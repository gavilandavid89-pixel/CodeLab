import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrbitalShowcase } from '../public/pixelforge/src/showcase-animation.mjs';

test('builds a complete 18-frame walk-to-crouch animation with independent raster layers', () => {
  const { doc, animation, loop } = createOrbitalShowcase();
  assert.equal(doc.name, 'Person · Walk to Crouch · 18-frame study');
  assert.equal(doc.width, 96);
  assert.equal(doc.height, 120);
  assert.equal(doc.layers.length, 4);
  assert.equal(doc.history.length, 0, 'the demo should open with a clean undo history');
  assert.equal(doc.dirty, false, 'the freshly generated demo should be ready to save without phantom edits');
  assert.ok(doc.composite().some(value => value !== 0), 'the actual editor canvas should render the generated artwork');
  assert.deepEqual(doc.layers.map(layer => layer.name), ['Twilight background', 'Ground', 'Character', 'Lighting details']);
  assert.equal(animation.frameCount, 18);
  assert.equal(animation.fps, 12);
  assert.equal(loop, true);
  assert.ok(Math.abs(animation.totalDurationMs - 1500) < 0.001, '18 frames at 12 FPS should last 1.5 seconds');
  assert.deepEqual(animation.layerIds, doc.layers.map(layer => layer.id));
  for (let frame = 0; frame < 18; frame++) {
    for (const layer of doc.layers) {
      const cel = animation.getLayerPixels(frame, layer.id);
      assert.equal(cel.length, 96 * 120 * 4);
      assert.ok(cel.some(value => value !== 0), layer.name + ' should have visible pixels in frame ' + frame);
    }
  }
  const firstCharacter = animation.getLayerPixels(0, doc.layers[2].id);
  const secondCharacter = animation.getLayerPixels(1, doc.layers[2].id);
  const crouchCharacter = animation.getLayerPixels(12, doc.layers[2].id);
  assert.notDeepEqual(firstCharacter, secondCharacter, 'character cel should move between walk frames');
  assert.notDeepEqual(secondCharacter, crouchCharacter, 'character cel should visibly change into the crouch phase');
  const firstDetails = animation.getLayerPixels(0, doc.layers[3].id);
  const thirdDetails = animation.getLayerPixels(2, doc.layers[3].id);
  assert.notDeepEqual(firstDetails, thirdDetails, 'lighting/details cel should animate independently');
  const probe = firstCharacter.findIndex(value => value !== 0);
  const original = firstCharacter[probe];
  firstCharacter[probe] = original ^ 0xff;
  assert.equal(animation.getLayerPixels(0, doc.layers[2].id)[probe], original,
    'returned cel data must be isolated from the saved animation');
});

test('serializes the showcase as a valid editable PixelForge project payload', () => {
  const { doc, animation, loop } = createOrbitalShowcase();
  const snapshot = doc.toJSON();
  snapshot.animation = { ...animation.toJSON(), loop };
  assert.equal(snapshot.format, 'pixelforge-project');
  assert.equal(snapshot.animation.format, 'pixelforge-animation');
  assert.equal(snapshot.animation.frames.length, 18);
  assert.equal(snapshot.animation.layerIds.length, 4);
  assert.ok(snapshot.layers.every(layer => typeof layer.pixels === 'string'));
  assert.ok(snapshot.animation.frames.every(frame => frame.cels.length === 4));
});
