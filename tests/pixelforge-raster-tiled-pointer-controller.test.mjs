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


test('pointer writes are serialized when move and pointer-up arrive before the first tile write settles', async () => {
  const document = TiledRasterProjectDocument.createBlank({
    width: 128, height: 128, tileSize: 32, maxDecodedCacheBytes: 64 * 1024,
  });
  const controller = new TiledRasterPointerStrokeController(document);
  const down = controller.pointerDown({
    pointerId: 91, layerId: document.activeLayerId,
    points: [{ x: 8, y: 8 }, { x: 120, y: 8 }, null],
    settings: { color: '#33aaff', size: 3, mode: 'draw', opacity: 1, shape: 'square', hardness: 1 },
  });
  const move = controller.pointerMove({
    pointerId: 91,
    points: [{ x: 12, y: 12 }, { x: 116, y: 12 }, null],
  });
  const up = controller.pointerUp({ pointerId: 91 });
  await Promise.all([down, move, up]);
  assert.equal(controller.active, false);
  assert.equal(document.history.length, 1);
  assert.deepEqual(Array.from(document.readRegion(document.activeLayerId, { x: 12, y: 12, width: 1, height: 1 })), [51, 170, 255, 255]);
  assert.deepEqual(Array.from(document.readRegion(document.activeLayerId, { x: 116, y: 12, width: 1, height: 1 })), [51, 170, 255, 255]);
  await document.undo();
  assert.deepEqual(Array.from(document.readRegion(document.activeLayerId, { x: 12, y: 12, width: 1, height: 1 })), [0, 0, 0, 0]);
  await controller.dispose();
  document.dispose();
});


test('pointer controller resolves the current document history for every new frame gesture', async () => {
  const doc = TiledRasterProjectDocument.createBlank({ width: 64, height: 64, tileSize: 32 });
  const layerId = doc.activeLayerId;
  const controller = new TiledRasterPointerStrokeController(doc);
  const draw = async (pointerId, x, y, color) => {
    await controller.pointerDown({ pointerId, layerId, point: { x, y }, settings: { color, size: 3, shape: 'square', hardness: 1, opacity: 1 } });
    await controller.pointerUp({ pointerId });
  };
  await draw(1, 8, 8, '#ff0000');
  const frame0History = doc.strokeHistory;
  assert.equal(frame0History.canUndo, true);

  const blankFrame1History = doc.swapStrokeHistory(doc.createStrokeHistory());
  await draw(2, 40, 40, '#0000ff');
  const frame1History = doc.strokeHistory;
  assert.notEqual(frame1History, frame0History);
  assert.equal(frame1History.canUndo, true, 'new gesture must write to the swapped-in frame history');
  assert.equal(frame0History.canUndo, true, 'previous frame history must remain retained');
  assert.equal(await doc.undo(), true);
  assert.equal(doc.readRegion(layerId, { x: 40, y: 40, width: 1, height: 1 })[3], 0);
  assert.equal(frame0History.canUndo, true);

  doc.swapStrokeHistory(frame0History).dispose();
  assert.equal(await doc.undo(), true);
  assert.equal(doc.readRegion(layerId, { x: 8, y: 8, width: 1, height: 1 })[3], 0);
  await controller.dispose();
  doc.dispose();
});
