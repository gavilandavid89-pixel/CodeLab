/**
 * PixelForge frame timeline model.
 *
 * Frames contain independent RGBA cels for each raster layer. This model is
 * deliberately UI-agnostic so the existing drawing engine remains the editor
 * for every frame; the timeline never introduces a second drawing surface.
 */
export const MAX_ANIMATION_FRAMES = 240;
export const MAX_ANIMATION_BYTES = 256 * 1024 * 1024;
export const MIN_FRAME_DURATION_MS = 1;
export const MAX_FRAME_DURATION_MS = 10_000;
export const MIN_ANIMATION_FPS = 1;
export const MAX_ANIMATION_FPS = 60;

function assertDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || width > 4096 || height > 4096 ||
      width * height > 16_777_216) {
    throw new RangeError('Animation dimensions exceed PixelForge canvas limits.');
  }
}

function assertLayerIds(layerIds) {
  if (!Array.isArray(layerIds) || layerIds.length < 1 || layerIds.length > 64 ||
      layerIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 180) ||
      new Set(layerIds).size !== layerIds.length) {
    throw new TypeError('Animation requires 1–64 unique raster layer IDs.');
  }
}

function assertDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < MIN_FRAME_DURATION_MS ||
      durationMs > MAX_FRAME_DURATION_MS) {
    throw new RangeError(`Frame duration must be between ${MIN_FRAME_DURATION_MS} and ${MAX_FRAME_DURATION_MS} ms.`);
  }
}

function assertFps(fps) {
  if (!Number.isInteger(fps) || fps < MIN_ANIMATION_FPS || fps > MAX_ANIMATION_FPS) {
    throw new RangeError(`Animation FPS must be an integer from ${MIN_ANIMATION_FPS} to ${MAX_ANIMATION_FPS}.`);
  }
}

function clonePixels(pixels, expectedBytes) {
  if (!(pixels instanceof Uint8Array) && !(pixels instanceof Uint8ClampedArray)) {
    throw new TypeError('Animation cel pixels must be a Uint8Array or Uint8ClampedArray.');
  }
  if (pixels.byteLength !== expectedBytes) throw new RangeError('Animation cel pixel data does not match frame dimensions.');
  return new Uint8ClampedArray(pixels);
}

function encodeBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value, expectedBytes) {
  const expectedChars = Math.ceil(expectedBytes / 3) * 4;
  if (typeof value !== 'string' || value.length !== expectedChars ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError('Animation cel contains invalid or oversized base64 data.');
  }
  let binary;
  try { binary = atob(value); } catch { throw new TypeError('Animation cel contains invalid base64 data.'); }
  if (binary.length !== expectedBytes || btoa(binary) !== value) {
    throw new TypeError('Animation cel contains non-canonical or incorrectly sized data.');
  }
  const pixels = new Uint8ClampedArray(expectedBytes);
  for (let index = 0; index < expectedBytes; index++) pixels[index] = binary.charCodeAt(index);
  return pixels;
}

function makeBlankCels(layerIds, byteLength) {
  return new Map(layerIds.map(id => [id, new Uint8ClampedArray(byteLength)]));
}

function cloneFrame(frame, layerIds, byteLength, { id = crypto.randomUUID(), durationMs = frame.durationMs } = {}) {
  return {
    id,
    durationMs,
    cels: new Map(layerIds.map(layerId => {
      const pixels = frame.cels.get(layerId);
      if (!pixels) throw new Error('Animation frame is missing a required layer cel.');
      return [layerId, clonePixels(pixels, byteLength)];
    })),
  };
}

export class PixelForgeAnimation {
  #frames;
  #layerIds;
  #width;
  #height;
  #fps;
  #activeFrameIndex;

