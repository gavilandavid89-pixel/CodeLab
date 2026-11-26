import { PixelForgeAnimation, MAX_ANIMATION_BYTES, MAX_ANIMATION_FRAMES } from './animation.mjs';
import { guardStyleOwnedPixels } from './raster-style-ownership.mjs';

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

function ownershipTilesToPlane(tiles, width, height) {
  const plane = new Uint8Array(width * height);
  for (const [key, owners] of tiles) {
    const [tileX, tileY] = key.split(':').map(Number);
    const x = tileX * 64, y = tileY * 64;
    const tileWidth = Math.min(64, width - x), tileHeight = Math.min(64, height - y);
    if (tileWidth < 1 || tileHeight < 1 ||
        (!(owners instanceof Uint8Array) && !(owners instanceof Uint8ClampedArray)) ||
        owners.byteLength !== tileWidth * tileHeight) {
      throw new TypeError('Animation ownership tile dimensions do not match the cel.');
    }
    for (let row = 0; row < tileHeight; row++) {
      plane.set(owners.subarray(row * tileWidth, (row + 1) * tileWidth),
        (y + row) * width + x);
    }
  }
  return plane;
}

function ownershipPlaneToTiles(plane, width, height) {
  if (!(plane instanceof Uint8Array) || plane.byteLength !== width * height) {
    throw new TypeError('Animation ownership plane does not match the cel dimensions.');
  }
  const tiles = [];
  for (let y = 0; y < height; y += 64) {
    for (let x = 0; x < width; x += 64) {
      const tileWidth = Math.min(64, width - x), tileHeight = Math.min(64, height - y);
      const owners = new Uint8Array(tileWidth * tileHeight);
      let nonzero = false;
      for (let row = 0; row < tileHeight; row++) {
        const source = plane.subarray((y + row) * width + x, (y + row) * width + x + tileWidth);
        owners.set(source, row * tileWidth);
        if (!nonzero && source.some(value => value !== 0)) nonzero = true;
      }
      if (nonzero) tiles.push({ tileX: x / 64, tileY: y / 64, owners: encodeBase64(owners) });
    }
  }
  return tiles;
}
const MIN_PLAYBACK_SPEED = 0.1;
const MAX_PLAYBACK_SPEED = 4;
function assertPlaybackSpeed(speed) {
  if (!Number.isFinite(speed) || speed < MIN_PLAYBACK_SPEED || speed > MAX_PLAYBACK_SPEED) {
    throw new RangeError(`Animation playback speed must be between ${MIN_PLAYBACK_SPEED}× and ${MAX_PLAYBACK_SPEED}×.`);
  }
}
function emptyTimeline(width, height, layerIds, fps = 12, loop = true, playbackSpeed = 1) {
  assertPlaybackSpeed(playbackSpeed);
  return {
    format: FORMAT, version: VERSION, width, height, layerIds: [...layerIds],
    fps, loop, playbackSpeed, activeFrameIndex: 0, frames: [],
  };
}
function modelFromTimeline(timeline) {
  const { loop, ...serialized } = timeline;
  return PixelForgeAnimation.fromJSON(serialized);
}
function serializeModel(model, loop = true, names = new Map()) {
  const serialized = model.toJSON();
  return {
    ...serialized,
    loop: loop !== false,
    frames: serialized.frames.map((frame, index) => ({
      ...frame,
      name: names.get(frame.id) || 'Frame ' + (index + 1),
    })),
  };
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

function frameContext(model, document, index, layerId) {
  const safeIndex = Math.max(0, Math.min(model.frameCount - 1, Number.isInteger(index) ? index : model.activeFrameIndex));
  const frame = model.getFrame(safeIndex);
  const layerIds = [...model.layerIds];
  const selectedLayerId = layerId ?? document.activeLayerId ?? layerIds[0];
  if (!layerIds.includes(selectedLayerId)) throw new Error('Animation context layer was not found.');
  const cel = model.getLayerPixels(safeIndex, selectedLayerId);
  const composite = model.compositeFrame(safeIndex, document.layers.map(layer => ({ id: layer.id, visible: layer.visible, opacity: layer.opacity })));
  const previousIndex = safeIndex > 0 ? safeIndex - 1 : null;
  const previousFrame = previousIndex === null ? null : model.getFrame(previousIndex);
  const previousCel = previousIndex === null ? null : model.getLayerPixels(previousIndex, selectedLayerId);
  const layerMetadata = model.getLayerMetadata(safeIndex, selectedLayerId);
  const previousLayerMetadata = previousIndex === null ? null : model.getLayerMetadata(previousIndex, selectedLayerId);
  const changed = previousCel && compareRawPixels(previousCel, cel, model.width, model.height);
  return {
    frame: {
      index: safeIndex, id: frame.id, name: frame.name || 'Frame ' + (safeIndex + 1),
      durationMs: frame.durationMs, authoringMode: frame.authoringMode,
    },
    layer: {
      id: selectedLayerId, name: document.layers.find(layer => layer.id === selectedLayerId)?.name || selectedLayerId,
      authoringMode: layerMetadata.authoringMode,
      ownershipTiles: layerMetadata.ownershipTiles || [],
    },
    previous: previousFrame ? {
      index: previousIndex,
      id: previousFrame.id,
      name: previousFrame.name || 'Frame ' + (previousIndex + 1),
      authoringMode: previousFrame.authoringMode,
      ownershipTiles: previousLayerMetadata?.ownershipTiles || [],
      cel: encodeBase64(previousCel),
      composite: encodeBase64(model.compositeFrame(previousIndex, document.layers.map(layer => ({ id: layer.id, visible: layer.visible, opacity: layer.opacity })))),
    } : null,
    current: { cel: encodeBase64(cel), composite: encodeBase64(composite) },
    visual: { format: 'rgba-base64', width: model.width, height: model.height, previousFrameIndex: previousIndex },
    change: changed,
    guidance: {
      rule: 'Use the returned previous frame/cel as the visual and structural source of truth. Do not infer hidden pixels, anatomy, proportions, palette, or layer contents. Respect authoringMode and ownershipTiles; never overwrite pixels owned by the other style.',
      requestMoreContextAction: 'animation.frame.get_context',
      availableLayerIds: layerIds,
    },
  };
}
function compareRawPixels(previous, next, width, height) {
  let changedPixels = 0, minX = width, minY = height, maxX = -1, maxY = -1;
  for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = pixel * 4;
    let changed = false;
    for (let channel = 0; channel < 4; channel++) {
      if (previous[offset + channel] !== next[offset + channel]) { changed = true; break; }
    }
    if (!changed) continue;
    const x = pixel % width, y = Math.floor(pixel / width);
    changedPixels++;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { changedPixels, bounds: maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } };
}

