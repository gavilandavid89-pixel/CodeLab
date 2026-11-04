import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrbitalShowcase } from '../public/pixelforge/src/showcase-animation.mjs';

test('builds a complete 12-frame orbital animation with independent raster layers', () => {
  const { doc, animation, loop } = createOrbitalShowcase();
  assert.equal(doc.name, 'Orbital · PixelForge 12-frame loop');
  assert.equal(doc.width, 96);
  assert.equal(doc.height, 96);
  assert.equal(doc.layers.length, 4);
  assert.deepEqual(doc.layers.map(layer => layer.name), ['Deep space', 'Starlight', 'Ion thruster', 'Explorer']);
  assert.equal(animation.frameCount, 12);
  assert.equal(animation.fps, 12);
  assert.equal(loop, true);
  assert.ok(Math.abs(animation.totalDurationMs - 1000) < 0.001, '12 frames at 12 FPS should last one second');
  assert.deepEqual(animation.layerIds, doc.layers.map(layer => layer.id));
  for (let frame = 0; frame < 12; frame++) {
    for (const layer of doc.layers) {
      const cel = animation.getLayerPixels(frame, layer.id);
      assert.equal(cel.length, 96 * 96 * 4);
      assert.ok(cel.some(value => value !== 0), layer.name + ' should have visible pixels in frame ' + frame);
    }
  }
  const firstShip = animation.getLayerPixels(0, doc.layers[3].id);
  const secondShip = animation.getLayerPixels(1, doc.layers[3].id);
  assert.notDeepEqual(firstShip, secondShip, 'ship cel should move between frames');
  const firstFlame = animation.getLayerPixels(0, doc.layers[2].id);
  const thirdFlame = animation.getLayerPixels(2, doc.layers[2].id);
  assert.notDeepEqual(firstFlame, thirdFlame, 'thruster cel should animate independently');
  const probe = firstShip.findIndex(value => value !== 0);
  const original = firstShip[probe];
  firstShip[probe] = original ^ 0xff;
  assert.equal(animation.getLayerPixels(0, doc.layers[3].id)[probe], original,
    'returned cel data must be isolated from the saved animation');
});

test('serializes the showcase as a valid editable PixelForge project payload', () => {
  const { doc, animation, loop } = createOrbitalShowcase();
  const snapshot = doc.toJSON();
  snapshot.animation = { ...animation.toJSON(), loop };
  assert.equal(snapshot.format, 'pixelforge-project');
  assert.equal(snapshot.animation.format, 'pixelforge-animation');
  assert.equal(snapshot.animation.frames.length, 12);
  assert.equal(snapshot.animation.layerIds.length, 4);
  assert.ok(snapshot.layers.every(layer => typeof layer.pixels === 'string'));
  assert.ok(snapshot.animation.frames.every(frame => frame.cels.length === 4));
});
