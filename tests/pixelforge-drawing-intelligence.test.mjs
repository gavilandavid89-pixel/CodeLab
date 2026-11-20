import assert from 'node:assert/strict';
import test from 'node:test';
import { createDrawingModel, normalizeDrawingModel, inspectRasterObject, extractLineGuide, DRAWING_SHEET_PRESETS, SEMANTIC_PALETTE } from '../public/pixelforge/src/drawing-intelligence.js';
import { HeadlessEditorRuntime } from '../public/pixelforge/src/headless.js';

test('drawing intelligence returns object geometry in one request', () => {
  const pixels = new Uint8ClampedArray(16 * 16 * 4);
  for (let y = 3; y < 9; y++) for (let x = 4; x < 10; x++) {
    const i = (y * 16 + x) * 4;
    pixels[i] = 255; pixels[i + 3] = 255;
  }
  const result = inspectRasterObject({ pixels, width: 16, height: 16, x: 5, y: 5, gridStep: 4 });
  assert.equal(result.found, true);
  assert.equal(result.pixelCount, 36);
  assert.deepEqual(result.bounds, { x: 4, y: 3, width: 6, height: 6, pixelCount: 36 });
  assert.equal(result.coordinates.length, 36);
  assert.equal(result.grid.boundsInCells.width, 2);
});

test('digital sheet presets and semantic palette are stable', () => {
  const model = normalizeDrawingModel(createDrawingModel({}), { width: 1024, height: 1024 });
  assert.equal(DRAWING_SHEET_PRESETS.sheet1024.gridStep, 8);
  assert.equal(model.sheet.width, 1024);
  assert.equal(SEMANTIC_PALETTE.metallic.steelLight, '#B8B6AF');
});

test('line guide extraction produces monochrome transparent background', () => {
  const pixels = new Uint8ClampedArray(8 * 8 * 4);
  for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) {
    const i = (y * 8 + x) * 4;
    pixels[i] = pixels[i + 1] = pixels[i + 2] = 255; pixels[i + 3] = 255;
  }
  const guide = extractLineGuide({ pixels, width: 8, height: 8, threshold: 10 });
  assert.equal(guide.mimeType, 'image/line-guide');
  assert.equal(guide.pixels[0 + 3], 0);
  assert.ok([...guide.pixels].some((value, index) => index % 4 === 3 && value === 255));
});

test('headless drawing metadata survives proposal acceptance and project reload', () => {
  const runtime = new HeadlessEditorRuntime({ width: 32, height: 32, name: 'Intelligence persistence' });
  assert.equal(runtime.execute({
    name: 'drawing.sheet.configure',
    sheet: { mode: 'digital-sheet', preset: 'digital256', gridStep: 4 },
  }).ok, true);
  const draw = runtime.execute({
    name: 'canvas.draw_stroke',
    points: [{ x: 4, y: 4 }, { x: 12, y: 12 }],
    color: '#D4A84F',
    size: 2,
  });
  assert.equal(draw.ok, true);
  const selected = runtime.execute({ name: 'drawing.object.select_at', layerId: runtime.sandbox.activeLayerId, x: 5, y: 5 });
  assert.equal(selected.ok, true);
  assert.ok(selected.result.selectedPixels > 0);
  const object = runtime.execute({ name: 'drawing.object.inspect', layerId: runtime.sandbox.activeLayerId, x: 5, y: 5, gridStep: 4 });
  assert.equal(object.ok, true);
  assert.equal(object.result.found, true);
  assert.ok(object.result.coordinates.length > 0);

  const reference = runtime.execute({ name: 'drawing.reference.create', name: 'Soldier Center' });
  assert.equal(reference.ok, true);
  const proposal = runtime.createProposal('Persist drawing intelligence metadata');
  assert.equal(proposal.status, 'pending');
  assert.equal(runtime.acceptProposal().status, 'applied');

  const saved = runtime.toJSON();
  assert.equal(saved.drawingModel.sheet.mode, 'digital-sheet');
  assert.equal(saved.drawingModel.referenceCenter.entries.length, 1);
  const reloaded = HeadlessEditorRuntime.fromJSON(saved);
  const listed = reloaded.execute({ name: 'drawing.reference.list' });
  assert.equal(listed.ok, true);
  assert.equal(listed.result.entries[0].name, 'Soldier Center');
});

test('headless tools support line-guide layers and frame motion analysis', () => {
  const runtime = new HeadlessEditorRuntime({ width: 8, height: 8, name: 'Guide and motion' });
  const source = new Uint8Array(8 * 8 * 4);
  for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) {
    const i = (y * 8 + x) * 4; source[i] = source[i + 1] = source[i + 2] = 255; source[i + 3] = 255;
  }
  const b64 = Buffer.from(source).toString('base64');
  const guide = runtime.execute({ name: 'drawing.reference.extract_line_guide', pixels: b64, width: 8, height: 8, threshold: 10 });
  assert.equal(guide.ok, true);
  assert.equal(guide.result.name, 'Reference Guide');

  assert.equal(runtime.execute({ name: 'animation.frame.capture_document', frameName: 'A' }).ok, true);
  assert.equal(runtime.execute({ name: 'canvas.draw_stroke', points: [{ x: 5, y: 2 }, { x: 7, y: 2 }], color: '#FFFFFF', size: 1 }).ok, true);
  assert.equal(runtime.execute({ name: 'animation.frame.capture_document', frameName: 'B' }).ok, true);
  const motion = runtime.execute({ name: 'drawing.motion.analyze', beforeIndex: 0, afterIndex: 1 });
  assert.equal(motion.ok, true);
  assert.equal(motion.result.found, true);
  assert.ok(Number.isFinite(motion.result.displacement.dx));
});
