const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const BASE_URL = process.env.CODELAB_E2E_BASE_URL || 'http://127.0.0.1:3190';
const DATA_DIR = process.env.CODELAB_DATA_DIR;
assert.ok(DATA_DIR, 'CODELAB_DATA_DIR must point to isolated test data');

function seedSession(id, name) {
  const sid = crypto.randomBytes(24).toString('hex');
  const dir = path.join(DATA_DIR, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sid + '.json'), JSON.stringify({
    id: sid, user: { id, provider: 'github', name, email: null, avatar: null },
    createdAt: Date.now(), expiresAt: Date.now() + 60_000
  }), { mode: 0o600 });
  return { id, name, cookie: 'codelab_sid=' + sid };
}
async function request(route, { method = 'GET', cookie, body } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(BASE_URL + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await response.json(); } catch (_) {}
  return { status: response.status, json };
}
function pixelProject(id, name, marker) {
  return { id, name, width: 16, height: 16, layers: [{ id: 'layer_' + marker, name: 'Layer', visible: true, opacity: 1, locked: false, pixels: Array(16 * 16 * 4).fill(0) }] };
}

(async () => {
  const alice = seedSession('pixel-alice', 'Pixel Alice');
  const bob = seedSession('pixel-bob', 'Pixel Bob');
  const anonymous = await request('/api/pixelforge/session');
  assert.equal(anonymous.status, 401, 'PixelForge cloud identity must require CodeLab sign-in');

  const [aliceSession, bobSession] = await Promise.all([
    request('/api/pixelforge/session', { cookie: alice.cookie }),
    request('/api/pixelforge/session', { cookie: bob.cookie })
  ]);
  assert.equal(aliceSession.status, 200);
  assert.equal(bobSession.status, 200);
  assert.notEqual(aliceSession.json.workspaceId, bobSession.json.workspaceId, 'CodeLab accounts must map to different PixelForge namespaces');

  const id = crypto.randomUUID();
  const saved = await request('/api/pixelforge/projects/' + id, {
    method: 'PUT', cookie: alice.cookie, body: { project: pixelProject(id, 'Alice sprite', 'alice') }
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.revision, 1);

  const listed = await request('/api/pixelforge/projects', { cookie: alice.cookie });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.projects.length, 1);
  assert.equal(listed.json.projects[0].id, id);

  const loaded = await request('/api/pixelforge/projects/' + id, { cookie: alice.cookie });
  assert.equal(loaded.status, 200);
  assert.equal(loaded.json.project.name, 'Alice sprite');
  assert.equal(loaded.json.revision, 1);

  const unauthorizedRead = await request('/api/pixelforge/projects/' + id, { cookie: bob.cookie });
  assert.equal(unauthorizedRead.status, 404, 'Other accounts must not see project existence or content');
  const unauthorizedList = await request('/api/pixelforge/projects', { cookie: bob.cookie });
  assert.equal(unauthorizedList.status, 200);
  assert.equal(unauthorizedList.json.projects.length, 0);

  const update = await request('/api/pixelforge/projects/' + id, {
    method: 'PUT', cookie: alice.cookie, body: { baseRevision: 1, project: pixelProject(id, 'Alice sprite v2', 'alice_v2') }
  });
  assert.equal(update.status, 200);
  assert.equal(update.json.revision, 2);

  const stale = await request('/api/pixelforge/projects/' + id, {
    method: 'PUT', cookie: alice.cookie, body: { baseRevision: 1, project: pixelProject(id, 'Stale overwrite', 'stale') }
  });
  assert.equal(stale.status, 409, 'Stale writes must not overwrite newer cloud state');
  const final = await request('/api/pixelforge/projects/' + id, { cookie: alice.cookie });
  assert.equal(final.json.project.name, 'Alice sprite v2');
  assert.equal(final.json.revision, 2);

  const invalid = await request('/api/pixelforge/projects/' + crypto.randomUUID(), {
    method: 'PUT', cookie: alice.cookie, body: { project: { id: 'mismatch_id', name: 'Invalid', width: 0, height: 0 } }
  });
  assert.equal(invalid.status, 400, 'Invalid document metadata must be rejected');

  console.log('PixelForge CodeLab-account E2E passed: authenticated identity, isolated per-account projects, atomic revisions and stale-write rejection.');
})().catch(error => { console.error(error); process.exitCode = 1; });
