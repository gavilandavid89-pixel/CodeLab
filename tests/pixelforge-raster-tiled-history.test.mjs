import test from 'node:test';
import assert from 'node:assert/strict';
import { TiledRasterProjectDocument } from '../public/pixelforge/src/raster-tiled-adapter.mjs';
import { TiledRasterStrokeHistory } from '../public/pixelforge/src/raster-tiled-history.mjs';
import { drawTiledShape } from '../public/pixelforge/src/raster-tiled-shapes.mjs';
import { fillTiledGradient } from '../public/pixelforge/src/raster-tiled-gradient.mjs';

const whole = (doc, layerId) => doc.readRegion(layerId, { x: 0, y: 0, width: doc.width, height: doc.height });

test('tiled stroke history commits atomically and supports undo/redo over overlapping dabs', async () => {
  const doc = TiledRasterProjectDocument.createBlank({ width: 96, height: 64, tileSize: 32 });
  const layerId = doc.activeLayerId;
  const history = new TiledRasterStrokeHistory(doc);
  const blank = whole(doc, layerId);
  history.beginStroke(layerId, { color: '#3a91e8', size: 7, opacity: 0.72, shape: 'circle', hardness: 0.4 });
  await history.dab(4, 4);
  await history.segment({ x: 4, y: 4 }, { x: 72, y: 40 });
  assert.equal(history.commitStroke(), true);
  const painted = whole(doc, layerId);
  assert.notDeepEqual(painted, blank);
  assert.equal(history.canUndo, true);
  assert.equal(await history.undo(), true);
  assert.deepEqual(whole(doc, layerId), blank);
  assert.equal(history.canRedo, true);
  assert.equal(await history.redo(), true);
  assert.deepEqual(whole(doc, layerId), painted);
  assert.equal(history.stats.undoCommands, 1);
  history.dispose();
  doc.dispose();
});

test('cancel restores a partially drawn stroke and never adds it to history', async () => {
  const doc = TiledRasterProjectDocument.createBlank({ width: 40, height: 40, tileSize: 32 });
  const layerId = doc.activeLayerId;
  const history = new TiledRasterStrokeHistory(doc);
  const blank = whole(doc, layerId);
  history.beginStroke(layerId, { color: '#ffffff', size: 5 });
  await history.dab(10, 10);
  await history.segment({ x: 10, y: 10 }, { x: 30, y: 30 });
  assert.equal(await history.cancelStroke(), true);
  assert.deepEqual(whole(doc, layerId), blank);
  assert.equal(history.canUndo, false);
  history.dispose();
  doc.dispose();
});

test('stroke exceeding history byte budget rolls back all prior dabs', async () => {
  const doc = TiledRasterProjectDocument.createBlank({ width: 32, height: 32, tileSize: 32 });
  const layerId = doc.activeLayerId;
  const history = new TiledRasterStrokeHistory(doc, { maxBytes: 8 });
  const blank = whole(doc, layerId);
  history.beginStroke(layerId, { color: '#ff0000', size: 1 });
  await history.dab(2, 2);
  await assert.rejects(() => history.dab(3, 3), /byte budget/);
  assert.equal(history.isStrokeActive, false);
  assert.deepEqual(whole(doc, layerId), blank);
  assert.equal(history.canUndo, false);
  history.dispose();
  doc.dispose();
});

test('history rejects undo during an active stroke and validates limits', async () => {
  const doc = TiledRasterProjectDocument.createBlank({ width: 8, height: 8 });
  assert.throws(() => new TiledRasterStrokeHistory(doc, { maxBytes: 0 }), /limits/);
  const history = new TiledRasterStrokeHistory(doc);
  history.beginStroke(doc.activeLayerId, { color: '#00ff00' });
  await assert.rejects(() => history.undo(), /active stroke/);
  await history.cancelStroke();
  history.dispose();
  doc.dispose();
});

import { fillTiledLayer } from '../public/pixelforge/src/raster-tiled-fill.mjs';

test('tiled flood fill stages sparse tiles atomically and supports undo/redo', async () => {
  const doc = TiledRasterProjectDocument.createBlank({ width: 80, height: 64, tileSize: 32 });
  const layerId = doc.activeLayerId;
  const before = whole(doc, layerId);
  const changed = await fillTiledLayer(doc, layerId, 2, 3, { color: '#2a7be4' });
  assert.equal(changed, 80 * 64);
  const painted = whole(doc, layerId);
  assert.notDeepEqual(painted, before);
  assert.equal(doc.history.at(-1).type, 'fill');
  assert.equal(await doc.undo(), true);
  assert.deepEqual(whole(doc, layerId), before);
  assert.equal(await doc.redo(), true);
  assert.deepEqual(whole(doc, layerId), painted);
  doc.dispose();
});

