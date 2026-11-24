import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { chromium as playwrightChromium } from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
import { HeadlessEditorRuntime } from '../public/pixelforge/src/headless.js';

const projectId = process.env.CODELAB_PROJECT_ID || 'soldier-walk-60f-20261124';
const baseUrl = String(process.env.CODELAB_PUBLIC_URL || 'https://codelab-qedi.onrender.com').replace(/\/+$/, '');
const bridgeToken = String(process.env.CODELAB_AGENT_BRIDGE_CONTROL_SECRET || '');
const expectedWorkspace = 'ws_local_admin';
const expectedFrames = 20;

if (!bridgeToken) throw new Error('CODELAB_AGENT_BRIDGE_CONTROL_SECRET is required.');
if (!/^https:\/\//i.test(baseUrl)) throw new Error('CODELAB_PUBLIC_URL must use HTTPS.');

async function bridgeGet(pathname) {
  const response = await fetch(baseUrl + pathname, {
    headers: { 'x-codelab-agent-bridge-token': bridgeToken, accept: 'application/json' },
    signal: AbortSignal.timeout(120000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('ADMIN bridge GET HTTP ' + response.status + ': ' + String(body.error || 'request_failed'));
  return body;
}

function alphaBounds(base64, width, height) {
  const bytes = Buffer.from(base64, 'base64');
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (bytes[(y * width + x) * 4 + 3] === 0) continue;
      count++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : {
    minX, minY, maxX, maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    area: (maxX - minX + 1) * (maxY - minY + 1),
    alphaPixels: count,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2
  };
}

function shiftRgba(base64, width, height, dx, dy) {
  if (!dx && !dy) return base64;
  const src = Buffer.from(base64, 'base64');
  const dst = Buffer.alloc(src.length);
  for (let y = 0; y < height; y++) {
    const ny = y + dy;
    if (ny < 0 || ny >= height) continue;
    for (let x = 0; x < width; x++) {
      const nx = x + dx;
      if (nx < 0 || nx >= width) continue;
      const s = (y * width + x) * 4;
      const d = (ny * width + nx) * 4;
      src.copy(dst, d, s, s + 4);
    }
  }
  return dst.toString('base64');
}

function roleFromLayer(layer, stat, allStats, width, height) {
  const name = String(layer.name || '').toLowerCase();
  if (/(head|helmet|cabeza|casco)/.test(name)) return 'head';
  if (/(torso|body|chest|cuerpo|pecho)/.test(name)) return 'torso';
  if (/(arm|hand|brazo|mano|shoulder|hombro)/.test(name)) return 'arms';
  if (/(leg|foot|feet|pierna|pie|boot|bota)/.test(name)) return 'legs';

  const meaningful = allStats.filter(s => s.bounds && s.bounds.area < width * height * 0.55);
  if (stat.bounds?.centerY < height * 0.38) return 'head';
  if (stat.bounds?.centerY > height * 0.62) return 'legs';

  const middle = meaningful.filter(s => s.bounds.centerY >= height * 0.38 && s.bounds.centerY <= height * 0.62);
  if (middle.length >= 2) {
    const largest = middle.slice().sort((a, b) => b.bounds.area - a.bounds.area)[0];
    return stat === largest ? 'torso' : 'arms';
  }
  return 'torso';
}

function motionForRole(role, phase) {
  const two = phase * 2;
  if (role === 'head') return { dx: Math.round(0.6 * Math.sin(phase)), dy: Math.round(1.0 * Math.cos(two)) };
  if (role === 'torso') return { dx: Math.round(1.0 * Math.sin(phase)), dy: Math.round(1.5 * Math.cos(two)) };
  if (role === 'arms') return { dx: Math.round(-1.0 * Math.sin(phase)), dy: Math.round(0.8 * Math.sin(two + Math.PI)) };
  if (role === 'legs') return { dx: Math.round(1.5 * Math.sin(phase + Math.PI / 2)), dy: Math.round(0.8 * Math.cos(two)) };
  return { dx: 0, dy: 0 };
}

async function uploadProject(page, project, expectedRevision) {
  const serialized = JSON.stringify(project);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  const uploadId = randomUUID().replace(/-/g, '').slice(0, 32);
  const chunkSize = 6 * 1024 * 1024;
  const totalChunks = Math.ceil(bytes / chunkSize);

  const begin = await page.evaluate(async ({ uploadId, projectId, expectedServerRevision, totalBytes, totalChunks }) => {
    const r = await fetch('/api/pixelforge/projects/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadId, projectId, expectedServerRevision, totalBytes, totalChunks })
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, { uploadId, projectId, expectedServerRevision: expectedRevision, totalBytes: bytes, totalChunks });
  if (![200, 201].includes(begin.status)) throw new Error('Upload begin failed HTTP ' + begin.status + ': ' + JSON.stringify(begin.body));

  for (let index = 0; index < totalChunks; index++) {
    const part = Buffer.from(serialized, 'utf8').subarray(index * chunkSize, Math.min(bytes, (index + 1) * chunkSize));
    const sha256 = createHash('sha256').update(part).digest('hex');
    const result = await page.evaluate(async ({ uploadId, index, chunk, sha256 }) => {
      const r = await fetch('/api/pixelforge/projects/uploads/' + uploadId + '/' + index, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chunk, sha256 })
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    }, { uploadId, index, chunk: part.toString('base64'), sha256 });
    if (result.status !== 200) throw new Error('Upload chunk ' + index + ' failed HTTP ' + result.status + ': ' + JSON.stringify(result.body));
  }

  const commit = await page.evaluate(async uploadId => {
    const r = await fetch('/api/pixelforge/projects/uploads/' + uploadId + '/commit', { method: 'POST' });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, uploadId);
  if (![200, 201].includes(commit.status)) throw new Error('Upload commit failed HTTP ' + commit.status + ': ' + JSON.stringify(commit.body));
  return commit.body;
}

const snapshot = await bridgeGet('/api/agent/bridge/pixelforge/projects/' + encodeURIComponent(projectId));
if (snapshot.workspaceId !== expectedWorkspace) throw new Error('Unexpected ADMIN workspace: ' + snapshot.workspaceId);
if (snapshot.projectId !== projectId) throw new Error('Unexpected project identity.');
const source = snapshot.project;
const frames = source.animation?.frames || [];
if (frames.length !== expectedFrames) throw new Error('Expected exactly ' + expectedFrames + ' source frames, found ' + frames.length + '.');
if (source.animation.fps !== 12) throw new Error('Expected the pinned Soldier Walk source FPS to remain 12.');
const baseRevision = Number(snapshot.serverRevision);
console.log('[POLISH] Source pinned:', JSON.stringify({
  projectId, workspaceId: snapshot.workspaceId, revision: baseRevision,
  sha256: snapshot.contentSha256, frames: frames.length, fps: source.animation.fps,
  layers: source.layers.map(layer => ({ id: layer.id, name: layer.name }))
}));

const runtime = HeadlessEditorRuntime.fromJSON(source);
const frameCels = new Map();
const stats = source.layers.map(layer => ({ layer, bounds: null, samples: [] }));

for (let index = 0; index < frames.length; index++) {
  for (const stat of stats) {
    const result = runtime.execute({ name: 'animation.frame.get_cel', index, layerId: stat.layer.id });
    if (!result.ok) throw new Error('Could not read frame ' + index + ' layer ' + stat.layer.id + ': ' + result.error?.message);
    const pixels = result.result.pixels;
    if (!frameCels.has(index)) frameCels.set(index, new Map());
    frameCels.get(index).set(stat.layer.id, pixels);
    const bounds = alphaBounds(pixels, source.width, source.height);
    if (bounds) stat.samples.push(bounds);
  }
}
for (const stat of stats) {
  const samples = stat.samples;
  stat.bounds = samples.length ? {
    centerX: samples.reduce((s, b) => s + b.centerX, 0) / samples.length,
    centerY: samples.reduce((s, b) => s + b.centerY, 0) / samples.length,
    area: samples.reduce((s, b) => s + b.area, 0) / samples.length,
    alphaPixels: samples.reduce((s, b) => s + b.alphaPixels, 0) / samples.length,
  } : null;
}
console.log('[POLISH] Layer geometry:', JSON.stringify(stats.map(stat => ({
  id: stat.layer.id, name: stat.layer.name, bounds: stat.bounds
}))));

const actions = [];
const roleCounts = {};
for (const stat of stats) {
  const role = roleFromLayer(stat.layer, { bounds: stat.bounds }, stats, source.width, source.height);
  roleCounts[role] = (roleCounts[role] || 0) + 1;
  for (let index = 0; index < frames.length; index++) {
    const phase = (index / frames.length) * Math.PI * 2;
    const motion = motionForRole(role, phase);
    const pixels = frameCels.get(index).get(stat.layer.id);
    const next = shiftRgba(pixels, source.width, source.height, motion.dx, motion.dy);
    if (next !== pixels) actions.push({
      name: 'animation.frame.set_cel',
      index,
      layerId: stat.layer.id,
      pixels: next
    });
  }
}
if (!actions.length) throw new Error('Polish produced no changes.');
console.log('[POLISH] Classified roles:', JSON.stringify(roleCounts), 'actions=', actions.length);

const batch = runtime.executeBatch(actions);
if (!batch.ok) throw new Error('Polish batch failed at action ' + batch.failedIndex + ': ' + (batch.error?.message || 'unknown'));
const diff = runtime.getDiff();
if (!diff.animation || diff.animation.changedPixelCount === 0 && diff.animation.changedPixels === 0) {
  throw new Error('Polish diff reports no animation pixel changes.');
}
runtime.createProposal('Polish Soldier Walk: weight transfer, torso/head bob and secondary arm/leg motion');
const accepted = runtime.acceptProposal();
if (accepted?.status !== 'applied') throw new Error('Polish proposal was not accepted.');
const polished = runtime.toJSON();
polished.serverRevision = baseRevision + 1;
const saved = await (async () => {
  chromiumBinary.setGraphicsMode = false;
  const browser = await playwrightChromium.launch({
    args: chromiumBinary.args,
    executablePath: await chromiumBinary.executablePath(),
    headless: true,
    timeout: 60000
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: 'dark', acceptDownloads: true });
    const page = await context.newPage();
    const handoff = await page.goto(baseUrl + '/api/auth/native-handoff?ticket=' + encodeURIComponent((await bridgeGet('/api/agent/bridge/admin-handoff')).ticket), {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    if (!handoff || ![200, 303].includes(handoff.status())) throw new Error('ADMIN handoff failed HTTP ' + (handoff?.status() || 0));
    return await uploadProject(page, polished, baseRevision);
  } finally {
    await browser.close().catch(() => {});
  }
})();
console.log('[POLISH] Saved:', JSON.stringify(saved));

const verify = await bridgeGet('/api/agent/bridge/pixelforge/projects/' + encodeURIComponent(projectId));
if (Number(verify.serverRevision) !== baseRevision + 1) throw new Error('Persisted revision did not advance by exactly one.');
if (verify.contentSha256 === snapshot.contentSha256) throw new Error('Persisted content hash did not change.');
if (verify.project.animation.frames.length !== expectedFrames || verify.project.animation.fps !== 12) {
  throw new Error('Persisted timeline no longer matches the expected 20-frame/12fps structure.');
}
console.log('[POLISH] Verified persisted revision:', JSON.stringify({
  revision: verify.serverRevision, sha256: verify.contentSha256,
  frames: verify.project.animation.frames.length, fps: verify.project.animation.fps
}));
await fs.writeFile(process.env.GITHUB_STEP_SUMMARY_FILE || 'polish-verification.json', JSON.stringify({
  status: 'verified',
  projectId,
  workspaceId: expectedWorkspace,
  beforeRevision: baseRevision,
  afterRevision: Number(verify.serverRevision),
  beforeSha256: snapshot.contentSha256,
  afterSha256: verify.contentSha256,
  frameCount: verify.project.animation.frames.length,
  fps: verify.project.animation.fps,
  roles: stats.map(stat => ({ layerId: stat.layer.id, name: stat.layer.name, role: roleFromLayer(stat.layer, { bounds: stat.bounds }, stats, source.width, source.height) })),
  diff: diff.animation,
  method: 'Authenticated ADMIN PixelForge project read + HeadlessEditorRuntime pose polish + authenticated PixelForge chunk upload; no B generation.'
}, null, 2));
