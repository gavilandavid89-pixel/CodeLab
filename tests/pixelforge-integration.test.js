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
    // A saved-project chooser can be open after account/project recovery; close it
    // explicitly so the modal does not intercept the canvas interaction below.
    const projectsDialog = accountPage.locator('#projects-dialog');
    if (await projectsDialog.isVisible()) await accountPage.locator('#close-projects').click();
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

    // Exercise real raster tools through pointer events, then inspect the
    // account-persisted RGBA buffers (not just button presence or status text).
    const canvasLocator = accountPage.locator('#canvas');
    const documentWidth = 12, documentHeight = 8;
    async function pixelPosition(x, y) {
      const box = await canvasLocator.boundingBox();
      const zoomText = await accountPage.locator('#zoom-label').innerText();
      const zoom = Number.parseFloat(zoomText) / 100;
      assert.ok(box && Number.isFinite(zoom) && zoom > 0, 'canvas viewport and zoom should be measurable');
      return {
        x: box.width / 2 + (x + 0.5 - documentWidth / 2) * zoom,
        y: box.height / 2 + (y + 0.5 - documentHeight / 2) * zoom
      };
    }
    async function clickPixel(x, y) {
      await canvasLocator.click({ position: await pixelPosition(x, y) });
    }
    async function setForegroundColor(value) {
      await accountPage.locator('#color').evaluate((input, color) => {
        input.value = color;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, value);
    }
    async function waitForRasterSave() {
      await accountPage.waitForFunction(() => {
        const save = document.querySelector('#save');
        return save?.dataset.dirty === 'false' &&
          document.querySelector('#status')?.textContent.includes('Saved to your CodeLab account');
      }, null, { timeout: 15000 });
    }
    async function readSavedArtwork() {
      const list = await (await fetch(base + '/api/pixelforge/projects', { headers: authHeaders })).json();
      const metadata = list.projects.find(project => project.name === 'Browser account artwork');
      assert.ok(metadata, 'tool edits should remain attached to the saved account project');
      const response = await fetch(base + '/api/pixelforge/projects/' + metadata.id, { headers: authHeaders });
      assert.equal(response.status, 200, 'tool edits should be readable from persistent project storage');
      return (await response.json()).project;
    }
    function rgbaAt(project, x, y, layerIndex = 0) {
      const bytes = Buffer.from(project.layers[layerIndex].pixels, 'base64');
      const offset = (y * project.width + x) * 4;
      return [...bytes.subarray(offset, offset + 4)];
    }
    function mergedHexAt(project, x, y) {
      let red = 0, green = 0, blue = 0, alpha = 0;
      project.layers.forEach((layer, index) => {
        if (layer.visible === false || layer.opacity <= 0) return;
        const [r, g, b, a] = rgbaAt(project, x, y, index);
        const sourceAlpha = a / 255 * layer.opacity, remaining = 1 - sourceAlpha;
        red = r * sourceAlpha + red * remaining;
        green = g * sourceAlpha + green * remaining;
        blue = b * sourceAlpha + blue * remaining;
        alpha = sourceAlpha + alpha * remaining;
      });
      if (!alpha) return null;
      return '#' + [red / alpha, green / alpha, blue / alpha]
        .map(value => Math.round(value).toString(16).padStart(2, '0')).join('');
    }

    await setForegroundColor('#ff0000');
    await accountPage.locator('#brush-tool').click();
    await clickPixel(2, 2);
    await waitForRasterSave();
    let toolProject = await readSavedArtwork();
    assert.deepEqual(rgbaAt(toolProject, 2, 2), [255, 0, 0, 255],
      'pencil pointer input should write the selected color to the expected raster pixel');

    await accountPage.locator('#eraser-tool').click();
    await clickPixel(2, 2);
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.equal(rgbaAt(toolProject, 2, 2)[3], 0, 'eraser should clear the target pixel to transparency');

    await setForegroundColor('#00aa44');
    await accountPage.locator('#fill-tool').click();
    await clickPixel(0, 0);
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.deepEqual(rgbaAt(toolProject, 0, 0), [0, 170, 68, 255],
      'bucket fill should update the selected connected transparent region');

    await accountPage.locator('#undo').click();
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.equal(rgbaAt(toolProject, 0, 0)[3], 0, 'undo should revert the bucket fill in persisted pixels');
    await accountPage.locator('#redo').click();
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.deepEqual(rgbaAt(toolProject, 0, 0), [0, 170, 68, 255],
      'redo should restore the bucket fill in persisted pixels');

    await accountPage.locator('#add-layer').click();
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.equal(toolProject.layers.length, 2, 'add-layer should create a second persisted raster layer');
    await setForegroundColor('#2255ee');
    await accountPage.locator('#line-tool').click();
    const lineStart = await pixelPosition(1, 1), lineEnd = await pixelPosition(10, 6);
    await canvasLocator.hover({ position: lineStart });
    await accountPage.mouse.move((await canvasLocator.boundingBox()).x + lineStart.x, (await canvasLocator.boundingBox()).y + lineStart.y);
    await accountPage.mouse.down();
    const canvasBoxForLine = await canvasLocator.boundingBox();
    await accountPage.mouse.move(canvasBoxForLine.x + lineEnd.x, canvasBoxForLine.y + lineEnd.y, { steps: 8 });
    await accountPage.mouse.up();
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.ok(rgbaAt(toolProject, 1, 1, 1)[3] > 0 && rgbaAt(toolProject, 10, 6, 1)[3] > 0,
      'line tool should rasterize its drag path into the active layer and persist both endpoints');

    await setForegroundColor('#ffffff');
    await accountPage.locator('#gradient-tool').click();
    const gradientStart = await pixelPosition(0, 7), gradientEnd = await pixelPosition(11, 7);
    const gradientBox = await canvasLocator.boundingBox();
    await accountPage.mouse.move(gradientBox.x + gradientStart.x, gradientBox.y + gradientStart.y);
    await accountPage.mouse.down();
    await accountPage.mouse.move(gradientBox.x + gradientEnd.x, gradientBox.y + gradientEnd.y, { steps: 10 });
    await accountPage.mouse.up();
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.ok(rgbaAt(toolProject, 0, 7, 1)[3] > 0 && rgbaAt(toolProject, 11, 7, 1)[3] > 0,
      'gradient tool should apply and persist a raster gradient across its drag endpoints');


    // Additional UI-level coverage for tools beyond pencil, eraser, fill, line and gradient.
    const eyedropperFixture = await readSavedArtwork();
    const expectedSample = mergedHexAt(eyedropperFixture, 1, 1);
    assert.ok(expectedSample, 'eyedropper fixture pixel should be visible in the merged artwork');
    await accountPage.locator('#eyedropper-tool').click();
    await clickPixel(1, 1);
    assert.equal((await accountPage.locator('#color').inputValue()).toLowerCase(), expectedSample,
      'eyedropper should sample the exact merged pixel color into the foreground control');

    await setForegroundColor('#ff8800');
    await accountPage.locator('#rectangle-tool').click();
    const rectangleBox = await canvasLocator.boundingBox();
    const rectangleStart = await pixelPosition(3, 2), rectangleEnd = await pixelPosition(5, 4);
    await accountPage.mouse.move(rectangleBox.x + rectangleStart.x, rectangleBox.y + rectangleStart.y);
    await accountPage.mouse.down();
    await accountPage.mouse.move(rectangleBox.x + rectangleEnd.x, rectangleBox.y + rectangleEnd.y, { steps: 8 });
    await accountPage.mouse.up();
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.deepEqual(rgbaAt(toolProject, 3, 2, 1), [255, 136, 0, 255],
      'rectangle tool should persist its first corner');
    assert.deepEqual(rgbaAt(toolProject, 5, 4, 1), [255, 136, 0, 255],
      'rectangle tool should persist its opposite corner');

    await setForegroundColor('#00ccdd');
    await accountPage.locator('#ellipse-tool').click();
    const ellipseBox = await canvasLocator.boundingBox();
    const ellipseStart = await pixelPosition(7, 2), ellipseEnd = await pixelPosition(10, 5);
    await accountPage.mouse.move(ellipseBox.x + ellipseStart.x, ellipseBox.y + ellipseStart.y);
    await accountPage.mouse.down();
    await accountPage.mouse.move(ellipseBox.x + ellipseEnd.x, ellipseBox.y + ellipseEnd.y, { steps: 8 });
    await accountPage.mouse.up();
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.ok(rgbaAt(toolProject, 8, 3, 1)[3] > 0,
      'ellipse tool should persist pixels inside the ellipse');

    // Selection masks constrain edits, and the selection operations remain usable.
    await accountPage.locator('#select-tool').click();
    const selectionBox = await canvasLocator.boundingBox();
    const selectionStart = await pixelPosition(4, 5), selectionEnd = await pixelPosition(6, 6);
    await accountPage.mouse.move(selectionBox.x + selectionStart.x, selectionBox.y + selectionStart.y);
    await accountPage.mouse.down();
    await accountPage.mouse.move(selectionBox.x + selectionEnd.x, selectionBox.y + selectionEnd.y, { steps: 4 });
    await accountPage.mouse.up();
    assert.match(await accountPage.locator('#status').innerText(), /Selected 3 × 2 pixels/,
      'rectangular selection should create the expected mask');
    await accountPage.locator('#selection-invert').click();
    await accountPage.locator('#selection-invert').click();
    await accountPage.locator('#selection-expand').click();
    await accountPage.locator('#selection-contract').click();
    await setForegroundColor('#cc22aa');
    await accountPage.locator('#brush-tool').click();
    await clickPixel(5, 5);
    await clickPixel(9, 0);
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.deepEqual(rgbaAt(toolProject, 5, 5, 1), [204, 34, 170, 255],
      'brush edits inside a selection should change selected pixels');
    assert.notDeepEqual(rgbaAt(toolProject, 9, 0, 1), [204, 34, 170, 255],
      'brush edits outside a selection should not alter unselected pixels');

    await accountPage.locator('#magic-select-tool').click();
    await clickPixel(1, 1);
    assert.match(await accountPage.locator('#status').innerText(), /Color selection/,
      'magic wand should create a color-based selection');

    // Transform preview is non-destructive until Apply; the committed transform is undoable.
    await accountPage.locator('#select-tool').click();
    const transformBox = await canvasLocator.boundingBox();
    const transformStart = await pixelPosition(1, 1), transformEnd = await pixelPosition(3, 3);
    await accountPage.mouse.move(transformBox.x + transformStart.x, transformBox.y + transformStart.y);
    await accountPage.mouse.down();
    await accountPage.mouse.move(transformBox.x + transformEnd.x, transformBox.y + transformEnd.y, { steps: 4 });
    await accountPage.mouse.up();
    const beforeTransform = await readSavedArtwork();
    const beforeTransformBytes = Buffer.from(beforeTransform.layers[1].pixels, 'base64');
    await accountPage.locator('#transform-rotation').selectOption('90');
    await accountPage.locator('#transform-preview').click();
    assert.match(await accountPage.locator('#status').innerText(), /Transform preview/,
      'transform should create a preview before modifying pixels');
    assert.equal(await accountPage.locator('#transform-apply').isDisabled(), false,
      'a valid transform preview should enable Apply');
    await accountPage.locator('#transform-cancel').click();
    let afterTransformCancel = await readSavedArtwork();
    assert.deepEqual(Buffer.from(afterTransformCancel.layers[1].pixels, 'base64'), beforeTransformBytes,
      'cancelling transform preview should preserve persisted pixels');
    await accountPage.locator('#transform-preview').click();
    await accountPage.locator('#transform-apply').click();
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.notDeepEqual(Buffer.from(toolProject.layers[1].pixels, 'base64'), beforeTransformBytes,
      'applying transform should commit changed raster pixels');
    await accountPage.locator('#undo').click();
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.deepEqual(Buffer.from(toolProject.layers[1].pixels, 'base64'), beforeTransformBytes,
      'undo should restore the exact pre-transform pixel buffer');

    // Crop preview/cancel is non-destructive; applying crop resizes every layer.
    await accountPage.locator('#select-tool').click();
    const cropBox = await canvasLocator.boundingBox();
    const cropStart = await pixelPosition(2, 1), cropEnd = await pixelPosition(8, 5);
    await accountPage.mouse.move(cropBox.x + cropStart.x, cropBox.y + cropStart.y);
    await accountPage.mouse.down();
    await accountPage.mouse.move(cropBox.x + cropEnd.x, cropBox.y + cropEnd.y, { steps: 5 });
    await accountPage.mouse.up();
    await accountPage.locator('#crop-preview').click();
    assert.match(await accountPage.locator('#status').innerText(), /Crop preview/,
      'crop should create a preview before resizing the canvas');
    await accountPage.locator('#crop-cancel').click();
    assert.equal((await readSavedArtwork()).width, 12,
      'cancelling crop preview should preserve the original canvas width');
    await accountPage.locator('#crop-preview').click();
    await accountPage.locator('#crop-apply').click();
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.equal(toolProject.width, 7, 'crop should resize canvas width to the selection');
    assert.equal(toolProject.height, 5, 'crop should resize canvas height to the selection');
    assert.equal(toolProject.layers.length, 2, 'crop should preserve every raster layer');
    await accountPage.locator('#undo').click();
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.equal(toolProject.width, 12, 'undo should restore canvas width after crop');
    assert.equal(toolProject.height, 8, 'undo should restore canvas height after crop');

    // Layer-management controls must persist structure and metadata, not only update the panel.
    await accountPage.locator('#layers-tab').click();
    await accountPage.locator('#duplicate-layer').click();
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.equal(toolProject.layers.length, 3, 'duplicate-layer should persist a third layer');
    const duplicatedLayerId = toolProject.activeLayerId;
    assert.equal(toolProject.layers.find(layer => layer.id === duplicatedLayerId)?.name, 'Layer 2 copy',
      'duplicated layer should receive a distinct default name');

    accountPage.once('dialog', dialog => dialog.accept('Layer QA'));
    await accountPage.locator('#rename-layer').click();
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.equal(toolProject.layers.find(layer => layer.id === duplicatedLayerId)?.name, 'Layer QA',
      'rename-layer should persist the new layer name');

    await accountPage.locator('#layer-opacity').evaluate(input => {
      input.value = '50';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.equal(toolProject.layers.find(layer => layer.id === duplicatedLayerId)?.opacity, 0.5,
      'active layer opacity should persist its numeric value');

    const activeLayerRow = accountPage.locator('.layer-row').first();
    await activeLayerRow.locator('.layer-visibility:not(.layer-lock)').click();
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.equal(toolProject.layers.find(layer => layer.id === duplicatedLayerId)?.visible, false,
      'layer visibility toggle should persist hidden state');
    await activeLayerRow.locator('.layer-visibility:not(.layer-lock)').click();
    await waitForRasterSave();

    await activeLayerRow.locator('.layer-lock').click();
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.equal(toolProject.layers.find(layer => layer.id === duplicatedLayerId)?.locked, true,
      'layer lock toggle should persist locked state');
    await activeLayerRow.locator('.layer-lock').click();
    await waitForRasterSave();

    await activeLayerRow.locator('.layer-order').last().click();
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.notEqual(toolProject.layers.at(-1).id, duplicatedLayerId,
      'layer reorder should change the persisted layer stack order');

    // Global checker fill should paint both foreground/background cells across matching pixels.
    await setForegroundColor('#ff0000');
    await accountPage.locator('#fill-tool').click();
    await accountPage.locator('#fill-mode').selectOption('global');
    await accountPage.locator('#fill-pattern').selectOption('checker');
    await accountPage.locator('#fill-scale').evaluate(input => {
      input.value = '1';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await clickPixel(0, 0);
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.deepEqual(rgbaAt(toolProject, 0, 0, 2), [255, 0, 0, 255],
      'global checker fill should use foreground color on the first checker cell');
    assert.deepEqual(rgbaAt(toolProject, 1, 0, 2), [36, 38, 50, 255],
      'global checker fill should use background color on the alternating cell');
    await accountPage.locator('#fill-mode').selectOption('contiguous');
    await accountPage.locator('#fill-pattern').selectOption('solid');

    // Symmetry mode 2 mirrors a brush stroke across the vertical document axis.
    await setForegroundColor('#00ff00');
    await accountPage.locator('#symmetry-mode').selectOption('2');
    await accountPage.locator('#brush-tool').click();
    await clickPixel(2, 4);
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.deepEqual(rgbaAt(toolProject, 2, 4, 2), [0, 255, 0, 255],
      'symmetry should draw the source brush pixel');
    assert.deepEqual(rgbaAt(toolProject, 9, 4, 2), [0, 255, 0, 255],
      'two-part symmetry should draw the mirrored brush pixel');
    await accountPage.locator('#symmetry-mode').selectOption('0');

    // Color replacement and flips must alter persisted raster buffers.
    await accountPage.locator('#replace-source').evaluate(input => {
      input.value = '#ff8800';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await setForegroundColor('#113355');
    await accountPage.locator('#replace-color').click();
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.deepEqual(rgbaAt(toolProject, 3, 2, 2), [17, 51, 85, 255],
      'replace-color should replace exact source-color pixels on the active layer');
    await accountPage.locator('#flip-horizontal').click();
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.deepEqual(rgbaAt(toolProject, 8, 2, 2), [17, 51, 85, 255],
      'horizontal flip should mirror the replaced pixel to the opposite canvas coordinate');
    await accountPage.locator('#flip-horizontal').click();
    await waitForRasterSave();

    // Ellipse and lasso selection modes should both create usable selection masks.
    await accountPage.locator('#ellipse-select-tool').click();
    const ellipseSelectionBox = await canvasLocator.boundingBox();
    const ellipseSelectionStart = await pixelPosition(2, 1), ellipseSelectionEnd = await pixelPosition(6, 5);
    await accountPage.mouse.move(ellipseSelectionBox.x + ellipseSelectionStart.x, ellipseSelectionBox.y + ellipseSelectionStart.y);
    await accountPage.mouse.down();
    await accountPage.mouse.move(ellipseSelectionBox.x + ellipseSelectionEnd.x, ellipseSelectionBox.y + ellipseSelectionEnd.y, { steps: 6 });
    await accountPage.mouse.up();
    assert.match(await accountPage.locator('#status').innerText(), /Selected 5 × 5 pixels/,
      'elliptical selection should create a bounded mask');

    await accountPage.locator('#lasso-select-tool').click();
    const lassoBox = await canvasLocator.boundingBox();
    const lassoPoints = [[1, 1], [5, 1], [5, 5], [1, 5], [1, 1]];
    const lassoStart = await pixelPosition(...lassoPoints[0]);
    await accountPage.mouse.move(lassoBox.x + lassoStart.x, lassoBox.y + lassoStart.y);
    await accountPage.mouse.down();
    for (const [x, y] of lassoPoints.slice(1)) {
      const point = await pixelPosition(x, y);
      await accountPage.mouse.move(lassoBox.x + point.x, lassoBox.y + point.y, { steps: 2 });
    }
    await accountPage.mouse.up();
    assert.match(await accountPage.locator('#status').innerText(), /Selected/,
      'freehand lasso should close a polygon and create a selection mask');
    await accountPage.locator('#selection-outline-move [data-selection-move="1,0"]').click();
    assert.match(await accountPage.locator('#status').innerText(), /Selection outline moved/,
      'selection-outline controls should move the mask without changing artwork pixels');

    // View controls should update their UI state without modifying saved artwork.
    const zoomBefore = await accountPage.locator('#zoom-label').innerText();
    await accountPage.locator('#zoom-in').click();
    assert.notEqual(await accountPage.locator('#zoom-label').innerText(), zoomBefore,
      'zoom-in should increase the visible canvas zoom');
    await accountPage.locator('#zoom-out').click();
    await accountPage.locator('#fit').click();
    await accountPage.locator('#grid-toggle').click();
    assert.equal(await accountPage.locator('#grid-toggle').getAttribute('aria-pressed'), 'true',
      'pixel grid toggle should expose its enabled state');
    await accountPage.locator('#grid-toggle').click();
    assert.equal(await accountPage.locator('#grid-toggle').getAttribute('aria-pressed'), 'false',
      'pixel grid toggle should return to its disabled state');

    // Palette controls should add and remove a local swatch.
    const paletteCount = await accountPage.locator('#user-palette .palette-item').count();
    await accountPage.locator('#palette-add').click();
    assert.equal(await accountPage.locator('#user-palette .palette-item').count(), paletteCount + 1,
      'palette-add should create a visible local color swatch');
    await accountPage.locator('#user-palette .palette-item').last().locator('.palette-remove').click();
    assert.equal(await accountPage.locator('#user-palette .palette-item').count(), paletteCount,
      'palette remove should delete only the selected swatch');

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
    assert.equal(await accountPage.locator('#ai-provider-key').inputValue(), '',
      'switching accounts must not carry the previous account API key into PixelForge');
    await accountContext.addCookies([{ name: 'codelab_sid', value: sessionId, url: base, httpOnly: true, sameSite: 'Lax' }]);
    await accountPage.reload({ waitUntil: 'networkidle' });
    await accountPage.locator('#canvas').waitFor({ state: 'visible' });
    assert.equal(await accountPage.locator('#user-palette .palette-item').count(), 1,
      'switching back should restore the original account palette');
    assert.equal(await accountPage.locator('#ai-provider-key').inputValue(), 'test-user-key-not-a-real-secret',
      'switching back should restore only the original account provider settings');

    // Import must persist to the authenticated CodeLab account, not merely
    // report a local save. Verify both the UI result and the stored RGBA data.
    const importFixture = makePixelProject('import-fixture', 'Imported browser artwork', 3, 3);
    const importPixels = Buffer.alloc(3 * 3 * 4);
    importPixels.set([17, 34, 51, 255], (1 * 3 + 2) * 4);
    importFixture.layers[0].pixels = importPixels.toString('base64');
    const importFixturePath = path.join(dataDir, 'pixelforge-import-fixture.pforge');
    fs.writeFileSync(importFixturePath, JSON.stringify(importFixture));
    await accountPage.locator('#import-file').setInputFiles(importFixturePath);
    await accountPage.waitForFunction(() =>
      document.querySelector('#status')?.textContent.includes('Import complete and saved to your CodeLab account'),
      null, { timeout: 15000 });
    const importedMetadata = (await (await fetch(base + '/api/pixelforge/projects', { headers: authHeaders })).json())
      .projects.find(project => project.name === 'Imported browser artwork (imported)');
    assert.ok(importedMetadata, 'imported artwork should be persisted in the signed-in CodeLab account');
    const importedProject = (await (await fetch(base + '/api/pixelforge/projects/' + importedMetadata.id, { headers: authHeaders })).json()).project;
    assert.deepEqual([...Buffer.from(importedProject.layers[0].pixels, 'base64').subarray((1 * 3 + 2) * 4, (1 * 3 + 2) * 4 + 4)],
      [17, 34, 51, 255], 'imported raster pixels should survive account-backed persistence');
    fs.rmSync(importFixturePath, { force: true });
    await accountContext.close();

    // Reaching the per-account project cap must never silently evict an older project.
    const status = await (await fetch(base + '/api/ai/status')).json();
    const maxProjects = status.maxProjects;
    const existingProjects = (await (await fetch(base + '/api/pixelforge/projects', { headers: authHeaders })).json()).projects;
    assert.ok(existingProjects.length < maxProjects, 'the test account should have room to exercise the project cap');
    for (let index = existingProjects.length; index < maxProjects; index++) {
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
