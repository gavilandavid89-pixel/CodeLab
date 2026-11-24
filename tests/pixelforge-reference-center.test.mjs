import test from 'node:test';
import assert from 'node:assert/strict';
import { HeadlessEditorRuntime } from '../public/pixelforge/src/headless.js';

function makeRuntime() {
  const runtime = new HeadlessEditorRuntime({ width: 16, height: 16, name: 'Reference package test' });
  assert.equal(runtime.execute({ name: 'canvas.draw_line', x0: 2, y0: 2, x1: 5, y1: 2, color: '#FFFFFF', size: 1 }).ok, true);
  assert.equal(runtime.execute({ name: 'layer.add', name: 'Body' }).ok, true);
  assert.equal(runtime.execute({ name: 'canvas.draw_line', x0: 4, y0: 4, x1: 8, y1: 8, color: '#FF0000', size: 1 }).ok, true);
  return runtime;
}

test('reference package snapshots pixels then leaves raster and animation clean', () => {
  const runtime = makeRuntime();
  const result = runtime.execute({ name: 'drawing.reference.package_current', cleanLayerName: 'Layer 1' });
  assert.equal(result.ok, true);
  assert.equal(runtime.sandbox.layers.length, 1);
  assert.equal(runtime.sandbox.layers[0].name, 'Layer 1');
  assert.equal(runtime.sandbox.layers[0].pixels.some(Boolean), false);
  assert.equal(runtime.inspect().animation.frameCount, 0);

  const reference = runtime.execute({ name: 'drawing.reference.get', referenceId: result.result.referenceId });
  assert.equal(reference.ok, true);
  assert.equal(reference.result.reference.immutableSnapshot, true);
  assert.equal(reference.result.reference.parts.length, 2);
  assert.equal(typeof reference.result.reference.parts[1].pixels, 'string');
});

test('reference center remains source of truth after editor is cleared', () => {
  const runtime = makeRuntime();
  const packaged = runtime.execute({ name: 'drawing.reference.package_current' });
  const restored = runtime.execute({
    name: 'drawing.reference.copy_part',
    referenceId: packaged.result.referenceId,
    partName: 'Body',
    layerName: 'Body restored',
  });
  assert.equal(restored.ok, true);
  assert.equal(runtime.sandbox.layers.length, 2);
  assert.equal(runtime.sandbox.layers.find(layer => layer.name === 'Body restored').pixels.some(Boolean), true);
});

test('copying a reference part creates an isolated editable layer without changing the canvas or master reference', () => {
  const runtime = makeRuntime();
  const packaged = runtime.execute({ name: 'drawing.reference.package_current' });
  assert.equal(packaged.ok, true);

  const masterBefore = runtime.execute({
    name: 'drawing.reference.get',
    referenceId: packaged.result.referenceId,
  });
  assert.equal(masterBefore.ok, true);
  const masterPartPixels = masterBefore.result.reference.parts.find(part => part.name === 'Body').pixels;
  assert.equal(typeof masterPartPixels, 'string');

  // Existing editor content must survive the copy as a separate layer.
  assert.equal(runtime.execute({
    name: 'canvas.draw_line',
    x0: 1, y0: 12, x1: 6, y1: 12, color: '#00AAFF', size: 1,
  }).ok, true);
  const existingLayer = runtime.sandbox.layers[0];
  const existingPixelsBefore = new Uint8Array(existingLayer.pixels);

  const copied = runtime.execute({
    name: 'drawing.reference.copy_part',
    referenceId: packaged.result.referenceId,
    partName: 'Body',
    layerName: 'Body copy',
  });
  assert.equal(copied.ok, true);
  assert.equal(runtime.sandbox.layers.length, 2);
  assert.deepEqual(runtime.sandbox.layers[0].pixels, existingPixelsBefore);

  const copiedLayer = runtime.sandbox.layers.find(layer => layer.name === 'Body copy');
  assert.ok(copiedLayer);
  assert.deepEqual(copiedLayer.pixels, Uint8Array.from(atob(masterPartPixels), char => char.charCodeAt(0)));
  assert.equal(Buffer.from(copiedLayer.pixels).some(Boolean), true);

  // Editing the materialized layer must not mutate the immutable Reference Center entry.
  assert.equal(runtime.execute({
    name: 'canvas.draw_line',
    x0: 10, y0: 10, x1: 14, y1: 10, color: '#00FF00', size: 1,
  }).ok, true);
  const masterAfter = runtime.execute({
    name: 'drawing.reference.get',
    referenceId: packaged.result.referenceId,
  });
  assert.equal(masterAfter.ok, true);
  assert.equal(masterAfter.result.reference.immutableSnapshot, true);
  assert.equal(masterAfter.result.reference.parts.find(part => part.name === 'Body').pixels, masterPartPixels);
});
