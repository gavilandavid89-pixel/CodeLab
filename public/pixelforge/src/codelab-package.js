import { createZipBlob } from './zip-export.js';
import { readStoredZip } from './video-composer-core.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_PACKAGE_BYTES = 100 * 1024 * 1024;
const MAX_FRAMES = 240;
const MAX_LAYERS = 64;
const MAX_CANVAS = 4096;
const MAX_REFERENCE_PARTS = 256;
const MAX_REFERENCE_BYTES = 16 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 32 * 1024 * 1024;

const SCENE_SECTIONS = [
  { key: 'environment', folder: 'Entorno', filename: 'entorno.tscn', role: 'environment' },
  { key: 'effects', folder: 'Efectos', filename: 'efectos.tscn', role: 'effect' },
  { key: 'details', folder: 'Detalles', filename: 'detalles.tscn', role: 'detail' },
  { key: 'elements', folder: 'Elementos', filename: 'elementos.tscn', role: 'element' },
  { key: 'objects', folder: 'Objetos', filename: 'objetos.tscn', role: 'object' },
];

const safeSlug = (value, fallback = 'item') =>
  String(value || fallback).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72) || fallback;

function safePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') &&
    !value.includes('\\') && !value.includes('\0') &&
    !value.split('/').some(part => !part || part === '.' || part === '..');
}

function bytesFromBase64(value, expectedBytes, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new TypeError(label + ' must be base64 data.');
  }
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  if (expectedBytes !== undefined && bytes.length !== expectedBytes) {
    throw new RangeError(label + ' must contain exactly ' + expectedBytes + ' bytes.');
  }
  return bytes;
}

function base64FromBytes(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
  }
  return btoa(binary);
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function jsonBytes(value) { return encoder.encode(JSON.stringify(value, null, 2)); }
function jsonFromBytes(bytes, label) {
  try { return JSON.parse(decoder.decode(bytes)); }
  catch { throw new TypeError(label + ' is not valid JSON.'); }
}

function referenceFolder(category) {
  const aliases = {
    character: 'personaje', characters: 'personaje', personaje: 'personaje',
    scene: 'escena', scenes: 'escena', environment: 'escena', entorno: 'escena', escena: 'escena',
    object: 'objeto', objects: 'objeto', prop: 'objeto', objeto: 'objeto',
    effect: 'efecto', effects: 'efecto', efecto: 'efecto',
    detail: 'detalle', details: 'detalle', detalle: 'detalle',
    element: 'elemento', elements: 'elemento', elemento: 'elemento',
    part: 'parte', parts: 'parte', parte: 'parte',
  };
  return aliases[String(category || 'object').toLowerCase()] || safeSlug(category, 'objeto');
}

function explicitSectionMatch(item, key) {
  return [item?.sceneSection, item?.category, item?.role]
    .some(value => String(value || '').toLowerCase() === key);
}

function buildSceneSections(project, files) {
  const drawing = project.drawingModel || {};
  const layerRoles = drawing.layerRoles || {};
  const sections = {};
  for (const section of SCENE_SECTIONS) {
    const path = section.folder + '/' + section.filename;
    const layerIds = (project.layers || [])
      .filter(layer => String(layerRoles[layer.id]?.role || '').toLowerCase() === section.role)
      .map(layer => String(layer.id));
    const drawingObjectIds = (drawing.objects || [])
      .filter(item => explicitSectionMatch(item, section.key)).map(item => String(item.id));
    const vectorObjectIds = (project.vectorModel?.objects || [])
      .filter(item => explicitSectionMatch(item, section.key)).map(item => String(item.id));
    const data = drawing.sceneSections?.[section.key] && typeof drawing.sceneSections[section.key] === 'object'
      ? structuredClone(drawing.sceneSections[section.key]) : {};
    files.set(path, jsonBytes({
      format: 'codelab-pixelforge-scene',
      version: 1,
      sceneType: section.key,
      projectId: String(project.id),
      canvas: { width: project.width, height: project.height },
      layerIds,
      drawingObjectIds,
      vectorObjectIds,
      ...(section.key === 'environment'
        ? { environmentHistory: structuredClone(drawing.environmentHistory || { version: 1, entries: [], activeEntryId: null }) }
        : {}),
      data,
    }));
    sections[section.key] = { manifestPath: path };
  }
  return { format: 'codelab-pixelforge-scenes', version: 1, sections };
}

