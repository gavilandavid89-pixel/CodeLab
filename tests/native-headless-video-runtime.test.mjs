import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chromium from '@sparticuz/chromium';
import { chromium as playwrightChromium } from 'playwright-core';
import { createOrbitalShowcase } from '../public/pixelforge/src/showcase-animation.mjs';
import { executeCodeLabBrowserActions } from '../native-headless-browser.mjs';

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
    assert.deepEqual(pageErrors.filter(error => !String(error).includes("Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.")), []);
    const png = await page.locator('#canvas').screenshot({ type: 'png' });
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const video = page.video();
    assert.ok(video);
    await page.close();
    await context.close();
    const webm = await fs.readFile(await video.path());
    assert.ok(webm.length > 1000);
    assert.deepEqual([...webm.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);

    // Explicit browser mode exercises the real CodeLab server/UI. The action
    // sequence is deliberately visible in the result and is never an implicit
    // fallback from an API command.
    const uiRun = await executeCodeLabBrowserActions({
      execution_mode: 'browser',
      baseUrl,
      workspaceId,
      workspaceToken: workspace.token,
      tempDir,
      actions: [
        { type: 'open_screen', path: '/' },
        { type: 'wait_for', selector: '#searchProjectInput', state: 'visible' },
        { type: 'click', selector: '#searchProjectInput' },
        { type: 'type', selector: '#searchProjectInput', text: 'Headless' },
        { type: 'open_screen', path: '/?projectId=' + encodeURIComponent(project.id) },
        { type: 'wait_for', selector: '#studioView', state: 'visible' },
        { type: 'open_panel', selector: 'button[onclick="editCurrentProjectName()"]' },
        { type: 'wait_for', selector: '#newProjectNameInput', state: 'visible' },
        { type: 'type', selector: '#newProjectNameInput', text: 'Headless UI temporary name' },
        { type: 'scroll', amount: 450 },
        { type: 'screenshot', selector: '#studioView' },
        { type: 'record_video', duration_ms: 1000 }
      ]
    });
    assert.equal(uiRun.execution_mode, 'browser');
    assert.equal(uiRun.passed, true);
    assert.equal(uiRun.actionCount, 12);
    assert.equal(uiRun.ui_actions[0].type, 'open_screen');
    assert.equal(uiRun.ui_actions[3].type, 'type');
    assert.equal(uiRun.ui_actions[5].type, 'wait_for');
    assert.equal(uiRun.ui_actions[6].type, 'open_panel');
    assert.equal(uiRun.ui_actions[7].type, 'wait_for');
    assert.equal(uiRun.ui_actions[8].type, 'type');
    assert.equal(uiRun.ui_actions[9].type, 'scroll');
    assert.equal(uiRun.ui_actions[10].type, 'screenshot');
    assert.equal(uiRun.ui_actions[11].type, 'record_video');
    assert.ok(uiRun.screenshots[0].sizeBytes > 1000);
    assert.ok(uiRun.video && uiRun.video.sizeBytes > 1000);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true });
    await new Promise(resolve => server.close(resolve));
  }
});


test('real CodeLab project route renders saved web code and records WebM', {
  timeout: 150000
}, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codelab-project-route-test-'));
  const portProbe = createServer();
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const secret = 'native-headless-integration-test-secret';
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      DATABASE_URL: '',
      CODELAB_DATA_DIR: dataDir,
      CODELAB_WORKSPACE_SECRET: secret,
      CODELAB_AGENT_BRIDGE_ENABLED: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverOutput = '';
  child.stdout.on('data', chunk => { serverOutput += chunk.toString(); });
  child.stderr.on('data', chunk => { serverOutput += chunk.toString(); });
  const baseUrl = 'http://127.0.0.1:' + port;
  let browser;
  let tempDir;
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error('CodeLab server exited before startup: ' + serverOutput);
      try {
        const response = await fetch(baseUrl + '/api/health', { signal: AbortSignal.timeout(1000) });
        if (response.ok && (await response.json()).ok === true) { healthy = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(healthy, 'CodeLab server must become healthy: ' + serverOutput);
    const workspaceId = 'ws_local_headless_test';
    const initialized = await fetch(baseUrl + '/api/workspace/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: workspaceId })
    });
    const workspace = await initialized.json();
    assert.equal(initialized.status, 200, JSON.stringify(workspace));
    const html = '<!doctype html><html><head><style>' +
      'body{margin:0;background:#101827;color:white;font:24px sans-serif}' +
      '#motion{width:80px;height:80px;background:#4af;animation:move 1s ease-in-out infinite alternate}' +
      '@keyframes move{to{transform:translateX(240px) rotate(180deg)}}' +
      '</style></head><body><h1>CodeLab headless animation</h1><div id="motion"></div></body></html>';
    const project = {
      id: 'proj_headless_video_fixture',
      name: 'Headless Video Fixture',
      type: 'web',
      code: { html, css: '', js: '' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const saved = await fetch(baseUrl + '/api/workspace/' + encodeURIComponent(workspaceId), {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-workspace-token': workspace.token
      },
      body: JSON.stringify({ projects: [project], baseRevision: workspace.state.revision })
    });
    assert.equal(saved.status, 200, await saved.text());
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codelab-project-route-video-'));
    chromium.setGraphicsMode = false;
    browser = await playwrightChromium.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
      timeout: 60000
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      recordVideo: { dir: tempDir, size: { width: 1280, height: 800 }, fps: 24 }
    });
    await context.addInitScript(({ id, token }) => {
      if (window.top !== window) return;
      localStorage.setItem('codelab_xd_workspace_v4', id);
      localStorage.setItem('codelab_xd_workspace_token_v1', token);
    }, { id: workspaceId, token: workspace.token });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error.stack || error.message || error)));
    await page.goto(baseUrl + '/?projectId=' + project.id, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(expectedName => {
      const studio = document.getElementById('studioView');
      const title = document.getElementById('currentProjectTitle');
      return !!studio && !studio.classList.contains('hidden') && !!title &&
        title.textContent.trim() === expectedName;
    }, project.name, { timeout: 45000 });
    const previewBody = page.frameLocator('#previewIframe').locator('body');
    await previewBody.waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForTimeout(1800);
    assert.match(await previewBody.innerText(), /CodeLab headless animation/);
    const png = await previewBody.screenshot({ type: 'png' });
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.deepEqual(pageErrors, []);
    const video = page.video();
    await page.close();
    await context.close();
    const webm = await fs.readFile(await video.path());
    assert.ok(webm.length > 1000);
    assert.deepEqual([...webm.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => {
        const timeout = setTimeout(resolve, 5000);
        child.once('exit', () => { clearTimeout(timeout); resolve(); });
      });
    }
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
