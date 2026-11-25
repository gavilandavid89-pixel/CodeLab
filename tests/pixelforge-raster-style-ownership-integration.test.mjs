import test from 'node:test';
import assert from 'node:assert/strict';
import { TiledRasterProjectDocument } from '../public/pixelforge/src/raster-tiled-adapter.mjs';
import { applyTiledBrushDab } from '../public/pixelforge/src/raster-tiled-brush.mjs';
import { fillTiledLayer } from '../public/pixelforge/src/raster-tiled-fill.mjs';

function project() { return TiledRasterProjectDocument.createBlank({ width: 8, height: 8, tileSize: 32 }); }

test('tiled cel persists ownership through clone, manifest export and reload', async () => {
  const doc = project();
  try {
    const region = { x: 2, y: 3, width: 1, height: 1 };
    const rgba = new Uint8ClampedArray([12, 34, 56, 255]);
    const owners = new Uint8Array([2]);
    const result = await doc.writeRegionWithOwnership(doc.activeLayerId, region, rgba, owners);
    assert.equal(result.changed, true);
    assert.deepEqual([...doc.readOwnershipRegion(doc.activeLayerId, region)], [2]);
    const manifest = await doc.toManifest();
    assert.equal(manifest.layers[0].cel.ownershipTiles.length, 1);
    const restored = await TiledRasterProjectDocument.fromManifest(manifest);
    try {
      assert.deepEqual([...restored.readRegion(restored.activeLayerId, region)], [...rgba]);
      assert.deepEqual([...restored.readOwnershipRegion(restored.activeLayerId, region)], [2]);
    } finally { restored.dispose(); }
  } finally { doc.dispose(); }
});

test('legacy cels without ownership metadata load as unowned', async () => {
  const doc = project();
  try {
    const manifest = await doc.toManifest();
    delete manifest.layers[0].cel.ownershipTiles;
    const restored = await TiledRasterProjectDocument.fromManifest(manifest);
    try { assert.deepEqual([...restored.readOwnershipRegion(restored.activeLayerId, { x: 0, y: 0, width: 2, height: 2 })], [0, 0, 0, 0]); }
    finally { restored.dispose(); }
  } finally { doc.dispose(); }
});

test('tiled brush blocks cross-style painting and erasing in both directions', async () => {
  const doc = project();
  try {
    const pixelArt = await applyTiledBrushDab(doc, doc.activeLayerId, 3, 3, { authoringMode: 'pixel-art', color: '#ff0000', size: 1, shape: 'square' });
    assert.equal(pixelArt.changed, true);
    const illustration = await applyTiledBrushDab(doc, doc.activeLayerId, 3, 3, { authoringMode: 'illustration', color: '#00ff00', size: 1, shape: 'square' });
    assert.equal(illustration.changed, false);
    assert.equal(illustration.blockedPixels, 1);
    assert.deepEqual([...doc.readRegion(doc.activeLayerId, { x: 3, y: 3, width: 1, height: 1 })], [255, 0, 0, 255]);
    const eraseForeign = await applyTiledBrushDab(doc, doc.activeLayerId, 3, 3, { authoringMode: 'illustration', mode: 'erase', size: 1 });
    assert.equal(eraseForeign.changed, false);
    assert.equal(eraseForeign.blockedPixels, 1);
    const eraseOwn = await applyTiledBrushDab(doc, doc.activeLayerId, 3, 3, { authoringMode: 'pixel-art', mode: 'erase', size: 1 });
    assert.equal(eraseOwn.changed, true);
    assert.deepEqual([...doc.readOwnershipRegion(doc.activeLayerId, { x: 3, y: 3, width: 1, height: 1 })], [0]);
    const paintIllustration = await applyTiledBrushDab(doc, doc.activeLayerId, 3, 3, { authoringMode: 'illustration', color: '#00ff00', size: 1 });
    assert.equal(paintIllustration.changed, true);
    assert.deepEqual([...doc.readOwnershipRegion(doc.activeLayerId, { x: 3, y: 3, width: 1, height: 1 })], [1]);
  } finally { doc.dispose(); }
});

test('stroke undo and redo restore RGBA and ownership together', async () => {
  const doc = project();
  try {
    const layerId = doc.activeLayerId;
    doc.strokeHistory.beginStroke(layerId, { authoringMode: 'illustration', size: 1, color: '#123456' });
    await doc.strokeHistory.dab(4, 4);
    assert.equal(doc.strokeHistory.commitStroke(), true);
    const region = { x: 4, y: 4, width: 1, height: 1 };
    assert.deepEqual([...doc.readOwnershipRegion(layerId, region)], [1]);
    await doc.undo();
    assert.deepEqual([...doc.readRegion(layerId, region)], [0, 0, 0, 0]);
    assert.deepEqual([...doc.readOwnershipRegion(layerId, region)], [0]);
    await doc.redo();
    assert.deepEqual([...doc.readOwnershipRegion(layerId, region)], [1]);
  } finally { doc.dispose(); }
});

test('bucket fill tile history restores the ownership plane on undo and redo', async () => {
  const doc = project();
  try {
    const layerId = doc.activeLayerId;
    const changed = await fillTiledLayer(doc, layerId, 0, 0, { color: '#abcdef', authoringMode: 'pixel-art' });
    assert.equal(changed, 64);
    const region = { x: 0, y: 0, width: 8, height: 8 };
    assert.ok([...doc.readOwnershipRegion(layerId, region)].every(owner => owner === 2));
    await doc.undo();
    assert.ok([...doc.readOwnershipRegion(layerId, region)].every(owner => owner === 0));
    await doc.redo();
    assert.ok([...doc.readOwnershipRegion(layerId, region)].every(owner => owner === 2));
  } finally { doc.dispose(); }
});
