import test from 'node:test';
import assert from 'node:assert/strict';
import { TiledRasterProjectDocument } from '../public/pixelforge/src/raster-tiled-adapter.mjs';
import { RasterDocument } from '../public/pixelforge/src/core.js';
import { applyTiledBrushDab } from '../public/pixelforge/src/raster-tiled-brush.mjs';
import { fillTiledLayer } from '../public/pixelforge/src/raster-tiled-fill.mjs';
import { PixelForgeAnimation } from '../public/pixelforge/src/animation.mjs';
import { TiledAnimationDocument } from '../public/pixelforge/src/animation-tiled-adapter.mjs';

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
    const pixelArtOverIllustration = await applyTiledBrushDab(doc, doc.activeLayerId, 3, 3, { authoringMode: 'pixel-art', color: '#0000ff', size: 1 });
    assert.equal(pixelArtOverIllustration.changed, false);
    assert.equal(pixelArtOverIllustration.blockedPixels, 1);
    assert.deepEqual([...doc.readRegion(doc.activeLayerId, { x: 3, y: 3, width: 1, height: 1 })], [0, 255, 0, 255]);
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

test('animation cels enforce style isolation and retain ownership across frame cloning and manifest reload', async () => {
  const legacy = new PixelForgeAnimation({ width: 8, height: 8, layerIds: ['paint'] });
  const animation = await TiledAnimationDocument.fromAnimation(legacy, { tileSize: 32 });
  try {
    const region = { x: 2, y: 2, width: 1, height: 1 };
    await animation.writeRegion(0, 'paint', region, new Uint8ClampedArray([255, 0, 0, 255]), { authoringMode: 'pixel-art' });
    const blocked = await animation.writeRegion(0, 'paint', region, new Uint8ClampedArray([0, 255, 0, 255]), { authoringMode: 'illustration' });
    assert.equal(blocked.changed, false);
    assert.equal(blocked.blockedPixels, 1);
    assert.deepEqual([...animation.readOwnershipRegion(0, 'paint', region)], [2]);
    animation.cloneFrame(0);
    assert.deepEqual([...animation.readOwnershipRegion(1, 'paint', region)], [2]);
    const manifest = await animation.toManifest();
    assert.equal(manifest.frames[1].cels[0].cel.ownershipTiles.length, 1);
    const restored = await TiledAnimationDocument.fromManifest(manifest);
    try { assert.deepEqual([...restored.readOwnershipRegion(1, 'paint', region)], [2]); }
    finally { restored.dispose(); }
  } finally { animation.dispose(); }
});

test('dense-to-tiled migration preserves per-pixel ownership metadata', async () => {
  const dense = new RasterDocument(8, 8);
  dense.activeLayer.authoringMode = 'illustration';
  const stroke = dense.beginStroke({ color: '#123456', size: 1 });
  dense.strokeTo(stroke, 6, 5); dense.endStroke(stroke);
  const tiled = await TiledRasterProjectDocument.fromDocument(dense, { tileSize: 32 });
  try { assert.deepEqual([...tiled.readOwnershipRegion(tiled.activeLayerId, { x: 6, y: 5, width: 1, height: 1 })], [1]); }
  finally { tiled.dispose(); }
});

test('dense animation ownership survives migration into tiled animation cels', async () => {
  const dense = new RasterDocument(8, 8);
  dense.activeLayer.authoringMode = 'pixel-art';
  const stroke = dense.beginStroke({ color: '#ff9900', size: 1 });
  dense.strokeTo(stroke, 1, 6); dense.endStroke(stroke);
  const animation = PixelForgeAnimation.fromDocument(dense);
  const tiled = await TiledAnimationDocument.fromAnimation(animation, { tileSize: 32 });
  try { assert.deepEqual([...tiled.readOwnershipRegion(0, dense.activeLayerId, { x: 1, y: 6, width: 1, height: 1 })], [2]); }
  finally { tiled.dispose(); }
});
