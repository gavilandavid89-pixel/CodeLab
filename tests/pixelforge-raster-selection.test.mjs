import test from 'node:test';
import assert from 'node:assert/strict';
import { RasterDocument } from '../public/pixelforge/src/core.js';

function makeDocument(width = 3, height = 3) {
  return new RasterDocument(width, height, 'Selection fill regression');
}

test('contiguous flood fill cannot cross unselected pixels to reach another selected island', () => {
  const doc = makeDocument();
  const mask = new Uint8Array(9);
  mask[3] = 1; // left-middle
  mask[5] = 1; // right-middle; connected only by traveling outside the selection
  doc.setSelectionMask(mask);

  assert.equal(doc.fillAt(0, 1, { color: '#ff0000' }), 1);
  assert.deepEqual([...doc.activeLayer.pixels.slice(12, 16)], [255, 0, 0, 255]);
  assert.deepEqual([...doc.activeLayer.pixels.slice(20, 24)], [0, 0, 0, 0]);
});

test('contiguous flood fill does nothing when its seed is outside the active selection', () => {
  const doc = makeDocument();
  const mask = new Uint8Array(9);
  mask[4] = 1;
  doc.setSelectionMask(mask);

  assert.equal(doc.fillAt(0, 0, { color: '#00ff00' }), 0);
  assert.deepEqual([...doc.activeLayer.pixels.slice(16, 20)], [0, 0, 0, 0]);
});

test('contiguous flood fill still fills connected pixels inside the active selection', () => {
  const doc = makeDocument();
  const mask = new Uint8Array(9);
  mask[3] = 1;
  mask[4] = 1;
  mask[5] = 1;
  doc.setSelectionMask(mask);

  assert.equal(doc.fillAt(0, 1, { color: '#0000ff' }), 3);
  for (const offset of [12, 16, 20]) {
    assert.deepEqual([...doc.activeLayer.pixels.slice(offset, offset + 4)], [0, 0, 255, 255]);
  }
});
