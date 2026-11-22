import { inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function fail(message) { throw new Error('CodeLab package install: ' + message); }

function decodePngRgba(buffer, expectedWidth, expectedHeight) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    fail('animation cel must be a valid PNG or raw RGBA8 file.');
  }
  let offset = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let palette = null, transparency = null;
  const compressed = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8, end = start + length;
    if (end + 4 > buffer.length) fail('PNG chunk is truncated.');
    const data = buffer.subarray(start, end);
    if (type === 'IHDR') {
      if (length !== 13) fail('PNG header is invalid.');
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
      if (data[10] !== 0 || data[11] !== 0) fail('unsupported PNG compression or filter method.');
    } else if (type === 'IDAT') compressed.push(data);
    else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') transparency = Buffer.from(data);
    offset = end + 4;
    if (type === 'IEND') break;
  }
  if (!width || !height || bitDepth !== 8 || interlace !== 0 ||
      ![0, 2, 3, 4, 6].includes(colorType)) {
    fail('PNG must be 8-bit, non-interlaced grayscale, RGB, indexed, grayscale-alpha or RGBA.');
  }
  if (width !== expectedWidth || height !== expectedHeight) fail('PNG cel dimensions must match project canvas dimensions.');
  if (colorType === 3 && (!palette || palette.length % 3)) fail('indexed PNG palette is missing or invalid.');
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[colorType];
  const rowBytes = width * channels;
  const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: (rowBytes + 1) * height });
  if (raw.length !== (rowBytes + 1) * height) fail('PNG pixel data length does not match its dimensions.');
  const decoded = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)];
    const src = y * (rowBytes + 1) + 1, dst = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const value = raw[src + x], left = x >= channels ? decoded[dst + x - channels] : 0;
      const up = y ? decoded[dst + x - rowBytes] : 0;
      const upperLeft = y && x >= channels ? decoded[dst + x - rowBytes - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upperLeft, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - upperLeft);
        predictor = a <= b && a <= c ? left : b <= c ? up : upperLeft;
      } else if (filter !== 0) fail('PNG uses an unsupported scanline filter.');
      decoded[dst + x] = (value + predictor) & 255;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i++, p += channels) {
    const d = i * 4;
    if (colorType === 6) decoded.copy(rgba, d, p, p + 4);
    else if (colorType === 2) { rgba[d] = decoded[p]; rgba[d + 1] = decoded[p + 1]; rgba[d + 2] = decoded[p + 2]; rgba[d + 3] = 255; }
    else if (colorType === 0) { rgba[d] = rgba[d + 1] = rgba[d + 2] = decoded[p]; rgba[d + 3] = 255; }
    else if (colorType === 4) { rgba[d] = rgba[d + 1] = rgba[d + 2] = decoded[p]; rgba[d + 3] = decoded[p + 1]; }
    else {
      const index = decoded[p], paletteOffset = index * 3;
      if (paletteOffset + 2 >= palette.length) fail('PNG palette index is out of range.');
      rgba[d] = palette[paletteOffset]; rgba[d + 1] = palette[paletteOffset + 1]; rgba[d + 2] = palette[paletteOffset + 2];
      rgba[d + 3] = transparency && index < transparency.length ? transparency[index] : 255;
    }
  }
  return { width, height, pixels: rgba };
}

function decodeCel(file, encoding, width, height) {
  const expected = width * height * 4;
  if (encoding === 'rgba8') {
    if (file.length !== expected) fail('RGBA8 cel byte length does not match project dimensions.');
    return file;
  }
  if (encoding !== 'png' && encoding !== 'png-rgba8') fail('cel encoding must be rgba8 or png.');
  const decoded = decodePngRgba(file, width, height);
  return decoded.pixels;
}

function safeResourcePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') &&
    !value.includes('\\0') && !value.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\'));
}

function classifyPath(filePath) {
  const [head] = filePath.split('/');
  return ['assets', 'scenes', 'animations', 'frames'].includes(head) ? head : 'project-files';
}

/**
 * Converts manifest-declared external PixelForge cels into the native
 * pixelforge-animation JSON model. No filename guessing: every cel is linked
 * explicitly by frameId + layerId in manifest.animation.frames[].cels[].
 */
