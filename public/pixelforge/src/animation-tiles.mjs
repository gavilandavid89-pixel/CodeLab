/**
 * Sparse tiled RGBA cel codec (format v2 building block).
 *
 * This module is deliberately isolated from PixelForgeAnimation v1. It provides
 * deterministic sparse encode/decode and tile-level diffs without changing the
 * editor's current in-memory model or project serializer.
 */
export const PIXELFORGE_TILED_CEL_FORMAT = 'pixelforge-tiled-cel';
export const PIXELFORGE_TILED_CEL_VERSION = 2;
export const DEFAULT_CEL_TILE_SIZE = 64;
const MAX_SIDE = 4096;
const MAX_AREA = 16_777_216;
const ALLOWED_TILE_SIZES = new Set([32, 64, 128]);

function assertDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE ||
      width * height > MAX_AREA) {
    throw new RangeError('Tiled cel dimensions exceed PixelForge canvas limits.');
  }
}

function assertTileSize(tileSize) {
  if (!ALLOWED_TILE_SIZES.has(tileSize)) {
    throw new RangeError('Tile size must be 32, 64, or 128 pixels.');
  }
}

function assertPixels(pixels, width, height) {
  if (!(pixels instanceof Uint8Array) && !(pixels instanceof Uint8ClampedArray)) {
    throw new TypeError('Tiled cel pixels must be a Uint8Array or Uint8ClampedArray.');
  }
  if (pixels.byteLength !== width * height * 4) {
    throw new RangeError('Tiled cel RGBA data does not match its dimensions.');
  }
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value, expectedBytes) {
  const expectedChars = Math.ceil(expectedBytes / 3) * 4;
  if (typeof value !== 'string' || value.length !== expectedChars ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError('Tiled cel tile contains invalid or incorrectly sized base64.');
  }
  let binary;
  try { binary = atob(value); } catch { throw new TypeError('Tiled cel tile contains invalid base64.'); }
  if (binary.length !== expectedBytes || btoa(binary) !== value) {
    throw new TypeError('Tiled cel tile contains non-canonical base64.');
  }
  const bytes = new Uint8Array(expectedBytes);
  for (let index = 0; index < expectedBytes; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function sha256(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto SHA-256 is required for tiled cel resources.');
  const digest = await subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function tileKey(x, y) { return `${x}:${y}`; }

/**
 * Encode a dense RGBA cel as sparse, independently hashed tiles.
 * A tile is omitted only when every RGBA byte is zero, preserving hidden RGB
 * values in transparent pixels and therefore preserving exact round trips.
 */
export async function encodeSparseTiles(pixels, {
  width, height, tileSize = DEFAULT_CEL_TILE_SIZE,
} = {}) {
  assertDimensions(width, height);
  assertTileSize(tileSize);
  assertPixels(pixels, width, height);
  const tiles = [];
  for (let y = 0; y < height; y += tileSize) {
    for (let x = 0; x < width; x += tileSize) {
      const tileWidth = Math.min(tileSize, width - x);
      const tileHeight = Math.min(tileSize, height - y);
      const rgba = new Uint8Array(tileWidth * tileHeight * 4);
      let hasAnyByte = false;
      for (let row = 0; row < tileHeight; row++) {
        const sourceStart = ((y + row) * width + x) * 4;
        const targetStart = row * tileWidth * 4;
        const rowBytes = pixels.subarray(sourceStart, sourceStart + tileWidth * 4);
        rgba.set(rowBytes, targetStart);
        if (!hasAnyByte) {
          for (let index = 0; index < rowBytes.length; index++) {
            if (rowBytes[index] !== 0) { hasAnyByte = true; break; }
          }
        }
      }
      if (!hasAnyByte) continue;
      tiles.push({
        x, y, width: tileWidth, height: tileHeight,
        sha256: await sha256(rgba),
        rgba: bytesToBase64(rgba),
      });
    }
  }
  return {
    format: PIXELFORGE_TILED_CEL_FORMAT,
    version: PIXELFORGE_TILED_CEL_VERSION,
    width, height, tileSize, tiles,
  };
}

/** Validate and decode a v2 tiled cel into the existing editor's RGBA adapter. */
export async function decodeSparseTiles(document) {
  if (!document || document.format !== PIXELFORGE_TILED_CEL_FORMAT ||
      document.version !== PIXELFORGE_TILED_CEL_VERSION || !Array.isArray(document.tiles)) {
    throw new TypeError('Unsupported or invalid PixelForge tiled cel.');
  }
  const { width, height, tileSize } = document;
  assertDimensions(width, height);
  assertTileSize(tileSize);
  const columns = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);
  if (document.tiles.length > columns * rows) {
    throw new RangeError('Tiled cel contains more tiles than its canvas can hold.');
  }
  const output = new Uint8ClampedArray(width * height * 4);
  const seen = new Set();
  for (const tile of document.tiles) {
    if (!tile || !Number.isInteger(tile.x) || !Number.isInteger(tile.y) ||
        tile.x < 0 || tile.y < 0 || tile.x % tileSize !== 0 || tile.y % tileSize !== 0 ||
        tile.x >= width || tile.y >= height) {
      throw new TypeError('Tiled cel contains an invalid tile coordinate.');
    }
    const expectedWidth = Math.min(tileSize, width - tile.x);
    const expectedHeight = Math.min(tileSize, height - tile.y);
    if (tile.width !== expectedWidth || tile.height !== expectedHeight) {
      throw new TypeError('Tiled cel edge dimensions do not match the canvas.');
    }
    const key = tileKey(tile.x, tile.y);
    if (seen.has(key)) throw new TypeError('Tiled cel contains duplicate tile coordinates.');
    seen.add(key);
    const bytes = base64ToBytes(tile.rgba, expectedWidth * expectedHeight * 4);
    if (typeof tile.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(tile.sha256) ||
        await sha256(bytes) !== tile.sha256) {
      throw new TypeError('Tiled cel tile SHA-256 integrity check failed.');
    }
    for (let row = 0; row < expectedHeight; row++) {
      const sourceStart = row * expectedWidth * 4;
      const targetStart = ((tile.y + row) * width + tile.x) * 4;
      output.set(bytes.subarray(sourceStart, sourceStart + expectedWidth * 4), targetStart);
    }
  }
  return output;
}

/**
 * Return only changed tile resources between two compatible sparse cels.
 * Added/changed contain new immutable tile payloads; removed contains coords.
 */
export function diffSparseTiles(previous, next) {
  for (const cel of [previous, next]) {
    if (!cel || cel.format !== PIXELFORGE_TILED_CEL_FORMAT ||
        cel.version !== PIXELFORGE_TILED_CEL_VERSION || !Array.isArray(cel.tiles)) {
      throw new TypeError('Tile diff requires two valid v2 tiled cels.');
    }
  }
  if (previous.width !== next.width || previous.height !== next.height ||
      previous.tileSize !== next.tileSize) {
    throw new RangeError('Tile diff requires matching canvas dimensions and tile size.');
  }
  const before = new Map(previous.tiles.map(tile => [tileKey(tile.x, tile.y), tile]));
  const after = new Map(next.tiles.map(tile => [tileKey(tile.x, tile.y), tile]));
  const added = [];
  const changed = [];
  const removed = [];
  for (const [key, tile] of after) {
    const old = before.get(key);
    if (!old) added.push(tile);
    else if (old.sha256 !== tile.sha256) changed.push(tile);
  }
  for (const [key, tile] of before) {
    if (!after.has(key)) removed.push({ x: tile.x, y: tile.y });
  }
  return { added, changed, removed };
}


function assertCacheBudget(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 64 * 1024 * 1024) {
    throw new RangeError('Decoded tile cache budget must be from 0 to 64 MiB.');
  }
}

/**
 * In-memory content-addressed tile store.
 *
 * Cels are lightweight maps of tile coordinates to immutable SHA-256 resources.
 * cloneCel() shares resource references; updateTile() swaps only the edited
 * coordinate, providing copy-on-write semantics. Decoded bytes live in a bounded
 * LRU cache; the canonical resource representation remains base64 payload data.
 *
 * This is a client-side model primitive, not a persistence or authorization API.
 */
export class SparseTileCelStore {
  #resources = new Map();
  #cels = new Map();
  #decoded = new Map();
  #decodedBytes = 0;
  #maxDecodedCacheBytes;

  constructor({ maxDecodedCacheBytes = 8 * 1024 * 1024 } = {}) {
    assertCacheBudget(maxDecodedCacheBytes);
    this.#maxDecodedCacheBytes = maxDecodedCacheBytes;
  }

  /** Create an empty sparse cel without allocating a width × height RGBA buffer. */
  createBlankCel({ width, height, tileSize = DEFAULT_CEL_TILE_SIZE } = {}) {
    assertDimensions(width, height);
    assertTileSize(tileSize);
    const celId = globalThis.crypto?.randomUUID?.();
    if (!celId) throw new Error('Secure UUID generation is required for sparse cel IDs.');
    this.#cels.set(celId, { width, height, tileSize, tiles: new Map(), ownershipTiles: new Map() });
    return celId;
  }

  get stats() {
    let references = 0;
    for (const resource of this.#resources.values()) references += resource.refs;
    return Object.freeze({
      celCount: this.#cels.size,
      resourceCount: this.#resources.size,
      resourceReferences: references,
      decodedCacheBytes: this.#decodedBytes,
      decodedCacheEntries: this.#decoded.size,
      maxDecodedCacheBytes: this.#maxDecodedCacheBytes,
    });
  }

  #cel(celId) {
    const cel = this.#cels.get(celId);
    if (!cel) throw new Error('Unknown sparse cel ID.');
    return cel;
  }

  #retain(hash, rgba) {
    const existing = this.#resources.get(hash);
    if (existing) {
      if (existing.rgba !== rgba) throw new Error('SHA-256 resource collision detected.');
      existing.refs++;
    } else {
      this.#resources.set(hash, { rgba, byteLength: Math.floor(rgba.length * 3 / 4) - (rgba.endsWith('==') ? 2 : rgba.endsWith('=') ? 1 : 0), refs: 1 });
    }
  }

  #release(hash) {
    const resource = this.#resources.get(hash);
    if (!resource) throw new Error('Sparse tile resource reference is missing.');
    resource.refs--;
    if (resource.refs < 0) throw new Error('Sparse tile resource reference count underflow.');
    if (resource.refs === 0) {
      this.#resources.delete(hash);
      const cached = this.#decoded.get(hash);
      if (cached) {
        this.#decodedBytes -= cached.byteLength;
        this.#decoded.delete(hash);
      }
    }
  }

  #tileBytes(hash) {
    const cached = this.#decoded.get(hash);
    if (cached) {
      this.#decoded.delete(hash);
      this.#decoded.set(hash, cached);
      return cached;
    }
    const resource = this.#resources.get(hash);
    if (!resource) throw new Error('Sparse tile resource is unavailable.');
    const expectedBytes = resource.byteLength;
    const bytes = base64ToBytes(resource.rgba, expectedBytes);
    if (this.#maxDecodedCacheBytes > 0 && bytes.byteLength <= this.#maxDecodedCacheBytes) {
      this.#decoded.set(hash, bytes);
      this.#decodedBytes += bytes.byteLength;
      while (this.#decodedBytes > this.#maxDecodedCacheBytes) {
        const oldestHash = this.#decoded.keys().next().value;
        const oldest = this.#decoded.get(oldestHash);
        this.#decodedBytes -= oldest.byteLength;
        this.#decoded.delete(oldestHash);
      }
    }
    return bytes;
  }

  async createCel(document) {
    if (!document || document.format !== PIXELFORGE_TILED_CEL_FORMAT ||
        document.version !== PIXELFORGE_TILED_CEL_VERSION || !Array.isArray(document.tiles)) {
      throw new TypeError('Unsupported or invalid PixelForge tiled cel.');
    }
    const { width, height, tileSize } = document;
    assertDimensions(width, height);
    assertTileSize(tileSize);
    const columns = Math.ceil(width / tileSize);
    const rows = Math.ceil(height / tileSize);
    if (document.tiles.length > columns * rows) {
      throw new RangeError('Tiled cel contains more tiles than its canvas can hold.');
    }
    const tiles = new Map();
    const pending = [];
    for (const tile of document.tiles) {
      if (!tile || !Number.isInteger(tile.x) || !Number.isInteger(tile.y) ||
          tile.x < 0 || tile.y < 0 || tile.x % tileSize !== 0 || tile.y % tileSize !== 0 ||
          tile.x >= width || tile.y >= height) {
        throw new TypeError('Tiled cel contains an invalid tile coordinate.');
      }
      const tileWidth = Math.min(tileSize, width - tile.x);
      const tileHeight = Math.min(tileSize, height - tile.y);
      if (tile.width !== tileWidth || tile.height !== tileHeight) {
        throw new TypeError('Tiled cel edge dimensions do not match the canvas.');
      }
      const key = tileKey(tile.x, tile.y);
      if (tiles.has(key)) throw new TypeError('Tiled cel contains duplicate tile coordinates.');
      const bytes = base64ToBytes(tile.rgba, tileWidth * tileHeight * 4);
      if (typeof tile.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(tile.sha256) ||
          await sha256(bytes) !== tile.sha256) {
        throw new TypeError('Tiled cel tile SHA-256 integrity check failed.');
      }
      let hasAnyByte = false;
      for (const byte of bytes) if (byte !== 0) { hasAnyByte = true; break; }
      if (!hasAnyByte) throw new TypeError('Sparse tiled cel must not store an empty tile.');
      tiles.set(key, { x: tile.x, y: tile.y, width: tileWidth, height: tileHeight, hash: tile.sha256 });
      pending.push({ hash: tile.sha256, rgba: tile.rgba, byteLength: bytes.byteLength });
    }
    const ownershipTiles = new Map();
    if (document.ownershipTiles !== undefined && !Array.isArray(document.ownershipTiles)) throw new TypeError('Tiled cel ownershipTiles must be an array.');
    for (const tile of document.ownershipTiles || []) {
      if (!tile || !Number.isInteger(tile.x) || !Number.isInteger(tile.y) || tile.x < 0 || tile.y < 0 || tile.x % tileSize || tile.y % tileSize || tile.x >= width || tile.y >= height) throw new TypeError('Invalid ownership tile coordinate.');
      const tileWidth = Math.min(tileSize, width - tile.x), tileHeight = Math.min(tileSize, height - tile.y);
      if (tile.width !== tileWidth || tile.height !== tileHeight) throw new TypeError('Ownership tile edge dimensions do not match canvas.');
      const key = tileKey(tile.x, tile.y);
      if (ownershipTiles.has(key)) throw new TypeError('Duplicate ownership tile coordinate.');
      const owners = base64ToBytes(tile.owners, tileWidth * tileHeight);
      if (typeof tile.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(tile.sha256) || await sha256(owners) !== tile.sha256) throw new TypeError('Ownership tile SHA-256 integrity check failed.');
      let nonzero = false;
      for (const owner of owners) { if (owner > 2) throw new TypeError('Unsupported pixel owner value.'); if (owner) nonzero = true; }
      if (!nonzero) throw new TypeError('Sparse ownership tiles cannot be empty.');
      ownershipTiles.set(key, { x: tile.x, y: tile.y, width: tileWidth, height: tileHeight, owners });
    }
    const celId = globalThis.crypto?.randomUUID?.();
    if (!celId) throw new Error('Secure UUID generation is required for sparse cel IDs.');
    for (const resource of pending) {
      this.#retain(resource.hash, resource.rgba);
      this.#resources.get(resource.hash).byteLength = resource.byteLength;
    }
    this.#cels.set(celId, { width, height, tileSize, tiles, ownershipTiles });
    return celId;
  }

  async createCelFromPixels(pixels, options) {
    return this.createCel(await encodeSparseTiles(pixels, options));
  }

  cloneCel(celId) {
    const source = this.#cel(celId);
    const cloneId = globalThis.crypto?.randomUUID?.();
    if (!cloneId) throw new Error('Secure UUID generation is required for sparse cel IDs.');
    const tiles = new Map([...source.tiles].map(([key, tile]) => {
      const resource = this.#resources.get(tile.hash);
      if (!resource) throw new Error('Sparse tile resource is unavailable.');
      resource.refs++;
      return [key, { ...tile }];
    }));
    this.#cels.set(cloneId, { width: source.width, height: source.height, tileSize: source.tileSize, tiles, ownershipTiles: new Map([...source.ownershipTiles].map(([key, tile]) => [key, { ...tile, owners: new Uint8Array(tile.owners) }])) });
    return cloneId;
  }

  getTile(celId, x, y) {
    const cel = this.#cel(celId);
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 ||
        x % cel.tileSize !== 0 || y % cel.tileSize !== 0 || x >= cel.width || y >= cel.height) {
      throw new RangeError('Sparse tile coordinate is outside the cel grid.');
    }
    const tile = cel.tiles.get(tileKey(x, y));
    if (!tile) return null;
    return {
      x: tile.x, y: tile.y, width: tile.width, height: tile.height,
      sha256: tile.hash,
      pixels: new Uint8Array(this.#tileBytes(tile.hash)),
    };
  }

  #assertRegion(cel, region, pixels = null) {
    const { x, y, width, height } = region || {};
    if (![x, y, width, height].every(Number.isInteger) || x < 0 || y < 0 ||
        width < 1 || height < 1 || x + width > cel.width || y + height > cel.height) {
      throw new RangeError('Sparse cel region must be a positive rectangle inside the canvas.');
    }
    if (pixels !== null) assertPixels(pixels, width, height);
    return { x, y, width, height };
  }

  /** Read a bounded rectangle without materializing the full canvas. */
  readRegion(celId, region) {
    const cel = this.#cel(celId);
    const rect = this.#assertRegion(cel, region);
    const output = new Uint8ClampedArray(rect.width * rect.height * 4);
    const startTileX = Math.floor(rect.x / cel.tileSize) * cel.tileSize;
    const startTileY = Math.floor(rect.y / cel.tileSize) * cel.tileSize;
    for (let tileY = startTileY; tileY < rect.y + rect.height; tileY += cel.tileSize) {
      for (let tileX = startTileX; tileX < rect.x + rect.width; tileX += cel.tileSize) {
        const tile = this.getTile(celId, tileX, tileY);
        if (!tile) continue;
        const left = Math.max(rect.x, tileX);
        const top = Math.max(rect.y, tileY);
        const right = Math.min(rect.x + rect.width, tileX + tile.width);
        const bottom = Math.min(rect.y + rect.height, tileY + tile.height);
        for (let y = top; y < bottom; y++) {
          const sourceStart = ((y - tileY) * tile.width + left - tileX) * 4;
          const targetStart = ((y - rect.y) * rect.width + left - rect.x) * 4;
          output.set(tile.pixels.subarray(sourceStart, sourceStart + (right - left) * 4), targetStart);
        }
      }
    }
    return output;
  }

  /**
   * Commit RGBA and ownership patches as one copy-on-write cel replacement.
   * Intermediate clones are never exposed; failures release them and preserve source.
   */
  async writeRegionWithOwnership(celId, region, pixels, owners) {
    const rgba = await this.writeRegion(celId, region, pixels);
    const intermediateId = rgba.celId;
    try {
      const ownership = await this.writeOwnershipRegion(intermediateId, region, owners);
      if (ownership.celId !== intermediateId) this.releaseCel(intermediateId);
      return { celId: ownership.celId, changed: rgba.changed || ownership.changed, changedTiles: rgba.changedTiles, changedOwnershipTiles: ownership.changedTiles };
    } catch (error) {
      if (intermediateId !== celId) this.releaseCel(intermediateId);
      throw error;
    }
  }
  /** Read a bounded ownership rectangle. 0=unowned, 1=Illustration, 2=Pixel Art. */
  readOwnershipRegion(celId, region) {
    const cel = this.#cel(celId), rect = this.#assertRegion(cel, region);
    const output = new Uint8Array(rect.width * rect.height);
    const startTileX = Math.floor(rect.x / cel.tileSize) * cel.tileSize, startTileY = Math.floor(rect.y / cel.tileSize) * cel.tileSize;
    for (let ty = startTileY; ty < rect.y + rect.height; ty += cel.tileSize) for (let tx = startTileX; tx < rect.x + rect.width; tx += cel.tileSize) {
      const tile = cel.ownershipTiles.get(tileKey(tx, ty)); if (!tile) continue;
      const left = Math.max(rect.x, tx), top = Math.max(rect.y, ty), right = Math.min(rect.x + rect.width, tx + tile.width), bottom = Math.min(rect.y + rect.height, ty + tile.height);
      for (let y = top; y < bottom; y++) { const from = (y - ty) * tile.width + left - tx, to = (y - rect.y) * rect.width + left - rect.x; output.set(tile.owners.subarray(from, from + right - left), to); }
    }
    return output;
  }

  /** Copy-on-write update of a bounded cel-local ownership rectangle. */
  async writeOwnershipRegion(celId, region, owners) {
    const source = this.#cel(celId), rect = this.#assertRegion(source, region);
    if (!(owners instanceof Uint8Array) || owners.byteLength !== rect.width * rect.height) throw new TypeError('Ownership data must match the region.');
    for (const owner of owners) if (owner > 2) throw new TypeError('Pixel owner must be 0, 1, or 2.');
    const nextId = this.cloneCel(celId); let changedTiles = 0;
    try {
      const sx = Math.floor(rect.x / source.tileSize) * source.tileSize, sy = Math.floor(rect.y / source.tileSize) * source.tileSize;
      for (let ty = sy; ty < rect.y + rect.height; ty += source.tileSize) for (let tx = sx; tx < rect.x + rect.width; tx += source.tileSize) {
        const tw = Math.min(source.tileSize, source.width - tx), th = Math.min(source.tileSize, source.height - ty), key = tileKey(tx, ty), cel = this.#cel(nextId), previous = cel.ownershipTiles.get(key);
        const bytes = previous ? new Uint8Array(previous.owners) : new Uint8Array(tw * th);
        const left = Math.max(rect.x, tx), top = Math.max(rect.y, ty), right = Math.min(rect.x + rect.width, tx + tw), bottom = Math.min(rect.y + rect.height, ty + th);
        for (let y = top; y < bottom; y++) { const from = (y - rect.y) * rect.width + left - rect.x, to = (y - ty) * tw + left - tx; bytes.set(owners.subarray(from, from + right - left), to); }
        let nonzero = false; for (const value of bytes) if (value) { nonzero = true; break; }
        const changed = !previous ? nonzero : bytes.some((value, index) => value !== previous.owners[index]); if (!changed) continue;
        if (nonzero) cel.ownershipTiles.set(key, { x: tx, y: ty, width: tw, height: th, owners: bytes }); else cel.ownershipTiles.delete(key);
        changedTiles++;
      }
      if (!changedTiles) { this.releaseCel(nextId); return { celId, changed: false, changedTiles: 0 }; }
      return { celId: nextId, changed: true, changedTiles };
    } catch (error) { this.releaseCel(nextId); throw error; }
  }

  /**
   * Copy-on-write update of a bounded rectangle. Only intersected tiles are
   * decoded and replaced. The source cel remains immutable and is returned
   * unchanged when the patch contains no pixel differences.
   */
  async writeRegion(celId, region, pixels) {
    const source = this.#cel(celId);
    const rect = this.#assertRegion(source, region, pixels);
    const nextId = this.cloneCel(celId);
    let changedTiles = 0, removedTiles = 0;
    try {
      const startTileX = Math.floor(rect.x / source.tileSize) * source.tileSize;
      const startTileY = Math.floor(rect.y / source.tileSize) * source.tileSize;
      for (let tileY = startTileY; tileY < rect.y + rect.height; tileY += source.tileSize) {
        for (let tileX = startTileX; tileX < rect.x + rect.width; tileX += source.tileSize) {
          const current = this.getTile(nextId, tileX, tileY);
          const tileWidth = Math.min(source.tileSize, source.width - tileX);
          const tileHeight = Math.min(source.tileSize, source.height - tileY);
          const tilePixels = current?.pixels ?? new Uint8Array(tileWidth * tileHeight * 4);
          const left = Math.max(rect.x, tileX);
          const top = Math.max(rect.y, tileY);
          const right = Math.min(rect.x + rect.width, tileX + tileWidth);
          const bottom = Math.min(rect.y + rect.height, tileY + tileHeight);
          for (let y = top; y < bottom; y++) {
            const sourceStart = ((y - rect.y) * rect.width + left - rect.x) * 4;
            const targetStart = ((y - tileY) * tileWidth + left - tileX) * 4;
            tilePixels.set(pixels.subarray(sourceStart, sourceStart + (right - left) * 4), targetStart);
          }
          const result = await this.updateTile(nextId, tileX, tileY, tilePixels);
          if (result.changed) changedTiles++;
          if (result.removed) removedTiles++;
        }
      }
      if (!changedTiles) {
        this.releaseCel(nextId);
        return { celId, changedTiles: 0, removedTiles: 0, changed: false };
      }
      return { celId: nextId, changedTiles, removedTiles, changed: true };
    } catch (error) {
      this.releaseCel(nextId);
      throw error;
    }
  }

  /**
   * Atomically apply a bounded set of complete tile replacements to one cel.
   * The source cel remains untouched until every replacement has succeeded.
   */
  async writeTileBatch(celId, patches, { maxBytes = 16 * 1024 * 1024 } = {}) {
    const source = this.#cel(celId);
    if (!Array.isArray(patches) || !patches.length) throw new TypeError('Tile batch must contain at least one patch.');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('Tile batch byte budget must be positive.');
    const seen = new Set();
    let totalBytes = 0;
    for (const patch of patches) {
      if (!patch || !Number.isInteger(patch.x) || !Number.isInteger(patch.y) ||
          patch.x < 0 || patch.y < 0 || patch.x % source.tileSize || patch.y % source.tileSize ||
          patch.x >= source.width || patch.y >= source.height) {
        throw new RangeError('Tile batch contains an invalid tile coordinate.');
      }
      const key = tileKey(patch.x, patch.y);
      if (seen.has(key)) throw new TypeError('Tile batch cannot contain duplicate coordinates.');
      seen.add(key);
      const width = Math.min(source.tileSize, source.width - patch.x);
      const height = Math.min(source.tileSize, source.height - patch.y);
      assertPixels(patch.pixels, width, height);
      totalBytes += patch.pixels.byteLength;
      if (totalBytes > maxBytes) throw new RangeError('Tile batch exceeded its byte budget.');
    }
    const nextId = this.cloneCel(celId);
    let changedTiles = 0, removedTiles = 0;
    try {
      for (const patch of patches) {
        const result = await this.updateTile(nextId, patch.x, patch.y, patch.pixels);
        if (result.changed) changedTiles++;
        if (result.removed) removedTiles++;
      }
      if (!changedTiles) {
        this.releaseCel(nextId);
        return { celId, changed: false, changedTiles: 0, removedTiles: 0 };
      }
      return { celId: nextId, changed: true, changedTiles, removedTiles };
    } catch (error) {
      this.releaseCel(nextId);
      throw error;
    }
  }

  getCelTileSize(celId) { return this.#cel(celId).tileSize; }
  getCelDimensions(celId) {
    const cel = this.#cel(celId);
    return Object.freeze({ width: cel.width, height: cel.height, tileSize: cel.tileSize });
  }

  async updateTile(celId, x, y, pixels) {
    const cel = this.#cel(celId);
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 ||
        x % cel.tileSize !== 0 || y % cel.tileSize !== 0 || x >= cel.width || y >= cel.height) {
      throw new RangeError('Sparse tile coordinate is outside the cel grid.');
    }
    const width = Math.min(cel.tileSize, cel.width - x);
    const height = Math.min(cel.tileSize, cel.height - y);
    assertPixels(pixels, width, height);
    const key = tileKey(x, y);
    const previous = cel.tiles.get(key);
    let hasAnyByte = false;
    for (const byte of pixels) if (byte !== 0) { hasAnyByte = true; break; }
    if (!hasAnyByte) {
      if (previous) {
        cel.tiles.delete(key);
        this.#release(previous.hash);
      }
      return { changed: Boolean(previous), removed: Boolean(previous), sha256: null };
    }
    const bytes = new Uint8Array(pixels);
    const hash = await sha256(bytes);
    const rgba = bytesToBase64(bytes);
    if (previous?.hash === hash) return { changed: false, removed: false, sha256: hash };
    this.#retain(hash, rgba);
    this.#resources.get(hash).byteLength = bytes.byteLength;
    cel.tiles.set(key, { x, y, width, height, hash });
    if (previous) this.#release(previous.hash);
    return { changed: true, removed: false, sha256: hash };
  }

  async exportCel(celId) {
    const cel = this.#cel(celId);
    const tiles = [...cel.tiles.values()].sort((a, b) => a.y - b.y || a.x - b.x).map(tile => {
      const resource = this.#resources.get(tile.hash);
      if (!resource) throw new Error('Sparse tile resource is unavailable.');
      return { x: tile.x, y: tile.y, width: tile.width, height: tile.height, sha256: tile.hash, rgba: resource.rgba };
    });
    return {
      format: PIXELFORGE_TILED_CEL_FORMAT,
      version: PIXELFORGE_TILED_CEL_VERSION,
      width: cel.width, height: cel.height, tileSize: cel.tileSize, tiles,
      ...(cel.ownershipTiles.size ? { ownershipTiles: await Promise.all([...cel.ownershipTiles.values()].sort((a, b) => a.y - b.y || a.x - b.x).map(async tile => ({
        x: tile.x, y: tile.y, width: tile.width, height: tile.height, sha256: await sha256(tile.owners), owners: bytesToBase64(tile.owners),
      }))) } : {}),
    };
  }

  composeCel(celId) {
    const cel = this.#cel(celId);
    const output = new Uint8ClampedArray(cel.width * cel.height * 4);
    for (const tile of cel.tiles.values()) {
      const bytes = this.#tileBytes(tile.hash);
      for (let row = 0; row < tile.height; row++) {
        const sourceStart = row * tile.width * 4;
        const targetStart = ((tile.y + row) * cel.width + tile.x) * 4;
        output.set(bytes.subarray(sourceStart, sourceStart + tile.width * 4), targetStart);
      }
    }
    return output;
  }

  releaseCel(celId) {
    const cel = this.#cel(celId);
    this.#cels.delete(celId);
    for (const tile of cel.tiles.values()) this.#release(tile.hash);
    return true;
  }

  diffCels(previousCelId, nextCelId) {
    return diffSparseTiles(this.#documentForDiff(previousCelId), this.#documentForDiff(nextCelId));
  }

  async createPatch(previousCelId, nextCelId, {
    projectId, baseRevision, operationId, frameId, layerId,
  } = {}) {
    for (const [name, value] of Object.entries({ projectId, operationId, frameId, layerId })) {
      if (typeof value !== 'string' || !value.trim() || value.length > 180) {
        throw new TypeError(`Sparse cel patch ${name} must be non-empty text up to 180 characters.`);
      }
    }
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
      throw new RangeError('Sparse cel patch baseRevision must be a non-negative safe integer.');
    }
    const previous = await this.exportCel(previousCelId);
    const next = await this.exportCel(nextCelId);
    if (previous.width !== next.width || previous.height !== next.height ||
        previous.tileSize !== next.tileSize) {
      throw new RangeError('Sparse cel patch requires matching canvas dimensions and tile size.');
    }
    const diff = diffSparseTiles(previous, next);
    const put = [...diff.added, ...diff.changed]
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map(tile => ({
        type: 'tile.put',
        x: tile.x, y: tile.y, width: tile.width, height: tile.height,
        sha256: tile.sha256, rgba: tile.rgba,
      }));
    const remove = [...diff.removed]
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map(tile => ({ type: 'tile.remove', x: tile.x, y: tile.y }));
    return {
      format: 'pixelforge-cel-patch',
      version: 1,
      projectId, baseRevision, operationId, frameId, layerId,
      canvas: { width: next.width, height: next.height, tileSize: next.tileSize },
      operations: [...put, ...remove],
      summary: { added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length },
    };
  }

  #documentForDiff(celId) {
    const cel = this.#cel(celId);
    return {
      format: PIXELFORGE_TILED_CEL_FORMAT,
      version: PIXELFORGE_TILED_CEL_VERSION,
      width: cel.width, height: cel.height, tileSize: cel.tileSize,
      tiles: [...cel.tiles.values()].map(tile => ({ x: tile.x, y: tile.y, sha256: tile.hash })),
    };
  }
}
