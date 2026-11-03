'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { exportDesignHtml, buildAiDesignCaptureContext } = require('./design-export');


test('exports one 720x1600 design correctly at desktop and 390x844 mobile viewports', async () => {
  const project = {
    id: 'proj_responsive_viewport_fixture',
    name: 'Responsive viewport fixture',
    type: 'design',
    code: { html: '', css: '', js: '' },
    design: {
      frame: 'mobile', background: '#ffffff', canvasWidth: 720, canvasHeight: 1600,
      revision: 1, layoutMode: 'free',
      elements: [
        { id: 'el_responsive_title', type: 'heading', text: 'Responsive viewport acceptance', x: 24, y: 32, width: 600, height: 80, fontSize: 28, color: '#111827' },
        { id: 'el_responsive_box', type: 'rectangle', x: 50, y: 25, xUnit: '%', yUnit: '%', width: 40, height: 40, background: '#ef4444' }
      ]
    }
  };
  const html = exportDesignHtml(project, [project]);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    for (const viewport of [{ width: 720, height: 1600 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
      try {
        const page = await context.newPage();
        await page.route('**/*', route => /^(data|blob|about):/i.test(route.request().url()) ? route.continue() : route.abort());
        await page.setContent(html, { waitUntil: 'load', timeout: 15000 });
        const layout = await page.locator('#layer-el_responsive_box').evaluate(el => {
          const rect = el.getBoundingClientRect();
          const frame = document.querySelector('.design-frame').getBoundingClientRect();
          return { left: rect.left, top: rect.top, frameWidth: frame.width, viewportWidth: window.innerWidth };
        });
        assert.equal(layout.viewportWidth, viewport.width);
        assert.ok(Math.abs(layout.frameWidth - viewport.width) < 1, 'exported frame must fit the viewport without horizontal overflow');
        const scale = viewport.width / 720;
        assert.ok(Math.abs(layout.left - 360 * scale) < 1, 'percentage X position must survive viewport scaling');
        assert.ok(Math.abs(layout.top - 400 * scale) < 1, 'percentage Y position must survive viewport scaling');
        const screenshot = await page.screenshot({ type: 'png', fullPage: false, animations: 'disabled' });
        assert.equal(screenshot.readUInt32BE(16), viewport.width);
        assert.equal(screenshot.readUInt32BE(20), viewport.height);
        assert.match(await page.locator('body').innerText(), /Responsive viewport acceptance/);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
});

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
        { id: 'el_capture_button', type: 'button', label: 'Action', text: 'Continue', x: 16, y: 110, width: 180, height: 48, fontSize: 16, weight: 600, color: '#ffffff', background: '#2563eb', radius: 10 },
        { id: 'el_responsive', type: 'rectangle', label: 'Responsive position', text: '', x: 50, y: 25, xUnit: '%', yUnit: '%', width: 40, height: 40, background: '#ef4444' },
        { id: 'el_real_png', type: 'image', label: 'Real PNG', x: 16, y: 180, width: 1, height: 1, src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l6kAAAAASUVORK5CYII=' }
      ]
    }
  };
  const scale = 2;
  const contextData = buildAiDesignCaptureContext(project, scale);
  const html = exportDesignHtml(project, [project]);
  assert.equal(contextData.designRevision, project.design.revision);
  assert.match(html, /Headless PNG fixture/);
  assert.match(html, /left:180px;top:200px;/, 'HTML export must resolve percentage positions against the saved canvas');

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
    const imageDecode = await page.locator('#layer-el_real_png').evaluate(async el => {
      const image = el.querySelector('img');
      if (!image) return { present: false, complete: false, width: 0, height: 0 };
      if (!image.complete) await new Promise((resolve, reject) => { image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', reject, { once: true }); });
      return { present: true, complete: image.complete, width: image.naturalWidth, height: image.naturalHeight };
    });
    assert.deepEqual(imageDecode, { present: true, complete: true, width: 1, height: 1 }, 'exported data URL must decode as a real PNG in Chromium');
    const responsivePosition = await page.locator('#layer-el_responsive').evaluate(el => ({ left: el.style.left, top: el.style.top }));
    assert.deepEqual(responsivePosition, { left: '180px', top: '200px' });
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
