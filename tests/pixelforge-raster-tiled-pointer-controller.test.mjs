import test from 'node:test';
import assert from 'node:assert/strict';
import { TiledRasterProjectDocument } from '../public/pixelforge/src/raster-tiled-adapter.mjs';
import { TiledRasterPointerStrokeController } from '../public/pixelforge/src/raster-tiled-pointer-controller.mjs';

const readAll = (doc, layerId) => doc.readRegion(layerId, { x: 0, y: 0, width: doc.width, height: doc.height });

test('pointer lifecycle groups down/move/up into one undoable sparse stroke', async () => {
  const doc = TiledRasterProjectDocument.createBlank({ width: 80, height: 64, tileSize: 32 });
  const layerId = doc.activeLayerId;
  const controller = new TiledRasterPointerStrokeController(doc);
  const blank = readAll(doc, layerId);
  await controller.pointerDown({ pointerId: 7, layerId, point: { x: 2, y: 2 }, settings: { color: '#45aadd', size: 5 } });
  await controller.pointerMove({ pointerId: 7, point: { x: 36, y: 24 } });
  assert.deepEqual(await controller.pointerMove({ pointerId: 8, point: { x: 70, y: 50 } }), { changed: false, ignored: true });
  assert.deepEqual(await controller.pointerMove({ pointerId: 7, point: { x: -1, y: 24 } }), { changed: false, ignored: true, outside: true });
  assert.equal(await controller.pointerUp({ pointerId: 7, commit: true }), true);
  assert.equal(controller.active, false);
  const painted = readAll(doc, layerId);
  assert.notDeepEqual(painted, blank);
  assert.equal(await controller.history.undo(), true);
  assert.deepEqual(readAll(doc, layerId), blank);
  assert.equal(await controller.history.redo(), true);
  assert.deepEqual(readAll(doc, layerId), painted);
  await controller.dispose();
  doc.dispose();
});

test('pointer cancel and lost capture roll back without adding history', async () => {
  for (const finish of ['pointerCancel', 'lostPointerCapture']) {
    const doc = TiledRasterProjectDocument.createBlank({ width: 40, height: 40 });
    const layerId = doc.activeLayerId;
    const controller = new TiledRasterPointerStrokeController(doc);
    const blank = readAll(doc, layerId);
    await controller.pointerDown({ pointerId: 3, layerId, point: { x: 10, y: 10 }, settings: { color: '#ffffff', size: 3 } });
    assert.equal(await controller[finish](3), true);
    assert.deepEqual(readAll(doc, layerId), blank);
    assert.equal(controller.history.canUndo, false);
    await controller.dispose();
    doc.dispose();
  }
});

test('disposing an active pointer controller cancels its stroke and prevents reuse', async () => {
  const doc = TiledRasterProjectDocument.createBlank({ width: 32, height: 32 });
  const layerId = doc.activeLayerId;
  const controller = new TiledRasterPointerStrokeController(doc);
  const blank = readAll(doc, layerId);
  await controller.pointerDown({ pointerId: 11, layerId, point: { x: 4, y: 4 }, settings: { color: '#00ff00' } });
  await controller.dispose();
  assert.deepEqual(readAll(doc, layerId), blank);
  await assert.rejects(() => controller.pointerDown({ pointerId: 11, layerId, point: { x: 4, y: 4 }, settings: {} }), /disposed/);
  doc.dispose();
});