function validateFrameIndex(index, frameCount) {
  if (!Number.isInteger(index) || index < 0 || index >= frameCount) {
    throw new RangeError('Frame index is outside the animation timeline.');
  }
}

export function createAnimationTimeline({ fps = 12, loop = true, playbackSpeed = 1 } = {}) {
  if (!Number.isInteger(fps) || fps < 1 || fps > 60 || typeof loop !== 'boolean') {
    throw new TypeError('Animation FPS must be 1–60 and loop must be boolean.');
  }
  assertPlaybackSpeed(playbackSpeed);
  return emptyTimeline(1, 1, ['layer-1'], fps, loop, playbackSpeed);
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
  assertPlaybackSpeed(value.playbackSpeed ?? 1);
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
    return emptyTimeline(width, height, value.layerIds, value.fps, value.loop !== false, value.playbackSpeed ?? 1);
  }
  for (const frame of value.frames) {
    if (frame.name !== undefined && (typeof frame.name !== 'string' || frame.name.length > 120)) {
      throw new TypeError('Animation frame name is invalid.');
    }
  }
  const model = PixelForgeAnimation.fromJSON({
    format: FORMAT, version: VERSION, width, height,
    layerIds: value.layerIds, fps: value.fps,
    activeFrameIndex: value.activeFrameIndex ?? 0,
    frames: value.frames,
  });
  const names = new Map(value.frames.map((frame, index) => [frame.id, frame.name || 'Frame ' + (index + 1)]));
  const normalized = serializeModel(model, value.loop !== false, names);
  normalized.playbackSpeed = value.playbackSpeed ?? 1;
  return normalized;
}

