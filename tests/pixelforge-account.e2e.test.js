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
  // Isolate this suite from the separate rate-limit stress test running in the same server process.
  headers['X-Forwarded-For'] = '203.0.113.50, 203.0.113.1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(BASE_URL + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await response.json(); } catch (_) {}
  return { status: response.status, json };
}
function pixelProject(id, name, marker) {
  const layerId = 'layer_' + marker;
  return {
    format: 'pixelforge-project', version: 1, id, name, width: 16, height: 16,
    activeLayerId: layerId, revision: 0, saveVersion: 0,
    layers: [{
      id: layerId, name: 'Layer', visible: true, opacity: 1, locked: false,
      pixels: Buffer.alloc(16 * 16 * 4).toString('base64')
    }]
  };
}

(async () => {
  const editorPage = await request('/pixelforge/');
  const editorModule = await request('/pixelforge/src/editor.js');
  assert.equal(editorPage.status, 200, 'CodeLab should serve the separately maintained PixelForge UI at /pixelforge/');
  assert.equal(editorModule.status, 200, 'PixelForge ES modules should be served under the same origin');

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
    method: 'PUT', cookie: alice.cookie, body: { workspaceId: aliceSession.json.workspaceId, project: pixelProject(id, 'Alice sprite', 'alice') }
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.revision, 1);

  const listed = await request('/api/pixelforge/projects', { cookie: alice.cookie });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.projects.length, 1);
  assert.equal(listed.json.projects[0].id, id);

  const aliceNewSession = seedSession('pixel-alice', 'Pixel Alice New Session');
  const sameAccountList = await request('/api/pixelforge/projects', { cookie: aliceNewSession.cookie });
  assert.equal(sameAccountList.status, 200);
  assert.ok(sameAccountList.json.projects.some(project => project.id === id),
    'A new session for the same CodeLab account must recover the same cloud project');

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
    method: 'PUT', cookie: alice.cookie, body: { workspaceId: aliceSession.json.workspaceId, baseRevision: 1, project: pixelProject(id, 'Alice sprite v2', 'alice_v2') }
  });
  assert.equal(update.status, 200);
  assert.equal(update.json.revision, 2);

  const stale = await request('/api/pixelforge/projects/' + id, {
    method: 'PUT', cookie: alice.cookie, body: { workspaceId: aliceSession.json.workspaceId, baseRevision: 1, project: pixelProject(id, 'Stale overwrite', 'stale') }
  });
  assert.equal(stale.status, 409, 'Stale writes must not overwrite newer cloud state');
  const final = await request('/api/pixelforge/projects/' + id, { cookie: alice.cookie });
  assert.equal(final.json.project.name, 'Alice sprite v2');
  assert.equal(final.json.revision, 2);

  const races = await Promise.all(['race_one', 'race_two'].map(marker => request('/api/pixelforge/projects/' + id, {
    method: 'PUT', cookie: alice.cookie, body: { workspaceId: aliceSession.json.workspaceId, baseRevision: 2, project: pixelProject(id, 'Race ' + marker, marker) }
  })));
  assert.equal(races.filter(item => item.status === 200).length, 1, 'Exactly one same-revision cloud save should win');
  assert.equal(races.filter(item => item.status === 409).length, 1, 'The competing cloud save should receive a revision conflict');
  const afterRace = await request('/api/pixelforge/projects/' + id, { cookie: alice.cookie });
  assert.equal(afterRace.json.revision, 3, 'A concurrent race must advance the document revision only once');

  const deleted = await request('/api/pixelforge/projects/' + id, { method: 'DELETE', cookie: alice.cookie });
  assert.equal(deleted.status, 200, 'The account owner should be able to delete their cloud project');
  assert.equal((await request('/api/pixelforge/projects/' + id, { cookie: alice.cookie })).status, 404,
    'A deleted cloud project should no longer be readable');

  const status = await request('/api/ai/status');
  const maxProjects = status.json.maxProjects;
  for (let index = 0; index < maxProjects; index++) {
    const projectId = 'limit_project_' + index;
    const savedProject = await request('/api/pixelforge/projects/' + projectId, {
      method: 'PUT', cookie: alice.cookie,
      body: { workspaceId: aliceSession.json.workspaceId, project: pixelProject(projectId, 'Limit project ' + index, 'limit_' + index) }
    });
    assert.equal(savedProject.status, 200, 'Projects within the account limit should save');
  }
  const overflowId = 'limit_project_overflow';
  const overflow = await request('/api/pixelforge/projects/' + overflowId, {
    method: 'PUT', cookie: alice.cookie,
    body: { workspaceId: aliceSession.json.workspaceId, project: pixelProject(overflowId, 'Overflow project', 'overflow') }
  });
  assert.equal(overflow.status, 409, 'The project cap must reject overflow instead of silently evicting old work');
  assert.equal(overflow.json.error, 'pixelforge_project_limit');
  const retained = await request('/api/pixelforge/projects', { cookie: alice.cookie });
  assert.equal(retained.json.projects.length, maxProjects, 'All saved projects must remain after reaching the cap');

  const invalid = await request('/api/pixelforge/projects/' + crypto.randomUUID(), {
    method: 'PUT', cookie: alice.cookie, body: { workspaceId: aliceSession.json.workspaceId, project: { id: 'mismatch_id', name: 'Invalid', width: 0, height: 0 } }
  });
  assert.equal(invalid.status, 400, 'Invalid document metadata must be rejected');
  const tooManyPixels = await request('/api/pixelforge/projects/' + crypto.randomUUID(), {
    method: 'PUT', cookie: alice.cookie, body: { workspaceId: aliceSession.json.workspaceId, project: { id: 'pixel_area_invalid', name: 'Oversized canvas', width: 8192, height: 8192 } }
  });
  assert.equal(tooManyPixels.status, 400, 'Canvas area must be bounded to prevent oversized pixel allocations');

  // Exercise the actual editor under CodeLab's origin: its Save button must persist through
  // the authenticated cloud adapter, not only through the local IndexedDB fallback.
  const browserUser = seedSession('pixel-browser-user', 'Pixel Browser User');
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => {
      localStorage.setItem('pixelforge.palette.v1:github:pixel-browser-user', JSON.stringify(['#A1B2C3']));
      localStorage.setItem('pixelforge.palette.v1', JSON.stringify(['#DEAD00']));
    });
    await context.addCookies([{ name: 'codelab_sid', value: browserUser.cookie.split('=')[1], url: BASE_URL }]);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const response = await page.goto(BASE_URL + '/pixelforge/', { waitUntil: 'domcontentloaded' });
    assert.equal(response.status(), 200, 'PixelForge must load under the same CodeLab origin');
    await page.locator('#canvas').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#user-palette .palette-item').count(), 1,
      'The signed-in CodeLab account should load only its own saved palette');
    await page.locator('#save').click();
    await page.waitForFunction(async () => {
      const response = await fetch('/api/pixelforge/projects', { cache: 'no-store' });
      if (!response.ok) return false;
      const payload = await response.json();
      return Array.isArray(payload.projects) && payload.projects.length === 1;
    }, null, { timeout: 10000 });
    assert.deepEqual(pageErrors, [], 'PixelForge must initialize without uncaught browser errors');
    const statusText = await page.locator('#status').textContent().catch(() => '');
    assert.match(statusText, /CodeLab cloud|device/i, 'Save status should disclose the active persistence path');

    const browserSession = await request('/api/pixelforge/session', { cookie: browserUser.cookie });
    const disposableId = crypto.randomUUID();
    const disposableSave = await request('/api/pixelforge/projects/' + disposableId, {
      method: 'PUT', cookie: browserUser.cookie,
      body: { workspaceId: browserSession.json.workspaceId, project: pixelProject(disposableId, 'Disposable browser project', 'disposable') }
    });
    assert.equal(disposableSave.status, 200);
    await page.on('dialog', dialog => dialog.accept());
    await page.locator('#projects-button').click();
    const disposableRow = page.locator('.saved-project').filter({ hasText: 'Disposable browser project' });
    await disposableRow.locator('.saved-project-delete').click();
    await disposableRow.waitFor({ state: 'detached' });
    assert.equal((await request('/api/pixelforge/projects/' + disposableId, { cookie: browserUser.cookie })).status, 404,
      'The PixelForge project-list delete control should remove the cloud record');

    const otherBrowserUser = seedSession('pixel-browser-other', 'Pixel Browser Other');
    await context.addCookies([{ name: 'codelab_sid', value: otherBrowserUser.cookie.split('=')[1], url: BASE_URL }]);
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#canvas').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#user-palette .palette-item').count(), 0,
      'Switching CodeLab accounts must not expose the previous account palette');
    const projectsAfterAccountSwitch = await page.evaluate(async () => {
      const persistence = await import('/pixelforge/src/persistence.js');
      return await persistence.listSavedProjects();
    });
    assert.deepEqual(projectsAfterAccountSwitch, [], 'Switching CodeLab accounts must not expose the previous account local backup');
    await context.close();
  } finally { await browser.close(); }

  console.log('PixelForge CodeLab-account E2E passed: same-origin editor boot, authenticated cloud save, account isolation, atomic revisions, stale-write/race rejection, and canvas safety limits.');
})().catch(error => { console.error(error); process.exitCode = 1; });