function addReferenceCenter(project, files) {
  const entries = project.drawingModel?.referenceCenter?.entries || [];
  const categories = new Map();
  let totalBytes = 0;
  for (const entry of entries) {
    const categoryId = safeSlug(entry.category, 'object');
    const folder = 'reference.' + referenceFolder(entry.category);
    if (!categories.has(categoryId)) categories.set(categoryId, { id: categoryId, folder, references: [] });
    const referenceId = safeSlug(entry.id, 'reference');
    const referenceDirectory = folder + '/' + safeSlug(entry.name, 'reference') + '-' + referenceId;
    const referencePath = referenceDirectory + '/reference.json';
    const width = Number(entry.geometry?.canvas?.width || project.width);
    const height = Number(entry.geometry?.canvas?.height || project.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_CANVAS || height > MAX_CANVAS) {
      throw new RangeError('Reference ' + entry.name + ' has invalid canvas dimensions.');
    }
    const snapshot = new Map((entry.layerSnapshot || []).map(layer => [String(layer.id), layer]));
    const parts = Array.isArray(entry.parts) ? entry.parts : [];
    if (!parts.length) throw new TypeError('Reference ' + entry.name + ' has no editable RGBA parts; it cannot be exported without losing editability.');
    if (parts.length > MAX_REFERENCE_PARTS) throw new RangeError('Reference ' + entry.name + ' exceeds 256 parts.');
    const normalizedParts = parts.map((part, index) => {
      const partId = safeSlug(part.id, 'part-' + (index + 1));
      const partWidth = Number(part.width || width);
      const partHeight = Number(part.height || height);
      const pixels = bytesFromBase64(part.pixels || snapshot.get(String(part.layerId))?.pixels,
        partWidth * partHeight * 4, 'Reference ' + entry.name + '/' + part.name);
      totalBytes += pixels.length;
      if (totalBytes > MAX_REFERENCE_BYTES) throw new RangeError('Reference Center exceeds the 16 MiB RGBA8 budget.');
      const pixelsPath = referenceDirectory + '/parts/' + partId + '.rgba';
      files.set(pixelsPath, pixels);
      const { pixels: ignoredPixels, ...metadata } = part;
      return {
        ...metadata,
        id: part.id || partId,
        name: part.name || partId,
        role: part.role || 'detail',
        width: partWidth,
        height: partHeight,
        pixelsPath,
      };
    });
    const { imageDataUrl, layerSnapshot, frameLayerMap, ...metadata } = entry;
    files.set(referencePath, jsonBytes({
      ...metadata,
      id: entry.id || referenceId,
      name: entry.name || 'Reference',
      width, height, parts: normalizedParts,
    }));
    categories.get(categoryId).references.push({ path: referencePath });
  }
  return { format: 'codelab-reference-center', version: 1, categories: [...categories.values()] };
}

