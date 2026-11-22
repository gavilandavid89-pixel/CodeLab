import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePixelForgeProject, validateVectorModel } from '../public/pixelforge/src/pixelforge-validation.js';

const baseProject = () => ({
  format: 'pixelforge-project',
  version: 1,
  width: 100,
  height: 80,
  activeLayerId: 'layer-1',
  layers: [{ id: 'layer-1', name: 'Background', visible: true, opacity: 1, locked: false, pixels: 'AAAA' }],
  vectorModel: { version: 4, width: 100, height: 80, grid: 8, snap: true, objects: [], frames: [] },
});

test('PixelForge validation accepts a valid raster + vector project', () => {
  const result = validatePixelForgeProject(baseProject());
  assert.equal(result.ok, true);
  assert.equal(result.score, 100);
  assert.equal(result.categories.schema.ok, true);
});

test('PixelForge validation reports duplicate vector IDs and invalid paths', () => {
  const project = baseProject();
  project.vectorModel.objects = [
    { id: 'same', type: 'path', points: [{ x: 0, y: 0 }] },
    { id: 'same', type: 'rect', x: 0, y: 0, width: 10, height: 10 },
  ];
  const result = validatePixelForgeProject(project);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(i => i.code === 'duplicate_vector_object_id'));
  assert.ok(result.issues.some(i => i.code === 'invalid_path'));
});

test('PixelForge validation detects animation and transform corruption', () => {
  const model = {
    version: 4, width: 100, height: 80, grid: 8, snap: true, objects: [{
      id: 'rect-1', type: 'rect', x: 5, y: 5, width: 20, height: 20, transform: { scaleX: NaN, scaleY: 0 }
    }], frames: [{ id: 'frame-1', time: -1, duration: -2 }],
  };
  const result = validateVectorModel(model, { width: 100, height: 80 });
  assert.equal(result.ok, false);
  assert.ok(result.categories === undefined || result.issues.some(i => i.code === 'invalid_transform'));
  assert.ok(result.issues.some(i => i.code === 'invalid_frame_time'));
  assert.ok(result.issues.some(i => i.code === 'invalid_frame_duration'));
});
