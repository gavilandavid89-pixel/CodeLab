import { createHash } from 'node:crypto';

const MAX_FRAMES = 240;
const MAX_LAYERS = 64;
const MAX_CANVAS = 4096;
const MAX_REFERENCE_PARTS = 256;
const MAX_REFERENCE_BYTES = 16 * 1024 * 1024;

function fail(message) {
  throw new Error('CodeLab structured package: ' + message);
}

function jsonFile(files, filePath, label) {
  const bytes = files.get(filePath);
  if (!bytes) fail(label + ' is missing: ' + filePath);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(label + ' is not valid JSON: ' + filePath);
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(label + ' must be a non-empty string.');
  return value;
}

function requireSafeRelativePath(value, label) {
  requireString(value, label);
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    fail(label + ' is not a safe relative path: ' + value);
  }
  return normalized;
}

function requireInt(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail(label + ' must be an integer between ' + min + ' and ' + max + '.');
  return value;
}

function requireFinite(value, label) {
  if (!Number.isFinite(Number(value))) fail(label + ' must be finite.');
  return Number(value);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readRgba8(files, pixelsPath, width, height, label) {
  const safePath = requireSafeRelativePath(pixelsPath, label + '.pixelsPath');
  const bytes = files.get(safePath);
  if (!bytes) fail(label + ' pixels are missing: ' + safePath);
  const expected = width * height * 4;
  if (bytes.length !== expected) {
    fail(label + ' pixels.bin must contain exactly ' + expected + ' RGBA8 bytes; received ' + bytes.length + '.');
  }
  return bytes;
}

function normalizeTransform(transform = {}) {
  if (!transform || typeof transform !== 'object' || Array.isArray(transform)) fail('transform must be an object.');
  const keys = ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'skewX', 'skewY'];
  const result = {};
  for (const key of keys) if (transform[key] !== undefined) result[key] = requireFinite(transform[key], 'transform.' + key);
  return result;
}


const SCENE_SECTION_LAYOUT = {
  environment: { folder: 'Entorno', filename: 'entorno.tscn', role: 'environment' },
  effects: { folder: 'Efectos', filename: 'efectos.tscn', role: 'effect' },
  details: { folder: 'Detalles', filename: 'detalles.tscn', role: 'detail' },
  elements: { folder: 'Elementos', filename: 'elementos.tscn', role: 'element' },
  objects: { folder: 'Objetos', filename: 'objetos.tscn', role: 'object' },
};

function validateSceneWorkspace(workspace, label) {
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace) ||
      workspace.format !== 'pixelforge-project' || typeof workspace.id !== 'string' ||
      !workspace.id || typeof workspace.name !== 'string' || !workspace.name.trim()) {
    fail(label + ' workspace must be a complete native pixelforge-project document.');
  }
  const width = Number(workspace.width), height = Number(workspace.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > MAX_CANVAS || height > MAX_CANVAS || !Array.isArray(workspace.layers) ||
      workspace.layers.length < 1 || workspace.layers.length > MAX_LAYERS) {
    fail(label + ' workspace canvas or layer stack is invalid.');
  }
  const layerIds = workspace.layers.map(layer => String(layer?.id || ''));
  if (layerIds.some(id => !id) || new Set(layerIds).size !== layerIds.length) {
    fail(label + ' workspace contains missing or duplicate layer IDs.');
  }
  const expectedBytes = width * height * 4;
  for (const layer of workspace.layers) {
    if (typeof layer.pixels !== 'string' || Buffer.from(layer.pixels, 'base64').length !== expectedBytes) {
      fail(label + ' workspace layer ' + layer.id + ' has invalid RGBA8 pixels.');
    }
  }
  if (!workspace.animation || typeof workspace.animation !== 'object') {
    fail(label + ' workspace must contain at least one complete frame.');
  }
  {
    const animation = workspace.animation;
    if (!Array.isArray(animation.frames) || animation.frames.length < 1 ||
        animation.frames.length > MAX_FRAMES || Number(animation.width) !== width ||
        Number(animation.height) !== height || !Number.isInteger(Number(animation.fps)) ||
        Number(animation.fps) < 1 || Number(animation.fps) > 60) {
      fail(label + ' workspace animation timeline is invalid.');
    }
    for (const [index, frame] of animation.frames.entries()) {
      const cels = Array.isArray(frame.cels) ? frame.cels : [];
      const celMap = new Map(cels.map(cel => [String(cel.layerId), cel]));
      if (cels.length !== layerIds.length || celMap.size !== cels.length ||
          layerIds.some(id => !celMap.has(id)) ||
          !Number.isFinite(Number(frame.durationMs)) || Number(frame.durationMs) < 1 ||
          Number(frame.durationMs) > 10000) {
        fail(label + ' workspace frame ' + index + ' must contain one valid cel per layer.');
      }
      for (const cel of cels) {
        if (typeof cel.pixels !== 'string' || Buffer.from(cel.pixels, 'base64').length !== expectedBytes) {
          fail(label + ' workspace frame ' + index + ' contains invalid RGBA8 cel data.');
        }
      }
    }
  }
  return structuredClone(workspace);
}

