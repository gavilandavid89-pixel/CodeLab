import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  encodeSparseTiles, decodeSparseTiles, diffSparseTiles,
  DEFAULT_CEL_TILE_SIZE,
} from '../public/pixelforge/src/animation-tiles.mjs';

globalThis.crypto ||= webcrypto;

function makePixels(width, height) {
  return new Uint8ClampedArray(width * height * 4);
}

test('sparse tiled cel omits empty tiles and round-trips exact RGBA bytes', async () => {
  const width = 130, height = 70;
  const pixels = makePixels(width, height);
  // Pixel in a full tile.
  pixels.set([12, 34, 56, 255], (5 * width + 7) * 4);
  // Non-zero RGB with zero alpha must also survive an exact round trip.
  pixels.set([9, 8, 7, 0], (69 * width + 129) * 4);
  const cel = await encodeSparseTiles(pixels, { width, height });
  assert.equal(cel.tileSize, DEFAULT_CEL_TILE_SIZE);
  assert.equal(cel.tiles.length, 2);
  assert.deepEqual(await decodeSparseTiles(cel), pixels);
});

test('sparse tile edge dimensions and empty canvas decode correctly', async () => {
  const width = 65, height = 33;
  const pixels = makePixels(width, height);
  const cel = await encodeSparseTiles(pixels, { width, height, tileSize: 32 });
  assert.equal(cel.tiles.length, 0);
  assert.deepEqual(await decodeSparseTiles(cel), pixels);
  pixels.set([1, 2, 3, 4], (32 * width + 64) * 4);
  const edge = await encodeSparseTiles(pixels, { width, height, tileSize: 32 });
  assert.equal(edge.tiles.length, 1);
  assert.deepEqual([edge.tiles[0].width, edge.tiles[0].height], [1, 1]);
  assert.deepEqual(await decodeSparseTiles(edge), pixels);
});

test('tile diff reports only changed, added, and removed tile coordinates', async () => {
  const width = 128, height = 128;
  const beforePixels = makePixels(width, height);
  beforePixels.set([10, 20, 30, 255], 0);
  beforePixels.set([40, 50, 60, 255], (64 * width + 64) * 4);
  const afterPixels = new Uint8ClampedArray(beforePixels);
  afterPixels.set([11, 21, 31, 255], 0);
  afterPixels.fill(0, (64 * width + 64) * 4, (64 * width + 64) * 4 + 4);
  afterPixels.set([70, 80, 90, 255], (0 * width + 64) * 4);
  const before = await encodeSparseTiles(beforePixels, { width, height });
  const after = await encodeSparseTiles(afterPixels, { width, height });
  const diff = diffSparseTiles(before, after);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.added.length, 1);
  assert.deepEqual(diff.removed, [{ x: 64, y: 64 }]);
});

test('decoder rejects duplicate coordinates and corrupted tile hashes', async () => {
  const pixels = makePixels(128, 64);
  pixels.set([1, 2, 3, 255], 0);
  const cel = await encodeSparseTiles(pixels, { width: 128, height: 64 });
  await assert.rejects(() => decodeSparseTiles({ ...cel, tiles: [...cel.tiles, cel.tiles[0]] }), /duplicate/);
  const corrupt = structuredClone(cel);
  corrupt.tiles[0].rgba = corrupt.tiles[0].rgba.replace(/^./, corrupt.tiles[0].rgba[0] === 'A' ? 'B' : 'A');
  await assert.rejects(() => decodeSparseTiles(corrupt), /integrity/);
});

test('tile codec validates dimensions and tile sizes', async () => {
  await assert.rejects(() => encodeSparseTiles(new Uint8Array(4), { width: 1, height: 1, tileSize: 16 }), /Tile size/);
  await assert.rejects(() => encodeSparseTiles(new Uint8Array(4), { width: 0, height: 1 }), /dimensions/);
});
