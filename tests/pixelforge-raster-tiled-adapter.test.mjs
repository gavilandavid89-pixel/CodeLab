import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { RasterDocument } from '../public/pixelforge/src/core.js';
import { TiledRasterProjectDocument } from '../public/pixelforge/src/raster-tiled-adapter.mjs';
import { SparseTileCelStore, PIXELFORGE_TILED_CEL_FORMAT, PIXELFORGE_TILED_CEL_VERSION } from '../public/pixelforge/src/animation-tiles.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

test('migrates all raster layers and project drawing configuration into a tiled manifest losslessly', async () => {
  const source = new RasterDocument(80, 72, 'Traditional raster');
  source.setDrawingModel({ projectNote: 'preserve-me' });
  source.activeLayer.pixels.set([7, 44, 99, 255], (65 * 80 + 70) * 4);
  source.activeLayer.opacity = 0.7;
  const extra = source.addLayer('Ink');
  extra.pixels.set([200, 30, 40, 255], (3 * 80 + 4) * 4);
  const config = { version: 1, availableModes: ['illustration', 'pixel-art'], initialMode: 'illustration', activeMode: 'illustration' };
  const tiled = await TiledRasterProjectDocument.fromDocument(source, { tileSize: 32, drawingConfiguration: config });
  const manifest = await tiled.toManifest();
  assert.equal(manifest.layers.length, 2);
  assert.equal(manifest.layers[0].cel.tiles.length, 1);
  assert.equal(manifest.layers[1].cel.tiles.length, 1);
  assert.deepEqual(manifest.drawingConfiguration, config);
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
