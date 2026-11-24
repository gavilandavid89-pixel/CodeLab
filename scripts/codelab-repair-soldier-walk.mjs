import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { chromium as playwrightChromium } from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';

const projectId = process.env.CODELAB_PROJECT_ID || 'soldier-walk-60f-20261124';
const baseUrl = String(process.env.CODELAB_PUBLIC_URL || 'https://codelab-qedi.onrender.com').replace(/\/+$/, '');
const bridgeToken = String(process.env.CODELAB_AGENT_BRIDGE_CONTROL_SECRET || '');
const expectedWorkspace = 'ws_local_admin';
const characterLayerName = 'Soldier · reference-guided';
if (!bridgeToken) throw new Error('CODELAB_AGENT_BRIDGE_CONTROL_SECRET is required.');

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

const snapshot = await bridgeGet('/api/agent/bridge/pixelforge/projects/' + encodeURIComponent(projectId));
if (snapshot.workspaceId !== expectedWorkspace) throw new Error('Refusing to modify a non-ADMIN workspace.');
const project = JSON.parse(JSON.stringify(snapshot.project));
const revision = Number(snapshot.serverRevision);
const animation = project.animation;
if (!animation || !Array.isArray(animation.frames) || animation.frames.length !== 20 || animation.fps !== 12) {
  throw new Error('Expected the pinned 20-frame / 12-FPS Soldier Walk timeline.');
}
const characterLayer = project.layers.find(layer => layer.name === characterLayerName);
if (!characterLayer || !animation.layerIds.includes(characterLayer.id)) throw new Error('Expected Soldier layer was not found in the persisted timeline.');
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

  // Undo the previous whole-sprite translation exactly; it was not an articulation pass.
  const previousDx = Math.round(Math.sin(phase));
  const previousDy = Math.round(1.5 * Math.cos(phase * 2));
  let output = translateRgba(source, project.width, project.height, -previousDx, -previousDy);

  // Add a restrained upper-body counter-bob while keeping the waist and contact shadow anchored.
  const bodyDy = Math.round(-Math.cos(phase * 2));
  const beforeBody = output;
  output = moveRegion(output, project.width, project.height, (x, y) => y < 88, 0, bodyDy);

  // Alternate the lower legs: the swing leg advances laterally and lifts one pixel;
  // neutral grey pixels are excluded so the rifle remains attached to the torso/hand.
  const stride = Math.sin(phase);
  const isGreyRiflePixel = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b) < 15 && (r + g + b) / 3 > 60;
  output = moveRegion(output, project.width, project.height,
    (x, y, r, g, b) => y >= 105 && y < 138 && x < 64 && !isGreyRiflePixel(r, g, b),
    Math.round(2.5 * stride), stride > 0 ? -1 : 0);
  output = moveRegion(output, project.width, project.height,
    (x, y, r, g, b) => y >= 105 && y < 138 && x >= 64 && x <= 96 && !isGreyRiflePixel(r, g, b),
    Math.round(-2.5 * stride), stride < 0 ? -1 : 0);

  for (let i = 0; i < source.length; i += 4) {
    if (source[i] !== output[i] || source[i + 1] !== output[i + 1] || source[i + 2] !== output[i + 2] || source[i + 3] !== output[i + 3]) changedPixels++;
  }
  cel.pixels = output.toString('base64');
  frameDiagnostics.push({ index, bodyDy, stride: Number(stride.toFixed(3)), previousWholeSpriteUndo: [previousDx, previousDy] });
}

project.serverRevision = revision + 1;
console.log('[REPAIR] Prepared:', JSON.stringify({
  projectId, workspaceId: snapshot.workspaceId, fromRevision: revision,
  frameCount: animation.frames.length, fps: animation.fps, changedPixels, frameDiagnostics
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
  const saved = await uploadProject(page, project, revision);
  console.log('[REPAIR] Upload:', JSON.stringify(saved));
} finally {
  await browser.close();
}

const persisted = await bridgeGet('/api/agent/bridge/pixelforge/projects/' + encodeURIComponent(projectId));
if (persisted.workspaceId !== expectedWorkspace || Number(persisted.serverRevision) !== revision + 1) {
  throw new Error('Persisted revision verification failed.');
}
if (persisted.contentSha256 === snapshot.contentSha256) throw new Error('Persisted content hash did not change.');
const verification = {
  status: 'persisted',
  projectId, workspaceId: persisted.workspaceId,
  beforeRevision: revision, afterRevision: persisted.serverRevision,
  beforeSha256: snapshot.contentSha256, afterSha256: persisted.contentSha256,
  frameCount: persisted.project.animation.frames.length, fps: persisted.project.animation.fps,
  changedPixels, method: 'Undo whole-sprite offset; apply phase-based lower-leg alternation and upper-body counter-bob; preserve rifle pixels, background, ground and contact shadow.'
};
await fs.writeFile((process.env.RUNNER_TEMP || '/tmp') + '/soldier-walk-repair-verification.json', JSON.stringify(verification, null, 2));
console.log('[REPAIR] Persisted verification:', JSON.stringify(verification));
