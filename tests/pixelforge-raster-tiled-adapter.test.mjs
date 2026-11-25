import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { RasterDocument } from '../public/pixelforge/src/core.js';
import { TiledRasterProjectDocument } from '../public/pixelforge/src/raster-tiled-adapter.mjs';
import { TiledRasterPointerStrokeController } from '../public/pixelforge/src/raster-tiled-pointer-controller.mjs';
import { SparseTileCelStore, PIXELFORGE_TILED_CEL_FORMAT, PIXELFORGE_TILED_CEL_VERSION } from '../public/pixelforge/src/animation-tiles.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

test('migrates all raster layers and project drawing configuration into a tiled manifest losslessly', async () => {
  const source = new RasterDocument(80, 72, 'Traditional raster');
  source.activeLayer.authoringMode = null;
  source.setDrawingModel({ projectNote: 'preserve-me' });
  source.activeLayer.pixels.set([7, 44, 99, 255], (65 * 80 + 70) * 4);
  source.activeLayer.opacity = 0.7;
  const extra = source.addLayer('Ink');
  extra.authoringMode = null;
  extra.pixels.set([200, 30, 40, 255], (3 * 80 + 4) * 4);
  const config = { version: 1, availableModes: ['illustration', 'pixel-art'], initialMode: 'illustration', activeMode: 'illustration' };
  const tiled = await TiledRasterProjectDocument.fromDocument(source, { tileSize: 32, drawingConfiguration: config });
  const manifest = await tiled.toManifest();
  assert.equal(manifest.layers.length, 2);
  assert.equal(manifest.layers[0].cel.tiles.length, 1);
  assert.equal(manifest.layers[1].cel.tiles.length, 1);
  assert.deepEqual(manifest.drawingConfiguration, config);
  assert.equal(manifest.layers[0].authoringMode, 'illustration', 'layers without an override inherit the project active mode');
  assert.equal(manifest.layers[1].authoringMode, 'illustration');
  assert.deepEqual(manifest.projectMetadata.drawingModel, { projectNote: 'preserve-me' });

  const restored = await TiledRasterProjectDocument.fromManifest(manifest);
  assert.deepEqual(restored.readRegion(source.layers[0].id, { x: 68, y: 63, width: 4, height: 4 }).slice((2 * 4 + 2) * 4, (2 * 4 + 2) * 4 + 4),
    new Uint8ClampedArray([7, 44, 99, 255]));
  assert.equal(restored.layers[1].name, 'Ink');
  const legacy = await restored.toLegacyProjectJSON();
  assert.deepEqual(Buffer.from(legacy.layers[0].pixels, 'base64'), Buffer.from(source.layers[0].pixels));
  assert.equal(legacy.drawingConfiguration.activeMode, 'illustration');
  assert.deepEqual(legacy.drawingModel, { projectNote: 'preserve-me' });
  restored.dispose();
  tiled.dispose();
});

test('duplicates layers with shared tile resources and writes only the selected layer', async () => {
  const source = new RasterDocument(64, 64, 'Layer copy');
  source.activeLayer.pixels.set([10, 20, 30, 255], 0);
  const tiled = await TiledRasterProjectDocument.fromDocument(source);
  const originalId = source.layers[0].id;
  const duplicate = tiled.duplicateLayer(originalId, 'Ink copy');
  assert.equal(tiled.stats.resourceReferences, 2);
  const patch = new Uint8ClampedArray([200, 100, 50, 255]);
  await tiled.writeRegion(duplicate.id, { x: 0, y: 0, width: 1, height: 1 }, patch);
  assert.deepEqual(tiled.readRegion(originalId, { x: 0, y: 0, width: 1, height: 1 }), new Uint8ClampedArray([10, 20, 30, 255]));
  assert.deepEqual(tiled.readRegion(duplicate.id, { x: 0, y: 0, width: 1, height: 1 }), patch);
  tiled.dispose();
});

test('rejects locked-layer writes and malformed project manifests', async () => {
  const source = new RasterDocument(16, 16, 'Validation');
  const tiled = await TiledRasterProjectDocument.fromDocument(source);
  tiled.updateLayer(source.layers[0].id, { locked: true });
  await assert.rejects(() => tiled.writeRegion(source.layers[0].id, { x: 0, y: 0, width: 1, height: 1 }, new Uint8Array(4)), /locked/);
  const manifest = await tiled.toManifest();
  manifest.layers[0].cel.width = 99;
  await assert.rejects(() => TiledRasterProjectDocument.fromManifest(manifest), /geometry/);
  tiled.dispose();
});

