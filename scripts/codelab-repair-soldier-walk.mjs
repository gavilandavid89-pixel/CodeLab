import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium as playwrightChromium } from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';

const projectId = process.env.CODELAB_PROJECT_ID || 'soldier-walk-60f-20261124';
const baseUrl = String(process.env.CODELAB_PUBLIC_URL || 'https://codelab-qedi.onrender.com').replace(/\/+$/, '');
const bridgeToken = String(process.env.CODELAB_AGENT_BRIDGE_CONTROL_SECRET || '');
const githubToken = String(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '');
const repository = process.env.GITHUB_REPOSITORY || 'gavilandavid89-pixel/CodeLab';
const sourceRunId = '45464718903';
const sourceArtifactName = 'codelab-soldier-walk-source-' + sourceRunId;
const expectedWorkspace = 'ws_local_admin';
const characterLayerName = 'Soldier · reference-guided';
if (!bridgeToken || !githubToken) throw new Error('ADMIN bridge token and GitHub token are required.');

async function bridgeGet(pathname) {
  const response = await fetch(baseUrl + pathname, {
    headers: { 'x-codelab-agent-bridge-token': bridgeToken, accept: 'application/json' },
    signal: AbortSignal.timeout(120000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('ADMIN bridge GET HTTP ' + response.status + ': ' + String(body.error || 'request_failed'));
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
  if (!response.ok) throw new Error('ADMIN bridge POST HTTP ' + response.status + ': ' + String(body.error || 'request_failed'));
  return body;
}

function translateRgba(source, width, height, dx, dy) {
  const out = Buffer.alloc(source.length);
  for (let y = 0; y < height; y++) {
    const ny = y + dy;
    if (ny < 0 || ny >= height) continue;
    for (let x = 0; x < width; x++) {
      const nx = x + dx;
      if (nx < 0 || nx >= width) continue;
      const from = (y * width + x) * 4;
      const to = (ny * width + nx) * 4;
      source.copy(out, to, from, from + 4);
    }
  }
  return out;
}

function extractRegion(source, width, height, predicate) {
  const body = Buffer.from(source);
  const part = Buffer.alloc(source.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const r = source[offset], g = source[offset + 1], b = source[offset + 2], a = source[offset + 3];
      if (!a || !predicate(x, y, r, g, b, a)) continue;
      source.copy(part, offset, offset, offset + 4);
      body.fill(0, offset, offset + 4);
    }
  }
  return { body, part };
}

function moveRegion(source, width, height, predicate, dx, dy) {
  if (!dx && !dy) return Buffer.from(source);
  const out = Buffer.from(source);
  const selected = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const r = source[offset], g = source[offset + 1], b = source[offset + 2], a = source[offset + 3];
      if (!a || !predicate(x, y, r, g, b, a)) continue;
      selected.push({ x, y, r, g, b, a });
      out.fill(0, offset, offset + 4);
    }
  }
  for (const pixel of selected) {
    const x = pixel.x + dx, y = pixel.y + dy;
    if (x < 0 || x >= width || y < 0 || y >= height) continue;
    const offset = (y * width + x) * 4;
    const da = out[offset + 3];
    if (!da) {
      out[offset] = pixel.r; out[offset + 1] = pixel.g; out[offset + 2] = pixel.b; out[offset + 3] = pixel.a;
    } else {
      const sa = pixel.a / 255, destA = da / 255;
      const outA = sa + destA * (1 - sa);
      if (outA <= 0) continue;
      out[offset] = Math.round((pixel.r * sa + out[offset] * destA * (1 - sa)) / outA);
      out[offset + 1] = Math.round((pixel.g * sa + out[offset + 1] * destA * (1 - sa)) / outA);
      out[offset + 2] = Math.round((pixel.b * sa + out[offset + 2] * destA * (1 - sa)) / outA);
      out[offset + 3] = Math.round(outA * 255);
    }
  }
  return out;
}

function compositeLayer(destination, source) {
  const out = Buffer.from(destination);
  for (let i = 0; i < source.length; i += 4) {
    const sa = source[i + 3] / 255;
    if (!sa) continue;
    const da = out[i + 3] / 255;
    if (!da) {
      source.copy(out, i, i, i + 4);
      continue;
    }
    const outA = sa + da * (1 - sa);
    out[i] = Math.round((source[i] * sa + out[i] * da * (1 - sa)) / outA);
    out[i + 1] = Math.round((source[i + 1] * sa + out[i + 1] * da * (1 - sa)) / outA);
    out[i + 2] = Math.round((source[i + 2] * sa + out[i + 2] * da * (1 - sa)) / outA);
    out[i + 3] = Math.round(outA * 255);
  }
  return out;
}