function installSceneSections(project, files, scenesManifest) {
  if (!scenesManifest || scenesManifest.format !== 'codelab-pixelforge-scenes' ||
      Number(scenesManifest.version) !== 1 || !scenesManifest.sections ||
      typeof scenesManifest.sections !== 'object' || Array.isArray(scenesManifest.sections)) {
    fail('manifest.scenes must declare codelab-pixelforge-scenes version 1.');
  }
  const layerIds = new Set((project.layers || []).map(layer => String(layer.id)));
  const drawing = project.drawingModel && typeof project.drawingModel === 'object'
    ? structuredClone(project.drawingModel) : {};
  const drawingObjects = new Set((Array.isArray(drawing.objects) ? drawing.objects : []).map(item => String(item.id)));
  const flattenVector = list => (Array.isArray(list) ? list : []).flatMap(item => [
    item, ...(item?.type === 'group' ? flattenVector(item.children) : []),
  ]);
  const vectorObjects = new Set(flattenVector(project.vectorModel?.objects).map(item => String(item.id)));
  const installed = {};
  drawing.sceneSections = drawing.sceneSections && typeof drawing.sceneSections === 'object'
    ? drawing.sceneSections : {};
  for (const [key, layout] of Object.entries(SCENE_SECTION_LAYOUT)) {
    const declaration = scenesManifest.sections[key];
    if (!declaration || typeof declaration.manifestPath !== 'string') {
      fail('manifest.scenes.sections.' + key + '.manifestPath is required.');
    }
    const scenePath = requireSafeRelativePath(declaration.manifestPath, 'scene ' + key + ' manifestPath');
    if (scenePath !== layout.folder + '/' + layout.filename) {
      fail('scene ' + key + ' must use canonical path ' + layout.folder + '/' + layout.filename + '.');
    }
    const scene = jsonFile(files, scenePath, key + ' scene manifest');
    if (scene.format !== 'codelab-pixelforge-scene' || ![1, 2].includes(Number(scene.version)) ||
        scene.sceneType !== key || String(scene.projectId) !== String(project.id)) {
      fail(scenePath + ' must declare the matching PixelForge scene type, version and projectId.');
    }
    const workspace = scene.workspace !== undefined && scene.workspace !== null
      ? validateSceneWorkspace(scene.workspace, scenePath) : null;
    const expectedCanvas = workspace || project;
    if (!scene.canvas || Number(scene.canvas.width) !== Number(expectedCanvas.width) ||
        Number(scene.canvas.height) !== Number(expectedCanvas.height)) {
      fail(scenePath + ' canvas dimensions must match its complete workspace.');
    }
    if (Number(scene.version) === 1) {
      for (const [field, validIds, label] of [
        ['layerIds', layerIds, 'layer'],
        ['drawingObjectIds', drawingObjects, 'drawing object'],
        ['vectorObjectIds', vectorObjects, 'vector object'],
      ]) {
        const ids = scene[field] ?? [];
        if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !validIds.has(id)) ||
            new Set(ids).size !== ids.length) {
          fail(scenePath + ' contains an unknown or duplicate ' + label + ' ID in ' + field + '.');
        }
      }
    }
    if (!scene.data || typeof scene.data !== 'object' || Array.isArray(scene.data)) {
      fail(scenePath + ' data must be an object.');
    }
    const sectionData = structuredClone(scene.data);
    if (workspace) sectionData.workspace = workspace;
    drawing.sceneSections[key] = sectionData;
    if (key === 'environment' && scene.environmentHistory !== undefined) {
      if (!scene.environmentHistory || typeof scene.environmentHistory !== 'object' ||
          !Array.isArray(scene.environmentHistory.entries)) {
        fail(scenePath + ' environmentHistory is invalid.');
      }
      drawing.environmentHistory = structuredClone(scene.environmentHistory);
    }
    installed[key] = {
      manifestPath: scenePath,
      layerCount: workspace?.layers?.length ?? (scene.layerIds || []).length,
      drawingObjectCount: (scene.drawingObjectIds || []).length,
      vectorObjectCount: (scene.vectorObjectIds || []).length,
    };
  }
  project.drawingModel = drawing;
  return installed;
}

