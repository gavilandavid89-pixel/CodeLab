import { createVisionSnapshot, toProviderImageParts } from './headless-vision.js';

const CONSENT_TTL_MS = 5 * 60 * 1000;
const consentTokens = new WeakMap();

function assertProjectId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) {
    throw new TypeError('A valid PixelForge project ID is required.');
  }
  return value;
}

function pick(source, keys) {
  if (source === null || source === undefined) return null;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError('Vision metadata must be an object.');
  }
  const output = {};
  for (const key of keys) {
    if (source[key] !== undefined) output[key] = source[key];
  }
  return output;
}

/**
 * Ask the host UI to show an explicit, project-scoped privacy confirmation.
 * The confirm callback must resolve true only after a user-facing approval
 * action; declining or dismissing the prompt creates no usable consent token.
 */
export async function requestPixelForgeVisionConsent({ projectId, confirm } = {}) {
  projectId = assertProjectId(projectId);
  if (typeof confirm !== 'function') throw new TypeError('A user-facing consent confirmation callback is required.');
  const approved = await confirm(Object.freeze({
    title: 'Allow AI to inspect this PixelForge artwork?',
    message: 'A snapshot of this artwork will be sent to the configured AI vision provider for this request. The snapshot is not saved to the project by this helper.',
    scope: 'pixel-forge-artwork-snapshot',
    projectId,
  }));
  if (approved !== true) return null;
  const token = Object.freeze({});
  consentTokens.set(token, { projectId, expiresAt: Date.now() + CONSENT_TTL_MS });
  return token;
}

/**
 * Build a provider-ready, artwork-only vision request after consuming a
 * one-time consent token. This module does not perform network calls, persist
 * snapshots, or place image bytes in the GitHub/mailbox command payload.
 */
export function preparePixelForgeVisionRequest({
  consent,
  projectId,
  artworkImage,
  project = {},
  selection = null,
  viewport = null,
  animation = null,
} = {}) {
  projectId = assertProjectId(projectId);
  const grant = consent && typeof consent === 'object' ? consentTokens.get(consent) : null;
  if (!grant || grant.projectId !== projectId || grant.expiresAt <= Date.now()) {
    if (grant) consentTokens.delete(consent);
    const error = new Error('Explicit, current consent for this PixelForge project is required before sending artwork to vision.');
    error.code = 'pixelforge_vision_consent_required';
    throw error;
  }
  consentTokens.delete(consent);

  const safeProject = pick(project, ['name', 'width', 'height', 'revision', 'layerCount', 'activeLayerId']);
  const safeSelection = pick(selection, ['x', 'y', 'width', 'height', 'selectedPixels', 'shape']);
  const safeViewport = pick(viewport, ['zoom', 'panX', 'panY', 'canvasWidth', 'canvasHeight']);
  let safeAnimation = null;
  if (animation !== null) {
    if (!animation || typeof animation !== 'object' || Array.isArray(animation)) {
      throw new TypeError('Animation vision metadata must be an object.');
    }
    if (!Array.isArray(animation.frames)) throw new TypeError('Animation frames must be an array.');
    safeAnimation = {
      fps: animation.fps,
      loop: animation.loop,
      selectedFrame: animation.selectedFrame,
      frames: animation.frames.map(frame => ({
        index: frame?.index,
        durationMs: frame?.durationMs,
        name: frame?.name,
        image: frame?.image,
      })),
    };
  }
  const snapshot = createVisionSnapshot({
    mode: 'artwork',
    artworkImage,
    project: { ...safeProject, projectId },
    selection: safeSelection,
    viewport: safeViewport,
    animation: safeAnimation,
  });
  return Object.freeze({
    projectId,
    context: snapshot.context,
    imageParts: Object.freeze(toProviderImageParts(snapshot)),
    imageCount: snapshot.images.length,
    consentConsumed: true,
  });
}

export const PIXELFORGE_VISION_CONSENT_TTL_MS = CONSENT_TTL_MS;