async function uploadProject(page, project, expectedRevision) {
  const serialized = JSON.stringify(project);
  const totalBytes = Buffer.byteLength(serialized, 'utf8');
  const chunkSize = 6 * 1024 * 1024;
  const totalChunks = Math.ceil(totalBytes / chunkSize);
  const uploadId = randomUUID().replace(/-/g, '').slice(0, 32);
  const begin = await page.evaluate(async body => {
    const r = await fetch('/api/pixelforge/projects/uploads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, { uploadId, projectId, expectedServerRevision: expectedRevision, totalBytes, totalChunks });
  if (![200, 201].includes(begin.status)) throw new Error('Upload begin failed: HTTP ' + begin.status + ' ' + JSON.stringify(begin.body));
  for (let index = 0; index < totalChunks; index++) {
    const bytes = Buffer.from(serialized, 'utf8').subarray(index * chunkSize, Math.min(totalBytes, (index + 1) * chunkSize));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const result = await page.evaluate(async ({ uploadId, index, chunk, sha256 }) => {
      const r = await fetch('/api/pixelforge/projects/uploads/' + uploadId + '/' + index, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chunk, sha256 })
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    }, { uploadId, index, chunk: bytes.toString('base64'), sha256 });
    if (result.status !== 200) throw new Error('Upload chunk ' + index + ' failed: HTTP ' + result.status + ' ' + JSON.stringify(result.body));
  }
  const commit = await page.evaluate(async uploadId => {
    const r = await fetch('/api/pixelforge/projects/uploads/' + uploadId + '/commit', { method: 'POST' });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, uploadId);
  if (![200, 201].includes(commit.status)) throw new Error('Upload commit failed: HTTP ' + commit.status + ' ' + JSON.stringify(commit.body));
  return commit.body;
}

// Revision 3 is the last clean source before the failed revision-4 pixel manipulation.
const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soldier-walk-source-'));
execFileSync('gh', ['run', 'download', sourceRunId, '--repo', repository, '--name', sourceArtifactName, '--dir', sourceDir], {
  env: { ...process.env, GH_TOKEN: githubToken }, stdio: 'inherit'
});
const sourceProject = JSON.parse(await fs.readFile(path.join(sourceDir, 'soldier-walk-project.json'), 'utf8'));
if (sourceProject.id !== projectId || !Array.isArray(sourceProject.animation?.frames)) {
  throw new Error('The clean revision-3 source artifact does not match the expected Soldier Walk project.');
}

const current = await bridgeGet('/api/agent/bridge/pixelforge/projects/' + encodeURIComponent(projectId));
if (current.workspaceId !== expectedWorkspace) throw new Error('Refusing to modify a non-ADMIN workspace.');
const currentRevision = Number(current.serverRevision);
if (currentRevision !== 4) throw new Error('Expected the failed revision 4 to be current; found revision ' + currentRevision + '. Refusing an unsafe overwrite.');

const project = sourceProject;
const animation = project.animation;
if (animation.frames.length !== 20 || animation.fps !== 12) throw new Error('Unexpected source timeline.');
const characterLayer = project.layers.find(layer => layer.name === characterLayerName);
if (!characterLayer || !animation.layerIds.includes(characterLayer.id)) throw new Error('Expected Soldier layer was not found.');
const characterLayerId = characterLayer.id;
let changedPixels = 0;
const frameDiagnostics = [];

for (let index = 0; index < animation.frames.length; index++) {
  const frame = animation.frames[index];
  const cel = frame.cels.find(item => item.layerId === characterLayerId);
  if (!cel || typeof cel.pixels !== 'string') throw new Error('Missing Soldier cel in frame ' + index);
  const source = Buffer.from(cel.pixels, 'base64');
  if (source.length !== project.width * project.height * 4) throw new Error('Unexpected RGBA cel size in frame ' + index);
  const phase = index / animation.frames.length * Math.PI * 2;

  // Restore the pre-polish poses by undoing revision 3's global sprite offsets.
  const previousDx = Math.round(Math.sin(phase));
  const previousDy = Math.round(1.5 * Math.cos(phase * 2));
  const base = translateRgba(source, project.width, project.height, -previousDx, -previousDy);

  const width = project.width, height = project.height;
  const isGrey = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b) < 15 && (r + g + b) / 3 > 60;

  // Separate the lower legs from the one-piece sprite cel, move each leg independently,
  // and keep the semi-transparent contact shadow fixed.
  const left = extractRegion(base, width, height,
    (x, y, r, g, b, a) => y >= 117 && y < 140 && a >= 200 && x < 64 && !isGrey(r, g, b));
  const right = extractRegion(left.body, width, height,
    (x, y, r, g, b, a) => y >= 117 && y < 140 && a >= 200 && x >= 64 && x <= 96 && !isGrey(r, g, b));

  const stride = Math.sin(phase);
  const bodyDy = Math.round(-Math.cos(phase * 2));
  const leftDx = Math.round(2 * stride);
  const rightDx = Math.round(-2 * stride);
  const leftDy = bodyDy + (stride > 0 ? -1 : 0);
  const rightDy = bodyDy + (stride < 0 ? -1 : 0);

  let body = moveRegion(right.body, width, height,
    (x, y, r, g, b) => y < 96 || (y < 130 && isGrey(r, g, b)),
    0, bodyDy);

  const movedLeft = translateRgba(left.part, width, height, leftDx, leftDy);
  const movedRight = translateRgba(right.part, width, height, rightDx, rightDy);
  body = compositeLayer(body, movedLeft);
  body = compositeLayer(body, movedRight);

  for (let i = 0; i < source.length; i += 4) {
    if (source[i] !== body[i] || source[i + 1] !== body[i + 1] || source[i + 2] !== body[i + 2] || source[i + 3] !== body[i + 3]) changedPixels++;
  }
  cel.pixels = body.toString('base64');
  frameDiagnostics.push({ index, bodyDy, leftDx, rightDx, leftDy, rightDy, restoredOffset: [previousDx, previousDy] });
}

project.serverRevision = currentRevision + 1;
console.log('[REPAIR] Prepared revision:', JSON.stringify({
  projectId, workspaceId: expectedWorkspace, fromRevision: currentRevision, sourceArtifactRun: sourceRunId,
  restoredSourceRevision: 2, frameCount: animation.frames.length, fps: animation.fps, changedPixels, frameDiagnostics
}));

const browser = await playwrightChromium.launch({
  args: chromiumBinary.args, executablePath: await chromiumBinary.executablePath(), headless: true, timeout: 60000
});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: 'dark' });
  const page = await context.newPage();
  const handoff = await bridgePost('/api/agent/bridge/admin-handoff');
  const response = await page.goto(baseUrl + '/api/auth/native-handoff?ticket=' + encodeURIComponent(handoff.ticket), {
    waitUntil: 'domcontentloaded', timeout: 30000
  });
  if (!response || ![200, 303].includes(response.status())) throw new Error('ADMIN handoff failed.');
  const saved = await uploadProject(page, project, currentRevision);
  console.log('[REPAIR] Upload:', JSON.stringify(saved));
} finally {
  await browser.close();
}

