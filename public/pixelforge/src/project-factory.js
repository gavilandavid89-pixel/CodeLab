export const PIXELFORGE_STARTER_TEMPLATES = Object.freeze({
  custom: Object.freeze({ width: 128, height: 128, name: 'Untitled artwork', layers: Object.freeze(['Layer 1']) }),
  character: Object.freeze({ width: 64, height: 64, name: 'Character sprite', layers: Object.freeze(['Sketch', 'Lineart', 'Color', 'Shading']) }),
  icon: Object.freeze({ width: 32, height: 32, name: 'Game icon', layers: Object.freeze(['Base', 'Details', 'Highlights']) }),
  tile: Object.freeze({ width: 32, height: 32, name: 'Environment tile', layers: Object.freeze(['Base', 'Details', 'Edges']) }),
  ui: Object.freeze({ width: 128, height: 64, name: 'UI element', layers: Object.freeze(['Base', 'Border', 'Details']) }),
  background: Object.freeze({ width: 256, height: 144, name: 'Background scene', layers: Object.freeze(['Far', 'Middle', 'Foreground']) }),
  effect: Object.freeze({ width: 64, height: 64, name: 'VFX sprite', layers: Object.freeze(['Core', 'Glow', 'Particles']) }),
});

export function normalizePixelForgeProjectOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('PixelForge project options must be an object.');
  }
  const template = options.template ?? 'custom';
  const defaults = PIXELFORGE_STARTER_TEMPLATES[template];
  if (!defaults) throw new TypeError('Unsupported PixelForge starter template.');
  const width = options.width ?? defaults.width;
  const height = options.height ?? defaults.height;
  const name = options.name ?? defaults.name;
  const layers = options.layerNames ?? defaults.layers;
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || width > 2048 || height > 2048 ||
      width * height > 4_194_304) {
    throw new RangeError('PixelForge canvas dimensions exceed the supported limits.');
  }
  if (typeof name !== 'string' || !name.trim() || name.length > 180) {
    throw new TypeError('PixelForge project name must contain 1 to 180 characters.');
  }
  if (!Array.isArray(layers) || layers.length < 1 || layers.length > 64 ||
      layers.some(layer => typeof layer !== 'string' || !layer.trim() || layer.length > 180) ||
      new Set(layers).size !== layers.length) {
    throw new TypeError('PixelForge layer names must contain 1 to 64 unique valid names.');
  }
  if (width * height * 4 * layers.length > 64 * 1024 * 1024) {
    throw new RangeError('PixelForge project exceeds the 64 MiB expanded layer-memory budget.');
  }
  return { template, width, height, name: name.trim(), layerNames: [...layers] };
}

/** Create a new project with the same initial layer/history semantics as the visual editor. */
export function createPixelForgeProject(options = {}, { RasterDocument, HeadlessEditorRuntime } = {}) {
  if (typeof RasterDocument !== 'function' || typeof HeadlessEditorRuntime !== 'function') {
    throw new TypeError('RasterDocument and HeadlessEditorRuntime constructors are required.');
  }
  const normalized = normalizePixelForgeProjectOptions(options);
  const document = new RasterDocument(normalized.width, normalized.height, normalized.name);
  const firstLayerId = document.activeLayerId;
  if (document.activeLayer.name !== normalized.layerNames[0]) {
    document.renameLayer(firstLayerId, normalized.layerNames[0]);
  }
  for (const layerName of normalized.layerNames.slice(1)) document.addLayer(layerName);
  document.setActiveLayer(firstLayerId);

  // Starter scaffolding is the initial project state, not an undoable edit.
  document.history.length = 0;
  document.future.length = 0;
  document.historyBytes = 0;
  document.revision = 0;
  document.saveVersion = 0;
  document.serverRevision = 0;
  document.dirty = false;

  const runtime = new HeadlessEditorRuntime({ project: document.toJSON() });
  const project = runtime.toJSON();
  return {
    project,
    template: normalized.template,
    layerNames: normalized.layerNames,
    readback: {
      width: project.width,
      height: project.height,
      layerCount: project.layers.length,
      activeLayerId: project.activeLayerId,
      revision: project.revision,
      serverRevision: project.serverRevision,
    },
  };
}
