import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeIllustrationScene,
  validateIllustrationScene,
  compileIllustrationScene,
} from '../public/pixelforge/src/illustration-scene.js';

const scene = {
  canvas: { width: 128, height: 128 },
  intent: 'A person walking with a rifle, viewed three-quarter front.',
  composition: { subjectCenter: { x: 64, y: 63 }, horizon: 94 },
  palette: { body: '#8A6A45', head: '#E1A37A', background: '#14161E' },
  lighting: { keyDirection: 'upper-left', intensity: 0.8 },
  constraints: { motion: { primaryAxis: 'x', preserve: ['head', 'torso', 'background'] } },
  nodes: [
    { id: 'bg', type: 'background', layer: 'Background', z: 0,
      geometry: { x: 0, y: 0, width: 128, height: 128 }, style: { color: '#14161E', fill: true } },
    { id: 'torso', type: 'body', name: 'Torso', layer: 'Body', z: 10,
      metadata: { bodyPart: 'torso' }, geometry: { points: [{ x: 55, y: 48 }, { x: 73, y: 48 }, { x: 78, y: 88 }, { x: 50, y: 88 }, { x: 55, y: 48 }] },
      style: { color: '#8A6A45', width: 2 } },
    { id: 'head', type: 'head', name: 'Head', layer: 'Body', z: 20,
      metadata: { bodyPart: 'head' }, geometry: { center: { x: 64, y: 37 }, rx: 9, ry: 10 }, style: { color: '#E1A37A', fill: true } },
    { id: 'leg', type: 'limb', name: 'Left leg', layer: 'Body', z: 30,
      metadata: { bodyPart: 'left_leg' }, geometry: { start: { x: 57, y: 86 }, end: { x: 47, y: 115 } },
      style: { color: '#8A6A45', width: 3 } },
  ],
};

test('semantic scene normalizes composition, anatomy and motion constraints', () => {
  const normalized = normalizeIllustrationScene(scene);
  assert.equal(normalized.version, 1);
  assert.equal(normalized.canvas.width, 128);
  assert.equal(normalized.nodes.length, 4);
  assert.equal(normalized.nodes[1].metadata.bodyPart, 'torso');
});

test('semantic scene rejects missing anatomical anchors', () => {
  const result = validateIllustrationScene({
    canvas: { width: 64, height: 64 },
    nodes: [{ id: 'bg', type: 'background', geometry: { x: 0, y: 0, width: 64, height: 64 } }],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /head anchor/);
  assert.match(result.errors.join(' '), /torso anchor/);
});

test('semantic scene compiles into deterministic allowlisted raster actions', () => {
  const compiled = compileIllustrationScene(scene);
  assert.equal(compiled.compilation.mode, 'semantic-to-raster');
  assert.equal(compiled.actionCount, 4);
  assert.equal(compiled.actions[0].name, 'canvas.draw_shape');
  assert.equal(compiled.actions[1].name, 'canvas.draw_stroke');
  assert.equal(compiled.actions[2].name, 'canvas.draw_shape');
  assert.equal(compiled.actions[3].name, 'canvas.draw_line');
  assert.equal(compiled.compilation.noImageGeneration, true);
});
