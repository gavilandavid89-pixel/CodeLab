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
  const users = Array.from({ length: 10 }, (_, i) => seedSession('stress-user-' + (i + 1), 'Stress User ' + (i + 1)));
  const initialized = await Promise.all(users.map(async user => {
    const [status, me, init] = await Promise.all([
      request('/api/auth/status', { cookie: user.cookie }),
      request('/api/auth/me', { cookie: user.cookie }),
      request('/api/workspace/init', { method: 'POST', cookie: user.cookie, body: {} })
    ]);
    assert.equal(status.status, 200, user.name + ' auth status should respond');
    assert.equal(status.json.user.id, user.id, user.name + ' identity must not bleed');
    assert.equal(me.status, 200, user.name + ' session should authenticate');
    assert.equal(me.json.user.id, user.id, user.name + ' /auth/me should return its own identity');
    assert.equal(init.status, 200, user.name + ' workspace init should succeed');
    assert.equal(init.json.user.id, user.id, user.name + ' workspace owner identity should match');
    return { user, workspaceId: init.json.workspaceId, token: init.json.token, revision: init.json.state.revision };
  }));

  assert.equal(new Set(initialized.map(x => x.workspaceId)).size, 10, 'All 10 users must receive distinct workspace IDs');
  assert.equal(new Set(initialized.map(x => x.token)).size, 10, 'All 10 users must receive distinct workspace tokens');

  const firstSaveResults = await Promise.all(initialized.map(async (account, i) => {
    const marker = 'PRIVATE_USER_' + (i + 1);
    const result = await request('/api/workspace/' + encodeURIComponent(account.workspaceId), {
      method: 'PUT', cookie: account.user.cookie, token: account.token,
      body: { baseRevision: account.revision, projects: [project('project-' + (i + 1), 'Private project ' + (i + 1), marker)] }
    });
    assert.equal(result.status, 200, account.user.name + ' parallel save should succeed');
    return marker;
  }));

  const snapshots = await Promise.all(initialized.map(async (account, i) => {
    const result = await request('/api/workspace/' + encodeURIComponent(account.workspaceId), {
      cookie: account.user.cookie, token: account.token
    });
    assert.equal(result.status, 200, account.user.name + ' should read its own workspace');
    assert.equal(result.json.projects.length, 1);
    assert.equal(result.json.projects[0].code.html.includes(firstSaveResults[i]), true, 'Own project must persist');
    const serialized = JSON.stringify(result.json);
    for (let j = 0; j < firstSaveResults.length; j++) {
      if (j !== i) assert.equal(serialized.includes(firstSaveResults[j]), false, 'Workspace must not leak another user content');
    }
    return result.json;
  }));

  // Try every user against every other account without the victim's bearer token.
  const crossReads = await Promise.all(initialized.map(async (attacker, i) => {
    const victim = initialized[(i + 1) % initialized.length];
    const result = await request('/api/workspace/' + encodeURIComponent(victim.workspaceId), {
      cookie: attacker.user.cookie
    });
    assert.equal(result.status, 401, attacker.user.name + ' must not read ' + victim.user.name + ' workspace using only their own session');
  }));
  void crossReads;

  // Invalid, empty, and swapped tokens must not grant access.
  const tokenAttacks = await Promise.all(initialized.map(async (attacker, i) => {
    const victim = initialized[(i + 1) % initialized.length];
    const result = await request('/api/workspace/' + encodeURIComponent(victim.workspaceId), {
      cookie: attacker.user.cookie, token: attacker.token
    });
    assert.equal(result.status, 401, 'A different account token must not authorize a victim workspace');
  }));
  void tokenAttacks;

  // Race two writes per account against the same revision. Exactly one must win;
  // the other must receive 409 rather than silently overwriting the winner.
  const conflictResults = await Promise.all(initialized.map(async (account, i) => {
    const revision = snapshots[i].revision;
    const attempts = await Promise.all(['RACE_A_' + i, 'RACE_B_' + i].map(marker =>
      request('/api/workspace/' + encodeURIComponent(account.workspaceId), {
        method: 'PUT', cookie: account.user.cookie, token: account.token,
        body: { baseRevision: revision, projects: [project('project-' + i, 'Race ' + marker, marker)] }
      })
    ));
    assert.equal(attempts.filter(x => x.status === 200).length, 1, 'Exactly one concurrent write should win for ' + account.user.name);
    assert.equal(attempts.filter(x => x.status === 409).length, 1, 'Losing concurrent write should receive revision conflict for ' + account.user.name);
    return attempts;
  }));

  const finalStates = await Promise.all(initialized.map(async (account, i) => {
    const result = await request('/api/workspace/' + encodeURIComponent(account.workspaceId), {
      cookie: account.user.cookie, token: account.token
    });
    assert.equal(result.status, 200);
    assert.equal(result.json.revision, snapshots[i].revision + 1, 'Revision must advance once despite concurrent edits');
    const html = result.json.projects[0].code.html;
    assert.ok(html.includes('RACE_A_' + i) || html.includes('RACE_B_' + i), 'Winning edit must persist');
    for (let j = 0; j < initialized.length; j++) {
      if (j !== i) assert.equal(JSON.stringify(result.json).includes('RACE_A_' + j) || JSON.stringify(result.json).includes('RACE_B_' + j), false, 'Concurrent edits must remain isolated');
    }
    return result.json;
  }));

  const anonymous = await request('/api/workspace/' + encodeURIComponent(initialized[0].workspaceId));
  assert.equal(anonymous.status, 401, 'Anonymous access must be denied');

  const logout = await request('/api/auth/logout', { method: 'POST', cookie: initialized[9].user.cookie, body: {} });
  assert.equal(logout.status, 200, 'Logout should succeed');
  const afterLogout = await request('/api/auth/me', { cookie: initialized[9].user.cookie });
  assert.equal(afterLogout.status, 401, 'Logged-out session must no longer authenticate');

  console.log('10-user isolation stress E2E passed: 10 authenticated test sessions, 10 cross-account reads denied, 10 swapped-token attempts denied, parallel persistence, 10 write races with one winner each, anonymous denial, and logout invalidation.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
