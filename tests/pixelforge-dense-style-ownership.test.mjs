import test from 'node:test';
import assert from 'node:assert/strict';
import { RasterDocument } from '../public/pixelforge/src/core.js';
import { PixelForgeAnimation } from '../public/pixelforge/src/animation.mjs';

test('dense brush and eraser enforce both directions of per-pixel style ownership', () => {
  const doc = new RasterDocument(8, 8);
  const layer = doc.activeLayer;
  const pixel = layer.pixels.slice(0, 4);
  layer.authoringMode = 'pixel-art';
  let stroke = doc.beginStroke({ color: '#ff0000', size: 1, mode: 'draw' });
  doc.strokeTo(stroke, 2, 2); doc.endStroke(stroke);
  assert.deepEqual([...layer.ownershipTiles.get('0:0')], [...new Uint8Array(64).map((_, i) => i === 18 ? 2 : 0)]);
  const red = [...layer.pixels.slice((2 * 8 + 2) * 4, (2 * 8 + 2) * 4 + 4)];
  layer.authoringMode = 'illustration';
  stroke = doc.beginStroke({ color: '#00ff00', size: 1, mode: 'draw' });
  doc.strokeTo(stroke, 2, 2); doc.endStroke(stroke);
  assert.deepEqual([...layer.pixels.slice((2 * 8 + 2) * 4, (2 * 8 + 2) * 4 + 4)], red);
  stroke = doc.beginStroke({ size: 1, mode: 'erase' });
  doc.strokeTo(stroke, 2, 2); doc.endStroke(stroke);
  assert.deepEqual([...layer.pixels.slice((2 * 8 + 2) * 4, (2 * 8 + 2) * 4 + 4)], red);
  layer.authoringMode = 'pixel-art';
  stroke = doc.beginStroke({ size: 1, mode: 'erase' });
  doc.strokeTo(stroke, 2, 2); doc.endStroke(stroke);
  assert.deepEqual([...layer.pixels.slice((2 * 8 + 2) * 4, (2 * 8 + 2) * 4 + 4)], [0, 0, 0, 0]);
  assert.equal(layer.ownershipTiles.size, 0);
  layer.authoringMode = 'illustration';
  stroke = doc.beginStroke({ color: '#00ff00', size: 1, mode: 'draw' });
  doc.strokeTo(stroke, 2, 2); doc.endStroke(stroke);
  layer.authoringMode = 'pixel-art';
  stroke = doc.beginStroke({ color: '#0000ff', size: 1, mode: 'draw' });
  doc.strokeTo(stroke, 2, 2); doc.endStroke(stroke);
  assert.deepEqual([...layer.pixels.slice((2 * 8 + 2) * 4, (2 * 8 + 2) * 4 + 4)], [0, 255, 0, 255]);
  assert.equal(layer.ownershipTiles.get('0:0')[18], 1);
  void pixel;
});

test('dense ownership survives undo, redo, and native JSON round-trip; legacy JSON remains unowned', () => {
  const doc = new RasterDocument(8, 8);
  const layer = doc.activeLayer; layer.authoringMode = 'illustration';
  const stroke = doc.beginStroke({ color: '#123456', size: 1 });
  doc.strokeTo(stroke, 4, 4); doc.endStroke(stroke);
  assert.equal(layer.ownershipTiles.get('0:0')[36], 1);
  doc.undo(); assert.equal(layer.ownershipTiles.size, 0);
  doc.redo(); assert.equal(layer.ownershipTiles.get('0:0')[36], 1);
  const manifest = doc.toJSON();
  const restored = RasterDocument.fromJSON(manifest);
  assert.equal(restored.activeLayer.ownershipTiles.get('0:0')[36], 1);
  const legacy = structuredClone(manifest); delete legacy.layers[0].ownershipTiles;
  const legacyRestored = RasterDocument.fromJSON(legacy);
  assert.equal(legacyRestored.activeLayer.ownershipTiles.size, 0);
});

test('dense bucket fill, gradient and AI batch replacement respect foreign style ownership', () => {
  const doc = new RasterDocument(8, 8);
  const layer = doc.activeLayer; layer.authoringMode = 'pixel-art';
  assert.equal(doc.fillAt(0, 0, { color: '#ff0000' }), 64);
  assert.ok([...layer.ownershipTiles.get('0:0')].every(owner => owner === 2));
  layer.authoringMode = 'illustration';
  assert.equal(doc.fillAt(0, 0, { color: '#00ff00' }), 0);
  assert.equal(doc.fillGradient(0, 0, 7, 7, { startColor: '#0000ff', endColor: '#ffffff' }), 0);
  const replacement = new Uint8ClampedArray(8 * 8 * 4);
  for (let i = 0; i < replacement.length; i += 4) replacement.set([0, 255, 0, 255], i);
  doc.replaceLayerPixelsBatch([{ layerId: layer.id, pixels: replacement }]);
  assert.deepEqual([...layer.pixels.slice(0, 4)], [255, 0, 0, 255]);
  assert.ok([...layer.ownershipTiles.get('0:0')].every(owner => owner === 2));
});

test('dense animation frame cloning and JSON retain each layer pixel ownership plane', () => {
  const doc = new RasterDocument(8, 8);
  const layer = doc.activeLayer; layer.authoringMode = 'illustration';
  const stroke = doc.beginStroke({ color: '#123456', size: 1 });
  doc.strokeTo(stroke, 1, 1); doc.endStroke(stroke);
  const animation = PixelForgeAnimation.fromDocument(doc);
  animation.addFrame({ duplicate: true });
  assert.equal(animation.getLayerOwnershipTiles(1, layer.id).get('0:0')[9], 1);
  const restored = PixelForgeAnimation.fromJSON(animation.toJSON());
  const frameOwners = restored.getLayerOwnershipTiles(1, layer.id);
  assert.equal(frameOwners.get('0:0')[9], 1);
  const framePixels = restored.getLayerPixels(1, layer.id);
  doc.replaceLayerPixelsBatch([{ layerId: layer.id, pixels: framePixels }], { restore: true, ownershipByLayer: new Map([[layer.id, frameOwners]]) });
  assert.equal(doc.activeLayer.ownershipTiles.get('0:0')[9], 1);
});


test('dense restore APIs require exact owner snapshots and reject transparent owner metadata on load', () => {
  const doc = new RasterDocument(8, 8);
  const layer = doc.activeLayer;
  layer.authoringMode = 'illustration';
  const stroke = doc.beginStroke({ color: '#123456', size: 1 });
  doc.strokeTo(stroke, 2, 2); doc.endStroke(stroke);
  const blank = new Uint8ClampedArray(8 * 8 * 4);
  assert.throws(
    () => doc.setLayerPixels(layer.id, blank, { restore: true }),
    /exact ownership snapshot/
  );
  assert.throws(
    () => doc.replaceLayerPixelsBatch([{ layerId: layer.id, pixels: blank }], { restore: true }),
    /exact ownership snapshot/
  );
  assert.deepEqual([...layer.pixels.slice((2 * 8 + 2) * 4, (2 * 8 + 2) * 4 + 4)], [18, 52, 86, 255]);
  const serialized = doc.toJSON();
  const pixels = Buffer.from(serialized.layers[0].pixels, 'base64');
  pixels[(2 * 8 + 2) * 4 + 3] = 0;
  serialized.layers[0].pixels = pixels.toString('base64');
  assert.throws(() => RasterDocument.fromJSON(serialized), /Transparent pixels cannot retain style ownership/);
});
