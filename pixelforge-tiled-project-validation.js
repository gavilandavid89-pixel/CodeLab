'use strict';

const crypto = require('crypto');

const FORMAT = 'pixelforge-tiled-project';
const VERSION = 1;
const CEL_FORMAT = 'pixelforge-tiled-cel';
const CEL_VERSION = 2;
const MAX_SIDE = 4096;
const MAX_AREA = 16_777_216;
const MAX_LAYERS = 64;
const TILE_SIZES = new Set([32, 64, 128]);

function failure(error = 'invalid_pixelforge_project', status = 400) {
  return { error, status };
}

function validBase64(value, expectedBytes) {
  if (typeof value !== 'string' || value.length !== Math.ceil(expectedBytes / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.byteLength !== expectedBytes || bytes.toString('base64') !== value) return null;
  return bytes;
}

function validateCel(cel, width, height, state) {
  if (!cel || typeof cel !== 'object' || Array.isArray(cel) ||
      cel.format !== CEL_FORMAT || cel.version !== CEL_VERSION ||
      cel.width !== width || cel.height !== height ||
      !TILE_SIZES.has(cel.tileSize) || !Array.isArray(cel.tiles)) return false;

  const columns = Math.ceil(width / cel.tileSize);
  const rows = Math.ceil(height / cel.tileSize);
  if (cel.tiles.length > columns * rows) return false;
  const seen = new Set();
  const rgbaByCoordinate = new Map();

  for (const tile of cel.tiles) {
    if (!tile || typeof tile !== 'object' || Array.isArray(tile) ||
        !Number.isInteger(tile.x) || !Number.isInteger(tile.y) ||
        tile.x < 0 || tile.y < 0 || tile.x >= width || tile.y >= height ||
        tile.x % cel.tileSize !== 0 || tile.y % cel.tileSize !== 0) return false;

    const expectedWidth = Math.min(cel.tileSize, width - tile.x);
    const expectedHeight = Math.min(cel.tileSize, height - tile.y);
    if (tile.width !== expectedWidth || tile.height !== expectedHeight) return false;
    const key = tile.x + ':' + tile.y;
    if (seen.has(key)) return false;
    seen.add(key);

    const bytes = validBase64(tile.rgba, expectedWidth * expectedHeight * 4);
    if (!bytes || typeof tile.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(tile.sha256)) return false;
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (hash !== tile.sha256) return false;
    rgbaByCoordinate.set(key, bytes);
    // Sparse cels omit fully-zero tiles; accepting them would let clients
    // consume quota with data that has no visual contribution.
    let hasAnyByte = false;
    for (const byte of bytes) { if (byte !== 0) { hasAnyByte = true; break; } }
    if (!hasAnyByte) return false;

    state.tileBytes += bytes.byteLength;
    if (state.tileBytes > state.maxRasterBytes) {
      state.error = 'pixelforge_project_too_large';
      state.status = 413;
      return false;
    }
  }

  if (cel.ownershipTiles !== undefined && !Array.isArray(cel.ownershipTiles)) return false;
  const ownershipSeen = new Set();
  for (const tile of cel.ownershipTiles || []) {
    if (!tile || typeof tile !== 'object' || Array.isArray(tile) ||
        !Number.isInteger(tile.x) || !Number.isInteger(tile.y) ||
        tile.x < 0 || tile.y < 0 || tile.x >= width || tile.y >= height ||
        tile.x % cel.tileSize !== 0 || tile.y % cel.tileSize !== 0) return false;
    const expectedWidth = Math.min(cel.tileSize, width - tile.x);
    const expectedHeight = Math.min(cel.tileSize, height - tile.y);
    if (tile.width !== expectedWidth || tile.height !== expectedHeight) return false;
    const key = tile.x + ':' + tile.y;
    if (ownershipSeen.has(key)) return false;
    ownershipSeen.add(key);
    const owners = validBase64(tile.owners, expectedWidth * expectedHeight);
    if (!owners || typeof tile.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(tile.sha256)) return false;
    const hash = crypto.createHash('sha256').update(owners).digest('hex');
    if (hash !== tile.sha256) return false;
    let hasOwner = false;
    const rgba = rgbaByCoordinate.get(key);
    for (let index = 0; index < owners.length; index++) {
      const owner = owners[index];
      if (owner > 2) return false;
      if (owner !== 0) {
        hasOwner = true;
        if (!rgba || rgba[index * 4 + 3] === 0) return false;
      }
    }
    // Ownership is sparse too: all-zero owner tiles are omitted, and every
    // owned pixel must remain visible in its corresponding RGBA tile.
    if (!hasOwner) return false;
  }
  return true;
}

/**
 * Validate the sparse tiled manifest without allocating a full-canvas RGBA
 * buffer. The raw tile payload remains subject to the same aggregate 64 MiB
 * raster ceiling as the legacy dense project format.
 */
function validatePixelForgeTiledProjectPayload(project, serializedInput = null, limits = {}) {
  const maxProjectBytes = Number.isSafeInteger(limits.maxProjectBytes) && limits.maxProjectBytes > 0
    ? limits.maxProjectBytes : 96 * 1024 * 1024;
  const maxRasterBytes = Number.isSafeInteger(limits.maxRasterBytes) && limits.maxRasterBytes > 0
    ? limits.maxRasterBytes : 64 * 1024 * 1024;

  if (!project || typeof project !== 'object' || Array.isArray(project) ||
      project.format !== FORMAT || project.version !== VERSION ||
      typeof project.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(project.id) ||
      typeof project.name !== 'string' || !project.name.trim() || project.name.length > 180 ||
      !Number.isInteger(project.width) || !Number.isInteger(project.height) ||
      project.width < 1 || project.height < 1 || project.width > MAX_SIDE || project.height > MAX_SIDE ||
      project.width * project.height > MAX_AREA ||
      !Number.isInteger(project.revision) || project.revision < 0 ||
      !Number.isInteger(project.saveVersion) || project.saveVersion < 0 ||
      (project.serverRevision !== undefined && (!Number.isInteger(project.serverRevision) || project.serverRevision < 0)) ||
      !Array.isArray(project.layers) || project.layers.length < 1 || project.layers.length > MAX_LAYERS ||
      typeof project.activeLayerId !== 'string' ||
      (project.projectMetadata !== undefined && (!project.projectMetadata || typeof project.projectMetadata !== 'object' || Array.isArray(project.projectMetadata))) ||
      (project.drawingConfiguration !== undefined && (!project.drawingConfiguration || typeof project.drawingConfiguration !== 'object' || Array.isArray(project.drawingConfiguration))) ||
      (project.animation !== undefined && (!project.animation || typeof project.animation !== 'object' || Array.isArray(project.animation)))) {
    return failure();
  }

  const state = { tileBytes: 0, maxRasterBytes };
  const layerIds = new Set();
  for (const layer of project.layers) {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer) ||
        typeof layer.id !== 'string' || !layer.id.trim() || layer.id.length > 180 || layerIds.has(layer.id) ||
        typeof layer.name !== 'string' || !layer.name.trim() || layer.name.length > 180 ||
        typeof layer.visible !== 'boolean' || typeof layer.locked !== 'boolean' ||
        !Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1 ||
        !validateCel(layer.cel, project.width, project.height, state)) {
      return failure(state.error || 'invalid_pixelforge_project', state.status || 400);
    }
    layerIds.add(layer.id);
  }
  if (!layerIds.has(project.activeLayerId)) return failure();

  if (project.animation !== undefined) {
    const animation = project.animation;
    if (animation.format !== 'pixelforge-tiled-animation' || animation.version !== 1 ||
        animation.width !== project.width || animation.height !== project.height ||
        !Number.isInteger(animation.fps) || animation.fps < 1 || animation.fps > 60 ||
        !Number.isInteger(animation.activeFrameIndex) ||
        !Array.isArray(animation.layerIds) || animation.layerIds.length !== project.layers.length ||
        animation.layerIds.some((id, index) => id !== project.layers[index].id) ||
        new Set(animation.layerIds).size !== animation.layerIds.length ||
        !Array.isArray(animation.frames) || animation.frames.length < 1 || animation.frames.length > 240 ||
        animation.activeFrameIndex < 0 || animation.activeFrameIndex >= animation.frames.length) return failure('invalid_pixelforge_animation');

    const frameIds = new Set();
    for (const frame of animation.frames) {
      if (!frame || typeof frame !== 'object' || Array.isArray(frame) ||
          typeof frame.id !== 'string' || !frame.id.trim() || frame.id.length > 180 || frameIds.has(frame.id) ||
          !Number.isFinite(frame.durationMs) || frame.durationMs < 1 || frame.durationMs > 10000 ||
          !['illustration', 'pixel-art'].includes(frame.authoringMode) ||
          !Array.isArray(frame.cels) || frame.cels.length !== animation.layerIds.length) return failure('invalid_pixelforge_animation');
      frameIds.add(frame.id);
      const celLayerIds = new Set();
      for (const entry of frame.cels) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
            typeof entry.layerId !== 'string' || !layerIds.has(entry.layerId) || celLayerIds.has(entry.layerId) ||
            !entry.metadata || typeof entry.metadata !== 'object' || Array.isArray(entry.metadata) ||
            !['illustration', 'pixel-art'].includes(entry.metadata.authoringMode) ||
            !validateCel(entry.cel, project.width, project.height, state)) return failure('invalid_pixelforge_animation');
        celLayerIds.add(entry.layerId);
      }
      if (celLayerIds.size !== animation.layerIds.length) return failure('invalid_pixelforge_animation');
    }
  }

  const serialized = typeof serializedInput === 'string' ? serializedInput : JSON.stringify(project);
  const projectBytes = Buffer.byteLength(serialized, 'utf8');
  if (projectBytes > maxProjectBytes) return failure('pixelforge_project_too_large', 413);
  return { serialized, projectBytes, tileBytes: state.tileBytes };
}

module.exports = { validatePixelForgeTiledProjectPayload };
