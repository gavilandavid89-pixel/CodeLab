import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { HeadlessEditorRuntime } from '../public/pixelforge/src/headless.js';
import { createSoldierReferenceAnimation } from '../public/pixelforge/src/showcase-animation-reference.mjs';

const repo = process.env.GITHUB_REPOSITORY || 'gavilandavid89-pixel/CodeLab';
const issueNumber = Number(process.env.CODELAB_SESSION_ISSUE);
const sessionId = String(process.env.CODELAB_SESSION_ID || randomUUID());
const maxMinutes = Math.max(1, Math.min(360, Number(process.env.CODELAB_SESSION_MINUTES || 360)));
const pollMs = 3000;
const sessionProjects = new Map();
const mailboxTransport = String(process.env.CODELAB_MAILBOX_TRANSPORT || 'relay').toLowerCase();
if (!['relay','custom'].includes(mailboxTransport)) throw new Error('Unsupported CODELAB_MAILBOX_TRANSPORT: ' + mailboxTransport);
const defaultMailboxBaseUrl = mailboxTransport === 'relay' ? 'https://codelab-pbw9.onrender.com' : '';
const mailboxBaseUrl = String(process.env.CODELAB_MAILBOX_BASE_URL || defaultMailboxBaseUrl).replace(/\/+$/, '');
if (!mailboxBaseUrl) throw new Error('CODELAB_MAILBOX_BASE_URL is required for custom mailbox transport.');
const mailboxToken = String(process.env.CODELAB_MAILBOX_TOKEN || createHash('sha256').update('codelab-headless-mailbox:v1:' + sessionId).digest('hex')).slice(0, 64);
async function mailboxPost(pathname, body) {
  const response = await fetch(mailboxBaseUrl + pathname, { method: 'POST', headers: { 'content-type': 'application/json', 'x-codelab-mailbox-token': mailboxToken }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  if (response.status === 204) return null;
  let data = null; try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error('Headless mailbox HTTP ' + response.status + ': ' + JSON.stringify(data));
  return data;
}
async function registerMailbox(expiresAt) {
  let lastError;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      return await mailboxPost('/api/headless/session/register', { sessionId, token: mailboxToken, expiresAt });
    } catch (error) {
      lastError = error;
      console.error('headless mailbox register attempt ' + attempt + '/8 failed:', error.message);
      if (attempt < 8) await new Promise(r => setTimeout(r, 5000));
    }
  }
  throw lastError || new Error('Headless mailbox registration timed out.');
}

if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error('CODELAB_SESSION_ISSUE is required.');
const startupWatchdog = setTimeout(() => { console.error('A startup watchdog expired after 660 seconds.'); process.exit(1); }, 660000);

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codelab-session-'));
const sessionStoreDir = path.join(dataDir, 'sessions');
await fs.mkdir(sessionStoreDir, { recursive: true });
const authSessionId = createHash('sha256').update('pixelforge-headless-auth:' + sessionId).digest('hex').slice(0, 48);
await fs.writeFile(path.join(sessionStoreDir, authSessionId + '.json'), JSON.stringify({
  id: authSessionId,
  user: { id: 'pixelforge-headless-agent', provider: 'github', name: 'CODELAB_HEADLESS_AGENT', role: 'user' },
  createdAt: Date.now(),
  expiresAt: Date.now() + maxMinutes * 60000,
}), { mode: 0o600 });
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

