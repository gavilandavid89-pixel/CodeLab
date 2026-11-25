import test from 'node:test';
import assert from 'node:assert/strict';
import { TiledRasterProjectDocument } from '../public/pixelforge/src/raster-tiled-adapter.mjs';
import { TiledRasterStrokeHistory } from '../public/pixelforge/src/raster-tiled-history.mjs';

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
