const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');

const BASE_URL = process.env.CODELAB_E2E_BASE_URL || 'http://127.0.0.1:3188';
const ARTIFACT_DIR = process.env.HEADLESS_VISUAL_ARTIFACT_DIR || path.join(os.tmpdir(), 'codelab-visual-evidence');

(async () => {
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const videoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pixelforge-visual-video-'));
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    recordVideo: { dir: videoDir, size: { width: 1440, height: 960 }, fps: 24 }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.stack || e.message || e)));

  try {
    await context.addCookies([{ name: 'codelab_sid', value: 'a'.repeat(48), domain: '127.0.0.1', path: '/', httpOnly: true }]);
    await page.goto(BASE_URL + '/pixelforge/index.html?createDemo=orbital-12&capture=video', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('#canvas').waitFor({ state: 'visible', timeout: 30000 });
    await page.locator('#animation-frame-count').waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForFunction(() => /12 frames/.test(document.getElementById('animation-frame-count')?.textContent || ''), null, { timeout: 30000 });
    await page.locator('#animation-frames .animation-frame').first().waitFor({ state: 'visible', timeout: 30000 });

    const layers = await page.locator('#layer-count').innerText();
    const frames = await page.locator('#animation-frames .animation-frame').count();
    assert.ok(frames >= 12, 'visual showcase must expose at least 12 animation frames');
    assert.match(layers, /[2-9]|1[0-9]/, 'visual showcase must render multiple layers');

    const canvas = page.locator('#canvas');
    const before = await canvas.screenshot({ type: 'png', path: path.join(ARTIFACT_DIR, 'polished-drawing.png') });
    const rasterStats = await canvas.evaluate(node => {
      const ctx = node.getContext('2d');
      const d = ctx.getImageData(0, 0, node.width, node.height).data;
      let opaque = 0, checksum = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 8) opaque++;
        checksum = (checksum + d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7 + d[i + 3]) % 1000000007;
      }
      return { width: node.width, height: node.height, opaque, checksum };
    });
    assert.ok(before.length > 50000, 'drawing screenshot must contain substantial visual content');
    assert.ok(rasterStats.opaque > 1500, 'drawing must not be an almost-empty canvas');

    await page.locator('#animation-play').click();
    await page.waitForTimeout(700);
    await canvas.screenshot({ type: 'png', path: path.join(ARTIFACT_DIR, 'animation-frame-playback.png') });
    const afterStats = await canvas.evaluate(node => {
      const ctx = node.getContext('2d');
      const d = ctx.getImageData(0, 0, node.width, node.height).data;
      let checksum = 0;
      for (let i = 0; i < d.length; i += 4) checksum = (checksum + d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7 + d[i + 3]) % 1000000007;
      return checksum;
    });
    assert.notEqual(afterStats, rasterStats.checksum, 'playback must visibly change the rendered frame');
    assert.deepEqual(errors, []);

    const video = page.video();
    await page.close();
    await context.close();
    const videoPath = await video.path();
    const videoBytes = await fs.readFile(videoPath);
    assert.ok(videoBytes.length > 20000, 'visual animation recording must contain substantial video data');
    await fs.copyFile(videoPath, path.join(ARTIFACT_DIR, 'polished-animation.webm'));
  } finally {
    await browser.close().catch(() => {});
    await fs.rm(videoDir, { recursive: true, force: true });
  }
  console.log('Visual PixelForge evidence passed: polished drawing, 12+ frames, playback delta and WebM captured.');
})();
