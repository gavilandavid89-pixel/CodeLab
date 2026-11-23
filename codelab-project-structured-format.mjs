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
    for (const layer of layers) {
      if (!layer || typeof layer !== 'object') fail(frameId + ' contains an invalid layer declaration.');
      const layerId = requireString(layer.id, frameId + '.layer.id');
      if (!layerIds.includes(layerId) || seenLayers.has(layerId)) fail(frameId + ' contains an unknown or duplicate layer ID: ' + layerId);
      seenLayers.add(layerId);
      const pixels = readRgba8(files, layer.pixelsPath, width, height, frameId + '/' + layerId);
      totalBytes += pixels.length;
      if (totalBytes > 64 * 1024 * 1024) fail('structured animation exceeds the 64 MiB RGBA8 pixel-memory budget.');
      cels.push({
        layerId,
        pixels: pixels.toString('base64'),
        metadata: {
          name: String(layer.name || ''),
          position: { x: requireFinite(layer.position?.x ?? 0, frameId + '/' + layerId + '.position.x'), y: requireFinite(layer.position?.y ?? 0, frameId + '/' + layerId + '.position.y') },
          opacity: requireFinite(layer.opacity ?? 1, frameId + '/' + layerId + '.opacity'),
          visible: layer.visible !== false,
          locked: layer.locked === true,
          zIndex: Number.isFinite(Number(layer.zIndex)) ? Number(layer.zIndex) : 0,
          pixelsSha256: sha256(pixels),
        },
      });
    }
    if (seenLayers.size !== layerIds.length) fail(frameId + ' does not provide every project layer.');
    frames.push({
      id: frameId,
      name: String(frame.name || frameId),
      index: frameIndex,
      durationMs,
      cels,
      layerCount: cels.length,
      sourcePath: framePath,
    });
  }
  project.animation = {
    format: 'pixelforge-animation',
    version: 2,
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
  return { frameCount: frames.length, celCount: frames.reduce((sum, frame) => sum + frame.cels.length, 0) };
}

function installReferenceCenter(project, files, centerManifest) {
  if (!centerManifest || centerManifest.format !== 'codelab-reference-center' || Number(centerManifest.version) !== 1) {
    fail('center.op/center.json must declare format codelab-reference-center version 1.');
  }
  const categories = centerManifest.categories;
  if (!Array.isArray(categories)) fail('center.op/center.json categories must be an array.');
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
  if (!['web', 'design', 'pixelforge'].includes(String(manifest.editor))) fail('structured .codelab requires a supported editor.');
  if (!project.id || !project.name) fail('structured project must declare project.id and project.name.');
  if (!manifest.integrityPath) fail('structured manifest must declare integrityPath.');
  const integrityPath = requireSafeRelativePath(manifest.integrityPath, 'manifest.integrityPath');
  const integrityEntries = validateIntegrityManifest(files, jsonFile(files, integrityPath, 'integrity manifest'));
  const result = {
    integrityEntries,
    frames: { frameCount: 0, celCount: 0 },
    references: { referenceCount: 0, embeddedReferenceBytes: 0, categories: [] },
  };
  if (manifest.frames?.manifestPath) {
    const frameManifestPath = requireSafeRelativePath(manifest.frames.manifestPath, 'manifest.frames.manifestPath');
    result.frames = installStructuredFrames(project, files, jsonFile(files, frameManifestPath, 'frames manifest'));
  } else {
    fail('structured manifest must declare frames.manifestPath.');
  }
  if (manifest.referenceCenter?.manifestPath) {
    const centerManifestPath = requireSafeRelativePath(manifest.referenceCenter.manifestPath, 'manifest.referenceCenter.manifestPath');
    result.references = installReferenceCenter(project, files, jsonFile(files, centerManifestPath, 'reference center manifest'));
  } else {
    fail('structured manifest must declare referenceCenter.manifestPath.');
  }
  project.codelabSchema = {
    version: 2,
    layout: 'structured',
    framesManifest: manifest.frames.manifestPath,
    referenceCenterManifest: manifest.referenceCenter.manifestPath,
  };
  return result;
}
