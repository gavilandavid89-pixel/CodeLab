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
        html: '<!doctype html><html><head><title>Browser Fixture</title></head><body><main style="padding:32px;background:#f8fafc"><h1 style="color:#6d28d9">Real browser capture</h1><p>Rendered content for the smoke test.</p><img alt="Tiny fixture" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/3XcAAAAASUVORK5CYII="><div class="background-fixture" aria-hidden="true"></div><button>Action</button></main></body></html>',
        css: 'body { margin: 0; font-family: Arial, sans-serif; } main { min-height: 600px; } .background-fixture { width: 1px; height: 1px; background-image: url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/3XcAAAAASUVORK5CYII="); }',
        js: 'document.body.dataset.test = "not-executed-in-capture";'
      })[kind];
    });
    await page.addScriptTag({ path: 'public/capture.js' });
    const loaderTimeoutMessage = await page.evaluate(async () => {
      const appendChild = document.head.appendChild;
      document.head.appendChild = function (script) {
        window.__codelabStalledCaptureScript = script;
        return script;
      };
      try {
        await window.CodeLabCapture.loadHtml2Canvas(250);
        return '';
      } catch (error) {
        return error && error.message ? error.message : String(error);
      } finally {
        document.head.appendChild = appendChild;
        if (window.__codelabStalledCaptureScript) window.__codelabStalledCaptureScript.remove();
      }
    });
    assert.match(loaderTimeoutMessage, /tardó demasiado en cargarse/, 'A stalled capture-engine download should fail within a bounded time');
    const pendingAssets = await page.evaluate(async () => {
      const image = { loading: 'lazy', complete: false, naturalWidth: 0, addEventListener() {} };
      return window.CodeLabCapture.waitForCaptureAssets({
        images: [image],
        fonts: { ready: Promise.resolve(), status: 'loaded' }
      }, 250);
    });
    assert.equal(pendingAssets.imagesPending, 1, 'Capture diagnostics should report images still loading after timeout');
    assert.equal(pendingAssets.timedOut, true, 'An image that never finishes should time out without hanging capture');
    await page.waitForSelector('#webCaptureBtn');
    await page.selectOption('#webCaptureViewport', '768');
    await page.selectOption('#webCaptureScale', '3');
    const downloads = [];
    const downloadsPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Expected PNG and JSON downloads, received: ' + downloads.map(d => d.suggestedFilename()).join(', '))), 45000);
      page.on('download', (download) => {
        downloads.push(download);
        if (downloads.length === 2) { clearTimeout(timeout); resolve(downloads); }
      });
    });
    await page.click('#webCaptureBtn');
    const receivedDownloads = await downloadsPromise;
    const pngDownload = receivedDownloads.find(download => /\.png$/i.test(download.suggestedFilename()));
    const jsonDownload = receivedDownloads.find(download => /\.json$/i.test(download.suggestedFilename()));
    assert.ok(pngDownload, 'Browser capture must download a PNG');
    assert.ok(jsonDownload, 'Browser capture must download context JSON');
    const pngPath = await pngDownload.path();
    const png = await fs.readFile(pngPath);
    assert.ok(png.length > 500, 'PNG output must contain rendered image data');
    assert.deepEqual(Array.from(png.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10], 'Downloaded image must have a valid PNG signature');
    assert.equal(png.readUInt32BE(16), 768 * 3, 'PNG pixel width must match selected 3× scale');
    assert.equal(png.readUInt32BE(20), 900 * 3, 'PNG pixel height must match selected 3× scale');

    const jsonPath = await jsonDownload.path();
    const context = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
    assert.equal(context.format, 'codelab-ai-web-capture');
    assert.equal(context.viewport.width, 768);
    assert.equal(context.viewport.scale, 3, 'AI context must document the selected image scale');
    assert.equal(context.viewport.pixelWidth, 768 * 3, 'AI context must document the actual output pixel width');
    assert.equal(context.viewport.pixelHeight, 900 * 3, 'AI context must document the actual output pixel height');
    assert.equal(context.renderedPage.assetStatus.imagesTotal, 1, 'Capture should report the image assets it waited for');
    assert.equal(context.renderedPage.assetStatus.imagesLoaded, 1, 'Capture should wait for inline images before rendering');
    assert.equal(context.renderedPage.assetStatus.imagesPending, 0, 'Capture context should report no pending images after successful readiness');
    assert.equal(context.renderedPage.assetStatus.backgroundImagesTotal, 1, 'Capture should discover CSS background image resources');
    assert.equal(context.renderedPage.assetStatus.backgroundImagesLoaded, 1, 'Capture should wait for CSS background images before rendering');
    assert.equal(context.renderedPage.assetStatus.backgroundImagesPending, 0, 'CSS background images should not remain pending after readiness');
    assert.equal(context.renderedPage.assetStatus.timedOut, false, 'Capture assets should be ready before PNG rendering');
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