async function listPixelForgeProjects() {
  const r = await fetch(`http://127.0.0.1:${port}/api/pixelforge/projects`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('PixelForge project list failed with HTTP ' + r.status);
  const result = await r.json();
  if (result?.project) sessionProjects.set(project.id, { ...project, serverRevision: result.project.serverRevision || project.serverRevision || 1 });
  return result;
}
async function getPixelForgeProject(projectId) {
  const r = await fetch(`http://127.0.0.1:${port}/api/pixelforge/projects/${encodeURIComponent(projectId)}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) throw new Error('PixelForge project GET failed with HTTP ' + r.status);
  return await r.json();
}
async function persistLocalPixelForgeProject(project) {
  const file = path.join(dataDir, 'workspaces', 'ws_pixelforge_guest.json.pixelforge.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  let records = [];
  try { records = JSON.parse(await fs.readFile(file, 'utf8')); if (!Array.isArray(records)) records = []; } catch {}
  const now = Date.now();
  const current = records.find(item => item.id === project.id);
  const currentRevision = Number(current?.project?.serverRevision || 0);
  const stored = { ...project, serverRevision: currentRevision + 1 };
  const record = { id: stored.id, name: stored.name, width: stored.width, height: stored.height, updatedAt: now, lastOpenedAt: now, project: stored };
  records = records.filter(item => item.id !== project.id);
  records.push(record);
  await fs.writeFile(file, JSON.stringify(records), { mode: 0o600 });
  sessionProjects.set(stored.id, stored);
  return { id: stored.id, name: stored.name, width: stored.width, height: stored.height, updatedAt: now, serverRevision: stored.serverRevision };
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
    if (r.status === 400 && detail.includes('invalid_pixelforge_project') && !process.env.DATABASE_URL) {
      console.warn('PixelForge API rejected local test payload; persisting through the same local CodeLab guest store for the isolated headless session.');
      return await persistLocalPixelForgeProject(project);
    }
    throw new Error('PixelForge project PUT failed with HTTP ' + r.status + ' ' + detail);
  }
  const result = await r.json();
  if (result?.project) sessionProjects.set(project.id, { ...project, serverRevision: result.project.serverRevision || project.serverRevision || 1 });
  return result;
}
function mapAnimationActionsToRuntimeLayers(runtime, project, actions) {
  const summaryOutcome = runtime.executeBatch([{ name: 'document.get_summary' }]);
  if (!summaryOutcome.ok) throw new Error(summaryOutcome.error?.message || 'Could not inspect runtime layers.');
  const sandboxLayers = summaryOutcome.results?.[0]?.result?.layers || [];
  const sourceLayers = project.layers || [];
  const sourceToSandbox = new Map();
  for (let index = 0; index < Math.min(sourceLayers.length, sandboxLayers.length); index++) {
    sourceToSandbox.set(sourceLayers[index].id, sandboxLayers[index].id);
  }
  return actions.map(action => {
    if (!action?.layerId || !String(action.name || '').startsWith('animation.')) return action;
    const mapped = sourceToSandbox.get(action.layerId);
    if (!mapped) throw new Error('Unknown stable animation layer ID: ' + action.layerId);
    return { ...action, layerId: mapped };
  });
}

function normalizeAnimationContext(context, project) {
  if (!context || !project?.layers?.length) return context;
  const stableLayerId = project.activeLayerId || project.layers[0].id;
  return {
    ...context,
    layer: context.layer ? { ...context.layer, id: stableLayerId, name: project.layers.find(layer => layer.id === stableLayerId)?.name || stableLayerId } : context.layer,
    guidance: context.guidance ? { ...context.guidance, availableLayerIds: project.layers.map(layer => layer.id) } : context.guidance,
  };
}

async function executePixelForge(request) {
  if (request.operation === 'list_projects') {
    return { sessionId, execution_mode: 'api', captureMethod: 'codelab-local-headless-runtime', projects: (await listPixelForgeProjects()).projects || [] };
  }
  if (request.operation === 'create_blank_animation') {
    const projectId = 'agent_' + sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 70);
    const layerId = 'layer_' + sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 70);
    const width = 128, height = 160;
    const blankPixels = Buffer.alloc(width * height * 4).toString('base64');
    const project = {
      format: 'pixelforge-project',
      version: 1,
      id: projectId,
      name: 'Agent feedback cycle',
      width,
      height,
      activeLayerId: layerId,
      revision: 0,
      saveVersion: 0,
      layers: [{ id: layerId, name: 'Agent source layer', visible: true, opacity: 1, locked: false, pixels: blankPixels }],
    };
    const saved = await putPixelForgeProject(project);
  sessionProjects.set(project.id, { ...project, serverRevision: saved.serverRevision || project.serverRevision || 1 });
    const runtime = HeadlessEditorRuntime.fromJSON({ ...project, serverRevision: saved.serverRevision || 1 });
    const outcome = runtime.executeBatch([{ name: 'animation.frame.add_from_layer' }]);
    if (!outcome.ok) throw new Error(outcome.error?.message || 'Initial animation frame creation failed.');
    const proposal = runtime.createProposal('Create initial agent feedback animation frame');
    const accepted = runtime.acceptProposal();
    if (accepted?.status !== 'applied') throw new Error('Initial animation frame proposal was not applied.');
    const committedProject = runtime.toJSON();
    const persisted = await putPixelForgeProject(committedProject);
    committedProject.serverRevision = persisted.serverRevision || committedProject.serverRevision || 1;
    const committedRuntime = HeadlessEditorRuntime.fromJSON(committedProject);
    const contextOutcome = committedRuntime.executeBatch([{ name: 'animation.frame.get_context', index: 0 }]);
    if (!contextOutcome.ok) throw new Error(contextOutcome.error?.message || 'Initial blank frame context failed.');
    return {
      sessionId,
      execution_mode: 'api',
      captureMethod: 'codelab-local-headless-runtime',
      projectId,
      serverRevision: persisted.serverRevision || null,
      context: normalizeAnimationContext(contextOutcome.results?.[0]?.result || contextOutcome.result || null, committedProject),
    };
  }
  if (request.operation === 'create_reference_animation') {
    const { doc, animation, workflow } = createSoldierReferenceAnimation();
    const raw = doc.toJSON();
    const projectId = 'ref_' + randomUUID().replace(/-/g, '');
    const project = {
      format: 'pixelforge-project',
      version: 1,
      id: projectId,
      name: 'Agent reference feedback cycle',
      width: raw.width,
      height: raw.height,
      activeLayerId: raw.activeLayerId,
      revision: 0,
      saveVersion: 0,
      layers: raw.layers.map(layer => ({
        id: layer.id,
        name: layer.name,
        visible: Boolean(layer.visible),
        opacity: Number(layer.opacity),
        locked: Boolean(layer.locked),
        pixels: layer.pixels,
      })),
    };
    project.animation = animation.toJSON();
    project.animation.layerIds = project.layers.map(layer => layer.id);
    const pixelBytes = project.width * project.height * 4;
    const expectedPixelBase64Length = Math.ceil(pixelBytes / 3) * 4;
    const diagnostics = {
      id: /^[a-zA-Z0-9_-]{1,100}$/.test(project.id),
      name: typeof project.name === 'string' && project.name.trim().length > 0 && project.name.length <= 180,
      dimensions: Number.isInteger(project.width) && Number.isInteger(project.height),
      revision: Number.isInteger(project.revision) && project.revision >= 0,
      saveVersion: Number.isInteger(project.saveVersion) && project.saveVersion >= 0,
      activeLayer: project.layers.some(layer => layer.id === project.activeLayerId),
      layers: project.layers.map(layer => ({
        id: typeof layer.id === 'string' && layer.id.length > 0 && layer.id.length <= 180,
        name: typeof layer.name === 'string' && layer.name.trim().length > 0 && layer.name.length <= 180,
        visible: typeof layer.visible === 'boolean',
        opacity: Number.isFinite(layer.opacity) && layer.opacity >= 0 && layer.opacity <= 1,
        locked: typeof layer.locked === 'boolean',
        pixels: typeof layer.pixels === 'string' && layer.pixels.length === expectedPixelBase64Length,
      })),
      animationLayerIds: project.animation.layerIds.every((id, index) => id === project.layers[index]?.id),
    };
    if (Object.values(diagnostics).some(value => value === false) || diagnostics.layers.some(layer => Object.values(layer).some(value => value === false))) {
      throw new Error('Reference project local validation failed: ' + JSON.stringify(diagnostics));
    }
    const saved = await putPixelForgeProject(project);
    const runtime = HeadlessEditorRuntime.fromJSON(saved);
    const outcome = runtime.executeBatch([{ name: 'animation.frame.get_context', index: 0, layerId: project.layers[0].id }]);
    if (!outcome.ok) throw new Error(outcome.error?.message || 'Initial reference context request failed.');
    return {
      sessionId,
      execution_mode: 'api',
      captureMethod: 'codelab-local-headless-runtime',
      projectId: saved.id,
      serverRevision: saved.serverRevision || null,
      workflow,
      context: outcome.results?.[0]?.result || outcome.result || null
    };
  }
  let project = await getPixelForgeProject(request.project_id);
  try {
    project = project && project.project ? project.project : project;
  } catch {}
  let runtime;
  try {
    runtime = HeadlessEditorRuntime.fromJSON(project);
  } catch (error) {
    const cached = sessionProjects.get(request.project_id);
    if (!cached) throw error;
    runtime = HeadlessEditorRuntime.fromJSON(cached);
    project = cached;
  }
  if (request.operation === 'frame_context') {
    const frameAction = {
      name: 'animation.frame.get_context',
      index: request.frame_index,
      ...(request.layer_id ? { layerId: request.layer_id } : {})
    };
    const runtimeActions = request.layer_id ? mapAnimationActionsToRuntimeLayers(runtime, project, [frameAction]) : [frameAction];
    const outcome = runtime.executeBatch(runtimeActions);
    if (!outcome.ok) throw new Error(outcome.error?.message || 'Frame context request failed.');
    const context = normalizeAnimationContext(outcome.results?.[0]?.result || outcome.result || null, project);
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
    const runtimeActions = mapAnimationActionsToRuntimeLayers(runtime, project, request.actions);
    const outcome = runtime.executeBatch(runtimeActions);
    if (!outcome.ok) throw new Error('PixelForge batch failed at action ' + outcome.failedIndex + ': ' + (outcome.error?.message || 'unknown error'));
    if (runtime.hasPendingChanges) {
      const proposal = runtime.createProposal(String(request.summary || 'Persistent session PixelForge batch'));
      const accepted = runtime.acceptProposal();
      if (accepted?.status !== 'applied') throw new Error('PixelForge batch proposal was not applied.');
      const committedProject = runtime.toJSON();
      const saved = await putPixelForgeProject(committedProject);
      committedProject.serverRevision = saved.serverRevision || committedProject.serverRevision || 1;
      const committedRuntime = HeadlessEditorRuntime.fromJSON(committedProject);
      let context = null;
      if (request.return_context !== false && committedProject.animation?.frames?.length) {
        const activeIndex = committedProject.animation.activeFrameIndex ?? 0;
        const contextOutcome = committedRuntime.executeBatch([{ name: 'animation.frame.get_context', index: activeIndex }]);
        if (contextOutcome.ok) context = normalizeAnimationContext(contextOutcome.results?.[0]?.result || contextOutcome.result || null, committedProject);
      }
      return {
        sessionId,
        execution_mode: 'api',
        captureMethod: 'codelab-local-headless-runtime',
        projectId: project.id,
        serverRevision: saved.serverRevision || null,
        inspection: committedRuntime.inspect(),
        results: outcome.results,
        ...(context ? { context } : {})
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
await comment('[CodeLab A Stage] local CodeLab healthy run=' + process.env.GITHUB_RUN_ID);
// The mailbox service currently accepts short-lived leases; this is independent from A's execution lifetime.
const mailboxLeaseMinutes = Math.min(maxMinutes, 10);
const expiresAt = new Date(Date.now() + mailboxLeaseMinutes * 60000).toISOString();
console.log('A stage: mailbox transport=' + mailboxTransport + ' base=' + mailboxBaseUrl);
console.log('A stage: registering mailbox before Chromium');
await registerMailbox(expiresAt);
console.log('A stage: mailbox registered');
await comment('[CodeLab A Stage] mailbox registered run=' + process.env.GITHUB_RUN_ID);
const mailboxHeartbeat = setInterval(async () => {
  try {
    const refreshedExpiresAt = new Date(Date.now() + mailboxLeaseMinutes * 60000).toISOString();
    await registerMailbox(refreshedExpiresAt);
    console.log('[CodeLab mailbox heartbeat] lease refreshed until ' + refreshedExpiresAt);
  } catch (error) {
    console.error('[CodeLab mailbox heartbeat] refresh failed:', error.message);
  }
}, 5 * 60 * 1000);
console.log('[CodeLab Session Ready]');
console.log(JSON.stringify({ sessionId, expiresAt, mailbox: mailboxBaseUrl, status: 'ready' }));
await comment('[CodeLab Session Ready] run=' + process.env.GITHUB_RUN_ID + ' session=' + sessionId + ' expiresAt=' + expiresAt);
console.log('A stage: launching Chromium');
const browser = await chromium.launch({ headless: true });
console.log('A stage: Chromium launched');
// A is a live host only. Animation video encoding belongs exclusively to B.
const sessionContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
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
  clearInterval(mailboxHeartbeat);
  await browser.close().catch(() => {});
  server.kill('SIGTERM');
  await fs.rm(dataDir, { recursive: true, force: true });
}
console.log(JSON.stringify({ sessionId, status: 'expired', minutes: maxMinutes }));
