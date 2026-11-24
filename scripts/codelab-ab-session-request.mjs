import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium as playwrightChromium } from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';

const repository = process.env.GITHUB_REPOSITORY || 'gavilandavid89-pixel/CodeLab';
const issueNumber = Number(process.env.CODELAB_SESSION_ISSUE || 492);
const sessionId = String(process.env.CODELAB_SESSION_ID || '');
const requestedProjectId = String(process.env.CODELAB_REQUESTED_PROJECT_ID || 'soldier-walk-60f-20261124').trim();
const timeoutMs = Math.max(30000, Math.min(30 * 60 * 1000, Number(process.env.CODELAB_SESSION_TIMEOUT_MS || 20 * 60 * 1000)));
const outputDir = path.resolve(process.env.CODELAB_AB_OUTPUT_DIR || 'artifacts/codelab-ab-video');
const requestId = randomUUID();

if (!sessionId) throw new Error('CODELAB_SESSION_ID is required; B cannot start or replace A.');
if (!/^[A-Za-z0-9_-]{1,100}$/.test(requestedProjectId)) throw new Error('CODELAB_REQUESTED_PROJECT_ID is invalid.');
if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error('CODELAB_SESSION_ISSUE must be a positive issue number.');

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
async function comments(since) {
  if (!since) throw new Error('CODELAB_A_READY_SINCE is required to scope the B mailbox.');
  return JSON.parse(await gh(['api', `repos/${repository}/issues/${issueNumber}/comments?per_page=100&since=${encodeURIComponent(since)}`]));
}
async function postComment(body) {
  await gh(['api', '-X', 'POST', `repos/${repository}/issues/${issueNumber}/comments`, '-f', 'body=' + body]);
}
function parseMarkedJson(body, marker) {
  if (!String(body || '').startsWith(marker + '\n')) return null;
  try { return JSON.parse(String(body).slice(marker.length + 1)); } catch { return null; }
}
const startedAt = Date.now();
const readySince = String(process.env.CODELAB_A_READY_SINCE || '');
let ready = null;
while (Date.now() - startedAt < timeoutMs) {
  const allComments = await comments(readySince);
  ready = allComments
    .map(comment => parseMarkedJson(comment.body, '[CodeLab A Ready]'))
    .find(item => item && item.sessionId === sessionId && item.status === 'ready') || null;
  if (ready) break;
  await new Promise(resolve => setTimeout(resolve, 2500));
}
if (!ready) throw new Error('A session was not READY before B timeout.');
if (ready.projectId !== requestedProjectId || ready.workspaceId !== 'ws_local_admin') {
  throw new Error('A READY session is not pinned to the ADMIN project requested by B. Start A with the same project_id input.');
}
if (!Number.isInteger(ready.serverRevision) || !/^[a-f0-9]{64}$/i.test(ready.contentSha256 || '') || ready.frameCount < 2) {
  throw new Error('A READY metadata is missing the pinned project revision/hash/timeline.');
}

const requestStartedAt = new Date().toISOString();
await postComment('[CodeLab B Request]\n' + JSON.stringify({
  sessionId, requestId, projectId: ready.projectId,
  serverRevision: ready.serverRevision, contentSha256: ready.contentSha256,
  requestedAt: new Date().toISOString()
}));
console.log('[B] Requested A to export the selected ADMIN project:', JSON.stringify({
  sessionId, requestId, projectId: ready.projectId, serverRevision: ready.serverRevision
}));

