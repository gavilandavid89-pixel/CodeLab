const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body class="bg-slate-950"><section id="previewPanel"><div class="bg-slate-900 px-3 py-1.5 border-b flex items-center justify-between text-xs"><span>Preview</span><button id="refresh">Refresh</button></div></section></body></html>');
    await page.evaluate(() => {
      window.showToast = (message) => { window.__lastToast = message; };
      window.getCurrentProject = () => ({ id: 'browser-fixture', name: 'Browser Capture Fixture', type: 'web' });
      window.getEditorValue = (kind) => ({
        html: '<!doctype html><html><head><title>Browser Fixture</title></head><body><main style="padding:32px;background:#f8fafc"><h1 style="color:#6d28d9">Real browser capture</h1><p>Rendered content for the smoke test.</p><button>Action</button></main></body></html>',
        css: 'body { margin: 0; font-family: Arial, sans-serif; } main { min-height: 600px; }',
        js: 'document.body.dataset.test = "not-executed-in-capture";'
      })[kind];
    });
    await page.addScriptTag({ path: 'public/capture.js' });
    await page.waitForSelector('#webCaptureBtn');
    await page.selectOption('#webCaptureViewport', '768');
    const pngDownloadPromise = page.waitForEvent('download', { timeout: 45000 });
    await page.click('#webCaptureBtn');
    const pngDownload = await pngDownloadPromise;
    assert.match(pngDownload.suggestedFilename(), /\.png$/i, 'Browser capture must download a PNG');
    const pngPath = await pngDownload.path();
    const png = await fs.readFile(pngPath);
    assert.ok(png.length > 500, 'PNG output must contain rendered image data');
    assert.deepEqual(Array.from(png.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10], 'Downloaded image must have a valid PNG signature');

    const jsonDownload = await page.waitForEvent('download', { timeout: 10000 });
    const jsonPath = await jsonDownload.path();
    const context = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
    assert.equal(context.format, 'codelab-ai-web-capture');
    assert.equal(context.viewport.width, 768);
    assert.equal(context.page.title, 'Browser Fixture');
    assert.match(context.sourceCode.javascript, /not-executed-in-capture/);
    assert.equal(context.page.javascriptIncludedInScreenshot, false);
    assert.match(await page.evaluate(() => window.__lastToast || ''), /Captura web lista/);
    console.log('Browser capture passed: rendered HTML/CSS, valid PNG bytes, responsive viewport and AI context JSON.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
