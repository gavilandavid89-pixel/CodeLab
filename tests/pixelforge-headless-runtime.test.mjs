import test from 'node:test';
import assert from 'node:assert/strict';
import { HeadlessEditorRuntime } from '../public/pixelforge/src/headless.js';
import { frameAtAnimationTime, exportAnimationSpriteSheet } from '../public/pixelforge/src/animation.js';

function projectFixture() {
  const runtime = new HeadlessEditorRuntime({ width: 16, height: 16, name: 'Headless fixture' });
  return runtime.toJSON();
}

test('headless runtime opens a persisted PixelForge project without changing its identity', () => {
  const fixture = projectFixture();
  fixture.serverRevision = 7;
  const runtime = HeadlessEditorRuntime.fromJSON(fixture);
  const state = runtime.inspect();
  assert.equal(state.project.id, fixture.id);
  assert.equal(state.project.serverRevision, 7);
  assert.equal(state.project.width, 16);
  assert.equal(state.project.layerCount, 1);
  assert.equal(state.sandbox.hasChanges, false);
});

test('headless batch edits an isolated sandbox and commits only after proposal acceptance', () => {
  const fixture = projectFixture();
  const runtime = HeadlessEditorRuntime.fromJSON(fixture);
  const before = runtime.toJSON();
  const batch = runtime.executeBatch([
    { name: 'canvas.draw_line', x0: 1, y0: 2, x1: 10, y1: 2, color: '#FF3300', size: 1 },
    { name: 'canvas.fill', x: 1, y: 2, color: '#00AA44', tolerance: 0, contiguous: true },
  ]);
  assert.equal(batch.ok, true);
  assert.equal(runtime.hasPendingChanges, true);
  assert.deepEqual(runtime.document.toJSON(), before, 'source document must remain untouched before review');
  assert.throws(() => runtime.toJSON(), /Unreviewed sandbox changes/);
  const proposal = runtime.createProposal('Draw a line and fill the connected area');
  assert.ok(proposal.id);
  assert.equal(runtime.acceptProposal().status, 'applied');
  assert.equal(runtime.hasPendingChanges, false);
  const saved = runtime.toJSON();
  assert.equal(saved.id, fixture.id);
  assert.ok(saved.revision > fixture.revision);
  assert.ok(saved.layers[0].pixels !== fixture.layers[0].pixels);
});

test('headless batch stops at first invalid action and never creates a proposal implicitly', () => {
  const runtime = HeadlessEditorRuntime.fromJSON(projectFixture());
  const result = runtime.executeBatch([
    { name: 'canvas.draw_line', x0: 0, y0: 0, x1: 3, y1: 0, color: '#112233' },
    { name: 'canvas.get_pixel', x: 99, y: 99 },
    { name: 'history.undo' },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.failedIndex, 1);
  assert.equal(result.results.length, 2);
  assert.equal(runtime.hasPendingChanges, true);
  assert.equal(runtime.hasPendingProposal, false);
});

test('headless proposal rejects a stale source revision', () => {
  const runtime = HeadlessEditorRuntime.fromJSON(projectFixture());
  assert.equal(runtime.execute({ name: 'canvas.draw_line', x0: 1, y0: 1, x1: 5, y1: 1, color: '#123456' }).ok, true);
  runtime.createProposal('Stale proposal');
  runtime.document.setLayerOpacity(runtime.document.activeLayerId, 0.5);
  const result = runtime.acceptProposal();
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'stale-base');
});

test('headless structural layer changes are reviewed and committed as one undoable source transaction', () => {
  const runtime = HeadlessEditorRuntime.fromJSON(projectFixture());
  const batch = runtime.executeBatch([
    { name: 'layer.add', layerName: 'Ink' },
  ]);
  assert.equal(batch.ok, true);
  assert.equal(runtime.inspect().sandbox.layerCount, 2);
  runtime.createProposal('Add an ink layer');
  const accepted = runtime.acceptProposal();
  assert.equal(accepted.status, 'applied');
  assert.equal(runtime.document.layers.length, 2);
  assert.equal(runtime.document.layers[1].name, 'Ink');
  assert.equal(runtime.document.undo(), true);
  assert.equal(runtime.document.layers.length, 1);
  assert.equal(runtime.document.redo(), true);
  assert.equal(runtime.document.layers.length, 2);
});