  constructor({ width, height, layerIds, fps = 12, frames = null, activeFrameIndex = 0 }) {
    assertDimensions(width, height);
    assertLayerIds(layerIds);
    assertFps(fps);
    this.#width = width;
    this.#height = height;
    this.#layerIds = [...layerIds];
    this.#fps = fps;
    const byteLength = width * height * 4;
    if (frames !== null && (!Array.isArray(frames) || frames.length < 1 || frames.length > MAX_ANIMATION_FRAMES)) {
      throw new RangeError(`Animation must contain 1–${MAX_ANIMATION_FRAMES} frames.`);
    }
    const estimatedBytes = (frames === null ? 1 : frames.length) * this.#layerIds.length * byteLength;
    if (estimatedBytes > MAX_ANIMATION_BYTES) {
      throw new RangeError('Animation exceeds PixelForge’s 256 MiB animation-memory budget.');
    }
    if (frames === null) {
      this.#frames = [{
        id: crypto.randomUUID(),
        durationMs: Math.round(1000 / fps),
        cels: makeBlankCels(this.#layerIds, byteLength),
      }];
    } else {
      this.#frames = frames.map(frame => {
        if (!frame || typeof frame.id !== 'string' || !frame.id.trim() || frame.id.length > 180) {
          throw new TypeError('Animation frame ID is invalid.');
        }
        assertDuration(frame.durationMs);
        const sourceCels = frame.cels instanceof Map ? frame.cels : new Map(
          Array.isArray(frame.cels) ? frame.cels.map(cel => [cel.layerId, cel.pixels]) : []
        );
        if (sourceCels.size !== this.#layerIds.length ||
            this.#layerIds.some(id => !sourceCels.has(id))) {
          throw new TypeError('Every animation frame must contain exactly one cel for each raster layer.');
        }
        return {
          id: frame.id,
          durationMs: frame.durationMs,
          cels: new Map(this.#layerIds.map(id => [id, clonePixels(sourceCels.get(id), byteLength)])),
        };
      });
      if (new Set(this.#frames.map(frame => frame.id)).size !== this.#frames.length) {
        throw new TypeError('Animation frame IDs must be unique.');
      }
    }
    if (!Number.isInteger(activeFrameIndex) || activeFrameIndex < 0 || activeFrameIndex >= this.#frames.length) {
      throw new RangeError('Active animation frame index is outside the timeline.');
    }
    this.#activeFrameIndex = activeFrameIndex;
    this.#assertMemoryBudget();
  }

  static fromDocument(document, { fps = 12 } = {}) {
    if (!document || !Number.isInteger(document.width) || !Array.isArray(document.layers) ||
        document.layers.length < 1 || document.layers.some(layer => !(layer.pixels instanceof Uint8Array) &&
        !(layer.pixels instanceof Uint8ClampedArray))) {
      throw new TypeError('A valid PixelForge raster document is required to create an animation.');
    }
    return new PixelForgeAnimation({
      width: document.width,
      height: document.height,
      layerIds: document.layers.map(layer => layer.id),
      fps,
      frames: [{
        id: crypto.randomUUID(),
        durationMs: Math.round(1000 / fps),
        cels: document.layers.map(layer => ({ layerId: layer.id, pixels: layer.pixels })),
      }],
    });
  }

  get width() { return this.#width; }
  get height() { return this.#height; }
  get fps() { return this.#fps; }
  get frameCount() { return this.#frames.length; }
  get activeFrameIndex() { return this.#activeFrameIndex; }
  get activeFrame() { return this.getFrame(this.#activeFrameIndex); }
  get layerIds() { return [...this.#layerIds]; }
  get totalDurationMs() { return this.#frames.reduce((sum, frame) => sum + frame.durationMs, 0); }
  get memoryBytes() { return this.#frames.length * this.#layerIds.length * this.#width * this.#height * 4; }

  getFrame(index) {
    const frame = this.#frameAt(index);
    return Object.freeze({ id: frame.id, durationMs: frame.durationMs, index });
  }

  getLayerPixels(frameIndex, layerId) {
    const frame = this.#frameAt(frameIndex);
    const pixels = frame.cels.get(layerId);
    if (!pixels) throw new Error('Unknown animation layer ID.');
    return new Uint8ClampedArray(pixels);
  }

  setLayerPixels(frameIndex, layerId, pixels) {
    const frame = this.#frameAt(frameIndex);
    if (!this.#layerIds.includes(layerId)) throw new Error('Unknown animation layer ID.');
    frame.cels.set(layerId, clonePixels(pixels, this.#width * this.#height * 4));
    this.#assertMemoryBudget();
    return true;
  }

  setActiveFrame(index) {
    this.#frameAt(index);
    this.#activeFrameIndex = index;
    return this.activeFrame;
  }

  addFrame({ duplicate = true, afterIndex = this.#activeFrameIndex, durationMs = null } = {}) {
    if (this.#frames.length >= MAX_ANIMATION_FRAMES) {
      throw new RangeError(`PixelForge supports up to ${MAX_ANIMATION_FRAMES} animation frames.`);
    }
    this.#frameAt(afterIndex);
    const nextFrameCount = this.#frames.length + 1;
    if (nextFrameCount * this.#layerIds.length * this.#width * this.#height * 4 > MAX_ANIMATION_BYTES) {
      throw new RangeError('Adding this frame would exceed PixelForge’s 256 MiB animation-memory budget.');
    }
    const source = this.#frames[afterIndex];
    const nextDuration = durationMs ?? source.durationMs;
    assertDuration(nextDuration);
    const next = duplicate
      ? cloneFrame(source, this.#layerIds, this.#width * this.#height * 4, { durationMs: nextDuration })
      : { id: crypto.randomUUID(), durationMs: nextDuration, cels: makeBlankCels(this.#layerIds, this.#width * this.#height * 4) };
    this.#frames.splice(afterIndex + 1, 0, next);
    this.#activeFrameIndex = afterIndex + 1;
    this.#assertMemoryBudget();
    return this.activeFrame;
  }

  duplicateFrame(index = this.#activeFrameIndex) {
    return this.addFrame({ duplicate: true, afterIndex: index });
  }

  deleteFrame(index = this.#activeFrameIndex) {
    this.#frameAt(index);
    if (this.#frames.length === 1) throw new RangeError('An animation must keep at least one frame.');
    const [removed] = this.#frames.splice(index, 1);
    if (this.#activeFrameIndex > index) this.#activeFrameIndex--;
    else if (this.#activeFrameIndex === index) this.#activeFrameIndex = Math.min(index, this.#frames.length - 1);
    return Object.freeze({ id: removed.id, index });
  }

  moveFrame(fromIndex, toIndex) {
    this.#frameAt(fromIndex);
    if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= this.#frames.length) {
      throw new RangeError('Target animation frame index is outside the timeline.');
    }
    if (fromIndex === toIndex) return false;
    const activeId = this.#frames[this.#activeFrameIndex].id;
    const [frame] = this.#frames.splice(fromIndex, 1);
    this.#frames.splice(toIndex, 0, frame);
    this.#activeFrameIndex = this.#frames.findIndex(item => item.id === activeId);
    return true;
  }

  addLayer(layerId, { copyFromLayerId = null } = {}) {
    if (typeof layerId !== 'string' || !layerId.trim() || layerId.length > 180 || this.#layerIds.includes(layerId)) {
      throw new TypeError('New animation layer ID must be unique non-empty text.');
    }
    if (this.#layerIds.length >= 64) throw new RangeError('Animation supports up to 64 raster layers.');
    const byteLength = this.#width * this.#height * 4;
    if ((this.#frames.length * (this.#layerIds.length + 1) * byteLength) > MAX_ANIMATION_BYTES) {
      throw new RangeError('Adding this layer would exceed PixelForge’s 256 MiB animation-memory budget.');
    }
    if (copyFromLayerId !== null && !this.#layerIds.includes(copyFromLayerId)) {
      throw new Error('Source animation layer ID does not exist.');
    }
    this.#layerIds.push(layerId);
    for (const frame of this.#frames) {
      const source = copyFromLayerId === null ? null : frame.cels.get(copyFromLayerId);
      frame.cels.set(layerId, source ? new Uint8ClampedArray(source) : new Uint8ClampedArray(byteLength));
    }
    return this.#layerIds.length;
  }

  removeLayer(layerId) {
    if (!this.#layerIds.includes(layerId)) throw new Error('Unknown animation layer ID.');
    if (this.#layerIds.length <= 1) throw new RangeError('An animation must keep at least one raster layer.');
    this.#layerIds = this.#layerIds.filter(id => id !== layerId);
    for (const frame of this.#frames) frame.cels.delete(layerId);
    return this.#layerIds.length;
  }

  reorderLayers(layerIds) {
    assertLayerIds(layerIds);
    if (layerIds.length !== this.#layerIds.length || this.#layerIds.some(id => !layerIds.includes(id))) {
      throw new TypeError('Layer reordering must preserve the existing animation layer IDs.');
    }
    if (layerIds.every((id, index) => id === this.#layerIds[index])) return false;
    for (const frame of this.#frames) frame.cels = new Map(layerIds.map(id => [id, frame.cels.get(id)]));
    this.#layerIds = [...layerIds];
    return true;
  }

  setFrameDuration(index, durationMs) {
    assertDuration(durationMs);
    this.#frameAt(index).durationMs = durationMs;
    return durationMs;
  }

  setFps(fps) {
    assertFps(fps);
    const durationMs = Math.max(MIN_FRAME_DURATION_MS, Math.min(MAX_FRAME_DURATION_MS, 1000 / fps));
    this.#fps = fps;
    for (const frame of this.#frames) frame.durationMs = durationMs;
    return durationMs;
  }

  frameIndexAtTime(elapsedMs, { loop = true } = {}) {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || typeof loop !== 'boolean') {
      throw new RangeError('Playback time must be a non-negative finite number.');
    }
    const total = this.totalDurationMs;
    const time = loop ? elapsedMs % total : Math.min(elapsedMs, Math.max(0, total - 1));
    let cursor = 0;
    for (let index = 0; index < this.#frames.length; index++) {
      cursor += this.#frames[index].durationMs;
      if (time < cursor) return index;
    }
    return this.#frames.length - 1;
  }

  getOnionSkinFrames({ previous = 1, next = 0 } = {}) {
    if (!Number.isInteger(previous) || previous < 0 || previous > 3 ||
        !Number.isInteger(next) || next < 0 || next > 3) {
      throw new RangeError('Onion skin range must be from 0 to 3 frames in each direction.');
    }
    const result = [];
    for (let offset = previous; offset >= 1; offset--) {
      const index = this.#activeFrameIndex - offset;
      if (index >= 0) result.push(Object.freeze({ index, direction: 'previous', opacity: 1 / (offset + 1) }));
    }
    for (let offset = 1; offset <= next; offset++) {
      const index = this.#activeFrameIndex + offset;
      if (index < this.#frames.length) result.push(Object.freeze({ index, direction: 'next', opacity: 1 / (offset + 1) }));
    }
    return result;
  }

  compositeFrame(frameIndex, layerSettings = null) {
    const frame = this.#frameAt(frameIndex);
    let settings = new Map();
    if (layerSettings !== null) {
      if (!Array.isArray(layerSettings) || layerSettings.length !== this.#layerIds.length) {
        throw new TypeError('Composite layer settings must match the animation layer stack.');
      }
      for (const layer of layerSettings) {
        if (!layer || !this.#layerIds.includes(layer.id) || settings.has(layer.id) ||
            (layer.visible !== undefined && typeof layer.visible !== 'boolean') ||
            (layer.opacity !== undefined && (!Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1))) {
          throw new TypeError('Composite layer settings contain invalid layer metadata.');
        }
        settings.set(layer.id, { visible: layer.visible !== false, opacity: layer.opacity ?? 1 });
      }
      if (settings.size !== this.#layerIds.length) throw new TypeError('Composite layer settings are missing a raster layer.');
    }
    const output = new Uint8ClampedArray(this.#width * this.#height * 4);
    for (let offset = 0; offset < output.length; offset += 4) {
      let red = 0, green = 0, blue = 0, alpha = 0;
      for (const layerId of this.#layerIds) {
        const settingsForLayer = settings.get(layerId) ?? { visible: true, opacity: 1 };
        if (!settingsForLayer.visible || settingsForLayer.opacity <= 0) continue;
        const source = frame.cels.get(layerId), sourceAlpha = source[offset + 3];
        if (sourceAlpha === 0) continue;
        const sa = sourceAlpha / 255 * settingsForLayer.opacity;
        const remaining = 1 - sa;
        red = source[offset] * sa + red * remaining;
        green = source[offset + 1] * sa + green * remaining;
        blue = source[offset + 2] * sa + blue * remaining;
        alpha = sa + alpha * remaining;
      }
      if (alpha > 0) {
        output[offset] = Math.round(red / alpha);
        output[offset + 1] = Math.round(green / alpha);
        output[offset + 2] = Math.round(blue / alpha);
        output[offset + 3] = Math.round(alpha * 255);
      }
    }
    return output;
  }

  toJSON() {
    return {
      format: 'pixelforge-animation',
      version: 1,
      width: this.#width,
      height: this.#height,
      layerIds: [...this.#layerIds],
      fps: this.#fps,
      activeFrameIndex: this.#activeFrameIndex,
      frames: this.#frames.map(frame => ({
        id: frame.id,
        durationMs: frame.durationMs,
        cels: this.#layerIds.map(layerId => ({
          layerId,
          pixels: encodeBase64(frame.cels.get(layerId)),
        })),
      })),
    };
  }

  static fromJSON(data) {
    if (!data || data.format !== 'pixelforge-animation' || data.version !== 1 ||
        !Array.isArray(data.layerIds) || !Array.isArray(data.frames)) {
      throw new TypeError('Unsupported or invalid PixelForge animation file.');
    }
    assertDimensions(data.width, data.height);
    assertLayerIds(data.layerIds);
    assertFps(data.fps);
    const byteLength = data.width * data.height * 4;
    if (data.frames.length < 1 || data.frames.length > MAX_ANIMATION_FRAMES) {
      throw new RangeError(`Animation must contain 1–${MAX_ANIMATION_FRAMES} frames.`);
    }
    if (data.frames.length * data.layerIds.length * byteLength > MAX_ANIMATION_BYTES) {
      throw new RangeError('Animation exceeds PixelForge’s 256 MiB animation-memory budget.');
    }
    if (!Number.isInteger(data.activeFrameIndex) || data.activeFrameIndex < 0 || data.activeFrameIndex >= data.frames.length) {
      throw new RangeError('Active animation frame index is outside the timeline.');
    }
    const frameIds = new Set();
    const layerIdSet = new Set(data.layerIds);
    for (const frame of data.frames) {
      if (!frame || typeof frame.id !== 'string' || !frame.id.trim() || frame.id.length > 180 || frameIds.has(frame.id)) {
        throw new TypeError('Animation frame IDs must be valid and unique.');
      }
      frameIds.add(frame.id);
      assertDuration(frame.durationMs);
      if (!Array.isArray(frame.cels) || frame.cels.length !== data.layerIds.length) {
        throw new TypeError('Every animation frame must contain exactly one cel for each raster layer.');
      }
      const celLayerIds = new Set();
      for (const cel of frame.cels) {
        if (!cel || typeof cel.layerId !== 'string' || !layerIdSet.has(cel.layerId) || celLayerIds.has(cel.layerId)) {
          throw new TypeError('Animation cel layer IDs must be valid, unique, and match the layer stack.');
        }
        celLayerIds.add(cel.layerId);
      }
    }
    const frames = data.frames.map(frame => ({
      id: frame.id,
      durationMs: frame.durationMs,
      cels: frame.cels.map(cel => ({
        layerId: cel.layerId,
        pixels: decodeBase64(cel.pixels, byteLength),
      })),
    }));
    return new PixelForgeAnimation({
      width: data.width,
      height: data.height,
      layerIds: data.layerIds,
      fps: data.fps,
      frames,
      activeFrameIndex: data.activeFrameIndex,
    });
  }

  #frameAt(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.#frames.length) {
      throw new RangeError('Animation frame index is outside the timeline.');
    }
    return this.#frames[index];
  }

  #assertMemoryBudget() {
    if (this.memoryBytes > MAX_ANIMATION_BYTES) {
      throw new RangeError('Animation exceeds PixelForge’s 256 MiB animation-memory budget.');
    }
  }
}
