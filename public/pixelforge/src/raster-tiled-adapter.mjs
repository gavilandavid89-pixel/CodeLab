/**
 * Tile-backed project-layer migration adapter.
 * Keeps the legacy RasterDocument untouched while establishing a lossless
 * project manifest for layer metadata and sparse RGBA cel resources.
 */
import { SparseTileCelStore, DEFAULT_CEL_TILE_SIZE } from './animation-tiles.mjs';
import { TiledRasterStrokeHistory } from './raster-tiled-history.mjs';
import { normalizeDrawingConfiguration, switchDrawingMode as switchProjectDrawingMode, PIXELFORGE_DRAWING_MODES } from './drawing-mode-config.mjs';
import { guardStyleOwnedPixels } from './raster-style-ownership.mjs';

export const PIXELFORGE_TILED_PROJECT_FORMAT = 'pixelforge-tiled-project';
export const PIXELFORGE_TILED_PROJECT_VERSION = 1;
const MAX_LAYERS = 64;
const MAX_CANVAS_SIDE = 4096;
const MAX_CANVAS_AREA = 16_777_216;

function encodeBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function validateGeometry(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE || width * height > MAX_CANVAS_AREA) {
    throw new RangeError('Tiled project canvas dimensions are outside PixelForge limits.');
  }
}

function normalizeRegion(region, width, height) {
  if (!region || !Number.isInteger(region.x) || !Number.isInteger(region.y) ||
      !Number.isInteger(region.width) || !Number.isInteger(region.height) ||
      region.width < 1 || region.height < 1 ||
      region.x < 0 || region.y < 0 ||
      region.x + region.width > width || region.y + region.height > height) {
    throw new RangeError('Tiled project region is outside canvas bounds.');
  }
  return {
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height,
  };
}

function normalizeLayer(layer, fallbackMode = PIXELFORGE_DRAWING_MODES.PIXEL_ART) {
  if (!layer || typeof layer.id !== 'string' || !layer.id.trim() || layer.id.length > 180 ||
      typeof layer.name !== 'string' || !layer.name.trim() || layer.name.length > 180 ||
      typeof layer.visible !== 'boolean' || typeof layer.locked !== 'boolean' ||
      !Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1) {
    throw new TypeError('Tiled project layer metadata is invalid.');
  }
  return {
    id: layer.id, name: layer.name, visible: layer.visible,
    opacity: layer.opacity, locked: layer.locked,
    x: Number.isFinite(layer.x) ? layer.x : 0,
    y: Number.isFinite(layer.y) ? layer.y : 0,
    scaleX: Number.isFinite(layer.scaleX) ? layer.scaleX : 1,
    scaleY: Number.isFinite(layer.scaleY) ? layer.scaleY : 1,
    rotation: Number.isFinite(layer.rotation) ? layer.rotation : 0,
    angle: Number.isFinite(layer.angle) ? layer.angle : 0,
    blendMode: typeof layer.blendMode === 'string' ? layer.blendMode : 'normal',
    blur: Number.isFinite(layer.blur) ? layer.blur : 0,
    brightness: Number.isFinite(layer.brightness) ? layer.brightness : 0,
    contrast: Number.isFinite(layer.contrast) ? layer.contrast : 0,
    saturation: Number.isFinite(layer.saturation) ? layer.saturation : 0,
    mask: layer.mask ?? null,
    clipping: layer.clipping ?? null,
    references: structuredClone(layer.references || []),
    assets: structuredClone(layer.assets || []),
    authoringMode: Object.values(PIXELFORGE_DRAWING_MODES).includes(layer.authoringMode) ? layer.authoringMode : fallbackMode,
    modeOverrides: structuredClone(layer.modeOverrides || {}),
    metadata: structuredClone(layer.metadata || {}),
  };
}

export class TiledRasterProjectDocument {
  #store;
  #layers;
  #width;
  #height;
  #id;
  #name;
  #activeLayerId;
  #drawingConfiguration;
  #projectMetadata;
  #strokeHistory;
  #revision;
  #saveVersion;
  #serverRevision;
  #dirty;
  #drawingModel;
  #vectorModel;
  #selectionMask = null;

