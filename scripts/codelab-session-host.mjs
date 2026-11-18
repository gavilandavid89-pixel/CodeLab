import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { HeadlessEditorRuntime } from '../public/pixelforge/src/headless.js';

const repo = process.env.GITHUB_REPOSITORY || 'gavilandavid89-pixel/CodeLab';
const issueNumber = Number(process.env.CODELAB_SESSION_ISSUE);
const sessionId = String(process.env.CODELAB_SESSION_ID || randomUUID());
const maxMinutes = Math.max(1, Math.min(30, Number(process.env.CODELAB_SESSION_MINUTES || 10)));
const pollMs = 1000;
const mailboxBaseUrl = String(process.env.CODELAB_MAILBOX_BASE_URL || 'https://codelab-pbw9.onrender.com').replace(/\/+$/, '');
const mailboxToken = String(process.env.CODELAB_MAILBOX_TOKEN || createHash('sha256').update('codelab-headless-mailbox:v1:' + sessionId).digest('hex')).slice(0, 64);
async function mailboxPost(pathname, body) {
  const response = await fetch(mailboxBaseUrl + pathname, { method: 'POST', headers: { 'content-type': 'application/json', 'x-codelab-mailbox-token': mailboxToken }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (response.status === 204) return null;
  let data = null; try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error('Headless mailbox HTTP ' + response.status + ': ' + JSON.stringify(data));
  return data;
}
async function registerMailbox(expiresAt) {
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      return await mailboxPost('/api/headless/session/register', { sessionId, token: mailboxToken, expiresAt });
    } catch (error) {
      lastError = error;
      console.error('headless mailbox register attempt ' + attempt + '/6 failed:', error.message);
      if (attempt < 6) await new Promise(r => setTimeout(r, 5000));
    }
  }
  throw lastError || new Error('Headless mailbox registration timed out.');
}

if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error('CODELAB_SESSION_ISSUE is required.');
const startupWatchdog = setTimeout(() => { console.error('A startup watchdog expired after 180 seconds.'); process.exit(1); }, 180000);

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codelab-session-'));
const videoDir = process.env.CODELAB_SESSION_VIDEO_DIR || path.join(os.tmpdir(), 'codelab-session-video');
await fs.mkdir(videoDir, { recursive: true });
const port = await new Promise((resolve, reject) => {
  const probeServer = createServer((req, res) => { res.writeHead(200); res.end('ready'); });
  probeServer.listen(0, '127.0.0.1', () => {
    const selectedPort = probeServer.address().port;
    probeServer.close(error => error ? reject(error) : resolve(selectedPort));
  });
  probeServer.on('error', reject);
});
const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(port), CODELAB_DATA_DIR: dataDir, PIXELFORGE_GUEST_MODE: 'true' },
  stdio: ['ignore', 'pipe', 'pipe']
});
const logs = [];
server.stdout.on('data', b => logs.push(String(b).trimEnd()));
server.stderr.on('data', b => logs.push(String(b).trimEnd()));

