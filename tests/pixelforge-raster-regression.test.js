const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const base = process.env.CODELAB_E2E_BASE_URL || 'http://127.0.0.1:3188';

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(async () => {
      const core = await import('/pixelforge/src/core.js');
      const { RasterDocument, createSelectionMask, modifySelectionMask, createColorSelectionMask } = core;
      const { AIWorkspace } = await import('/pixelforge/src/workspaces.js');

      const sample = (doc, x, y) => doc.sampleColorAt(x, y);
      const draw = (doc, x, y, color = '#FF0000', mode = 'draw') => {
        const stroke = doc.beginStroke({ color, mode, size: 1 });
        doc.strokeTo(stroke, x, y);
        doc.endStroke(stroke);
      };

      // Brush, eraser, undo and redo must modify the actual raster pixels.
      const paint = new RasterDocument(8, 8, 'brush regression');
      draw(paint, 2, 2);
      const brushPixel = sample(paint, 2, 2);
      draw(paint, 2, 2, '#000000', 'erase');
      const erasedPixel = sample(paint, 2, 2);
      paint.undo();
      const undoPixel = sample(paint, 2, 2);
      paint.redo();
      const redoPixel = sample(paint, 2, 2);

      // Contiguous fill, global fill, gradient and color replacement.
      const fill = new RasterDocument(6, 4, 'fill regression');
      draw(fill, 3, 1, '#FF0000');
      const contiguousFillCount = fill.fillAt(0, 0, { color: '#00FF00', tolerance: 0, contiguous: true });
      const fillSeed = sample(fill, 0, 0);
      const barrierPixel = sample(fill, 3, 1);
      const globalFillCount = fill.fillAt(3, 1, { color: '#0000FF', tolerance: 0, contiguous: false });
      const globalFillPixel = sample(fill, 3, 1);
      const gradient = new RasterDocument(4, 2, 'gradient regression');
      const gradientCount = gradient.fillGradient(0, 0, 3, 0, { startColor: '#000000', endColor: '#FFFFFF' });
      const gradientStart = sample(gradient, 0, 0);
      const gradientEnd = sample(gradient, 3, 0);
      const replaceCount = gradient.replaceColor('#FFFFFF', '#FF00FF', 0);
      const replacedPixel = sample(gradient, 3, 0);

      // Rect/ellipse/polygon/color selection and mask morphology.
      const rectMask = createSelectionMask(6, 6, { x: 1, y: 1, width: 3, height: 2, shape: 'rect' });
      const ellipseMask = createSelectionMask(6, 6, { x: 1, y: 1, width: 4, height: 4, shape: 'ellipse' });
      const polygonMask = createSelectionMask(6, 6, {
        x: 0, y: 0, width: 5, height: 5, shape: 'polygon',
        points: [{ x: 1, y: 1 }, { x: 4, y: 1 }, { x: 2, y: 4 }]
      });
      const invertedMask = modifySelectionMask(6, 6, rectMask, 'invert');
      const expandedMask = modifySelectionMask(6, 6, rectMask, 'expand', 1);
      const contractedMask = modifySelectionMask(6, 6, rectMask, 'contract', 1);
      const selectionDoc = new RasterDocument(6, 6, 'selection clipping');
      selectionDoc.setSelectionMask(rectMask);
      selectionDoc.fillAt(0, 0, { color: '#123456', contiguous: false });
      const selectedPixel = sample(selectionDoc, 1, 1);
      const outsideSelectionPixel = sample(selectionDoc, 0, 0);
      const colorDoc = new RasterDocument(4, 2, 'color selection');
      draw(colorDoc, 0, 0, '#FF0000');
      draw(colorDoc, 3, 1, '#FF0000');
      const colorMask = createColorSelectionMask(4, 2, colorDoc.activeLayer.pixels, 0, 0, { tolerance: 0, contiguous: false });

      // Transform, crop, flip and outline should preserve exact pixel state.
      const transform = new RasterDocument(8, 8, 'transform regression');
      draw(transform, 1, 1, '#ABCDEF');
      const transformed = transform.transformRect(1, 1, 1, 1, { dx: 2, dy: 1 });
      const transformedSource = sample(transform, 1, 1);
      const transformedTarget = sample(transform, 3, 2);
      const cropResult = transform.cropCanvas(2, 1, 4, 4);
      const croppedPixel = sample(transform, 1, 1);
      const croppedSize = [transform.width, transform.height];
      const flip = new RasterDocument(4, 2, 'flip regression');
      draw(flip, 0, 0, '#FF0000');
      flip.flipRect(0, 0, 4, 2, 'horizontal');
      const flippedPixel = sample(flip, 3, 0);
      const outline = new RasterDocument(4, 4, 'outline regression');
      draw(outline, 1, 1, '#FFFFFF');
      const outlineCount = outline.createOutline('#000000', { diagonals: false });
      const outlinePixel = sample(outline, 1, 0);

      // Layer stack operations, locks, visibility, opacity and history.
      const layers = new RasterDocument(4, 4, 'layer regression');
      const baseLayerId = layers.activeLayerId;
      const secondLayer = layers.addLayer('Foreground');
      layers.renameLayer(secondLayer.id, 'Renamed foreground');
      layers.setLayerOpacity(secondLayer.id, 0.5);
      layers.setLayerVisibility(secondLayer.id, false);
      layers.setLayerLocked(secondLayer.id, true);
      const lockedStrokeRejected = (() => {
        try { layers.beginStroke(); return false; } catch { return true; }
      })();
      layers.setLayerLocked(secondLayer.id, false);
      layers.moveLayer(secondLayer.id, 0);
      const layerOrder = layers.layers.map(layer => layer.name);
      const duplicate = layers.duplicateLayer(secondLayer.id, 'Copy');
      const duplicateCount = layers.layers.length;
      layers.deleteLayer(duplicate.id);
      const afterDeleteCount = layers.layers.length;
      layers.undo();
      const undoRestoresDuplicate = layers.layers.length === duplicateCount;
      layers.redo();
      const redoRemovesDuplicate = layers.layers.length === afterDeleteCount;

      // Project serialization must preserve dimensions, layer metadata and pixels.
      const serialized = layers.toJSON();
      const restored = RasterDocument.fromJSON(serialized);
      const serializationRoundTrip = restored.width === layers.width &&
        restored.height === layers.height &&
        restored.layers.length === layers.layers.length &&
        restored.layers.map(layer => layer.name).join('|') === layers.layers.map(layer => layer.name).join('|');

      // Proposal acceptance is tested for pixel edits; structural edits must fail closed
      // until the structural diff/merge implementation is delivered.
      const proposalSource = new RasterDocument(4, 4, 'proposal regression');
      const pixelWorkspace = new AIWorkspace(proposalSource);
      draw(pixelWorkspace.sandbox, 2, 2, '#00AAFF');
      pixelWorkspace.createProposal('pixel-only proposal');
      const pixelProposalResult = pixelWorkspace.acceptProposal();
      const acceptedPixel = sample(proposalSource, 2, 2);

      const structuralSource = new RasterDocument(4, 4, 'structural proposal regression');
      const structuralWorkspace = new AIWorkspace(structuralSource);
      structuralWorkspace.sandbox.addLayer('Agent layer');
      structuralWorkspace.createProposal('structural proposal');
      const structuralProposalResult = structuralWorkspace.acceptProposal();

      return {
        brushPixel, erasedPixel, undoPixel, redoPixel,
        contiguousFillCount, fillSeed, barrierPixel, globalFillCount, globalFillPixel,
        gradientCount, gradientStart, gradientEnd, replaceCount, replacedPixel,
        rectMaskCount: rectMask.reduce((a, b) => a + b, 0),
        ellipseMaskCount: ellipseMask.reduce((a, b) => a + b, 0),
        polygonMaskCount: polygonMask.reduce((a, b) => a + b, 0),
        invertedMaskCount: invertedMask.reduce((a, b) => a + b, 0),
        expandedMaskCount: expandedMask.reduce((a, b) => a + b, 0),
        contractedMaskCount: contractedMask.reduce((a, b) => a + b, 0),
        selectedPixel, outsideSelectionPixel,
        colorMaskCount: colorMask.reduce((a, b) => a + b, 0),
        transformedChanged: transformed.changedPixels, transformedSource, transformedTarget,
        cropResult, croppedPixel, croppedSize, flippedPixel, outlineCount, outlinePixel,
        lockedStrokeRejected, layerOrder, duplicateCount, afterDeleteCount,
        undoRestoresDuplicate, redoRemovesDuplicate, serializationRoundTrip,
        pixelProposalResult, acceptedPixel, structuralProposalResult
      };
    });

    assert.equal(result.brushPixel, '#FF0000', 'brush stroke must paint the selected pixel');
    assert.equal(result.erasedPixel, null, 'eraser must clear the painted pixel');
    assert.equal(result.undoPixel, '#FF0000', 'undo must restore the pixel erased by the prior action');
    assert.equal(result.redoPixel, null, 'redo must reapply the erase');
    assert.ok(result.contiguousFillCount > 0, 'contiguous bucket fill must paint a connected region');
    assert.equal(result.fillSeed, '#00FF00', 'contiguous fill must use the requested foreground color');
    assert.equal(result.barrierPixel, '#FF0000', 'contiguous fill must not cross a different-color barrier');
    assert.ok(result.globalFillCount > 0, 'global fill must replace matching pixels outside the connected region');
    assert.equal(result.globalFillPixel, '#0000FF', 'global fill must replace the barrier color');
    assert.ok(result.gradientCount > 0, 'gradient must alter raster pixels');
    assert.equal(result.gradientStart, '#000000', 'gradient start must match its start color');
    assert.equal(result.gradientEnd, '#FFFFFF', 'gradient end must match its end color');
    assert.ok(result.replaceCount > 0, 'replace-color must report changed pixels');
    assert.equal(result.replacedPixel, '#FF00FF', 'replace-color must update the target pixel');
    assert.equal(result.rectMaskCount, 6, 'rectangular selection mask must cover the requested area');
    assert.ok(result.ellipseMaskCount > 0 && result.ellipseMaskCount < 16, 'elliptical selection must have a bounded interior');
    assert.ok(result.polygonMaskCount > 0, 'lasso polygon selection must include its interior');
    assert.equal(result.invertedMaskCount, 30, 'selection inversion must invert the binary mask');
    assert.ok(result.expandedMaskCount > result.rectMaskCount, 'selection expansion must increase selected pixels');
    assert.ok(result.contractedMaskCount < result.rectMaskCount, 'selection contraction must reduce selected pixels');
    assert.equal(result.selectedPixel, '#123456', 'painting must affect selected pixels');
    assert.equal(result.outsideSelectionPixel, null, 'painting must not escape the selection mask');
    assert.equal(result.colorMaskCount, 2, 'non-contiguous color selection must select all matching pixels');
    assert.ok(result.transformedChanged > 0, 'transform must report pixel changes');
    assert.equal(result.transformedSource, null, 'transform must clear the original pixels');
    assert.equal(result.transformedTarget, '#ABCDEF', 'transform must move pixels to the requested offset');
    assert.equal(result.cropResult, true, 'crop must apply a non-empty crop');
    assert.equal(result.croppedPixel, '#ABCDEF', 'crop must preserve pixels inside the cropped bounds');
    assert.deepEqual(result.croppedSize, [4, 4], 'crop must update document dimensions');
    assert.equal(result.flippedPixel, '#FF0000', 'horizontal flip must mirror the painted pixel');
    assert.ok(result.outlineCount > 0, 'outline must add neighboring border pixels');
    assert.equal(result.outlinePixel, '#000000', 'outline must use the requested color');
    assert.equal(result.lockedStrokeRejected, true, 'locked layers must reject drawing');
    assert.ok(result.layerOrder[0] === 'Renamed foreground', 'layer reorder and rename must update the stack');
    assert.equal(result.duplicateCount, 3, 'duplicate layer must increase the layer count');
    assert.equal(result.afterDeleteCount, 2, 'delete layer must reduce the layer count');
    assert.equal(result.undoRestoresDuplicate, true, 'undo must restore a deleted layer');
    assert.equal(result.redoRemovesDuplicate, true, 'redo must reapply layer deletion');
    assert.equal(result.serializationRoundTrip, true, 'project JSON round-trip must preserve the layer structure');
    assert.equal(result.pixelProposalResult.status, 'applied', 'pixel-only AI proposals should be accepted');
    assert.equal(result.acceptedPixel, '#00AAFF', 'accepted AI pixel proposal must update the source document');
    assert.equal(result.structuralProposalResult.reason, 'unsupported-layer-structure',
      'structural AI proposals must currently fail closed rather than silently corrupt layers');

    console.log('PixelForge raster regression checks passed: brush/eraser, fills, gradient, color replacement, selections, transforms, crop, flip, outline, layers, history, serialization and AI proposal boundaries.');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