function installStructuredFrames(project, files, framesManifest) {
  if (!framesManifest || framesManifest.format !== 'codelab-frames' || Number(framesManifest.version) !== 1) {
    fail('frames/frames.tscn must declare format codelab-frames version 1.');
  }
  if (!framesManifest.canvas || Number(framesManifest.canvas.width) !== Number(project.width) ||
      Number(framesManifest.canvas.height) !== Number(project.height)) {
    fail('frames canvas dimensions must match project.json dimensions.');
  }
  const fps = requireInt(framesManifest.fps ?? 12, 'frames fps', 1, 60);
  const activeFrameIndex = requireInt(framesManifest.activeFrameIndex ?? 0, 'frames activeFrameIndex', 0, MAX_FRAMES - 1);
  const frameRefs = framesManifest.frames;
  if (!Array.isArray(frameRefs) || frameRefs.length < 1 || frameRefs.length > MAX_FRAMES) {
    fail('frames/frames.tscn must declare 1–240 frames.');
  }
  if (activeFrameIndex >= frameRefs.length) fail('activeFrameIndex must point to an existing frame.');
  const layerIds = project.layers.map(layer => String(layer.id));
  if (!layerIds.length || layerIds.length > MAX_LAYERS || new Set(layerIds).size !== layerIds.length) {
    fail('project layers must have unique IDs before structured animation installation.');
  }

  const seenFrameIds = new Set();
  const frames = [];
  const frameLayerMetadata = [];
  let totalBytes = 0;
  for (let frameIndex = 0; frameIndex < frameRefs.length; frameIndex++) {
    const ref = frameRefs[frameIndex];
    if (!ref || typeof ref !== 'object') fail('frame reference ' + frameIndex + ' is invalid.');
    const framePath = requireSafeRelativePath(ref.path, 'frame ' + frameIndex + ' path');
    const frame = jsonFile(files, framePath, 'frame.json');
    const frameId = requireString(frame.id, 'frame.id');
    if (seenFrameIds.has(frameId)) fail('duplicate frame ID: ' + frameId);
    seenFrameIds.add(frameId);
    if (Number(frame.index) !== frameIndex) fail(frameId + ' index must equal its position in frames/frames.tscn.');
    const width = requireInt(Number(frame.width), frameId + '.width', 1, MAX_CANVAS);
    const height = requireInt(Number(frame.height), frameId + '.height', 1, MAX_CANVAS);
    if (width !== Number(project.width) || height !== Number(project.height)) fail(frameId + ' dimensions must match project dimensions.');
    const durationMs = requireInt(Number(frame.durationMs), frameId + '.durationMs', 1, 10000);
    const layers = frame.layers;
    if (!Array.isArray(layers) || layers.length !== layerIds.length || Number(frame.layerCount) !== layers.length) {
      fail(frameId + ' must declare exactly ' + layerIds.length + ' layers.');
    }
    const seenLayers = new Set();
    const cels = [];
    const frameMetadata = [];
    for (const layer of layers) {
      if (!layer || typeof layer !== 'object') fail(frameId + ' contains an invalid layer declaration.');
      const layerId = requireString(layer.id, frameId + '.layer.id');
      if (!layerIds.includes(layerId) || seenLayers.has(layerId)) fail(frameId + ' contains an unknown or duplicate layer ID: ' + layerId);
      seenLayers.add(layerId);
      const pixels = readRgba8(files, layer.pixelsPath, width, height, frameId + '/' + layerId);
      totalBytes += pixels.length;
      if (totalBytes > 64 * 1024 * 1024) fail('structured animation exceeds the 64 MiB RGBA8 pixel-memory budget.');
      cels.push({ layerId, pixels: pixels.toString('base64') });
      frameMetadata.push({
        layerId, name: String(layer.name || ''), parentFrameId: String(layer.parentFrameId || frameId), index: requireInt(Number(layer.index ?? frameMetadata.length + 1), frameId + '/' + layerId + '.index', 1, MAX_LAYERS),
        position: { x: requireFinite(layer.position?.x ?? layer.x ?? 0, frameId + '/' + layerId + '.position.x'), y: requireFinite(layer.position?.y ?? layer.y ?? 0, frameId + '/' + layerId + '.position.y') },
        x: requireFinite(layer.x ?? layer.position?.x ?? 0, frameId + '/' + layerId + '.x'), y: requireFinite(layer.y ?? layer.position?.y ?? 0, frameId + '/' + layerId + '.y'),
        scaleX: requireFinite(layer.scaleX ?? 1, frameId + '/' + layerId + '.scaleX'), scaleY: requireFinite(layer.scaleY ?? 1, frameId + '/' + layerId + '.scaleY'),
        rotation: requireFinite(layer.rotation ?? 0, frameId + '/' + layerId + '.rotation'), angle: layer.angle ?? 0,
        opacity: requireFinite(layer.opacity ?? 1, frameId + '/' + layerId + '.opacity'), visible: layer.visible !== false, locked: layer.locked === true,
        blendMode: String(layer.blendMode || 'normal'), blur: layer.blur ?? 0, brightness: layer.brightness ?? 0, contrast: layer.contrast ?? 0, saturation: layer.saturation ?? 0,
        mask: structuredClone(layer.mask ?? 'inexistente'), clipping: structuredClone(layer.clipping ?? 'inexistente'),
        references: Array.isArray(layer.references) ? structuredClone(layer.references) : [], assets: Array.isArray(layer.assets) ? structuredClone(layer.assets) : [],
        metadata: layer.metadata && typeof layer.metadata === 'object' ? structuredClone(layer.metadata) : {},
        zIndex: Number.isFinite(Number(layer.zIndex)) ? Number(layer.zIndex) : frameMetadata.length, pixelsSha256: sha256(pixels),
      });
    }
    if (seenLayers.size !== layerIds.length) fail(frameId + ' does not provide every project layer.');
    frameLayerMetadata.push({ id: frameId, index: frameIndex, layers: frameMetadata });
    frames.push({
      id: frameId,
      name: String(frame.name || frameId),
      index: frameIndex,
      durationMs,
      cels,
      layerMetadata: structuredClone(frameMetadata),
      layerCount: cels.length,
      sourcePath: framePath,
    });
  }
  project.animation = {
    format: 'pixelforge-animation',
    version: 1,
    width: project.width,
    height: project.height,
    layerIds,
    fps,
    activeFrameIndex,
    loop: framesManifest.loop !== false,
    playbackSpeed: Number.isFinite(Number(framesManifest.playbackSpeed)) ? Number(framesManifest.playbackSpeed) : 1,
    frames,
    source: { format: 'codelab-frames', manifestPath: 'frames/frames.tscn' },
  };
  project.drawingModel ||= {};
  project.drawingModel.animationLayerMetadata = {
    format: 'pixelforge-frame-layer-metadata',
    version: 1,
    frames: frameLayerMetadata,
  };
  return { frameCount: frames.length, celCount: frames.reduce((sum, frame) => sum + frame.cels.length, 0) };
}

