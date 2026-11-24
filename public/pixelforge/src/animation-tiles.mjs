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
