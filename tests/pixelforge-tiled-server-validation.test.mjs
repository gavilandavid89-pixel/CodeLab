import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import validation from '../pixelforge-tiled-project-validation.js';

const tile = (x, y, width = 64, height = 64, fill = 7) => {
  const bytes = Buffer.alloc(width * height * 4, fill);
  return {
    x, y, width, height,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    rgba: bytes.toString('base64'),
  };
};

const manifest = (width = 4096, height = 4096, tiles = [tile(0, 0)]) => ({
  format: 'pixelforge-tiled-project',
  version: 1,
  id: 'tiled-project-1',
  name: 'Sparse project',
  width, height,
  revision: 0,
  saveVersion: 0,
  serverRevision: 0,
  activeLayerId: 'layer-1',
  drawingConfiguration: { activeMode: 'pixel-art', availableModes: ['illustration', 'pixel-art'] },
  projectMetadata: {},
  layers: [{
    id: 'layer-1', name: 'Layer 1', visible: true, opacity: 1, locked: false,
    cel: { format: 'pixelforge-tiled-cel', version: 2, width, height, tileSize: 64, tiles },
  }],
});

test('server accepts a sparse 4096px canvas without allocating a dense full-canvas cel', () => {
  const project = manifest();
  const result = validation.validatePixelForgeTiledProjectPayload(project);
  assert.equal(result.error, undefined);
  assert.equal(result.tileBytes, 64 * 64 * 4);
  assert.ok(result.projectBytes > 0);
});

test('server accepts exact partial edge-tile dimensions on a non-square canvas', () => {
  const project = manifest(70, 70, [tile(64, 64, 6, 6)]);
  project.layers[0].cel.tileSize = 64;
  const result = validation.validatePixelForgeTiledProjectPayload(project);
  assert.equal(result.error, undefined);
  assert.equal(result.tileBytes, 6 * 6 * 4);
});

test('server rejects a tile with a forged SHA-256 digest', () => {
  const project = manifest();
  project.layers[0].cel.tiles[0].sha256 = '0'.repeat(64);
  assert.equal(validation.validatePixelForgeTiledProjectPayload(project).error, 'invalid_pixelforge_project');
});

test('server rejects duplicate, unaligned, out-of-bounds and malformed edge tiles', () => {
  const duplicate = manifest(128, 128, [tile(0, 0), tile(0, 0)]);
  assert.equal(validation.validatePixelForgeTiledProjectPayload(duplicate).error, 'invalid_pixelforge_project');

  const unaligned = manifest(128, 128, [tile(1, 0)]);
  assert.equal(validation.validatePixelForgeTiledProjectPayload(unaligned).error, 'invalid_pixelforge_project');

  const outside = manifest(128, 128, [tile(128, 0)]);
  assert.equal(validation.validatePixelForgeTiledProjectPayload(outside).error, 'invalid_pixelforge_project');

  const wrongEdge = manifest(70, 70, [tile(64, 64, 64, 64)]);
  assert.equal(validation.validatePixelForgeTiledProjectPayload(wrongEdge).error, 'invalid_pixelforge_project');
});

test('server rejects non-canonical base64 and fully-zero tiles in sparse manifests', () => {
  const malformed = manifest();
  malformed.layers[0].cel.tiles[0].rgba = 'not-base64';
  assert.equal(validation.validatePixelForgeTiledProjectPayload(malformed).error, 'invalid_pixelforge_project');

  const zeroBytes = Buffer.alloc(64 * 64 * 4);
  const zeroTile = {
    ...tile(0, 0),
    sha256: crypto.createHash('sha256').update(zeroBytes).digest('hex'),
    rgba: zeroBytes.toString('base64'),
  };
  const zero = manifest(4096, 4096, [zeroTile]);
  assert.equal(validation.validatePixelForgeTiledProjectPayload(zero).error, 'invalid_pixelforge_project');
});

test('server enforces aggregate decoded tile bytes independently of canvas area', () => {
  const project = manifest(128, 64, [tile(0, 0), tile(64, 0)]);
  const result = validation.validatePixelForgeTiledProjectPayload(project, null, { maxRasterBytes: 64 * 64 * 4 });
  assert.equal(result.error, 'pixelforge_project_too_large');
  assert.equal(result.status, 413);
});

test('server enforces the serialized project cap and refuses mixed raster-animation manifests', () => {
  const project = manifest();
  const tooLarge = validation.validatePixelForgeTiledProjectPayload(project, JSON.stringify(project), { maxProjectBytes: 10 });
  assert.equal(tooLarge.error, 'pixelforge_project_too_large');
  assert.equal(tooLarge.status, 413);

  const mixed = manifest();
  mixed.animation = { version: 1 };
  assert.equal(validation.validatePixelForgeTiledProjectPayload(mixed).error, 'invalid_pixelforge_project');
});

test('server rejects invalid layer metadata and active-layer references', () => {
  const invalidLayer = manifest();
  invalidLayer.layers[0].opacity = 2;
  assert.equal(validation.validatePixelForgeTiledProjectPayload(invalidLayer).error, 'invalid_pixelforge_project');

  const invalidActive = manifest();
  invalidActive.activeLayerId = 'missing';
  assert.equal(validation.validatePixelForgeTiledProjectPayload(invalidActive).error, 'invalid_pixelforge_project');
});
