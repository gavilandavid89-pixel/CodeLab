import test from 'node:test';
import assert from 'node:assert/strict';
import { createDrawingModel, inspectRasterObject, buildReferenceFromProject, DRAWING_SHEET_PRESETS } from '../public/pixelforge/src/drawing-intelligence.js';

test('drawing intelligence returns object geometry and coordinates', () => {
  const pixels = new Uint8Array(16 * 16 * 4);
  for (let y = 4; y <= 6; y++) for (let x = 5; x <= 8; x++) pixels[(y * 16 + x) * 4 + 3] = 255;
  const result = inspectRasterObject({ pixels, width: 16, height: 16, x: 6, y: 5, gridStep: 4 });
  assert.equal(result.found, true);
  assert.equal(result.pixelCount, 9);
  assert.deepEqual(result.bounds, { x: 5, y: 4, width: 4, height: 3 });
  assert.equal(result.coordinates.length, 9);
  assert.deepEqual(result.grid.boundsInCells, { x: 1, y: 1, width: 1, height: 1 });
});

test('digital sheet keeps fine precision independent from grid', () => {
  assert.equal(DRAWING_SHEET_PRESETS.sheet1024.width, 1024);
  assert.equal(DRAWING_SHEET_PRESETS.sheet1024.gridStep, 8);
  assert.equal(DRAWING_SHEET_PRESETS.sheet1024.brushMin, 1);
});

test('reference center preserves parts, frames and layer metadata', () => {
  const project = {
    id: 'p1', width: 64, height: 64,
    layers: [{ id: 'body', name: 'Body', opacity: 1, visible: true, locked: false }],
    animation: { frames: [{ id: 'f0', durationMs: 100, cels: [{ layerId: 'body', pixels: 'abc' }] }] },
    drawingModel: createDrawingModel({ sheet: { width: 64, height: 64 } }),
  };
  const ref = buildReferenceFromProject({ projectId: 'p1', project });
  assert.equal(ref.parts[0].layerId, 'body');
  assert.equal(ref.frames[0].layers[0].layerId, 'body');
  assert.equal(ref.layerSnapshot[0].name, 'Body');
  assert.equal(ref.frameLayerMap[0].layers[0].layerId, 'body');
});
