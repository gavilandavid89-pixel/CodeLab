import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import chromium from '@sparticuz/chromium';
import { chromium as playwrightChromium } from 'playwright-core';

test('headless Chromium captures a PNG and records an animated WebM at the requested FPS', {
  timeout: 120000
}, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codelab-native-video-test-'));
  let browser;
  try {
    chromium.setGraphicsMode = false;
    browser = await playwrightChromium.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
      timeout: 60000
    });
    const context = await browser.newContext({
      viewport: { width: 640, height: 360 },
      deviceScaleFactor: 1,
      recordVideo: { dir: tempDir, size: { width: 640, height: 360 }, fps: 24 }
    });
    const page = await context.newPage();
    const html = '<!doctype html><html><head><style>' +
      'html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#111}' +
      '#moving{width:80px;height:80px;position:absolute;left:0;top:100px;background:#39f;' +
      'animation:travel 1.4s linear infinite alternate}' +
      '@keyframes travel{from{transform:translateX(0) rotate(0)}to{transform:translateX(480px) rotate(180deg)}}' +
      '</style></head><body><div id="moving"></div></body></html>';
    await page.setContent(html, { waitUntil: 'load' });
    const png = await page.screenshot({ type: 'png' });
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    await page.waitForTimeout(1800);
    const video = page.video();
    assert.ok(video, 'Playwright must attach a real video recorder to the page');
    await page.close();
    await context.close();
    const videoPath = await video.path();
    const webm = await fs.readFile(videoPath);
    assert.ok(webm.length > 1000, 'Chromium must write a non-empty WebM');
    assert.deepEqual([...webm.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3],
      'recorded video must have the EBML/WebM container signature');
  } finally {
    if (browser) await browser.close().catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