test('tiled contiguous fill respects boundaries and leaves disconnected regions untouched', async () => {
  const doc = TiledRasterProjectDocument.createBlank({ width: 12, height: 8, tileSize: 32 });
  const layerId = doc.activeLayerId;
  const wall = new Uint8ClampedArray(8 * 4);
  for (let i = 0; i < 8; i++) wall.set([0, 0, 0, 255], i * 4);
  await doc.writeRegion(layerId, { x: 5, y: 0, width: 1, height: 8 }, wall);
  const changed = await fillTiledLayer(doc, layerId, 1, 1, { color: '#ff0000' });
  assert.equal(changed, 5 * 8);
  const pixels = whole(doc, layerId);
  assert.deepEqual([...pixels.slice((1 * 12 + 1) * 4, (1 * 12 + 1) * 4 + 4)], [255, 0, 0, 255]);
  assert.deepEqual([...pixels.slice((1 * 12 + 7) * 4, (1 * 12 + 7) * 4 + 4)], [0, 0, 0, 0]);
  doc.dispose();
});

test('tiled fill rejects its working/history budget before changing any cel', async () => {
  const doc = TiledRasterProjectDocument.createBlank({ width: 32, height: 32, tileSize: 32 });
  const layerId = doc.activeLayerId;
  const before = whole(doc, layerId);
  await assert.rejects(
    () => fillTiledLayer(doc, layerId, 0, 0, { color: '#00ff00', maxBytes: 8 }),
    /byte budget/
  );
  assert.deepEqual(whole(doc, layerId), before);
  assert.equal(doc.history.length, 0);
  doc.dispose();
});

test('tile operation history can undo and redo after the target layer is locked', async () => {
  const doc = TiledRasterProjectDocument.createBlank({ width: 32, height: 32, tileSize: 32 });
  const layerId = doc.activeLayerId;
  const before = whole(doc, layerId);
  await fillTiledLayer(doc, layerId, 4, 4, { color: '#abcdef' });
  const after = whole(doc, layerId);
  doc.setLayerLocked(layerId, true);
  assert.equal(await doc.undo(), true);
  assert.deepEqual(whole(doc, layerId), before);
  assert.equal(await doc.redo(), true);
  assert.deepEqual(whole(doc, layerId), after);
  doc.dispose();
});

test('tiled flood fill treats the active selection as a traversal and paint boundary', async () => {
  const doc = TiledRasterProjectDocument.createBlank({ width: 10, height: 10, tileSize: 32 });
  const layerId = doc.activeLayerId;
  const mask = new Uint8Array(100);
  for (let y = 3; y < 6; y++) mask.fill(1, y * 10 + 2, y * 10 + 7);
  doc.setSelectionMask(mask);
  const changed = await fillTiledLayer(doc, layerId, 3, 4, { color: '#11aaee' });
  assert.equal(changed, 15);
  const pixels = whole(doc, layerId);
  assert.deepEqual([...pixels.slice((4 * 10 + 3) * 4, (4 * 10 + 3) * 4 + 4)], [17, 170, 238, 255]);
  assert.deepEqual([...pixels.slice((4 * 10 + 8) * 4, (4 * 10 + 8) * 4 + 4)], [0, 0, 0, 0]);
  doc.dispose();
});

