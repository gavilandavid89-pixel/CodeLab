const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const base = process.env.CODELAB_E2E_BASE_URL || 'http://127.0.0.1:3188';

function makePixelProject(id, name, width = 2, height = 2) {
  const layerId = 'layer-' + id;
  return {
    format: 'pixelforge-project', version: 1, id, name, width, height,
    activeLayerId: layerId, revision: 0, saveVersion: 0,
    layers: [{
      id: layerId, name: 'Layer 1', visible: true, opacity: 1, locked: false,
      pixels: Buffer.alloc(width * height * 4).toString('base64')
    }]
  };
}

async function main() {
  const dashboardResponse = await fetch(base + '/');
  assert.equal(dashboardResponse.status, 200, 'CodeLab dashboard should be served');
  const dashboard = await dashboardResponse.text();
  assert.match(dashboard, /id="studioChooser"/, 'dashboard should expose the studio chooser');
  assert.match(dashboard, /href="\/pixelforge\/index\.html"/, 'PixelForge should be a separate dashboard destination');
  assert.ok(dashboard.indexOf('src="/studio-core.js"') < dashboard.indexOf('src="/app.js"'), 'CodeLab dashboard must load the shared runtime before its app');
  assert.match(dashboard, /Crear proyecto/, 'existing project creation should remain available');

  const sharedCoreResponse = await fetch(base + '/studio-core.js');
  assert.equal(sharedCoreResponse.status, 200, 'the shared CodeLab studio runtime should be served');
  const sharedCore = await sharedCoreResponse.text();
  assert.match(sharedCore, /getCodeLabSession/, 'shared runtime should own session resolution');
  assert.match(sharedCore, /codeLabRequest/, 'shared runtime should own API request semantics');

  const pageResponse = await fetch(base + '/pixelforge/index.html');
  assert.equal(pageResponse.status, 200, 'PixelForge entry route should serve its own editor page');
  const page = await pageResponse.text();
  assert.match(page, /id="canvas"/, 'PixelForge artwork canvas should be present');
  assert.match(page, /src="\.\/src\/editor\.js"/, 'PixelForge should load its editor module');
  assert.ok(page.indexOf('src="/studio-core.js"') < page.indexOf('src="./src/editor.js"'), 'PixelForge must load the same shared runtime before its editor');
  assert.match(page, /href="\/"[^>]*CodeLab dashboard|href="\/" title="Back to CodeLab dashboard"/, 'PixelForge should provide a return path to CodeLab');

  for (const path of [
    '/pixelforge/styles.css',
    '/pixelforge/src/editor.js',
    '/pixelforge/src/core.js',
    '/pixelforge/src/persistence.js',
    '/pixelforge/src/workspaces.js',
    '/pixelforge/src/ai-tools.js',
    '/pixelforge/src/ai-provider.js',
    '/pixelforge/src/image-import.js',
    '/pixelforge/src/asset-export.js',
    '/pixelforge/src/headless.js',
    '/pixelforge/src/headless-vision.js',
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path + ' should be served');
    assert.ok((await response.text()).length > 0, path + ' should not be empty');
  }
  const anonymousResponse = await fetch(base + '/api/pixelforge/projects', { headers: { 'x-forwarded-for': '198.51.100.77' } });
  assert.equal(anonymousResponse.status, 401, 'PixelForge project API must require a CodeLab account');
  const anonymousBody = await anonymousResponse.json();
  assert.equal(anonymousBody.error, 'not_authenticated', 'anonymous access should have a clear auth error');

  const malformedProjectIdResponse = await fetch(base + '/api/pixelforge/projects/%E0%A4%A', {
    headers: { 'x-forwarded-for': '198.51.100.78' }
  });
  assert.equal(malformedProjectIdResponse.status, 401, 'authentication must be checked before parsing project IDs');

  // Build a test-only session in the isolated E2E data directory, using the
  // same on-disk session contract as CodeLab's real login flow.
  const dataDir = process.env.CODELAB_DATA_DIR || path.join(__dirname, '..', 'data');
  const sessionId = 'a'.repeat(48);
  const sessionsDir = path.join(dataDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, sessionId + '.json'), JSON.stringify({
    id: sessionId,
    user: { id: 'pixelforge-integration-user', provider: 'github', name: 'PIXELFORGE_TEST', role: 'user' },
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000
  }), { mode: 0o600 });
  const authHeaders = { cookie: 'codelab_sid=' + sessionId, 'x-forwarded-for': '198.51.100.79' };
  const authenticatedMalformedId = await fetch(base + '/api/pixelforge/projects/%E0%A4%A', { headers: authHeaders });
  assert.equal(authenticatedMalformedId.status, 400, 'malformed encoded project IDs should return a client error, not crash the API');
  assert.equal((await authenticatedMalformedId.json()).error, 'invalid_project_id', 'malformed project ID should have a stable error code');
  const coreWorkspaceResponse = await fetch(base + '/api/workspace/init', {
    method: 'POST',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(coreWorkspaceResponse.status, 200, 'PixelForge must use the same authenticated CodeLab workspace identity');
  const coreWorkspace = await coreWorkspaceResponse.json();
  assert.equal(coreWorkspace.workspaceId, 'ws_github_pixelforge-integration-user', 'PixelForge account identity should match CodeLab workspace identity');
  const workspaceFile = path.join(dataDir, 'workspaces', coreWorkspace.workspaceId + '.json');
  assert.ok(fs.existsSync(workspaceFile), 'CodeLab core should own the account workspace used by PixelForge');
  const pixelForgeStoreFile = workspaceFile + '.pixelforge.json';
  // The database may persist between CI runs; clear only this dedicated test
  // account so the assertions remain repeatable without touching real users.
  const priorProjects = await (await fetch(base + '/api/pixelforge/projects', { headers: authHeaders })).json();
  for (const project of priorProjects.projects || []) {
    await fetch(base + '/api/pixelforge/projects/' + encodeURIComponent(project.id), {
      method: 'DELETE', headers: authHeaders
    });
  }
  const health = await (await fetch(base + '/api/health')).json();
  assert.ok(['postgresql', 'server-file'].includes(health.persistence), 'CodeLab should report its active persistence backend');
  const listBefore = await fetch(base + '/api/pixelforge/projects', { headers: authHeaders });
  assert.equal(listBefore.status, 200, 'authenticated CodeLab users should list their PixelForge projects');
  assert.deepEqual((await listBefore.json()).projects, [], 'new account should start with an empty PixelForge project list');

  const fixture = makePixelProject('integration-artwork', 'Account integration artwork');
  const saved = await fetch(base + '/api/pixelforge/projects', {
    method: 'PUT',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ project: fixture })
  });
  assert.equal(saved.status, 201, 'first save should create a project in the account');
  if (health.persistence === 'postgresql') {
    assert.equal(fs.existsSync(pixelForgeStoreFile), false, 'PostgreSQL-backed PixelForge projects must not be duplicated in workspace sidecar files');
  } else {
    assert.ok(fs.existsSync(pixelForgeStoreFile), 'file fallback should stay bound to the same CodeLab workspace identity when PostgreSQL is unavailable');
  }
  const malformed = await fetch(base + '/api/pixelforge/projects', {
    method: 'PUT',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ project: { ...fixture, id: 'invalid-artwork', layers: [] } })
  });
  assert.equal(malformed.status, 400, 'the server must reject malformed PixelForge project structures');
  assert.equal((await malformed.json()).error, 'invalid_pixelforge_project');
  const listed = await fetch(base + '/api/pixelforge/projects', { headers: authHeaders });
  assert.equal((await listed.json()).projects[0].name, fixture.name, 'account list should expose saved project metadata');

  // A fresh session for the same provider/account must resolve the same workspace,
  // matching the cross-device behavior of CodeLab's deterministic account binding.
  const sameAccountSessionId = 'c'.repeat(48);
  fs.writeFileSync(path.join(sessionsDir, sameAccountSessionId + '.json'), JSON.stringify({
    id: sameAccountSessionId,
    user: { id: 'pixelforge-integration-user', provider: 'github', name: 'PIXELFORGE_TEST_NEW_SESSION', role: 'user' },
    createdAt: Date.now(), expiresAt: Date.now() + 60_000
  }), { mode: 0o600 });
  const sameAccountHeaders = { cookie: 'codelab_sid=' + sameAccountSessionId, 'x-forwarded-for': '198.51.100.82' };
  const sameAccountList = await fetch(base + '/api/pixelforge/projects', { headers: sameAccountHeaders });
  assert.equal(sameAccountList.status, 200);
  assert.ok((await sameAccountList.json()).projects.some(project => project.id === fixture.id),
    'a new session for the same CodeLab account must see its saved PixelForge projects');

  const secondSessionId = 'b'.repeat(48);
  fs.writeFileSync(path.join(sessionsDir, secondSessionId + '.json'), JSON.stringify({
    id: secondSessionId,
    user: { id: 'pixelforge-other-user', provider: 'google', name: 'PIXELFORGE_OTHER', role: 'user' },
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000
  }), { mode: 0o600 });
  const otherHeaders = { cookie: 'codelab_sid=' + secondSessionId, 'x-forwarded-for': '198.51.100.80' };
  const otherList = await fetch(base + '/api/pixelforge/projects', { headers: otherHeaders });
  assert.deepEqual((await otherList.json()).projects, [], 'a different CodeLab account must not see another account\'s PixelForge projects');
  assert.equal((await fetch(base + '/api/pixelforge/projects/' + fixture.id, { headers: otherHeaders })).status, 404, 'a different account must not open another account\'s project');

  const concurrentProjects = Array.from({ length: 6 }, (_, index) =>
    makePixelProject('parallel-artwork-' + index, 'Parallel artwork ' + index));
  const concurrentSaves = await Promise.all(concurrentProjects.map(project => fetch(base + '/api/pixelforge/projects', {
    method: 'PUT',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ project })
  })));
  assert.ok(concurrentSaves.every(response => response.status === 201), 'concurrent project creations should all succeed without overwriting each other');
  const afterConcurrentSaves = await (await fetch(base + '/api/pixelforge/projects', { headers: authHeaders })).json();
  for (const project of concurrentProjects) {
    assert.ok(afterConcurrentSaves.projects.some(item => item.id === project.id), 'concurrent write should preserve ' + project.id);
  }
  await Promise.all(concurrentProjects.map(project => fetch(base + '/api/pixelforge/projects/' + project.id, {
    method: 'DELETE', headers: authHeaders
  })));

  const recencyBefore = (await (await fetch(base + '/api/pixelforge/projects', { headers: authHeaders })).json())
    .projects.find(project => project.id === fixture.id);
  assert.ok(recencyBefore, 'saved project metadata should be available before opening the project');
  const loaded = await fetch(base + '/api/pixelforge/projects/' + fixture.id, { headers: authHeaders });
  assert.deepEqual((await loaded.json()).project, fixture, 'saved project should round-trip through account storage');
  const recencyAfter = (await (await fetch(base + '/api/pixelforge/projects', { headers: authHeaders })).json())
    .projects.find(project => project.id === fixture.id);
  assert.ok(recencyAfter.lastOpenedAt > recencyBefore.lastOpenedAt,
    'opening a saved project should update its recent-project timestamp in persistent storage');
  const deleted = await fetch(base + '/api/pixelforge/projects/' + fixture.id, { method: 'DELETE', headers: authHeaders });
  assert.equal(deleted.status, 200, 'account owner should be able to delete their own project');
  assert.equal((await fetch(base + '/api/pixelforge/projects/' + fixture.id, { headers: authHeaders })).status, 404, 'deleted project should no longer be available');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': '198.51.100.78' } }));
    const page = await context.newPage();
    await page.goto(base + '/pixelforge/index.html', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.body.innerText.includes('Inicia sesión en CodeLab'));
    assert.match(await page.locator('body').innerText(), /Ir a CodeLab e iniciar sesión/, 'anonymous visitors should be directed to CodeLab authentication');
    assert.equal(await page.locator('#canvas').count(), 0, 'editor must not initialize before account authentication');
    await context.close();

    const accountContext = await browser.newContext();
    await accountContext.addInitScript(() => {
      localStorage.setItem('pixelforge.palette.v1:github:pixelforge-integration-user', JSON.stringify(['#A1B2C3']));
      localStorage.setItem('pixelforge.palette.v1', JSON.stringify(['#DEAD00']));
      localStorage.setItem('codelab_xd_ai_settings_v1:github_pixelforge-integration-user', JSON.stringify({
        mode: 'api',
        baseUrl: 'https://api.example.test/v1',
        model: 'test-model',
        apiKey: 'test-user-key-not-a-real-secret'
      }));
    });
    await accountContext.route('**/*', route => route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': '198.51.100.81' } }));
    await accountContext.addCookies([{ name: 'codelab_sid', value: sessionId, url: base, httpOnly: true, sameSite: 'Lax' }]);
    const accountPage = await accountContext.newPage();
    await accountPage.goto(base + '/pixelforge/index.html', { waitUntil: 'networkidle' });
    await accountPage.locator('#canvas').waitFor({ state: 'visible' });
    assert.equal(await accountPage.locator('#ai-provider-endpoint').inputValue(), 'https://api.example.test/v1/chat/completions',
      'PixelForge should reuse the authenticated account provider endpoint from CodeLab AI settings');
    assert.equal(await accountPage.locator('#ai-provider-model').inputValue(), 'test-model',
      'PixelForge should reuse the account model from CodeLab AI settings');
    assert.equal(await accountPage.locator('#ai-provider-key').inputValue(), 'test-user-key-not-a-real-secret',
      'PixelForge should prefill the current account key without persisting it in a project');
    assert.equal(await accountPage.locator('#user-palette .palette-item').count(), 1,
      'the signed-in account should load its own palette, not the legacy shared palette');
    await accountPage.locator('#new-document').click();
    await accountPage.locator('#new-dialog').waitFor({ state: 'visible' });
    await accountPage.locator('#new-name').fill('Browser account artwork');
    await accountPage.locator('#new-width').fill('12');
    await accountPage.locator('#new-height').fill('8');
    await accountPage.locator('#create-new').click();
    await accountPage.locator('#new-dialog').waitFor({ state: 'hidden' });
    await accountPage.locator('#save').click();
    await accountPage.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Saved to your CodeLab account'), null, { timeout: 10000 });
    await accountPage.reload({ waitUntil: 'networkidle' });
    await accountPage.locator('#canvas').waitFor({ state: 'visible' });
    assert.equal(await accountPage.locator('#document-name').innerText(), 'Browser account artwork', 'the editor should recover the account-saved project after reload');
    assert.equal(await accountPage.locator('#document-size').innerText(), '12 × 8', 'the account-saved project dimensions should survive reload');
    const deleteFixture = makePixelProject('browser-delete-artwork', 'Browser delete artwork');
    const deleteFixtureResponse = await fetch(base + '/api/pixelforge/projects', {
      method: 'PUT',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ project: deleteFixture })
    });
    assert.equal(deleteFixtureResponse.status, 201, 'a second saved project should be available for UI deletion');
    accountPage.on('dialog', dialog => dialog.accept());
    await accountPage.locator('#projects-button').click();
    await accountPage.locator('#projects-dialog').waitFor({ state: 'visible' });
    await accountPage.locator('.saved-project-open').filter({ hasText: 'Browser account artwork' }).waitFor({ state: 'visible' });
    const deleteRow = accountPage.locator('.saved-project').filter({ hasText: 'Browser delete artwork' });
    await deleteRow.locator('.saved-project-delete').click();
    await deleteRow.waitFor({ state: 'detached' });
    assert.equal((await fetch(base + '/api/pixelforge/projects/browser-delete-artwork', { headers: authHeaders })).status, 404, 'UI deletion must remove the account-owned project from server storage');

    await accountContext.addCookies([{ name: 'codelab_sid', value: secondSessionId, url: base, httpOnly: true, sameSite: 'Lax' }]);
    await accountPage.reload({ waitUntil: 'networkidle' });
    await accountPage.locator('#canvas').waitFor({ state: 'visible' });
    assert.equal(await accountPage.locator('#user-palette .palette-item').count(), 0,
      'switching to another CodeLab account must not reveal the previous account palette');
    await accountContext.addCookies([{ name: 'codelab_sid', value: sessionId, url: base, httpOnly: true, sameSite: 'Lax' }]);
    await accountPage.reload({ waitUntil: 'networkidle' });
    await accountPage.locator('#canvas').waitFor({ state: 'visible' });
    assert.equal(await accountPage.locator('#user-palette .palette-item').count(), 1,
      'switching back should restore the original account palette');
    await accountContext.close();

    // Reaching the per-account project cap must never silently evict an older project.
    const status = await (await fetch(base + '/api/ai/status')).json();
    const maxProjects = status.maxProjects;
    for (let index = 1; index < maxProjects; index++) {
      const response = await fetch(base + '/api/pixelforge/projects', {
        method: 'PUT',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ project: makePixelProject('limit-project-' + index, 'Limit project ' + index) })
      });
      assert.ok(response.status === 200 || response.status === 201, 'projects below the account limit should save');
    }
    const overflow = await fetch(base + '/api/pixelforge/projects', {
      method: 'PUT',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ project: makePixelProject('limit-project-overflow', 'Overflow project') })
    });
    assert.equal(overflow.status, 409, 'saving beyond the account project cap should return a conflict');
    assert.equal((await overflow.json()).error, 'pixelforge_project_limit');
    const afterLimit = await (await fetch(base + '/api/pixelforge/projects', { headers: authHeaders })).json();
    assert.equal(afterLimit.projects.length, maxProjects, 'hitting the cap must preserve all existing projects');
    assert.ok(afterLimit.projects.some(project => project.name === 'Browser account artwork'), 'existing project records must remain available');
  } finally {
    await browser.close();
    fs.rmSync(path.join(sessionsDir, sessionId + '.json'), { force: true });
    fs.rmSync(path.join(sessionsDir, sameAccountSessionId + '.json'), { force: true });
    fs.rmSync(path.join(sessionsDir, secondSessionId + '.json'), { force: true });
  }
  console.log('PixelForge account gate, project CRUD/isolation, and authenticated browser save/reload verified.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
