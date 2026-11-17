import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chromium from '@sparticuz/chromium';
import { chromium as playwrightChromium } from 'playwright-core';
import { createOrbitalShowcase } from '../public/pixelforge/src/showcase-animation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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


test('real PixelForge editor loads a saved animation and records its native playback', {
  timeout: 120000
}, async () => {
  const showcase = createOrbitalShowcase();
  const project = showcase.doc.toJSON();
  project.id = 'pf_test_animation';
  project.animation = { ...showcase.animation.toJSON(), loop: showcase.loop };
  const publicRoot = path.join(root, 'public');
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/api/pixelforge/mode') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ guestMode: true }));
      return;
    }
    if (url.pathname === '/api/pixelforge/projects/pf_test_animation') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ project }));
      return;
    }
    if (url.pathname === '/api/pixelforge/projects') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ projects: [{ id: project.id, name: project.name }] }));
      return;
    }
    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const filePath = path.resolve(publicRoot, relative);
    if (filePath !== publicRoot && !filePath.startsWith(publicRoot + path.sep)) {
      res.writeHead(403); res.end(); return;
    }
    try {
      const bytes = fsSync.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const types = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.mjs': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.woff2': 'font/woff2'
      };
      res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream' });
      res.end(bytes);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = 'http://127.0.0.1:' + address.port;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codelab-pixelforge-native-test-'));
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
      viewport: { width: 960, height: 720 },
      deviceScaleFactor: 1,
      recordVideo: { dir: tempDir, size: { width: 960, height: 720 }, fps: 24 }
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error.stack || error.message || error)));
    await page.goto(baseUrl + '/pixelforge/index.html?projectId=' + project.id + '&capture=video', {
      waitUntil: 'domcontentloaded'
    });
    await page.locator('#canvas').waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForFunction(() => document.documentElement.dataset.pixelforgeCapture === 'complete', null, {
      timeout: Number(project.animation.frames.reduce((sum, frame) => sum + frame.durationMs, 0)) + 30000
    });
    const frameCount = await page.locator('#animation-frame-count').textContent();
    assert.match(frameCount || '', /12 frames/i);
    assert.deepEqual(pageErrors, []);
    const png = await page.locator('#canvas').screenshot({ type: 'png' });
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const video = page.video();
    assert.ok(video);
    await page.close();
    await context.close();
    const webm = await fs.readFile(await video.path());
    assert.ok(webm.length > 1000);
    assert.deepEqual([...webm.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true });
    await new Promise(resolve => server.close(resolve));
  }
});
