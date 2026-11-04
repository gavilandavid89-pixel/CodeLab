import { PixelForgeAnimation, MAX_ANIMATION_BYTES, MAX_ANIMATION_FRAMES } from './animation.mjs';

const FORMAT = 'pixelforge-animation';
const VERSION = 1;

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function encodeBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}
function decodeBase64(value, expectedBytes) {
  const expectedLength = Math.ceil(expectedBytes / 3) * 4;
  if (typeof value !== 'string' || value.length !== expectedLength ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError('Animation cel must be canonical Base64 matching the canvas dimensions.');
  }
  const binary = atob(value);
  if (binary.length !== expectedBytes || btoa(binary) !== value) {
    throw new TypeError('Animation cel Base64 is non-canonical or has the wrong byte length.');
  }
  const pixels = new Uint8ClampedArray(expectedBytes);
  for (let index = 0; index < expectedBytes; index++) pixels[index] = binary.charCodeAt(index);
  return pixels;
}
function layerIdsFrom(document) { return document.layers.map(layer => layer.id); }
function emptyTimeline(width, height, layerIds, fps = 12, loop = true) {
  return {
    format: FORMAT, version: VERSION, width, height, layerIds: [...layerIds],
    fps, loop, activeFrameIndex: 0, frames: [],
  };
}
function modelFromTimeline(timeline) {
  const { loop, ...serialized } = timeline;
  return PixelForgeAnimation.fromJSON(serialized);
}
function serializeModel(model, loop = true) {
  return { ...model.toJSON(), loop: loop !== false };
}
function assertDocumentMatches(timeline, document) {
  if (timeline.width !== document.width || timeline.height !== document.height) {
    throw new RangeError('Animation dimensions must match the PixelForge document.');
  }
  const expected = layerIdsFrom(document);
  if (expected.length !== timeline.layerIds.length ||
      expected.some((id, index) => id !== timeline.layerIds[index])) {
    throw new TypeError('Animation layer IDs and order must match the PixelForge document.');
  }
}
function createModel(timeline, document) {
  if (!timeline.frames.length) return PixelForgeAnimation.fromDocument(document, { fps: timeline.fps });
  assertDocumentMatches(timeline, document);
  return modelFromTimeline(timeline);
}
function validateFrameIndex(index, frameCount) {
  if (!Number.isInteger(index) || index < 0 || index >= frameCount) {
    throw new RangeError('Frame index is outside the animation timeline.');
  }
}

export function createAnimationTimeline({ fps = 12, loop = true } = {}) {
  if (!Number.isInteger(fps) || fps < 1 || fps > 60 || typeof loop !== 'boolean') {
    throw new TypeError('Animation FPS must be 1–60 and loop must be boolean.');
  }
  return emptyTimeline(1, 1, ['layer-1'], fps, loop);
}

export function validateAnimationTimeline(value, width, height, documentLayers = null) {
  const layerIds = Array.isArray(documentLayers)
    ? documentLayers.map(layer => layer.id)
    : Array.isArray(value?.layerIds) ? value.layerIds : ['layer-1'];
  if (value == null) return emptyTimeline(width, height, layerIds);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.format !== FORMAT || value.version !== VERSION) {
    throw new TypeError('Unsupported or invalid PixelForge animation format.');
  }
  if (value.width !== undefined && value.width !== width) throw new RangeError('Animation width does not match the project.');
  if (value.height !== undefined && value.height !== height) throw new RangeError('Animation height does not match the project.');
  if (!Number.isInteger(value.fps) || value.fps < 1 || value.fps > 60 ||
      typeof (value.loop ?? true) !== 'boolean') {
    throw new TypeError('Animation FPS or loop setting is invalid.');
  }
  if (!Array.isArray(value.frames) || value.frames.length > MAX_ANIMATION_FRAMES) {
    throw new RangeError('Animation must contain at most ' + MAX_ANIMATION_FRAMES + ' frames.');
  }
  if (!Array.isArray(value.layerIds) || value.layerIds.length < 1 ||
      value.layerIds.some(id => typeof id !== 'string' || !id.trim()) ||
      new Set(value.layerIds).size !== value.layerIds.length) {
    throw new TypeError('Animation layer IDs must be non-empty and unique.');
  }
  if (documentLayers && (layerIds.length !== value.layerIds.length ||
      layerIds.some((id, index) => id !== value.layerIds[index]))) {
    throw new TypeError('Saved animation layer IDs/order do not match the project layer stack.');
  }
  if (!value.frames.length) {
    return emptyTimeline(width, height, value.layerIds, value.fps, value.loop !== false);
  }
  const model = PixelForgeAnimation.fromJSON({
    format: FORMAT, version: VERSION, width, height,
    layerIds: value.layerIds, fps: value.fps,
    activeFrameIndex: value.activeFrameIndex ?? 0,
    frames: value.frames,
  });
  return serializeModel(model, value.loop !== false);
}

