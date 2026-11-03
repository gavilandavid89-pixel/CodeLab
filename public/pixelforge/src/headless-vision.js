const MAX_IMAGES = 24;
const MAX_IMAGE_LENGTH = 8 * 1024 * 1024;
const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
const MODES = new Set(['interface', 'artwork', 'combined']);

function validateImage(image, label) {
  if (typeof image !== 'string' || !PNG_DATA_URL.test(image) || image.length > MAX_IMAGE_LENGTH) {
    throw new TypeError(label + ' must be a PNG data URL no larger than 8 MiB.');
  }
  return image;
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(label + ' must be an object.');
  return value;
}

/**
 * Immutable, DOM-free observation packet. The browser host is responsible for
 * capturing screenshots; Headless receives pixels plus semantic editor data.
 */
export function createVisionSnapshot({
  mode = 'combined',
  interfaceImage,
  artworkImage,
  project = {},
  selection = null,
  viewport = null,
  animation = null,
} = {}) {
  if (!MODES.has(mode)) throw new TypeError('Vision mode must be interface, artwork, or combined.');
  if (mode !== 'artwork' && !interfaceImage) throw new TypeError('This vision mode requires an interface screenshot.');
  if (mode !== 'interface' && !artworkImage) throw new TypeError('This vision mode requires an artwork image.');
  const images = [];
  if (mode !== 'artwork') images.push({ role: 'interface', label: 'Editor interface screenshot', dataUrl: validateImage(interfaceImage, 'interfaceImage') });
  if (mode !== 'interface') images.push({ role: 'artwork', label: 'Full artwork composite', dataUrl: validateImage(artworkImage, 'artworkImage') });
  const safeProject = plainObject(project, 'project');
  const safeViewport = viewport === null ? null : plainObject(viewport, 'viewport');
  const safeSelection = selection === null ? null : plainObject(selection, 'selection');
  let safeAnimation = null;
  if (animation !== null) {
    plainObject(animation, 'animation');
    if (!Array.isArray(animation.frames) || animation.frames.length < 1 || animation.frames.length > MAX_IMAGES - images.length) {
      throw new RangeError('Animation must contain between 1 and ' + (MAX_IMAGES - images.length) + ' visible frames.');
    }
    const frames = animation.frames.map((frame, index) => {
      plainObject(frame, 'animation frame ' + index);
      if (!Number.isInteger(frame.index) || frame.index < 0) throw new TypeError('Frame index must be a non-negative integer.');
      if (!Number.isFinite(frame.durationMs) || frame.durationMs < 1 || frame.durationMs > 60000) throw new RangeError('Frame duration must be between 1 and 60000 ms.');
      const dataUrl = validateImage(frame.image, 'frame ' + index + ' image');
      images.push({ role: 'animation-frame', label: 'Animation frame ' + frame.index + ' (' + frame.durationMs + ' ms)', dataUrl });
      return { index: frame.index, durationMs: frame.durationMs, name: typeof frame.name === 'string' ? frame.name.slice(0, 120) : null };
    });
    safeAnimation = {
      fps: Number.isFinite(animation.fps) && animation.fps > 0 && animation.fps <= 120 ? animation.fps : null,
      loop: animation.loop !== false,
      selectedFrame: Number.isInteger(animation.selectedFrame) ? animation.selectedFrame : null,
      frames,
    };
  }
  const snapshot = {
    mode,
    project: { ...safeProject },
    viewport: safeViewport ? { ...safeViewport } : null,
    selection: safeSelection ? { ...safeSelection } : null,
    animation: safeAnimation,
    images: images.map(({ role, label }) => ({ role, label })),
  };
  if (JSON.stringify(snapshot).length > 50000) throw new RangeError('Vision metadata exceeds 50,000 characters.');
  return Object.freeze({
    mode,
    context: Object.freeze(snapshot),
    images: Object.freeze(images.map(image => Object.freeze(image))),
  });
}

export function toProviderImageParts(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.images)) throw new TypeError('Expected a vision snapshot.');
  return snapshot.images.map(image => ({
    type: 'image_url',
    image_url: { url: image.dataUrl, detail: 'high' },
  }));
}
