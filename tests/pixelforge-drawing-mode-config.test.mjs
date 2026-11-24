import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PIXELFORGE_DRAWING_MODES,
  normalizeDrawingConfiguration,
  switchDrawingMode,
  getDrawingModePresentation,
  getVideoScalingMode,
  normalizeDrawingModeProfile,
  updateDrawingModeOverrides,
} from '../public/pixelforge/src/drawing-mode-config.mjs';

test('legacy projects restore a compatible pixel-art mode without changing canvas data', () => {
  const config = normalizeDrawingConfiguration(null);
  assert.equal(config.activeMode, PIXELFORGE_DRAWING_MODES.PIXEL_ART);
  assert.deepEqual(config.availableModes, ['illustration', 'pixel-art']);
});

test('projects persist both modes and restore their selected initial mode', () => {
  const config = normalizeDrawingConfiguration({
    version: 1,
    availableModes: ['illustration', 'pixel-art'],
    initialMode: 'illustration',
    activeMode: 'pixel-art',
  });
  assert.equal(config.initialMode, 'illustration');
  assert.equal(config.activeMode, 'pixel-art');
  assert.equal(switchDrawingMode(config, 'illustration').activeMode, 'illustration');
});

test('a project with one enabled mode cannot silently switch to a disabled mode', () => {
  const config = normalizeDrawingConfiguration({
    availableModes: ['pixel-art'], initialMode: 'pixel-art', activeMode: 'pixel-art',
  });
  assert.throws(() => switchDrawingMode(config, 'illustration'), /does not enable/);
});

test('drawing modes change presentation defaults, not source geometry', () => {
  const illustration = getDrawingModePresentation('illustration');
  const pixelArt = getDrawingModePresentation('pixel-art');
  assert.equal(illustration.imageSmoothingEnabled, true);
  assert.equal(illustration.brushSize, 5);
  assert.equal(illustration.brushShape, 'circle');
  assert.equal(illustration.brushHardness, 55);
  assert.equal(illustration.interpolation, 'bilinear');
  assert.equal(pixelArt.imageSmoothingEnabled, false);
  assert.equal(pixelArt.brushSize, 1);
  assert.equal(pixelArt.brushShape, 'square');
  assert.equal(pixelArt.brushHardness, 100);
  assert.equal(pixelArt.interpolation, 'nearest');
});

test('Video Composer inherits the source project drawing mode by default', () => {
  assert.equal(getVideoScalingMode(PIXELFORGE_DRAWING_MODES.ILLUSTRATION), 'smooth');
  assert.equal(getVideoScalingMode(PIXELFORGE_DRAWING_MODES.PIXEL_ART), 'pixelated');
});

test('per-layer mode profiles store only non-default exceptions and restore them independently', () => {
  const illustrationDefaults = getDrawingModePresentation('illustration');
  let overrides = updateDrawingModeOverrides({}, 'illustration', illustrationDefaults);
  assert.deepEqual(overrides, {});
  overrides = updateDrawingModeOverrides(overrides, 'illustration', {
    ...illustrationDefaults, brushSize: 9, brushHardness: 72, brushOpacity: 63,
  });
  overrides = updateDrawingModeOverrides(overrides, 'pixel-art', {
    ...getDrawingModePresentation('pixel-art'), brushSize: 3,
  });
  assert.equal(normalizeDrawingModeProfile('illustration', overrides.illustration).brushSize, 9);
  assert.equal(normalizeDrawingModeProfile('illustration', overrides.illustration).brushHardness, 72);
  assert.equal(normalizeDrawingModeProfile('illustration', overrides.illustration).brushOpacity, 63);
  assert.equal(normalizeDrawingModeProfile('pixel-art', overrides['pixel-art']).brushSize, 3);
  assert.equal(normalizeDrawingModeProfile('illustration', overrides['pixel-art']).brushSize, 5);
  overrides = updateDrawingModeOverrides(overrides, 'illustration', illustrationDefaults);
  assert.equal('illustration' in overrides, false);
  assert.equal(overrides['pixel-art'].brushSize, 3);
});
