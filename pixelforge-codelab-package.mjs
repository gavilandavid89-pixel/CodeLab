import { createHash } from 'node:crypto';
import { createZip } from './public/pixelforge/src/zip-export.js';
import { HeadlessEditorRuntime } from './public/pixelforge/src/headless.js';

const MAX_PACKAGE_BYTES = 100 * 1024 * 1024;
const MAX_FRAMES = 240;
const MAX_LAYERS = 64;
const MAX_REFERENCE_PARTS = 256;
const MAX_REFERENCE_BYTES = 16 * 1024 * 1024;

const safeSlug = (value, fallback = 'item') =>
  String(value || fallback).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72) || fallback;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function sortPackageEntries(entries) {
  const rank = path => {
    if (path === 'project.codelab-pixelforge') return 0;
    if (path === 'manifest.json') return 10;
    if (path === 'project.json') return 20;
    if (path === 'integrity.json') return 30;
    if (path === 'Frames/frames.tscn') return 100;
    if (path.startsWith('Frames/')) return 110;
    if (path === 'Entorno/entorno.tscn') return 200;
    if (path.startsWith('Entorno/')) return 210;
    if (path === 'Efectos/efectos.tscn') return 300;
    if (path.startsWith('Efectos/')) return 310;
    if (path === 'Detalles/detalles.tscn') return 400;
    if (path.startsWith('Detalles/')) return 410;
    if (path === 'Elementos/elementos.tscn') return 500;
    if (path.startsWith('Elementos/')) return 510;
    if (path === 'Objetos/objetos.tscn') return 600;
    if (path.startsWith('Objetos/')) return 610;
    if (path === 'reference.center/reference.center') return 700;
    if (path.startsWith('reference.')) return 710;
    return 800;
  };
  return [...entries].sort((a, b) => {
    const byRank = rank(a.name) - rank(b.name);
    return byRank || a.name.localeCompare(b.name, 'en');
  });
}

function isStructuralPackagePath(path) {
  return path === 'project.codelab-pixelforge' ||
    path === 'manifest.json' ||
    path === 'project.json' ||
    path === 'integrity.json' ||
    path === 'Frames/frames.tscn' ||
    path === 'Entorno/entorno.tscn' ||
    path === 'Efectos/efectos.tscn' ||
    path === 'Detalles/detalles.tscn' ||
    path === 'Elementos/elementos.tscn' ||
    path === 'Objetos/objetos.tscn' ||
    path === 'reference.center/reference.center' ||
    path.startsWith('reference.');
}

function safeRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') &&
    !value.includes('\\') && !value.includes('\0') &&
    !value.split('/').some(part => !part || part === '.' || part === '..');
}

function decodePixels(value, expectedBytes, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new TypeError(label + ' must be base64 RGBA8 pixels.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== expectedBytes) {
    throw new RangeError(label + ' must contain exactly ' + expectedBytes + ' RGBA8 bytes; received ' + bytes.length + '.');
  }
  return bytes;
}

function frameLayers(frame, project, frameIndex) {
  const sourceCels = Array.isArray(frame?.cels) ? frame.cels : [];
  const cels = new Map(sourceCels.map(cel => [String(cel.layerId), cel]));
  if (sourceCels.length !== project.layers.length || cels.size !== sourceCels.length ||
      sourceCels.some(cel => !project.layers.some(layer => String(layer.id) === String(cel.layerId)))) {
    throw new TypeError('Frame ' + (frameIndex + 1) + ' must contain exactly one cel for every project layer.');
  }
  return project.layers.map(layer => {
    const cel = cels.get(String(layer.id));
    const encoded = cel?.pixels ?? (frameIndex === -1 ? layer.pixels : null);
    if (typeof encoded !== 'string') {
      throw new TypeError('Frame ' + (frameIndex + 1) + ' is missing pixels for layer ' + layer.id + '.');
    }
    const pixels = decodePixels(encoded, project.width * project.height * 4, 'Frame ' + (frameIndex + 1) + '/' + layer.id);
    return { layer, pixels };
  });
}