test('switching drawing modes is a guarded metadata-only operation and preserves per-cel exceptions', async () => {
  const source = new RasterDocument(48, 48, 'Mode guard');
  const layer = source.activeLayer;
  layer.pixels.set([21, 42, 63, 255], (12 * 48 + 17) * 4);
  layer.authoringMode = 'illustration';
  layer.modeOverrides = { brushHardness: 37, interpolation: 'bilinear', customFlag: true };
  const tiled = await TiledRasterProjectDocument.fromDocument(source, {
    tileSize: 32,
    drawingConfiguration: {
      version: 1,
      availableModes: ['illustration', 'pixel-art'],
      initialMode: 'illustration',
      activeMode: 'illustration',
    },
  });
  const before = await tiled.toManifest();
  const beforeCel = before.layers[0].cel;
  const beforeTileHashes = beforeCel.tiles.map(tile => tile.sha256);
  const result = tiled.switchDrawingMode('pixel-art');
  const after = await tiled.toManifest();
  assert.equal(result.pixelsChanged, false);
  assert.equal(result.celsRewritten, 0);
  assert.deepEqual(result.preservedLayerIds, [layer.id]);
  assert.equal(after.drawingConfiguration.activeMode, 'pixel-art');
  assert.deepEqual(after.layers[0].cel.tiles.map(tile => tile.sha256), beforeTileHashes);
  assert.equal(after.layers[0].authoringMode, 'illustration');
  assert.deepEqual(after.layers[0].modeOverrides, { brushHardness: 37, interpolation: 'bilinear', customFlag: true });
  tiled.switchDrawingMode('illustration');
  const restored = await tiled.toManifest();
  assert.equal(restored.drawingConfiguration.activeMode, 'illustration');
  assert.deepEqual(restored.layers[0].modeOverrides, after.layers[0].modeOverrides);
  tiled.dispose();
});

test('native RasterDocument JSON preserves per-layer authoring mode exceptions', async () => {
  const source = new RasterDocument(24, 24, 'Mode metadata round trip');
  source.activeLayer.authoringMode = 'illustration';
  source.activeLayer.modeOverrides = { brushHardness: 42, interpolation: 'bilinear' };
  const pixelsBefore = new Uint8ClampedArray(source.activeLayer.pixels);
  const serialized = source.toJSON();
  assert.equal(serialized.layers[0].authoringMode, 'illustration');
  assert.deepEqual(serialized.layers[0].modeOverrides, { brushHardness: 42, interpolation: 'bilinear' });
  const restored = RasterDocument.fromJSON(serialized);
  assert.equal(restored.activeLayer.authoringMode, 'illustration');
  assert.deepEqual(restored.activeLayer.modeOverrides, { brushHardness: 42, interpolation: 'bilinear' });
  assert.deepEqual(restored.activeLayer.pixels, pixelsBefore);
});

test('sparse tiled projects exceed the legacy 64 MiB dense-layer budget without allocating full canvases', async () => {
  const width = 4096;
  const height = 4096;
  const tileSize = 32;
  const tilePixels = new Uint8Array(tileSize * tileSize * 4);
  tilePixels.set([11, 22, 33, 255], (7 * tileSize + 9) * 4);
  const digest = await webcrypto.subtle.digest('SHA-256', tilePixels);
  const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const store = new SparseTileCelStore({ maxDecodedCacheBytes: 0 });
  const firstCelId = await store.createCel({
    format: PIXELFORGE_TILED_CEL_FORMAT,
    version: PIXELFORGE_TILED_CEL_VERSION,
    width, height, tileSize,
    tiles: [{ x: 0, y: 0, width: tileSize, height: tileSize, sha256, rgba: Buffer.from(tilePixels).toString('base64') }],
  });
  const layers = [];
  for (let index = 0; index < 17; index++) {
    layers.push({
      id: `layer-${index}`, name: `Sparse layer ${index + 1}`,
      visible: true, opacity: 1, locked: false,
      celId: index === 0 ? firstCelId : store.cloneCel(firstCelId),
    });
  }
  const tiled = new TiledRasterProjectDocument({
    store, id: 'sparse-over-64mib', name: 'Sparse high-resolution proof',
    width, height, layers, activeLayerId: layers[0].id,
  });
  assert.ok(width * height * 4 * layers.length > 64 * 1024 * 1024);
  assert.equal(tiled.layerIds.length, 17);
  assert.equal(tiled.stats.resourceCount, 1, 'identical immutable tiles deduplicate across layers');
  assert.equal(tiled.stats.resourceReferences, 17);
  assert.deepEqual(tiled.readRegion('layer-16', { x: 9, y: 7, width: 1, height: 1 }), new Uint8ClampedArray([11, 22, 33, 255]));
  const manifest = await tiled.toManifest();
  assert.equal(manifest.layers.length, 17);
  assert.equal(manifest.layers[16].cel.tiles[0].sha256, sha256);
  tiled.dispose();
});


