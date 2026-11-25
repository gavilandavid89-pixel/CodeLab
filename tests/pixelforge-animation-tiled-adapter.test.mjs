import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { PixelForgeAnimation } from '../public/pixelforge/src/animation.mjs';
import { TiledAnimationDocument } from '../public/pixelforge/src/animation-tiled-adapter.mjs';
import { SparseTileCelStore } from '../public/pixelforge/src/animation-tiles.mjs';
import { TiledRasterProjectDocument } from '../public/pixelforge/src/raster-tiled-adapter.mjs';

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
  assert.deepEqual(tiled.readRegion(0, 'ink', { x: 68, y: 68, width: 4, height: 4 }).slice((2 * 4 + 2) * 4, (2 * 4 + 2) * 4 + 4),
    new Uint8ClampedArray([31, 64, 127, 255]));
  const manifest = await tiled.toManifest();
  assert.equal(manifest.format, 'pixelforge-tiled-animation');
  assert.equal(manifest.frames[0].cels.length, 2);
  assert.equal(manifest.frames[0].cels[0].cel.tiles.length, 1);
  const tiledReloaded = await TiledAnimationDocument.fromManifest(manifest, { maxDecodedCacheBytes: 1024 * 1024 });
  assert.deepEqual(tiledReloaded.readRegion(0, 'ink', { x: 68, y: 68, width: 4, height: 4 }),
    tiled.readRegion(0, 'ink', { x: 68, y: 68, width: 4, height: 4 }));
  assert.equal(tiledReloaded.getFrame(0).id, tiled.getFrame(0).id);
  tiledReloaded.dispose();

  const legacy = await tiled.toLegacyAnimationJSON();
  const restored = PixelForgeAnimation.fromJSON(legacy);
  assert.deepEqual(restored.getLayerPixels(0, 'ink'), animation.getLayerPixels(0, 'ink'));
  assert.equal(restored.getFrame(0).durationMs, 83);
  tiled.dispose();
});

test('tile-backed animation duplicates by shared resources and edits only the cloned frame', async () => {
  const animation = new PixelForgeAnimation({ width: 64, height: 64, layerIds: ['paint'] });
  const sourcePixels = new Uint8ClampedArray(64 * 64 * 4);
  sourcePixels.set([9, 80, 190, 255], 0);
  animation.setLayerPixels(0, 'paint', sourcePixels);
  const tiled = await TiledAnimationDocument.fromAnimation(animation);
  const original = tiled.getFrame(0);
  tiled.cloneFrame(0);
  const clone = tiled.getFrame(1);
  assert.notEqual(original.id, clone.id);
  assert.equal(tiled.stats.resourceReferences, 2);

  const patch = new Uint8ClampedArray(2 * 2 * 4);
  patch.set([255, 10, 20, 255], 0);
  const result = await tiled.writeRegion(1, 'paint', { x: 4, y: 4, width: 2, height: 2 }, patch);
  assert.equal(result.changed, true);
  assert.deepEqual(tiled.readRegion(0, 'paint', { x: 4, y: 4, width: 2, height: 2 }), new Uint8ClampedArray(16));
  assert.deepEqual(tiled.readRegion(1, 'paint', { x: 4, y: 4, width: 2, height: 2 }), patch);
  tiled.deleteFrame(1);
  tiled.dispose();
});


test('tiled animation manifest reader rejects corrupt tile resources', async () => {
  const animation = new PixelForgeAnimation({ width: 32, height: 32, layerIds: ['paint'] });
  const pixels = new Uint8ClampedArray(32 * 32 * 4);
  pixels.set([2, 4, 6, 255], 0);
  animation.setLayerPixels(0, 'paint', pixels);
  const tiled = await TiledAnimationDocument.fromAnimation(animation);
  const manifest = await tiled.toManifest();
  manifest.frames[0].cels[0].cel.tiles[0].sha256 = '0'.repeat(64);
  await assert.rejects(() => TiledAnimationDocument.fromManifest(manifest), /SHA-256 integrity check failed/);
  tiled.dispose();
});


