import test from 'node:test';
import assert from 'node:assert/strict';
import { HeadlessEditorRuntime } from '../public/pixelforge/src/headless.js';
import { copyReferencePixelsToActiveFrameLayer } from '../public/pixelforge/src/drawing-intelligence.js';

function makeRuntime() {
  const runtime = new HeadlessEditorRuntime({ width: 16, height: 16, name: 'Reference package test' });
  assert.equal(runtime.execute({ name: 'canvas.draw_line', x0: 2, y0: 2, x1: 5, y1: 2, color: '#FFFFFF', size: 1 }).ok, true);
  assert.equal(runtime.execute({ name: 'layer.add', layerName: 'Body' }).ok, true);
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
  assert.equal(runtime.sandbox.layers.length, 1);
  assert.equal(runtime.sandbox.layers[0].id, runtime.sandbox.activeLayerId);
  assert.equal(runtime.sandbox.layers[0].pixels.some(Boolean), true);
});

test('copying a reference part replaces only the active layer pixels and preserves the master reference', () => {
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

  // Copying replaces pixels in the selected layer without creating or deleting layers.
  assert.equal(runtime.execute({
    name: 'canvas.draw_line',
    x0: 1, y0: 12, x1: 6, y1: 12, color: '#00AAFF', size: 1,
  }).ok, true);
  const activeLayerId = runtime.sandbox.activeLayerId;

  const copied = runtime.execute({
    name: 'drawing.reference.copy_part',
    referenceId: packaged.result.referenceId,
    partName: 'Body',
  });
  assert.equal(copied.ok, true);
  assert.equal(runtime.sandbox.layers.length, 1);
  assert.equal(runtime.sandbox.activeLayerId, activeLayerId);
  const copiedLayer = runtime.sandbox.layers[0];
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


test('reference copy writes only to the active frame-layer and preserves the timeline and layer stack', () => {
  const sourcePixels = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255]);
  const activeLayer = { id: 'layer-active', locked: false, pixels: new Uint8Array(8) };
  const otherLayer = { id: 'layer-other', locked: false, pixels: new Uint8Array(8).fill(7) };
  const layers = [activeLayer, otherLayer];
  const writes = [];
  const drawingDocument = {
    width: 2,
    height: 1,
    layers,
    activeLayer,
    dirty: false,
    setLayerPixels(layerId, pixels) {
      const target = layers.find(layer => layer.id === layerId);
      assert.ok(target);
      target.pixels = new Uint8Array(pixels);
      writes.push({ layerId, pixels: new Uint8Array(pixels) });
    },
  };
  const animationWrites = [];
  const animation = {
    activeFrameIndex: 4,
    setLayerPixels(frameIndex, layerId, pixels) {
      animationWrites.push({ frameIndex, layerId, pixels: new Uint8Array(pixels) });
    },
  };

  const result = copyReferencePixelsToActiveFrameLayer({ drawingDocument, animation, pixels: sourcePixels });
  assert.deepEqual(result, { layerId: 'layer-active', frameIndex: 4, copiedBytes: 8 });
  assert.equal(drawingDocument.layers.length, 2);
  assert.deepEqual(activeLayer.pixels, sourcePixels);
  assert.deepEqual(otherLayer.pixels, new Uint8Array(8).fill(7));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].layerId, 'layer-active');
  assert.equal(animationWrites.length, 1);
  assert.equal(animationWrites[0].frameIndex, 4);
  assert.equal(animationWrites[0].layerId, 'layer-active');
  assert.deepEqual(animationWrites[0].pixels, sourcePixels);
  assert.equal(drawingDocument.dirty, true);
});

test('reference copy refuses a locked active layer without mutating the document or animation', () => {
  const activeLayer = { id: 'locked-layer', locked: true, pixels: new Uint8Array(4) };
  const drawingDocument = {
    width: 1, height: 1, activeLayer, dirty: false,
    setLayerPixels() { throw new Error('must not write'); },
  };
  let animationWrites = 0;
  const animation = {
    activeFrameIndex: 0,
    setLayerPixels() { animationWrites++; },
  };
  assert.throws(
    () => copyReferencePixelsToActiveFrameLayer({
      drawingDocument, animation, pixels: new Uint8Array([1, 2, 3, 4]),
    }),
    /locked/,
  );
  assert.equal(animationWrites, 0);
  assert.equal(drawingDocument.dirty, false);
});
