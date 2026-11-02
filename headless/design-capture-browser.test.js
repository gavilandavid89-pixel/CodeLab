'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { exportDesignHtml, buildAiDesignCaptureContext } = require('./design-export');

test('renders a real PNG paired with the same saved design revision in an isolated browser', async () => {
  const project = {
    id: 'proj_capture_fixture',
    name: 'Capture fixture',
    type: 'design',
    code: { html: '', css: '', js: '' },
    design: {
      frame: 'mobile',
      background: '#ffffff',
      canvasWidth: 360,
      canvasHeight: 800,
      revision: 7,
      layoutMode: 'free',
      elements: [
        { id: 'el_capture_heading', type: 'heading', label: 'Capture title', text: 'Headless PNG fixture', x: 16, y: 20, width: 320, height: 64, fontSize: 26, weight: 700, color: '#111827', background: 'transparent' },
        { id: 'el_capture_button', type: 'button', label: 'Action', text: 'Continue', x: 16, y: 110, width: 180, height: 48, fontSize: 16, weight: 600, color: '#ffffff', background: '#2563eb', radius: 10 }
      ]
    }
  };
  const scale = 2;
  const contextData = buildAiDesignCaptureContext(project, scale);
  const html = exportDesignHtml(project, [project]);
  assert.equal(contextData.designRevision, project.design.revision);
  assert.match(html, /Headless PNG fixture/);

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const isolated = await browser.newContext({
    viewport: { width: contextData.canvas.width, height: contextData.canvas.height },
    deviceScaleFactor: scale,
    serviceWorkers: 'block'
  });
  try {
    const page = await isolated.newPage();
    await page.route('**/*', route => {
      const url = route.request().url();
      if (/^(data|blob|about):/i.test(url)) return route.continue();
      return route.abort();
    });
    await page.setContent(html, { waitUntil: 'load', timeout: 15000 });
    await page.evaluate(() => document.fonts?.ready || Promise.resolve());
    assert.match(await page.locator('body').innerText(), /Headless PNG fixture/);
    const png = await page.screenshot({ type: 'png', fullPage: false, animations: 'disabled', timeout: 20000 });
    assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a', 'capture output must be a PNG binary');
    assert.equal(png.readUInt32BE(16), contextData.canvas.pixelWidth, 'PNG width must match the structured capture context');
    assert.equal(png.readUInt32BE(20), contextData.canvas.pixelHeight, 'PNG height must match the structured capture context');
    assert.ok(png.length > 1000, 'PNG must contain rendered visual content');
    assert.equal(contextData.designRevision, 7, 'PNG context must identify the fixture design revision');
  } finally {
    await isolated.close();
    await browser.close();
  }
});
