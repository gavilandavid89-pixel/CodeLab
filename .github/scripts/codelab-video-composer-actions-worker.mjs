import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { chromium } from 'playwright';

const TARGET_URL = String(process.env.TARGET_URL || 'https://codelab-pbw9.onrender.com').replace(/\/$/, '');
const PROJECT_ID = String(process.env.PROJECT_ID || '2b33ccf4-f70c-4649-bed8-df1707cfdc74');
const ADMIN_USERNAME = String(process.env.CODELAB_ADMIN_USERNAME || '');
const ADMIN_PASSWORD = String(process.env.CODELAB_ADMIN_PASSWORD || '');
const COMPOSER_URL = String(process.env.COMPOSER_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');

if (ADMIN_USERNAME !== 'ADMIN' || !ADMIN_PASSWORD) throw new Error('ADMIN credentials are required.');

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
  out.writeUInt32BE(data.length, 0); typeBuf.copy(out, 4); data.copy(out, 8);
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
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}
function compositeFrame(project, frame) {
  const width = Number(project.width), height = Number(project.height);
  const out = Buffer.alloc(width * height * 4);
  const cels = new Map((frame.cels || []).map(c => [c.layerId, c]));
  for (const layer of project.layers || []) {
    if (!layer || layer.visible === false || !Number(layer.opacity ?? 1)) continue;
    const cel = cels.get(layer.id);
    const encoded = cel?.pixels || layer.pixels;
    if (typeof encoded !== 'string') throw new Error('Missing RGBA data for layer ' + layer.id);
    const src = Buffer.from(encoded, 'base64');
    if (src.length !== out.length) throw new Error('Invalid RGBA byte length.');
    const opacity = Math.max(0, Math.min(1, Number(layer.opacity ?? 1)));
    for (let i = 0; i < out.length; i += 4) {
      const sa = (src[i + 3] / 255) * opacity, da = out[i + 3] / 255;
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
function countVisiblePixels(rgba) {
  let visible = 0;
  for (let offset = 3; offset < rgba.length; offset += 4) {
    if (rgba[offset] > 0) visible++;
  }
  return visible;
}
function makeZip(entries) {
  const local = [], central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50,0); lh.writeUInt16LE(20,4); lh.writeUInt16LE(0,6);
    lh.writeUInt16LE(0,8); lh.writeUInt32LE(crc,14); lh.writeUInt32LE(data.length,18);
    lh.writeUInt32LE(data.length,22); lh.writeUInt16LE(name.length,26);
    local.push(lh,name,data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50,0); ch.writeUInt16LE(20,4); ch.writeUInt16LE(20,6);
    ch.writeUInt32LE(crc,16); ch.writeUInt32LE(data.length,20); ch.writeUInt32LE(data.length,24);
    ch.writeUInt16LE(name.length,28); ch.writeUInt32LE(offset,42);
    central.push(ch,name); offset += lh.length + name.length + data.length;
  }
  const l = Buffer.concat(local), c = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0); end.writeUInt16LE(entries.length,8);
  end.writeUInt16LE(entries.length,10); end.writeUInt32LE(c.length,12); end.writeUInt32LE(l.length,16);
  return Buffer.concat([l,c,end]);
}


