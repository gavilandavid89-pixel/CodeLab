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
  assert.doesNotMatch(dashboard, /id="studioChooser"/, 'PixelForge should not appear as a separate top-level studio');
  const designPanelStart = dashboard.indexOf('id="designStudioPanel"');
  const pixelForgeEntry = dashboard.indexOf('id="openPixelForgeFromDesign"');
  const designCanvas = dashboard.indexOf('id="designCanvas"');
  assert.ok(designPanelStart >= 0 && pixelForgeEntry > designPanelStart && pixelForgeEntry < designCanvas,
    'PixelForge should be a direct entry inside CodeLab Design, not a separate dashboard destination');
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
  const pixelForgeHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'pixelforge', 'index.html'), 'utf8');
  assert.match(pixelForgeHtml, /Projects autosave to your CodeLab account/,
    'the studio should describe account-backed persistence, not local-only autosave');
  assert.doesNotMatch(pixelForgeHtml, /Projects autosave locally/,
    'the UI must not imply that local-only storage is the production source of truth');
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

  const fixture = { ...makePixelProject('integration-artwork', 'Account integration artwork'), revision: 2, saveVersion: 2 };
  const saved = await fetch(base + '/api/pixelforge/projects', {
    method: 'PUT',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ project: fixture })
  });
  assert.equal(saved.status, 201, 'first save should create a project in the account');
  fixture.serverRevision = (await saved.json()).project.serverRevision;
  assert.equal(fixture.serverRevision, 1, 'the server should issue the first durable revision token');
  const staleWrite = await fetch(base + '/api/pixelforge/projects', {
    method: 'PUT',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ project: { ...fixture, name: 'Stale session overwrite', revision: 1, saveVersion: 1, serverRevision: 0 } })
  });
  assert.equal(staleWrite.status, 409, 'a stale session must not overwrite a newer saved revision');
  assert.equal((await staleWrite.json()).error, 'pixelforge_revision_conflict',
    'stale project writes should return a stable revision-conflict error');
  const sameRevisionFork = await fetch(base + '/api/pixelforge/projects', {
    method: 'PUT',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ project: { ...fixture, name: 'Concurrent fork with same local revision', revision: fixture.revision, saveVersion: fixture.saveVersion, serverRevision: 0 } })
  });
  assert.equal(sameRevisionFork.status, 409,
    'two divergent sessions with the same local edit revision must still conflict through serverRevision');
  const currentRevisionSave = await fetch(base + '/api/pixelforge/projects', {
    method: 'PUT',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ project: fixture })
  });
  assert.equal(currentRevisionSave.status, 200, 'the current revision token should permit a legitimate subsequent save');
  fixture.serverRevision = (await currentRevisionSave.json()).project.serverRevision;
  assert.equal(fixture.serverRevision, 2, 'a successful update should advance the server revision token');
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
  const invalidServerRevision = await fetch(base + '/api/pixelforge/projects', {
    method: 'PUT',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ project: { ...fixture, id: 'invalid-server-revision', serverRevision: -1 } })
  });
  assert.equal(invalidServerRevision.status, 400, 'server revision tokens must be non-negative integers');
  assert.equal((await invalidServerRevision.json()).error, 'invalid_pixelforge_project');
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
  const crossAccountDelete = await fetch(base + '/api/pixelforge/projects/' + fixture.id, {
    method: 'DELETE', headers: otherHeaders
  });
  assert.equal(crossAccountDelete.status, 404, 'a different account must not delete another account\'s project');
  assert.equal((await fetch(base + '/api/pixelforge/projects/' + fixture.id, { headers: authHeaders })).status, 200,
    'a denied cross-account deletion must leave the owner\'s project intact');
  const staleEditorWrite = await fetch(base + '/api/pixelforge/projects', {
    method: 'PUT',
    headers: {
      ...otherHeaders,
      'content-type': 'application/json',
      'x-codelab-expected-account': encodeURIComponent(JSON.stringify(['github', 'pixelforge-integration-user']))
    },
    body: JSON.stringify({ project: makePixelProject('stale-editor-cross-account-write', 'Must not cross accounts') })
  });
  assert.equal(staleEditorWrite.status, 409, 'the server must reject a PixelForge request whose editor-bound account differs from the active session');
  assert.equal((await staleEditorWrite.json()).error, 'account_session_changed');
  assert.deepEqual((await (await fetch(base + '/api/pixelforge/projects', { headers: otherHeaders })).json()).projects, [],
    'a mismatched editor account header must not create a project in the newly signed-in account');

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
    let holdFirstProjectSave = true;
    let notifyFirstProjectSaveStarted;
    const firstProjectSaveStarted = new Promise(resolve => { notifyFirstProjectSaveStarted = resolve; });
    await accountContext.route('**/*', async route => {
      const headers = { ...route.request().headers(), 'x-forwarded-for': '198.51.100.81' };
      if (holdFirstProjectSave && route.request().method() === 'PUT' &&
          new URL(route.request().url()).pathname === '/api/pixelforge/projects') {
        holdFirstProjectSave = false;
        notifyFirstProjectSaveStarted();
        const response = await route.fetch({ headers });
        // Keep the first response in flight long enough for another edit to
        // queue an autosave. The queued snapshot must use the new server token.
        await new Promise(resolve => setTimeout(resolve, 1200));
        await route.fulfill({ response });
        return;
      }
      await route.continue({ headers });
    });
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
    await Promise.race([
      firstProjectSaveStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error('PixelForge autosave did not start')), 10000))
    ]);
    // Edit while the first autosave response is held. The second queued save
    // must wait for the first serverRevision before capturing its snapshot.
    const canvasBox = await accountPage.locator('#canvas').boundingBox();
    assert.ok(canvasBox && canvasBox.width > 0 && canvasBox.height > 0, 'PixelForge canvas should have a drawable viewport');
    await accountPage.locator('#canvas').click({ position: { x: canvasBox.width / 2, y: canvasBox.height / 2 } });
    await accountPage.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Saved to your CodeLab account'), null, { timeout: 15000 });
    assert.doesNotMatch(await accountPage.locator('#status').innerText(), /revision conflict|changed in another session/i,
      'rapid edits during a delayed save must not conflict with the same editor session');
    await accountPage.reload({ waitUntil: 'networkidle' });
    await accountPage.locator('#canvas').waitFor({ state: 'visible' });
    assert.equal(await accountPage.locator('#document-name').innerText(), 'Browser account artwork', 'the editor should recover the account-saved project after reload');
    assert.equal(await accountPage.locator('#document-size').innerText(), '12 × 8', 'the account-saved project dimensions should survive reload');
    const recoveredMetadata = (await (await fetch(base + '/api/pixelforge/projects', { headers: authHeaders })).json())
      .projects.find(project => project.name === 'Browser account artwork');
    assert.ok(recoveredMetadata, 'the browser-created artwork should remain in the account project list');
    const recoveredProject = (await (await fetch(base + '/api/pixelforge/projects/' + recoveredMetadata.id, { headers: authHeaders })).json()).project;
    assert.ok(Buffer.from(recoveredProject.layers[0].pixels, 'base64').some(value => value !== 0),
      'actual edited raster pixels, not only project metadata, should survive autosave and reload');
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

    // Changing the shared session cookie in another tab must not redirect this
    // still-open editor's autosave into the newly signed-in account.
    await accountContext.addCookies([{ name: 'codelab_sid', value: secondSessionId, url: base, httpOnly: true, sameSite: 'Lax' }]);
    const switchedCanvas = await accountPage.locator('#canvas').boundingBox();
    assert.ok(switchedCanvas && switchedCanvas.width > 0 && switchedCanvas.height > 0, 'the existing editor should remain mounted during a shared-session switch');
    await accountPage.locator('#canvas').click({ position: { x: switchedCanvas.width / 2, y: switchedCanvas.height / 2 } });
    await accountPage.waitForFunction(() => document.querySelector('#status')?.textContent.includes('La sesión de CodeLab cambió'), null, { timeout: 10000 });
    const switchedAccountProjects = await (await fetch(base + '/api/pixelforge/projects', { headers: otherHeaders })).json();
    assert.deepEqual(switchedAccountProjects.projects, [], 'a still-open editor must not save the previous account document into the newly signed-in account');
    await accountPage.reload({ waitUntil: 'networkidle' });
    await accountPage.locator('#canvas').waitFor({ state: 'visible' });
    assert.equal(await accountPage.locator('#user-palette .palette-item').count(), 0,
      'switching to another CodeLab account must not reveal the previous account palette');
    assert.equal(await accountPage.locator('#ai-provider-key').inputValue(), '',
      'switching accounts must not carry the previous account API key into PixelForge');
    await accountContext.addCookies([{ name: 'codelab_sid', value: sessionId, url: base, httpOnly: true, sameSite: 'Lax' }]);
    await accountPage.reload({ waitUntil: 'networkidle' });
    await accountPage.locator('#canvas').waitFor({ state: 'visible' });
    assert.equal(await accountPage.locator('#user-palette .palette-item').count(), 1,
      'switching back should restore the original account palette');
    assert.equal(await accountPage.locator('#ai-provider-key').inputValue(), 'test-user-key-not-a-real-secret',
      'switching back should restore only the original account provider settings');
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
