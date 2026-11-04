const MAX_FRAMES = 240;
const MAX_DURATION_MS = 60000;
const MAX_FPS = 120;
const MAX_ANIMATION_BYTES = 16 * 1024 * 1024;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function assert(condition, message, Type = TypeError) { if (!condition) throw new Type(message); }

export function createAnimationTimeline({ fps = 12, loop = true } = {}) {
  return validateAnimationTimeline({ format: 'pixelforge-animation', version: 1, fps, loop, frames: [] });
}

export function validateAnimationTimeline(value, width, height) {
  if (value == null) return createAnimationTimeline();
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Animation timeline must be an object.');
  assert(value.format === 'pixelforge-animation' && value.version === 1, 'Unsupported PixelForge animation format.');
  assert(Array.isArray(value.frames) && value.frames.length <= MAX_FRAMES, 'Animation must contain at most ' + MAX_FRAMES + ' frames.', RangeError);
  const fps = value.fps ?? 12;
  assert(Number.isInteger(fps) && fps >= 1 && fps <= MAX_FPS, 'Animation FPS must be an integer from 1 to ' + MAX_FPS + '.', RangeError);
  assert(typeof (value.loop ?? true) === 'boolean', 'Animation loop must be a boolean.');
  const expectedBytes = width && height ? width * height * 4 : null;
  const ids = new Set();
  const frames = value.frames.map((frame, index) => {
    assert(frame && typeof frame === 'object' && !Array.isArray(frame), 'Animation frame ' + index + ' must be an object.');
    assert(typeof frame.id === 'string' && frame.id.length > 0 && frame.id.length <= 100 && !ids.has(frame.id), 'Animation frame IDs must be unique non-empty strings.');
    ids.add(frame.id);
    assert(typeof frame.name === 'string' && frame.name.length <= 120, 'Animation frame name is invalid.');
    assert(Number.isInteger(frame.durationMs) && frame.durationMs >= 1 && frame.durationMs <= MAX_DURATION_MS, 'Frame duration must be from 1 to ' + MAX_DURATION_MS + ' ms.', RangeError);
    assert(typeof frame.pixels === 'string' && BASE64.test(frame.pixels), 'Animation frame pixels must be valid Base64.');
    if (expectedBytes !== null) {
      const expectedBase64Length = Math.ceil(expectedBytes / 3) * 4;
      assert(frame.pixels.length === expectedBase64Length, 'Animation frame pixel buffer does not match the project dimensions.');
    }
    return { id: frame.id, name: frame.name, durationMs: frame.durationMs, pixels: frame.pixels };
  });
  const normalized = { format: 'pixelforge-animation', version: 1, fps, loop: value.loop !== false, frames };
  assert(JSON.stringify(normalized).length <= MAX_ANIMATION_BYTES, 'Animation exceeds the 16 MiB timeline budget.', RangeError);
  return normalized;
}

export function summarizeAnimationTimeline(timeline) {
  return {
    fps: timeline.fps,
    loop: timeline.loop,
    frameCount: timeline.frames.length,
    totalDurationMs: timeline.frames.reduce((sum, frame) => sum + frame.durationMs, 0),
    frames: timeline.frames.map((frame, index) => ({ index, id: frame.id, name: frame.name, durationMs: frame.durationMs })),
  };
}

export function applyAnimationAction(timeline, document, action) {
  if (!action || typeof action !== 'object' || Array.isArray(action) || typeof action.name !== 'string') {
    throw new TypeError('Animation action must have a name.');
  }
  const next = clone(timeline);
  let result;
  switch (action.name) {
    case 'animation.get_summary':
      return { timeline, result: summarizeAnimationTimeline(timeline), changed: false };
    case 'animation.frame.add_from_layer': {
      if (next.frames.length >= MAX_FRAMES) throw new RangeError('Animation reached the ' + MAX_FRAMES + ' frame limit.');
      const layerId = action.layerId ?? document.activeLayerId;
      const layer = document.layers.find(item => item.id === layerId);
      if (!layer) throw new Error('Animation source layer was not found.');
      const snapshot = document.toJSON();
      const serializedLayer = snapshot.layers.find(item => item.id === layer.id);
      const frame = {
        id: crypto.randomUUID(),
        name: typeof action.frameName === 'string' && action.frameName.trim() ? action.frameName.trim().slice(0, 120) : 'Frame ' + (next.frames.length + 1),
        durationMs: action.durationMs ?? Math.round(1000 / next.fps),
        pixels: serializedLayer.pixels,
      };
      next.frames.push(frame);
      result = { frameId: frame.id, index: next.frames.length - 1, name: frame.name, durationMs: frame.durationMs };
      break;
    }
    case 'animation.frame.duplicate': {
      const index = action.index;
      if (!Number.isInteger(index) || index < 0 || index >= next.frames.length) throw new RangeError('Frame index is outside the timeline.');
      if (next.frames.length >= MAX_FRAMES) throw new RangeError('Animation reached the ' + MAX_FRAMES + ' frame limit.');
      const source = next.frames[index];
      const frame = { ...source, id: crypto.randomUUID(), name: (source.name + ' copy').slice(0, 120) };
      next.frames.splice(index + 1, 0, frame);
      result = { frameId: frame.id, index: index + 1 };
      break;
    }
    case 'animation.frame.delete': {
      const index = action.index;
      if (!Number.isInteger(index) || index < 0 || index >= next.frames.length) throw new RangeError('Frame index is outside the timeline.');
      const [removed] = next.frames.splice(index, 1);
      result = { deletedFrameId: removed.id, frameCount: next.frames.length };
      break;
    }
    case 'animation.frame.reorder': {
      const from = action.from, to = action.to;
      if (![from, to].every(Number.isInteger) || from < 0 || to < 0 || from >= next.frames.length || to >= next.frames.length) throw new RangeError('Frame reorder indices are outside the timeline.');
      const [frame] = next.frames.splice(from, 1);
      next.frames.splice(to, 0, frame);
      result = { frameId: frame.id, from, to };
      break;
    }
    case 'animation.frame.set_duration': {
      const index = action.index, durationMs = action.durationMs;
      if (!Number.isInteger(index) || index < 0 || index >= next.frames.length) throw new RangeError('Frame index is outside the timeline.');
      if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > MAX_DURATION_MS) throw new RangeError('Frame duration must be from 1 to ' + MAX_DURATION_MS + ' ms.', RangeError);
      next.frames[index].durationMs = durationMs;
      result = { frameId: next.frames[index].id, durationMs };
      break;
    }
    case 'animation.set_fps':
      if (!Number.isInteger(action.fps) || action.fps < 1 || action.fps > MAX_FPS) throw new RangeError('Animation FPS must be from 1 to ' + MAX_FPS + '.', RangeError);
      next.fps = action.fps;
      result = { fps: next.fps };
      break;
    case 'animation.set_loop':
      if (typeof action.loop !== 'boolean') throw new TypeError('loop must be a boolean.');
      next.loop = action.loop;
      result = { loop: next.loop };
      break;
    default:
      throw new Error('Unsupported animation action: ' + action.name);
  }
  return { timeline: validateAnimationTimeline(next, document.width, document.height), result, changed: true };
}

export const ANIMATION_LIMITS = Object.freeze({ maxFrames: MAX_FRAMES, maxDurationMs: MAX_DURATION_MS, maxFps: MAX_FPS, maxAnimationBytes: MAX_ANIMATION_BYTES });