  constructor({
    store, id, name, width, height, layers, activeLayerId, drawingConfiguration,
    projectMetadata = {}, revision = 0, saveVersion = 0, serverRevision = 0,
    dirty = false, drawingModel, vectorModel = null,
  }) {
    if (!(store instanceof SparseTileCelStore)) throw new TypeError('A SparseTileCelStore is required.');
    validateGeometry(width, height);
    if (typeof id !== 'string' || !id.trim() || typeof name !== 'string' || !name.trim()) {
      throw new TypeError('Tiled project identity and name are required.');
    }
    if (!Array.isArray(layers) || !layers.length || layers.length > MAX_LAYERS) {
      throw new RangeError('Tiled project must contain 1–64 raster layers.');
    }
    const normalizedDrawingConfiguration = normalizeDrawingConfiguration(drawingConfiguration);
    const normalized = layers.map(layer => ({ ...normalizeLayer(layer, normalizedDrawingConfiguration.activeMode), celId: layer.celId }));
    if (new Set(normalized.map(layer => layer.id)).size !== normalized.length ||
        normalized.some(layer => typeof layer.celId !== 'string' || !layer.celId)) {
      throw new TypeError('Tiled project layer IDs and cel references must be unique and valid.');
    }
    if (!normalized.some(layer => layer.id === activeLayerId)) {
      throw new TypeError('Tiled project active layer must reference an existing layer.');
    }
    this.#store = store;
    this.#id = id;
    this.#name = name;
    this.#width = width;
    this.#height = height;
    this.#layers = normalized;
    this.#activeLayerId = activeLayerId;
    this.#drawingConfiguration = normalizedDrawingConfiguration;
    if (!projectMetadata || typeof projectMetadata !== 'object' || Array.isArray(projectMetadata)) {
      throw new TypeError('Tiled project metadata must be an object.');
    }
    this.#projectMetadata = structuredClone(projectMetadata);
    this.#revision = Number.isInteger(revision) && revision >= 0 ? revision : 0;
    this.#saveVersion = Number.isInteger(saveVersion) && saveVersion >= 0 ? saveVersion : 0;
    this.#serverRevision = Number.isInteger(serverRevision) && serverRevision >= 0 ? serverRevision : 0;
    this.#dirty = Boolean(dirty);
    this.#drawingModel = structuredClone(drawingModel ?? projectMetadata.drawingModel ?? {});
    this.#vectorModel = vectorModel === null ? structuredClone(projectMetadata.vectorModel ?? null) : structuredClone(vectorModel);
    this.#strokeHistory = new TiledRasterStrokeHistory(this);
  }

  /**
   * Create a native blank tiled project. Unlike fromDocument(), this path never
   * constructs or serializes a dense RasterDocument and is safe for large sparse
   * canvases within the current geometry/layer limits.
   */
  static createBlank({
    width = 128,
    height = 128,
    id = globalThis.crypto?.randomUUID?.(),
    name = 'Untitled artwork',
    layerName = 'Layer 1',
    layerId = globalThis.crypto?.randomUUID?.(),
    tileSize = DEFAULT_CEL_TILE_SIZE,
    maxDecodedCacheBytes = 16 * 1024 * 1024,
    drawingConfiguration,
    projectMetadata = {},
    revision = 0,
    saveVersion = 0,
    serverRevision = 0,
    dirty = false,
    drawingModel,
    vectorModel = null,
  } = {}) {
    validateGeometry(width, height);
    if (!id || !layerId) throw new Error('Secure UUID generation is required for tiled project identity.');
    const store = new SparseTileCelStore({ maxDecodedCacheBytes });
    const celId = store.createBlankCel({ width, height, tileSize });
    try {
      return new TiledRasterProjectDocument({
        store, id, name, width, height,
        layers: [{
          id: layerId, name: layerName, visible: true, opacity: 1, locked: false, celId,
        }],
        activeLayerId: layerId,
        drawingConfiguration,
        projectMetadata, revision, saveVersion, serverRevision, dirty, drawingModel, vectorModel,
      });
    } catch (error) {
      store.releaseCel(celId);
      throw error;
    }
  }

  static async fromDocument(document, {
    tileSize = DEFAULT_CEL_TILE_SIZE,
    maxDecodedCacheBytes = 16 * 1024 * 1024,
    drawingConfiguration,
  } = {}) {
    if (!document || !Array.isArray(document.layers) || typeof document.toJSON !== 'function') {
      throw new TypeError('fromDocument requires a RasterDocument-compatible source.');
    }
    validateGeometry(document.width, document.height);
    const sourceSnapshot = document.toJSON();
    const sourceDrawingConfiguration = normalizeDrawingConfiguration(drawingConfiguration ?? sourceSnapshot.drawingConfiguration);
    const { layers: _sourceLayers, ...projectMetadata } = sourceSnapshot;
    const store = new SparseTileCelStore({ maxDecodedCacheBytes });
    const layers = [];
    try {
      for (const layer of document.layers) {
        const celId = await store.createCelFromPixels(layer.pixels, {
          width: document.width, height: document.height, tileSize,
        });
        layers.push({ ...normalizeLayer(layer, sourceDrawingConfiguration.activeMode), celId });
      }
      return new TiledRasterProjectDocument({
        store, id: document.id, name: document.name, width: document.width, height: document.height,
        layers, activeLayerId: document.activeLayerId,
        drawingConfiguration: sourceDrawingConfiguration,
        projectMetadata,
        revision: document.revision, saveVersion: document.saveVersion,
        serverRevision: document.serverRevision, dirty: document.dirty,
        drawingModel: sourceSnapshot.drawingModel, vectorModel: sourceSnapshot.vectorModel,
      });
    } catch (error) {
      for (const layer of layers) store.releaseCel(layer.celId);
      throw error;
    }
  }