function installReferenceCenter(project, files, centerManifest) {
  if (!centerManifest || centerManifest.format !== 'codelab-reference-center' || Number(centerManifest.version) !== 1) {
    fail('reference.center/reference.center must declare format codelab-reference-center version 1.');
  }
  const categories = centerManifest.categories;
  if (!Array.isArray(categories)) fail('reference.center/reference.center categories must be an array.');
  const categoryIds = new Set();
  const entries = [];
  let embeddedBytes = 0;
  let referenceCount = 0;
  for (const category of categories) {
    if (!category || typeof category !== 'object') fail('reference category declaration is invalid.');
    const categoryId = requireString(category.id, 'reference category id');
    if (categoryIds.has(categoryId)) fail('duplicate reference category id: ' + categoryId);
    categoryIds.add(categoryId);
    const folder = requireSafeRelativePath(category.folder, categoryId + '.folder');
    if (!folder.startsWith('reference.')) fail('reference category folder must start with reference.: ' + folder);
    if (!Array.isArray(category.references)) fail(categoryId + '.references must be an array.');
    for (const ref of category.references) {
      if (!ref || typeof ref !== 'object') fail(categoryId + ' contains an invalid reference declaration.');
      const refPath = requireSafeRelativePath(ref.path, categoryId + '.reference.path');
      if (!refPath.startsWith(folder + '/')) fail('reference path must remain inside its declared category folder: ' + refPath);
      const definition = jsonFile(files, refPath, 'reference.json');
      const id = requireString(definition.id, 'reference.id');
      const name = requireString(definition.name, 'reference.name');
      const width = requireInt(Number(definition.width), id + '.width', 1, MAX_CANVAS);
      const height = requireInt(Number(definition.height), id + '.height', 1, MAX_CANVAS);
      const parts = definition.parts;
      if (!Array.isArray(parts) || parts.length < 1 || parts.length > MAX_REFERENCE_PARTS) {
        fail(id + '.parts must contain 1–256 editable parts.');
      }
      const seenPartIds = new Set();
      const normalizedParts = [];
      for (const part of parts) {
        if (!part || typeof part !== 'object') fail(id + ' contains an invalid part.');
        const partId = requireString(part.id, id + '.part.id');
        if (seenPartIds.has(partId)) fail(id + ' contains duplicate part ID: ' + partId);
        seenPartIds.add(partId);
        const partWidth = requireInt(Number(part.width ?? width), id + '/' + partId + '.width', 1, width);
        const partHeight = requireInt(Number(part.height ?? height), id + '/' + partId + '.height', 1, height);
        const pixels = readRgba8(files, part.pixelsPath, partWidth, partHeight, id + '/' + partId);
        embeddedBytes += pixels.length;
        if (embeddedBytes > MAX_REFERENCE_BYTES) fail('Reference Center exceeds the 16 MiB embedded RGBA8 budget.');
        normalizedParts.push({
          id: partId,
          name: String(part.name || partId),
          role: String(part.role || 'detail'),
          frameIndex: Number.isInteger(part.frameIndex) ? part.frameIndex : null,
          bounds: part.bounds ? structuredClone(part.bounds) : { x: 0, y: 0, width: partWidth, height: partHeight },
          anchors: structuredClone(part.anchors || {}),
          proportions: structuredClone(part.proportions || {}),
          colorRoles: Array.isArray(part.colorRoles) ? [...part.colorRoles] : [],
          z: Number.isFinite(Number(part.z)) ? Number(part.z) : 0,
          width: partWidth,
          height: partHeight,
          pixels: pixels.toString('base64'),
          pixelsSha256: sha256(pixels),
          editable: true,
          sourcePath: part.pixelsPath,
        });
      }
      const entry = {
        id,
        name,
        type: String(definition.type || 'drawing'),
        category: categoryId,
        categoryFolder: folder,
        version: Number(definition.version || 1),
        immutableSnapshot: true,
        editable: true,
        createdAt: definition.createdAt || new Date().toISOString(),
        sourcePath: refPath,
        sourceRevision: Number(definition.sourceRevision || 0),
        frames: Array.isArray(definition.frames) ? structuredClone(definition.frames) : [],
        parts: normalizedParts,
        geometry: structuredClone(definition.geometry || {
          canvas: { width, height },
          objectCount: normalizedParts.length,
        }),
        transform: normalizeTransform(definition.transform || {}),
        palette: structuredClone(definition.palette || project.drawingModel?.palette || {}),
        preview: definition.preview ? structuredClone(definition.preview) : null,
        notes: String(definition.notes || '').slice(0, 2000),
        materialization: {
          sourceId: id,
          sourceRevision: Number(definition.sourceRevision || 0),
          editable: true,
          copyPolicy: 'deep-copy',
        },
      };
      entries.push(entry);
      referenceCount++;
    }
  }
  const model = project.drawingModel && typeof project.drawingModel === 'object'
    ? structuredClone(project.drawingModel)
    : {};
  model.referenceCenter ||= { version: 3, entries: [], activeEntryId: null, viewContext: {} };
  model.referenceCenter.version = 3;
  model.referenceCenter.entries = Array.isArray(model.referenceCenter.entries) ? model.referenceCenter.entries.filter(entry => !entry?.sourcePath) : [];
  model.referenceCenter.entries.push(...entries);
  model.referenceCenter.activeEntryId = entries.at(-1)?.id ?? model.referenceCenter.activeEntryId ?? null;
  project.drawingModel = model;
  return { referenceCount, embeddedReferenceBytes: embeddedBytes, categories: [...categoryIds] };
}

