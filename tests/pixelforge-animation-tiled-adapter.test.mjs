import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { PixelForgeAnimation } from '../public/pixelforge/src/animation.mjs';
import { TiledAnimationDocument } from '../public/pixelforge/src/animation-tiled-adapter.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

test('tile-backed animation adapter migrates v1 frames and preserves frame/layer metadata', async () => {
  const animation = new PixelForgeAnimation({ width: 96, height: 80, layerIds: ['ink', 'color'], fps: 12 });
  const pixels = new Uint8ClampedArray(96 * 80 * 4);
  pixels.set([31, 64, 127, 255], (70 * 96 + 70) * 4);
  animation.setLayerPixels(0, 'ink', pixels);
  animation.setLayerMetadata(0, 'ink', { name: 'Ink', opacity: 0.75, visible: true });
  animation.setFrameDuration(0, 83);

  const tiled = await TiledAnimationDocument.fromAnimation(animation, { tileSize: 32 });
  assert.equal(tiled.frameCount, 1);
  assert.equal(tiled.getFrame(0).durationMs, 83);
  assert.deepEqual(tiled.readRegion(0, 'ink', { x: 68, y: 68, width: 4, height: 4 }).slice(3 * 4, 3 * 4 + 4),
    new Uint8ClampedArray([31, 64, 127, 255]));
  const manifest = await tiled.toManifest();
  assert.equal(manifest.format, 'pixelforge-tiled-animation');
  assert.equal(manifest.frames[0].cels.length, 2);
  assert.equal(manifest.frames[0].cels[0].cel.tiles.length, 1);

  const legacy = await tiled.toLegacyAnimationJSON();
  const restored = PixelForgeAnimation.fromJSON(legacy);
  assert.deepEqual(restored.getLayerPixels(0, 'ink'), animation.getLayerPixels(0, 'ink'));
  assert.equal(restored.getFrame(0).durationMs, 83);
  tiled.dispose();
});

test('tile-backed animation duplicates by shared resources and edits only the cloned frame', async () => {
  const animation = new PixelForgeAnimation({ width: 64, height: 64, layerIds: ['paint'] });
  const tiled = await TiledAnimationDocument.fromAnimation(animation);
  const original = tiled.getFrame(0);
  tiled.cloneFrame(0);
  const clone = tiled.getFrame(1);
  assert.notEqual(original.id, clone.id);
  assert.equal(tiled.stats.resourceReferences, 0);

  const patch = new Uint8ClampedArray(2 * 2 * 4);
  patch.set([255, 10, 20, 255], 0);
  const result = await tiled.writeRegion(1, 'paint', { x: 4, y: 4, width: 2, height: 2 }, patch);
  assert.equal(result.changed, true);
  assert.deepEqual(tiled.readRegion(0, 'paint', { x: 4, y: 4, width: 2, height: 2 }), new Uint8ClampedArray(16));
  assert.deepEqual(tiled.readRegion(1, 'paint', { x: 4, y: 4, width: 2, height: 2 }), patch);
  tiled.deleteFrame(1);
  tiled.dispose();
});
