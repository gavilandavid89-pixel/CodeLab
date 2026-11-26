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

test('server enforces the serialized project cap and accepts a valid tiled animation envelope', () => {
  const project = manifest();
  const tooLarge = validation.validatePixelForgeTiledProjectPayload(project, JSON.stringify(project), { maxProjectBytes: 10 });
  assert.equal(tooLarge.error, 'pixelforge_project_too_large');
  assert.equal(tooLarge.status, 413);

  project.animation = {
    format: 'pixelforge-tiled-animation', version: 1, width: project.width, height: project.height,
    fps: 12, layerIds: ['layer-1'], activeFrameIndex: 0,
    frames: [{ id: 'frame-1', durationMs: 100, authoringMode: 'pixel-art', cels: [{
      layerId: 'layer-1', cel: structuredClone(project.layers[0].cel),
      metadata: { authoringMode: 'pixel-art' }
    }]}]
  };
  assert.equal(validation.validatePixelForgeTiledProjectPayload(project).error, undefined);

  const invalid = structuredClone(project);
  invalid.animation.frames[0].cels[0].layerId = 'missing-layer';
  assert.equal(validation.validatePixelForgeTiledProjectPayload(invalid).error, 'invalid_pixelforge_animation');

  const badMode = structuredClone(project);
  badMode.animation.frames[0].cels[0].metadata.authoringMode = 'unknown';
  assert.equal(validation.validatePixelForgeTiledProjectPayload(badMode).error, 'invalid_pixelforge_animation');
});

test('server rejects invalid layer metadata and active-layer references', () => {
  const invalidLayer = manifest();
  invalidLayer.layers[0].opacity = 2;
  assert.equal(validation.validatePixelForgeTiledProjectPayload(invalidLayer).error, 'invalid_pixelforge_project');

  const invalidActive = manifest();
  invalidActive.activeLayerId = 'missing';
  assert.equal(validation.validatePixelForgeTiledProjectPayload(invalidActive).error, 'invalid_pixelforge_project');
});


test('server accepts and validates sparse ownership tiles independently of RGBA', () => {
  const project = manifest();
  const owners = Buffer.alloc(64 * 64);
  owners[0] = 1;
  project.layers[0].cel.ownershipTiles = [{
    x: 0, y: 0, width: 64, height: 64,
    sha256: crypto.createHash('sha256').update(owners).digest('hex'),
    owners: owners.toString('base64'),
  }];
  const result = validation.validatePixelForgeTiledProjectPayload(project);
  assert.equal(result.error, undefined);

  const forged = structuredClone(project);
  forged.layers[0].cel.ownershipTiles[0].owners = Buffer.alloc(64 * 64).toString('base64');
  assert.equal(validation.validatePixelForgeTiledProjectPayload(forged).error, 'invalid_pixelforge_project');

  const invalidOwner = structuredClone(project);
  const invalidBytes = Buffer.from(owners);
  invalidBytes[1] = 3;
  invalidOwner.layers[0].cel.ownershipTiles[0] = {
    x: 0, y: 0, width: 64, height: 64,
    sha256: crypto.createHash('sha256').update(invalidBytes).digest('hex'),
    owners: invalidBytes.toString('base64'),
  };
  assert.equal(validation.validatePixelForgeTiledProjectPayload(invalidOwner).error, 'invalid_pixelforge_project');
});
