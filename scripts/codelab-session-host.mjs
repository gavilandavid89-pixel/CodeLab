import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error('CODELAB_SESSION_ISSUE is required.');

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codelab-session-'));
const port = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => { res.writeHead(200); res.end('ready'); });
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  server.on('error', reject);
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
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('CodeLab local server did not become healthy.');
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

async function executeBrowser(request, browser) {
  const context = await browser.newContext({
    viewport: { width: Number(request.width || 1440), height: Number(request.height || 960) },
    ...(request.recordVideo ? { recordVideo: { dir: path.join(dataDir, 'video'), size: { width: 1440, height: 960 }, fps: 24 } } : {})
  });
  const page = await context.newPage();
  const trace = [];
  const screenshots = [];
  const startPath = String(request.start_path || '/pixelforge/index.html');
  await page.goto(`http://127.0.0.1:${port}${startPath.startsWith('/') ? startPath : '/' + startPath}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
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
    ui_actions: trace,
    screenshots,
    passed: true
  };
  await page.close();
  await context.close();
  return result;
}

await waitHealthy();
const browser = await chromium.launch({ headless: true });
await comment(`[CodeLab Session Ready]\\n\\n` + JSON.stringify({ sessionId, port, expiresAt: new Date(Date.now() + maxMinutes * 60000).toISOString() }));

const processed = new Set();
const deadline = Date.now() + maxMinutes * 60000;
try {
  while (Date.now() < deadline) {
    const all = await comments();
    for (const c of all) {
      const body = String(c.body || '');
      if (!body.startsWith('[CodeLab Session Request]')) continue;
      if (processed.has(c.id)) continue;
      processed.add(c.id);
      let request;
      try {
        request = JSON.parse(body.slice('[CodeLab Session Request]'.length).trim());
        if (request.sessionId !== sessionId) continue;
        const result = request.kind === 'pixelforge' ? await executePixelForge(request) : await executeBrowser(request, browser);
        await comment('[CodeLab Session Result]\n' + JSON.stringify({ requestId: request.requestId, sessionId, ok: true, result }));
      } catch (error) {
        await comment('[CodeLab Session Result]\n' + JSON.stringify({ requestId: request?.requestId || null, sessionId, ok: false, error: String(error.message || error) }));
      }
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
} finally {
  await browser.close().catch(() => {});
  server.kill('SIGTERM');
  await fs.rm(dataDir, { recursive: true, force: true });
}
console.log(JSON.stringify({ sessionId, status: 'expired', minutes: maxMinutes }));
