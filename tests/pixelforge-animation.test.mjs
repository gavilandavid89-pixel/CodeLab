import test from 'node:test';
import assert from 'node:assert/strict';
import { PixelForgeAnimation, MAX_ANIMATION_FRAMES } from '../public/pixelforge/src/animation.mjs';

function documentFixture() {
  return {
    width: 2,
    height: 2,
    layers: [
      { id: 'ink', pixels: new Uint8ClampedArray(16).fill(10) },
      { id: 'color', pixels: new Uint8ClampedArray(16).fill(20) },
    ],
  };
}

test('creates a one-frame timeline from the existing raster document without sharing pixel buffers', () => {
  const source = documentFixture();
  const timeline = PixelForgeAnimation.fromDocument(source, { fps: 12 });
  assert.equal(timeline.frameCount, 1);
  assert.equal(timeline.fps, 12);
  assert.equal(timeline.activeFrameIndex, 0);
  assert.deepEqual(timeline.layerIds, ['ink', 'color']);
  const pixels = timeline.getLayerPixels(0, 'ink');
  assert.equal(pixels[0], 10);
  pixels[0] = 255;
  assert.equal(timeline.getLayerPixels(0, 'ink')[0], 10);
  assert.equal(source.layers[0].pixels[0], 10);
});

test('adds blank and duplicated frames with independent cels', () => {
  const timeline = PixelForgeAnimation.fromDocument(documentFixture());
  timeline.setLayerPixels(0, 'ink', new Uint8ClampedArray(16).fill(77));
  timeline.addFrame({ duplicate: true });
  assert.equal(timeline.frameCount, 2);
  assert.equal(timeline.activeFrameIndex, 1);
  assert.equal(timeline.getLayerPixels(1, 'ink')[0], 77);
  timeline.setLayerPixels(1, 'ink', new Uint8ClampedArray(16).fill(88));
  assert.equal(timeline.getLayerPixels(0, 'ink')[0], 77);
  assert.equal(timeline.getLayerPixels(1, 'ink')[0], 88);
  timeline.addFrame({ duplicate: false, durationMs: 100 });
  assert.equal(timeline.frameCount, 3);
  assert.equal(timeline.getLayerPixels(2, 'ink')[0], 0);
  assert.equal(timeline.activeFrame.durationMs, 100);
});

test('reorders and deletes frames while keeping the active frame attached to its identity', () => {
  const timeline = PixelForgeAnimation.fromDocument(documentFixture());
  const firstId = timeline.getFrame(0).id;
  timeline.addFrame({ duplicate: true });
  const secondId = timeline.getFrame(1).id;
  timeline.addFrame({ duplicate: true });
  timeline.setActiveFrame(1);
  timeline.moveFrame(1, 0);
  assert.equal(timeline.activeFrame.id, secondId);
  assert.equal(timeline.getFrame(1).id, firstId);
  timeline.deleteFrame(0);
  assert.equal(timeline.activeFrameIndex, 0);
  assert.equal(timeline.activeFrame.id, firstId);
  assert.equal(timeline.frameCount, 2);
  timeline.deleteFrame(0);
  assert.equal(timeline.frameCount, 1);
  assert.throws(() => timeline.deleteFrame(0), /at least one frame/);
});

test('supports per-frame duration, global FPS, and deterministic playback time mapping', () => {
  const timeline = PixelForgeAnimation.fromDocument(documentFixture(), { fps: 10 });
  timeline.addFrame({ duplicate: true });
  timeline.addFrame({ duplicate: true });
  timeline.setFrameDuration(1, 250);
  assert.equal(timeline.totalDurationMs, 450);
  assert.equal(timeline.frameIndexAtTime(0), 0);
  assert.equal(timeline.frameIndexAtTime(99), 0);
  assert.equal(timeline.frameIndexAtTime(100), 1);
  assert.equal(timeline.frameIndexAtTime(349), 1);
  assert.equal(timeline.frameIndexAtTime(350), 2);
  assert.equal(timeline.frameIndexAtTime(450), 0);
  assert.equal(timeline.frameIndexAtTime(450, { loop: false }), 2);
  timeline.setFps(20);
  assert.equal(timeline.fps, 20);
  assert.equal(timeline.totalDurationMs, 150);
  assert.equal(timeline.activeFrame.durationMs, 50);
});