test('tiled animation persists an explicit mode on every frame and frame-layer cel', async () => {
  const animation = new PixelForgeAnimation({ width: 32, height: 32, layerIds: ['illustration-layer', 'pixel-layer'] });
  const tiled = await TiledAnimationDocument.fromAnimation(animation);
  tiled.setFrameAuthoringMode(0, 'illustration');
  tiled.setLayerMetadata(0, 'illustration-layer', { authoringMode: 'illustration', brushHardness: 35 });
  tiled.setLayerMetadata(0, 'pixel-layer', { authoringMode: 'pixel-art', interpolation: 'nearest' });
  const manifest = await tiled.toManifest();
  assert.equal(manifest.frames[0].authoringMode, 'illustration');
  assert.equal(manifest.frames[0].cels[0].metadata.authoringMode, 'illustration');
  assert.equal(manifest.frames[0].cels[1].metadata.authoringMode, 'pixel-art');

  const restored = await TiledAnimationDocument.fromManifest(manifest);
  assert.equal(restored.getFrame(0).authoringMode, 'illustration');
  assert.equal(restored.getLayerMetadata(0, 'illustration-layer').authoringMode, 'illustration');
  assert.equal(restored.getLayerMetadata(0, 'pixel-layer').authoringMode, 'pixel-art');
  restored.cloneFrame(0);
  assert.equal(restored.getFrame(1).authoringMode, 'illustration');
  assert.equal(restored.getLayerMetadata(1, 'pixel-layer').authoringMode, 'pixel-art');
  restored.dispose();
  tiled.dispose();
});


test('tiled timeline supports blank frames, reorder, duration, and active-index-safe deletion without dense canvases', async () => {
  const store = new SparseTileCelStore({ maxDecodedCacheBytes: 0 });
  const layerIds = ['ink', 'color'];
  const cels = new Map(layerIds.map(layerId => [layerId, store.createBlankCel({ width: 4096, height: 4096, tileSize: 128 })]));
  const tiled = new TiledAnimationDocument({
    store, width: 4096, height: 4096, fps: 12, layerIds,
    frames: [{ id: 'base-frame', durationMs: 100, authoringMode: 'pixel-art', cels }],
  });
  const blank = tiled.createBlankFrame({ afterIndex: 0, durationMs: 125, authoringMode: 'illustration' });
  assert.equal(blank.index, 1);
  assert.equal(tiled.frameCount, 2);
  assert.equal(tiled.getFrame(1).durationMs, 125);
  assert.equal(tiled.getFrame(1).authoringMode, 'illustration');
  assert.equal(tiled.stats.resourceCount, 0);
  assert.equal(tiled.readRegion(1, 'ink', { x: 4000, y: 4000, width: 1, height: 1 }).byteLength, 4);

  tiled.createBlankFrame({ afterIndex: 1, durationMs: 80, authoringMode: 'pixel-art' });
  tiled.setActiveFrame(2);
  tiled.moveFrame(2, 0);
  assert.equal(tiled.activeFrameIndex, 0);
  assert.equal(tiled.getFrame(0).durationMs, 80);
  tiled.deleteFrame(1);
  assert.equal(tiled.activeFrameIndex, 0);
  tiled.deleteFrame(0);
  assert.equal(tiled.activeFrameIndex, 0);
  assert.equal(tiled.frameCount, 1);
  assert.equal(tiled.setFps(24), 24);
  assert.equal(tiled.fps, 24);
  assert.throws(() => tiled.setFps(61), /FPS/);
  tiled.dispose();
});


test('tiled animation shares the project tile store and swaps frame cel references without dense frame buffers', async () => {
  const project = TiledRasterProjectDocument.createBlank({ width: 4096, height: 4096, tileSize: 128 });
  const animation = TiledAnimationDocument.fromTiledProjectDocument(project, { fps: 12 });
  assert.equal(animation.store, project.tileStore);
  assert.equal(animation.frameCount, 1);
  const layerId = project.activeLayerId;
  const patch = new Uint8ClampedArray([255, 32, 16, 255]);
  await project.writeRegion(layerId, { x: 2048, y: 2048, width: 1, height: 1 }, patch);
  const celId = project.cloneLayerCelReference(layerId);
  animation.replaceFrameCelReference(0, layerId, celId, { takeOwnership: true });
  const sampled = animation.readRegion(0, layerId, { x: 2048, y: 2048, width: 1, height: 1 });
  assert.deepEqual([...sampled], [...patch]);
  const thumbnail = animation.compositeThumbnail(0, null, 48);
  assert.equal(thumbnail.width, 48);
  assert.equal(thumbnail.height, 48);
  assert.equal(thumbnail.pixels.byteLength, 48 * 48 * 4);
  const frameRegion = animation.compositeRegion(0, { x: 2048, y: 2048, width: 1, height: 1 });
  assert.deepEqual([...frameRegion.pixels], [...patch]);

  animation.createBlankFrame({ durationMs: 80, authoringMode: 'illustration' });
  assert.equal(animation.frameCount, 2);
  assert.equal(animation.readRegion(1, layerId, { x: 2048, y: 2048, width: 1, height: 1 })[3], 0);
  animation.setActiveFrame(0);
  const refs = new Map(animation.layerIds.map(id => [id, animation.getFrameCelReference(0, id)]));
  project.replaceLayerCelReferences(refs, { takeOwnership: true });
  assert.deepEqual([...project.readRegion(layerId, { x: 2048, y: 2048, width: 1, height: 1 })], [...patch]);
  const manifest = await animation.toManifest();
  const restored = await TiledAnimationDocument.fromManifest(manifest, { store: project.tileStore });
  assert.equal(restored.store, project.tileStore);
  assert.equal(restored.frameCount, 2);
  assert.deepEqual([...restored.readRegion(0, layerId, { x: 2048, y: 2048, width: 1, height: 1 })], [...patch]);
  restored.dispose();
  animation.dispose();
  project.dispose();
});


