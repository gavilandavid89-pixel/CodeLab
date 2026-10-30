const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const BASE_URL = process.env.CODELAB_E2E_BASE_URL || 'http://127.0.0.1:3190';
const DATA_DIR = process.env.CODELAB_DATA_DIR;
const SECRET = process.env.CODELAB_WORKSPACE_SECRET || 'test-only-account-isolation-secret';
assert.ok(DATA_DIR, 'CODELAB_DATA_DIR must point to an isolated test data directory');

function seedSession(id, name) {
  const sid = crypto.randomBytes(24).toString('hex');
  const sessionDir = path.join(DATA_DIR, 'sessions');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, sid + '.json'), JSON.stringify({
    id: sid,
    user: { id, provider: 'github', name, email: null, avatar: null },
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000
  }), { mode: 0o600 });
  return { id, name, cookie: 'codelab_sid=' + sid };
}

async function request(route, { method = 'GET', cookie, token, body } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (token) headers['x-workspace-token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(BASE_URL + route, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json;
  try { json = await response.json(); } catch (_) { json = null; }
  return { status: response.status, json };
}

function project(id, name, marker) {
  return {
    id, name, code: {
      html: '<main>' + marker + '</main>',
      css: 'body { --account-marker: ' + marker + '; }',
      js: 'window.accountMarker = "' + marker + '";'
    }
  };
}

(async () => {
  const alice = seedSession('test-account-alice', 'Alice Test');
  const bob = seedSession('test-account-bob', 'Bob Test');

  const [aliceInit, bobInit] = await Promise.all([
    request('/api/workspace/init', { method: 'POST', cookie: alice.cookie, body: {} }),
    request('/api/workspace/init', { method: 'POST', cookie: bob.cookie, body: {} })
  ]);
  assert.equal(aliceInit.status, 200, 'Account A should initialize its authenticated workspace');
  assert.equal(bobInit.status, 200, 'Account B should initialize its authenticated workspace');
  assert.notEqual(aliceInit.json.workspaceId, bobInit.json.workspaceId, 'Different accounts must receive different workspace IDs');
  assert.notEqual(aliceInit.json.token, bobInit.json.token, 'Different accounts must receive different workspace tokens');

  const aProject = project('project-alice-1', 'Alice private project', 'ALICE_ONLY');
  const bProject = project('project-bob-1', 'Bob private project', 'BOB_ONLY');
  const [saveA, saveB] = await Promise.all([
    request('/api/workspace/' + encodeURIComponent(aliceInit.json.workspaceId), {
      method: 'PUT', cookie: alice.cookie, token: aliceInit.json.token,
      body: { baseRevision: aliceInit.json.state.revision, projects: [aProject] }
    }),
    request('/api/workspace/' + encodeURIComponent(bobInit.json.workspaceId), {
      method: 'PUT', cookie: bob.cookie, token: bobInit.json.token,
      body: { baseRevision: bobInit.json.state.revision, projects: [bProject] }
    })
  ]);
  assert.equal(saveA.status, 200, 'Account A save should succeed');
  assert.equal(saveB.status, 200, 'Account B save should succeed');

  const [readA, readB] = await Promise.all([
    request('/api/workspace/' + encodeURIComponent(aliceInit.json.workspaceId), { cookie: alice.cookie, token: aliceInit.json.token }),
    request('/api/workspace/' + encodeURIComponent(bobInit.json.workspaceId), { cookie: bob.cookie, token: bobInit.json.token })
  ]);
  assert.equal(readA.status, 200);
  assert.equal(readB.status, 200);
  assert.equal(readA.json.projects.length, 1);
  assert.equal(readB.json.projects.length, 1);
  assert.equal(readA.json.projects[0].code.html.includes('ALICE_ONLY'), true, 'Account A must retain its own project content');
  assert.equal(readB.json.projects[0].code.html.includes('BOB_ONLY'), true, 'Account B must retain its own project content');
  assert.equal(JSON.stringify(readA.json).includes('BOB_ONLY'), false, 'Account A must not see Account B content');
  assert.equal(JSON.stringify(readB.json).includes('ALICE_ONLY'), false, 'Account B must not see Account A content');

  const [crossReadA, crossReadB] = await Promise.all([
    request('/api/workspace/' + encodeURIComponent(bobInit.json.workspaceId), { cookie: alice.cookie }),
    request('/api/workspace/' + encodeURIComponent(aliceInit.json.workspaceId), { cookie: bob.cookie })
  ]);
  assert.equal(crossReadA.status, 401, 'Account A must not read Account B workspace without B credentials');
  assert.equal(crossReadB.status, 401, 'Account B must not read Account A workspace without A credentials');

  const updatedA = project('project-alice-1', 'Alice edited project', 'ALICE_EDIT_2');
  const updatedB = project('project-bob-1', 'Bob edited project', 'BOB_EDIT_2');
  const [editA, editB] = await Promise.all([
    request('/api/workspace/' + encodeURIComponent(aliceInit.json.workspaceId), {
      method: 'PUT', cookie: alice.cookie, token: aliceInit.json.token,
      body: { baseRevision: readA.json.revision, projects: [updatedA] }
    }),
    request('/api/workspace/' + encodeURIComponent(bobInit.json.workspaceId), {
      method: 'PUT', cookie: bob.cookie, token: bobInit.json.token,
      body: { baseRevision: readB.json.revision, projects: [updatedB] }
    })
  ]);
  assert.equal(editA.status, 200, 'Account A should edit while Account B is active');
  assert.equal(editB.status, 200, 'Account B should edit while Account A is active');

  const [finalA, finalB, anonymousCrossRead] = await Promise.all([
    request('/api/workspace/' + encodeURIComponent(aliceInit.json.workspaceId), { cookie: alice.cookie, token: aliceInit.json.token }),
    request('/api/workspace/' + encodeURIComponent(bobInit.json.workspaceId), { cookie: bob.cookie, token: bobInit.json.token }),
    request('/api/workspace/' + encodeURIComponent(aliceInit.json.workspaceId))
  ]);
  assert.equal(finalA.json.projects[0].code.html.includes('ALICE_EDIT_2'), true, 'A latest edit must persist independently');
  assert.equal(finalB.json.projects[0].code.html.includes('BOB_EDIT_2'), true, 'B latest edit must persist independently');
  assert.equal(anonymousCrossRead.status, 401, 'An anonymous session must not access an account-owned workspace');

  console.log('Two-account isolation E2E passed: independent sessions, parallel saves/edits, private project content, and cross-account access denial.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
