import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createCelPatch } from '../public/pixelforge/src/cel-patch-diff.mjs';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const rgba = Buffer.alloc(32 * 32 * 4); rgba.set([1, 2, 3, 255]);
  const cel = { format: 'pixelforge-tiled-cel', version: 2, width: 32, height: 32, tileSize: 32,
    tiles: [{ x: 0, y: 0, width: 32, height: 32, sha256: digest(rgba), rgba: rgba.toString('base64') }] };
  return { format: 'pixelforge-tiled-project', version: 1, id: 'p1', revision: 1, saveVersion: 1,
    serverRevision: 7, width: 32, height: 32, activeLayerId: 'l1',
    layers: [{ id: 'l1', name: 'Layer', visible: true, cel: structuredClone(cel) }],
    animation: { format: 'pixelforge-tiled-animation', version: 1, width: 32, height: 32,
      fps: 12, layerIds: ['l1'], activeFrameIndex: 0,
      frames: [{ id: 'f1', durationMs: 100, authoringMode: 'pixel-art',
        cels: [{ layerId: 'l1', metadata: { authoringMode: 'pixel-art' }, cel: structuredClone(cel) }] }] } };
}
function changeTile(project, color) {
  const bytes = Buffer.alloc(32 * 32 * 4); bytes.set([...color, 255]);
  const cel = project.animation.frames[0].cels[0].cel;
  cel.tiles = [{ x: 0, y: 0, width: 32, height: 32, sha256: digest(bytes), rgba: bytes.toString('base64') }];
  project.layers[0].cel = structuredClone(cel);
}
test('builds one integrity-carrying RGBA tile patch for a single cel change', () => {
  const before = fixture(), after = structuredClone(before);
  changeTile(after, [8, 9, 10]); after.revision++; after.saveVersion++;
  const patch = createCelPatch(before, after, { operationId: 'stable-op-1' });
  assert.equal(patch.baseRevision, 7); assert.equal(patch.operationId, 'stable-op-1');
  assert.equal(patch.frameId, 'f1'); assert.equal(patch.layerId, 'l1');
  assert.equal(patch.operations.length, 1); assert.equal(patch.operations[0].type, 'tile.put');
  assert.equal(patch.operations[0].sha256, digest(Buffer.from(patch.operations[0].rgba, 'base64')));
});
test('includes ownership plane edits and emits removals for emptied tiles', () => {
  const before = fixture(), after = structuredClone(before);
  const owners = Buffer.alloc(32 * 32); owners[0] = 1;
  after.animation.frames[0].cels[0].cel.ownershipTiles = [{ x: 0, y: 0, width: 32, height: 32, sha256: digest(owners), owners: owners.toString('base64') }];
  after.animation.frames[0].cels[0].cel.tiles = [];
  after.layers[0].cel = structuredClone(after.animation.frames[0].cels[0].cel);
  const patch = createCelPatch(before, after, { operationId: 'ownership-op' });
  assert.deepEqual(patch.operations.map(op => op.type).sort(), ['ownership.put', 'tile.remove']);
});
test('declines structural, metadata, multi-cel, and malformed tile changes', () => {
  const before = fixture(), metadata = structuredClone(before); metadata.name = 'Renamed';
  assert.equal(createCelPatch(before, metadata, { operationId: 'op' }), null);
  const mode = structuredClone(before); mode.animation.frames[0].authoringMode = 'illustration';
  assert.equal(createCelPatch(before, mode, { operationId: 'op' }), null);
  const multiple = structuredClone(before);
  multiple.animation.frames.push({ ...structuredClone(multiple.animation.frames[0]), id: 'f2' });
  changeTile(multiple, [4, 5, 6]);
  multiple.animation.frames[1].cels[0].cel.tiles = [];
  assert.equal(createCelPatch(before, multiple, { operationId: 'op' }), null);
  const malformed = structuredClone(before); malformed.animation.frames[0].cels[0].cel.tiles[0].sha256 = 'bad';
  assert.equal(createCelPatch(before, malformed, { operationId: 'op' }), null);
});
test('returns null for a cel edit with no tile-level difference', () => {
  const before = fixture(), after = structuredClone(before);
  after.revision++;
  assert.equal(createCelPatch(before, after, { operationId: 'op' }), null);
});
