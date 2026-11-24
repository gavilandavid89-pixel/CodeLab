/**
 * Persisted drawing-mode contract for PixelForge projects.
 * Modes affect presentation/tool defaults, never source pixel dimensions or data.
 */
export const PIXELFORGE_DRAWING_MODES = Object.freeze({
  ILLUSTRATION: 'illustration',
  PIXEL_ART: 'pixel-art',
});
export const PIXELFORGE_DRAWING_CONFIGURATION_VERSION = 1;

const VALID_MODES = Object.values(PIXELFORGE_DRAWING_MODES);

export function normalizeDrawingConfiguration(value, { legacyDefault = PIXELFORGE_DRAWING_MODES.PIXEL_ART } = {}) {
  const fallback = VALID_MODES.includes(legacyDefault) ? legacyDefault : PIXELFORGE_DRAWING_MODES.PIXEL_ART;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      version: PIXELFORGE_DRAWING_CONFIGURATION_VERSION,
      availableModes: [...VALID_MODES],
      initialMode: fallback,
      activeMode: fallback,
    };
  }
  const availableModes = Array.isArray(value.availableModes)
    ? [...new Set(value.availableModes.filter(mode => VALID_MODES.includes(mode)))]
    : [...VALID_MODES];
  if (!availableModes.length) availableModes.push(fallback);
  const initialMode = availableModes.includes(value.initialMode) ? value.initialMode : availableModes[0];
  const activeMode = availableModes.includes(value.activeMode) ? value.activeMode : initialMode;
  return {
    version: PIXELFORGE_DRAWING_CONFIGURATION_VERSION,
    availableModes,
    initialMode,
    activeMode,
  };
}

export function switchDrawingMode(configuration, mode) {
  const current = normalizeDrawingConfiguration(configuration);
  if (!current.availableModes.includes(mode)) {
    throw new RangeError('This project does not enable the selected drawing mode.');
  }
  return { ...current, activeMode: mode };
}

export function getDrawingModePresentation(mode) {
  return mode === PIXELFORGE_DRAWING_MODES.ILLUSTRATION
    ? { imageSmoothingEnabled: true, imageSmoothingQuality: 'high', brushProfile: 'soft', interpolation: 'bilinear' }
    : { imageSmoothingEnabled: false, imageSmoothingQuality: 'low', brushProfile: 'hard', interpolation: 'nearest' };
}