function validateIntegrityManifest(files, integrity) {
  if (!integrity || integrity.format !== 'codelab-integrity' || Number(integrity.version) !== 1 ||
      !integrity.files || typeof integrity.files !== 'object' || Array.isArray(integrity.files)) {
    fail('integrity.json must declare format codelab-integrity version 1 and a files map.');
  }
  for (const [filePath, declaration] of Object.entries(integrity.files)) {
    const safePath = requireSafeRelativePath(filePath, 'integrity file path');
    const bytes = files.get(safePath);
    if (!bytes) fail('integrity.json references a missing file: ' + safePath);
    if (!declaration || declaration.sha256 !== sha256(bytes) || Number(declaration.byteSize) !== bytes.length) {
      fail('integrity verification failed for ' + safePath + '.');
    }
  }
  return Object.keys(integrity.files).length;
}

export function installStructuredCodeLabV2({ project, files, manifest }) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) fail('project.json is invalid.');
  if (!manifest || Number(manifest.version) !== 2 || Number(manifest.schemaVersion) !== 2 || manifest.layout !== 'structured') {
    fail('manifest must declare codelab version 2, schemaVersion 2 and layout structured.');
  }
  const editor = String(manifest.editor || '');
  if (!['web', 'design', 'pixelforge'].includes(editor)) fail('structured .codelab requires a supported editor.');
  if (manifest.projectType !== editor) fail('manifest.projectType must match manifest.editor.');
  if (!project.id || !project.name) fail('structured project must declare project.id and project.name.');
  if (!manifest.integrityPath) fail('structured manifest must declare integrityPath.');
  const integrityPath = requireSafeRelativePath(manifest.integrityPath, 'manifest.integrityPath');
  const integrityEntries = validateIntegrityManifest(files, jsonFile(files, integrityPath, 'integrity manifest'));
  const result = {
    integrityEntries,
    frames: { frameCount: 0, celCount: 0 },
    references: { referenceCount: 0, embeddedReferenceBytes: 0, categories: [] },
    scenes: {},
  };

  // The Web and Design editors store their native document in project.json.
  // Frame cels and Reference Center are PixelForge-specific package sections.
  if (editor === 'pixelforge') {
    if (manifest.frames?.manifestPath) {
      const frameManifestPath = requireSafeRelativePath(manifest.frames.manifestPath, 'manifest.frames.manifestPath');
      result.frames = installStructuredFrames(project, files, jsonFile(files, frameManifestPath, 'frames manifest'));
    } else {
      fail('PixelForge structured manifest must declare frames.manifestPath.');
    }
    if (manifest.scenes) result.scenes = installSceneSections(project, files, manifest.scenes);
    if (manifest.referenceCenter?.manifestPath) {
      const centerManifestPath = requireSafeRelativePath(manifest.referenceCenter.manifestPath, 'manifest.referenceCenter.manifestPath');
      result.references = installReferenceCenter(project, files, jsonFile(files, centerManifestPath, 'reference center manifest'));
    } else {
      fail('PixelForge structured manifest must declare referenceCenter.manifestPath.');
    }
  }

  project.codelabSchema = {
    version: 2,
    layout: 'structured',
    editor,
    framesManifest: manifest.frames?.manifestPath || null,
    referenceCenterManifest: manifest.referenceCenter?.manifestPath || null,
    sceneManifestVersion: manifest.scenes?.version || null,
    integrityPath,
  };
  return result;
}
