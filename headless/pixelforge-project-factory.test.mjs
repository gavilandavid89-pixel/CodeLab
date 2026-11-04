import test from 'node:test';
import assert from 'node:assert/strict';
import { createPixelForgeProject, normalizePixelForgeProjectOptions } from '../public/pixelforge/src/project-factory.js';

class FakeHeadlessEditorRuntime {
  constructor({ width, height, name }) {
    const layer = { id: 'layer-1', name: 'Layer 1', visible: true, locked: false, opacity: 1, pixels: '' };
    this.document = { id: 'project-1', format: 'pixelforge-project', version: 1, name, width, height, activeLayerId: layer.id, revision: 0, saveVersion: 0, serverRevision: 0, layers: [layer] };
    this.sandbox = { activeLayerId: layer.id, activeLayer: layer, layers: this.document.layers };
    this.hasPendingChanges = false;
  }
  execute(action) {
    if (action.name === 'layer.rename') { this.sandbox.activeLayer.name = action.newName; this.hasPendingChanges = true; return { ok: true }; }
    if (action.name === 'layer.add') { const layer = { id: 'layer-' + (this.sandbox.layers.length + 1), name: action.layerName, visible: true, locked: false, opacity: 1, pixels: '' }; this.sandbox.layers.push(layer); this.hasPendingChanges = true; return { ok: true }; }
    return { ok: false, error: { message: 'unsupported fake action' } };
  }
  createProposal() { this.pending = true; }
  acceptProposal() { this.pending = false; this.hasPendingChanges = false; this.document.layers = this.sandbox.layers.map(layer => ({ ...layer })); this.document.revision++; this.document.saveVersion++; return { status: 'applied' }; }
  toJSON() { if (this.pending || this.hasPendingChanges) throw new Error('pending'); return JSON.parse(JSON.stringify(this.document)); }
}

test('custom PixelForge project factory creates a valid blank canvas', () => {
  const created = createPixelForgeProject({}, { HeadlessEditorRuntime: FakeHeadlessEditorRuntime });
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
  const created = createPixelForgeProject({ template: 'character' }, { HeadlessEditorRuntime: FakeHeadlessEditorRuntime });
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
  const created = createPixelForgeProject(options, { HeadlessEditorRuntime: FakeHeadlessEditorRuntime });
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
