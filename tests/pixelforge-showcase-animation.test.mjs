import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrbitalShowcase } from '../public/pixelforge/src/showcase-animation.mjs';

const checksum = pixels => {
  let value = 0;
  for (let i = 0; i < pixels.length; i++) value = (value + pixels[i] * ((i % 65521) + 1)) % 1000000007;
  return value;
};

test('builds the complete 60-frame, 12 FPS soldier walk-to-crouch showcase', () => {
  const { doc, animation, loop } = createOrbitalShowcase();
  assert.equal(doc.name, 'Soldier reference · Walk to Crouch · 60 frames');
  assert.equal(doc.width, 128);
  assert.equal(doc.height, 160);
  assert.equal(doc.layers.length, 4);
  assert.deepEqual(doc.layers.map(layer => layer.name), [
    'Reference background',
    'Ground',
    'Soldier · reference-guided',
    'Lighting and contact'
  ]);
  assert.equal(animation.frameCount, 60);
  assert.equal(animation.fps, 12);
  assert.equal(animation.totalDurationMs, 5000);
  assert.equal(loop, true);
  assert.equal(doc.history.length, 0);
  assert.equal(doc.dirty, false);
  assert.ok(doc.composite().some(value => value !== 0));
  assert.deepEqual(animation.layerIds, doc.layers.map(layer => layer.id));
});

test('stores populated, independently editable raster cels for every layer and frame', () => {
  const { doc, animation } = createOrbitalShowcase();
  for (let frame = 0; frame < 60; frame++) {
    for (const layer of doc.layers) {
      const cel = animation.getLayerPixels(frame, layer.id);
      assert.equal(cel.length, 128 * 160 * 4);
      assert.ok(cel.some(value => value !== 0), layer.name + ' should contain pixels in frame ' + frame);
    }
  }
  const first = animation.getLayerPixels(0, doc.layers[2].id);
  const next = animation.getLayerPixels(1, doc.layers[2].id);
  const crouch = animation.getLayerPixels(16, doc.layers[2].id);
  assert.notEqual(checksum(first), checksum(next), 'the soldier must move between walking frames');
  assert.notEqual(checksum(next), checksum(crouch), 'the soldier must visibly transition into the crouch phase');
  const detail0 = animation.getLayerPixels(0, doc.layers[3].id);
  const detail4 = animation.getLayerPixels(4, doc.layers[3].id);
  assert.notEqual(checksum(detail0), checksum(detail4), 'lighting/contact details must animate independently');
});

test('returns isolated cel buffers so inspection cannot mutate the saved animation', () => {
  const { doc, animation } = createOrbitalShowcase();
  const layerId = doc.layers[2].id;
  const original = animation.getLayerPixels(0, layerId);
  const probe = original.findIndex(value => value !== 0);
  assert.notEqual(probe, -1);
  const savedValue = animation.getLayerPixels(0, layerId)[probe];
  original[probe] ^= 0xff;
  assert.equal(animation.getLayerPixels(0, layerId)[probe], savedValue);
});