test('creates a native large sparse project and edits only the touched tile without dense migration', async () => {
  const tiled = TiledRasterProjectDocument.createBlank({
    width: 4096,
    height: 4096,
    name: 'Native sparse blank',
    maxDecodedCacheBytes: 0,
    tileSize: 64,
  });
  const layerId = tiled.activeLayerId;
  assert.equal(tiled.stats.resourceCount, 0);
  assert.equal(tiled.stats.celCount, 1);
  assert.equal(tiled.layers.length, 1);

  const patch = new Uint8Array([91, 82, 73, 255]);
  const result = await tiled.writeRegion(layerId, { x: 2049, y: 1027, width: 1, height: 1 }, patch);
  assert.equal(result.changed, true);
  assert.equal(result.changedTiles, 1);
  assert.equal(tiled.stats.resourceCount, 1);
  assert.deepEqual(tiled.readRegion(layerId, { x: 2049, y: 1027, width: 1, height: 1 }), new Uint8ClampedArray(patch));

  const duplicate = tiled.duplicateLayer(layerId, 'Shared sparse copy');
  assert.equal(tiled.stats.resourceCount, 1);
  assert.equal(tiled.stats.resourceReferences, 2);
  const duplicatePatch = new Uint8Array([1, 2, 3, 255]);
  await tiled.writeRegion(duplicate.id, { x: 2049, y: 1027, width: 1, height: 1 }, duplicatePatch);
  assert.equal(tiled.stats.resourceCount, 2);
  assert.equal(tiled.stats.celCount, 2, 'only the two live layer cels remain after copy-on-write edits');
  assert.deepEqual(tiled.readRegion(layerId, { x: 2049, y: 1027, width: 1, height: 1 }), new Uint8ClampedArray(patch));
  assert.deepEqual(tiled.readRegion(duplicate.id, { x: 2049, y: 1027, width: 1, height: 1 }), new Uint8ClampedArray(duplicatePatch));

  const manifest = await tiled.toManifest();
  assert.equal(manifest.width, 4096);
  assert.equal(manifest.height, 4096);
  assert.equal(manifest.layers.length, 2);
  assert.equal(manifest.layers[0].cel.tiles.length, 1);
  assert.equal(manifest.layers[1].cel.tiles.length, 1);
  tiled.dispose();
  assert.equal(tiled.stats.celCount, 0);
  assert.equal(tiled.stats.resourceCount, 0);
});


test('composites only a bounded viewport from a large sparse project', async () => {
  const tiled = TiledRasterProjectDocument.createBlank({
    width: 4096,
    height: 4096,
    tileSize: 64,
    maxDecodedCacheBytes: 64 * 1024,
  });
  const layerId = tiled.activeLayerId;
  await tiled.writeRegion(layerId, { x: 2000, y: 2000, width: 1, height: 1 }, new Uint8Array([10, 20, 30, 255]));
  const viewport = tiled.readCompositeRegion({ x: 1992, y: 1992, width: 16, height: 16 });
  assert.equal(viewport.width, 16);
  assert.equal(viewport.height, 16);
  const offset = ((2000 - 1992) * 16 + (2000 - 1992)) * 4;
  assert.deepEqual(Array.from(viewport.pixels.slice(offset, offset + 4)), [10, 20, 30, 255]);
  assert.equal(viewport.pixels.length, 16 * 16 * 4);
  tiled.dispose();
});


test('rejects bounded composite regions outside the canvas', () => {
  const tiled = TiledRasterProjectDocument.createBlank({ width: 64, height: 64, maxDecodedCacheBytes: 0 });
  assert.throws(() => tiled.readCompositeRegion({ x: 60, y: 60, width: 8, height: 8 }), /outside canvas bounds/);
  assert.throws(() => tiled.readCompositeRegion({ x: -1, y: 0, width: 1, height: 1 }), /outside canvas bounds/);
  tiled.dispose();
});


test('bounded sparse compositing handles viewport edges and mixed layer opacity without reading outside the canvas', async () => {
  const tiled = TiledRasterProjectDocument.createBlank({ width: 65, height: 65, tileSize: 32, maxDecodedCacheBytes: 64 * 1024 });
  const baseId = tiled.activeLayerId;
  await tiled.writeRegion(baseId, { x: 64, y: 64, width: 1, height: 1 }, new Uint8Array([20, 40, 60, 255]));
  const overlay = tiled.duplicateLayer(baseId, 'Overlay');
  await tiled.writeRegion(overlay.id, { x: 64, y: 64, width: 1, height: 1 }, new Uint8Array([220, 120, 20, 255]));
  tiled.updateLayer(overlay.id, { opacity: 0.5 });
  const edge = tiled.readCompositeRegion({ x: 63, y: 63, width: 2, height: 2 });
  const pixel = edge.pixels.slice((1 * edge.width + 1) * 4, (1 * edge.width + 1) * 4 + 4);
  assert.deepEqual(Array.from(pixel), [120, 80, 40, 255]);
  assert.throws(() => tiled.readCompositeRegion({ x: 64, y: 64, width: 2, height: 1 }), /outside canvas bounds/);
  assert.throws(() => tiled.readCompositeRegion({ x: 64, y: 64, width: 1, height: 2 }), /outside canvas bounds/);
  tiled.dispose();
});