  static async fromManifest(manifest, { maxDecodedCacheBytes = 16 * 1024 * 1024, newIdentity = false } = {}) {
    if (!manifest || manifest.format !== PIXELFORGE_TILED_PROJECT_FORMAT ||
        manifest.version !== PIXELFORGE_TILED_PROJECT_VERSION) {
      throw new TypeError('Unsupported PixelForge tiled project manifest.');
    }
    validateGeometry(manifest.width, manifest.height);
    if (!Array.isArray(manifest.layers) || !manifest.layers.length || manifest.layers.length > MAX_LAYERS) {
      throw new RangeError('Tiled project manifest must contain 1–64 layers.');
    }
    const store = new SparseTileCelStore({ maxDecodedCacheBytes });
    const layers = [];
    try {
      for (const entry of manifest.layers) {
        const metadata = normalizeLayer(entry);
        if (!entry.cel || entry.cel.width !== manifest.width || entry.cel.height !== manifest.height) {
          throw new TypeError('Tiled project cel geometry does not match its canvas.');
        }
        const celId = await store.createCel(entry.cel);
        layers.push({ ...metadata, celId });
      }
      return new TiledRasterProjectDocument({
        store, id: manifest.id, name: manifest.name, width: manifest.width, height: manifest.height,
        layers, activeLayerId: manifest.activeLayerId, drawingConfiguration: manifest.drawingConfiguration,
        projectMetadata: manifest.projectMetadata || {},
        revision: newIdentity ? 0 : manifest.revision, saveVersion: newIdentity ? 0 : manifest.saveVersion,
        serverRevision: newIdentity ? 0 : manifest.serverRevision, dirty: newIdentity,
        drawingModel: manifest.drawingModel, vectorModel: manifest.vectorModel,
      });
    } catch (error) {
      for (const layer of layers) store.releaseCel(layer.celId);
      throw error;
    }
  }