let result = null;
let receivedChunks = new Map();
const requestDeadline = Date.now() + timeoutMs;
while (Date.now() < requestDeadline) {
  const allComments = await comments(requestStartedAt);
  for (const comment of allComments) {
    const exportResult = parseMarkedJson(comment.body, '[CodeLab A Export Result]');
    if (exportResult?.sessionId === sessionId && exportResult?.requestId === requestId) result = exportResult;
    const chunk = parseMarkedJson(comment.body, '[CodeLab A Video Chunk]');
    if (chunk?.sessionId === sessionId && chunk?.requestId === requestId) {
      if (Number.isInteger(chunk.index) && Number.isInteger(chunk.total) && typeof chunk.data === 'string') {
        receivedChunks.set(chunk.index, chunk);
      }
    }
  }
  if (result?.status === 'failed') {
    await postComment('[CodeLab B Verification]\n' + JSON.stringify({ sessionId, requestId, status: 'failed', error: result.error || 'A_export_failed' }));
    throw new Error('A export failed: ' + String(result.error || 'unknown_error'));
  }
  if (result?.status === 'succeeded' && receivedChunks.size === result.chunkCount) break;
  await new Promise(resolve => setTimeout(resolve, 2500));
}
if (!result || result.status !== 'succeeded') throw new Error('A did not return a completed export before B timeout.');
if (receivedChunks.size !== result.chunkCount) throw new Error('B received an incomplete video chunk set.');
const orderedChunks = [...receivedChunks.values()].sort((a, b) => a.index - b.index);
if (orderedChunks.some((chunk, index) => chunk.index !== index || chunk.total !== result.chunkCount)) {
  throw new Error('B received non-contiguous or inconsistent video chunks.');
}
const base64 = orderedChunks.map(chunk => chunk.data).join('');
const videoBytes = Buffer.from(base64, 'base64');
const sha256 = createHash('sha256').update(videoBytes).digest('hex');
if (sha256 !== result.videoSha256) throw new Error('B video SHA-256 does not match A.');
if (videoBytes.length !== result.videoBytes || videoBytes.length < 1000 || videoBytes.subarray(0, 4).toString('hex') !== '1a45dfa3') {
  throw new Error('B received invalid WebM bytes or size.');
}
if (result.projectId !== ready.projectId || result.serverRevision !== ready.serverRevision ||
    result.contentSha256 !== ready.contentSha256 || result.frameCount !== ready.frameCount || result.fps !== ready.fps) {
  throw new Error('A export metadata does not match the pinned ADMIN project revision.');
}

console.log('[B] Downloaded bytes from A; verifying playback with Chromium (no encoder/FFmpeg).');
chromiumBinary.setGraphicsMode = false;
const browser = await playwrightChromium.launch({
  args: chromiumBinary.args,
  executablePath: await chromiumBinary.executablePath(),
  headless: true,
  timeout: 60000
});
let decoded;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error.message || error)));
  await page.setContent('<!doctype html><html><body><video id="video" muted playsinline controls></video></body></html>');
  decoded = await page.evaluate(async encoded => {
    const video = document.querySelector('#video');
    video.src = 'data:video/webm;base64,' + encoded;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('video_metadata_timeout')), 20000);
      video.addEventListener('loadedmetadata', () => { clearTimeout(timer); resolve(); }, { once: true });
      video.addEventListener('error', () => { clearTimeout(timer); reject(new Error('video_decode_error')); }, { once: true });
    });
    await video.play().catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 250));
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight || !Number.isFinite(video.duration)) {
      throw new Error('video_not_decoded');
    }
    const duration = video.duration;
    const sampleTimes = [0, duration * 0.25, duration * 0.5, duration * 0.75, Math.max(0, duration - 0.04)];
    let decodedSamples = 0;
    for (const time of sampleTimes) {
      if (time > 0.02) {
        const seeked = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('video_seek_timeout')), 8000);
          video.addEventListener('seeked', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        video.currentTime = time;
        await seeked;
      } else {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (video.readyState >= 2) decodedSamples++;
    }
    return {
      width: video.videoWidth, height: video.videoHeight, duration,
      readyState: video.readyState, decodedSamples, sampleTimes
    };
  }, base64);
  await page.close();
  if (pageErrors.length) throw new Error('Chromium reported page errors: ' + pageErrors.join('; '));
} finally {
  await browser.close().catch(() => {});
}
const expectedDuration = result.frameCount / result.fps;
if (!decoded || decoded.decodedSamples < 4 || decoded.width < 1 || decoded.height < 1 ||
    !Number.isFinite(expectedDuration) || Math.abs(decoded.duration - expectedDuration) > 0.15) {
  throw new Error('Chromium did not decode enough frames from the delivered WebM.');
}

await fs.mkdir(outputDir, { recursive: true });
const videoPath = path.join(outputDir, path.basename(result.filename || 'PixelForge-Soldier-Walk.webm'));
await fs.writeFile(videoPath, videoBytes);
const verification = {
  status: 'verified',
  sessionId, requestId, projectId: result.projectId,
  serverRevision: result.serverRevision, contentSha256: result.contentSha256,
  frameCount: result.frameCount, fps: result.fps,
  videoPath, videoBytes: videoBytes.length, videoSha256: sha256,
  decoded, method: 'Chromium HTMLVideoElement decode; no FFmpeg and no video generation in B',
  verifiedAt: new Date().toISOString()
};
await fs.writeFile(path.join(outputDir, 'verification.json'), JSON.stringify(verification, null, 2));
await postComment('[CodeLab B Verification]\n' + JSON.stringify(verification));
console.log('[B] VIDEO VERIFIED:', JSON.stringify(verification));