test('tiled document exposes bounded editor state, layer operations and shared stroke undo/redo', async () => {
  const tiled = TiledRasterProjectDocument.createBlank({
    width: 128, height: 128, name: 'Editor adapter contract', tileSize: 32, maxDecodedCacheBytes: 64 * 1024,
  });
  const baseId = tiled.activeLayerId;
  assert.equal(tiled.isTiled, true);
  assert.equal(tiled.activeLayer.id, baseId);
  assert.equal(tiled.history.length, 0);
  assert.equal(tiled.future.length, 0);
  assert.equal(tiled.dirty, false);

  const overlay = tiled.addLayer('Ink');
  assert.equal(tiled.layers.length, 2);
  assert.equal(tiled.activeLayerId, overlay.id);
  tiled.setLayerOpacity(overlay.id, 0.75);
  tiled.setLayerVisibility(overlay.id, true);
  tiled.setLayerLocked(overlay.id, false);
  tiled.renameLayer(overlay.id, 'Ink renamed');
  tiled.moveLayer(overlay.id, 0);
  assert.equal(tiled.layers[0].name, 'Ink renamed');
  assert.equal(tiled.activeLayer.id, overlay.id);

  const controller = new TiledRasterPointerStrokeController(tiled);
  await controller.pointerDown({
    pointerId: 77,
    layerId: overlay.id,
    points: [{ x: 10, y: 12 }, { x: 110, y: 12 }, null, { x: 10, y: 116 }],
    settings: { color: '#e34b72', size: 1, mode: 'draw', opacity: 1, shape: 'square', hardness: 1 },
  });
  await controller.pointerMove({
    pointerId: 77,
    points: [{ x: 14, y: 16 }, { x: 106, y: 16 }, null, { x: 14, y: 112 }],
  });
  await controller.pointerUp({ pointerId: 77 });
  assert.equal(tiled.history.length, 1, 'one pointer gesture becomes one shared document history command');
  assert.ok(tiled.historyBytes > 0);
  assert.equal(tiled.sampleColorAt(10, 12, { merged: false }), '#E34B72');
  assert.equal(tiled.sampleColorAt(110, 12, { merged: true }), '#E34B72');
  assert.equal(tiled.composite().length, 128 * 128 * 4);
  assert.deepEqual(tiled.getCompositeDirtyTiles(), []);

  assert.equal(await tiled.undo(), true);
  assert.equal(tiled.sampleColorAt(10, 12, { merged: false }), null);
  assert.equal(tiled.history.length, 0);
  assert.equal(tiled.future.length, 1);
  assert.equal(await tiled.redo(), true);
  assert.equal(tiled.sampleColorAt(10, 12, { merged: false }), '#E34B72');
  assert.equal(tiled.history.length, 1);
  await controller.dispose();

  tiled.setSelectionMask(null);
  assert.equal(tiled.selectionMask, null);
  const selectionMask = new Uint8Array(128 * 128);
  selectionMask.fill(1, 10 * 128, 12 * 128);
  tiled.setSelectionMask(selectionMask);
  assert.equal(tiled.selectionMask[10 * 128], 1);
  assert.throws(() => tiled.setSelectionMask(new Uint8Array(8)), /matching tiled project dimensions/);
  tiled.setSelectionMask(null);
  tiled.drawingModel = { activeWorkspace: 'main' };
  tiled.setVectorModel({ version: 1, objects: [] });
  assert.deepEqual(tiled.getVectorModel(), { version: 1, objects: [] });

  const manifest = await tiled.toManifest();
  assert.equal(manifest.revision, tiled.revision);
  assert.equal(manifest.saveVersion, tiled.saveVersion);
  assert.equal(manifest.serverRevision, 0);
  assert.deepEqual(manifest.drawingModel, { activeWorkspace: 'main' });
  const restored = await TiledRasterProjectDocument.fromManifest(manifest);
  assert.equal(restored.revision, manifest.revision);
  assert.equal(restored.sampleColorAt(10, 12, { merged: false }), '#E34B72');
  restored.dispose();
  tiled.dispose();
});