  get isTiled() { return true; }
  get id() { return this.#id; }
  set id(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new TypeError('Document ID is invalid.');
    if (this.#id !== value) {
      this.#id = value;
      this.#revision = 0;
      this.#saveVersion = 0;
      this.#serverRevision = 0;
      this.#dirty = true;
    }
  }
  get name() { return this.#name; }
  set name(value) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 180) throw new TypeError('Document name must contain 1–180 characters.');
    if (this.#name !== value.trim()) { this.#name = value.trim(); this.#markChanged(); }
  }
  get width() { return this.#width; }
  get height() { return this.#height; }
  get activeLayerId() { return this.#activeLayerId; }
  get activeLayer() { return this.#cel(this.#activeLayerId); }
  get drawingConfiguration() { return structuredClone(this.#drawingConfiguration); }
  set drawingConfiguration(value) { this.#drawingConfiguration = normalizeDrawingConfiguration(value); this.#markChanged(); }
  get revision() { return this.#revision; }
  set revision(value) { if (!Number.isInteger(value) || value < 0) throw new RangeError('Revision must be a non-negative integer.'); this.#revision = value; }
  get saveVersion() { return this.#saveVersion; }
  set saveVersion(value) { if (!Number.isInteger(value) || value < 0) throw new RangeError('Save version must be a non-negative integer.'); this.#saveVersion = value; }
  get serverRevision() { return this.#serverRevision; }
  set serverRevision(value) { if (!Number.isInteger(value) || value < 0) throw new RangeError('Server revision must be a non-negative integer.'); this.#serverRevision = value; }
  get dirty() { return this.#dirty; }
  set dirty(value) { this.#dirty = Boolean(value); }
  get drawingModel() { return structuredClone(this.#drawingModel); }
  set drawingModel(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Drawing model must be an object.');
    if (JSON.stringify(this.#drawingModel) !== JSON.stringify(value)) {
      this.#drawingModel = structuredClone(value); this.#markChanged();
    }
  }
  get selectionMask() { return this.#selectionMask; }
  set selectionMask(value) { this.setSelectionMask(value); }
  get strokeHistory() { return this.#strokeHistory; }
  get history() { return this.#strokeHistory.undoStack; }
  set history(value) { if (Array.isArray(value) && value.length === 0) this.#strokeHistory.clear(); }
  get future() { return this.#strokeHistory.redoStack; }
  set future(value) { if (Array.isArray(value) && value.length === 0) this.#strokeHistory.clear(); }
  get historyBytes() { return this.#strokeHistory.stats.retainedBytes; }
  set historyBytes(value) { if (value === 0) this.#strokeHistory.clear(); }
  /**
   * Switches the editor interpretation without rewriting any cel bytes.
   * Layer authoringMode/modeOverrides remain attached to their original cels,
   * so a later switch back can restore their non-default editing profile.
   */
  switchDrawingMode(mode) {
    const previousMode = this.#drawingConfiguration.activeMode;
    if (previousMode === mode) {
      return { previousMode, activeMode: mode, pixelsChanged: false, celsRewritten: 0, preservedLayerIds: this.layerIds };
    }
    this.#drawingConfiguration = switchProjectDrawingMode(this.#drawingConfiguration, mode);
    this.#markChanged();
    return {
      previousMode,
      activeMode: mode,
      pixelsChanged: false,
      celsRewritten: 0,
      preservedLayerIds: this.layerIds,
    };
  }
  get layerIds() { return this.#layers.map(layer => layer.id); }
  get layers() {
    return this.#layers.map(({ celId, ...layer }) => ({ ...structuredClone(layer), celId }));
  }
  get stats() { return { ...this.#store.stats, history: this.#strokeHistory.stats }; }
  get tileStore() { return this.#store; }

  /** Internal animation bridge: frame cels share this document's immutable tile store. */
  createAnimationBridgeSeed() {
    const frames = [];
    try {
      frames.push({
        id: globalThis.crypto?.randomUUID?.(),
        durationMs: 1000 / 12,
        authoringMode: this.#drawingConfiguration.activeMode,
        layerMetadata: Object.fromEntries(this.#layers.map(layer => {
          const { celId, ...metadata } = layer;
          return [layer.id, structuredClone(metadata)];
        })),
        cels: new Map(this.#layers.map(layer => [layer.id, this.#store.cloneCel(layer.celId)])),
      });
      return { store: this.#store, width: this.#width, height: this.#height, fps: 12, layerIds: this.layerIds, frames };
    } catch (error) {
      for (const frame of frames) for (const celId of frame.cels.values()) this.#store.releaseCel(celId);
      throw error;
    }
  }

  cloneLayerCelReference(layerId) { return this.#store.cloneCel(this.#cel(layerId).celId); }

  replaceLayerCelReferences(references, { takeOwnership = false } = {}) {
    if (!(references instanceof Map) || references.size !== this.#layers.length ||
        this.#layers.some(layer => !references.has(layer.id))) {
      throw new TypeError('Animation frame cel references must match the current raster layer stack.');
    }
    const replacements = [];
    try {
      for (const layer of this.#layers) {
        const sourceCelId = references.get(layer.id);
        const geometry = this.#store.getCelDimensions(sourceCelId);
        if (geometry.width !== this.#width || geometry.height !== this.#height) throw new RangeError('Animation cel geometry does not match the tiled project.');
        replacements.push({ layer, nextCelId: takeOwnership ? sourceCelId : this.#store.cloneCel(sourceCelId) });
      }
    } catch (error) {
      if (!takeOwnership) for (const item of replacements) this.#store.releaseCel(item.nextCelId);
      throw error;
    }
    for (const { layer, nextCelId } of replacements) {
      const previousCelId = layer.celId;
      layer.celId = nextCelId;
      this.#store.releaseCel(previousCelId);
    }
    this.#markChanged();
    return true;
  }

  swapStrokeHistory(nextHistory) {
    if (!nextHistory || typeof nextHistory.undo !== 'function' || typeof nextHistory.redo !== 'function' ||
        typeof nextHistory.dispose !== 'function') throw new TypeError('A compatible tiled stroke history is required.');
    if (nextHistory === this.#strokeHistory) return this.#strokeHistory;
    const previous = this.#strokeHistory;
    this.#strokeHistory = nextHistory;
    return previous;
  }

  createStrokeHistory(options) { return new TiledRasterStrokeHistory(this, options); }
  getVectorModel() { return this.#vectorModel === null ? null : structuredClone(this.#vectorModel); }
  setVectorModel(model) {
    if (model !== null && (!model || typeof model !== 'object' || Array.isArray(model))) throw new TypeError('Vector model must be an object or null.');
    this.#vectorModel = model === null ? null : structuredClone(model);
    this.#markChanged();
    return true;
  }
  setSelectionMask(mask) {
    if (mask !== null && (!(mask instanceof Uint8Array) || mask.length !== this.#width * this.#height)) {
      throw new TypeError('Selection mask must be a Uint8Array matching tiled project dimensions.');
    }
    // Keep the editor-owned transient mask by reference: selection gestures
    // regenerate it frequently, and copying a 16 MiB mask on every pointermove
    // would create avoidable allocation pressure. Callers replace, not mutate,
    // masks after passing them here.
    this.#selectionMask = mask;
  }
  clearHistory() { this.#strokeHistory.clear(); }
  async undo() { return this.#strokeHistory.undo(); }
  async redo() { return this.#strokeHistory.redo(); }
  getCompositeDirtyTiles() { return []; }
  clearCompositeDirtyTiles() {}
  composite() { return this.readCompositeRegion({ x: 0, y: 0, width: this.#width, height: this.#height }).pixels; }
  sampleColorAt(x, y, { merged = true } = {}) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= this.#width || y >= this.#height) {
      throw new RangeError('Sample coordinates are outside the document bounds.');
    }
    const region = { x, y, width: 1, height: 1 };
    const pixel = merged ? this.readCompositeRegion(region).pixels : this.readRegion(this.#activeLayerId, region);
    if (pixel[3] === 0) return null;
    return '#' + [...pixel.subarray(0, 3)].map(channel => channel.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  readRegion(layerId, region) {
    return this.#store.readRegion(this.#cel(layerId).celId, region);
  }

  readOwnershipRegion(layerId, region) {
    return this.#store.readOwnershipRegion(this.#cel(layerId).celId, region);
  }

  async writeRegionWithOwnership(layerId, region, pixels, { authoringMode = this.#drawingConfiguration.activeMode, operation = 'draw' } = {}) {
    const layer = this.#cel(layerId);
    if (layer.locked) throw new Error('The target layer is locked.');
    const previousCelId = layer.celId;
    const before = this.#store.readRegion(previousCelId, region);
    const owners = this.#store.readOwnershipRegion(previousCelId, region);
    const guarded = guardStyleOwnedPixels({ before, after: pixels, owners, authoringMode, operation });
    if (!guarded.changedPixels && guarded.owners.every((value, index) => value === owners[index])) {
      return { changed: false, changedTiles: 0, celId: previousCelId, blockedPixels: guarded.blockedPixels, changedPixels: 0 };
    }
    const result = await this.#store.writeRegionWithOwnership(previousCelId, region, guarded.pixels, guarded.owners);
    if (result.changed) { layer.celId = result.celId; this.#markChanged(); this.#store.releaseCel(previousCelId); }
    return { changed: result.changed, changedTiles: result.changedTiles, celId: result.celId, blockedPixels: guarded.blockedPixels, changedPixels: guarded.changedPixels };
  }

  /**
   * Composite only a bounded viewport-sized region. This is intentionally
   * separate from toLegacyProjectJSON()/composeCel(): callers rendering a
   * zoomed viewport do not need to allocate width × height RGBA storage.
   */
  readCompositeRegion(region) {
    const normalized = normalizeRegion(region, this.#width, this.#height);
    const output = new Uint8ClampedArray(normalized.width * normalized.height * 4);
    for (const layer of this.#layers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      const source = this.#store.readRegion(layer.celId, normalized);
      const opacity = layer.opacity;
      for (let i = 0; i < source.length; i += 4) {
        const alpha = (source[i + 3] / 255) * opacity;
        if (alpha <= 0) continue;
        const dstAlpha = output[i + 3] / 255;
        const outAlpha = alpha + dstAlpha * (1 - alpha);
        if (outAlpha <= 0) continue;
        const dstWeight = dstAlpha * (1 - alpha);
        output[i] = Math.round((source[i] * alpha + output[i] * dstWeight) / outAlpha);
        output[i + 1] = Math.round((source[i + 1] * alpha + output[i + 1] * dstWeight) / outAlpha);
        output[i + 2] = Math.round((source[i + 2] * alpha + output[i + 2] * dstWeight) / outAlpha);
        output[i + 3] = Math.round(outAlpha * 255);
      }
    }
    return { ...normalized, pixels: output };
  }

  get tileSize() { return this.getLayerTileSize(this.#activeLayerId); }
  getLayerTileSize(layerId) { return this.#store.getCelTileSize(this.#cel(layerId).celId); }

  async writeTileBatch(layerId, patches, { allowLocked = false, restore = false, authoringMode = this.#drawingConfiguration.activeMode, ...options } = {}) {
    const layer = this.#cel(layerId);
    if (layer.locked && !allowLocked) throw new Error('The target layer is locked.');
    if (!Array.isArray(patches) || !patches.length) throw new TypeError('Tile batch must contain at least one patch.');
    const tileSize = this.#store.getCelTileSize(layer.celId), seen = new Set();
    const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('Tile batch byte budget must be positive.');
    let batchBytes = 0;
    for (const patch of patches) {
      if (!patch || !Number.isInteger(patch.x) || !Number.isInteger(patch.y) || patch.x < 0 || patch.y < 0 || patch.x % tileSize || patch.y % tileSize || patch.x >= this.#width || patch.y >= this.#height) throw new RangeError('Tile batch contains an invalid tile coordinate.');
      const key = patch.x + ':' + patch.y;
      if (seen.has(key)) throw new TypeError('Tile batch cannot contain duplicate coordinates.');
      seen.add(key);
      const width = Math.min(tileSize, this.#width - patch.x), height = Math.min(tileSize, this.#height - patch.y);
      if (!(patch.pixels instanceof Uint8Array || patch.pixels instanceof Uint8ClampedArray) || patch.pixels.byteLength !== width * height * 4) throw new TypeError('Tile batch pixel buffer does not match its tile dimensions.');
      batchBytes += patch.pixels.byteLength;
      if (batchBytes > maxBytes) throw new RangeError('Tile batch exceeded its byte budget.');
    }
    if (restore) {
      const previousCelId = layer.celId;
      if (!patches.some(patch => patch.owners instanceof Uint8Array)) {
        const result = await this.#store.writeTileBatch(previousCelId, patches, options);
        if (result.changed) { layer.celId = result.celId; this.#markChanged(); this.#store.releaseCel(previousCelId); }
        return { changed: result.changed, changedTiles: result.changedTiles, removedTiles: result.removedTiles, celId: result.celId, blockedPixels: 0 };
      }
      let workingCelId = previousCelId, changedTiles = 0;
      try {
        for (const patch of patches) {
          if (!(patch.owners instanceof Uint8Array)) throw new TypeError('Restoring a mixed-style tile batch requires owner snapshots for every tile.');
          const width = Math.min(this.#store.getCelTileSize(workingCelId), this.#width - patch.x);
          const height = Math.min(this.#store.getCelTileSize(workingCelId), this.#height - patch.y);
          const result = await this.#store.writeRegionWithOwnership(workingCelId, { x: patch.x, y: patch.y, width, height }, patch.pixels, patch.owners);
          if (result.changed) { if (workingCelId !== previousCelId) this.#store.releaseCel(workingCelId); workingCelId = result.celId; changedTiles += result.changedTiles; }
        }
        if (workingCelId === previousCelId) return { changed: false, changedTiles: 0, removedTiles: 0, celId: previousCelId, blockedPixels: 0 };
        layer.celId = workingCelId; this.#markChanged(); this.#store.releaseCel(previousCelId);
        return { changed: true, changedTiles, removedTiles: 0, celId: workingCelId, blockedPixels: 0 };
      } catch (error) { if (workingCelId !== previousCelId) this.#store.releaseCel(workingCelId); throw error; }
    }
    const ownerMode = authoringMode;
    const previousCelId = layer.celId;
    let workingCelId = previousCelId, changedTiles = 0, blockedPixels = 0, changedPixels = 0;
    try {
      for (const patch of patches) {
        const width = Math.min(this.#store.getCelTileSize(workingCelId), this.#width - patch.x);
        const height = Math.min(this.#store.getCelTileSize(workingCelId), this.#height - patch.y);
        const region = { x: patch.x, y: patch.y, width, height };
        const before = this.#store.readRegion(workingCelId, region);
        const owners = this.#store.readOwnershipRegion(workingCelId, region);
        const guarded = guardStyleOwnedPixels({ before, after: patch.pixels, owners, authoringMode: ownerMode, operation: 'draw' });
        blockedPixels += guarded.blockedPixels;
        changedPixels += guarded.changedPixels;
        if (!guarded.changedPixels && guarded.owners.every((value, index) => value === owners[index])) continue;
        const result = await this.#store.writeRegionWithOwnership(workingCelId, region, guarded.pixels, guarded.owners);
        if (result.changed) { if (workingCelId !== previousCelId) this.#store.releaseCel(workingCelId); workingCelId = result.celId; changedTiles += result.changedTiles; }
      }
      if (workingCelId === previousCelId) return { changed: false, changedTiles: 0, removedTiles: 0, celId: previousCelId, blockedPixels, changedPixels: 0 };
      layer.celId = workingCelId; this.#markChanged(); this.#store.releaseCel(previousCelId);
      return { changed: true, changedTiles, removedTiles: 0, celId: workingCelId, blockedPixels, changedPixels };
    } catch (error) { if (workingCelId !== previousCelId) this.#store.releaseCel(workingCelId); throw error; }
  }

  async writeRegion(layerId, region, pixels, { authoringMode = this.#drawingConfiguration.activeMode, operation = 'draw', restore = false, owners: ownerSnapshot = null } = {}) {
    const layer = this.#cel(layerId);
    if (layer.locked) throw new Error('The target layer is locked.');
    const previousCelId = layer.celId;
    if (restore) {
      const result = ownerSnapshot instanceof Uint8Array
        ? await this.#store.writeRegionWithOwnership(previousCelId, region, pixels, ownerSnapshot)
        : await this.#store.writeRegion(previousCelId, region, pixels);
      if (result.changed) { layer.celId = result.celId; this.#markChanged(); this.#store.releaseCel(previousCelId); }
      return { changed: result.changed, changedTiles: result.changedTiles, removedTiles: result.removedTiles, celId: result.celId, blockedPixels: 0 };
    }
    const before = this.#store.readRegion(previousCelId, region);
    const owners = this.#store.readOwnershipRegion(previousCelId, region);
    const guarded = guardStyleOwnedPixels({ before, after: pixels, owners, authoringMode, operation });
    if (!guarded.changedPixels && guarded.owners.every((value, index) => value === owners[index])) return { changed: false, changedTiles: 0, removedTiles: 0, celId: previousCelId, blockedPixels: guarded.blockedPixels, changedPixels: 0 };
    const result = await this.#store.writeRegionWithOwnership(previousCelId, region, guarded.pixels, guarded.owners);
    if (result.changed) { layer.celId = result.celId; this.#markChanged(); this.#store.releaseCel(previousCelId); }
    return { changed: result.changed, changedTiles: result.changedTiles, removedTiles: 0, celId: result.celId, blockedPixels: guarded.blockedPixels, changedPixels: guarded.changedPixels };
  }
  setActiveLayer(layerId) {
    this.#cel(layerId);
    if (this.#activeLayerId !== layerId) {
      this.#activeLayerId = layerId;
      this.#markChanged();
    }
    return layerId;
  }

  captureLayerState() {
    const layers = [];
    try {
      for (const layer of this.#layers) {
        const { celId, ...metadata } = layer;
        layers.push({ ...structuredClone(metadata), celId: this.#store.cloneCel(celId) });
      }
      return { activeLayerId: this.#activeLayerId, layers };
    } catch (error) {
      for (const layer of layers) this.#store.releaseCel(layer.celId);
      throw error;
    }
  }

  releaseLayerState(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.layers)) return;
    for (const layer of snapshot.layers) this.#store.releaseCel(layer.celId);
    snapshot.layers.length = 0;
  }

  restoreLayerState(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.layers) || !snapshot.layers.length ||
        snapshot.layers.length > MAX_LAYERS ||
        !snapshot.layers.some(layer => layer.id === snapshot.activeLayerId)) {
      throw new TypeError('Tiled layer history snapshot is invalid.');
    }
    const restored = [];
    try {
      for (const layer of snapshot.layers) {
        const { celId, ...metadata } = layer;
        restored.push({ ...structuredClone(metadata), celId: this.#store.cloneCel(celId) });
      }
    } catch (error) {
      for (const layer of restored) this.#store.releaseCel(layer.celId);
      throw error;
    }
    for (const layer of this.#layers) this.#store.releaseCel(layer.celId);
    this.#layers = restored;
    this.#activeLayerId = snapshot.activeLayerId;
    this.#markChanged();
    return true;
  }

  runLayerOperation(type, operation) {
    if (typeof type !== 'string' || !type.trim() || typeof operation !== 'function') {
      throw new TypeError('A layer operation type and callback are required.');
    }
    if (this.#strokeHistory.isStrokeActive) throw new Error('Finish the active tiled stroke before changing layers.');
    const before = this.captureLayerState();
    let result;
    try {
      result = operation();
    } catch (error) {
      this.releaseLayerState(before);
      throw error;
    }
    let after;
    try {
      after = this.captureLayerState();
      const signature = state => JSON.stringify({
        activeLayerId: state.activeLayerId,
        layers: state.layers.map(({ celId, ...metadata }) => metadata),
      });
      if (signature(before) === signature(after)) {
        this.releaseLayerState(before);
        this.releaseLayerState(after);
      } else {
        this.#strokeHistory.recordLayerState(type, before, after);
      }
      return result;
    } catch (error) {
      if (after) {
        try { this.restoreLayerState(before); }
        catch (rollbackError) {
          this.releaseLayerState(before);
          this.releaseLayerState(after);
          throw new AggregateError([error, rollbackError], 'Tiled layer operation failed and rollback could not be completed.');
        }
      }
      this.releaseLayerState(before);
      if (after) this.releaseLayerState(after);
      throw error;
    }
  }

  addLayer(name = 'Layer ' + (this.#layers.length + 1)) {
    if (this.#layers.length >= MAX_LAYERS) throw new RangeError('Tiled project supports up to 64 layers.');
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 180) throw new TypeError('Layer name must contain 1–180 characters.');
    const id = globalThis.crypto?.randomUUID?.();
    if (!id) throw new Error('Secure UUID generation is required for tiled layer identity.');
    const celId = this.#store.createBlankCel({ width: this.#width, height: this.#height });
    const layer = { id, name: name.trim(), visible: true, opacity: 1, locked: false, celId };
    const activeIndex = this.#layers.findIndex(item => item.id === this.#activeLayerId);
    this.#layers.splice(activeIndex + 1, 0, layer);
    this.#activeLayerId = id;
    this.#markChanged();
    return this.layers.find(item => item.id === id);
  }

  renameLayer(layerId, name) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 180) throw new TypeError('Layer name must contain 1–180 characters.');
    const layer = this.#cel(layerId);
    if (layer.name === name.trim()) return false;
    layer.name = name.trim(); this.#markChanged(); return true;
  }

  moveLayer(layerId, targetIndex) {
    if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= this.#layers.length) throw new RangeError('Layer target index is outside the layer stack.');
    const index = this.#layers.findIndex(layer => layer.id === layerId);
    if (index < 0) throw new Error('Unknown layer ID.');
    if (index === targetIndex) return false;
    const [layer] = this.#layers.splice(index, 1);
    this.#layers.splice(targetIndex, 0, layer);
    this.#markChanged(); return true;
  }

  setLayerVisibility(layerId, visible) {
    if (typeof visible !== 'boolean') throw new TypeError('Layer visibility must be a boolean.');
    const layer = this.#cel(layerId);
    if (layer.visible === visible) return false;
    layer.visible = visible; this.#markChanged(); return true;
  }

  setLayerOpacity(layerId, opacity) {
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new RangeError('Layer opacity must be between 0 and 1.');
    const layer = this.#cel(layerId);
    if (layer.opacity === opacity) return false;
    layer.opacity = opacity; this.#markChanged(); return true;
  }

  setLayerLocked(layerId, locked) {
    if (typeof locked !== 'boolean') throw new TypeError('Layer lock must be a boolean.');
    const layer = this.#cel(layerId);
    if (layer.locked === locked) return false;
    layer.locked = locked; this.#markChanged(); return true;
  }

  updateLayer(layerId, changes) {
    const layer = this.#cel(layerId);
    const next = normalizeLayer({ ...layer, ...changes, id: layer.id });
    Object.assign(layer, next);
    this.#markChanged();
    return this.layers.find(item => item.id === layerId);
  }

  duplicateLayer(layerId, name) {
    const source = this.#cel(layerId);
    if (this.#layers.length >= MAX_LAYERS) throw new RangeError('Tiled project supports up to 64 layers.');
    const { celId: sourceCelId, ...sourceMetadata } = source;
    const layer = {
      ...structuredClone(sourceMetadata),
      id: crypto.randomUUID(),
      name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 180) : (source.name + ' copy').slice(0, 180),
      celId: this.#store.cloneCel(source.celId),
    };
    const index = this.#layers.indexOf(source);
    this.#layers.splice(index + 1, 0, layer);
    this.#activeLayerId = layer.id;
    this.#markChanged();
    return this.layers.find(item => item.id === layer.id);
  }

  deleteLayer(layerId) {
    if (this.#layers.length <= 1) throw new RangeError('A tiled project must retain at least one layer.');
    const index = this.#layers.findIndex(layer => layer.id === layerId);
    if (index < 0) throw new Error('Unknown layer ID.');
    const [removed] = this.#layers.splice(index, 1);
    this.#store.releaseCel(removed.celId);
    if (this.#activeLayerId === layerId) this.#activeLayerId = this.#layers[Math.min(index, this.#layers.length - 1)].id;
    this.#markChanged();
    return { id: removed.id, activeLayerId: this.#activeLayerId };
  }

  async toManifest() {
    const layers = [];
    for (const { celId, ...metadata } of this.#layers) {
      layers.push({ ...structuredClone(metadata), cel: await this.#store.exportCel(celId) });
    }
    return {
      format: PIXELFORGE_TILED_PROJECT_FORMAT,
      version: PIXELFORGE_TILED_PROJECT_VERSION,
      id: this.#id, name: this.#name, width: this.#width, height: this.#height,
      activeLayerId: this.#activeLayerId,
      revision: this.#revision, saveVersion: this.#saveVersion, serverRevision: this.#serverRevision,
      drawingConfiguration: structuredClone(this.#drawingConfiguration),
      drawingModel: structuredClone(this.#drawingModel),
      vectorModel: this.#vectorModel === null ? null : structuredClone(this.#vectorModel),
      projectMetadata: structuredClone(this.#projectMetadata),
      layers,
    };
  }

  async toLegacyProjectJSON() {
    const layers = [];
    for (const { celId, ...metadata } of this.#layers) {
      layers.push({ ...structuredClone(metadata), pixels: encodeBase64(this.#store.composeCel(celId)) });
    }
    return {
      ...structuredClone(this.#projectMetadata),
      format: 'pixelforge-project', version: 1,
      id: this.#id, name: this.#name, width: this.#width, height: this.#height,
      activeLayerId: this.#activeLayerId, layers,
      revision: this.#revision, saveVersion: this.#saveVersion, serverRevision: this.#serverRevision,
      drawingConfiguration: structuredClone(this.#drawingConfiguration),
      drawingModel: structuredClone(this.#drawingModel),
      vectorModel: this.#vectorModel === null ? null : structuredClone(this.#vectorModel),
    };
  }

  dispose() {
    this.#strokeHistory.dispose();
    for (const layer of this.#layers) this.#store.releaseCel(layer.celId);
    this.#layers = [];
  }

  #markChanged() {
    this.#revision++;
    this.#saveVersion++;
    this.#dirty = true;
  }

  #cel(layerId) {
    const layer = this.#layers.find(item => item.id === layerId);
    if (!layer) throw new Error('Unknown layer ID.');
    return layer;
  }
}