test('headless layer selection advances the sandbox revision and is proposal-visible', () => {
  const runtime = HeadlessEditorRuntime.fromJSON(projectFixture());
  const originalLayerId = runtime.document.activeLayerId;
  const sandboxOriginalLayerId = runtime.sandbox.layers[0].id;
  const added = runtime.execute({ name: 'layer.add', layerName: 'Color' });
  assert.equal(added.ok, true);
  const layerId = added.result.layerId;
  const selected = runtime.execute({ name: 'layer.select', layerId: sandboxOriginalLayerId });
  assert.equal(selected.ok, true);
  assert.equal(runtime.hasPendingChanges, true);
  runtime.createProposal('Add Color layer and select the original layer');
  assert.equal(runtime.acceptProposal().status, 'applied');
  assert.equal(runtime.document.activeLayerId, originalLayerId);
  assert.ok(runtime.document.layers.some(layer => layer.id === layerId));
});

test('headless brush actions validate points and keep edits in the sandbox', () => {
  const runtime = HeadlessEditorRuntime.fromJSON(projectFixture());
  const result = runtime.execute({
    name: 'canvas.draw_stroke',
    points: [{ x: 2, y: 2 }, { x: 3, y: 3 }, { x: 4, y: 4 }],
    color: '#CC2288', size: 3, opacity: 0.75, shape: 'circle', hardness: 0.6,
  });
  assert.equal(result.ok, true);
  assert.equal(runtime.hasPendingChanges, true);
  assert.equal(runtime.document.revision, 0);
});

test('animation-only edits require proposal acceptance and persist as project timeline metadata', () => {
  const fixture = projectFixture();
  fixture.serverRevision = 12;
  const runtime = HeadlessEditorRuntime.fromJSON(fixture);
  const added = runtime.execute({ name: 'animation.frame.add_from_layer', frameName: 'Idle 1', durationMs: 100 });
  assert.equal(added.ok, true);
  assert.equal(runtime.inspect().animation.frameCount, 1);
  assert.equal(runtime.inspect().animation.hasChanges, true);
  assert.throws(() => runtime.toJSON(), /Unreviewed sandbox changes/);
  runtime.createProposal('Create the first idle animation frame');
  const accepted = runtime.acceptProposal();
  assert.equal(accepted.status, 'applied');
  const saved = runtime.toJSON();
  assert.equal(saved.serverRevision, 12);
  assert.equal(saved.animation.format, 'pixelforge-animation');
  assert.equal(saved.animation.frames[0].name, 'Idle 1');
  assert.equal(saved.animation.frames[0].durationMs, 100);
  assert.equal(runtime.document.revision, fixture.revision + 1);
});

test('animation timeline supports duplication, timing, ordering and safe deletion', () => {
  const runtime = HeadlessEditorRuntime.fromJSON(projectFixture());
  const first = runtime.execute({ name: 'animation.frame.add_from_layer', frameName: 'A' });
  assert.equal(first.ok, true);
  const second = runtime.execute({ name: 'animation.frame.duplicate', index: 0 });
  assert.equal(second.ok, true);
  assert.equal(runtime.execute({ name: 'animation.frame.set_duration', index: 1, durationMs: 250 }).ok, true);
  assert.equal(runtime.execute({ name: 'animation.set_fps', fps: 24 }).ok, true);
  assert.equal(runtime.execute({ name: 'animation.set_loop', loop: false }).ok, true);
  assert.equal(runtime.execute({ name: 'animation.frame.reorder', from: 1, to: 0 }).ok, true);
  assert.equal(runtime.execute({ name: 'animation.frame.delete', index: 1 }).ok, true);
  const summary = runtime.execute({ name: 'animation.get_summary' });
  assert.equal(summary.ok, true);
  assert.equal(summary.result.frameCount, 1);
  assert.equal(summary.result.fps, 24);
  assert.equal(summary.result.loop, false);
  assert.equal(summary.result.totalDurationMs, 250);
});

test('animation timeline rejects invalid frame dimensions and timing values', () => {
  const runtime = HeadlessEditorRuntime.fromJSON(projectFixture());
  assert.equal(runtime.execute({ name: 'animation.frame.add_from_layer', durationMs: 0 }).ok, false);
  assert.equal(runtime.execute({ name: 'animation.set_fps', fps: 240 }).ok, false);
  assert.equal(runtime.hasPendingChanges, false);
});

