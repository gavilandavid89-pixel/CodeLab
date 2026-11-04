import test from 'node:test';
import assert from 'node:assert/strict';
import { preparePixelForgeProjectImport } from './pixelforge-project-import.mjs';

function fixture({ animation = false } = {}) {
  const project = {
    format: 'pixelforge-project', version: 1, id: 'old-project', name: 'Hero',
    width: 1, height: 1, activeLayerId: 'old-layer',
    revision: 8, saveVersion: 12, serverRevision: 4,
    layers: [{ id: 'old-layer', name: 'Ink', visible: true, opacity: 1, locked: false, pixels: 'AAAAAA==' }],
  };
  if (animation) {
    project.animation = {
      format: 'pixelforge-animation', version: 1, width: 1, height: 1,
      fps: 12, loop: false, activeFrameIndex: 0, layerIds: ['old-layer'],
      frames: [{ id: 'frame-1', name: 'Pose A', durationMs: 120, cels: [{ layerId: 'old-layer', pixels: '/////w==' }] }],
    };
  }
  return project;
}

function ids() {
  let next = 0;
  return () => 'import-id-' + (++next).toString().padStart(8, '0');
}

test('portable raster import gets a fresh project/layer identity and resets revision tokens', () => {
  const source = fixture();
  const result = preparePixelForgeProjectImport(Buffer.from(JSON.stringify(source)), { randomUUID: ids() });
  assert.notEqual(result.project.id, source.id);
  assert.notEqual(result.project.layers[0].id, source.layers[0].id);
  assert.notEqual(result.project.activeLayerId, source.activeLayerId);
  assert.equal(result.project.activeLayerId, result.project.layers[0].id);
  assert.equal(result.project.revision, 0);
  assert.equal(result.project.saveVersion, 0);
  assert.equal(result.project.serverRevision, 0);
  assert.equal(result.project.name, 'Hero (imported)');
  assert.equal(result.layerCount, 1);
  assert.equal(result.frameCount, 0);
  assert.match(result.semanticDigest, /^[a-f0-9]{64}$/);
});

test('animated import remaps every cel while preserving pixels, fps, frame timing and loop=false', () => {
  const source = fixture({ animation: true });
  const result = preparePixelForgeProjectImport(Buffer.from(JSON.stringify(source)), { randomUUID: ids() });
  const newLayerId = result.project.layers[0].id;
  assert.equal(result.project.animation.loop, false);
  assert.equal(result.project.animation.fps, 12);
  assert.equal(result.project.animation.layerIds[0], newLayerId);
  assert.equal(result.project.animation.frames[0].cels[0].layerId, newLayerId);
  assert.equal(result.project.animation.frames[0].cels[0].pixels, '/////w==');
  assert.equal(result.project.animation.frames[0].durationMs, 120);
  assert.equal(result.frameCount, 1);
  assert.match(result.semanticDigest, /^[a-f0-9]{64}$/);
});

test('portable import rejects invalid loop, layer mapping, dimensions and noncanonical pixels', () => {
  const invalidLoop = fixture({ animation: true });
  invalidLoop.animation.loop = 'false';
  assert.throws(() => preparePixelForgeProjectImport(Buffer.from(JSON.stringify(invalidLoop))), /animation metadata/);
  const invalidLayer = fixture({ animation: true });
  invalidLayer.animation.layerIds[0] = 'missing-layer';
  assert.throws(() => preparePixelForgeProjectImport(Buffer.from(JSON.stringify(invalidLayer))), /layer order/);
  const invalidDimensions = fixture();
  invalidDimensions.width = 0;
  assert.throws(() => preparePixelForgeProjectImport(Buffer.from(JSON.stringify(invalidDimensions))), /dimensions/);
  const invalidPixels = fixture();
  invalidPixels.layers[0].pixels = 'AAAAAA';
  assert.throws(() => preparePixelForgeProjectImport(Buffer.from(JSON.stringify(invalidPixels))), /canonical base64/);
});
