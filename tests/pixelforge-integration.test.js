const assert = require('node:assert/strict');

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
  console.log('PixelForge studio route, assets, and return navigation verified.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