function addFrames(project, files) {
  if (!Array.isArray(project.layers) || project.layers.length < 1 || project.layers.length > MAX_LAYERS) {
    throw new RangeError('PixelForge project must contain 1–64 layers.');
  }
  const animation = project.animation;
  const sourceFrames = animation?.frames?.length ? animation.frames : [{
    id: 'frame-still', name: 'Frame 1', durationMs: 1000,
    cels: project.layers.map(layer => ({ layerId: layer.id, pixels: layer.pixels })),
  }];
  if (sourceFrames.length > MAX_FRAMES) throw new RangeError('PixelForge supports at most 240 frames per project package.');
  const frameRefs = [];
  let totalBytes = 0;
  for (let index = 0; index < sourceFrames.length; index++) {
    const frame = sourceFrames[index];
    const cels = Array.isArray(frame.cels) ? frame.cels : [];
    const celMap = new Map(cels.map(cel => [String(cel.layerId), cel]));
    if (cels.length !== project.layers.length || celMap.size !== cels.length ||
        project.layers.some(layer => !celMap.has(String(layer.id)))) {
      throw new TypeError('Frame ' + (index + 1) + ' must contain exactly one cel for every project layer.');
    }
    const directory = 'Frames/frame-' + String(index + 1).padStart(4, '0');
    const layers = [];
    for (let layerIndex = 0; layerIndex < project.layers.length; layerIndex++) {
      const layer = project.layers[layerIndex];
      const cel = celMap.get(String(layer.id));
      const pixels = bytesFromBase64(cel.pixels, project.width * project.height * 4,
        'Frame ' + (index + 1) + '/' + layer.id);
      totalBytes += pixels.length;
      if (totalBytes > 64 * 1024 * 1024) throw new RangeError('Animation exceeds the 64 MiB RGBA8 budget.');
      const pixelsPath = directory + '/' + safeSlug(layer.name, layer.id) + '-' + safeSlug(layer.id, 'layer') + '.rgba';
      files.set(pixelsPath, pixels);
      layers.push({
        id: String(layer.id),
        name: String(layer.name || layer.id),
        pixelsPath,
        position: { x: Number(layer.x || 0), y: Number(layer.y || 0) },
        opacity: Number(layer.opacity ?? 1),
        visible: layer.visible !== false,
        locked: layer.locked === true,
        zIndex: layerIndex,
      });
    }
    const framePath = directory + '/frame.json';
    files.set(framePath, jsonBytes({
      id: String(frame.id || 'frame-' + (index + 1)),
      name: String(frame.name || 'Frame ' + (index + 1)),
      index,
      width: project.width,
      height: project.height,
      durationMs: Math.round(Math.max(1, Math.min(10000, Number(frame.durationMs || 1000)))),
      layerCount: layers.length,
      layers,
    }));
    frameRefs.push({ path: framePath });
  }
  const manifest = {
    format: 'codelab-frames',
    version: 1,
    canvas: { width: project.width, height: project.height },
    fps: Number.isInteger(animation?.fps) ? Math.max(1, Math.min(60, animation.fps)) : 12,
    activeFrameIndex: Math.max(0, Math.min(sourceFrames.length - 1, Number(animation?.activeFrameIndex || 0))),
    loop: animation?.loop !== false,
    playbackSpeed: Number.isFinite(Number(animation?.playbackSpeed)) ? Number(animation.playbackSpeed) : 1,
    frames: frameRefs,
  };
  files.set('Frames/frames.tscn', jsonBytes(manifest));
  return manifest;
}

function inferResourceDestination(path) {
  const folder = String(path).split('/')[0].toLowerCase();
  const folders = {
    entorno: 'environment', environment: 'environment',
    efectos: 'effects', effects: 'effects',
    detalles: 'details', details: 'details',
    elementos: 'elements', elements: 'elements',
    objetos: 'objects', objects: 'objects',
    frames: 'frames',
    assets: 'assets', fonts: 'fonts', audio: 'audio', video: 'video',
    models: 'models', textures: 'textures', documents: 'documents',
  };
  if (folders[folder]) return folders[folder];
  if (folder.startsWith('reference.')) return 'reference-center';
  const extension = path.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(extension)) return 'assets';
  if (['.ttf', '.otf', '.woff', '.woff2'].includes(extension)) return 'fonts';
  if (['.mp3', '.wav', '.ogg', '.flac'].includes(extension)) return 'audio';
  if (['.mp4', '.webm', '.mov'].includes(extension)) return 'video';
  return 'project-files';
}

function addResources(project, files, resources) {
  const provided = [...(project.packageResourceFiles || []), ...(resources || [])];
  const declared = new Map();
  for (const resource of provided) {
    if (!resource || !safePath(resource.path) || files.has(resource.path) || declared.has(resource.path)) {
      throw new TypeError('Resource path is unsafe or duplicated: ' + String(resource?.path || ''));
    }
    const bytes = resource.bytes instanceof Uint8Array
      ? resource.bytes
      : resource.bytes instanceof ArrayBuffer
        ? new Uint8Array(resource.bytes)
        : resource.base64
          ? bytesFromBase64(resource.base64, undefined, resource.path)
          : null;
    if (!bytes || !bytes.length) throw new TypeError('Resource bytes are missing: ' + resource.path);
    if (bytes.length > MAX_RESOURCE_BYTES) throw new RangeError('Resource exceeds the 32 MiB per-file limit: ' + resource.path);
    files.set(resource.path, bytes);
    declared.set(resource.path, {
      path: resource.path,
      destination: String(resource.destination || inferResourceDestination(resource.path)),
      contentType: String(resource.contentType || 'application/octet-stream'),
    });
  }
  const declaredMetadata = Array.isArray(project.packageResources) ? project.packageResources : [];
  for (const item of declaredMetadata) {
    if (!declared.has(item.path)) throw new Error('Project resource is missing its stored bytes: ' + item.path);
  }
  return [...declared.values()];
}