export function summarizeAnimationTimeline(timeline) {
  return {
    fps: timeline.fps,
    loop: timeline.loop !== false,
    frameCount: timeline.frames.length,
    layerCount: timeline.layerIds.length,
    activeFrameIndex: timeline.frames.length ? timeline.activeFrameIndex : null,
    memoryBytes: timeline.frames.length * timeline.layerIds.length * timeline.width * timeline.height * 4,
    totalDurationMs: timeline.frames.reduce((sum, frame) => sum + frame.durationMs, 0),
    frames: timeline.frames.map((frame, index) => ({
      index, id: frame.id, name: frame.name || 'Frame ' + (index + 1), durationMs: frame.durationMs,
    })),
  };
}

export function synchronizeAnimationLayers(timeline, document) {
  const next = clone(timeline);
  const currentIds = layerIdsFrom(document);
  if (!next.frames.length) {
    next.layerIds = currentIds;
    next.width = document.width;
    next.height = document.height;
    return next;
  }
  const model = modelFromTimeline(next);
  const desired = new Set(currentIds);
  for (const id of [...model.layerIds]) if (!desired.has(id)) model.removeLayer(id);
  for (const layer of document.layers) {
    if (!model.layerIds.includes(layer.id)) model.addLayer(layer.id);
  }
  model.reorderLayers(currentIds);
  return serializeModel(model, next.loop);
}

export function applyAnimationAction(timeline, document, action) {
  if (!action || typeof action !== 'object' || Array.isArray(action) || typeof action.name !== 'string') {
    throw new TypeError('Animation action must have a name.');
  }
  if (action.name === 'animation.get_summary') {
    return { timeline, result: summarizeAnimationTimeline(timeline), changed: false };
  }
  const next = clone(timeline);
  let model = createModel(next, document);
  let result;
  let loop = next.loop !== false;

  switch (action.name) {
    case 'animation.frame.add_from_layer':
    case 'animation.frame.capture_composite':
    case 'animation.frame.capture_document': {
      const layerId = action.layerId ?? document.activeLayerId;
      if (!document.layers.some(layer => layer.id === layerId)) throw new Error('Animation source layer was not found.');
      let frame;
      if (!next.frames.length) {
        frame = model.activeFrame;
      } else {
        frame = model.addFrame({
          duplicate: true,
          afterIndex: model.activeFrameIndex,
          ...(action.durationMs === undefined ? {} : { durationMs: action.durationMs }),
        });
      }
      const targetIndex = frame.index;
      if (action.name === 'animation.frame.capture_document' ||
          action.name === 'animation.frame.capture_composite') {
        for (const layer of document.layers) model.setLayerPixels(targetIndex, layer.id, layer.pixels);
      } else {
        const layer = document.layers.find(item => item.id === layerId);
        model.setLayerPixels(targetIndex, layerId, layer.pixels);
      }
      result = { frameId: frame.id, index: targetIndex, durationMs: frame.durationMs, source: action.name.endsWith('composite') ? 'document-layers' : layerId };
      break;
    }
    case 'animation.frame.duplicate': {
      const index = action.index ?? model.activeFrameIndex;
      validateFrameIndex(index, model.frameCount);
      const frame = model.duplicateFrame(index);
      result = { frameId: frame.id, index: frame.index };
      break;
    }
    case 'animation.frame.delete': {
      const index = action.index ?? model.activeFrameIndex;
      validateFrameIndex(index, model.frameCount);
      result = { ...model.deleteFrame(index), frameCount: model.frameCount };
      break;
    }
    case 'animation.frame.reorder': {
      const from = action.from, to = action.to;
      validateFrameIndex(from, model.frameCount);
      validateFrameIndex(to, model.frameCount);
      const frameId = model.getFrame(from).id;
      result = { frameId, from, to, changed: model.moveFrame(from, to) };
      break;
    }
    case 'animation.frame.set_duration': {
      const index = action.index ?? model.activeFrameIndex;
      result = { frameId: model.getFrame(index).id, durationMs: model.setFrameDuration(index, action.durationMs) };
      break;
    }
    case 'animation.frame.set_active': {
      const frame = model.setActiveFrame(action.index);
      result = { frameId: frame.id, index: frame.index };
      break;
    }
    case 'animation.set_fps':
      result = { fps: action.fps, frameDurationMs: model.setFps(action.fps) };
      break;
    case 'animation.set_loop':
      if (typeof action.loop !== 'boolean') throw new TypeError('loop must be a boolean.');
      loop = action.loop;
      result = { loop };
      break;
    case 'animation.frame.get_cel': {
      const index = action.index ?? model.activeFrameIndex;
      const pixels = model.getLayerPixels(index, action.layerId);
      result = { frameId: model.getFrame(index).id, layerId: action.layerId, width: model.width, height: model.height, pixels: encodeBase64(pixels) };
      break;
    }
    case 'animation.frame.set_cel': {
      const index = action.index ?? model.activeFrameIndex;
      const layerId = action.layerId;
      const pixels = decodeBase64(action.pixels, model.width * model.height * 4);
      model.setLayerPixels(index, layerId, pixels);
      result = { frameId: model.getFrame(index).id, layerId, changed: true };
      break;
    }
    case 'animation.frame.get_onion_skin':
      result = model.getOnionSkinFrames({ previous: action.previous ?? 1, next: action.next ?? 0 });
      break;
    case 'animation.frame.get_composite': {
      const index = action.index ?? model.activeFrameIndex;
      const settings = document.layers.map(layer => ({ id: layer.id, visible: layer.visible, opacity: layer.opacity }));
      result = { frameId: model.getFrame(index).id, width: model.width, height: model.height, pixels: encodeBase64(model.compositeFrame(index, settings)) };
      break;
    }
    default:
      throw new Error('Unsupported animation action: ' + action.name);
  }

  const updated = serializeModel(model, loop);
  return { timeline: validateAnimationTimeline(updated, document.width, document.height, document.layers), result, changed: JSON.stringify(next) !== JSON.stringify(updated) };
}