function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.png': 'image/png',
    '.svg': 'image/svg+xml', '.webm': 'video/webm'
  })[ext] || 'application/octet-stream';
}
function startLocalComposerServer() {
  const root = path.resolve(process.cwd(), 'public');
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const filePath = path.resolve(root, relative);
      if (!filePath.startsWith(root + path.sep) && filePath !== root) {
        res.writeHead(403); return res.end('Forbidden');
      }
      const data = await fs.readFile(filePath);
      res.writeHead(200, { 'content-type': contentType(filePath), 'cache-control': 'no-store' });
      res.end(data);
    } catch (error) {
      res.writeHead(error?.code === 'ENOENT' ? 404 : 500);
      res.end(error?.code === 'ENOENT' ? 'Not found' : 'Server error');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(4173, '127.0.0.1', () => {
      console.log('[worker] local Video Composer server: ' + COMPOSER_URL);
      resolve(server);
    });
  });
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codelab-actions-vc-'));
let browser;
let composerServer;
try {
  composerServer = await startLocalComposerServer();
  console.log('[worker] starting CodeLab Video Composer Actions worker');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 640, height: 480 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    acceptDownloads: true
  });
  const page = await context.newPage();

  console.log('[worker] authenticating ADMIN');
  const login = await page.request.post(TARGET_URL + '/api/auth/login', {
    headers: { 'content-type': 'application/json' },
    data: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    timeout: 20000
  });
  const loginData = await login.json().catch(() => ({}));
  if (!login.ok() || loginData.ok !== true || loginData.user?.name !== 'ADMIN') {
    throw new Error('ADMIN login failed: HTTP ' + login.status());
  }

  console.log('[worker] downloading PixelForge project ' + PROJECT_ID);
  const projectResponse = await page.request.get(TARGET_URL + '/api/pixelforge/projects/' + encodeURIComponent(PROJECT_ID), { timeout: 30000 });
  if (!projectResponse.ok()) throw new Error('Project download failed: HTTP ' + projectResponse.status());
  const projectData = await projectResponse.json();
  const project = projectData.project;
  const frames = project?.animation?.frames;
  const fps = Number.isInteger(project?.animation?.fps) ? project.animation.fps : 12;
  if (!project || !Array.isArray(frames) || frames.length < 1) throw new Error('Project has no animation frames.');

  console.log('[worker] building Composer package: ' + frames.length + ' frames @ ' + fps + ' FPS');
  const entries = [];
  const manifestFrames = [];
  let durationMs = 0;
  let totalVisiblePixels = 0;
  for (let i = 0; i < frames.length; i++) {
    const duration = Math.max(1, Number(frames[i].durationMs || Math.round(1000 / fps)));
    const rgba = compositeFrame(project, frames[i]);
    const visiblePixels = countVisiblePixels(rgba);
    totalVisiblePixels += visiblePixels;
    if (i === 0 || i === Math.floor(frames.length / 2) || i === frames.length - 1) {
      console.log('[worker] source frame ' + (i + 1) + '/' + frames.length + ': ' + visiblePixels + ' visible pixels');
    }
    const png = rgbaToPng(rgba, Number(project.width), Number(project.height));
    const file = 'frames/frame-' + String(i + 1).padStart(4, '0') + '.png';
    entries.push({ name: file, data: png });
    manifestFrames.push({ index: i, file, durationMs: duration });
    durationMs += duration;
    if ((i + 1) % 20 === 0 || i === frames.length - 1) console.log('[worker] packaged ' + (i + 1) + '/' + frames.length);
  }
  if (totalVisiblePixels === 0) {
    throw new Error('PixelForge source animation is completely transparent: every frame has 0 visible pixels. The project data is empty before Video Composer; restore/save the artwork in PixelForge before exporting.');
  }
  console.log('[worker] source animation visible-pixel total: ' + totalVisiblePixels);
  entries.unshift({
    name: 'manifest.json',
    data: JSON.stringify({
      format: 'pixelforge-video-package', version: 1,
      width: Number(project.width), height: Number(project.height), fps,
      loop: project.animation.loop !== false, frameCount: frames.length, totalDurationMs: durationMs,
      frames: manifestFrames
    }, null, 2)
  });
  const packagePath = path.join(tempDir, 'codelab-video-composer.pixelforge-video.zip');
  await fs.writeFile(packagePath, makeZip(entries));
  console.log('[worker] package ready: ' + fsSync.statSync(packagePath).size + ' bytes');

  console.log('[worker] opening CodeLab Video Composer locally (GitHub runner)');
  const response = await page.goto(COMPOSER_URL + '/pixelforge/video-composer.html?export=1', {
    waitUntil: 'domcontentloaded', timeout: 45000
  });
  if (!response || !response.ok()) throw new Error('Video Composer returned HTTP ' + (response?.status() || 'no response'));
  await page.locator('#vc-file').waitFor({ state: 'attached', timeout: 15000 });
  await page.setInputFiles('#vc-file', packagePath);
  await page.waitForFunction(() => {
    const frames = Number(document.querySelector('#vc-stat-frames')?.textContent || 0);
    const button = document.querySelector('#vc-export');
    return frames > 0 && button && !button.disabled;
  }, null, { timeout: 30000 });

  const imported = await page.evaluate(() => ({
    frames: Number(document.querySelector('#vc-stat-frames')?.textContent || 0),
    fps: Number.parseInt(document.querySelector('#vc-stat-fps')?.textContent || '0', 10),
    size: document.querySelector('#vc-stat-size')?.textContent || '',
    duration: document.querySelector('#vc-stat-duration')?.textContent || ''
  }));
  if (imported.frames !== frames.length || imported.fps !== fps) {
    throw new Error('Composer metadata mismatch: ' + JSON.stringify({ imported, expected: { frames: frames.length, fps } }));
  }

  await page.selectOption('#vc-format', 'webm-vp9').catch(() => {});
  await page.selectOption('#vc-output-fps', String(fps)).catch(() => {});
  await page.selectOption('#vc-resolution', 'auto').catch(() => {});
  await page.selectOption('#vc-aspect', 'auto').catch(() => {});
  console.log('[worker] exporting WebM with CodeLab Video Composer');
  const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
  await page.locator('#vc-export').click();
  const download = await downloadPromise;
  const videoPath = path.join(tempDir, 'pixelforge-actions-composer.webm');
  await download.saveAs(videoPath);
  const video = await fs.readFile(videoPath);
  if (video.length < 1000 || video.length > 24 * 1024 * 1024) throw new Error('Invalid video size: ' + video.length);

  console.log('[worker] uploading completed Composer video to CodeLab evidence');
  const upload = await page.request.post(TARGET_URL + '/api/pixelforge/remote-video', {
    headers: { 'content-type': 'application/json' },
    data: {
      project_id: PROJECT_ID,
      video_base64: video.toString('base64'),
      filename: download.suggestedFilename(),
      frames: frames.length,
      fps,
      duration_ms: durationMs
    },
    timeout: 60000
  });
  const uploadData = await upload.json().catch(() => ({}));
  if (!upload.ok() || uploadData.ok !== true) throw new Error('Evidence upload failed: HTTP ' + upload.status() + ' ' + JSON.stringify(uploadData));

  console.log(JSON.stringify({
    ok: true, method: 'CodeLab Video Composer on GitHub Actions',
    projectId: PROJECT_ID, frames: frames.length, fps, durationMs,
    imported, videoBytes: video.length, eventId: uploadData.eventId,
    evidence: uploadData.artifact
  }, null, 2));

} finally {
  if (browser) await browser.close().catch(() => {});
  if (composerServer) await new Promise(resolve => composerServer.close(resolve));
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
}