export async function exportPixelForgeCodeLabPackage(projectSnapshot, { resources = [] } = {}) {
  if (!projectSnapshot || projectSnapshot.format !== 'pixelforge-project' ||
      !projectSnapshot.id || !projectSnapshot.name ||
      !Number.isInteger(projectSnapshot.width) || !Number.isInteger(projectSnapshot.height) ||
      projectSnapshot.width < 1 || projectSnapshot.height < 1 ||
      projectSnapshot.width > MAX_CANVAS || projectSnapshot.height > MAX_CANVAS) {
    throw new TypeError('A valid native PixelForge project snapshot is required.');
  }
  const project = structuredClone(projectSnapshot);
  const files = new Map();
  const frames = addFrames(project, files);
  const scenes = buildSceneSections(project, files);
  const referenceCenter = addReferenceCenter(project, files);
  const resourceDeclarations = addResources(project, files, resources);

  delete project.animation;
  delete project.packageResourceFiles;
  if (project.drawingModel?.referenceCenter) {
    project.drawingModel.referenceCenter.entries = project.drawingModel.referenceCenter.entries
      .filter(entry => !Array.isArray(entry?.parts) || entry.parts.length === 0);
  }
  files.set('project.json', jsonBytes(project));
  files.set('center.op/center.json', jsonBytes(referenceCenter));

  const manifest = {
    format: 'codelab',
    version: 2,
    schemaVersion: 2,
    layout: 'structured',
    editor: 'pixelforge',
    projectType: 'pixelforge',
    entry: 'project.json',
    integrityPath: 'integrity.json',
    frames: { manifestPath: 'Frames/frames.tscn' },
    scenes,
    referenceCenter: { manifestPath: 'center.op/center.json' },
    resources: resourceDeclarations,
  };
  files.set('manifest.json', jsonBytes(manifest));
  files.set('project.codelab-pixelforge', new Uint8Array());
  const integrity = { format: 'codelab-integrity', version: 1, files: {} };
  for (const [path, bytes] of files) {
    if (['manifest.json', 'project.json', 'project.codelab-pixelforge'].includes(path)) continue;
    integrity.files[path] = { sha256: await sha256(bytes), byteSize: bytes.byteLength };
  }
  files.set('integrity.json', jsonBytes(integrity));

  const entries = [...files].map(([name, data]) => ({ name, data }));
  const archive = await createZipBlob(entries);
  if (archive.size > MAX_PACKAGE_BYTES) throw new RangeError('PixelForge CodeLab package exceeds the 100 MiB limit.');
  return {
    blob: archive,
    filename: safeSlug(project.name, 'pixelforge-project') + '.codelab-pixelforge',
    metadata: {
      format: 'codelab', version: 2, editor: 'pixelforge',
      projectId: project.id, projectName: project.name,
      width: project.width, height: project.height,
      layerCount: project.layers.length, frameCount: frames.frames.length,
      referenceCount: referenceCenter.categories.reduce((sum, item) => sum + item.references.length, 0),
      resourceCount: resourceDeclarations.length, sceneSectionCount: Object.keys(scenes.sections).length,
      entryCount: entries.length,
    },
  };
}

async function readBytes(entries, path, label = path) {
  if (!safePath(path)) throw new TypeError(label + ' path is unsafe.');
  const entry = entries.get(path);
  if (!entry) throw new Error(label + ' is missing: ' + path);
  return new Uint8Array(await entry.blob.arrayBuffer());
}

async function readJson(entries, path, label) {
  return jsonFromBytes(await readBytes(entries, path, label), label);
}

function validateIds(ids, allowed, label) {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !allowed.has(id)) ||
      new Set(ids).size !== ids.length) throw new TypeError(label + ' contains unknown or duplicate IDs.');
}

