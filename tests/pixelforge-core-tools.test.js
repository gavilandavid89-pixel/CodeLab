const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');

globalThis.crypto ??= webcrypto;

async function loadCore() {
  const source = fs.readFileSync(path.join(__dirname, '../public/pixelforge/src/core.js'), 'utf8');
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

function paintPixel(doc, x, y, color) {
  const stroke = doc.beginStroke({ color, size: 1, mode: 'draw' });
  doc.strokeTo(stroke, x, y);
  doc.endStroke(stroke);
}

async function main() {
  const { RasterDocument, modifySelectionMask, combineSelectionMasks, translateSelectionMask } = await loadCore();

  // Eyedropper sampling must return the exact visible pixel color and respect
  // active-layer vs merged sampling.
  const sampled = new RasterDocument(4, 4, 'Sampling regression');
  paintPixel(sampled, 1, 1, '#12ABEF');
  assert.equal(sampled.sampleColorAt(1, 1), '#12ABEF');
  assert.equal(sampled.sampleColorAt(1, 1, { merged: false }), '#12ABEF');
  assert.equal(sampled.sampleColorAt(0, 0), null);

  const upper = sampled.addLayer('Upper');
  paintPixel(sampled, 1, 1, '#F02030');
  assert.equal(sampled.sampleColorAt(1, 1), '#F02030', 'merged sampling should read the visible top layer');
  assert.equal(sampled.sampleColorAt(1, 1, { merged: false }), '#F02030');
  sampled.setLayerVisibility(upper.id, false);
  assert.equal(sampled.sampleColorAt(1, 1), '#12ABEF', 'hidden layers must not affect merged sampling');

  // Layer lifecycle: rename, duplicate, reorder, opacity, lock, visibility,
  // deletion and history replay all operate on stable layer identities.
  const layerDoc = new RasterDocument(4, 4, 'Layer regression');
  const baseLayer = layerDoc.activeLayer;
  const second = layerDoc.addLayer('Second');
  assert.equal(layerDoc.layers.length, 2);
  assert.equal(layerDoc.renameLayer(second.id, 'Foreground'), true);
  assert.equal(layerDoc.setLayerOpacity(second.id, 0.5), true);
  layerDoc.setLayerVisibility(second.id, false);
  assert.equal(layerDoc.layers.find(layer => layer.id === second.id).visible, false);
  layerDoc.setLayerVisibility(second.id, true);
  const duplicate = layerDoc.duplicateLayer(second.id, 'Foreground copy');
  assert.equal(layerDoc.activeLayerId, duplicate.id);
  assert.equal(layerDoc.layers.length, 3);
  assert.equal(layerDoc.moveLayer(duplicate.id, 0), true);
  assert.equal(layerDoc.layers[0].id, duplicate.id);
  layerDoc.setLayerLocked(duplicate.id, true);
  assert.throws(() => layerDoc.beginStroke({ color: '#FFFFFF' }), /locked/i);
  layerDoc.setLayerLocked(duplicate.id, false);
  layerDoc.deleteLayer(duplicate.id);
  assert.equal(layerDoc.layers.length, 2);
  assert.equal(layerDoc.undo(), true, 'layer deletion should be undoable');
  assert.equal(layerDoc.layers.length, 3);
  assert.equal(layerDoc.redo(), true, 'layer deletion should be redoable');
  assert.equal(layerDoc.layers.length, 2);
  assert.ok(layerDoc.layers.some(layer => layer.id === baseLayer.id));

  // Selection masks: invert/expand/contract, boolean combination and movement.
  const mask = new Uint8Array(16);
  mask[5] = 1;
  const inverted = modifySelectionMask(4, 4, mask, 'invert');
  assert.equal(inverted[5], 0);
  assert.equal(inverted[0], 1);
  const expanded = modifySelectionMask(4, 4, mask, 'expand', 1);
  assert.equal(expanded[5], 1);
  assert.equal(expanded[1], 1);
  assert.equal(expanded[4], 1);
  const contracted = modifySelectionMask(4, 4, expanded, 'contract', 1);
  assert.equal(contracted[5], 1);
  const movedMask = translateSelectionMask(4, 4, mask, 1, 0);
  assert.equal(movedMask[6], 1);
  assert.equal(movedMask[5], 0);
  const union = combineSelectionMasks(4, 4, mask, movedMask, 'add');
  assert.equal(union[5], 1);
  assert.equal(union[6], 1);

  // Selected transform must move only selected pixels, clear the source and
  // remain a single undo/redo transaction.
  const transformDoc = new RasterDocument(4, 4, 'Transform regression');
  paintPixel(transformDoc, 1, 1, '#FF0000');
  const selection = new Uint8Array(16);
  selection[5] = 1;
  transformDoc.setSelectionMask(selection);
  const transformed = transformDoc.transformRect(0, 0, 4, 4, { dx: 1, dy: 0 });
  assert.ok(transformed.changedPixels > 0);
  assert.equal(transformDoc.sampleColorAt(1, 1, { merged: false }), null);
  assert.equal(transformDoc.sampleColorAt(2, 1, { merged: false }), '#FF0000');
  assert.equal(transformDoc.undo(), true);
  assert.equal(transformDoc.sampleColorAt(1, 1, { merged: false }), '#FF0000');
  assert.equal(transformDoc.sampleColorAt(2, 1, { merged: false }), null);
  assert.equal(transformDoc.redo(), true);
  assert.equal(transformDoc.sampleColorAt(2, 1, { merged: false }), '#FF0000');

  // Crop must resize every layer and preserve full-document undo/redo.
  const cropDoc = new RasterDocument(4, 4, 'Crop regression');
  paintPixel(cropDoc, 1, 1, '#00AA44');
  cropDoc.addLayer('Second');
  paintPixel(cropDoc, 2, 2, '#2244CC');
  assert.equal(cropDoc.cropCanvas(1, 1, 2, 2), true);
  assert.equal(cropDoc.width, 2);
  assert.equal(cropDoc.height, 2);
  assert.equal(cropDoc.layers.length, 2);
  assert.equal(cropDoc.sampleColorAt(0, 0, { merged: false }), '#00AA44');
  assert.equal(cropDoc.undo(), true);
  assert.equal(cropDoc.width, 4);
  assert.equal(cropDoc.height, 4);
  assert.equal(cropDoc.sampleColorAt(1, 1, { merged: false }), '#00AA44');
  assert.equal(cropDoc.redo(), true);
  assert.equal(cropDoc.width, 2);

  // Pixel operations used by the color/transform toolbar.
  const colorDoc = new RasterDocument(3, 3, 'Color operations');
  paintPixel(colorDoc, 1, 1, '#FF0000');
  assert.equal(colorDoc.createOutline('#00FF00'), 8);
  assert.equal(colorDoc.sampleColorAt(0, 0, { merged: false }), '#00FF00');
  assert.equal(colorDoc.replaceColor('#FF0000', '#0000FF'), 1);
  assert.equal(colorDoc.sampleColorAt(1, 1, { merged: false }), '#0000FF');
  assert.equal(colorDoc.undo(), true);
  assert.equal(colorDoc.sampleColorAt(1, 1, { merged: false }), '#FF0000');

  const flipDoc = new RasterDocument(3, 1, 'Flip regression');
  paintPixel(flipDoc, 0, 0, '#FF0000');
  paintPixel(flipDoc, 2, 0, '#0000FF');
  assert.ok(flipDoc.flipRect(0, 0, 3, 1, 'horizontal') > 0);
  assert.equal(flipDoc.sampleColorAt(0, 0, { merged: false }), '#0000FF');
  assert.equal(flipDoc.sampleColorAt(2, 0, { merged: false }), '#FF0000');

  const gradientDoc = new RasterDocument(4, 1, 'Gradient regression');
  assert.equal(gradientDoc.fillGradient(0, 0, 3, 0, { startColor: '#FF0000', endColor: '#0000FF' }), 4);
  assert.equal(gradientDoc.sampleColorAt(0, 0, { merged: false }), '#FF0000');
  assert.equal(gradientDoc.sampleColorAt(3, 0, { merged: false }), '#0000FF');

  console.log('PixelForge raster core regressions passed: sampling, layer lifecycle, selection masks, transform, crop, color operations, flip and gradient.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