function categoryFolder(category) {
  const aliases = {
    character: 'personaje', characters: 'personaje', personaje: 'personaje',
    scene: 'escena', scenes: 'escena', environment: 'escena', escena: 'escena',
    object: 'objeto', objects: 'objeto', prop: 'objeto', objeto: 'objeto',
    effect: 'efecto', effects: 'efecto', efecto: 'efecto',
    detail: 'detalle', details: 'detalle', detalle: 'detalle',
    element: 'elemento', elements: 'elemento', elemento: 'elemento',
    part: 'parte', parts: 'parte', parte: 'parte',
  };
  return aliases[String(category || 'object').toLowerCase()] || safeSlug(category, 'objeto');
}

function addReferenceEntries(project, files) {
  const entries = project.drawingModel?.referenceCenter?.entries || [];
  const categories = new Map();
  let embeddedBytes = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') throw new TypeError('Reference Center contains an invalid entry.');
    const categoryId = safeSlug(entry.category, 'object');
    const folder = 'reference.' + categoryFolder(entry.category);
    if (!categories.has(categoryId)) categories.set(categoryId, { id: categoryId, folder, references: [] });
    const referenceId = safeSlug(entry.id, 'reference');
    const referencePath = folder + '/' + safeSlug(entry.name, 'reference') + '-' + referenceId + '/reference.json';
    const width = Number(entry.geometry?.canvas?.width || project.width);
    const height = Number(entry.geometry?.canvas?.height || project.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096) {
      throw new RangeError('Reference ' + entry.name + ' has invalid canvas dimensions.');
    }
    const snapshot = new Map((entry.layerSnapshot || []).map(layer => [String(layer.id), layer]));
    const sourceParts = Array.isArray(entry.parts) ? entry.parts : [];
    if (!sourceParts.length) {
      throw new TypeError('Reference ' + entry.name + ' has no editable parts. Image-only references must be exported as package resources.');
    }
    if (sourceParts.length > MAX_REFERENCE_PARTS) throw new RangeError('Reference ' + entry.name + ' exceeds 256 parts.');
    const parts = sourceParts.map((part, index) => {
      const partId = safeSlug(part.id, 'part-' + (index + 1));
      const partWidth = Number(part.width || width);
      const partHeight = Number(part.height || height);
      const pixelData = part.pixels || snapshot.get(String(part.layerId))?.pixels;
      const bytes = decodePixels(pixelData, partWidth * partHeight * 4, 'Reference ' + entry.name + '/' + part.name);
      embeddedBytes += bytes.length;
      if (embeddedBytes > MAX_REFERENCE_BYTES) throw new RangeError('Reference Center exceeds the 16 MiB embedded RGBA8 budget.');
      const pixelsPath = folder + '/' + safeSlug(entry.name, 'reference') + '-' + referenceId + '/parts/' + partId + '.rgba';
      files.set(pixelsPath, bytes);
      const { pixels, ...metadata } = part;
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
    const { imageDataUrl, layerSnapshot, frameLayerMap, ...referenceMetadata } = entry;
    files.set(referencePath, Buffer.from(JSON.stringify({
      ...referenceMetadata,
      id: entry.id || referenceId,
      name: entry.name || 'Reference',
      width,
      height,
      parts,
    }, null, 2), 'utf8'));
    categories.get(categoryId).references.push({ path: referencePath });
  }
  return { format: 'codelab-reference-center', version: 1, categories: [...categories.values()] };
}

const SCENE_SECTIONS = [
  { key: 'environment', folder: 'Entorno', filename: 'entorno.tscn', role: 'environment' },
  { key: 'effects', folder: 'Efectos', filename: 'efectos.tscn', role: 'effect' },
  { key: 'details', folder: 'Detalles', filename: 'detalles.tscn', role: 'detail' },
  { key: 'elements', folder: 'Elementos', filename: 'elementos.tscn', role: 'element' },
  { key: 'objects', folder: 'Objetos', filename: 'objetos.tscn', role: 'object' },
];

function explicitSectionMatch(item, key) {
  return [item?.sceneSection, item?.category, item?.role].some(value => String(value || '').toLowerCase() === key);
}

function inferResourceDestination(path) {
  const folder = String(path).split('/')[0].toLowerCase();
  const folders = {
    entorno: 'environment', environment: 'environment',
    efectos: 'effects', effects: 'effects',
    detalles: 'details', details: 'details',
    elementos: 'elements', elements: 'elements',
    objetos: 'objects', objects: 'objects',
    frames: 'frames', assets: 'assets', fonts: 'fonts', audio: 'audio',
    video: 'video', models: 'models', textures: 'textures', documents: 'documents',
  };
  if (folders[folder]) return folders[folder];
  if (folder.startsWith('reference.')) return 'reference-center';
  const extension = String(path).toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(extension)) return 'assets';
  if (['.ttf', '.otf', '.woff', '.woff2'].includes(extension)) return 'fonts';
  if (['.mp3', '.wav', '.ogg', '.flac'].includes(extension)) return 'audio';
  if (['.mp4', '.webm', '.mov'].includes(extension)) return 'video';
  return 'project-files';
}