export async function importPixelForgeCodeLabPackage(file) {
  if (!file || !Number.isFinite(file.size) || file.size < 1 || file.size > 256 * 1024 * 1024) {
    throw new RangeError('CodeLab package must be between 1 byte and 256 MiB.');
  }
  const entries = await readStoredZip(file);
  if (!entries.has('project.codelab-pixelforge') && !entries.has('project.codelab')) {
    throw new TypeError('ZIP root marker project.codelab-pixelforge is missing.');
  }
  const manifest = await readJson(entries, 'manifest.json', 'manifest.json');
  if (Number(manifest.version) !== 2 || Number(manifest.schemaVersion) !== 2 ||
      manifest.layout !== 'structured' || manifest.editor !== 'pixelforge' ||
      manifest.projectType !== 'pixelforge') {
    throw new TypeError('ZIP is not a structured CodeLab v2 PixelForge project.');
  }
  const project = await readJson(entries, manifest.entry || 'project.json', 'project.json');
  if (project.format !== 'pixelforge-project' || !Array.isArray(project.layers) ||
      project.layers.length < 1 || project.layers.length > MAX_LAYERS ||
      !Number.isInteger(project.width) || !Number.isInteger(project.height) ||
      project.width < 1 || project.height < 1 || project.width > MAX_CANVAS || project.height > MAX_CANVAS) {
    throw new TypeError('project.json is not a valid native PixelForge document.');
  }

  const integrityPath = manifest.integrityPath || 'integrity.json';
  const integrity = await readJson(entries, integrityPath, 'integrity.json');
  if (integrity.format !== 'codelab-integrity' || Number(integrity.version) !== 1 ||
      !integrity.files || typeof integrity.files !== 'object' || Array.isArray(integrity.files)) {
    throw new TypeError('integrity.json is invalid.');
  }
  for (const [path, declaration] of Object.entries(integrity.files)) {
    const bytes = await readBytes(entries, path, 'integrity entry');
    if (declaration.sha256 !== await sha256(bytes) || Number(declaration.byteSize) !== bytes.byteLength) {
      throw new Error('Integrity verification failed for ' + path + '.');
    }
  }

  const framesPath = manifest.frames?.manifestPath;
  if (!framesPath) throw new TypeError('manifest.frames.manifestPath is required.');
  const frameManifest = await readJson(entries, framesPath, 'Frames/frames.tscn');
  if (frameManifest.format !== 'codelab-frames' || Number(frameManifest.version) !== 1 ||
      Number(frameManifest.canvas?.width) !== project.width || Number(frameManifest.canvas?.height) !== project.height ||
      !Array.isArray(frameManifest.frames) || frameManifest.frames.length < 1 || frameManifest.frames.length > MAX_FRAMES) {
    throw new TypeError('Frames/frames.tscn is invalid or does not match the canvas.');
  }
  const layerIds = project.layers.map(layer => String(layer.id));
  if (new Set(layerIds).size !== layerIds.length) throw new TypeError('project.json contains duplicate layer IDs.');
  const animationFrames = [];
  const frameMetadata = [];
  let totalFrameBytes = 0;
  for (let index = 0; index < frameManifest.frames.length; index++) {
    const frameRef = frameManifest.frames[index];
    const frame = await readJson(entries, frameRef.path, 'frame definition');
    if (Number(frame.index) !== index || Number(frame.width) !== project.width || Number(frame.height) !== project.height ||
        !Array.isArray(frame.layers) || frame.layers.length !== layerIds.length ||
        Number(frame.layerCount) !== layerIds.length) throw new TypeError('Frame ' + index + ' does not match the project layer stack.');
    const cels = [];
    const metadata = [];
    const seen = new Set();
    for (const layer of frame.layers) {
      const id = String(layer.id);
      if (!layerIds.includes(id) || seen.has(id)) throw new TypeError('Frame contains an unknown or duplicate layer ID: ' + id);
      seen.add(id);
      const bytes = await readBytes(entries, layer.pixelsPath, 'frame cel');
      if (bytes.length !== project.width * project.height * 4) throw new RangeError('Frame cel RGBA8 byte length is invalid.');
      totalFrameBytes += bytes.length;
      if (totalFrameBytes > 64 * 1024 * 1024) throw new RangeError('Animation exceeds the 64 MiB RGBA8 budget.');
      cels.push({ layerId: id, pixels: base64FromBytes(bytes) });
      metadata.push({
        layerId: id, name: String(layer.name || id),
        position: { x: Number(layer.position?.x || 0), y: Number(layer.position?.y || 0) },
        opacity: Number(layer.opacity ?? 1), visible: layer.visible !== false,
        locked: layer.locked === true, zIndex: Number(layer.zIndex ?? 0),
        pixelsSha256: await sha256(bytes),
      });
    }
    if (seen.size !== layerIds.length) throw new TypeError('Frame is missing one or more project layers.');
    animationFrames.push({
      id: String(frame.id), name: String(frame.name || frame.id), index,
      durationMs: Number(frame.durationMs), cels, layerCount: cels.length, sourcePath: frameRef.path,
    });
    frameMetadata.push({ id: String(frame.id), index, layers: metadata });
  }
  const fps = Number(frameManifest.fps ?? 12);
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw new RangeError('Animation FPS must be 1–60.');
  const activeFrameIndex = Number(frameManifest.activeFrameIndex ?? 0);
  if (!Number.isInteger(activeFrameIndex) || activeFrameIndex < 0 || activeFrameIndex >= animationFrames.length) {
    throw new RangeError('Animation activeFrameIndex is invalid.');
  }
  project.animation = {
    format: 'pixelforge-animation', version: 1,
    width: project.width, height: project.height, layerIds, fps, activeFrameIndex,
    loop: frameManifest.loop !== false,
    playbackSpeed: Number(frameManifest.playbackSpeed ?? 1),
    frames: animationFrames,
    source: { format: 'codelab-frames', manifestPath: framesPath },
  };
  project.drawingModel ||= {};
  project.drawingModel.animationLayerMetadata = {
    format: 'pixelforge-frame-layer-metadata', version: 1, frames: frameMetadata,
  };

  const centerPath = manifest.referenceCenter?.manifestPath;
  if (!centerPath) throw new TypeError('manifest.referenceCenter.manifestPath is required.');
  const center = await readJson(entries, centerPath, 'center.op/center.json');
  if (center.format !== 'codelab-reference-center' || Number(center.version) !== 1 || !Array.isArray(center.categories)) {
    throw new TypeError('center.op/center.json is invalid.');
  }
  const referenceEntries = [];
  let referenceBytes = 0;
  const categoryIds = new Set();
  for (const category of center.categories) {
    if (!category || typeof category.id !== 'string' || !safePath(category.folder) ||
        !category.folder.startsWith('reference.') || categoryIds.has(category.id) || !Array.isArray(category.references)) {
      throw new TypeError('Reference Center category declaration is invalid.');
    }
    categoryIds.add(category.id);
    for (const ref of category.references) {
      if (!ref || !safePath(ref.path) || !ref.path.startsWith(category.folder + '/')) throw new TypeError('Reference path escapes its category folder.');
      const definition = await readJson(entries, ref.path, 'reference.json');
      if (!Array.isArray(definition.parts) || definition.parts.length < 1 || definition.parts.length > MAX_REFERENCE_PARTS) {
        throw new TypeError('Reference ' + definition.id + ' must contain 1–256 editable parts.');
      }
      const parts = [];
      for (const part of definition.parts) {
        const width = Number(part.width ?? definition.width), height = Number(part.height ?? definition.height);
        const bytes = await readBytes(entries, part.pixelsPath, 'reference part');
        if (bytes.length !== width * height * 4) throw new RangeError('Reference part RGBA8 byte length is invalid.');
        referenceBytes += bytes.length;
        if (referenceBytes > MAX_REFERENCE_BYTES) throw new RangeError('Reference Center exceeds 16 MiB.');
        parts.push({ ...part, width, height, pixels: base64FromBytes(bytes), pixelsSha256: await sha256(bytes), editable: true });
      }
      referenceEntries.push({
        ...definition, category: category.id, categoryFolder: category.folder,
        parts, immutableSnapshot: true, editable: true, sourcePath: ref.path,
        materialization: { sourceId: definition.id, sourceRevision: Number(definition.sourceRevision || 0), editable: true, copyPolicy: 'deep-copy' },
      });
    }
  }
  project.drawingModel.referenceCenter ||= { version: 3, entries: [], activeEntryId: null, viewContext: {} };
  project.drawingModel.referenceCenter.version = 3;
  project.drawingModel.referenceCenter.entries = [
    ...(project.drawingModel.referenceCenter.entries || []).filter(entry => !entry?.sourcePath),
    ...referenceEntries,
  ];
  if (referenceEntries.length) project.drawingModel.referenceCenter.activeEntryId = referenceEntries.at(-1).id;

  const sceneResult = {};
  if (manifest.scenes) {
    if (manifest.scenes.format !== 'codelab-pixelforge-scenes' || Number(manifest.scenes.version) !== 1) {
      throw new TypeError('manifest.scenes is invalid.');
    }
    const drawingObjects = new Set((project.drawingModel.objects || []).map(item => String(item.id)));
    const vectorObjects = new Set((project.vectorModel?.objects || []).map(item => String(item.id)));
    const availableLayers = new Set(layerIds);
    project.drawingModel.sceneSections ||= {};
    for (const section of SCENE_SECTIONS) {
      const path = manifest.scenes.sections?.[section.key]?.manifestPath;
      if (path !== section.folder + '/' + section.filename) throw new TypeError('Scene manifest path is not canonical for ' + section.key + '.');
      const scene = await readJson(entries, path, section.filename);
      if (scene.format !== 'codelab-pixelforge-scene' || Number(scene.version) !== 1 ||
          scene.sceneType !== section.key || String(scene.projectId) !== String(project.id) ||
          Number(scene.canvas?.width) !== project.width || Number(scene.canvas?.height) !== project.height) {
        throw new TypeError(path + ' does not match this project.');
      }
      validateIds(scene.layerIds || [], availableLayers, path + '.layerIds');
      validateIds(scene.drawingObjectIds || [], drawingObjects, path + '.drawingObjectIds');
      validateIds(scene.vectorObjectIds || [], vectorObjects, path + '.vectorObjectIds');
      if (!scene.data || typeof scene.data !== 'object' || Array.isArray(scene.data)) throw new TypeError(path + '.data must be an object.');
      project.drawingModel.sceneSections[section.key] = scene.data;
      if (section.key === 'environment' && scene.environmentHistory) {
        project.drawingModel.environmentHistory = scene.environmentHistory;
      }
      sceneResult[section.key] = { path, layerCount: scene.layerIds.length, drawingObjectCount: scene.drawingObjectIds.length, vectorObjectCount: scene.vectorObjectIds.length };
    }
  }

  const resources = [];
  let resourceBytes = 0;
  for (const declaration of manifest.resources || []) {
    if (!declaration || !safePath(declaration.path)) throw new TypeError('manifest.resources contains an unsafe path.');
    const bytes = await readBytes(entries, declaration.path, 'declared resource');
    resourceBytes += bytes.length;
    if (resourceBytes > MAX_RESOURCE_BYTES) throw new RangeError('Package resources exceed the 32 MiB aggregate limit.');
    resources.push({
      path: declaration.path,
      destination: String(declaration.destination || 'project-files'),
      contentType: String(declaration.contentType || 'application/octet-stream'),
      base64: base64FromBytes(bytes),
    });
  }
  project.packageResourceFiles = resources;
  project.packageResources = resources.map(item => ({
    path: item.path, destination: item.destination, destinationPath: item.path,
    contentType: item.contentType, byteSize: bytesFromBase64(item.base64).length,
  }));
  project.drawingModel.packageResources = structuredClone(project.packageResources);
  project.codelabSchema = {
    version: 2, layout: 'structured', editor: 'pixelforge',
    framesManifest: framesPath, referenceCenterManifest: centerPath,
    sceneManifestVersion: manifest.scenes?.version || null,
    integrityPath,
  };
  return {
    project, manifest, metadata: {
      frameCount: animationFrames.length, referenceCount: referenceEntries.length,
      resourceCount: resources.length, sceneSectionCount: Object.keys(sceneResult).length,
      scenes: sceneResult,
    },
  };
}
