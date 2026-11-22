import assert from 'node:assert/strict';
import test from 'node:test';
import { createVectorModel, vectorModelToSVG, auditVectorModel, parseSvgPathData } from '../public/pixelforge/src/vector-studio.js';
import { RasterDocument } from '../public/pixelforge/src/core.js';

test('vector model stores editable objects and exports SVG', () => {
  const model = createVectorModel(256, 256);
  model.objects.push(
    { id: 'r1', type: 'rect', x: 16, y: 24, width: 80, height: 40, fill: '#9B8AFB', stroke: '#E8EAF2', strokeWidth: 2 },
    { id: 'p1', type: 'path', points: [{ x: 10, y: 10 }, { x: 20, y: 20 }, { x: 30, y: 10 }], closed: false, fill: 'none', stroke: '#59D8B4', strokeWidth: 2 }
  );
  assert.equal(model.objects.length, 2);
  const svg = vectorModelToSVG(model);
  assert.match(svg, /<rect/);
  assert.match(svg, /<path/);
  assert.match(svg, /viewBox="0 0 256 256"/);
});

test('vector model is JSON serializable for PixelForge project persistence', () => {
  const model = createVectorModel(64, 64);
  model.objects.push({ id: 'e1', type: 'ellipse', x: 8, y: 12, width: 20, height: 14, fill: '#ffffff', stroke: 'none' });
  const roundTrip = JSON.parse(JSON.stringify(model));
  assert.deepEqual(roundTrip.objects[0], model.objects[0]);
  assert.equal(roundTrip.version, 5);
});

test('vector model supports gradients, groups and animation keyframes in persistence/export', () => {
  const model = createVectorModel(320, 180);
  model.objects.push({
    id: 'g1', type: 'group', name: 'Character', transform: {},
    children: [{
      id: 'r1', type: 'rect', x: 20, y: 20, width: 60, height: 40,
      fill: 'none', stroke: '#fff', gradient: {
        type: 'linear', stops: [{ offset: 0, color: '#fff' }, { offset: 100, color: '#000' }]
      },
      keyframes: [{ time: 0, x: 20, y: 20 }, { time: 10, x: 80, y: 20 }]
    }]
  });
  const svg = vectorModelToSVG(model);
  assert.match(svg, /linearGradient/);
  assert.match(svg, /<g/);
  assert.match(svg, /<rect/);
  const roundTrip = JSON.parse(JSON.stringify(model));
  assert.deepEqual(roundTrip, model);
});

test('vector audit reports invalid geometry deterministically', () => {
  const model = createVectorModel(100, 100);
  model.objects.push({ id: 'bad', type: 'rect', x: NaN, y: 0, width: 10, height: 10 });
  const audit = auditVectorModel(model);
  assert.equal(audit.ok, false);
  assert.ok(audit.issues.some(issue => issue.code === 'invalid_geometry'));
});

test('SVG path parser preserves relative, horizontal, vertical, cubic and quadratic curves', () => {
  const parsed = parseSvgPathData('M 2 3 l 4 0 h 2 v 3 C 9 6 10 7 11 8 Q 12 9 13 10 T 15 12 z');
  assert.equal(parsed.closed, true);
  assert.deepEqual(parsed.points.slice(0, 4), [
    { x: 2, y: 3 }, { x: 6, y: 3 }, { x: 8, y: 3 }, { x: 8, y: 6 }
  ]);
  assert.equal(parsed.points[4].kind, 'cubic');
  assert.equal(parsed.points[5].kind, 'cubic');
  assert.equal(parsed.points[6].kind, 'cubic');
  assert.throws(() => parseSvgPathData('M 1'), /Malformed SVG path/);
  assert.throws(() => parseSvgPathData('M 1 2 A 3 4 0 0 1 5 6'), /Unsupported SVG path command/);
});

test('vector edits participate in real document undo and redo history', () => {
  const doc = new RasterDocument(64, 64, 'Vector history');
  const original = createVectorModel(64, 64);
  doc.setVectorModel(original);
  const edited = createVectorModel(64, 64, original);
  edited.objects.push({ id: 'shape-1', type: 'rect', x: 4, y: 5, width: 20, height: 12, transform: {} });
  assert.equal(doc.setVectorModel(edited), true);
  assert.equal(doc.getVectorModel().objects.length, 1);
  assert.equal(doc.undo(), true);
  assert.equal(doc.getVectorModel().objects.length, 0);
  assert.equal(doc.redo(), true);
  assert.equal(doc.getVectorModel().objects[0].id, 'shape-1');
});

test('vector model survives full project serialization and rehydration', () => {
  const doc = new RasterDocument(64, 64, 'Vector persistence');
  const model = createVectorModel(64, 64);
  model.objects.push({
    id: 'group-1', type: 'group', transform: { svgTransform: 'translate(4 5)' },
    children: [{ id: 'shape-1', type: 'rect', x: 3, y: 4, width: 15, height: 16, gradient: { type: 'linear', stops: [{ offset: 0, color: '#fff' }, { offset: 100, color: '#000' }] } }]
  });
  doc.setVectorModel(model);
  const saved = doc.toJSON();
  const loaded = RasterDocument.fromJSON(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(loaded.getVectorModel(), model);
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.toJSON().vectorModel)), model);
});
