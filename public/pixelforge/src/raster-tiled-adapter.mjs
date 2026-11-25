/**
 * Tile-backed project-layer migration adapter.
 * Keeps the legacy RasterDocument untouched while establishing a lossless
 * project manifest for layer metadata and sparse RGBA cel resources.
 */
import { SparseTileCelStore, DEFAULT_CEL_TILE_SIZE } from './animation-tiles.mjs';
import { normalizeDrawingConfiguration, switchDrawingMode as switchProjectDrawingMode, PIXELFORGE_DRAWING_MODES } from './drawing-mode-config.mjs';

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

function normalizeLayer(layer) {
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
    authoringMode: Object.values(PIXELFORGE_DRAWING_MODES).includes(layer.authoringMode) ? layer.authoringMode : null,
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

  constructor({ store, id, name, width, height, layers, activeLayerId, drawingConfiguration, projectMetadata = {} }) {
    if (!(store instanceof SparseTileCelStore)) throw new TypeError('A SparseTileCelStore is required.');
    validateGeometry(width, height);
    if (typeof id !== 'string' || !id.trim() || typeof name !== 'string' || !name.trim()) {
      throw new TypeError('Tiled project identity and name are required.');
    }
    if (!Array.isArray(layers) || !layers.length || layers.length > MAX_LAYERS) {
      throw new RangeError('Tiled project must contain 1–64 raster layers.');
    }
    const normalized = layers.map(layer => ({ ...normalizeLayer(layer), celId: layer.celId }));
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
    this.#drawingConfiguration = normalizeDrawingConfiguration(drawingConfiguration);
    if (!projectMetadata || typeof projectMetadata !== 'object' || Array.isArray(projectMetadata)) {
      throw new TypeError('Tiled project metadata must be an object.');
    }
    this.#projectMetadata = structuredClone(projectMetadata);
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
        projectMetadata,
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
    const { layers: _sourceLayers, ...projectMetadata } = sourceSnapshot;
    const store = new SparseTileCelStore({ maxDecodedCacheBytes });
    const layers = [];
    try {
      for (const layer of document.layers) {
        const celId = await store.createCelFromPixels(layer.pixels, {
          width: document.width, height: document.height, tileSize,
        });
        layers.push({ ...normalizeLayer(layer), celId });
      }
      return new TiledRasterProjectDocument({
        store, id: document.id, name: document.name, width: document.width, height: document.height,
        layers, activeLayerId: document.activeLayerId,
        drawingConfiguration: drawingConfiguration ?? sourceSnapshot.drawingConfiguration,
        projectMetadata,
      });
    } catch (error) {
      for (const layer of layers) store.releaseCel(layer.celId);
      throw error;
    }
  }

  static async fromManifest(manifest, { maxDecodedCacheBytes = 16 * 1024 * 1024 } = {}) {
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
      });
    } catch (error) {
      for (const layer of layers) store.releaseCel(layer.celId);
      throw error;
    }
  }

  get id() { return this.#id; }
  get name() { return this.#name; }
  get width() { return this.#width; }
  get height() { return this.#height; }
  get activeLayerId() { return this.#activeLayerId; }
  get drawingConfiguration() { return structuredClone(this.#drawingConfiguration); }
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
  get stats() { return this.#store.stats; }

  readRegion(layerId, region) {
    return this.#store.readRegion(this.#cel(layerId).celId, region);
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

  async writeRegion(layerId, region, pixels) {
    const layer = this.#cel(layerId);
    if (layer.locked) throw new Error('The target layer is locked.');
    const previousCelId = layer.celId;
    const result = await this.#store.writeRegion(previousCelId, region, pixels);
    if (result.changed) {
      layer.celId = result.celId;
      // writeRegion creates a copy-on-write cel. Once the layer points at the
      // replacement, release its old ownership reference; duplicated layers
      // retain their own references to that immutable cel.
      this.#store.releaseCel(previousCelId);
    }
    return {
      changed: result.changed, changedTiles: result.changedTiles,
      removedTiles: result.removedTiles, celId: result.celId,
    };
  }

  setActiveLayer(layerId) {
    this.#cel(layerId);
    this.#activeLayerId = layerId;
    return layerId;
  }

  updateLayer(layerId, changes) {
    const layer = this.#cel(layerId);
    const next = normalizeLayer({ ...layer, ...changes, id: layer.id });
    Object.assign(layer, next);
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
    return this.layers.find(item => item.id === layer.id);
  }

  deleteLayer(layerId) {
    if (this.#layers.length <= 1) throw new RangeError('A tiled project must retain at least one layer.');
    const index = this.#layers.findIndex(layer => layer.id === layerId);
    if (index < 0) throw new Error('Unknown layer ID.');
    const [removed] = this.#layers.splice(index, 1);
    this.#store.releaseCel(removed.celId);
    if (this.#activeLayerId === layerId) this.#activeLayerId = this.#layers[Math.min(index, this.#layers.length - 1)].id;
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
      drawingConfiguration: structuredClone(this.#drawingConfiguration),
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
      drawingConfiguration: structuredClone(this.#drawingConfiguration),
    };
  }

  dispose() {
    for (const layer of this.#layers) this.#store.releaseCel(layer.celId);
    this.#layers = [];
  }

  #cel(layerId) {
    const layer = this.#layers.find(item => item.id === layerId);
    if (!layer) throw new Error('Unknown layer ID.');
    return layer;
  }
}
