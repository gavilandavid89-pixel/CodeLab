import { createHash, randomUUID } from 'node:crypto';

const sessionId = String(process.env.CODELAB_SESSION_ID || '');
const mailboxBaseUrl = String(process.env.CODELAB_MAILBOX_BASE_URL || 'https://codelab-pbw9.onrender.com').replace(/\/+$/, '');
const mailboxToken = String(process.env.CODELAB_MAILBOX_TOKEN || createHash('sha256').update('codelab-headless-mailbox:v1:' + sessionId).digest('hex'));
const timeoutMs = Math.max(10000, Math.min(10 * 60 * 1000, Number(process.env.CODELAB_SESSION_TIMEOUT_MS || 180000)));

if (!sessionId) throw new Error('CODELAB_SESSION_ID is required.');
if (!/^[a-f0-9]{64}$/i.test(mailboxToken)) throw new Error('CODELAB_MAILBOX_TOKEN is invalid.');

async function mailbox(pathname, method = 'GET', body = null) {
  const response = await fetch(mailboxBaseUrl + pathname, {
    method,
    headers: {
      accept: 'application/json',
      'x-codelab-mailbox-token': mailboxToken,
      ...(body === null ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  let data = null;
  try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error('Headless mailbox HTTP ' + response.status + ': ' + JSON.stringify(data));
  return data;
}

async function send(payload) {
  const requestId = randomUUID();
  const request = { ...payload, requestId, sessionId };
  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      await mailbox('/api/headless/session/request?sessionId=' + encodeURIComponent(sessionId), 'POST', { requestId, payload: request });
      break;
    } catch (error) {
      if (!/(HTTP 404|HTTP 502|HTTP 503|HTTP 504)/.test(String(error.message || error)) || attempt === 60) throw error;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await mailbox('/api/headless/session/result?sessionId=' + encodeURIComponent(sessionId) + '&requestId=' + encodeURIComponent(requestId));
    if (result.status === 'succeeded' || result.status === 'failed' || result.status === 'expired') {
      if (result.status !== 'succeeded') throw new Error('A rejected request ' + requestId + ': ' + JSON.stringify(result.result));
      return result.result;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Timed out waiting for A request ' + requestId);
}

function decodeBase64(value) {
  const binary = Buffer.from(value, 'base64');
  return new Uint8ClampedArray(binary.buffer, binary.byteOffset, binary.byteLength);
}
function encodeBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}
function translateFromExactPrevious(base64, width, height, dx, dy) {
  const source = decodeBase64(base64);
  const next = new Uint8ClampedArray(source.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = x - dx;
      const sy = y - dy;
      if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
      const src = (sy * width + sx) * 4;
      const dst = (y * width + x) * 4;
      next[dst] = source[src];
      next[dst + 1] = source[src + 1];
      next[dst + 2] = source[src + 2];
      next[dst + 3] = source[src + 3];
    }
  }
  return encodeBase64(next);
}

const cycle = [];

const opened = await send({
  kind: 'browser',
  start_path: '/pixelforge/index.html',
  actions: [{ type: 'wait_for', selector: '#canvas', state: 'visible', timeoutMs: 30000 }],
});
cycle.push({
  step: 'B1→A→context',
  browser: {
    finalUrl: opened.finalUrl,
    captureMethod: opened.captureMethod,
    uiActions: opened.ui_actions,
  },
});

const created = await send({ kind: 'pixelforge', operation: 'create_blank_animation' });
if (!created.projectId || !created.context) throw new Error('A did not return a real persisted animation project plus initial context.');
cycle.push({
  step: 'A→context',
  projectId: created.projectId,
  frame: created.context.frame,
  layer: created.context.layer,
  sourcePixelsBytes: Buffer.from(created.context.current.cel, 'base64').byteLength,
  guidance: created.context.guidance,
});

const { SOLDIER_REFERENCE_RASTER } = await import('../public/pixelforge/assets/soldier-reference-raster.mjs');
const referencePixels = SOLDIER_REFERENCE_RASTER.decode();
const referenceBase64 = Buffer.from(referencePixels).toString('base64');

const referenceApplied = await send({
  kind: 'pixelforge',
  operation: 'batch',
  project_id: created.projectId,
  summary: 'B→A: seed the source frame from the authoritative CodeLab reference raster',
  actions: [{
    name: 'animation.frame.set_cel',
    index: 0,
    layerId: created.context.layer.id,
    pixels: referenceBase64,
  }],
});
if (!referenceApplied.context) throw new Error('A did not return context after seeding the source reference.');
cycle.push({
  step: 'B→A→context',
  frame: referenceApplied.context.frame,
  seededFromAuthoritativeReference: true,
  exactReferenceBytes: referencePixels.byteLength,
});

const duplicated = await send({
  kind: 'pixelforge',
  operation: 'batch',
  project_id: created.projectId,
  summary: 'B→A: duplicate exact reference frame',
  actions: [{ name: 'animation.frame.duplicate', index: created.context.frame.index }],
  return_context: false,
});
const duplicateResult = duplicated.results?.[0]?.result || duplicated.results?.[0] || null;
const nextIndex = Number(duplicateResult?.index);
if (!Number.isInteger(nextIndex)) throw new Error('A did not return the duplicated frame index.');
cycle.push({ step: 'B2→A', operation: 'animation.frame.duplicate', nextIndex });

const selected = await send({
  kind: 'pixelforge',
  operation: 'frame_context',
  project_id: created.projectId,
  frame_index: nextIndex,
});
if (!selected.context) throw new Error('A did not return context after querying the new frame.');
cycle.push({
  step: 'A→context',
  frame: selected.context.frame,
  previousFrame: selected.context.previous?.frame ?? null,
  exactPreviousCelBytes: Buffer.from(selected.context.previous?.cel || '', 'base64').byteLength,
  change: selected.context.change,
});

const width = selected.context.visual.width;
const height = selected.context.visual.height;
const previousCel = selected.context.previous?.cel;
if (!previousCel) throw new Error('The new frame context did not expose its exact previous cel.');
const transformed = translateFromExactPrevious(previousCel, width, height, 1, 0);

const applied = await send({
  kind: 'pixelforge',
  operation: 'batch',
  project_id: created.projectId,
  summary: 'B→A: apply one-pixel transformation derived only from returned previous cel',
  actions: [{
    name: 'animation.frame.set_cel',
    index: nextIndex,
    layerId: selected.context.layer.id,
    pixels: transformed,
  }],
});
if (!applied.context) throw new Error('A did not return context after applying the derived cel.');
if (applied.context.frame.index !== nextIndex) throw new Error('A returned the wrong active frame after set_cel.');
if (!applied.context.change) throw new Error('A reported no visual change after the derived cel was applied.');

cycle.push({
  step: 'B3→A→context',
  frame: applied.context.frame,
  previousFrame: applied.context.previous?.frame ?? null,
  changed: applied.context.change,
  result: 'derived-from-exact-previous-cel',
});

console.log(JSON.stringify({
  ok: true,
  protocol: 'B→A→context→B→A→context',
  projectId: created.projectId,
  cycle,
  proof: {
    initialFrameId: created.context.frame.id,
    derivedFrameId: applied.context.frame.id,
    derivedFromFrameId: applied.context.previous?.id ?? null,
    exactPreviousCelUsed: true,
    noAssumedPreviousPixels: true,
    serverReturnedContextAfterMutation: true,
  },
}, null, 2));
