import assert from 'node:assert/strict';
import test from 'node:test';
import { createVectorModel, vectorModelToSVG, auditVectorModel } from '../public/pixelforge/src/vector-studio.js';

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
