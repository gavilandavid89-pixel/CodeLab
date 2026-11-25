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
import { PIXELFORGE_DRAWING_MODES } from './drawing-mode-config.mjs';

const VALID_DRAWING_MODES = Object.values(PIXELFORGE_DRAWING_MODES);
const DEFAULT_DRAWING_MODE = PIXELFORGE_DRAWING_MODES.PIXEL_ART;
function normalizeAuthoringMode(value, fallback = DEFAULT_DRAWING_MODE) {
  return VALID_DRAWING_MODES.includes(value) ? value : fallback;
}
function normalizeCelMetadata(value, fallbackMode) {
  const metadata = value && typeof value === 'object' && !Array.isArray(value) ? structuredClone(value) : {};
  metadata.authoringMode = normalizeAuthoringMode(metadata.authoringMode, fallbackMode);
  return metadata;
}

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
      authoringMode: normalizeAuthoringMode(frame.authoringMode),
      layerMetadata: Object.fromEntries(Object.entries(frame.layerMetadata || {}).map(([layerId, metadata]) => [layerId, normalizeCelMetadata(metadata, normalizeAuthoringMode(frame.authoringMode))])),
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
        const frameAuthoringMode = normalizeAuthoringMode(frame.authoringMode ?? animation.getFrameMetadata?.(frameIndex)?.authoringMode);
        for (const layerId of animation.layerIds) {
          const pixels = animation.getLayerPixels(frameIndex, layerId);
          cels.set(layerId, await store.createCelFromPixels(pixels, {
            width: animation.width, height: animation.height, tileSize,
          }));
          layerMetadata[layerId] = normalizeCelMetadata(animation.getLayerMetadata?.(frameIndex, layerId), frameAuthoringMode);
        }
        frames.push({ id: frame.id, durationMs: frame.durationMs, authoringMode: frameAuthoringMode, cels, layerMetadata });
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

  static async fromManifest(manifest, { maxDecodedCacheBytes = 8 * 1024 * 1024 } = {}) {
    if (!manifest || manifest.format !== PIXELFORGE_TILED_ANIMATION_FORMAT ||
        manifest.version !== PIXELFORGE_TILED_ANIMATION_VERSION ||
        !Array.isArray(manifest.layerIds) || !Array.isArray(manifest.frames)) {
      throw new TypeError('Unsupported or invalid PixelForge tiled animation manifest.');
    }
    if (!Number.isInteger(manifest.fps) || manifest.fps < 1 || manifest.fps > 60 ||
        manifest.frames.length < 1 || manifest.frames.length > 240 ||
        !Number.isInteger(manifest.activeFrameIndex) || manifest.activeFrameIndex < 0 ||
        manifest.activeFrameIndex >= manifest.frames.length) {
      throw new RangeError('Tiled animation timeline metadata is outside supported limits.');
    }
    if (!manifest.layerIds.length || manifest.layerIds.length > 64 ||
        manifest.layerIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 180) ||
        new Set(manifest.layerIds).size !== manifest.layerIds.length) {
      throw new TypeError('Tiled animation layer IDs must be valid and unique.');
    }
    const frameIds = new Set();
    const store = new SparseTileCelStore({ maxDecodedCacheBytes });
    const frames = [];
    try {
      for (const frame of manifest.frames) {
        if (!frame || typeof frame.id !== 'string' || !frame.id.trim() || frame.id.length > 180 ||
            frameIds.has(frame.id) || !Number.isFinite(frame.durationMs) ||
            frame.durationMs < 1 || frame.durationMs > 10000 ||
            !Array.isArray(frame.cels) || frame.cels.length !== manifest.layerIds.length) {
          throw new TypeError('Tiled animation frame metadata is invalid.');
        }
        frameIds.add(frame.id);
        const cels = new Map();
        const authoringMode = normalizeAuthoringMode(frame.authoringMode);
        const layerMetadata = {};
        const restoredFrame = { id: frame.id, durationMs: frame.durationMs, authoringMode, cels, layerMetadata };
        frames.push(restoredFrame);
        for (const entry of frame.cels) {
          if (!entry || !manifest.layerIds.includes(entry.layerId) || cels.has(entry.layerId) ||
              !entry.cel || entry.cel.width !== manifest.width || entry.cel.height !== manifest.height) {
            throw new TypeError('Tiled animation cel references do not match the project geometry/layers.');
          }
          const celId = await store.createCel(entry.cel);
          cels.set(entry.layerId, celId);
          layerMetadata[entry.layerId] = normalizeCelMetadata(entry.metadata, authoringMode);
        }
        if (cels.size !== manifest.layerIds.length) throw new TypeError('Tiled animation frame is missing a layer cel.');
      }
      return new TiledAnimationDocument({
        store, width: manifest.width, height: manifest.height, fps: manifest.fps,
        layerIds: manifest.layerIds, frames, activeFrameIndex: manifest.activeFrameIndex,
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
    return Object.freeze({ id: frame.id, durationMs: frame.durationMs, authoringMode: frame.authoringMode, index });
  }

  getLayerMetadata(frameIndex, layerId) {
    const frame = this.#frame(frameIndex);
    this.#cel(frame, layerId);
    return normalizeCelMetadata(frame.layerMetadata[layerId], frame.authoringMode);
  }

  setLayerMetadata(frameIndex, layerId, metadata) {
    const frame = this.#frame(frameIndex);
    this.#cel(frame, layerId);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new TypeError('Tiled animation cel metadata must be an object.');
    }
    frame.layerMetadata[layerId] = normalizeCelMetadata(metadata, frame.authoringMode);
    return this.getLayerMetadata(frameIndex, layerId);
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
      authoringMode: source.authoringMode,
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
          metadata: normalizeCelMetadata(frame.layerMetadata[layerId], frame.authoringMode),
        });
      }
      frames.push({ id: frame.id, durationMs: frame.durationMs, authoringMode: frame.authoringMode, cels });
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
