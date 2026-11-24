import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PIXELFORGE_DRAWING_MODES,
  normalizeDrawingConfiguration,
  switchDrawingMode,
  getDrawingModePresentation,
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
  assert.equal(getDrawingModePresentation('illustration').imageSmoothingEnabled, true);
  assert.equal(getDrawingModePresentation('pixel-art').imageSmoothingEnabled, false);
});