test('animation composite frames capture sandbox pixels and frame-time lookup respects timing and looping', () => {
  const runtime = HeadlessEditorRuntime.fromJSON(projectFixture());
  const batch = runtime.executeBatch([
    { name: 'canvas.draw_line', x0: 2, y0: 3, x1: 7, y1: 3, color: '#EE2211' },
    { name: 'animation.frame.capture_composite', frameName: 'Walk 1', durationMs: 80 },
    { name: 'canvas.draw_line', x0: 2, y0: 4, x1: 7, y1: 4, color: '#22AA44' },
    { name: 'animation.frame.capture_composite', frameName: 'Walk 2', durationMs: 120 },
  ]);
  assert.equal(batch.ok, true);
  runtime.createProposal('Create two walking frames');
  assert.equal(runtime.acceptProposal().status, 'applied');
  const saved = runtime.toJSON();
  assert.equal(saved.animation.frames.length, 2);
  const firstPixels = Buffer.from(saved.animation.frames[0].pixels, 'base64');
  const secondPixels = Buffer.from(saved.animation.frames[1].pixels, 'base64');
  const containsColor = (pixels, rgba) => {
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (rgba.every((channel, index) => pixels[offset + index] === channel)) return true;
    }
    return false;
  };
  assert.equal(containsColor(firstPixels, [238, 34, 17, 255]), true, 'first cel must preserve the first raster edit');
  assert.equal(containsColor(secondPixels, [238, 34, 17, 255]), true, 'second composite cel must preserve prior edits');
  assert.equal(containsColor(secondPixels, [34, 170, 68, 255]), true, 'second composite cel must include its new raster edit');
  const timeline = saved.animation;
  assert.equal(frameAtAnimationTime(timeline, 0).index, 0);
  assert.equal(frameAtAnimationTime(timeline, 79).index, 0);
  assert.equal(frameAtAnimationTime(timeline, 80).index, 1);
  assert.equal(frameAtAnimationTime(timeline, 200).index, 0);
  timeline.loop = false;
  assert.equal(frameAtAnimationTime(timeline, 10000).index, 1);
});

test('headless shapes, selections, crop and rename compose into one accepted document change', () => {
  const runtime = HeadlessEditorRuntime.fromJSON(projectFixture());
  const batch = runtime.executeBatch([
    { name: 'document.rename', newName: 'Sprite study' },
    { name: 'selection.create_rect', x: 1, y: 1, width: 3, height: 3 },
    { name: 'canvas.fill', x: 1, y: 1, color: '#22AA44' },
    { name: 'selection.clear' },
    { name: 'canvas.draw_shape', shape: 'ellipse', x: 4, y: 4, width: 4, height: 4, color: '#EE2211', size: 1 },
    { name: 'canvas.crop', x: 0, y: 0, width: 10, height: 10 },
  ]);
  assert.equal(batch.ok, true);
  runtime.createProposal('Create a sprite study with selected fill and ellipse');
  assert.equal(runtime.acceptProposal().status, 'applied');
  const saved = runtime.toJSON();
  assert.equal(saved.name, 'Sprite study');
  assert.equal(saved.width, 10);
  assert.equal(saved.height, 10);
  const pixels = Buffer.from(saved.layers[0].pixels, 'base64');
  assert.deepEqual([...pixels.subarray((1 * 10 + 1) * 4, (1 * 10 + 1) * 4 + 4)], [34, 170, 68, 255]);
  assert.ok(pixels.some((value, index) => index % 4 === 0 && value === 238), 'ellipse outline should be persisted');
});

test('animation sprite-sheet export returns a PNG blob and frame manifest', async () => {
  const fixture = projectFixture();
  const timeline = {
    format: 'pixelforge-animation', version: 1, fps: 12, loop: true,
    frames: [
      { id: 'frame-a', name: 'A', durationMs: 100, pixels: fixture.layers[0].pixels },
      { id: 'frame-b', name: 'B', durationMs: 120, pixels: fixture.layers[0].pixels },
    ],
  };
  const originalDocument = globalThis.document;
  const originalImageData = globalThis.ImageData;
  const writes = [];
  globalThis.ImageData = class TestImageData {
    constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
  };
  globalThis.document = {
    createElement() {
      return {
        width: 0, height: 0,
        getContext() {
          return {
            clearRect() {},
            putImageData(image, x, y) { writes.push({ width: image.width, height: image.height, x, y }); },
          };
        },
        toBlob(callback) { callback(new Blob(['png-test-data'], { type: 'image/png' })); },
      };
    },
  };
  try {
    const exported = await exportAnimationSpriteSheet(timeline, 16, 16, { columns: 2, padding: 1 });
    assert.equal(exported.blob.type, 'image/png');
    assert.equal(exported.manifest.frameCount, 2);
    assert.equal(exported.manifest.sheet.columns, 2);
    assert.deepEqual(writes.map(item => [item.x, item.y]), [[1, 1], [18, 1]]);
  } finally {
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalImageData === undefined) delete globalThis.ImageData; else globalThis.ImageData = originalImageData;
  }
});
