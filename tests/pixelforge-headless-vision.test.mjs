import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisionSnapshot, toProviderImageParts } from '../public/pixelforge/src/headless-vision.js';

const png = 'data:image/png;base64,iVBORw0KGgo=';

test('artwork vision snapshot carries safe project, viewport, selection and animation context', () => {
  const snapshot = createVisionSnapshot({
    mode: 'artwork',
    artworkImage: png,
    project: { id: 'fixture', width: 32, height: 24, layerCount: 3 },
    viewport: { zoom: 4, panX: 12, panY: 8 },
    selection: { active: true, selectedPixels: 20 },
    animation: {
      fps: 12,
      loop: true,
      selectedFrame: 1,
      frames: [{ index: 0, name: 'Idle', durationMs: 100, image: png }],
    },
  });
  assert.equal(snapshot.mode, 'artwork');
  assert.equal(snapshot.context.project.width, 32);
  assert.equal(snapshot.context.viewport.zoom, 4);
  assert.equal(snapshot.context.selection.selectedPixels, 20);
  assert.equal(snapshot.context.animation.selectedFrame, 1);
  assert.deepEqual(snapshot.images.map(image => image.role), ['artwork', 'animation-frame']);
  const parts = toProviderImageParts(snapshot);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].image_url.url, png);
});

test('vision snapshots reject missing images, unsafe modes and oversized frame lists', () => {
  assert.throws(() => createVisionSnapshot({ mode: 'artwork' }), /requires an artwork image/);
  assert.throws(() => createVisionSnapshot({ mode: 'invalid', artworkImage: png }), /mode must be/);
  assert.throws(() => createVisionSnapshot({
    mode: 'artwork',
    artworkImage: png,
    animation: { frames: Array.from({ length: 24 }, (_, index) => ({ index, durationMs: 100, image: png })) },
  }), /visible frames/);
});

test('vision snapshots reject malformed or oversized image payloads and metadata', () => {
  assert.throws(() => createVisionSnapshot({ mode: 'artwork', artworkImage: 'data:image/jpeg;base64,AAAA' }), /PNG data URL/);
  assert.throws(() => createVisionSnapshot({ mode: 'artwork', artworkImage: png, project: [] }), /project must be an object/);
  assert.throws(() => toProviderImageParts(null), /Expected a vision snapshot/);
});
