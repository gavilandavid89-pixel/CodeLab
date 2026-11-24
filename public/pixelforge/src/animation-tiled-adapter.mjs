/**
 * Lossless migration adapter between the legacy dense PixelForgeAnimation v1
 * model and a tile-backed animation working document.
 *
 * This is an opt-in bridge: the editor still uses PixelForgeAnimation v1 until
 * its tools/history/serializer are migrated. The tiled document stores cels by
 * stable frame/layer identity and never needs to compose a full canvas for
 * bounded region reads or writes.
 */
import { SparseTileCelStore, DEFAULT_CEL_TILE_SIZE } from './animation-tiles.mjs';

export const PIXELFORGE_TILED_ANIMATION_FORMAT = 'pixelforge-tiled-animation';
export const PIXELFORGE_TILED_ANIMATION_VERSION = 1;

function encodeBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function assertFrameIndex(index, length) {
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    throw new RangeError('Animation frame index is outside the timeline.');
  }
}

/**
 * Tile-backed adapter for an existing PixelForgeAnimation.
 * fromAnimation() performs a one-time v1-to-tile migration; subsequent edits
 * can use readRegion/writeRegion and cloneFrame without full-frame copies.
 */
export class TiledAnimationDocument {
  #store;
  #frames;
  #layerIds;
  #width;
  #height;
  #fps;
  #activeFrameIndex;

