import { deflateSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { createZip } from './public/pixelforge/src/zip-export.js';
import { readStoredZip } from './public/pixelforge/src/video-composer-core.mjs';
import { HeadlessEditorRuntime } from './public/pixelforge/src/headless.js';

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

export function createPixelForgeProjectZip(sourceProject) {
  if (!sourceProject || typeof sourceProject !== 'object') throw new TypeError('A PixelForge project object is required.');
  const runtime = HeadlessEditorRuntime.fromJSON(sourceProject);
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
  for (let index = 0; index < frames.length; index++) {
    const durationMs = Math.max(1, Math.min(10000, Number(frames[index].durationMs || Math.round(1000 / fps))));
    totalDurationMs += durationMs;
    const rgba = composite(project, frames[index]);
    frameEntries.push({
      name: 'frames/frame-' + String(index + 1).padStart(4, '0') + '.png',
      data: rgbaToPng(rgba, project.width, project.height)
    });
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
      entryCount: frameEntries.length + 3
    }
  };
}

export async function parsePixelForgeProjectZip(input, { importedName } = {}) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (bytes.length < 22 || bytes.length > MAX_ZIP_BYTES) throw new RangeError('PixelForge ZIP must be between 22 bytes and 256 MiB.');
  const entries = await readStoredZip(new Blob([bytes]), { maxEntries: 512, maxTotalBytes: MAX_ZIP_BYTES });
  const manifestEntry = entries.get('manifest.json');
  if (!manifestEntry || manifestEntry.size > 2 * 1024 * 1024) throw new TypeError('PixelForge ZIP is missing a valid manifest.json.');
  let manifest;
  try { manifest = JSON.parse(await manifestEntry.blob.text()); }
  catch { throw new TypeError('PixelForge ZIP manifest is invalid JSON.'); }
  if (!manifest || manifest.format !== 'pixelforge-video-package' || manifest.version !== 1 ||
      typeof manifest.projectFile !== 'string' || manifest.projectFile.startsWith('/') ||
      manifest.projectFile.includes('\\') || manifest.projectFile.split('/').some(part => part === '..' || part === '.') ||
      !Number.isInteger(manifest.width) || !Number.isInteger(manifest.height) ||
      manifest.width < 1 || manifest.height < 1 || manifest.width > 4096 || manifest.height > 4096 ||
      !Number.isInteger(manifest.frameCount) || manifest.frameCount < 1 || manifest.frameCount > 240 ||
      !Array.isArray(manifest.frames) || manifest.frames.length !== manifest.frameCount) {
    throw new TypeError('PixelForge ZIP manifest has an unsupported format or invalid dimensions/timeline.');
  }
  const projectEntry = entries.get(manifest.projectFile);
  if (!projectEntry || projectEntry.size > MAX_PROJECT_BYTES) throw new TypeError('PixelForge ZIP does not contain its editable .pforge project file.');
  let project;
  try { project = JSON.parse(await projectEntry.blob.text()); }
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
  const inspection = verified.inspect();
  return {
    project: verified.toJSON(),
    metadata: {
      filename: projectEntry.name,
      projectName: canonical.name,
      width: canonical.width,
      height: canonical.height,
      layerCount: canonical.layers.length,
      frameCount: canonical.animation?.frames?.length || 0,
      entryCount: entries.size,
      zipBytes: bytes.length,
      projectBytes: projectEntry.size,
      inspection
    }
  };
}