test('tiled animation layer removal returns retained cels and restores them by stable frame ID', async () => {
  const store = new SparseTileCelStore({ maxDecodedCacheBytes: 0 });
  const base = store.createBlankCel({ width: 64, height: 64, tileSize: 32 });
  const animation = new TiledAnimationDocument({
    store, width: 64, height: 64, fps: 12, layerIds: ['base'],
    frames: [{ id: 'frame-a', durationMs: 100, authoringMode: 'pixel-art', layerMetadata: { base: { name: 'Base' } }, cels: new Map([['base', base]]) }],
  });
  const extra = store.createBlankCel({ width: 64, height: 64, tileSize: 32 });
  const red = new Uint8ClampedArray(32 * 32 * 4); red.set([220, 40, 30, 255]);
  const write = await store.writeRegion(extra, { x: 0, y: 0, width: 32, height: 32 }, red);
  store.releaseCel(extra);
  animation.addLayer('ink', { activeCelId: write.celId, metadata: { name: 'Ink', opacity: 0.8 } });
  animation.createBlankFrame({ durationMs: 80 });
  const removed = animation.removeLayer('ink');
  assert.equal(removed.frames.length, 2);
  const orphanFrames = new Map(removed.frames.map(item => [item.frameId, item]));
  const blankActive = store.createBlankCel({ width: 64, height: 64, tileSize: 32 });
  animation.addLayer('ink', { activeCelId: blankActive, metadata: { name: 'Ink' }, orphanFrames });
  assert.deepEqual([...animation.readRegion(0, 'ink', { x: 0, y: 0, width: 1, height: 1 })], [220, 40, 30, 255]);
  assert.equal(animation.readRegion(1, 'ink', { x: 0, y: 0, width: 1, height: 1 })[3], 0);
  assert.equal(animation.getLayerMetadata(0, 'ink').name, 'Ink');
  assert.equal(removed.frames.every(item => item.celId === null), true);
  animation.dispose();
});


test('per-frame tiled stroke history remains isolated when the active cel references are swapped', async () => {
  const project = TiledRasterProjectDocument.createBlank({ width: 64, height: 64, tileSize: 32 });
  const animation = TiledAnimationDocument.fromTiledProjectDocument(project, { fps: 12 });
  const layerId = project.activeLayerId;
  const historyFrame0 = project.strokeHistory;
  const before = project.readRegion(layerId, { x: 0, y: 0, width: 32, height: 32 });
  const after = new Uint8ClampedArray(before);
  after.set([80, 170, 240, 255], 0);
  await historyFrame0.applyTileOperation(layerId, [{ x: 0, y: 0, before, after }], { type: 'test-frame-paint' });
  const frame0Cel = project.cloneLayerCelReference(layerId);
  animation.replaceFrameCelReference(0, layerId, frame0Cel, { takeOwnership: true });

  const detachedFrame0History = project.swapStrokeHistory(project.createStrokeHistory());
  animation.createBlankFrame({ durationMs: 80 });
  const frame1References = new Map(animation.layerIds.map(id => [id, animation.getFrameCelReference(1, id)]));
  project.replaceLayerCelReferences(frame1References, { takeOwnership: true });
  project.swapStrokeHistory(project.createStrokeHistory()).dispose();
  assert.equal(project.strokeHistory.canUndo, false);
  assert.equal(project.readRegion(layerId, { x: 0, y: 0, width: 1, height: 1 })[3], 0);

  const detachedFrame1History = project.swapStrokeHistory(project.createStrokeHistory());
  animation.setActiveFrame(0);
  const frame0References = new Map(animation.layerIds.map(id => [id, animation.getFrameCelReference(0, id)]));
  project.replaceLayerCelReferences(frame0References, { takeOwnership: true });
  project.swapStrokeHistory(detachedFrame0History).dispose();
  assert.equal(project.strokeHistory.canUndo, true);
  assert.equal(project.readRegion(layerId, { x: 0, y: 0, width: 1, height: 1 })[3], 255);
  assert.equal(await project.undo(), true);
  assert.equal(project.readRegion(layerId, { x: 0, y: 0, width: 1, height: 1 })[3], 0);

  detachedFrame1History.dispose();
  animation.dispose();
  project.dispose();
});