export function summarizeAnimationTimeline(timeline) {
  return {
    fps: timeline.fps,
    loop: timeline.loop !== false,
    playbackSpeed: timeline.playbackSpeed ?? 1,
    frameCount: timeline.frames.length,
    layerCount: timeline.layerIds.length,
    layerIds: [...timeline.layerIds],
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
  const names = new Map(next.frames.map((frame, index) => [frame.id, frame.name || 'Frame ' + (index + 1)]));
  const model = modelFromTimeline(next);
  const desired = new Set(currentIds);
  for (const id of [...model.layerIds]) if (!desired.has(id)) model.removeLayer(id);
  for (const layer of document.layers) {
    if (!model.layerIds.includes(layer.id)) model.addLayer(layer.id);
  }
  model.reorderLayers(currentIds);
  const synchronized = serializeModel(model, next.loop, names);
  synchronized.playbackSpeed = next.playbackSpeed ?? 1;
  return synchronized;
}

export function applyAnimationAction(timeline, document, action) {
  if (!action || typeof action !== 'object' || Array.isArray(action) || typeof action.name !== 'string') {
    throw new TypeError('Animation action must have a name.');
  }
  if (action.name === 'animation.get_summary') {
    return { timeline, result: summarizeAnimationTimeline(timeline), changed: false };
  }
  const next = clone(timeline);
  let loop = next.loop !== false;
  let playbackSpeed = next.playbackSpeed ?? 1;
  assertPlaybackSpeed(playbackSpeed);
  if (!next.frames.length && action.name === 'animation.set_loop') {
    if (typeof action.loop !== 'boolean') throw new TypeError('loop must be a boolean.');
    const updated = { ...next, loop: action.loop };
    return { timeline: updated, result: { loop: action.loop }, changed: updated.loop !== timeline.loop };
  }
  if (!next.frames.length && action.name === 'animation.set_playback_speed') {
    assertPlaybackSpeed(action.speed);
    const updated = { ...next, playbackSpeed: action.speed };
    return { timeline: updated, result: { playbackSpeed: action.speed }, changed: updated.playbackSpeed !== (timeline.playbackSpeed ?? 1) };
  }
  if (!next.frames.length && action.name === 'animation.set_fps') {
    if (!Number.isInteger(action.fps) || action.fps < 1 || action.fps > 60) {
      throw new RangeError('Animation FPS must be from 1 to 60.');
    }
    const updated = { ...next, fps: action.fps };
    return { timeline: updated, result: { fps: action.fps }, changed: updated.fps !== timeline.fps };
  }
  const createsInitialFrame = action.name === 'animation.frame.add_from_layer' ||
    action.name === 'animation.frame.capture_composite' ||
    action.name === 'animation.frame.capture_document';
  if (!next.frames.length && !createsInitialFrame) {
    throw new RangeError('Create the first animation frame before editing the timeline.');
  }
  let model = createModel(next, document);
  let result;
  const names = new Map(next.frames.map((frame, index) => [frame.id, frame.name || 'Frame ' + (index + 1)]));

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
      if (action.durationMs !== undefined) model.setFrameDuration(targetIndex, action.durationMs);
      const frameName = typeof action.frameName === 'string' && action.frameName.trim()
        ? action.frameName.trim().slice(0, 120) : 'Frame ' + (targetIndex + 1);
      names.set(frame.id, frameName);
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
      const sourceName = names.get(model.getFrame(index).id) || 'Frame ' + (index + 1);
      const frame = model.duplicateFrame(index);
      names.set(frame.id, (sourceName + ' copy').slice(0, 120));
      result = { frameId: frame.id, index: frame.index };
      break;
    }
    case 'animation.frame.delete': {
      const index = action.index ?? model.activeFrameIndex;
      validateFrameIndex(index, model.frameCount);
      const removed = model.getFrame(index);
      names.delete(removed.id);
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
    case 'animation.set_playback_speed':
      assertPlaybackSpeed(action.speed);
      playbackSpeed = action.speed;
      result = { playbackSpeed };
      break;
    case 'animation.frame.get_context': {
      result = frameContext(model, document, action.index, action.layerId);
      break;
    }
    case 'animation.frame.get_cel': {
      const index = action.index ?? model.activeFrameIndex;
      const pixels = model.getLayerPixels(index, action.layerId);
      const metadata = model.getLayerMetadata(index, action.layerId);
      result = {
        frameId: model.getFrame(index).id, layerId: action.layerId,
        width: model.width, height: model.height, pixels: encodeBase64(pixels),
        authoringMode: metadata.authoringMode,
        ownershipTiles: metadata.ownershipTiles,
      };
      break;
    }
    case 'animation.frame.set_cel': {
      const index = action.index ?? model.activeFrameIndex;
      const layerId = action.layerId;
      const pixels = decodeBase64(action.pixels, model.width * model.height * 4);
      const metadata = model.getLayerMetadata(index, layerId);
      const authoringMode = action.authoringMode ?? metadata.authoringMode ?? model.getFrame(index).authoringMode;
      if (!['illustration', 'pixel-art'].includes(authoringMode)) {
        throw new TypeError('animation.frame.set_cel requires a valid authoringMode.');
      }
      const before = model.getLayerPixels(index, layerId);
      const owners = ownershipTilesToPlane(model.getLayerOwnershipTiles(index, layerId), model.width, model.height);
      const guarded = guardStyleOwnedPixels({
        before, after: pixels, owners, authoringMode, operation: 'draw',
      });
      model.setLayerPixels(index, layerId, guarded.pixels);
      model.setFrameAuthoringMode(index, authoringMode);
      model.setLayerMetadata(index, layerId, {
        ...metadata, authoringMode,
        ownershipTiles: ownershipPlaneToTiles(guarded.owners, model.width, model.height),
      });
      result = {
        frameId: model.getFrame(index).id, layerId, changed: true,
        authoringMode, blockedPixels: guarded.blockedPixels,
        changedPixels: guarded.changedPixels,
      };
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

  const updated = serializeModel(model, loop, names);
  updated.playbackSpeed = playbackSpeed;
  return { timeline: validateAnimationTimeline(updated, document.width, document.height, document.layers), result, changed: JSON.stringify(next) !== JSON.stringify(updated) };
}

export function frameAtAnimationTime(timeline, timeMs) {
  if (!timeline.frames.length) return null;
  const model = modelFromTimeline(timeline);
  const index = model.frameIndexAtTime(timeMs, { loop: timeline.loop !== false });
  return { index, frame: timeline.frames[index], elapsedMs: timeMs, playbackSpeed: timeline.playbackSpeed ?? 1 };
}

export async function exportAnimationSpriteSheet(timeline, width, height, { columns = Math.ceil(Math.sqrt(timeline.frames.length)), padding = 1, layers = null } = {}) {
  const validated = validateAnimationTimeline(timeline, width, height);
  if (!validated.frames.length) throw new RangeError('Cannot export an empty animation timeline.');
  if (!Number.isInteger(columns) || columns < 1 || columns > MAX_ANIMATION_FRAMES) {
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
