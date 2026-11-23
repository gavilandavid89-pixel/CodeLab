import { deflateSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { createZip } from './public/pixelforge/src/zip-export.js';
import { parsePixelForgeVideoPackage } from './public/pixelforge/src/video-composer-core.mjs';
import { HeadlessEditorRuntime } from './public/pixelforge/src/headless.js';
import { vectorModelToSVG } from './public/pixelforge/src/vector-studio.js';
import chromium from '@sparticuz/chromium';
import { chromium as playwrightChromium } from 'playwright-core';

const MAX_PROJECT_BYTES = 96 * 1024 * 1024;
const MAX_ZIP_BYTES = 256 * 1024 * 1024;
const safeName = value => String(value || 'pixelforge-project').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90) || 'pixelforge-project';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBytes.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return result;
}

function rgbaToPng(rgba, width, height) {
  const stride = width * 4;
  if (rgba.length !== stride * height) throw new RangeError('RGBA frame dimensions do not match the project canvas.');
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
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

function composite(project, frame) {
  const width = project.width, height = project.height;
  const output = Buffer.alloc(width * height * 4);
  const cels = new Map((frame?.cels || []).map(cel => [cel.layerId, cel]));
  for (const layer of project.layers) {
    if (layer.visible === false || Number(layer.opacity ?? 1) <= 0) continue;
    const encoded = cels.get(layer.id)?.pixels || layer.pixels;
    if (typeof encoded !== 'string') throw new TypeError('A raster layer is missing its RGBA data.');
    const source = Buffer.from(encoded, 'base64');
    if (source.length !== output.length) throw new RangeError('Raster layer byte length does not match project dimensions.');
    const opacity = Math.max(0, Math.min(1, Number(layer.opacity ?? 1)));
    for (let offset = 0; offset < output.length; offset += 4) {
      const sourceAlpha = source[offset + 3] / 255 * opacity;
      if (!sourceAlpha) continue;
      const destAlpha = output[offset + 3] / 255;
      const alpha = sourceAlpha + destAlpha * (1 - sourceAlpha);
      if (!alpha) continue;
      for (let channel = 0; channel < 3; channel++) {
        output[offset + channel] = Math.round((source[offset + channel] * sourceAlpha + output[offset + channel] * destAlpha * (1 - sourceAlpha)) / alpha);
      }
      output[offset + 3] = Math.round(alpha * 255);
    }
  }
  return output;
}

export async function createPixelForgeProjectZip(sourceProject) {
  if (!sourceProject || typeof sourceProject !== 'object') throw new TypeError('A PixelForge project object is required.');
  const runtime = HeadlessEditorRuntime.fromJSON(sourceProject);
  if (sourceProject.vectorModel) {
    const vectorModel = sourceProject.vectorModel;
    const vectorCheck = runtime.execute({
      name: 'vector.model.configure',
      grid: vectorModel.grid,
      snap: vectorModel.snap,
      metadata: vectorModel.metadata
    });
    if (!vectorCheck.ok) throw new TypeError('Project vector model failed Headless validation: ' + vectorCheck.error.message);
  }
  const project = runtime.toJSON();
  const projectBytes = Buffer.from(JSON.stringify(project), 'utf8');
  if (projectBytes.length > MAX_PROJECT_BYTES) throw new RangeError('PixelForge project exceeds the 96 MiB JSON limit.');
  const animation = project.animation || null;
  const frames = animation?.frames?.length
    ? animation.frames
    : [{ id: 'still', durationMs: 1000, cels: project.layers.map(layer => ({ layerId: layer.id, pixels: layer.pixels })) }];
  if (frames.length > 240) throw new RangeError('PixelForge ZIP export supports at most 240 frames.');
  const fps = Number.isInteger(animation?.fps) ? animation.fps : 1;
  const frameEntries = [];
  let totalDurationMs = 0;
  const vectorSvg = project.vectorModel?.objects?.length ? vectorModelToSVG(project.vectorModel) : null;
  let browser = null;
  try {
    let vectorPage = null;
    if (vectorSvg) {
      chromium.setGraphicsMode = false;
      browser = await playwrightChromium.launch({
        args: chromium.args,
        executablePath: await chromium.executablePath(),
        headless: true,
        timeout: 60000
      });
      vectorPage = await browser.newPage({
        viewport: { width: project.width, height: project.height },
        deviceScaleFactor: 1
      });
      await vectorPage.setContent('<!doctype html><html><body style="margin:0;padding:0;background:transparent"><canvas id="vector-composite" width="' +
        project.width + '" height="' + project.height + '" style="display:block"></canvas></body></html>');
    }
    const vectorDataUrl = vectorSvg ? 'data:image/svg+xml;base64,' + Buffer.from(vectorSvg, 'utf8').toString('base64') : null;
    for (let index = 0; index < frames.length; index++) {
      const durationMs = Math.max(1, Math.min(10000, Number(frames[index].durationMs || Math.round(1000 / fps))));
      totalDurationMs += durationMs;
      const rgba = composite(project, frames[index]);
      let png = rgbaToPng(rgba, project.width, project.height);
      if (vectorPage) {
        await vectorPage.evaluate(async ({ rasterDataUrl, vectorDataUrl, width, height }) => {
          const load = source => new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error('Could not rasterize vector overlay for the ZIP frame.'));
            image.src = source;
          });
          const [raster, vector] = await Promise.all([load(rasterDataUrl), load(vectorDataUrl)]);
          const canvas = document.querySelector('#vector-composite');
          canvas.width = width; canvas.height = height;
          const context = canvas.getContext('2d', { alpha: true });
          context.clearRect(0, 0, width, height);
          context.drawImage(raster, 0, 0, width, height);
          context.drawImage(vector, 0, 0, width, height);
        }, {
          rasterDataUrl: 'data:image/png;base64,' + png.toString('base64'),
          vectorDataUrl,
          width: project.width,
          height: project.height
        });
        png = await vectorPage.screenshot({ type: 'png', omitBackground: true });
      }
      frameEntries.push({
        name: 'frames/frame-' + String(index + 1).padStart(4, '0') + '.png',
        data: png
      });
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  const projectFile = 'project/' + safeName(project.name) + '.pforge';
  const manifest = {
    format: 'pixelforge-video-package',
    version: 1,
    width: project.width,
    height: project.height,
    fps,
    loop: animation?.loop !== false,
    frameCount: frames.length,
    totalDurationMs,
    projectFile,
    frames: frameEntries.map((entry, index) => ({
      index, file: entry.name,
      durationMs: Math.max(1, Math.min(10000, Number(frames[index].durationMs || Math.round(1000 / fps))))
    }))
  };
  const archive = createZip([
    { name: projectFile, data: projectBytes },
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    { name: 'README.txt', data: Buffer.from('PIXELFORGE EDITABLE PROJECT PACKAGE\n\nproject/: canonical editable .pforge project JSON\nframes/: transparent PNG frames in playback order\nmanifest.json: dimensions, FPS, loop and frame durations\n\nImport the .pforge file in PixelForge or this ZIP through the CodeLab agent mailbox.\n', 'utf8') },
    ...frameEntries
  ]);
  if (archive.length > MAX_ZIP_BYTES) throw new RangeError('PixelForge ZIP package exceeds the 256 MiB artifact limit.');
  return {
    bytes: Buffer.from(archive),
    metadata: {
      format: 'pixelforge-editable-zip/v1',
      projectId: project.id,
      projectName: project.name,
      width: project.width,
      height: project.height,
      frameCount: frames.length,
      fps,
      totalDurationMs,
      projectFile,
      entryCount: frameEntries.length + 3,
      vectorOverlayIncluded: Boolean(vectorSvg)
    }
  };
}