function addSceneSections(project, files) {
  const drawing = project.drawingModel || {};
  const layerRoles = drawing.layerRoles || {};
  const sceneDeclarations = {};
  for (const section of SCENE_SECTIONS) {
    const path = section.folder + '/' + section.filename;
    const layerIds = project.layers
      .filter(layer => String(layerRoles[layer.id]?.role || '').toLowerCase() === section.role)
      .map(layer => String(layer.id));
    const drawingObjectIds = (Array.isArray(drawing.objects) ? drawing.objects : [])
      .filter(item => explicitSectionMatch(item, section.key))
      .map(item => String(item.id));
    const vectorObjectIds = (Array.isArray(project.vectorModel?.objects) ? project.vectorModel.objects : [])
      .filter(item => explicitSectionMatch(item, section.key))
      .map(item => String(item.id));
    const sectionData = drawing.sceneSections?.[section.key] && typeof drawing.sceneSections[section.key] === 'object'
      ? structuredClone(drawing.sceneSections[section.key]) : {};
    let workspace = sectionData.workspace ?? null;
    if (workspace !== null) {
      HeadlessEditorRuntime.fromJSON(workspace);
      workspace = structuredClone(workspace);
      if (!workspace.animation) {
        workspace.animation = {
          format: 'pixelforge-animation', version: 1,
          width: workspace.width, height: workspace.height,
          layerIds: workspace.layers.map(layer => String(layer.id)),
          fps: 12, activeFrameIndex: 0, loop: true, playbackSpeed: 1,
          frames: [{
            id: 'scene-' + section.key + '-frame-0001',
            name: 'Frame 1', index: 0, durationMs: 1000,
            cels: workspace.layers.map(layer => ({ layerId: String(layer.id), pixels: layer.pixels })),
          }],
        };
      }
    }
    delete sectionData.workspace;
    const declaration = {
      format: 'codelab-pixelforge-scene',
      version: 2,
      sceneType: section.key,
      projectId: String(project.id),
      canvas: { width: workspace?.width ?? project.width, height: workspace?.height ?? project.height },
      workspace,
      environmentHistory: section.key === 'environment'
        ? structuredClone(drawing.environmentHistory || { version: 1, entries: [], activeEntryId: null })
        : undefined,
      data: sectionData,
    };
    files.set(path, Buffer.from(JSON.stringify(declaration, null, 2), 'utf8'));
    sceneDeclarations[section.key] = { manifestPath: path };
  }
  return {
    format: 'codelab-pixelforge-scenes',
    version: 1,
    sections: sceneDeclarations,
  };
}

