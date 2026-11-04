import { createHash, randomUUID as nodeRandomUUID } from 'node:crypto';

const MAX_PROJECT_BYTES = 96 * 1024 * 1024;
const MAX_RASTER_BYTES = 64 * 1024 * 1024;
const MAX_ANIMATION_BYTES = 64 * 1024 * 1024;
const MAX_ANIMATION_FRAMES = 240;

function decodeCanonicalBase64(value, expectedBytes, label) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError(label + ' must be canonical base64.');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== expectedBytes || decoded.toString('base64') !== value) {
    throw new RangeError(label + ' does not match the expected RGBA byte length.');
  }
  return decoded.length;
}

function freshId(prefix, randomUUID) {
  const value = randomUUID();
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(value)) {
    throw new TypeError('The import identity generator returned an invalid ID.');
  }
  return prefix + value.replace(/-/g, '');
}

/**
 * Validate and re-key a portable PixelForge project before a chunked API import.
 * The source is never mutated; animation cels keep their pixel data and loop state.
 */
export function preparePixelForgeProjectImport(input, { randomUUID = nodeRandomUUID } = {}) {
  const source = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (source.length < 2 || source.length > MAX_PROJECT_BYTES) {
    throw new RangeError('PixelForge import file must be between 2 bytes and 96 MiB.');
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(source);
  let project;
  try { project = JSON.parse(text); }
  catch { throw new TypeError('PixelForge import file is not valid JSON.'); }

  if (!project || typeof project !== 'object' || Array.isArray(project) ||
      project.format !== 'pixelforge-project' || project.version !== 1) {
    throw new TypeError('Unsupported PixelForge portable project format.');
  }
  const { width, height } = project;
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || width > 2048 || height > 2048 ||
      width * height > 4_194_304) {
    throw new RangeError('PixelForge import canvas dimensions are outside the supported limits.');
  }
  if (typeof project.name !== 'string' || !project.name.trim() || project.name.length > 180) {
    throw new TypeError('PixelForge import project name is invalid.');
  }
  if (!Array.isArray(project.layers) || project.layers.length < 1 || project.layers.length > 64) {
    throw new RangeError('PixelForge import must contain 1 to 64 layers.');
  }

  const expectedCelBytes = width * height * 4;
  const originalIds = new Set();
  const layerIdMap = new Map();
  let rasterBytes = 0;
  for (const layer of project.layers) {
    if (!layer || typeof layer !== 'object' || typeof layer.id !== 'string' || !layer.id ||
        originalIds.has(layer.id) || typeof layer.name !== 'string' || !layer.name.trim() ||
        typeof layer.visible !== 'boolean' || typeof layer.locked !== 'boolean' ||
        !Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1) {
      throw new TypeError('PixelForge import contains an invalid or duplicate layer.');
    }
    originalIds.add(layer.id);
    rasterBytes += decodeCanonicalBase64(layer.pixels, expectedCelBytes, 'Layer pixels');
    layerIdMap.set(layer.id, freshId('layer_', randomUUID));
  }
  if (rasterBytes > MAX_RASTER_BYTES) {
    throw new RangeError('PixelForge import raster data exceeds the 64 MiB expanded limit.');
  }
  if (!originalIds.has(project.activeLayerId)) {
    throw new TypeError('PixelForge import active layer does not exist.');
  }

  let frameCount = 0;
  let animationBytes = 0;
  if (project.animation !== undefined && project.animation !== null) {
    const animation = project.animation;
    if (!animation || typeof animation !== 'object' || Array.isArray(animation) ||
        animation.format !== 'pixelforge-animation' || animation.version !== 1 ||
        animation.width !== width || animation.height !== height ||
        !Number.isInteger(animation.fps) || animation.fps < 1 || animation.fps > 60 ||
        typeof animation.loop !== 'boolean' ||
        !Array.isArray(animation.layerIds) || animation.layerIds.length !== project.layers.length ||
        !Array.isArray(animation.frames) || animation.frames.length > MAX_ANIMATION_FRAMES) {
      throw new TypeError('PixelForge import animation metadata is invalid.');
    }
    for (let index = 0; index < project.layers.length; index++) {
      if (animation.layerIds[index] !== project.layers[index].id) {
        throw new TypeError('PixelForge import animation layer order does not match the document.');
      }
    }
    frameCount = animation.frames.length;
    for (const frame of animation.frames) {
      if (!frame || typeof frame !== 'object' || !Array.isArray(frame.cels) ||
          frame.cels.length !== project.layers.length) {
        throw new TypeError('PixelForge import animation frame has an invalid cel set.');
      }
      for (let index = 0; index < frame.cels.length; index++) {
        const cel = frame.cels[index];
        if (!cel || cel.layerId !== project.layers[index].id) {
          throw new TypeError('PixelForge import animation cel does not match its layer.');
        }
        animationBytes += decodeCanonicalBase64(cel.pixels, expectedCelBytes, 'Animation cel pixels');
      }
    }
    if (animationBytes > MAX_ANIMATION_BYTES) {
      throw new RangeError('PixelForge import animation data exceeds the 64 MiB expanded limit.');
    }
    animation.layerIds = animation.layerIds.map(id => layerIdMap.get(id));
    animation.frames = animation.frames.map(frame => ({
      ...frame,
      cels: frame.cels.map(cel => ({ ...cel, layerId: layerIdMap.get(cel.layerId) })),
    }));
  }

  const imported = {
    ...project,
    id: freshId('pf_', randomUUID),
    name: project.name.trim().slice(0, 169) + ' (imported)',
    activeLayerId: layerIdMap.get(project.activeLayerId),
    revision: 0,
    saveVersion: 0,
    serverRevision: 0,
    layers: project.layers.map(layer => ({ ...layer, id: layerIdMap.get(layer.id) })),
  };
  const serialized = Buffer.from(JSON.stringify(imported), 'utf8');
  if (serialized.length > MAX_PROJECT_BYTES) {
    throw new RangeError('PixelForge imported project exceeds the 96 MiB serialized limit.');
  }
  const semanticSnapshot = [
    imported.name, imported.width, imported.height, imported.activeLayerId,
    imported.layers.map(layer => [layer.id, layer.name, layer.visible, layer.opacity, layer.locked, layer.pixels]),
    imported.animation ? [imported.animation.width, imported.animation.height, imported.animation.fps, imported.animation.loop, imported.animation.activeFrameIndex, imported.animation.layerIds,
      imported.animation.frames.map(frame => [frame.id, frame.name, frame.durationMs, frame.cels.map(cel => [cel.layerId, cel.pixels])])] : null,
  ];
  const semanticDigest = createHash('sha256').update(JSON.stringify(semanticSnapshot)).digest('hex');
  return {
    project: imported,
    serialized,
    bytes: serialized.length,
    layerCount: imported.layers.length,
    frameCount,
    rasterBytes,
    animationBytes,
    semanticDigest,
  };
}
