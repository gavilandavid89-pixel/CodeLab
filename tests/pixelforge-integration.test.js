const assert = require('node:assert/strict');
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
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(base + '/pixelforge/index.html', { waitUntil: 'networkidle' });
    await page.locator('#canvas').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#document-size').innerText(), '128 × 128', 'initial artwork dimensions should render');

    await page.locator('#new-document').click();
    await page.locator('#new-dialog').waitFor({ state: 'visible' });
    await page.locator('#new-name').fill('Integration smoke artwork');
    await page.locator('#new-width').fill('64');
    await page.locator('#new-height').fill('32');
    await page.locator('#create-new').click();
    await page.locator('#new-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#document-size').innerText(), '64 × 32', 'creating a document should update the editor');

    // Verify the existing local-first storage survives a full page reload before
    // any future account-sync adapter is introduced.
    await page.locator('#save').click();
    await page.locator('#status').getByText('Saved on this device').waitFor({ state: 'visible' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#canvas').waitFor({ state: 'visible' });
    await page.locator('#projects-button').click();
    await page.locator('#projects-dialog').waitFor({ state: 'visible' });
    const savedArtwork = page.locator('.saved-project-open').filter({ hasText: 'Integration smoke artwork' });
    await savedArtwork.waitFor({ state: 'visible' });
    await savedArtwork.click();
    await page.locator('#projects-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#document-size').innerText(), '64 × 32', 'saved artwork should survive reload and reopen at its original dimensions');

    await page.locator('a[aria-label="Back to CodeLab dashboard"]').click();
    await page.waitForURL(base + '/');
    assert.match(await page.locator('#studioChooser').innerText(), /PixelForge AI/, 'return navigation should land on the studio chooser');
    await context.close();
  } finally {
    await browser.close();
  }
  console.log('PixelForge studio route, assets, navigation, and browser smoke verified.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
