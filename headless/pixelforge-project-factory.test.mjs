import test from 'node:test';
import assert from 'node:assert/strict';
import { createPixelForgeProject, normalizePixelForgeProjectOptions } from '../public/pixelforge/src/project-factory.js';

test('custom PixelForge project factory creates a valid blank canvas', () => {
  const created = createPixelForgeProject();
  assert.equal(created.project.format, 'pixelforge-project');
  assert.equal(created.project.version, 1);
  assert.equal(created.project.width, 128);
  assert.equal(created.project.height, 128);
  assert.equal(created.project.name, 'Untitled artwork');
  assert.deepEqual(created.project.layers.map(layer => layer.name), ['Layer 1']);
  assert.equal(created.project.activeLayerId, created.project.layers[0].id);
  assert.equal(created.readback.layerCount, 1);
});

test('starter templates preserve the editor layer stacks through Headless proposal acceptance', () => {
  const created = createPixelForgeProject({ template: 'character' });
  assert.equal(created.project.width, 64);
  assert.equal(created.project.height, 64);
  assert.equal(created.project.name, 'Character sprite');
  assert.deepEqual(created.project.layers.map(layer => layer.name), ['Sketch', 'Lineart', 'Color', 'Shading']);
  assert.equal(created.project.layers.length, created.readback.layerCount);
  assert.ok(created.project.layers.every(layer => typeof layer.pixels === 'string'));
});

test('custom project options override template defaults and retain a fresh project identity', () => {
  const options = normalizePixelForgeProjectOptions({
    template: 'icon', width: 48, height: 40, name: 'My icon',
    layerNames: ['Base', 'Shadow'],
  });
  const created = createPixelForgeProject(options);
  assert.equal(created.project.width, 48);
  assert.equal(created.project.height, 40);
  assert.equal(created.project.name, 'My icon');
  assert.deepEqual(created.project.layers.map(layer => layer.name), ['Base', 'Shadow']);
  assert.match(created.project.id, /^[a-zA-Z0-9_-]{1,100}$/);
});

test('project factory rejects invalid dimensions, duplicate layers, and expanded memory overflow', () => {
  assert.throws(() => normalizePixelForgeProjectOptions({ width: 0 }), /dimensions/);
  assert.throws(() => normalizePixelForgeProjectOptions({ layerNames: ['Ink', 'Ink'] }), /unique valid names/);
  assert.throws(() => normalizePixelForgeProjectOptions({
    width: 2048, height: 2048, layerNames: Array.from({ length: 2 }, (_, index) => 'Layer ' + index),
  }), /64 MiB/);
});