function addAnimation(project, files) {
  const source = project.animation;
  const frames = source?.frames?.length
    ? source.frames
    : [{ id: 'frame-still', durationMs: 1000, cels: project.layers.map(layer => ({ layerId: layer.id, pixels: layer.pixels })) }];
  if (frames.length > MAX_FRAMES) throw new RangeError('PixelForge structured packages support at most 240 frames.');
  if (!Array.isArray(project.layers) || !project.layers.length || project.layers.length > MAX_LAYERS) {
    throw new RangeError('PixelForge project must contain 1–64 layers.');
  }
  const frameRefs = [];
  let totalBytes = 0;
  frames.forEach((frame, index) => {
    const directory = 'Frames/frame-' + String(index + 1).padStart(4, '0');
    const layers = frameLayers(frame, project, source?.frames?.length ? index : -1);
    const frameLayersMetadata = layers.map(({ layer, pixels }, layerIndex) => {
      totalBytes += pixels.length;
      if (totalBytes > 64 * 1024 * 1024) throw new RangeError('PixelForge animation exceeds the 64 MiB RGBA8 pixel-memory budget.');
      const layerToken = 'layer' + index + '-' + (layerIndex + 1);
      const pixelsPath = directory + '/' + layerToken + '/pixels.rgba';
      files.set(pixelsPath, pixels);
      return {
        id: String(layer.id), name: String(layer.name || layer.id),
        parentFrameId: String(frame.id || 'frame-' + (index + 1)), index: layerIndex + 1,
        pixelsPath, position: { x: Number(layer.x ?? 0), y: Number(layer.y ?? 0) },
        x: Number(layer.x ?? 0), y: Number(layer.y ?? 0), scaleX: Number(layer.scaleX ?? 1), scaleY: Number(layer.scaleY ?? 1),
        rotation: Number(layer.rotation ?? 0), angle: layer.angle ?? 0, opacity: Number(layer.opacity ?? 1),
        visible: layer.visible !== false, locked: layer.locked === true, blendMode: String(layer.blendMode || 'normal'),
        blur: layer.blur ?? 0, brightness: layer.brightness ?? 0, contrast: layer.contrast ?? 0, saturation: layer.saturation ?? 0,
        mask: structuredClone(layer.mask ?? 'inexistente'), clipping: structuredClone(layer.clipping ?? 'inexistente'),
        references: structuredClone(layer.references || []), assets: structuredClone(layer.assets || []), metadata: structuredClone(layer.metadata || {}),
        zIndex: layerIndex,
      };
    });
    const framePath = directory + '/frame.json';
    files.set(framePath, Buffer.from(JSON.stringify({
      id: String(frame.id || 'frame-' + (index + 1)),
      name: String(frame.name || 'Frame ' + (index + 1)),
      index,
      width: project.width,
      height: project.height,
      durationMs: Math.round(Math.max(1, Math.min(10000, Number(frame.durationMs || Math.round(1000 / (source?.fps || 12)))))),
      layerCount: frameLayersMetadata.length,
      layers: frameLayersMetadata,
    }, null, 2), 'utf8'));
    frameRefs.push({ path: framePath });
  });
  const manifest = {
    format: 'codelab-frames',
    version: 1,
    canvas: { width: project.width, height: project.height },
    fps: Number.isInteger(source?.fps) ? Math.max(1, Math.min(60, source.fps)) : 12,
    activeFrameIndex: Math.max(0, Math.min(frames.length - 1, Number(source?.activeFrameIndex || 0))),
    loop: source?.loop !== false,
    playbackSpeed: Number.isFinite(Number(source?.playbackSpeed)) ? Number(source.playbackSpeed) : 1,
    frames: frameRefs,
  };
  files.set('Frames/frames.tscn', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  return manifest;
}

export function createPixelForgeCodeLabPackageZip(sourceProject, { resources = [] } = {}) {
  if (!sourceProject || typeof sourceProject !== 'object' || Array.isArray(sourceProject)) {
    throw new TypeError('A PixelForge project object is required.');
  }
  const runtime = HeadlessEditorRuntime.fromJSON(sourceProject);
  const project = runtime.toJSON();
  if (project.format !== 'pixelforge-project' || !project.id || !project.name ||
      !Number.isInteger(project.width) || !Number.isInteger(project.height) ||
      project.width < 1 || project.height < 1 || project.width > 4096 || project.height > 4096) {
    throw new TypeError('The source must be a valid native PixelForge project.');
  }

  const files = new Map();
  const referenceCenter = addReferenceEntries(project, files);
  const frames = addAnimation(project, files);
  const scenes = addSceneSections(project, files);
  const resourceDeclarations = [];
  for (const resource of resources) {
    if (!resource || !safeRelativePath(resource.path) || files.has(resource.path)) {
      throw new TypeError('Package resource path is invalid or duplicated: ' + String(resource?.path || ''));
    }
    const bytes = Buffer.isBuffer(resource.bytes) ? resource.bytes : Buffer.from(resource.bytes || []);
    if (!bytes.length) throw new TypeError('Package resource is empty: ' + resource.path);
    const destination = String(resource.destination || inferResourceDestination(resource.path));
    files.set(resource.path, bytes);
    resourceDeclarations.push({
      path: resource.path,
      destination,
      contentType: String(resource.contentType || 'application/octet-stream'),
    });
  }
  for (const declared of project.packageResources || []) {
    const declaredPath = String(declared?.path || '');
    if (!declaredPath || isStructuralPackagePath(declaredPath)) continue;
    if (files.has(declaredPath)) continue;
    if (!resourceDeclarations.some(resource => resource.path === declaredPath)) {
      throw new Error('The project declares a resource without supplied bytes: ' + String(declared.path || 'unknown'));
    }
  }

  for (const section of SCENE_SECTIONS) {
    if (project.drawingModel?.sceneSections?.[section.key]) {
      delete project.drawingModel.sceneSections[section.key].workspace;
    }
  }
  delete project.animation;
  if (project.drawingModel?.referenceCenter) {
    project.drawingModel.referenceCenter.entries = project.drawingModel.referenceCenter.entries.filter(entry => !entry?.parts?.length);
  }
  const projectBytes = Buffer.from(JSON.stringify(project), 'utf8');
  if (projectBytes.length > 96 * 1024 * 1024) throw new RangeError('PixelForge project JSON exceeds the 96 MiB limit.');
  files.set('project.json', projectBytes);
  files.set('Frames/frames.tscn', Buffer.from(JSON.stringify(frames, null, 2), 'utf8'));
  files.set('reference.center/reference.center', Buffer.from(JSON.stringify(referenceCenter, null, 2), 'utf8'));

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
    referenceCenter: { manifestPath: 'reference.center/reference.center' },
    resources: resourceDeclarations,
  };
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  files.set('project.codelab-pixelforge', Buffer.alloc(0));

  const integrity = { format: 'codelab-integrity', version: 1, files: {} };
  for (const [path, bytes] of files) {
    if (['manifest.json', 'project.json', 'project.codelab-pixelforge'].includes(path)) continue;
    integrity.files[path] = { sha256: sha256(bytes), byteSize: bytes.length };
  }
  files.set('integrity.json', Buffer.from(JSON.stringify(integrity, null, 2), 'utf8'));

  const entries = sortPackageEntries([...files].map(([name, data]) => ({ name, data })));
  const bytes = Buffer.from(createZip(entries));
  if (bytes.length > MAX_PACKAGE_BYTES) throw new RangeError('PixelForge CodeLab package exceeds the 100 MiB artifact limit.');
  return {
    bytes,
    filename: safeSlug(project.name, 'pixelforge-project') + '.codelab-pixelforge',
    metadata: {
      format: 'codelab',
      version: 2,
      editor: 'pixelforge',
      projectId: project.id,
      projectName: project.name,
      width: project.width,
      height: project.height,
      layerCount: project.layers.length,
      frameCount: frames.frames.length,
      referenceCount: referenceCenter.categories.reduce((sum, category) => sum + category.references.length, 0),
      resourceCount: resourceDeclarations.length,
      sceneSectionCount: Object.keys(scenes.sections).length,
      entryCount: entries.length,
    },
  };
}
