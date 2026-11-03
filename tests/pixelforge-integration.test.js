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
    user: { id: 'pixelforge-integration-user', provider: 'local', name: 'PIXELFORGE_TEST', role: 'user' },
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
  const loaded = await fetch(base + '/api/pixelforge/projects/' + fixture.id, { headers: authHeaders });
  assert.deepEqual((await loaded.json()).project, fixture, 'saved project should round-trip through account storage');
  const deleted = await fetch(base + '/api/pixelforge/projects/' + fixture.id, { method: 'DELETE', headers: authHeaders });
  assert.equal(deleted.status, 200, 'account owner should be able to delete their own project');
  assert.equal((await fetch(base + '/api/pixelforge/projects/' + fixture.id, { headers: authHeaders })).status, 404, 'deleted project should no longer be available');
  fs.rmSync(path.join(sessionsDir, sessionId + '.json'), { force: true });

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
  } finally {
    await browser.close();
  }
  console.log('PixelForge routes/assets verified; anonymous account access is correctly blocked.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
