import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { deflateSync } from 'node:zlib';
import chromium from '@sparticuz/chromium';
import { chromium as playwrightChromium } from 'playwright-core';
import { createPixelForgeCodeLabPackageZip } from './pixelforge-codelab-package.mjs';

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBuf.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 8 + data.length);
  return out;
}

function rgbaToPng(rgba, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const compressed = deflateSync(raw, { level: 6 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function compositeFrame(project, frame) {
  const width = Number(project.width);
  const height = Number(project.height);
  const out = Buffer.alloc(width * height * 4);
  const cels = new Map((frame.cels || []).map(cel => [cel.layerId, cel]));
  for (const layer of project.layers || []) {
    if (!layer || layer.visible === false || !Number(layer.opacity ?? 1)) continue;
    const cel = cels.get(layer.id);
    const encoded = cel?.pixels || layer.pixels;
    if (typeof encoded !== 'string') throw new Error('Frame cel is missing RGBA data for layer ' + layer.id);
    const src = Buffer.from(encoded, 'base64');
    if (src.length !== width * height * 4) throw new Error('Frame cel has invalid RGBA byte length.');
    const layerOpacity = Math.max(0, Math.min(1, Number(layer.opacity ?? 1)));
    for (let i = 0; i < out.length; i += 4) {
      const sa = (src[i + 3] / 255) * layerOpacity;
      if (sa <= 0) continue;
      const da = out[i + 3] / 255;
      const oa = sa + da * (1 - sa);
      if (oa <= 0) continue;
      out[i] = Math.round((src[i] * sa + out[i] * da * (1 - sa)) / oa);
      out[i + 1] = Math.round((src[i + 1] * sa + out[i + 1] * da * (1 - sa)) / oa);
      out[i + 2] = Math.round((src[i + 2] * sa + out[i + 2] * da * (1 - sa)) / oa);
      out[i + 3] = Math.round(oa * 255);
    }
  }
  return out;
}

function makeStoredZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    local.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, name);
    offset += localHeader.length + name.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const localBytes = Buffer.concat(local);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(localBytes.length, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([localBytes, centralBytes, end]);
}

function safeVideoName(name) {
  return String(name || 'pixelforge-animation').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'pixelforge-animation';
}

async function exportPixelForgeAnimationVideo(payload, deps = {}) {
  const { loadProject, targetPixelForgeWorkspace, uploadNativeArtifact, neonEvidence, pool, workspaceTokenFor, workspaceId } = deps;
  if (!payload?.project_id) throw new Error('project_id is required.');
  const targetWorkspace = targetPixelForgeWorkspace(payload);
  const loaded = await loadProject(payload.project_id, targetWorkspace);
  const project = loaded.project;
  const animation = project?.animation;
  if (!animation || !Array.isArray(animation.frames) || animation.frames.length < 1) {
    throw new Error('PixelForge project has no saved animation frames.');
  }
  const fps = Number.isInteger(animation.fps) ? animation.fps : 12;
  const frames = animation.frames;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codelab-vc-export-'));
  let browser = deps.browser || null;
  let context = deps.context || null;
  let page = null;
  const ownsBrowser = !deps.browser;
  const ownsContext = !deps.context;
  let packagePath = path.join(tempDir, safeVideoName(project.name) + '.pixelforge-video.zip');
  try {
    const nativePackage = createPixelForgeCodeLabPackageZip(project);
    const zipBytes = nativePackage.bytes;
    packagePath = path.join(tempDir, safeVideoName(project.name) + '.codelab-pixelforge.zip');
    const totalDurationMs = frames.reduce((sum, frame) =>
      sum + Math.max(1, Number(frame.durationMs || Math.round(1000 / fps))), 0);
    fs.writeFileSync(packagePath, zipBytes);

    chromium.setGraphicsMode = false;
    browser = browser || await playwrightChromium.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
      timeout: 60000
    });
    context = context || await browser.newContext({
      viewport: { width: 640, height: 480 },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      reducedMotion: 'reduce',
      acceptDownloads: true
    });
    await context.addInitScript(({ id, token }) => {
      localStorage.setItem('codelab_xd_workspace_v4', id);
      localStorage.setItem('codelab_xd_workspace_token_v1', token);
    }, { id: targetWorkspace, token: typeof workspaceTokenFor === 'function' ? workspaceTokenFor(targetWorkspace) : '' });

    page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', error => { if (pageErrors.length < 20) pageErrors.push(String(error.message || error).slice(0, 300)); });
    page.on('console', message => { if (message.type() === 'error' && consoleErrors.length < 20) consoleErrors.push(message.text().slice(0, 300)); });

    const baseUrl = String(process.env.RENDER_EXTERNAL_URL || process.env.OAUTH_PUBLIC_URL || ('http://127.0.0.1:' + String(process.env.PORT || 3000))).replace(/\/$/, '');
    const composerUrl = baseUrl + '/pixelforge/video-composer.html?export=1';
    const response = await page.goto(composerUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!response || !response.ok()) throw new Error('CodeLab Video Composer returned HTTP ' + (response?.status() || 'no response'));
    await page.locator('#vc-file').waitFor({ state: 'attached', timeout: 15000 });
    await page.setInputFiles('#vc-file', packagePath);
    await page.waitForFunction(() => {
      const frames = Number(document.querySelector('#vc-stat-frames')?.textContent || 0);
      const button = document.querySelector('#vc-export');
      return frames > 0 && !!button && !button.disabled;
    }, null, { timeout: 30000 });
    const imported = await page.evaluate(() => ({
      frames: Number(document.querySelector('#vc-stat-frames')?.textContent || 0),
      fps: Number.parseInt(document.querySelector('#vc-stat-fps')?.textContent || '0', 10),
      size: document.querySelector('#vc-stat-size')?.textContent || '',
      duration: document.querySelector('#vc-stat-duration')?.textContent || '',
      status: document.querySelector('#vc-status')?.textContent || ''
    }));
    if (imported.frames !== frames.length || imported.fps !== fps) {
      throw new Error('CodeLab Video Composer imported unexpected animation metadata: ' + JSON.stringify({imported,expected:{frames:frames.length,fps}}));
    }
    await page.selectOption('#vc-format', 'webm-vp9').catch(() => {});
    await page.selectOption('#vc-output-fps', String(fps)).catch(() => {});
    await page.selectOption('#vc-resolution', 'auto').catch(() => {});
    await page.selectOption('#vc-aspect', 'auto').catch(() => {});
    await page.waitForFunction(() => {
      const button = document.querySelector('#vc-export');
      return button && !button.disabled;
    }, null, { timeout: 15000 });
    const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
    await page.locator('#vc-export').click();
    const download = await downloadPromise;
    const videoPath = path.join(tempDir, safeVideoName(project.name) + '-composer.' + (download.suggestedFilename().split('.').pop() || 'webm'));
    await download.saveAs(videoPath);
    const stat = fs.statSync(videoPath);
    if (!stat.isFile() || stat.size < 1000) throw new Error('CodeLab Video Composer produced an invalid video: ' + JSON.stringify({isFile: stat.isFile(), sizeBytes: stat.size, filename: download.suggestedFilename()}));
    if (stat.size > 24 * 1024 * 1024) throw new Error('CodeLab Video Composer video exceeds the 24 MiB artifact limit.');
    const videoBytes = fs.readFileSync(videoPath);

    let artifact;
    let evidence = null;
    if (payload.uploadTarget) {
      artifact = await uploadNativeArtifact(payload.uploadTarget, videoBytes, 'video/webm', 'pixelforge/exports/');
    } else if (payload.persist_evidence !== false && neonEvidence && pool) {
      evidence = await neonEvidence.createChangeEvent(pool, {
        workspaceId: targetWorkspace,
        projectId: payload.project_id,
        revision: loaded.serverRevision,
        changeKind: 'animation-video-composer-export',
        metadata: {
          commandId: payload.command_id || null,
          action: 'pixelforge_export_animation_video',
          contentSha256: loaded.contentSha256,
          capture: 'codelab-video-composer',
          transport: neonEvidence.cloudflareEvidenceConfigured() ? 'cloudflare-r2' : (neonEvidence.storageConfigured() ? 'neon-object-storage' : 'neon-postgres-bytea'),
          videoDurationMs: totalDurationMs
        }
      });
      const objectKey = 'pixelforge/' + targetWorkspace + '/' + payload.project_id +
        '/r' + loaded.serverRevision + '/' + evidence.eventId + '-composer.webm';
      const upload = neonEvidence.storageConfigured()
        ? neonEvidence.presignStorageObject({ objectKey, contentType: 'video/webm', expiresInSeconds: 900 })
        : null;
      if (upload) {
        artifact = await uploadNativeArtifact(upload, videoBytes, 'video/webm', 'pixelforge/');
        await neonEvidence.attachEvidence(pool, {
          workspaceId: targetWorkspace,
          eventId: evidence.eventId,
          kind: 'video',
          objectKey,
          publicUrl: upload.publicUrl
        });
      } else {
        await neonEvidence.attachEvidence(pool, {
          workspaceId: targetWorkspace,
          eventId: evidence.eventId,
          kind: 'video',
          objectKey,
          publicUrl: null,
          data: videoBytes,
          mimeType: 'video/webm'
        });
        artifact = { stored: true, provider: 'neon-postgres-bytea', access: 'neon-row', objectKey, mimeType: 'video/webm', sizeBytes: videoBytes.length };
      }
    } else if (videoBytes.length <= 8 * 1024 * 1024) {
      artifact = { stored: false, mimeType: 'video/webm', sizeBytes: videoBytes.length, dataBase64: videoBytes.toString('base64') };
    } else {
      throw new Error('Video exceeds inline result limit; provide uploadTarget or enable evidence persistence.');
    }

    return {
      videoExport: {
        enabled: true,
        method: 'CodeLab Video Composer',
        composerUrl,
        package: { format: 'codelab-pixelforge', frameCount: frames.length, fps, width: Number(project.width), height: Number(project.height), sizeBytes: zipBytes.length, vectorOverlayIncluded: Boolean(project.vectorModel?.objects?.length), perLayerDrawingModes: true },
        video: { format: 'webm', sizeBytes: videoBytes.length, suggestedFilename: download.suggestedFilename() },
        projectId: payload.project_id,
        serverRevision: loaded.serverRevision,
        imported,
        artifact,
        pageErrors,
        consoleErrors,
        passed: pageErrors.length === 0 && consoleErrors.length === 0 && imported.frames === frames.length
      }
    };
  } finally {
    if (page) await page.close().catch(() => {});
    if (ownsContext && context) await context.close().catch(() => {});
    if (ownsBrowser && browser) await browser.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export { exportPixelForgeAnimationVideo };
