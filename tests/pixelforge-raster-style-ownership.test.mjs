import test from 'node:test';
import assert from 'node:assert/strict';
import { guardStyleOwnedPixels, PIXEL_STYLE_OWNER } from '../public/pixelforge/src/raster-style-ownership.mjs';

function rgba(...pixels) { return new Uint8ClampedArray(pixels.flat()); }

test('illustration cannot paint over pixel-art-owned pixels and claims unowned pixels', () => {
  const before = rgba([10, 20, 30, 255], [0, 0, 0, 0], [40, 50, 60, 255]);
  const after = rgba([200, 0, 0, 255], [0, 200, 0, 255], [80, 90, 100, 255]);
  const owners = new Uint8Array([PIXEL_STYLE_OWNER.PIXEL_ART, 0, PIXEL_STYLE_OWNER.ILLUSTRATION]);
  const result = guardStyleOwnedPixels({ before, after, owners, authoringMode: 'illustration' });
  assert.deepEqual([...result.pixels], [...rgba([10, 20, 30, 255], [0, 200, 0, 255], [80, 90, 100, 255])]);
  assert.deepEqual([...result.owners], [2, 1, 1]);
  assert.equal(result.blockedPixels, 1);
  assert.equal(result.changedPixels, 2);
});

test('pixel art cannot erase illustration-owned pixels but can erase its own pixels', () => {
  const before = rgba([1, 2, 3, 255], [4, 5, 6, 255], [7, 8, 9, 255]);
  const after = rgba([0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]);
  const owners = new Uint8Array([1, 2, 0]);
  const result = guardStyleOwnedPixels({ before, after, owners, authoringMode: 'pixel-art', operation: 'erase' });
  assert.deepEqual([...result.pixels], [...rgba([1, 2, 3, 255], [0, 0, 0, 0], [7, 8, 9, 255])]);
  assert.deepEqual([...result.owners], [1, 0, 0]);
  assert.equal(result.blockedPixels, 2);
});

test('same-style edits remain allowed and transparent results release ownership', () => {
  const before = rgba([10, 20, 30, 255]);
  const after = rgba([50, 60, 70, 0]);
  const result = guardStyleOwnedPixels({ before, after, owners: new Uint8Array([1]), authoringMode: 'illustration' });
  assert.deepEqual([...result.pixels], [50, 60, 70, 0]);
  assert.deepEqual([...result.owners], [0]);
  assert.equal(result.blockedPixels, 0);
});

test('history restore bypasses style blocking and preserves the supplied owner snapshot exactly', () => {
  const before = rgba([1, 2, 3, 255]);
  const after = rgba([9, 8, 7, 0]);
  const result = guardStyleOwnedPixels({ before, after, owners: new Uint8Array([2]), authoringMode: 'illustration', operation: 'restore' });
  assert.deepEqual([...result.pixels], [9, 8, 7, 0]);
  assert.deepEqual([...result.owners], [2]);
  assert.equal(result.blockedPixels, 0);
});

test('invalid owner values and missing authoring mode are rejected', () => {
  const pixels = rgba([0, 0, 0, 0]);
  assert.throws(() => guardStyleOwnedPixels({ before: pixels, after: pixels, owners: new Uint8Array([3]), authoringMode: 'illustration' }), /unsupported owner/i);
  assert.throws(() => guardStyleOwnedPixels({ before: pixels, after: pixels, owners: new Uint8Array([0]) }), /authoringMode/i);
});