async function gh(args) {
  const p = spawn('gh', args, { env: { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  p.stdout.on('data', b => stdout += b);
  p.stderr.on('data', b => stderr += b);
  const code = await new Promise(resolve => p.on('close', resolve));
  if (code !== 0) throw new Error('gh ' + args.join(' ') + ' failed: ' + stderr.slice(0, 2000));
  return stdout;
}
async function comment(body) {
  await gh(['api', '-X', 'POST', `repos/${repo}/issues/${issueNumber}/comments`, '-f', 'body=' + body]);
}
async function comments() {
  return JSON.parse(await gh(['api', `repos/${repo}/issues/${issueNumber}/comments?per_page=100`]));
}
async function waitHealthy() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch (error) {
      if (i === 19) console.error('CodeLab health probe failed:', error.message);
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('CodeLab local server did not become healthy within 10 seconds. Server logs: ' + logs.slice(-20).join(' | '));
}

async function getPixelForgeProject(projectId) {
  const r = await fetch(`http://127.0.0.1:${port}/api/pixelforge/projects/${encodeURIComponent(projectId)}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) throw new Error('PixelForge project GET failed with HTTP ' + r.status);
  return await r.json();
}
async function putPixelForgeProject(project) {
  const r = await fetch(`http://127.0.0.1:${port}/api/pixelforge/projects/${encodeURIComponent(project.id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(project),
    signal: AbortSignal.timeout(30000)
  });
  if (!r.ok) {
    let detail = '';
    try { detail = JSON.stringify(await r.json()); } catch {}
    throw new Error('PixelForge project PUT failed with HTTP ' + r.status + ' ' + detail);
  }
  return await r.json();
}
async function executePixelForge(request) {
  const project = await getPixelForgeProject(request.project_id);
  const runtime = HeadlessEditorRuntime.fromJSON(project);
  if (request.operation === 'frame_context') {
    const outcome = runtime.executeBatch([{
      name: 'animation.frame.get_context',
      index: request.frame_index,
      ...(request.layer_id ? { layerId: request.layer_id } : {})
    }]);
    if (!outcome.ok) throw new Error(outcome.error?.message || 'Frame context request failed.');
    const context = outcome.results?.[0]?.result || outcome.result || null;
    return {
      sessionId,
      execution_mode: 'api',
      captureMethod: 'codelab-local-headless-runtime',
      projectId: project.id,
      serverRevision: project.serverRevision || null,
      context
    };
  }
  if (request.operation === 'batch') {
    if (!Array.isArray(request.actions) || request.actions.length < 1 || request.actions.length > 500) {
      throw new Error('PixelForge batch requires 1–500 structured actions.');
    }
    const outcome = runtime.executeBatch(request.actions);
    if (!outcome.ok) throw new Error('PixelForge batch failed at action ' + outcome.failedIndex + ': ' + (outcome.error?.message || 'unknown error'));
    if (runtime.hasPendingChanges) {
      const proposal = runtime.createProposal(String(request.summary || 'Persistent session PixelForge batch'));
      const accepted = runtime.acceptProposal();
      if (accepted?.status !== 'applied') throw new Error('PixelForge batch proposal was not applied.');
      const saved = await putPixelForgeProject(runtime.toJSON());
      return {
        sessionId,
        execution_mode: 'api',
        captureMethod: 'codelab-local-headless-runtime',
        projectId: project.id,
        serverRevision: saved.serverRevision || null,
        inspection: runtime.inspect(),
        results: outcome.results
      };
    }
    return { sessionId, execution_mode: 'api', projectId: project.id, serverRevision: project.serverRevision || null, results: outcome.results };
  }
  throw new Error('Unsupported PixelForge session operation.');
}

async function executeBrowser(request, page) {
  const trace = [];
  const screenshots = [];
  if (request.start_path) {
    const startPath = String(request.start_path);
    await page.goto(`http://127.0.0.1:${port}${startPath.startsWith('/') ? startPath : '/' + startPath}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  for (const action of request.actions || []) {
    if (!action || typeof action !== 'object' || typeof action.type !== 'string') throw new Error('Invalid structured browser action.');
    const type = action.type;
    trace.push({ type, startedAt: new Date().toISOString() });
    if (type === 'open_screen' || type === 'open_panel') {
      if (action.selector) await page.locator(action.selector).click({ timeout: Number(action.timeoutMs || 10000) });
    } else if (type === 'click') {
      await page.locator(String(action.selector)).click({ timeout: Number(action.timeoutMs || 10000) });
    } else if (type === 'scroll') {
      await page.locator(String(action.selector || 'body')).evaluate((el, amount) => el.scrollBy(0, amount), Number(action.amount || 0));
    } else if (type === 'type') {
      await page.locator(String(action.selector)).fill(String(action.text ?? ''));
    } else if (type === 'select') {
      await page.locator(String(action.selector)).selectOption(String(action.value));
    } else if (type === 'wait_for') {
      await page.locator(String(action.selector)).waitFor({ state: action.state || 'visible', timeout: Number(action.timeoutMs || 10000) });
    } else if (type === 'screenshot') {
      const file = path.join(dataDir, 'evidence', `${trace.length}-screenshot.png`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await page.screenshot({ path: file, fullPage: Boolean(action.fullPage) });
      screenshots.push(file);
    } else if (type === 'record_video') {
      await page.waitForTimeout(Math.max(100, Math.min(30000, Number(action.durationMs || 1000))));
    } else {
      throw new Error('Unsupported browser action: ' + type);
    }
    trace[trace.length - 1].finishedAt = new Date().toISOString();
  }
  const result = {
    sessionId,
    execution_mode: 'browser',
    captureMethod: 'playwright-chromium-real-codelab-session',
    finalUrl: page.url(),
    title: await page.title().catch(() => ''),
    bodyText: (await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')).slice(0, 4000),
    ui_actions: trace,
    screenshots,
    passed: true
  };
  return result;
}

console.log('A stage: waiting for local CodeLab health');
await waitHealthy();
console.log('A stage: local CodeLab healthy');
const expiresAt = new Date(Date.now() + maxMinutes * 60000).toISOString();
console.log('A stage: registering mailbox before Chromium');
await registerMailbox(expiresAt);
console.log('A stage: mailbox registered');
console.log(JSON.stringify({ sessionId, expiresAt, mailbox: mailboxBaseUrl, status: 'ready' }));
console.log('A stage: launching Chromium');
const browser = await chromium.launch({ headless: true });
console.log('A stage: Chromium launched');
const sessionContext = await browser.newContext({ viewport: { width: 1440, height: 960 }, recordVideo: { dir: videoDir, size: { width: 1440, height: 960 }, fps: 24 } });
const sessionPage = await sessionContext.newPage();
console.log('A stage: opening persistent PixelForge page');
await sessionPage.goto(`http://127.0.0.1:${port}/pixelforge/index.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
console.log('A stage: persistent PixelForge page ready');
clearTimeout(startupWatchdog);

let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });
const deadline = Date.now() + maxMinutes * 60000;
try {
  while (!stopping && Date.now() < deadline) {
    let request = null;
    try {
      const claimed = await mailboxPost('/api/headless/session/claim?sessionId=' + encodeURIComponent(sessionId), {});
      if (claimed?.requestId) request = claimed;
    } catch (error) {
      console.error('headless mailbox claim failed:', error.message);
    }
    if (request) {
      try {
        const result = request.payload?.kind === 'pixelforge'
          ? await executePixelForge(request.payload)
          : await executeBrowser(request.payload, sessionPage);
        await mailboxPost('/api/headless/session/result?sessionId=' + encodeURIComponent(sessionId), {
          requestId: request.requestId, status: 'succeeded', result
        });
      } catch (error) {
        try {
          await mailboxPost('/api/headless/session/result?sessionId=' + encodeURIComponent(sessionId), {
            requestId: request.requestId, status: 'failed',
            result: { sessionId, error: String(error.message || error) }
          });
        } catch (mailboxError) {
          console.error('headless mailbox result failed:', mailboxError.message);
        }
      }
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
} finally {
  await sessionPage.close().catch(() => {});
  await sessionContext.close().catch(() => {});
  await browser.close().catch(() => {});
  server.kill('SIGTERM');
  await fs.rm(dataDir, { recursive: true, force: true });
}
console.log(JSON.stringify({ sessionId, status: 'expired', minutes: maxMinutes }));
