const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const base = process.env.CODELAB_E2E_BASE_URL || 'http://127.0.0.1:3188';

async function main() {
  const dashboardResponse = await fetch(base + '/');
  assert.equal(dashboardResponse.status, 200, 'CodeLab dashboard should be served');
  const dashboard = await dashboardResponse.text();
  assert.match(dashboard, /id="studioChooser"/, 'dashboard should expose the studio chooser');
  assert.match(dashboard, /href="\/pixelforge\/index\.html"/, 'PixelForge should be a separate dashboard destination');
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
  const listBefore = await fetch(base + '/api/pixelforge/projects', { headers: authHeaders });
  assert.equal(listBefore.status, 200, 'authenticated CodeLab users should list their PixelForge projects');
  assert.deepEqual((await listBefore.json()).projects, [], 'new account should start with an empty PixelForge project list');

  const fixture = { id: 'integration-artwork', name: 'Account integration artwork', width: 2, height: 2, layers: [] };
  const saved = await fetch(base + '/api/pixelforge/projects', {
    method: 'PUT',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ project: fixture })
  });
  assert.equal(saved.status, 201, 'first save should create a project in the account');
  const listed = await fetch(base + '/api/pixelforge/projects', { headers: authHeaders });
  assert.equal((await listed.json()).projects[0].name, fixture.name, 'account list should expose saved project metadata');

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

  const loaded = await fetch(base + '/api/pixelforge/projects/' + fixture.id, { headers: authHeaders });
  assert.deepEqual((await loaded.json()).project, fixture, 'saved project should round-trip through account storage');
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
    await accountContext.route('**/*', route => route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': '198.51.100.81' } }));
    await accountContext.addCookies([{ name: 'codelab_sid', value: sessionId, url: base, httpOnly: true, sameSite: 'Lax' }]);
    const accountPage = await accountContext.newPage();
    await accountPage.goto(base + '/pixelforge/index.html', { waitUntil: 'networkidle' });
    await accountPage.locator('#canvas').waitFor({ state: 'visible' });
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
    await accountPage.locator('#projects-button').click();
    await accountPage.locator('#projects-dialog').waitFor({ state: 'visible' });
    await accountPage.locator('.saved-project-open').filter({ hasText: 'Browser account artwork' }).waitFor({ state: 'visible' });
    await accountContext.close();

    // Reaching the per-account project cap must never silently evict an older project.
    const status = await (await fetch(base + '/api/ai/status')).json();
    const maxProjects = status.maxProjects;
    for (let index = 1; index < maxProjects; index++) {
      const response = await fetch(base + '/api/pixelforge/projects', {
        method: 'PUT',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ project: {
          id: 'limit-project-' + index, name: 'Limit project ' + index, width: 2, height: 2, layers: []
        } })
      });
      assert.ok(response.status === 200 || response.status === 201, 'projects below the account limit should save');
    }
    const overflow = await fetch(base + '/api/pixelforge/projects', {
      method: 'PUT',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ project: {
        id: 'limit-project-overflow', name: 'Overflow project', width: 2, height: 2, layers: []
      } })
    });
    assert.equal(overflow.status, 409, 'saving beyond the account project cap should return a conflict');
    assert.equal((await overflow.json()).error, 'pixelforge_project_limit');
    const afterLimit = await (await fetch(base + '/api/pixelforge/projects', { headers: authHeaders })).json();
    assert.equal(afterLimit.projects.length, maxProjects, 'hitting the cap must preserve all existing projects');
    assert.ok(afterLimit.projects.some(project => project.name === 'Browser account artwork'), 'existing project records must remain available');
  } finally {
    await browser.close();
    fs.rmSync(path.join(sessionsDir, sessionId + '.json'), { force: true });
    fs.rmSync(path.join(sessionsDir, secondSessionId + '.json'), { force: true });
  }
  console.log('PixelForge account gate, project CRUD/isolation, and authenticated browser save/reload verified.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
