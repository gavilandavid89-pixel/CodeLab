import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import chromium from '@sparticuz/chromium';
import { chromium as playwrightChromium } from 'playwright-core';
import { createPixelForgeCodeLabPackageZip } from './pixelforge-codelab-package.mjs';

const ALLOWED_OPERATIONS = new Set(['inspect', 'seek', 'play', 'configure', 'capture_preview', 'capture_studio', 'record_studio']);

export function validateVideoComposerOperations(operations = [{ type: 'inspect' }]) {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 20) {
    throw new RangeError('Video Composer control requires between 1 and 20 operations.');
  }
  return operations.map((operation, index) => {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation) || !ALLOWED_OPERATIONS.has(operation.type)) {
      throw new TypeError('Unsupported Video Composer operation at index ' + index + '.');
    }
    if (operation.type === 'seek' && (!Number.isInteger(operation.index) || operation.index < 0 || operation.index > 239)) {
      throw new RangeError('seek.index must be an integer from 0 to 239.');
    }
    if (operation.type === 'play' && (!Number.isInteger(operation.duration_ms) || operation.duration_ms < 100 || operation.duration_ms > 10000)) {
      throw new RangeError('play.duration_ms must be between 100 and 10,000.');
    }
    if (operation.type === 'record_studio' && (!Number.isInteger(operation.duration_ms) || operation.duration_ms < 1000 || operation.duration_ms > 30000)) throw new RangeError('record_studio.duration_ms must be between 1,000 and 30,000.');
    if (operation.type === 'configure') {
      if (operation.format !== undefined && !['webm-vp9', 'webm-vp8', 'mp4'].includes(operation.format)) throw new TypeError('Unsupported Video Composer output format.');
      if (operation.output_fps !== undefined && ![12, 24, 30, 60].includes(operation.output_fps)) throw new RangeError('output_fps must be 12, 24, 30 or 60.');
      if (operation.resolution !== undefined && !['720', '1080'].includes(String(operation.resolution))) throw new TypeError('resolution must be 720 or 1080.');
      if (operation.aspect !== undefined && !['16:9', '9:16', '1:1', 'auto'].includes(operation.aspect)) throw new TypeError('Unsupported Video Composer aspect ratio.');
      if (operation.loop_export !== undefined && typeof operation.loop_export !== 'boolean') throw new TypeError('loop_export must be a boolean.');
      if (operation.solid_background !== undefined && typeof operation.solid_background !== 'boolean') throw new TypeError('solid_background must be a boolean.');
    }
    return JSON.parse(JSON.stringify(operation));
  });
}

