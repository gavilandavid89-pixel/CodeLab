import { createVisionSnapshot, toProviderImageParts } from './headless-vision.js';

const CONSENT_TTL_MS = 5 * 60 * 1000;
const MAX_IMAGE_LENGTH = 8 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 8192;
const MAX_IMAGE_PIXELS = 16_777_216;
const PNG_PREFIX = 'data:image/png;base64,';
const PNG_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const consentTokens = new WeakMap();

function assertPngDataUrl(value, label) {
  if (typeof value !== 'string' || !value.startsWith(PNG_PREFIX) || value.length > MAX_IMAGE_LENGTH) {
    throw new TypeError(label + ' must be a PNG data URL no larger than 8 MiB.');
  }
  const encoded = value.slice(PNG_PREFIX.length);
  if (!PNG_BASE64.test(encoded)) throw new TypeError(label + ' contains invalid PNG Base64.');
  let binary;
  try { binary = atob(encoded); } catch { throw new TypeError(label + ' contains invalid PNG Base64.'); }
  if (btoa(binary) !== encoded || binary.length < 24) throw new TypeError(label + ' is not a canonical PNG image.');
  for (let index = 0; index < PNG_SIGNATURE.length; index++) {
    if (binary.charCodeAt(index) !== PNG_SIGNATURE[index]) throw new TypeError(label + ' has an invalid PNG signature.');
  }
  if (binary.slice(12, 16) !== 'IHDR') throw new TypeError(label + ' is missing the PNG IHDR header.');
  const width = ((binary.charCodeAt(16) << 24) | (binary.charCodeAt(17) << 16) |
    (binary.charCodeAt(18) << 8) | binary.charCodeAt(19)) >>> 0;
  const height = ((binary.charCodeAt(20) << 24) | (binary.charCodeAt(21) << 16) |
    (binary.charCodeAt(22) << 8) | binary.charCodeAt(23)) >>> 0;
  if (!width || !height || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION ||
      width * height > MAX_IMAGE_PIXELS) {
    throw new RangeError(label + ' dimensions exceed the PixelForge vision safety limit.');
  }
  return value;
}

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
  if (consent && typeof consent === 'object') consentTokens.delete(consent);
  if (!grant || grant.projectId !== projectId || grant.expiresAt <= Date.now()) {
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
    if (animation.frames.length < 1 || animation.frames.length > 23) {
      throw new RangeError('PixelForge vision accepts between 1 and 23 animation frames per snapshot.');
    }
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
  assertPngDataUrl(artworkImage, 'artworkImage');
  if (safeAnimation) {
    for (const [index, frame] of safeAnimation.frames.entries()) {
      assertPngDataUrl(frame.image, 'animation frame ' + index + ' image');
    }
  }
  const snapshot = createVisionSnapshot({
    mode: 'artwork',
    artworkImage,
    project: safeProject,
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


/**
 * Render a RasterDocument composite into a PNG data URL in the browser host.
 * The canvas factory is injected so this module remains testable and does not
 * capture the editor DOM or interface chrome.
 */
export function capturePixelForgeArtworkDataUrl({ rasterDocument, canvasFactory } = {}) {
  if (!rasterDocument || !Number.isInteger(rasterDocument.width) ||
      !Number.isInteger(rasterDocument.height) || rasterDocument.width < 1 ||
      rasterDocument.height < 1 || rasterDocument.width > 2048 ||
      rasterDocument.height > 2048 || rasterDocument.width * rasterDocument.height > 4_194_304) {
    throw new RangeError('A valid PixelForge raster document within canvas limits is required.');
  }
  if (typeof canvasFactory !== 'function') throw new TypeError('A browser canvas factory is required for artwork capture.');
  const pixels = rasterDocument.composite();
  if (!(pixels instanceof Uint8Array) && !(pixels instanceof Uint8ClampedArray)) {
    throw new TypeError('RasterDocument composite must return RGBA pixel bytes.');
  }
  if (pixels.byteLength !== rasterDocument.width * rasterDocument.height * 4) {
    throw new RangeError('RasterDocument composite pixel length does not match its dimensions.');
  }
  const canvas = canvasFactory();
  if (!canvas || typeof canvas.getContext !== 'function' || typeof canvas.toDataURL !== 'function') {
    throw new TypeError('Canvas factory must return a PNG-capable canvas.');
  }
  canvas.width = rasterDocument.width;
  canvas.height = rasterDocument.height;
  const context = canvas.getContext('2d', { alpha: true });
  if (!context || typeof context.createImageData !== 'function' || typeof context.putImageData !== 'function') {
    throw new Error('Canvas 2D context cannot accept PixelForge RGBA pixels.');
  }
  const imageData = context.createImageData(rasterDocument.width, rasterDocument.height);
  imageData.data.set(pixels);
  context.putImageData(imageData, 0, 0);
  const dataUrl = canvas.toDataURL('image/png');
  assertPngDataUrl(dataUrl, 'captured artwork');
  return dataUrl;
}

export const PIXELFORGE_VISION_CONSENT_TTL_MS = CONSENT_TTL_MS;
