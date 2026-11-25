import test from 'node:test';
import assert from 'node:assert/strict';
import { RasterDocument } from '../public/pixelforge/src/core.js';
import { TiledRasterProjectDocument } from '../public/pixelforge/src/raster-tiled-adapter.mjs';
import { applyTiledBrushDab, applyTiledBrushSegment } from '../public/pixelforge/src/raster-tiled-brush.mjs';

test('tiled brush and eraser match dense RasterDocument pixels across tile and canvas edges', async () => {
  const dense = new RasterDocument(130, 90, 'Brush parity');
  const tiled = await TiledRasterProjectDocument.fromDocument(dense, { tileSize: 32 });
  const layerId = dense.activeLayer.id;
  const stroke = dense.beginStroke({
    color: '#e34b72', size: 9, mode: 'draw', opacity: 0.63,
    shape: 'circle', hardness: 0.35,
  });
  dense.strokeTo(stroke, 0, 0);
  await applyTiledBrushDab(tiled, layerId, 0, 0, {
    color: '#e34b72', size: 9, mode: 'draw', opacity: 0.63,
    shape: 'circle', hardness: 0.35,
  });
  dense.strokeTo(stroke, 35, 29);
  await applyTiledBrushSegment(tiled, layerId, { x: 0, y: 0 }, { x: 35, y: 29 }, {
    color: '#e34b72', size: 9, mode: 'draw', opacity: 0.63,
    shape: 'circle', hardness: 0.35,
  });
  dense.strokeTo(stroke, 129, 89);
  await applyTiledBrushSegment(tiled, layerId, { x: 35, y: 29 }, { x: 129, y: 89 }, {
    color: '#e34b72', size: 9, mode: 'draw', opacity: 0.63,
    shape: 'circle', hardness: 0.35,
  });
  dense.endStroke(stroke);

  const eraser = dense.beginStroke({ size: 4, mode: 'erase', opacity: 0.4, shape: 'square' });
  dense.strokeTo(eraser, 33, 31);
  dense.strokeTo(eraser, 65, 48);
  await applyTiledBrushDab(tiled, layerId, 33, 31, { size: 4, mode: 'erase', opacity: 0.4, shape: 'square' });
  await applyTiledBrushSegment(tiled, layerId, { x: 33, y: 31 }, { x: 65, y: 48 }, {
    size: 4, mode: 'erase', opacity: 0.4, shape: 'square',
  });
  dense.endStroke(eraser);

  assert.deepEqual(tiled.readRegion(layerId, { x: 0, y: 0, width: 130, height: 90 }), dense.activeLayer.pixels);
  tiled.dispose();
});

test('tiled brush rejects invalid coordinates, settings, and locked layers without changing pixels', async () => {
  const dense = new RasterDocument(20, 20, 'Brush validation');
  const tiled = await TiledRasterProjectDocument.fromDocument(dense);
  const layerId = dense.activeLayer.id;
  const before = tiled.readRegion(layerId, { x: 0, y: 0, width: 20, height: 20 });
  await assert.rejects(() => applyTiledBrushDab(tiled, layerId, -1, 0), /outside/);
  await assert.rejects(() => applyTiledBrushDab(tiled, layerId, 0, 0, { size: 129 }), /size/);
  await assert.rejects(() => applyTiledBrushDab(tiled, layerId, 0, 0, { mode: 'smudge' }), /mode/);
  tiled.updateLayer(layerId, { locked: true });
  await assert.rejects(() => applyTiledBrushDab(tiled, layerId, 4, 4), /locked/);
  assert.deepEqual(tiled.readRegion(layerId, { x: 0, y: 0, width: 20, height: 20 }), before);
  tiled.dispose();
});

test('tiled brush no-op opacity does not allocate sparse tile resources', async () => {
  const tiled = TiledRasterProjectDocument.createBlank({ width: 4096, height: 4096, maxDecodedCacheBytes: 0 });
  const result = await applyTiledBrushDab(tiled, tiled.activeLayerId, 2048, 2048, { color: '#ffffff', opacity: 0 });
  assert.equal(result.changed, false);
  assert.equal(tiled.stats.resourceCount, 0);
  tiled.dispose();
});