export async function controlPixelForgeVideoComposer(payload, deps = {}) {
  if (!payload?.project_id) throw new TypeError('project_id is required.');
  const { loadProject, targetPixelForgeWorkspace, workspaceTokenFor } = deps;
  if (typeof loadProject !== 'function' || typeof targetPixelForgeWorkspace !== 'function' || typeof workspaceTokenFor !== 'function') {
    throw new TypeError('Video Composer control dependencies are incomplete.');
  }
  const operations = validateVideoComposerOperations(payload.operations || [{ type: 'inspect' }]);
  const targetWorkspace = targetPixelForgeWorkspace(payload);
  const loaded = await loadProject(payload.project_id, targetWorkspace);
  const project = loaded.project;
  const packageData = createPixelForgeCodeLabPackageZip(project);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codelab-vc-control-'));
  const packagePath = path.join(tempDir, 'pixelforge-control.zip');
  fs.writeFileSync(packagePath, packageData.bytes);
  let browser, context, page, video;
  const artifacts = [];
  try {
    chromium.setGraphicsMode = false;
    browser = await playwrightChromium.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
      timeout: 60000
    });
    const viewport = {
      width: Number.isInteger(payload.viewport?.width) ? Math.max(640, Math.min(1600, payload.viewport.width)) : 960,
      height: Number.isInteger(payload.viewport?.height) ? Math.max(480, Math.min(1200, payload.viewport.height)) : 720
    };
    const recordStudioRequested = operations.some(operation => operation.type === 'record_studio');
    context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      reducedMotion: 'reduce',
      ...(recordStudioRequested ? { recordVideo: { dir: tempDir, size: viewport, fps: 24 } } : {})
    });
    await context.addInitScript(({ id, token }) => {
      localStorage.setItem('codelab_xd_workspace_v4', id);
      localStorage.setItem('codelab_xd_workspace_token_v1', token);
    }, { id: targetWorkspace, token: workspaceTokenFor(targetWorkspace) });
    page = await context.newPage();
    video = recordStudioRequested ? page.video() : null;
    const pageErrors = [], consoleErrors = [];
    page.on('pageerror', error => { if (pageErrors.length < 20) pageErrors.push(String(error.message || error).slice(0, 300)); });
    page.on('console', message => { if (message.type() === 'error' && consoleErrors.length < 20) consoleErrors.push(message.text().slice(0, 300)); });
    const baseUrl = String(process.env.RENDER_EXTERNAL_URL || process.env.OAUTH_PUBLIC_URL || ('http://127.0.0.1:' + String(process.env.PORT || 3000))).replace(/\/$/, '');
    const composerUrl = baseUrl + '/pixelforge/video-composer.html?remote=1';
    const response = await page.goto(composerUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!response?.ok()) throw new Error('Video Composer returned HTTP ' + (response?.status() || 'no response') + '.');
    await page.locator('#vc-file').waitFor({ state: 'attached', timeout: 15000 });
    await page.setInputFiles('#vc-file', packagePath);
    await page.waitForFunction(() => {
      const frames = Number(document.querySelector('#vc-stat-frames')?.textContent || 0);
      return frames > 0 && document.querySelector('#vc-play') && !document.querySelector('#vc-play').disabled;
    }, null, { timeout: 30000 });
    const imported = await page.evaluate(() => ({
      frames: Number(document.querySelector('#vc-stat-frames')?.textContent || 0),
      fps: Number.parseInt(document.querySelector('#vc-stat-fps')?.textContent || '0', 10),
      dimensions: document.querySelector('#vc-stat-size')?.textContent || '',
      duration: document.querySelector('#vc-stat-duration')?.textContent || '',
      name: document.querySelector('#vc-project-name')?.textContent || '',
      status: document.querySelector('#vc-export-note')?.textContent || ''
    }));
    if (imported.frames !== packageData.metadata.frameCount || imported.fps !== packageData.metadata.fps) {
      throw new Error('Video Composer import did not preserve the project timeline.');
    }
    const results = [];
    for (const operation of operations) {
      if (operation.type === 'inspect') {
        results.push({ type: 'inspect', state: await inspectPage(page) });
      } else if (operation.type === 'seek') {
        if (operation.index >= imported.frames) throw new RangeError('seek.index exceeds the imported frame count.');
        await page.locator('#vc-scrubber').evaluate((element, index) => {
          element.value = String(index);
          element.dispatchEvent(new Event('input', { bubbles: true }));
        }, operation.index);
        await page.waitForTimeout(120);
        results.push({ type: 'seek', state: await inspectPage(page) });
      } else if (operation.type === 'play') {
        await page.locator('#vc-play').click();
        await page.waitForTimeout(operation.duration_ms);
        const label = await page.locator('#vc-play').getAttribute('aria-label');
        if (label === 'Pausar') await page.locator('#vc-play').click();
        results.push({ type: 'play', requestedDurationMs: operation.duration_ms, state: await inspectPage(page) });
      } else if (operation.type === 'configure') {
        if (operation.format) await page.locator('#vc-format').selectOption(operation.format);
        if (operation.output_fps) await page.locator('#vc-output-fps').selectOption(String(operation.output_fps));
        if (operation.resolution) await page.locator('#vc-resolution').selectOption(String(operation.resolution));
        if (operation.aspect) await page.locator('#vc-aspect').selectOption(operation.aspect);
        if (operation.loop_export !== undefined) await page.locator('#vc-loop-export').setChecked(operation.loop_export);
        if (operation.solid_background !== undefined) await page.locator('#vc-solid-bg').setChecked(operation.solid_background);
        results.push({ type: 'configure', settings: await page.evaluate(() => ({
          format: document.querySelector('#vc-format')?.value,
          outputFps: Number(document.querySelector('#vc-output-fps')?.value),
          resolution: document.querySelector('#vc-resolution')?.value,
          aspect: document.querySelector('#vc-aspect')?.value,
          loopExport: Boolean(document.querySelector('#vc-loop-export')?.checked),
          solidBackground: Boolean(document.querySelector('#vc-solid-bg')?.checked),
          formatSupport: document.querySelector('#vc-format-support')?.textContent || ''
        })) });
      } else if (operation.type === 'capture_preview') {
        const png = await page.locator('#vc-preview').screenshot({ type: 'png' });
        if (png.length > 2 * 1024 * 1024) throw new RangeError('Video Composer preview PNG exceeds the 2 MiB inline evidence limit.');
        results.push({ type: 'capture_preview', mimeType: 'image/png', sizeBytes: png.length, dataBase64: png.toString('base64'), state: await inspectPage(page) });
      } else if (operation.type === 'capture_studio') {
        const png = await page.screenshot({ type: 'png', fullPage: true });
        if (typeof deps.storeArtifact === 'function') {
          const artifact = await deps.storeArtifact({
            kind: 'pixelforge_composer_png',
            filename: 'pixelforge-video-composer.png',
            contentType: 'image/png',
            bytes: png,
            metadata: { projectId: payload.project_id, serverRevision: loaded.serverRevision, capture: 'full-composer-interface' }
          });
          artifacts.push(artifact);
          results.push({ type: 'capture_studio', mimeType: 'image/png', sizeBytes: png.length, artifact });
        } else {
          if (png.length > 2 * 1024 * 1024) throw new RangeError('Video Composer studio screenshot exceeds the inline evidence limit.');
          results.push({ type: 'capture_studio', mimeType: 'image/png', sizeBytes: png.length, dataBase64: png.toString('base64') });
        }
      } else if (operation.type === 'record_studio') {
        await page.waitForTimeout(operation.duration_ms);
        results.push({ type: 'record_studio', requestedDurationMs: operation.duration_ms, capture: 'Playwright page recording' });
      }
    }
    if (recordStudioRequested) {
      await context.close();
      const videoPath = await video.path();
      const videoBytes = fs.readFileSync(videoPath);
      if (videoBytes.length < 1000 || videoBytes.length > 24 * 1024 * 1024) throw new RangeError('Video Composer studio recording must be between 1 KiB and 24 MiB.');
      if (typeof deps.storeArtifact !== 'function') throw new Error('Video Composer recording requires native artifact storage.');
      const artifact = await deps.storeArtifact({
        kind: 'pixelforge_composer_video',
        filename: 'pixelforge-video-composer-studio.webm',
        contentType: 'video/webm',
        bytes: videoBytes,
        metadata: { projectId: payload.project_id, serverRevision: loaded.serverRevision, capture: 'Playwright page recording', fps: 24 }
      });
      artifacts.push(artifact);
    }
    return {
      ok: pageErrors.length === 0 && consoleErrors.length === 0,
      controller: 'playwright-chromium',
      composerUrl,
      projectId: payload.project_id,
      serverRevision: loaded.serverRevision,
      package: packageData.metadata,
      imported,
      operations: results,
      artifacts,
      diagnostics: { pageErrors, consoleErrors }
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function inspectPage(page) {
  return page.evaluate(() => ({
    frameCount: Number(document.querySelector('#vc-stat-frames')?.textContent || 0),
    fps: Number.parseInt(document.querySelector('#vc-stat-fps')?.textContent || '0', 10),
    currentFrame: Number(document.querySelector('#vc-scrubber')?.value || 0),
    playbackLabel: document.querySelector('#vc-play')?.getAttribute('aria-label') || '',
    status: document.querySelector('#vc-export-note')?.textContent || '',
    exportEnabled: Boolean(document.querySelector('#vc-export') && !document.querySelector('#vc-export').disabled)
  }));
}
