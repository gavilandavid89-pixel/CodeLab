import test from 'node:test';
import assert from 'node:assert/strict';
import {
  requestPixelForgeVisionConsent,
  preparePixelForgeVisionRequest,
  PIXELFORGE_VISION_CONSENT_TTL_MS,
} from '../public/pixelforge/src/pixelforge-vision.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

test('requires a user-facing confirmation callback and refuses declined consent', async () => {
  await assert.rejects(() => requestPixelForgeVisionConsent({ projectId: 'project-1' }), /confirmation callback/);
  assert.equal(await requestPixelForgeVisionConsent({ projectId: 'project-1', confirm: async () => false }), null);
  assert.equal(await requestPixelForgeVisionConsent({ projectId: 'project-1', confirm: async () => undefined }), null);
});

test('requires explicit project-scoped consent before preparing provider image parts', async () => {
  const args = { projectId: 'project-1', artworkImage: PNG };
  assert.throws(() => preparePixelForgeVisionRequest(args), error => error.code === 'pixelforge_vision_consent_required');
  let prompt;
  const consent = await requestPixelForgeVisionConsent({
    projectId: 'project-1',
    confirm: async value => { prompt = value; return true; },
  });
  assert.equal(prompt.scope, 'pixel-forge-artwork-snapshot');
  assert.equal(prompt.projectId, 'project-1');
  const request = preparePixelForgeVisionRequest({
    ...args,
    consent,
    project: { name: 'Sketch', width: 32, height: 32, revision: 4, ownerEmail: 'private@example.test' },
  });
  assert.equal(request.projectId, 'project-1');
  assert.equal(request.imageCount, 1);
  assert.equal(request.imageParts[0].type, 'image_url');
  assert.equal(request.context.project.name, 'Sketch');
  assert.equal(request.context.project.ownerEmail, undefined);
  assert.equal(request.consentConsumed, true);
});

test('consent is one-use and cannot be replayed or transferred to another project', async () => {
  const consent = await requestPixelForgeVisionConsent({ projectId: 'project-1', confirm: async () => true });
  assert.throws(() => preparePixelForgeVisionRequest({ consent, projectId: 'project-2', artworkImage: PNG }), error => error.code === 'pixelforge_vision_consent_required');
  assert.throws(() => preparePixelForgeVisionRequest({ consent, projectId: 'project-1', artworkImage: PNG }), error => error.code === 'pixelforge_vision_consent_required');
});

test('includes only validated animation frames and bounded semantic metadata', async () => {
  const consent = await requestPixelForgeVisionConsent({ projectId: 'project-1', confirm: async () => true });
  const request = preparePixelForgeVisionRequest({
    consent,
    projectId: 'project-1',
    artworkImage: PNG,
    selection: { x: 1, y: 2, width: 3, height: 4, selectedPixels: 12, secret: 'omit' },
    viewport: { zoom: 2, panX: 4, panY: 5, accessToken: 'omit' },
    animation: { fps: 12, loop: true, selectedFrame: 0, frames: [{ index: 0, durationMs: 83, name: 'first', image: PNG }] },
  });
  assert.equal(request.imageCount, 2);
  assert.equal(request.imageParts.length, 2);
  assert.equal(request.context.selection.secret, undefined);
  assert.equal(request.context.viewport.accessToken, undefined);
  assert.equal(request.context.animation.frames[0].durationMs, 83);
});

test('rejects invalid image payloads and malformed animation metadata', async () => {
  const consent = await requestPixelForgeVisionConsent({ projectId: 'project-1', confirm: async () => true });
  assert.throws(() => preparePixelForgeVisionRequest({ consent, projectId: 'project-1', artworkImage: 'data:image/jpeg;base64,AAAA' }), /PNG data URL/);
  const nextConsent = await requestPixelForgeVisionConsent({ projectId: 'project-1', confirm: async () => true });
  assert.throws(() => preparePixelForgeVisionRequest({
    consent: nextConsent, projectId: 'project-1', artworkImage: PNG,
    animation: { frames: 'not-an-array' },
  }), /frames must be an array/);
  assert.equal(PIXELFORGE_VISION_CONSENT_TTL_MS, 300000);
});

test('rejects forged and expired consent tokens', async () => {
  assert.throws(() => preparePixelForgeVisionRequest({
    consent: {}, projectId: 'project-1', artworkImage: PNG,
  }), error => error.code === 'pixelforge_vision_consent_required');

  const consent = await requestPixelForgeVisionConsent({
    projectId: 'project-1', confirm: async () => true,
  });
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + PIXELFORGE_VISION_CONSENT_TTL_MS + 1;
    assert.throws(() => preparePixelForgeVisionRequest({
      consent, projectId: 'project-1', artworkImage: PNG,
    }), error => error.code === 'pixelforge_vision_consent_required');
  } finally {
    Date.now = originalNow;
  }
});

test('enforces the existing vision snapshot image-count and per-image byte limits', async () => {
  const consent = await requestPixelForgeVisionConsent({
    projectId: 'project-1', confirm: async () => true,
  });
  const tooManyFrames = Array.from({ length: 24 }, (_, index) => ({
    index, durationMs: 80, image: PNG,
  }));
  assert.throws(() => preparePixelForgeVisionRequest({
    consent, projectId: 'project-1', artworkImage: PNG,
    animation: { frames: tooManyFrames },
  }), /between 1 and 23 visible frames/);

  const nextConsent = await requestPixelForgeVisionConsent({
    projectId: 'project-1', confirm: async () => true,
  });
  const oversized = 'data:image/png;base64,' + 'A'.repeat(8 * 1024 * 1024);
  assert.throws(() => preparePixelForgeVisionRequest({
    consent: nextConsent, projectId: 'project-1', artworkImage: oversized,
  }), /no larger than 8 MiB/);
});
