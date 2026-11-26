import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createZipBlob } from '../public/pixelforge/src/zip-export.js';
import { HeadlessEditorRuntime } from '../public/pixelforge/src/headless.js';
import { createPixelForgeCodeLabPackageZip } from '../pixelforge-codelab-package.mjs';

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
    frames: [{ index: 0, id: 'frame-1', file: 'frames/frame-0001.png', durationMs: 250, startMs: 0 }],
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
  const encoderAvailable = encoderStatus.startsWith('Codificación determinista disponible:');
  assert.equal(await page.locator('#vc-export').isDisabled(), !encoderAvailable,
    'export must be enabled only when WebCodecs is available for the selected format');
  assert.equal(await page.locator('#vc-preview').isVisible(), true);
  assert.equal(await page.locator('#vc-resolution').inputValue(), '1080');
  assert.equal(await page.locator('#vc-aspect').inputValue(), '16:9');
  assert.equal(await page.locator('#vc-export-dimensions').textContent(), '1920 × 1080');
  assert.equal(await page.locator('#vc-capture-content').isDisabled(), false);
  const contentPngDownloadPromise = page.waitForEvent('download', { timeout: 15000 });
  await page.locator('#vc-capture-content').click();
  const contentPngDownload = await contentPngDownloadPromise;
  assert.match(contentPngDownload.suggestedFilename(), /-contenido\.png$/);
  const contentPngPath = await contentPngDownload.path();
  const contentPng = fs.readFileSync(contentPngPath);
  assert.deepEqual([...contentPng.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10],
    'content capture must produce a valid PNG image');
  assert.equal(contentPng.readUInt32BE(16), 1920, 'default capture should produce a full HD width');
  assert.equal(contentPng.readUInt32BE(20), 1080, 'default capture should produce a full HD height');
  await page.locator('#vc-aspect').selectOption('9:16');
  assert.equal(await page.locator('#vc-export-dimensions').textContent(), '1080 × 1920',
    'portrait export must fill a mobile-friendly frame without cropping the source');
  await page.locator('#vc-aspect').selectOption('16:9');

  if (!(await page.locator('#vc-export').isDisabled())) {
    const videoDownloadPromise = page.waitForEvent('download', { timeout: 15000 });
    await page.locator('#vc-export').click();
    const videoDownload = await videoDownloadPromise;
    assert.match(videoDownload.suggestedFilename(), /\.(webm|mp4)$/);
    const videoPath = await videoDownload.path();
    assert.ok(fs.statSync(videoPath).size > 0, 'the browser encoder must produce a non-empty local video file');
  }

  // Exercise the native CodeLab package path: the importer must reconstruct
  // editable cels and preserve Illustration/Pixel Art modes per layer.
  const runtime = new HeadlessEditorRuntime({ width: 32, height: 32, name: 'Mixed style fixture' });
  assert.equal(runtime.execute({ name: 'drawing.mode.set', mode: 'illustration' }).ok, true);
  assert.equal(runtime.execute({
    name: 'canvas.draw_line', x0: 2, y0: 4, x1: 12, y1: 4, color: '#E85D75', size: 3
  }).ok, true);
  const layerResult = runtime.execute({ name: 'layer.add', layerName: 'Pixel details' });
  assert.equal(layerResult.ok, true);
  assert.equal(runtime.execute({ name: 'drawing.mode.set', mode: 'pixel-art' }).ok, true);
  assert.equal(runtime.execute({
    name: 'canvas.draw_line', x0: 4, y0: 12, x1: 16, y1: 12, color: '#342D52', size: 1
  }).ok, true);
  assert.equal(runtime.execute({
    name: 'animation.frame.capture_document', frameName: 'Pose 1', durationMs: 120
  }).ok, true);
  assert.equal(runtime.execute({
    name: 'canvas.draw_line', x0: 6, y0: 13, x1: 18, y1: 13, color: '#342D52', size: 1
  }).ok, true);
  assert.equal(runtime.execute({
    name: 'animation.frame.capture_document', frameName: 'Pose 2', durationMs: 140
  }).ok, true);
  runtime.createProposal('Native mixed-style Video Composer fixture');
  assert.equal(runtime.acceptProposal().status, 'applied');
  const nativePackage = createPixelForgeCodeLabPackageZip(runtime.toJSON());
  const nativePageErrors = [];
  page.on('pageerror', error => nativePageErrors.push(error.message));
  await page.locator('#vc-file').setInputFiles({
    name: 'mixed-style.codelab-pixelforge.zip',
    mimeType: 'application/zip',
    buffer: nativePackage.bytes,
  });
  await page.waitForFunction(() => document.querySelector('#vc-project-name')?.textContent === 'mixed-style');
  await page.waitForFunction(() => Number(document.querySelector('#vc-stat-frames')?.textContent || 0) === 2);
  assert.equal(await page.locator('.vc-frame-card').count(), 2,
    'native CodeLab packages must import every animation frame');
  assert.deepEqual(nativePageErrors, [],
    'native mixed-style import and per-layer composition must not raise browser errors');

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