export function frameAtAnimationTime(timeline, timeMs) {
  if (!timeline.frames.length) return null;
  const model = modelFromTimeline(timeline);
  const index = model.frameIndexAtTime(timeMs, { loop: timeline.loop !== false });
  return { index, frame: timeline.frames[index], elapsedMs: timeMs };
}

export async function exportAnimationSpriteSheet(timeline, width, height, { columns = Math.ceil(Math.sqrt(timeline.frames.length)), padding = 1, layers = null } = {}) {
  const validated = validateAnimationTimeline(timeline, width, height);
  if (!validated.frames.length) throw new RangeError('Cannot export an empty animation timeline.');
  if (!Number.isInteger(columns) || columns < 1 || columns > validated.frames.length) {
    throw new RangeError('Sprite sheet columns must be within the frame count.');
  }
  if (!Number.isInteger(padding) || padding < 0 || padding > 64) {
    throw new RangeError('Sprite sheet padding must be from 0 to 64 pixels.');
  }
  if (typeof document === 'undefined' || typeof ImageData === 'undefined') {
    throw new Error('Sprite sheet export requires a browser canvas.');
  }
  const model = modelFromTimeline(validated);
  const rows = Math.ceil(validated.frames.length / columns);
  const sheetWidth = columns * width + (columns + 1) * padding;
  const sheetHeight = rows * height + (rows + 1) * padding;
  if (sheetWidth > 16384 || sheetHeight > 16384 || sheetWidth * sheetHeight > 16_777_216) {
    throw new RangeError('Sprite sheet exceeds the 16-megapixel / 16384-pixel export surface limit.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = sheetWidth;
  canvas.height = sheetHeight;
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) throw new Error('Could not create the animation sprite sheet surface.');
  context.clearRect(0, 0, canvas.width, canvas.height);
  const frameSettings = layers ?? validated.layerIds.map(id => ({ id, visible: true, opacity: 1 }));
  const frames = validated.frames.map((frame, index) => {
    const pixels = model.compositeFrame(index, frameSettings);
    const x = padding + (index % columns) * (width + padding);
    const y = padding + Math.floor(index / columns) * (height + padding);
    context.putImageData(new ImageData(pixels, width, height), x, y);
    return { index, id: frame.id, durationMs: frame.durationMs, x, y, width, height };
  });
  const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('PNG encoder returned no data.')), 'image/png'));
  return {
    blob,
    manifest: {
      format: 'pixelforge-animation-sprite-sheet',
      version: 1,
      fps: validated.fps,
      loop: validated.loop,
      layerIds: validated.layerIds,
      frameCount: frames.length,
      sheet: { width: canvas.width, height: canvas.height, columns, rows, padding },
      frameSize: { width, height },
      frames,
    },
  };
}

export const ANIMATION_LIMITS = Object.freeze({
  maxFrames: MAX_ANIMATION_FRAMES,
  maxFps: 60,
  maxAnimationBytes: MAX_ANIMATION_BYTES,
});
