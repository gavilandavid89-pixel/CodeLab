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
import { guardStyleOwnedPixels } from './raster-style-ownership.mjs';

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
  #thumbnailCache = new Map();

  constructor({ store, width, height, fps, layerIds, frames, activeFrameIndex = 0 }) {
    if (!(store instanceof SparseTileCelStore)) throw new TypeError('A SparseTileCelStore is required.');
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new RangeError('Tiled animation dimensions must be positive integers.');
    }
    if (!Array.isArray(layerIds) || !layerIds.length || new Set(layerIds).size !== layerIds.length) {
      throw new TypeError('Tiled animation requires unique layer IDs.');
    }
    if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw new RangeError('Animation FPS must be an integer between 1 and 60.');
    if (!Array.isArray(frames) || !frames.length || frames.length > 240) throw new TypeError('Tiled animation requires 1–240 frames.');
    if (!Number.isInteger(activeFrameIndex) || activeFrameIndex < 0 || activeFrameIndex >= frames.length) {
      throw new RangeError('Active animation frame index is outside the timeline.');
    }
    const frameIds = new Set();
    for (const frame of frames) {
      if (!frame || typeof frame.id !== 'string' || !frame.id.trim() || frameIds.has(frame.id) ||
          !Number.isFinite(frame.durationMs) || frame.durationMs < 1 || frame.durationMs > 10000 ||
          !(frame.cels instanceof Map) || frame.cels.size !== layerIds.length ||
          layerIds.some(layerId => !frame.cels.has(layerId))) {
        throw new TypeError('Tiled animation frame metadata and cel references are invalid.');
      }
      frameIds.add(frame.id);
      for (const layerId of layerIds) {
        const geometry = store.getCelDimensions(frame.cels.get(layerId));
        if (geometry.width !== width || geometry.height !== height) throw new RangeError('Animation frame cel geometry does not match the timeline.');
      }
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
            ownershipTiles: animation.getLayerOwnershipTiles?.(frameIndex, layerId),
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

  static async fromManifest(manifest, { maxDecodedCacheBytes = 8 * 1024 * 1024, store: sharedStore = null } = {}) {
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
    const store = sharedStore || new SparseTileCelStore({ maxDecodedCacheBytes });
    if (!(store instanceof SparseTileCelStore)) throw new TypeError('A SparseTileCelStore is required.');
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

  static fromTiledProjectDocument(document, { fps = 12 } = {}) {
    if (!document?.isTiled || typeof document.createAnimationBridgeSeed !== 'function') {
      throw new TypeError('A tiled raster project document is required.');
    }
    const seed = document.createAnimationBridgeSeed();
    const frame = seed.frames[0];
    frame.durationMs = Math.max(1, Math.min(10000, 1000 / fps));
    return new TiledAnimationDocument({ ...seed, fps, activeFrameIndex: 0 });
  }

  get width() { return this.#width; }
  get height() { return this.#height; }
  get fps() { return this.#fps; }
  get frameCount() { return this.#frames.length; }
  get activeFrameIndex() { return this.#activeFrameIndex; }
  get activeFrame() { return this.getFrame(this.#activeFrameIndex); }
  get layerIds() { return [...this.#layerIds]; }
  get stats() { return this.#store.stats; }
  get totalDurationMs() { return this.#frames.reduce((sum, frame) => sum + frame.durationMs, 0); }
  get store() { return this.#store; }

  getFrame(index) {
    assertFrameIndex(index, this.#frames.length);
    const frame = this.#frames[index];
    return Object.freeze({ id: frame.id, durationMs: frame.durationMs, authoringMode: frame.authoringMode, index });
  }

  setFrameAuthoringMode(frameIndex, mode) {
    if (!VALID_DRAWING_MODES.includes(mode)) throw new RangeError('Unsupported frame authoring mode.');
    const frame = this.#frame(frameIndex);
    frame.authoringMode = mode;
    for (const layerId of this.#layerIds) {
      const metadata = frame.layerMetadata[layerId] || {};
      if (!VALID_DRAWING_MODES.includes(metadata.authoringMode)) {
        frame.layerMetadata[layerId] = normalizeCelMetadata(metadata, mode);
      }
    }
    return this.getFrame(frameIndex);
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
    this.#thumbnailCache.delete(frame.id);
    return this.getLayerMetadata(frameIndex, layerId);
  }

  releaseCelReference(celId) { return this.#store.releaseCel(celId); }

  getFrameCelReference(frameIndex, layerId) {
    const frame = this.#frame(frameIndex);
    return this.#store.cloneCel(this.#cel(frame, layerId));
  }

  replaceFrameCelReference(frameIndex, layerId, celId, { takeOwnership = false } = {}) {
    const frame = this.#frame(frameIndex);
    const previous = this.#cel(frame, layerId);
    const next = takeOwnership ? celId : this.#store.cloneCel(celId);
    if (typeof next !== 'string' || next === previous) {
      if (takeOwnership && next === previous) return false;
      throw new TypeError('A distinct sparse cel reference is required.');
    }
    const geometry = this.#store.getCelDimensions(next);
    if (geometry.width !== this.#width || geometry.height !== this.#height) throw new RangeError('Replacement animation cel geometry does not match the timeline.');
    frame.cels.set(layerId, next);
    this.#store.releaseCel(previous);
    this.#thumbnailCache.delete(frame.id);
    return true;
  }

  getOnionSkinFrames({ previous = 1, next = 0 } = {}) {
    if (!Number.isInteger(previous) || previous < 0 || previous > 3 || !Number.isInteger(next) || next < 0 || next > 3) {
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

  frameIndexAtTime(elapsedMs, { loop = true } = {}) {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || typeof loop !== 'boolean') throw new RangeError('Playback time must be non-negative.');
    const total = this.totalDurationMs;
    const time = loop ? elapsedMs % total : Math.min(elapsedMs, Math.max(0, total - 1));
    let cursor = 0;
    for (let index = 0; index < this.#frames.length; index++) {
      cursor += this.#frames[index].durationMs;
      if (time < cursor) return index;
    }
    return this.#frames.length - 1;
  }

  compositeRegion(frameIndex, region, layerSettings = null) {
    const frame = this.#frame(frameIndex);
    const settings = new Map();
    if (layerSettings !== null) {
      if (!Array.isArray(layerSettings) || layerSettings.length !== this.#layerIds.length) throw new TypeError('Composite layer settings must match the animation layer stack.');
      for (const layer of layerSettings) {
        if (!layer || !this.#layerIds.includes(layer.id) || settings.has(layer.id) ||
            (layer.visible !== undefined && typeof layer.visible !== 'boolean') ||
            (layer.opacity !== undefined && (!Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1))) {
          throw new TypeError('Composite layer settings contain invalid metadata.');
        }
        settings.set(layer.id, { visible: layer.visible !== false, opacity: layer.opacity ?? 1 });
      }
      if (settings.size !== this.#layerIds.length) throw new TypeError('Composite settings are missing a raster layer.');
    }
    const output = new Uint8ClampedArray(region.width * region.height * 4);
    for (const layerId of this.#layerIds) {
      const layer = settings.get(layerId) ?? { visible: true, opacity: 1 };
      if (!layer.visible || layer.opacity <= 0) continue;
      const source = this.#store.readRegion(this.#cel(frame, layerId), region);
      for (let i = 0; i < source.length; i += 4) {
        const alpha = source[i + 3] / 255 * layer.opacity;
        if (alpha <= 0) continue;
        const dstAlpha = output[i + 3] / 255, outAlpha = alpha + dstAlpha * (1 - alpha);
        const dstWeight = dstAlpha * (1 - alpha);
        output[i] = Math.round((source[i] * alpha + output[i] * dstWeight) / outAlpha);
        output[i + 1] = Math.round((source[i + 1] * alpha + output[i + 1] * dstWeight) / outAlpha);
        output[i + 2] = Math.round((source[i + 2] * alpha + output[i + 2] * dstWeight) / outAlpha);
        output[i + 3] = Math.round(outAlpha * 255);
      }
    }
    return { ...region, pixels: output };
  }

  compositeThumbnail(frameIndex, layerSettings = null, size = 48) {
    if (!Number.isInteger(size) || size < 1 || size > 256) throw new RangeError('Thumbnail size must be 1–256 pixels.');
    const frame = this.#frame(frameIndex);
    const cacheKey = frame.id + ':' + size + ':' + JSON.stringify(layerSettings);
    const cached = this.#thumbnailCache.get(cacheKey);
    if (cached) return { width: cached.width, height: cached.height, pixels: new Uint8ClampedArray(cached.pixels) };
    const scale = Math.min(size / this.#width, size / this.#height);
    const width = Math.max(1, Math.round(this.#width * scale));
    const height = Math.max(1, Math.round(this.#height * scale));
    const pixels = new Uint8ClampedArray(width * height * 4);
    const xs = Array.from({ length: width }, (_, x) => Math.min(this.#width - 1, Math.floor((x + .5) * this.#width / width)));
    for (let y = 0; y < height; y++) {
      const sourceY = Math.min(this.#height - 1, Math.floor((y + .5) * this.#height / height));
      const row = this.compositeRegion(frameIndex, { x: 0, y: sourceY, width: this.#width, height: 1 }, layerSettings).pixels;
      for (let x = 0; x < width; x++) {
        const source = xs[x] * 4, target = (y * width + x) * 4;
        pixels.set(row.subarray(source, source + 4), target);
      }
    }
    this.#thumbnailCache.set(cacheKey, { width, height, pixels: new Uint8ClampedArray(pixels) });
    return { width, height, pixels };
  }

  readRegion(frameIndex, layerId, region) {
    const frame = this.#frame(frameIndex);
    return this.#store.readRegion(this.#cel(frame, layerId), region);
  }

  readOwnershipRegion(frameIndex, layerId, region) {
    const frame = this.#frame(frameIndex);
    return this.#store.readOwnershipRegion(this.#cel(frame, layerId), region);
  }

  async writeRegion(frameIndex, layerId, region, pixels, { authoringMode, operation = 'draw', restore = false, owners: ownerSnapshot = null } = {}) {
    const frame = this.#frame(frameIndex);
    const previousCelId = this.#cel(frame, layerId);
    let result;
    if (restore) {
      if (!(ownerSnapshot instanceof Uint8Array) &&
          this.#store.readOwnershipRegion(previousCelId, region).some(owner => owner !== 0)) {
        throw new TypeError('Restoring an owned animation cel region requires its exact owner snapshot.');
      }
      result = ownerSnapshot instanceof Uint8Array
        ? await this.#store.writeRegionWithOwnership(previousCelId, region, pixels, ownerSnapshot)
        : await this.#store.writeRegion(previousCelId, region, pixels);
    } else {
      const before = this.#store.readRegion(previousCelId, region);
      const owners = this.#store.readOwnershipRegion(previousCelId, region);
      const mode = authoringMode ?? frame.layerMetadata?.[layerId]?.authoringMode ?? frame.authoringMode;
      const guarded = guardStyleOwnedPixels({ before, after: pixels, owners, authoringMode: mode, operation });
      if (!guarded.changedPixels && guarded.owners.every((value, index) => value === owners[index])) {
        return { changed: false, celId: previousCelId, changedTiles: 0, blockedPixels: guarded.blockedPixels, changedPixels: 0 };
      }
      result = await this.#store.writeRegionWithOwnership(previousCelId, region, guarded.pixels, guarded.owners);
      result.blockedPixels = guarded.blockedPixels;
      result.changedPixels = guarded.changedPixels;
    }
    if (result.changed) { frame.cels.set(layerId, result.celId); this.#store.releaseCel(previousCelId); this.#thumbnailCache.delete(frame.id); }
    return { changed: result.changed, celId: result.celId, changedTiles: result.changedTiles, removedTiles: result.removedTiles, blockedPixels: result.blockedPixels || 0, changedPixels: result.changedPixels || 0 };
  }

  createBlankFrame({ afterIndex = this.#activeFrameIndex, durationMs = 100, authoringMode } = {}) {
    if (!Number.isInteger(afterIndex) || afterIndex < -1 || afterIndex >= this.#frames.length) {
      throw new RangeError('Frame insertion index is outside the timeline.');
    }
    if (this.#frames.length >= 240) throw new RangeError('A tiled animation cannot exceed 240 frames.');
    if (!Number.isFinite(durationMs) || durationMs < 1 || durationMs > 10000) {
      throw new RangeError('Frame duration must be between 1 and 10000 ms.');
    }
    const mode = normalizeAuthoringMode(authoringMode, this.#frames[this.#activeFrameIndex].authoringMode);
    const cels = new Map();
    try {
      for (const layerId of this.#layerIds) {
        cels.set(layerId, this.#store.createBlankCel({
          width: this.#width, height: this.#height,
          tileSize: this.#store.getCelTileSize(this.#frames[this.#activeFrameIndex].cels.get(layerId)),
        }));
      }
      const layerMetadata = Object.fromEntries(this.#layerIds.map(layerId => [
        layerId, normalizeCelMetadata({ authoringMode: mode }, mode),
      ]));
      const frame = { id: crypto.randomUUID(), durationMs, authoringMode: mode, layerMetadata, cels };
      this.#frames.splice(afterIndex + 1, 0, frame);
      this.#activeFrameIndex = afterIndex + 1;
      this.#thumbnailCache.clear();
      return this.getFrame(this.#activeFrameIndex);
    } catch (error) {
      for (const celId of cels.values()) this.#store.releaseCel(celId);
      throw error;
    }
  }

  moveFrame(fromIndex, toIndex) {
    assertFrameIndex(fromIndex, this.#frames.length);
    assertFrameIndex(toIndex, this.#frames.length);
    if (fromIndex === toIndex) return this.getFrame(this.#activeFrameIndex);
    const [frame] = this.#frames.splice(fromIndex, 1);
    this.#frames.splice(toIndex, 0, frame);
    this.#thumbnailCache.clear();
    if (this.#activeFrameIndex === fromIndex) this.#activeFrameIndex = toIndex;
    else if (fromIndex < this.#activeFrameIndex && toIndex >= this.#activeFrameIndex) this.#activeFrameIndex--;
    else if (fromIndex > this.#activeFrameIndex && toIndex <= this.#activeFrameIndex) this.#activeFrameIndex++;
    return this.getFrame(this.#activeFrameIndex);
  }

  setFps(fps) {
    if (!Number.isInteger(fps) || fps < 1 || fps > 60) {
      throw new RangeError('Animation FPS must be an integer between 1 and 60.');
    }
    this.#fps = fps;
    const durationMs = Math.max(1, Math.min(10000, 1000 / fps));
    for (const frame of this.#frames) frame.durationMs = durationMs;
    return fps;
  }

  addLayer(layerId, { activeCelId, copyFromLayerId = null, metadata = {}, orphanFrames = null } = {}) {
    if (typeof layerId !== 'string' || !layerId.trim() || this.#layerIds.includes(layerId)) throw new TypeError('A new unique animation layer ID is required.');
    if (this.#layerIds.length >= 64) throw new RangeError('A tiled animation cannot exceed 64 layers.');
    if (!activeCelId) throw new TypeError('The active frame cel reference is required.');
    if (copyFromLayerId !== null && !this.#layerIds.includes(copyFromLayerId)) throw new Error('Unknown source animation layer ID.');
    const created = [];
    try {
      const activeGeometry = this.#store.getCelDimensions(activeCelId);
      if (activeGeometry.width !== this.#width || activeGeometry.height !== this.#height) throw new RangeError('New animation layer cel geometry does not match the timeline.');
      for (let index = 0; index < this.#frames.length; index++) {
        const frame = this.#frames[index], orphan = orphanFrames?.get(frame.id);
        let celId, retainedOrphan = false;
        if (index === this.#activeFrameIndex) celId = activeCelId;
        else if (orphan?.celId) {
          celId = orphan.celId; retainedOrphan = true;
          const geometry = this.#store.getCelDimensions(celId);
          if (geometry.width !== this.#width || geometry.height !== this.#height) throw new RangeError('Orphan animation cel geometry does not match the timeline.');
        }
        else if (copyFromLayerId) celId = this.#store.cloneCel(this.#cel(frame, copyFromLayerId));
        else celId = this.#store.createBlankCel({ width: this.#width, height: this.#height, tileSize: this.#store.getCelTileSize(this.#cel(frame, this.#layerIds[0])) });
        created.push({ frame, celId, retainedOrphan, orphan });
      }
      this.#layerIds.push(layerId);
      this.#thumbnailCache.clear();
      for (const { frame, celId, orphan } of created) {
        frame.cels.set(layerId, celId);
        const source = orphan?.metadata || (copyFromLayerId ? frame.layerMetadata[copyFromLayerId] : null);
        frame.layerMetadata[layerId] = normalizeCelMetadata({ ...(source || metadata), ...metadata, id: layerId }, frame.authoringMode);
      }
      for (const { frame, orphan } of created) if (orphan?.celId) {
        if (frame === this.#frames[this.#activeFrameIndex] && orphan.celId !== activeCelId) this.#store.releaseCel(orphan.celId);
        orphan.celId = null;
      }
      return this.#layerIds.length;
    } catch (error) {
      for (const { celId, retainedOrphan } of created) if (!retainedOrphan) this.#store.releaseCel(celId);
      if (!created.some(item => item.celId === activeCelId)) this.#store.releaseCel(activeCelId);
      throw error;
    }
  }

  removeLayer(layerId) {
    if (!this.#layerIds.includes(layerId)) throw new Error('Unknown animation layer ID.');
    if (this.#layerIds.length <= 1) throw new RangeError('A tiled animation must retain at least one raster layer.');
    const frames = this.#frames.map(frame => {
      const celId = frame.cels.get(layerId), metadata = structuredClone(frame.layerMetadata[layerId] || {});
      frame.cels.delete(layerId); delete frame.layerMetadata[layerId];
      return { frameId: frame.id, celId, metadata };
    });
    this.#layerIds = this.#layerIds.filter(id => id !== layerId);
    this.#thumbnailCache.clear();
    return { layerId, frames };
  }

  reorderLayers(layerIds) {
    if (!Array.isArray(layerIds) || layerIds.length !== this.#layerIds.length ||
        new Set(layerIds).size !== layerIds.length || this.#layerIds.some(id => !layerIds.includes(id))) {
      throw new TypeError('Layer reordering must preserve all tiled animation layer IDs.');
    }
    if (layerIds.every((id, index) => id === this.#layerIds[index])) return false;
    for (const frame of this.#frames) {
      frame.cels = new Map(layerIds.map(id => [id, frame.cels.get(id)]));
      frame.layerMetadata = Object.fromEntries(layerIds.map(id => [id, frame.layerMetadata[id]]));
    }
    this.#layerIds = [...layerIds];
    this.#thumbnailCache.clear();
    return true;
  }

  cloneFrame(index, { afterIndex = index } = {}) {
    assertFrameIndex(index, this.#frames.length);
    if (!Number.isInteger(afterIndex) || afterIndex < -1 || afterIndex >= this.#frames.length) {
      throw new RangeError('Frame insertion index is outside the timeline.');
    }
    if (this.#frames.length >= 240) throw new RangeError('A tiled animation cannot exceed 240 frames.');
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
    this.#thumbnailCache.clear();
    return this.getFrame(this.#activeFrameIndex);
  }

  deleteFrame(index) {
    if (this.#frames.length <= 1) throw new RangeError('A tiled animation must retain at least one frame.');
    const frame = this.#frame(index);
    for (const celId of frame.cels.values()) this.#store.releaseCel(celId);
    this.#frames.splice(index, 1);
    this.#thumbnailCache.clear();
    if (index < this.#activeFrameIndex) this.#activeFrameIndex--;
    else if (index === this.#activeFrameIndex) this.#activeFrameIndex = Math.min(index, this.#frames.length - 1);
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
          metadata: normalizeCelMetadata(frame.layerMetadata[layerId], frame.authoringMode),
        });
      }
      frames.push({ id: frame.id, durationMs: frame.durationMs, authoringMode: frame.authoringMode, cels });
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
    this.#thumbnailCache.clear();
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
