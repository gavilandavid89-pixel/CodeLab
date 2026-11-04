import test from 'node:test';
import assert from 'node:assert/strict';
import { RasterDocument } from '../public/pixelforge/src/core.js';
import {
  preparePixelForgeProposal,
  acceptPixelForgeProposal,
  discardPixelForgeProposal,
} from '../public/pixelforge/src/headless-bridge.js';

function makeProject(serverRevision = 4) {
  const document = new RasterDocument(12, 12, 'Authenticated fixture');
  const project = document.toJSON();
  project.serverRevision = serverRevision;
  return project;
}
function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return payload; } };
}

test('authenticated bridge loads, proposes, and persists only after explicit approval', async () => {
  const source = makeProject();
  let savedPayload = null;
  const fetcher = async (url, options = {}) => {
    assert.match(url, /^\/api\/pixelforge\/projects\//);
    if (options.method === 'GET') return jsonResponse({ project: source });
    if (options.method === 'PUT') {
      savedPayload = JSON.parse(options.body).project;
      assert.equal(savedPayload.serverRevision, 4, 'save must use the loaded optimistic revision token');
      return jsonResponse({ project: { id: source.id, serverRevision: 5 } });
    }
    throw new Error('Unexpected HTTP method');
  };
  const prepared = await preparePixelForgeProposal({
    projectId: source.id,
    summary: 'Paint a short red line',
    actions: [{ name: 'canvas.draw_line', x0: 1, y0: 2, x1: 8, y1: 2, color: '#FF0000' }],
    fetcher,
  });
  assert.equal(prepared.status, 'proposal');
  assert.ok(prepared.sessionId);
  assert.equal(savedPayload, null, 'preparing a proposal must never persist it');
  await assert.rejects(() => acceptPixelForgeProposal({ sessionId: prepared.sessionId }), /approved:true/);
  const accepted = await acceptPixelForgeProposal({ sessionId: prepared.sessionId, approved: true });
  assert.equal(accepted.status, 'saved');
  assert.equal(accepted.serverRevision, 5);
  assert.ok(savedPayload);
  assert.equal(savedPayload.id, source.id);
});

test('authenticated bridge returns revision conflicts without retrying or overwriting', async () => {
  const source = makeProject(9);
  let putCount = 0;
  const fetcher = async (_url, options = {}) => {
    if (options.method === 'GET') return jsonResponse({ project: source });
    putCount++;
    return jsonResponse({ error: 'pixelforge_revision_conflict', revision: 10 }, 409);
  };
  const prepared = await preparePixelForgeProposal({
    projectId: source.id,
    summary: 'Try a safe edit',
    actions: [{ name: 'canvas.draw_line', x0: 1, y0: 1, x1: 4, y1: 1, color: '#00AAFF' }],
    fetcher,
  });
  await assert.rejects(
    () => acceptPixelForgeProposal({ sessionId: prepared.sessionId, approved: true }),
    error => error.status === 409 && error.code === 'pixelforge_revision_conflict'
  );
  assert.equal(putCount, 1, 'a stale proposal must not be silently retried');
});

test('authenticated bridge discards pending proposals without writing', async () => {
  const source = makeProject();
  let writes = 0;
  const fetcher = async (_url, options = {}) => {
    if (options.method === 'GET') return jsonResponse({ project: source });
    writes++;
    return jsonResponse({ project: { id: source.id, serverRevision: 5 } });
  };
  const prepared = await preparePixelForgeProposal({
    projectId: source.id,
    summary: 'Discard this draft',
    actions: [{ name: 'canvas.draw_line', x0: 1, y0: 1, x1: 4, y1: 1, color: '#00AAFF' }],
    fetcher,
  });
  assert.deepEqual(discardPixelForgeProposal({ sessionId: prepared.sessionId }), { discarded: true, projectId: source.id });
  assert.equal(writes, 0);
});