export function installCodeLabPackage({ manifest, project, files }) {
  if (!manifest || !project || !(files instanceof Map)) fail('manifest, project and file map are required.');
  const destinations = [];
  for (const filePath of files.keys()) {
    if (!safeResourcePath(filePath)) fail('unsafe resource path: ' + filePath);
    destinations.push({ path: filePath, destination: classifyPath(filePath) });
  }

  if (manifest.editor !== 'pixelforge' || !manifest.animation) {
    return { project, destinations, installed: { animationFrames: 0, animationCels: 0 } };
  }
  if (project.format !== 'pixelforge-project' || !Array.isArray(project.layers) ||
      !Number.isInteger(project.width) || !Number.isInteger(project.height) ||
      project.width < 1 || project.height < 1 || project.width > 4096 || project.height > 4096 ||
      project.width * project.height > 16_777_216) {
    fail('PixelForge animation package requires a valid native pixelforge-project document.');
  }
  const animationSpec = manifest.animation;
  if (!Array.isArray(animationSpec.frames) || animationSpec.frames.length < 1 || animationSpec.frames.length > 240) {
    fail('manifest.animation.frames must contain 1–240 frames.');
  }
  const layerIds = project.layers.map(layer => layer.id);
  if (!layerIds.length || layerIds.length > 64 || layerIds.some(id => typeof id !== 'string' || !id) ||
      new Set(layerIds).size !== layerIds.length) {
    fail('project layers must have unique IDs before animation installation.');
  }
  const totalBytes = project.width * project.height * 4 * layerIds.length * animationSpec.frames.length;
  if (totalBytes > 64 * 1024 * 1024) fail('animation exceeds PixelForge 64 MiB animation pixel-memory budget.');
  const usedPaths = new Set();
  let celCount = 0;
  const frames = animationSpec.frames.map((frame, index) => {
    if (!frame || typeof frame.id !== 'string' || !frame.id.trim() ||
        !Number.isFinite(frame.durationMs) || frame.durationMs < 1 || frame.durationMs > 10000 ||
        !Array.isArray(frame.cels)) fail('frame ' + index + ' has invalid metadata.');
    const seenLayers = new Set();
    const cels = frame.cels.map(cel => {
      if (!cel || !layerIds.includes(cel.layerId) || seenLayers.has(cel.layerId) ||
          !safeResourcePath(cel.path) || typeof cel.encoding !== 'string') {
        fail('frame ' + frame.id + ' has an invalid or duplicate layer cel reference.');
      }
      const file = files.get(cel.path);
      if (!file) fail('frame ' + frame.id + ' references missing file: ' + cel.path);
      if (usedPaths.has(cel.path)) fail('a cel file cannot be assigned to multiple frame/layer destinations: ' + cel.path);
      usedPaths.add(cel.path); seenLayers.add(cel.layerId); celCount++;
      const pixels = decodeCel(file, cel.encoding, project.width, project.height);
      return { layerId: cel.layerId, pixels: pixels.toString('base64') };
    });
    if (seenLayers.size !== layerIds.length) fail('frame ' + frame.id + ' must provide exactly one cel for every project layer.');
    return { id: frame.id, durationMs: frame.durationMs, cels };
  });
  if (new Set(frames.map(frame => frame.id)).size !== frames.length) fail('frame IDs must be unique.');
  const fps = animationSpec.fps ?? 12;
  const activeFrameIndex = animationSpec.activeFrameIndex ?? 0;
  if (!Number.isInteger(fps) || fps < 1 || fps > 60 ||
      !Number.isInteger(activeFrameIndex) || activeFrameIndex < 0 || activeFrameIndex >= frames.length) {
    fail('animation FPS or active frame index is outside supported limits.');
  }
  const totalBytes = project.width * project.height * 4 * layerIds.length * frames.length;
  if (totalBytes > 64 * 1024 * 1024) fail('animation exceeds PixelForge 64 MiB frame-memory budget.');
  project.animation = {
    format: 'pixelforge-animation', version: 1, width: project.width, height: project.height,
    layerIds, fps, activeFrameIndex, frames,
    loop: animationSpec.loop !== false,
    playbackSpeed: Number.isFinite(animationSpec.playbackSpeed) ? animationSpec.playbackSpeed : 1,
  };
  return { project, destinations, installed: { animationFrames: frames.length, animationCels: celCount } };
}