  constructor({ store, width, height, fps, layerIds, frames, activeFrameIndex = 0 }) {
    if (!(store instanceof SparseTileCelStore)) throw new TypeError('A SparseTileCelStore is required.');
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new RangeError('Tiled animation dimensions must be positive integers.');
    }
    if (!Array.isArray(layerIds) || !layerIds.length || new Set(layerIds).size !== layerIds.length) {
      throw new TypeError('Tiled animation requires unique layer IDs.');
    }
    if (!Array.isArray(frames) || !frames.length) throw new TypeError('Tiled animation requires at least one frame.');
    if (!Number.isInteger(activeFrameIndex) || activeFrameIndex < 0 || activeFrameIndex >= frames.length) {
      throw new RangeError('Active animation frame index is outside the timeline.');
    }
    this.#store = store;
    this.#width = width;
    this.#height = height;
    this.#fps = fps;
    this.#layerIds = [...layerIds];
    this.#frames = frames.map(frame => ({
      id: frame.id,
      durationMs: frame.durationMs,
      layerMetadata: structuredClone(frame.layerMetadata || {}),
      cels: new Map(frame.cels),
    }));
    this.#activeFrameIndex = activeFrameIndex;
  }

  static async fromAnimation(animation, {
    tileSize = DEFAULT_CEL_TILE_SIZE,
    maxDecodedCacheBytes = 8 * 1024 * 1024,
  } = {}) {
    if (!animation || typeof animation.getFrame !== 'function' ||
        typeof animation.getLayerPixels !== 'function' || !Array.isArray(animation.layerIds)) {
      throw new TypeError('fromAnimation requires a PixelForgeAnimation-compatible instance.');
    }
    const store = new SparseTileCelStore({ maxDecodedCacheBytes });
    const frames = [];
    try {
      for (let frameIndex = 0; frameIndex < animation.frameCount; frameIndex++) {
        const frame = animation.getFrame(frameIndex);
        const cels = new Map();
        const layerMetadata = {};
        for (const layerId of animation.layerIds) {
          const pixels = animation.getLayerPixels(frameIndex, layerId);
          cels.set(layerId, await store.createCelFromPixels(pixels, {
            width: animation.width, height: animation.height, tileSize,
          }));
          layerMetadata[layerId] = animation.getLayerMetadata?.(frameIndex, layerId) ?? {};
        }
        frames.push({ id: frame.id, durationMs: frame.durationMs, cels, layerMetadata });
      }
      return new TiledAnimationDocument({
        store, width: animation.width, height: animation.height, fps: animation.fps,
        layerIds: animation.layerIds, frames, activeFrameIndex: animation.activeFrameIndex,
      });
    } catch (error) {
      for (const frame of frames) for (const celId of frame.cels.values()) store.releaseCel(celId);
      throw error;
    }
  }

  get width() { return this.#width; }
  get height() { return this.#height; }
  get fps() { return this.#fps; }
  get frameCount() { return this.#frames.length; }
  get activeFrameIndex() { return this.#activeFrameIndex; }
  get layerIds() { return [...this.#layerIds]; }
  get stats() { return this.#store.stats; }

  getFrame(index) {
    assertFrameIndex(index, this.#frames.length);
    const frame = this.#frames[index];
    return Object.freeze({ id: frame.id, durationMs: frame.durationMs, index });
  }

  readRegion(frameIndex, layerId, region) {
    const frame = this.#frame(frameIndex);
    return this.#store.readRegion(this.#cel(frame, layerId), region);
  }

  async writeRegion(frameIndex, layerId, region, pixels) {
    const frame = this.#frame(frameIndex);
    const previousCelId = this.#cel(frame, layerId);
    const result = await this.#store.writeRegion(previousCelId, region, pixels);
    if (result.changed) frame.cels.set(layerId, result.celId);
    return { changed: result.changed, celId: result.celId, changedTiles: result.changedTiles, removedTiles: result.removedTiles };
  }

  cloneFrame(index, { afterIndex = index } = {}) {
    assertFrameIndex(index, this.#frames.length);
    if (!Number.isInteger(afterIndex) || afterIndex < -1 || afterIndex >= this.#frames.length) {
      throw new RangeError('Frame insertion index is outside the timeline.');
    }
    const source = this.#frames[index];
    const frame = {
      id: crypto.randomUUID(),
      durationMs: source.durationMs,
      layerMetadata: structuredClone(source.layerMetadata),
      cels: new Map([...source.cels].map(([layerId, celId]) => [layerId, this.#store.cloneCel(celId)])),
    };
    this.#frames.splice(afterIndex + 1, 0, frame);
    this.#activeFrameIndex = afterIndex + 1;
    return this.getFrame(this.#activeFrameIndex);
  }

  deleteFrame(index) {
    if (this.#frames.length <= 1) throw new RangeError('A tiled animation must retain at least one frame.');
    const frame = this.#frame(index);
    for (const celId of frame.cels.values()) this.#store.releaseCel(celId);
    this.#frames.splice(index, 1);
    this.#activeFrameIndex = Math.min(this.#activeFrameIndex, this.#frames.length - 1);
    return this.#frames.length;
  }

  setActiveFrame(index) {
    assertFrameIndex(index, this.#frames.length);
    this.#activeFrameIndex = index;
    return this.getFrame(index);
  }

  setFrameDuration(index, durationMs) {
    if (!Number.isFinite(durationMs) || durationMs < 1 || durationMs > 10000) {
      throw new RangeError('Frame duration must be between 1 and 10000 ms.');
    }
    this.#frame(index).durationMs = durationMs;
    return durationMs;
  }

  async toManifest() {
    const frames = [];
    for (const frame of this.#frames) {
      const cels = [];
      for (const layerId of this.#layerIds) {
        cels.push({
          layerId,
          cel: await this.#store.exportCel(this.#cel(frame, layerId)),
          metadata: structuredClone(frame.layerMetadata[layerId] || {}),
        });
      }
      frames.push({ id: frame.id, durationMs: frame.durationMs, cels });
    }
    return {
      format: PIXELFORGE_TILED_ANIMATION_FORMAT,
      version: PIXELFORGE_TILED_ANIMATION_VERSION,
      width: this.#width, height: this.#height, fps: this.#fps,
      layerIds: [...this.#layerIds], activeFrameIndex: this.#activeFrameIndex, frames,
    };
  }

  /** Explicit compatibility export; this intentionally materializes dense v1 cels. */
  async toLegacyAnimationJSON() {
    const frames = [];
    for (const frame of this.#frames) {
      const cels = [];
      for (const layerId of this.#layerIds) {
        cels.push({
          layerId,
          pixels: encodeBase64(this.#store.composeCel(this.#cel(frame, layerId))),
          metadata: structuredClone(frame.layerMetadata[layerId] || {}),
        });
      }
      frames.push({ id: frame.id, durationMs: frame.durationMs, cels });
    }
    return {
      format: 'pixelforge-animation', version: 1,
      width: this.#width, height: this.#height, layerIds: [...this.#layerIds],
      fps: this.#fps, activeFrameIndex: this.#activeFrameIndex, frames,
    };
  }

  dispose() {
    for (const frame of this.#frames) for (const celId of frame.cels.values()) this.#store.releaseCel(celId);
    this.#frames = [];
  }

  #frame(index) {
    assertFrameIndex(index, this.#frames.length);
    return this.#frames[index];
  }

  #cel(frame, layerId) {
    const celId = frame.cels.get(layerId);
    if (!celId || !this.#layerIds.includes(layerId)) throw new Error('Unknown animation layer ID.');
    return celId;
  }
}
