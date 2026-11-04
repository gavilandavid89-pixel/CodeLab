import test from 'node:test';
import assert from 'node:assert/strict';
import { createPixelForgeProject, normalizePixelForgeProjectOptions } from '../public/pixelforge/src/project-factory.js';

class FakeRasterDocument {
  constructor(width, height, name) {
    const first = { id: 'layer-1', name: 'Layer 1', visible: true, locked: false, opacity: 1, pixels: '' };
    this.format = 'pixelforge-project'; this.version = 1; this.id = 'project-1'; this.name = name;
    this.width = width; this.height = height; this.activeLayerId = first.id; this.revision = 4; this.saveVersion = 4; this.serverRevision = 0;
    this.layers = [first]; this.history = [1, 2]; this.future = [3]; this.historyBytes = 99; this.dirty = true;
  }
  get activeLayer() { return this.layers.find(layer => layer.id === this.activeLayerId); }
  renameLayer(id, name) { this.layers.find(layer => layer.id === id).name = name; }
  addLayer(name) { this.layers.push({ id: 'layer-' + (this.layers.length + 1), name, visible: true, locked: false, opacity: 1, pixels: '' }); }
  setActiveLayer(id) { this.activeLayerId = id; }
  toJSON() { return JSON.parse(JSON.stringify({ format: this.format, version: this.version, id: this.id, name: this.name, width: this.width, height: this.height, activeLayerId: this.activeLayerId, revision: this.revision, saveVersion: this.saveVersion, serverRevision: this.serverRevision, layers: this.layers })); }
}
class FakeHeadlessEditorRuntime {
  constructor({ project }) { this.project = project; }
  toJSON() { return JSON.parse(JSON.stringify(this.project)); }
}

test('custom PixelForge project factory creates a valid blank canvas', () => {
  const created = createPixelForgeProject({}, { RasterDocument: FakeRasterDocument, HeadlessEditorRuntime: FakeHeadlessEditorRuntime });
  assert.equal(created.project.format, 'pixelforge-project');
  assert.equal(created.project.version, 1);
  assert.equal(created.project.width, 128);
  assert.equal(created.project.height, 128);
  assert.equal(created.project.name, 'Untitled artwork');
  assert.deepEqual(created.project.layers.map(layer => layer.name), ['Layer 1']);
  assert.equal(created.project.activeLayerId, created.project.layers[0].id);
  assert.equal(created.project.revision, 0);
  assert.equal(created.project.saveVersion, 0);
  assert.equal(created.project.serverRevision, 0);
  assert.equal(created.readback.layerCount, 1);
});

test('starter templates preserve the editor layer stacks in a clean Headless project', () => {
  const created = createPixelForgeProject({ template: 'character' }, { RasterDocument: FakeRasterDocument, HeadlessEditorRuntime: FakeHeadlessEditorRuntime });
  assert.equal(created.project.width, 64);
  assert.equal(created.project.height, 64);
  assert.equal(created.project.name, 'Character sprite');
  assert.deepEqual(created.project.layers.map(layer => layer.name), ['Sketch', 'Lineart', 'Color', 'Shading']);
  assert.equal(created.project.layers.length, created.readback.layerCount);
  assert.equal(created.project.activeLayerId, created.project.layers[0].id);
  assert.equal(created.project.revision, 0);
  assert.equal(created.project.saveVersion, 0);
  assert.ok(created.project.layers.every(layer => typeof layer.pixels === 'string'));
});

test('custom project options override template defaults and retain a fresh project identity', () => {
  const options = normalizePixelForgeProjectOptions({
    template: 'icon', width: 48, height: 40, name: 'My icon',
    layerNames: ['Base', 'Shadow'],
  });
  const created = createPixelForgeProject(options, { RasterDocument: FakeRasterDocument, HeadlessEditorRuntime: FakeHeadlessEditorRuntime });
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
    width: 2048, height: 2048, layerNames: Array.from({ length: 5 }, (_, index) => 'Layer ' + index),
  }), /64 MiB/);
});