test('tiled fill handles checker pattern and avoids history entries for an identical refill', async () => {
  const doc = TiledRasterProjectDocument.createBlank({ width: 4, height: 4, tileSize: 32 });
  const layerId = doc.activeLayerId;
  const changed = await fillTiledLayer(doc, layerId, 0, 0, {
    color: '#ff0000', secondaryColor: '#0000ff', pattern: 'checker', scale: 1,
  });
  assert.equal(changed, 16);
  const pixels = whole(doc, layerId);
  assert.deepEqual([...pixels.slice(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...pixels.slice(4, 8)], [0, 0, 255, 255]);
  const historyLength = doc.history.length;
  assert.equal(await fillTiledLayer(doc, layerId, 0, 0, {
    color: '#ff0000', secondaryColor: '#0000ff', pattern: 'checker', scale: 1,
  }), 0);
  assert.equal(doc.history.length, historyLength);
  doc.dispose();
});


test('tiled shape paths apply symmetry as one undoable operation', async () => {
  const doc = TiledRasterProjectDocument.createBlank({ width: 20, height: 12, tileSize: 32 });
  const layerId = doc.activeLayerId;
  const before = whole(doc, layerId);
  const points = [{ x: 2, y: 3 }, { x: 3, y: 3 }, { x: 4, y: 3 }];
  const result = await drawTiledShape(doc, layerId, points, {
    color: '#ff8800', size: 1, mode: 'draw', opacity: 1, shape: 'square', hardness: 1,
  }, {
    mapPoint: point => [point, { x: doc.width - 1 - point.x, y: point.y }],
  });
  assert.equal(result.changed, true);
  assert.equal(result.changedDabs, 6);
  const painted = whole(doc, layerId);
  assert.notDeepEqual(painted, before);
  assert.deepEqual([...painted.slice((3 * doc.width + 2) * 4, (3 * doc.width + 2) * 4 + 4)], [255, 136, 0, 255]);
  assert.deepEqual([...painted.slice((3 * doc.width + 17) * 4, (3 * doc.width + 17) * 4 + 4)], [255, 136, 0, 255]);
  assert.equal(doc.history.length, 1);
  assert.equal(await doc.undo(), true);
  assert.deepEqual(whole(doc, layerId), before);
  assert.equal(await doc.redo(), true);
  assert.deepEqual(whole(doc, layerId), painted);
  doc.dispose();
});

test('tiled shape dab cap rejects before drawing and history budget rolls back the whole outline', async () => {
  const doc = TiledRasterProjectDocument.createBlank({ width: 16, height: 8, tileSize: 32 });
  const layerId = doc.activeLayerId;
  const before = whole(doc, layerId);
  const settings = { color: '#00cc88', size: 1, mode: 'draw', opacity: 1, shape: 'square', hardness: 1 };
  await assert.rejects(() => drawTiledShape(doc, layerId, [{ x: 1, y: 1 }, { x: 2, y: 1 }], settings, { maxDabs: 1 }), /dab limit/);
  assert.deepEqual(whole(doc, layerId), before);
  const constrainedHistory = new TiledRasterStrokeHistory(doc, { maxBytes: 8 });
  await assert.rejects(() => drawTiledShape(doc, layerId, [{ x: 1, y: 1 }, { x: 2, y: 1 }], settings, { history: constrainedHistory }), /byte budget/);
  assert.deepEqual(whole(doc, layerId), before);
  assert.equal(constrainedHistory.canUndo, false);
  constrainedHistory.dispose();
  doc.dispose();
});


test('tiled linear gradient stages changed tiles and is one undoable operation', async () => {
  const doc = TiledRasterProjectDocument.createBlank({ width: 40, height: 12, tileSize: 16 });
  const layerId = doc.activeLayerId;
  const before = whole(doc, layerId);
  const changed = await fillTiledGradient(doc, layerId, 0, 0, 39, 0, {
    startColor: '#ff0000', endColor: '#0000ff', opacity: 1,
  });
  assert.equal(changed, 40 * 12);
  const painted = whole(doc, layerId);
  assert.deepEqual([...painted.slice(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...painted.slice((11 * 40 + 39) * 4, (11 * 40 + 39) * 4 + 4)], [0, 0, 255, 255]);
  assert.equal(doc.history.length, 1);
  assert.equal(doc.history.at(-1).type, 'gradient');
  assert.equal(await doc.undo(), true);
  assert.deepEqual(whole(doc, layerId), before);
  assert.equal(await doc.redo(), true);
  assert.deepEqual(whole(doc, layerId), painted);
  doc.dispose();
});

test('tiled gradient respects selection, rejects budget overflow atomically and skips no-op work', async () => {
  const doc = TiledRasterProjectDocument.createBlank({ width: 24, height: 12, tileSize: 8 });
  const layerId = doc.activeLayerId;
  const mask = new Uint8Array(doc.width * doc.height);
  for (let y = 2; y < 6; y++) mask.fill(1, y * doc.width + 3, y * doc.width + 9);
  doc.setSelectionMask(mask);
  const before = whole(doc, layerId);
  await assert.rejects(() => fillTiledGradient(doc, layerId, 0, 0, 23, 0, {
    startColor: '#ff0000', endColor: '#0000ff', maxBytes: 8,
  }), /byte budget/);
  assert.deepEqual(whole(doc, layerId), before);
  assert.equal(doc.history.length, 0);
  const changed = await fillTiledGradient(doc, layerId, 0, 0, 23, 0, {
    startColor: '#ff0000', endColor: '#0000ff',
  });
  assert.equal(changed, 24);
  const pixels = whole(doc, layerId);
  assert.deepEqual([...pixels.slice((3 * 24 + 4) * 4, (3 * 24 + 4) * 4 + 4)].slice(3), [255]);
  assert.deepEqual([...pixels.slice((3 * 24 + 12) * 4, (3 * 24 + 12) * 4 + 4)], [0, 0, 0, 0]);
  assert.equal(await fillTiledGradient(doc, layerId, 0, 0, 23, 0, {
    startColor: '#ff0000', endColor: '#0000ff',
  }), 0);
  assert.equal(doc.history.length, 1);
  doc.dispose();
});

test('tiled gradient validates endpoints and respects layer locking', async () => {
  const doc = TiledRasterProjectDocument.createBlank({ width: 8, height: 8, tileSize: 8 });
  const layerId = doc.activeLayerId;
  await assert.rejects(() => fillTiledGradient(doc, layerId, -1, 0, 7, 7), /endpoints/);
  doc.setLayerLocked(layerId, true);
  await assert.rejects(() => fillTiledGradient(doc, layerId, 0, 0, 7, 7), /locked/);
  doc.dispose();
});
