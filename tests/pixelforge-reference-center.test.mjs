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
