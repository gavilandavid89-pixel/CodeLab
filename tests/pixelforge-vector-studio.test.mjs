import assert from 'node:assert/strict';
import test from 'node:test';
import { createVectorModel, vectorModelToSVG } from '../public/pixelforge/src/vector-studio.js';

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
});
