import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { chromium as playwrightChromium } from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
import { exportPixelForgeAnimationVideo } from '../pixelforge-video-composer-export.mjs';

const repository = process.env.GITHUB_REPOSITORY || 'gavilandavid89-pixel/CodeLab';
const issueNumber = Number(process.env.CODELAB_SESSION_ISSUE || 492);
const sessionId = String(process.env.CODELAB_SESSION_ID || randomUUID());
const projectId = String(process.env.CODELAB_PROJECT_ID || 'soldier-walk-60f-20261124');
const baseUrl = String(process.env.CODELAB_PUBLIC_URL || 'https://codelab-qedi.onrender.com').replace(/\/+$/, '');
const bridgeToken = String(process.env.CODELAB_AGENT_BRIDGE_CONTROL_SECRET || '');
const maxMinutes = Math.max(1, Math.min(360, Number(process.env.CODELAB_SESSION_MINUTES || 360)));
const pollMs = 2500;

if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error('CODELAB_SESSION_ISSUE must be a positive issue number.');
if (!bridgeToken) throw new Error('CODELAB_AGENT_BRIDGE_CONTROL_SECRET is required by A; it is never passed to B.');
if (!/^https:\/\//i.test(baseUrl)) throw new Error('CODELAB_PUBLIC_URL must use HTTPS.');
process.env.RENDER_EXTERNAL_URL = baseUrl;

function gh(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, {
      env: { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0
      ? resolve(stdout)
      : reject(new Error('gh ' + args.join(' ') + ' failed: ' + stderr.slice(0, 1500))));
  });
}
async function comments() {
  return JSON.parse(await gh(['api', `repos/${repository}/issues/${issueNumber}/comments?per_page=100`]));
}
async function postComment(body) {
  await gh(['api', '-X', 'POST', `repos/${repository}/issues/${issueNumber}/comments`, '-f', 'body=' + body]);
}
async function bridgeGet(pathname) {
  const response = await fetch(baseUrl + pathname, {
    headers: { 'x-codelab-agent-bridge-token': bridgeToken, accept: 'application/json' },
    signal: AbortSignal.timeout(120000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('ADMIN bridge HTTP ' + response.status + ': ' + String(body.error || 'request_failed'));
  return body;
}
async function bridgePost(pathname, payload = {}) {
  const response = await fetch(baseUrl + pathname, {
    method: 'POST',
    headers: { 'x-codelab-agent-bridge-token': bridgeToken, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('ADMIN bridge HTTP ' + response.status + ': ' + String(body.error || 'request_failed'));
  return body;
}
function parseMarkedJson(body, marker) {
  if (!String(body || '').startsWith(marker + '\n')) return null;
  try { return JSON.parse(String(body).slice(marker.length + 1)); } catch { return null; }
}

console.log('[A] Reading the pinned ADMIN PixelForge revision through the authenticated bridge.');
const health = await fetch(baseUrl + '/api/health', { signal: AbortSignal.timeout(20000) });
if (!health.ok) throw new Error('CodeLab health endpoint returned HTTP ' + health.status);
const snapshot = await bridgeGet('/api/agent/bridge/pixelforge/projects/' + encodeURIComponent(projectId));
const project = snapshot.project;
const frameCount = Array.isArray(project?.animation?.frames) ? project.animation.frames.length : 0;
const fps = Number.isInteger(project?.animation?.fps) ? project.animation.fps : 12;
if (snapshot.workspaceId !== 'ws_local_admin') throw new Error('ADMIN bridge returned an unexpected workspace.');
if (snapshot.projectId !== projectId || project?.id !== projectId) throw new Error('ADMIN bridge returned a different project identity.');
if (project.name !== snapshot.name || frameCount < 2 || !Array.isArray(project.layers) || project.layers.length < 1) {
  throw new Error('The persisted ADMIN project is incomplete or has no real animation timeline.');
}
if (!Number.isInteger(snapshot.serverRevision) || snapshot.serverRevision < 1 || !/^[a-f0-9]{64}$/i.test(snapshot.contentSha256 || '')) {
  throw new Error('The persisted ADMIN project revision/hash is missing.');
}
const pinned = {
  workspaceId: snapshot.workspaceId,
  projectId,
  projectName: snapshot.name,
  serverRevision: snapshot.serverRevision,
  contentSha256: snapshot.contentSha256,
  frameCount,
  fps,
  width: Number(project.width),
  height: Number(project.height),
  project
};
console.log('[A] ADMIN snapshot pinned:', JSON.stringify({
  projectId, serverRevision: pinned.serverRevision, contentSha256: pinned.contentSha256,
  frameCount, fps, layers: project.layers.length
}));

console.log('[A] Minting a one-use ADMIN browser handoff for the persistent CodeLab/PixelForge session.');
const handoff = await bridgePost('/api/agent/bridge/admin-handoff');
if (!handoff.ticket || handoff.oneTime !== true) throw new Error('ADMIN browser handoff was not issued.');
console.log('[A] Launching persistent Chromium with ADMIN PixelForge and Video Composer pages.');
chromiumBinary.setGraphicsMode = false;
const browser = await playwrightChromium.launch({
  args: chromiumBinary.args,
  executablePath: await chromiumBinary.executablePath(),
  headless: true,
  timeout: 60000
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 960 },
  deviceScaleFactor: 1,
  colorScheme: 'dark',
  reducedMotion: 'reduce',
  acceptDownloads: true
});
const adminPage = await context.newPage();
const handoffResponse = await adminPage.goto(baseUrl + '/api/auth/native-handoff?ticket=' + encodeURIComponent(handoff.ticket), { waitUntil: 'domcontentloaded', timeout: 30000 });
if (!handoffResponse || ![200, 303].includes(handoffResponse.status())) throw new Error('ADMIN browser handoff could not be consumed.');
await adminPage.goto(baseUrl + '/pixelforge/index.html', { waitUntil: 'domcontentloaded', timeout: 45000 });
await adminPage.locator('#canvas').waitFor({ state: 'attached', timeout: 45000 });
const adminIdentity = await adminPage.evaluate(async () => {
  const [authResponse, projectResponse] = await Promise.all([fetch('/api/auth/status'), fetch('/api/pixelforge/projects')]);
  const auth = await authResponse.json();
  const projects = await projectResponse.json();
  return { user: auth.user || null, workspaceId: auth.workspaceId || null, projects: projects.projects || [] };
});
if (adminIdentity.user?.name !== 'ADMIN' || adminIdentity.user?.role !== 'admin' || adminIdentity.workspaceId !== pinned.workspaceId) {
  throw new Error('Persistent PixelForge browser is not authenticated as the ADMIN workspace.');
}
if (!adminIdentity.projects.some(item => item.id === projectId)) throw new Error('Pinned Soldier Walk project is not visible in the ADMIN PixelForge session.');
const sessionPage = await context.newPage();
const composerUrl = baseUrl + '/pixelforge/video-composer.html?export=1';
const pageErrors = [];
sessionPage.on('pageerror', error => { if (pageErrors.length < 10) pageErrors.push(String(error.message || error)); });
const composerResponse = await sessionPage.goto(composerUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
if (!composerResponse?.ok()) throw new Error('Persistent Video Composer page failed to load.');
await sessionPage.locator('#vc-file').waitFor({ state: 'attached', timeout: 15000 });
if (!/Video Composer/i.test(await sessionPage.title())) throw new Error('The persistent A session did not load the real Video Composer.');

const expiresAt = new Date(Date.now() + maxMinutes * 60000).toISOString();
await postComment('[CodeLab A Ready]\n' + JSON.stringify({
  sessionId, runId: process.env.GITHUB_RUN_ID || null, status: 'ready', expiresAt, projectId, projectName: pinned.projectName,
  workspaceId: pinned.workspaceId, serverRevision: pinned.serverRevision,
  contentSha256: pinned.contentSha256, frameCount: pinned.frameCount, fps: pinned.fps,
  width: pinned.width, height: pinned.height, composerUrl
}));
console.log('[CodeLab A Ready]', JSON.stringify({ sessionId, expiresAt, projectId, serverRevision: pinned.serverRevision }));

const processed = new Set();
let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });
const deadline = Date.now() + maxMinutes * 60000;

async function processRequest(request) {
  if (!request || request.sessionId !== sessionId || typeof request.requestId !== 'string') return;
  if (processed.has(request.requestId)) return;
  processed.add(request.requestId);
  const expectedRevision = Number(request.serverRevision);
  const expectedSha = String(request.contentSha256 || '');
  if (request.projectId !== projectId || expectedRevision !== pinned.serverRevision || expectedSha !== pinned.contentSha256) {
    await postComment('[CodeLab A Export Result]\n' + JSON.stringify({
      sessionId, requestId: request.requestId, status: 'failed',
      error: 'requested_project_revision_does_not_match_pinned_admin_snapshot',
      projectId, serverRevision: pinned.serverRevision, contentSha256: pinned.contentSha256
    }));
    return;
  }
  console.log('[A] Received B request:', request.requestId);
  try {
    const exported = await exportPixelForgeAnimationVideo({
      project_id: projectId,
      target_workspace_id: pinned.workspaceId,
      include_vector_overlay: true,
      persist_evidence: false,
      command_id: request.requestId
    }, {
      browser,
      context,
      workspaceId: pinned.workspaceId,
      targetPixelForgeWorkspace: payload => {
        if (payload.target_workspace_id !== pinned.workspaceId) throw new Error('A export target is not the ADMIN workspace.');
        return pinned.workspaceId;
      },
      loadProject: async requestedProjectId => {
        if (requestedProjectId !== pinned.projectId) throw new Error('A refused a different project ID.');
        return {
          project: pinned.project,
          serverRevision: pinned.serverRevision,
          contentSha256: pinned.contentSha256
        };
      },
      workspaceTokenFor: () => ''
    });
    const videoExport = exported.videoExport;
    if (!videoExport?.passed || videoExport.serverRevision !== pinned.serverRevision || videoExport.projectId !== projectId) {
      throw new Error('Video Composer export did not pass the pinned ADMIN revision checks.');
    }
    const base64 = videoExport.artifact?.dataBase64;
    if (typeof base64 !== 'string' || !base64.length) throw new Error('A did not receive the generated WebM bytes.');
    const videoBytes = Buffer.from(base64, 'base64');
    if (videoBytes.length !== videoExport.video.sizeBytes || videoBytes.length < 1000 || videoBytes.subarray(0, 4).toString('hex') !== '1a45dfa3') {
      throw new Error('Video Composer returned invalid WebM bytes.');
    }
    const videoSha256 = createHash('sha256').update(videoBytes).digest('hex');
    const chunkSize = 30000;
    const totalChunks = Math.ceil(base64.length / chunkSize);
    for (let index = 0; index < totalChunks; index++) {
      const data = base64.slice(index * chunkSize, (index + 1) * chunkSize);
      await postComment('[CodeLab A Video Chunk]\n' + JSON.stringify({
        sessionId, requestId: request.requestId, index, total: totalChunks, data
      }));
    }
    await postComment('[CodeLab A Export Result]\n' + JSON.stringify({
      sessionId, requestId: request.requestId, status: 'succeeded',
      projectId, projectName: pinned.projectName, workspaceId: pinned.workspaceId,
      serverRevision: pinned.serverRevision, contentSha256: pinned.contentSha256,
      frameCount: videoExport.package.frameCount, fps: videoExport.package.fps,
      videoFormat: videoExport.video.format, videoBytes: videoBytes.length,
      videoSha256, filename: videoExport.video.suggestedFilename,
      composerUrl: videoExport.composerUrl, method: videoExport.method,
      imported: videoExport.imported, pageErrors: videoExport.pageErrors,
      consoleErrors: videoExport.consoleErrors, chunkCount: totalChunks
    }));
    console.log('[A] Export delivered to B:', JSON.stringify({ requestId: request.requestId, videoBytes: videoBytes.length, videoSha256 }));
  } catch (error) {
    await postComment('[CodeLab A Export Result]\n' + JSON.stringify({
      sessionId, requestId: request.requestId, status: 'failed',
      error: String(error.message || error).slice(0, 1500)
    }));
    console.error('[A] Export failed:', error.message || error);
  }
}

try {
  while (!stopping && Date.now() < deadline) {
    try {
      const allComments = await comments();
      const requests = allComments
        .map(comment => parseMarkedJson(comment.body, '[CodeLab B Request]'))
        .filter(request => request && request.sessionId === sessionId && !processed.has(request.requestId));
      for (const request of requests) await processRequest(request);
    } catch (error) {
      console.error('[A] Mailbox poll failed:', error.message || error);
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
} finally {
  await sessionPage.close().catch(() => {});
  await adminPage.close().catch(() => {});
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
}
await postComment('[CodeLab A Expired]\n' + JSON.stringify({ sessionId, projectId, serverRevision: pinned.serverRevision, expiredAt: new Date().toISOString() }));
console.log('[CodeLab A] Session expired:', sessionId);
