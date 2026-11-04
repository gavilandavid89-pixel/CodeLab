import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createZipBlob } from '../public/pixelforge/src/zip-export.js';

const root = path.resolve('public/pixelforge');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
};

test('Video Composer imports a PixelForge ZIP, previews frames and fits a mobile viewport', async t => {
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + pathname);
    if (!file.startsWith(root + path.sep) && file !== path.join(root, 'video-composer.html')) {
      response.writeHead(403); response.end(); return;
    }
    fs.readFile(file, (error, bytes) => {
      if (error) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' });
      response.end(bytes);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.close(); });

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('http://127.0.0.1:' + address.port + '/video-composer.html');
  await page.waitForSelector('#vc-dropzone');
  assert.match(await page.title(), /Video Composer/);
  assert.equal(await page.locator('#vc-export').isDisabled(), true);

  const pngBase64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 32; canvas.height = 32;
    const context = canvas.getContext('2d');
    context.fillStyle = '#d8a65d'; context.fillRect(8, 8, 16, 16);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    return await new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.readAsDataURL(blob);
    });
  });
  const png = Buffer.from(pngBase64, 'base64');
  const manifest = {
    format: 'pixelforge-video-package', version: 1, width: 32, height: 32,
    fps: 12, loop: true, frameCount: 1, projectFile: 'project/orbital.pforge',
    frames: [{ index: 0, id: 'frame-1', file: 'frames/frame-0001.png', durationMs: 83.333, startMs: 0 }],
  };
  const zip = await createZipBlob([
    { name: 'manifest.json', data: JSON.stringify(manifest) },
    { name: 'frames/frame-0001.png', data: png },
    { name: 'project/orbital.pforge', data: '{"format":"pixelforge-project"}' },
  ]);
  await page.locator('#vc-file').setInputFiles({
    name: 'orbital-demo.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(await zip.arrayBuffer()),
  });
  await page.waitForFunction(() => document.querySelector('#vc-project-name')?.textContent === 'orbital-demo');
  await page.waitForSelector('.vc-frame-card');
  assert.equal(await page.locator('.vc-frame-card').count(), 1);
  assert.equal(await page.locator('#vc-stat-fps').textContent(), '12 FPS');
  const encoderStatus = await page.locator('#vc-format-support').textContent();
  assert.ok(encoderStatus.length > 0, 'the interface should explain the current encoder capability');
  assert.equal(await page.locator('#vc-export').isDisabled(), !encoderStatus.startsWith('Disponible'),
    'export must be enabled only when the browser can capture and encode video');
  assert.equal(await page.locator('#vc-preview').isVisible(), true);

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mobile.goto('http://127.0.0.1:' + address.port + '/video-composer.html');
  const dimensions = await mobile.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  assert.ok(dimensions.document <= dimensions.viewport + 1,
    'mobile Video Composer must not introduce horizontal page overflow');
  assert.deepEqual(pageErrors, []);
  await mobile.close();
});
