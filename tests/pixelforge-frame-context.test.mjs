import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeadlessRuntime } from '../public/pixelforge/src/headless.js';

test('animation frame context returns authoritative previous cel and visual payload', () => {
  const runtime = createHeadlessRuntime({ width: 16, height: 16, name: 'context-test' });
  assert.equal(runtime.execute({ name: 'animation.frame.capture_document', frameName: 'Frame 1' }).ok, true);
  assert.equal(runtime.execute({ name: 'animation.frame.duplicate', index: 0 }).ok, true);
  const context = runtime.execute({ name: 'animation.frame.get_context', index: 1 });
  assert.equal(context.ok, true);
  assert.equal(context.result.previous.index, 0);
  assert.equal(context.result.previous.cel.length, Math.ceil((16 * 16 * 4) / 3) * 4);
  assert.equal(context.result.visual.format, 'rgba-base64');
  assert.equal(context.result.visual.width, 16);
  assert.equal(context.result.visual.height, 16);
  assert.equal(context.result.guidance.requestMoreContextAction, 'animation.frame.get_context');
  assert.equal(context.result.change.changedPixels, 0);
});


test('layer context returns the previous layer as authoritative visual context', () => {
  const runtime = createHeadlessRuntime({ width: 8, height: 8, name: 'layer-context-test' });
  const added = runtime.execute({ name: 'layer.add', layerName: 'Detail' });
  assert.equal(added.ok, true);
  const activeLayerId = runtime.sandbox.activeLayerId;
  assert.ok(runtime.sandbox.layers.some(layer => layer.id === activeLayerId && layer.name === 'Detail'));
  const context = runtime.execute({ name: 'layer.get_context', layerId: activeLayerId });
  assert.equal(context.ok, true, JSON.stringify({ added, activeLayerId, layers: runtime.sandbox.layers.map(layer => ({ id: layer.id, name: layer.name })), context }));
  assert.equal(context.result.current.name, 'Detail');
  assert.equal(context.result.previous.name, 'Layer 1');
  assert.equal(context.result.visual.format, 'rgba-base64');
  assert.equal(Buffer.from(context.result.current.pixels, 'base64').length, 8 * 8 * 4);
  assert.equal(Buffer.from(context.result.previous.pixels, 'base64').length, 8 * 8 * 4);
  assert.equal(context.result.guidance.requestMoreContextAction, 'layer.get_context');
});