export async function parsePixelForgeProjectZip(input, { importedName } = {}) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (bytes.length < 22 || bytes.length > MAX_ZIP_BYTES) throw new RangeError('PixelForge ZIP must be between 22 bytes and 256 MiB.');
  const parsedPackage = await parsePixelForgeVideoPackage(new Blob([bytes]));
  const manifest = parsedPackage.manifest;
  if (!manifest || manifest.format !== 'pixelforge-video-package' || manifest.version !== 1 ||
      typeof manifest.projectFile !== 'string' || manifest.projectFile.startsWith('/') ||
      manifest.projectFile.includes('\\\\') || manifest.projectFile.split('/').some(part => part === '..' || part === '.') ||
      !parsedPackage.project || parsedPackage.project.size > MAX_PROJECT_BYTES) {
    throw new TypeError('PixelForge ZIP does not contain a safe editable .pforge project entry.');
  }
  let project;
  try { project = JSON.parse(await parsedPackage.project.text()); }
  catch { throw new TypeError('Editable .pforge project is invalid JSON.'); }
  if (project.width !== manifest.width || project.height !== manifest.height) throw new TypeError('ZIP manifest and editable project dimensions do not match.');
  if ((project.animation?.frames?.length || 1) !== manifest.frameCount) throw new TypeError('ZIP manifest and editable project frame counts do not match.');
  const canonical = HeadlessEditorRuntime.fromJSON(project).toJSON();
  canonical.id = randomUUID().replaceAll('-', '_');
  canonical.name = String(importedName || (project.name + ' (imported)')).trim().slice(0, 100) || 'Imported PixelForge project';
  canonical.revision = 0;
  canonical.saveVersion = 0;
  canonical.serverRevision = 0;
  const verified = HeadlessEditorRuntime.fromJSON(canonical);
  if (canonical.vectorModel) {
    const vectorModel = canonical.vectorModel;
    const vectorCheck = verified.execute({
      name: 'vector.model.configure',
      grid: vectorModel.grid,
      snap: vectorModel.snap,
      metadata: vectorModel.metadata
    });
    if (!vectorCheck.ok) throw new TypeError('Imported vector model failed Headless validation: ' + vectorCheck.error.message);
  }
  const inspection = verified.inspect();
  return {
    project: verified.toJSON(),
    metadata: {
      filename: manifest.projectFile,
      projectName: canonical.name,
      width: canonical.width,
      height: canonical.height,
      layerCount: canonical.layers.length,
      frameCount: canonical.animation?.frames?.length || 0,
      entryCount: parsedPackage.entryCount,
      zipBytes: bytes.length,
      projectBytes: parsedPackage.project.size,
      inspection
    }
  };
}