test('returns bounded onion-skin neighbors without crossing timeline edges', () => {
  const timeline = PixelForgeAnimation.fromDocument(documentFixture());
  timeline.addFrame({ duplicate: true });
  timeline.addFrame({ duplicate: true });
  timeline.addFrame({ duplicate: true });
  timeline.setActiveFrame(2);
  assert.deepEqual(timeline.getOnionSkinFrames({ previous: 2, next: 1 }).map(item => [item.index, item.direction]), [
    [0, 'previous'], [1, 'previous'], [3, 'next'],
  ]);
  assert.throws(() => timeline.getOnionSkinFrames({ previous: 4 }), /from 0 to 3/);
});

test('keeps animation cels synchronized with layer add, duplicate, delete, and reorder operations', () => {
  const timeline = PixelForgeAnimation.fromDocument(documentFixture());
  timeline.setLayerPixels(0, 'ink', new Uint8ClampedArray(16).fill(33));
  timeline.addFrame({ duplicate: true });
  timeline.addLayer('shadow');
  assert.deepEqual(timeline.layerIds, ['ink', 'color', 'shadow']);
  assert.equal(timeline.getLayerPixels(0, 'shadow')[0], 0);
  timeline.addLayer('ink-copy', { copyFromLayerId: 'ink' });
  assert.equal(timeline.getLayerPixels(1, 'ink-copy')[0], 33);
  assert.equal(timeline.removeLayer('color'), 3);
  assert.deepEqual(timeline.layerIds, ['ink', 'shadow', 'ink-copy']);
  assert.equal(timeline.reorderLayers(['ink-copy', 'ink', 'shadow']), true);
  assert.deepEqual(timeline.layerIds, ['ink-copy', 'ink', 'shadow']);
  assert.equal(timeline.getLayerPixels(0, 'ink')[0], 33);
  assert.throws(() => timeline.removeLayer('ink'), /at least one raster layer/);
});

test('uses 60 FPS timing and rejects oversized allocations before decoding cels', () => {
  const timeline = PixelForgeAnimation.fromDocument(documentFixture());
  assert.equal(timeline.setFps(60), 17);
  assert.equal(timeline.activeFrame.durationMs, 17);
  const layerIds = Array.from({ length: 64 }, (_, index) => 'layer-' + index);
  assert.throws(() => new PixelForgeAnimation({ width: 2048, height: 2048, layerIds }), /64 MiB/);
  assert.throws(() => PixelForgeAnimation.fromJSON({
    format: 'pixelforge-animation', version: 1, width: 2048, height: 2048,
    layerIds, fps: 12, activeFrameIndex: 0,
    frames: [{ id: 'oversized', durationMs: 100, cels: [] }],
  }), /64 MiB/);
});

test('round-trips timeline metadata and RGBA cels through a validated JSON format', () => {
  const timeline = PixelForgeAnimation.fromDocument(documentFixture(), { fps: 8 });
  timeline.setLayerPixels(0, 'color', new Uint8ClampedArray(16).fill(201));
  timeline.addFrame({ duplicate: true, durationMs: 240 });
  timeline.setActiveFrame(0);
  const restored = PixelForgeAnimation.fromJSON(JSON.parse(JSON.stringify(timeline)));
  assert.equal(restored.frameCount, 2);
  assert.equal(restored.fps, 8);
  assert.equal(restored.getFrame(1).durationMs, 240);
  assert.equal(restored.getLayerPixels(1, 'color')[0], 201);
  assert.equal(restored.activeFrameIndex, 0);
});

test('rejects malformed dimensions, duplicate layer IDs, bad durations, and invalid cel buffers', () => {
  assert.throws(() => new PixelForgeAnimation({ width: 0, height: 2, layerIds: ['ink'] }), /dimensions/);
  assert.throws(() => new PixelForgeAnimation({ width: 2, height: 2, layerIds: ['ink', 'ink'] }), /unique/);
  assert.throws(() => PixelForgeAnimation.fromDocument(documentFixture(), { fps: 0 }), /FPS/);
  const timeline = PixelForgeAnimation.fromDocument(documentFixture());
  assert.throws(() => timeline.setFrameDuration(0, 1), /duration/);
  assert.throws(() => timeline.setLayerPixels(0, 'ink', new Uint8ClampedArray(4)), /dimensions/);
  assert.throws(() => PixelForgeAnimation.fromJSON({ format: 'pixelforge-animation', version: 1 }), /invalid/);
});

test('enforces the maximum frame count', () => {
  const timeline = PixelForgeAnimation.fromDocument(documentFixture());
  for (let index = 1; index < MAX_ANIMATION_FRAMES; index++) timeline.addFrame({ duplicate: false });
  assert.equal(timeline.frameCount, MAX_ANIMATION_FRAMES);
  assert.throws(() => timeline.addFrame(), /up to 240/);
});
