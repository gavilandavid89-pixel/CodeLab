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

/**
 * Resolve the mode that owns a rendered/edited cel. More specific content
 * metadata always wins over editor/project defaults.
 */
export function resolveDrawingMode({ cel, frame, layer, project } = {}) {
  const candidates = [cel?.authoringMode, cel?.metadata?.authoringMode, frame?.authoringMode, layer?.authoringMode];
  for (const mode of candidates) if (VALID_MODES.includes(mode)) return mode;
  const configuration = normalizeDrawingConfiguration(project?.drawingConfiguration ?? project);
  return VALID_MODES.includes(configuration.activeMode)
    ? configuration.activeMode
    : PIXELFORGE_DRAWING_MODES.PIXEL_ART;
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
    ? { imageSmoothingEnabled: true, imageSmoothingQuality: 'high', brushProfile: 'soft', brushSize: 5, brushShape: 'circle', brushHardness: 55, interpolation: 'bilinear' }
    : { imageSmoothingEnabled: false, imageSmoothingQuality: 'low', brushProfile: 'hard', brushSize: 1, brushShape: 'square', brushHardness: 100, interpolation: 'nearest' };
}


export function getVideoScalingMode(drawingMode) {
  return drawingMode === PIXELFORGE_DRAWING_MODES.PIXEL_ART ? 'pixelated' : 'smooth';
}

/**
 * Normalize a layer's saved editing profile for one drawing mode.
 * Invalid or missing fields fall back independently to that mode's defaults.
 */
export function normalizeDrawingModeProfile(mode, value) {
  const defaults = getDrawingModePresentation(mode);
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const number = (key, fallback, min, max, integer = false) => {
    const parsed = Number(source[key]);
    if (!Number.isFinite(parsed)) return fallback;
    const bounded = Math.max(min, Math.min(max, parsed));
    return integer ? Math.round(bounded) : bounded;
  };
  return {
    brushSize: number('brushSize', defaults.brushSize, 1, 32, true),
    brushShape: ['square', 'circle'].includes(source.brushShape) ? source.brushShape : defaults.brushShape,
    brushHardness: number('brushHardness', defaults.brushHardness, 0, 100),
    brushOpacity: number('brushOpacity', 100, 0, 100),
    interpolation: ['nearest', 'bilinear'].includes(source.interpolation) ? source.interpolation : defaults.interpolation,
  };
}

/**
 * Store only non-default values. This keeps the common case compact while
 * preserving deliberate per-layer/per-cel exceptions for each drawing mode.
 */
export function updateDrawingModeOverrides(overrides, mode, profile) {
  const defaults = normalizeDrawingModeProfile(mode, getDrawingModePresentation(mode));
  const normalized = normalizeDrawingModeProfile(mode, profile);
  const next = overrides && typeof overrides === 'object' && !Array.isArray(overrides)
    ? structuredClone(overrides) : {};
  const isDefault = Object.keys(defaults).every(key => normalized[key] === defaults[key]);
  if (isDefault) delete next[mode];
  else next[mode] = normalized;
  return next;
}