const persisted = await bridgeGet('/api/agent/bridge/pixelforge/projects/' + encodeURIComponent(projectId));
if (persisted.workspaceId !== expectedWorkspace || Number(persisted.serverRevision) !== currentRevision + 1) {
  throw new Error('Persisted revision verification failed.');
}
if (persisted.contentSha256 === current.contentSha256) throw new Error('Persisted content hash did not change.');
const verification = {
  status: 'persisted',
  projectId, workspaceId: persisted.workspaceId,
  beforeRevision: currentRevision, afterRevision: persisted.serverRevision,
  restoredFromRevision: 2, sourceArtifactRun: sourceRunId,
  beforeSha256: current.contentSha256, afterSha256: persisted.contentSha256,
  frameCount: persisted.project.animation.frames.length, fps: persisted.project.animation.fps,
  changedPixels,
  method: 'Restore clean revision-2 poses; isolate and alternate lower-leg pixel regions within the existing Soldier cel; add a one-pixel upper-body counter-bob; preserve the contact shadow, rifle, background and ground.'
};
await fs.writeFile((process.env.RUNNER_TEMP || '/tmp') + '/soldier-walk-repair-verification.json', JSON.stringify(verification, null, 2));
console.log('[REPAIR] Persisted verification:', JSON.stringify(verification));
