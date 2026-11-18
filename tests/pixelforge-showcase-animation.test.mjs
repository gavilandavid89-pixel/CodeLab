import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrbitalShowcase, createSoldierReferenceAnimation } from '../public/pixelforge/src/showcase-animation.mjs';

test('builds a complete 24-frame walk-to-crouch animation with independent raster layers', () => {
  const { doc, animation, loop } = createOrbitalShowcase();
  assert.equal(doc.name, 'Soldier reference · Walk to Crouch · 24 frames');
  assert.equal(doc.width, 128);
  assert.equal(doc.height, 160);
  assert.equal(doc.layers.length, 4);
  assert.equal(doc.history.length, 0, 'the demo should open with a clean undo history');
  assert.equal(doc.dirty, false, 'the freshly generated demo should be ready to save without phantom edits');
  assert.ok(doc.composite().some(value => value !== 0), 'the actual editor canvas should render the generated artwork');
  assert.deepEqual(doc.layers.map(layer => layer.name), ['Reference background', 'Ground', 'Soldier · reference-guided', 'Lighting and contact']);
  assert.equal(animation.frameCount, 24);
  assert.equal(animation.fps, 16);
  assert.equal(loop, true);
  assert.ok(Math.abs(animation.totalDurationMs - 1500) < 0.001, '24 frames at 16 FPS should last 1.5 seconds');
  assert.deepEqual(animation.layerIds, doc.layers.map(layer => layer.id));
  for (let frame = 0; frame < 24; frame++) {
    for (const layer of doc.layers) {
      const cel = animation.getLayerPixels(frame, layer.id);
      assert.equal(cel.length, 128 * 160 * 4);
      assert.ok(cel.some(value => value !== 0), layer.name + ' should have visible pixels in frame ' + frame);
    }
  }
  const checksum = pixels => { let n = 0; for (let i = 0; i < pixels.length; i++) n = (n + pixels[i] * ((i % 65521) + 1)) % 1000000007; return n; };
  const firstCharacter = animation.getLayerPixels(0, doc.layers[2].id);
  const secondCharacter = animation.getLayerPixels(1, doc.layers[2].id);
  const crouchCharacter = animation.getLayerPixels(20, doc.layers[2].id);
  assert.notEqual(checksum(firstCharacter), checksum(secondCharacter), 'character cel should move between walk frames');
  assert.notEqual(checksum(secondCharacter), checksum(crouchCharacter), 'character cel should visibly change into the crouch phase');
  const firstDetails = animation.getLayerPixels(0, doc.layers[3].id);
  const thirdDetails = animation.getLayerPixels(2, doc.layers[3].id);
  assert.notEqual(checksum(firstDetails), checksum(thirdDetails), 'lighting/details cel should animate independently');
  const probe = firstCharacter.findIndex(value => value !== 0);
  const original = firstCharacter[probe];
  firstCharacter[probe] = original ^ 0xff;
  assert.equal(animation.getLayerPixels(0, doc.layers[2].id)[probe], original,
    'returned cel data must be isolated from the saved animation');
});

test('keeps the showcase timeline metadata editable without forcing a huge raster serialization in the contract test', () => {
  const { doc, animation, loop } = createOrbitalShowcase();
  assert.equal(animation.frameCount, 24);
  assert.equal(animation.fps, 16);
  assert.equal(animation.layerIds.length, doc.layers.length);
  assert.equal(loop, true);
  assert.equal(animation.totalDurationMs, 1500);
  for (let frameIndex = 0; frameIndex < 24; frameIndex++) {
    const frame = animation.getFrame(frameIndex);
    assert.equal(frame.index, frameIndex);
    for (const layerId of doc.layers.map(layer => layer.id)) {
      assert.equal(animation.getLayerPixels(frameIndex, layerId).length, 128 * 160 * 4);
    }
  }
});


test('soldier reference starts a real animation project and exposes previous-frame context', () => {
  const { doc, animation, workflow } = createSoldierReferenceAnimation();
  assert.equal(doc.width, 64);
  assert.equal(doc.height, 120);
  assert.equal(animation.frameCount, 1);
  assert.equal(doc.layers[0].name, 'Soldier reference · initial');
  assert.equal(workflow.mode, 'reference-guided');
  assert.equal(workflow.nextAction, 'animation.frame.get_context');
  const pixels = animation.getLayerPixels(0, doc.layers[0].id);
  assert.ok(pixels.some((value) => value !== 0), 'reference frame must contain raster data');
});
