import { RasterDocument } from './core.js';
import { PIXELFORGE_DRAWING_MODES, normalizeDrawingConfiguration } from './drawing-mode-config.mjs';
import { AIWorkspace } from './workspaces.js';
import { AICommandSession } from './ai-tools.js';
import { applyAnimationAction, summarizeAnimationTimeline, synchronizeAnimationLayers, validateAnimationTimeline } from './animation.js';
import { analyzeMotion, deserializePixels as deserializeDrawingPixels, buildReferenceFromProject, registerReferenceEntry, normalizeDrawingModel } from './drawing-intelligence.js';
import { createVectorModel, auditVectorModel, parseSVGToVectorModel, vectorModelToSVG } from './vector-studio.js';

const MAX_ANIMATION_HISTORY_STEPS = 100;

const MAX_ANIMATION_HISTORY_BYTES = 16 * 1024 * 1024;

function encodeBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export const HEADLESS_CAPABILITIES = Object.freeze({
  protocol: 'pixelforge-headless/v1',
  maxBatchActions: 500,
  maxLayers: 64,
  maxFrames: 240,
  maxCanvasDimension: 4096,
  maxRegionWidth: 32,
  maxRegionHeight: 32,
  maxRegionPixels: 1024,
  maxRawRasterBytes: 64 * 1024 * 1024,
  maxRawAnimationBytes: 64 * 1024 * 1024,
  maxProjectJsonBytes: 96 * 1024 * 1024,
  proposalApprovalRequired: true,
  authenticatedPersistence: true,
  rasterActions: Object.freeze([
    'document.get_summary', 'document.rename', 'canvas.get_reference', 'layer.get_context', 'drawing.model.get', 'drawing.sheet.get', 'drawing.sheet.configure', 'drawing.palette.get', 'drawing.object.select_at', 'drawing.object.inspect', 'drawing.layer.inspect', 'drawing.reference.extract_line_guide', 'drawing.motion.analyze', 'drawing.reference.create', 'drawing.layer.role.set', 'drawing.current_state.set', 'drawing.current_state.get', 'drawing.environment_history.record', 'drawing.environment_history.get', 'drawing.environment_history.list', 'drawing.reference.package_current', 'drawing.reference.list', 'drawing.reference.get', 'drawing.reference.apply', 'drawing.reference.copy_part', 'drawing.reference.copy_frame', 'drawing.reference.remove', 'drawing.layer.context.set', 'canvas.get_pixel',
    'canvas.draw_line', 'canvas.draw_stroke', 'layer.add', 'layer.select', 'layer.move',
    'layer.rename', 'layer.set_opacity', 'layer.set_visibility', 'layer.set_locked',
    'layer.duplicate', 'layer.delete', 'canvas.fill', 'canvas.clear_region',
    'canvas.copy_region', 'canvas.paste_region', 'canvas.crop', 'canvas.draw_shape',
    'canvas.fill_gradient', 'canvas.flip_region', 'canvas.create_outline',
    'canvas.replace_color', 'canvas.preview_transform_region', 'canvas.transform_region',
    'selection.clear', 'selection.create_rect', 'selection.create_ellipse',
    'selection.create_lasso', 'selection.create_magic', 'selection.modify',
    'selection.combine', 'selection.translate', 'history.undo', 'history.redo',
  ]),
  vectorActions: Object.freeze([
    'vector.model.get', 'vector.model.configure', 'vector.audit', 'vector.svg.import', 'vector.svg.export',
    'vector.object.create', 'vector.object.update', 'vector.object.delete', 'vector.object.duplicate',
    'vector.object.reorder', 'vector.object.transform', 'vector.group.create', 'vector.group.ungroup',
    'vector.precision.configure', 'vector.frames.set',
  ]),
  animationActions: Object.freeze([
    'animation.get_summary', 'animation.undo', 'animation.redo',
    'animation.frame.add_from_layer', 'animation.frame.capture_composite',
    'animation.frame.capture_document', 'animation.frame.duplicate',
    'animation.frame.delete', 'animation.frame.reorder', 'animation.frame.set_duration',
    'animation.frame.set_active', 'animation.set_fps', 'animation.set_loop', 'animation.set_playback_speed',
    'animation.frame.get_cel', 'animation.frame.get_context', 'animation.frame.set_cel',
    'animation.frame.get_onion_skin', 'animation.frame.get_composite',
  ]),
});

function remapAnimationLayerIds(timeline, targetLayerIds) {
  if (!Array.isArray(targetLayerIds) || targetLayerIds.length !== timeline.layerIds.length) {
    throw new TypeError('Animation layer identity mapping must preserve the complete layer stack.');
  }
  const mapping = new Map(timeline.layerIds.map((id, index) => [id, targetLayerIds[index]]));
  return {
    ...timeline,
    layerIds: [...targetLayerIds],
    frames: timeline.frames.map(frame => ({
      ...frame,
      cels: frame.cels.map(cel => ({ ...cel, layerId: mapping.get(cel.layerId) ?? cel.layerId })),
    })),
  };
}


function decodeCelPixels(value) {
  if (typeof value !== 'string') return null;
  const binary = atob(value);
  const pixels = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) pixels[index] = binary.charCodeAt(index);
  return pixels;
}

function compareCelPixels(before, after, width, height) {
  const previous = decodeCelPixels(before);
  const next = decodeCelPixels(after);
  const length = width * height * 4;
  if ((previous && previous.length !== length) || (next && next.length !== length)) {
    throw new RangeError('Animation cel dimensions do not match the project canvas.');
  }
  let changedPixels = 0, minX = width, minY = height, maxX = -1, maxY = -1;
  for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = pixel * 4;
    let changed = false;
    for (let channel = 0; channel < 4; channel++) {
      if ((previous?.[offset + channel] ?? 0) !== (next?.[offset + channel] ?? 0)) {
        changed = true;
        break;
      }
    }
    if (!changed) continue;
    const x = pixel % width, y = Math.floor(pixel / width);
    changedPixels++;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return {
    changedPixels,
    bounds: maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
  };
}

function diffAnimationTimelines(before, after) {
  const beforeFrames = new Map(before.frames.map((frame, index) => [frame.id, { frame, index }]));
  const afterFrames = new Map(after.frames.map((frame, index) => [frame.id, { frame, index }]));
  const frameIds = [...after.frames.map(frame => frame.id), ...before.frames.map(frame => frame.id).filter(id => !afterFrames.has(id))];
  const beforeSharedOrder = before.frames.map(frame => frame.id).filter(id => afterFrames.has(id));
  const afterSharedOrder = after.frames.map(frame => frame.id).filter(id => beforeFrames.has(id));
  const orderChanged = beforeSharedOrder.some((id, index) => afterSharedOrder[index] !== id);
  const frames = [];
  let changedCelCount = 0, changedPixels = 0;
  for (const id of frameIds) {
    const previousEntry = beforeFrames.get(id), nextEntry = afterFrames.get(id);
    const previous = previousEntry?.frame, next = nextEntry?.frame;
    const layerIds = [...(next?.cels.map(cel => cel.layerId) ?? []), ...(previous?.cels.map(cel => cel.layerId) ?? []).filter(layerId => !next?.cels.some(cel => cel.layerId === layerId))];
    const cels = [];
    for (const layerId of layerIds) {
      const previousCel = previous?.cels.find(cel => cel.layerId === layerId);
      const nextCel = next?.cels.find(cel => cel.layerId === layerId);
      const previousPixels = previousCel?.pixels ?? null;
      const nextPixels = nextCel?.pixels ?? null;
      if (previousPixels === nextPixels && Boolean(previousCel) === Boolean(nextCel)) continue;
      const pixelDiff = compareCelPixels(previousPixels, nextPixels, after.width, after.height);
      cels.push({
        layerId,
        change: !previousCel ? 'added' : !nextCel ? 'removed' : 'updated',
        changedPixels: pixelDiff.changedPixels,
        bounds: pixelDiff.bounds,
      });
      changedPixels += pixelDiff.changedPixels;
    }
    const reordered = Boolean(previousEntry && nextEntry && beforeSharedOrder.indexOf(id) !== afterSharedOrder.indexOf(id));
    const durationChanged = Boolean(previous && next && previous.durationMs !== next.durationMs);
    const frameMetadataChanged = Boolean(previous && next && durationChanged);
    if (cels.length || reordered || frameMetadataChanged || !previousEntry || !nextEntry) {
      changedCelCount += cels.length;
      frames.push({
        id,
        name: next?.name ?? previous?.name ?? null,
        index: nextEntry?.index ?? previousEntry?.index ?? null,
        previousIndex: previousEntry?.index ?? null,
        change: !previousEntry ? 'added' : !nextEntry ? 'removed' : reordered && !cels.length && !frameMetadataChanged ? 'reordered' : frameMetadataChanged && !cels.length ? 'timing-updated' : 'updated',
        reordered,
        durationChanged,
        previousDurationMs: previous?.durationMs ?? null,
        durationMs: next?.durationMs ?? null,
        cels,
      });
    }
  }
  const settingsChanged = [];
  if (before.fps !== after.fps) settingsChanged.push('fps');
  if (before.loop !== after.loop) settingsChanged.push('loop');
  if ((before.playbackSpeed ?? 1) !== (after.playbackSpeed ?? 1)) settingsChanged.push('playbackSpeed');
  if (before.activeFrameIndex !== after.activeFrameIndex) settingsChanged.push('activeFrameIndex');
  return {
    changedFrameCount: frames.length,
    changedCelCount,
    changedPixels,
    reordered: orderChanged,
    settingsChanged,
    frames,
  };
}

/**
 * DOM-free, provider-independent PixelForge automation runtime.
 * Mutations stay in an isolated sandbox until an explicit proposal is accepted.
 */

function assignVectorObjectIds(value, rootId = crypto.randomUUID()) {
  let index = 0;
  const visit = object => {
    if (!object.id) object.id = index === 0 ? rootId : rootId + '-' + index;
    index++;
    if (object.type === 'group') for (const child of object.children || []) visit(child);
  };
  visit(value);
  return value;
}

function cloneVectorObjectWithFreshIds(value, rootId = crypto.randomUUID()) {
  const copy = JSON.parse(JSON.stringify(value));
  let index = 0;
  const visit = object => {
    object.id = index === 0 ? rootId : rootId + '-' + index;
    index++;
    if (object.type === 'group') for (const child of object.children || []) visit(child);
  };
  visit(copy);
  return copy;
}

function executeVectorModelAction(document, action) {
  const name = action.name;
  const current = document.getVectorModel();
  const model = createVectorModel(document.width, document.height, current);
  const findObject = id => model.objects.find(item => item.id === id);
  const flatten = objects => objects.flatMap(item => [item, ...(item.type === 'group' ? flatten(item.children || []) : [])]);
  const objectCount = flatten(model.objects).length;
  const maxObjects = 10000;
  const validate = candidate => {
    if (!Array.isArray(candidate.objects) || candidate.objects.length > maxObjects ||
        !Array.isArray(candidate.frames) || candidate.frames.length > 240) {
      throw new RangeError('Vector model exceeds the 10,000-object or 240-frame limit.');
    }
    const serialized = JSON.stringify(candidate);
    if (new TextEncoder().encode(serialized).byteLength > 16 * 1024 * 1024) {
      throw new RangeError('Vector model exceeds the 16 MiB Headless vector budget.');
    }
    const audit = auditVectorModel(candidate);
    if (!audit.ok) throw new TypeError('Vector model failed validation: ' + audit.issues.filter(issue => issue.severity === 'error').map(issue => issue.code).join(', '));
    for (const object of flatten(candidate.objects)) {
      for (const key of ['fill', 'stroke', 'fontFamily']) {
        const value = object[key];
        if (typeof value === 'string' && (/url\(\s*(?!#)/i.test(value) || /(?:javascript|https?|file|data):/i.test(value))) {
          throw new TypeError('Vector styles cannot reference external resources or executable URLs.');
        }
      }
      for (const stop of object.gradient?.stops || []) {
        if (typeof stop.color === 'string' && /url\(|(?:javascript|https?|file|data):/i.test(stop.color)) {
          throw new TypeError('Vector gradients cannot reference external resources.');
        }
      }
    }
    const ids = flatten(candidate.objects).map(item => item.id);
    if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
      throw new TypeError('Vector object IDs must be present and unique, including nested group children.');
    }
    return audit;
  };
  if (name === 'vector.model.get') {
    return { ok: true, action: name, result: { model, objectCount, frameCount: model.frames.length } };
  }
  if (name === 'vector.audit') {
    return { ok: true, action: name, result: auditVectorModel(model) };
  }
  if (name === 'vector.svg.export') {
    return { ok: true, action: name, result: { svg: vectorModelToSVG(model), width: model.width, height: model.height, objectCount } };
  }
  if (name === 'vector.svg.import') {
    if (typeof action.svg !== 'string' || !action.svg.trim() || action.svg.length > 2 * 1024 * 1024) {
      throw new TypeError('vector.svg.import requires SVG text between 1 byte and 2 MiB.');
    }
    const imported = parseSVGToVectorModel(action.svg, document.width, document.height);
    let importedId = 0;
    const assignImportedIds = object => {
      object.id = (action.id_prefix || crypto.randomUUID()) + '-' + importedId++;
      if (object.type === 'group') for (const child of object.children || []) assignImportedIds(child);
    };
    for (const object of imported.objects) assignImportedIds(object);
    if (action.replace === false) model.objects.push(...imported.objects);
    else {
      model.objects = imported.objects;
      model.precision = imported.precision;
      model.metadata = imported.metadata;
    }
    const audit = validate(model);
    document.setVectorModel(model);
    return { ok: true, action: name, result: { objectCount: model.objects.length, importedObjectCount: imported.objects.length, audit } };
  }
  if (name === 'vector.model.configure') {
    if (action.grid !== undefined) {
      const grid = Number(action.grid);
      if (!Number.isFinite(grid) || grid < 1 || grid > 4096) throw new RangeError('Vector grid must be between 1 and 4096.');
      model.grid = grid;
    }
    if (action.snap !== undefined) {
      if (typeof action.snap !== 'boolean') throw new TypeError('Vector snap must be a boolean.');
      model.snap = action.snap;
    }
    if (action.metadata !== undefined) {
      if (!action.metadata || typeof action.metadata !== 'object' || Array.isArray(action.metadata)) throw new TypeError('Vector metadata must be an object.');
      model.metadata = { ...model.metadata, ...action.metadata };
    }
  } else if (name === 'vector.precision.configure') {
    if (!action.precision || typeof action.precision !== 'object' || Array.isArray(action.precision)) throw new TypeError('precision must be an object.');
    model.precision = { ...model.precision, ...action.precision };
  } else if (name === 'vector.frames.set') {
    if (!Array.isArray(action.frames) || action.frames.length > 240) throw new RangeError('Vector frames must be an array of at most 240 entries.');
    model.frames = JSON.parse(JSON.stringify(action.frames));
  } else if (name === 'vector.object.create') {
    if (!action.object || typeof action.object !== 'object' || Array.isArray(action.object)) throw new TypeError('object is required.');
    const object = JSON.parse(JSON.stringify(action.object));
    if (!['rect', 'ellipse', 'line', 'path', 'text', 'group'].includes(object.type)) throw new TypeError('Unsupported vector object type.');
    object.id = typeof object.id === 'string' && object.id ? object.id : crypto.randomUUID();
    assignVectorObjectIds(object, object.id);
    if (flatten(model.objects).some(item => item.id === object.id)) throw new TypeError('Vector object ID already exists.');
    if (object.type === 'group' && !Array.isArray(object.children)) throw new TypeError('Vector group children must be an array.');
    model.objects.splice(Number.isInteger(action.index) ? Math.max(0, Math.min(model.objects.length, action.index)) : model.objects.length, 0, object);
  } else if (name === 'vector.object.update') {
    const object = findObject(action.object_id);
    if (!object) throw new Error('Vector object was not found.');
    if (!action.patch || typeof action.patch !== 'object' || Array.isArray(action.patch) || 'id' in action.patch || 'type' in action.patch) {
      throw new TypeError('patch must be an object and cannot change object id or type.');
    }
    Object.assign(object, JSON.parse(JSON.stringify(action.patch)));
  } else if (name === 'vector.object.delete') {
    if (typeof action.object_id !== 'string') throw new TypeError('object_id is required.');
    const before = flatten(model.objects).length;
    const remove = list => {
      for (let index = list.length - 1; index >= 0; index--) {
        const item = list[index];
        if (item.id === action.object_id) list.splice(index, 1);
        else if (item.type === 'group') remove(item.children || []);
      }
    };
    remove(model.objects);
    if (flatten(model.objects).length === before) throw new Error('Vector object was not found.');
  } else if (name === 'vector.object.duplicate') {
    const object = findObject(action.object_id);
    if (!object) throw new Error('Vector object was not found.');
    const duplicate = cloneVectorObjectWithFreshIds(object, action.new_id || crypto.randomUUID());
    duplicate.name = String(duplicate.name || duplicate.type) + ' copy';
    model.objects.splice(model.objects.indexOf(object) + 1, 0, duplicate);
  } else if (name === 'vector.object.reorder') {
    const object = findObject(action.object_id);
    if (!object) throw new Error('Vector object was not found.');
    if (!Number.isInteger(action.index) || action.index < 0 || action.index >= model.objects.length) throw new RangeError('index must identify a top-level vector object position.');
    const currentIndex = model.objects.indexOf(object);
    if (currentIndex < 0) throw new TypeError('Only top-level vector objects can be reordered.');
    model.objects.splice(currentIndex, 1);
    model.objects.splice(Math.min(action.index, model.objects.length), 0, object);
  } else if (name === 'vector.object.transform') {
    const object = findObject(action.object_id);
    if (!object) throw new Error('Vector object was not found.');
    const transform = action.transform;
    if (!transform || typeof transform !== 'object' || Array.isArray(transform)) throw new TypeError('transform must be an object.');
    for (const key of ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'skewX', 'skewY']) {
      if (transform[key] !== undefined && !Number.isFinite(Number(transform[key]))) throw new TypeError('Transform values must be finite numbers.');
    }
    object.transform = { ...(object.transform || {}), ...transform };
  } else if (name === 'vector.group.create') {
    const ids = [...new Set(action.object_ids || [])];
    if (ids.length < 2 || ids.some(id => typeof id !== 'string')) throw new TypeError('Grouping requires at least two object_ids.');
    const selected = model.objects.filter(object => ids.includes(object.id));
    if (selected.length !== ids.length) throw new TypeError('All grouped objects must be top-level objects in the document.');
    model.objects = model.objects.filter(object => !ids.includes(object.id));
    model.objects.push({ id: action.group_id || crypto.randomUUID(), name: action.group_name || 'Group', type: 'group', children: selected, transform: {} });
  } else if (name === 'vector.group.ungroup') {
    const index = model.objects.findIndex(object => object.id === action.object_id && object.type === 'group');
    if (index < 0) throw new Error('Vector group was not found.');
    const [group] = model.objects.splice(index, 1);
    model.objects.splice(index, 0, ...(group.children || []));
  } else {
    throw new TypeError('Unsupported vector action: ' + name);
  }
  const audit = validate(model);
  const changed = JSON.stringify(current) !== JSON.stringify(model);
  if (changed) document.setVectorModel(model);
  return { ok: true, action: name, result: { changed, objectCount: flatten(model.objects).length, frameCount: model.frames.length, audit } };
}

export class HeadlessEditorRuntime {
  #document;
  #workspace;
  #commands;
  #animation;
  #sandboxAnimation;
  #animationDirty = false;
  #animationHistory = [];
  #animationFuture = [];
  #animationHistoryBytes = 0;
  #hasAnimation = false;
  #drawingConfiguration;

  constructor({ width = 128, height = 128, name = 'Untitled artwork', project = null } = {}) {
    this.#document = project === null
      ? new RasterDocument(width, height, name)
      : RasterDocument.fromJSON(project);
    this.#drawingConfiguration = normalizeDrawingConfiguration(project?.drawingConfiguration, {
      legacyDefault: project ? PIXELFORGE_DRAWING_MODES.PIXEL_ART : PIXELFORGE_DRAWING_MODES.ILLUSTRATION,
    });
    this.#hasAnimation = Boolean(project?.animation);
    this.#animation = validateAnimationTimeline(project?.animation, this.#document.width, this.#document.height, this.#document.layers);
    this.#resetWorkspace();
  }

  #clearAnimationHistory() {
    this.#animationHistory = [];
    this.#animationFuture = [];
    this.#animationHistoryBytes = 0;
  }

  #pushAnimationHistory(stack, snapshot) {
    const bytes = JSON.stringify(snapshot).length;
    stack.push({ snapshot, bytes });
    this.#animationHistoryBytes += bytes;
    while (stack.length > MAX_ANIMATION_HISTORY_STEPS || this.#animationHistoryBytes > MAX_ANIMATION_HISTORY_BYTES) {
      const removed = stack.shift();
      if (!removed) break;
      this.#animationHistoryBytes -= removed.bytes;
    }
  }

  #clearAnimationFuture() {
    for (const entry of this.#animationFuture) this.#animationHistoryBytes -= entry.bytes;
    this.#animationFuture = [];
  }

  #committedAnimationForSandbox() {
    const sandboxIds = this.#workspace.mapSourceLayerIdsToSandbox(this.#animation.layerIds);
    const mapped = remapAnimationLayerIds(this.#animation, sandboxIds);
    return synchronizeAnimationLayers(mapped, this.#workspace.sandbox);
  }

  #animationDiffersFromCommitted() {
    return JSON.stringify(this.#sandboxAnimation) !== JSON.stringify(this.#committedAnimationForSandbox());
  }

  #resetWorkspace() {
    this.#workspace = new AIWorkspace(this.#document);
    this.#commands = new AICommandSession(this.#workspace);
    const sandboxLayerIds = this.#workspace.mapSourceLayerIdsToSandbox(this.#animation.layerIds);
    this.#sandboxAnimation = remapAnimationLayerIds(this.#animation, sandboxLayerIds);
    this.#animationDirty = false;
    this.#clearAnimationHistory();
  }

  get document() { return this.#document; }
  get sandbox() { return this.#workspace.sandbox; }
  get workspace() { return this.#workspace; }
  get hasPendingChanges() { return this.#workspace.hasSandboxChanges || this.#animationDirty; }
  get hasPendingProposal() { return this.#workspace.hasProposal; }

  #layerContext(layerId) {
    const layers = this.#workspace.sandbox.layers;
    const index = layerId ? layers.findIndex(layer => layer.id === layerId) : layers.findIndex(layer => layer.id === this.#workspace.sandbox.activeLayerId);
    if (index < 0) throw new Error('Layer context target was not found.');
    const current = layers[index];
    const previous = index > 0 ? layers[index - 1] : null;
    return {
      current: { index, id: current.id, name: current.name, width: this.#workspace.sandbox.width, height: this.#workspace.sandbox.height, pixels: encodeBase64(current.pixels) },
      previous: previous ? { index: index - 1, id: previous.id, name: previous.name, pixels: encodeBase64(previous.pixels) } : null,
      visual: { format: 'rgba-base64', width: this.#workspace.sandbox.width, height: this.#workspace.sandbox.height },
      guidance: { rule: 'Use the returned previous layer as authoritative visual context; do not infer hidden pixels or layer contents.', requestMoreContextAction: 'layer.get_context' },
    };
  }

  execute(action) {
    if (action && typeof action.name === 'string' && action.name.startsWith('vector.')) {
      const readOnlyVectorActions = new Set(['vector.model.get', 'vector.audit', 'vector.svg.export']);
      if (this.#workspace.hasProposal && !readOnlyVectorActions.has(action.name)) return { ok: false, action: action.name, error: { code: 'proposal_pending', message: 'Accept or discard the pending proposal before making more vector edits.' } };
      try { return executeVectorModelAction(this.#workspace.sandbox, action); }
      catch (error) { return { ok: false, action: action.name, error: { code: error instanceof RangeError ? 'out_of_bounds_or_limit' : error instanceof TypeError ? 'invalid_arguments' : 'operation_failed', message: error instanceof Error ? error.message : 'Vector operation failed.' } }; }
    }
    if (action?.name === 'layer.get_context') {
      try { return { ok: true, action: action.name, result: this.#layerContext(action.layerId) }; }
      catch (error) { return { ok: false, action: action.name, error: { code: 'operation_failed', message: error instanceof Error ? error.message : 'Layer context failed.' } }; }
    }
    if (action?.name === 'drawing.reference.package_current') {
      try {
        const sourceProject = this.#workspace.sandbox.toJSON();
        sourceProject.animation = JSON.parse(JSON.stringify(this.#sandboxAnimation));
        const currentModel = normalizeDrawingModel(this.#workspace.sandbox.getDrawingModel(), {
          width: this.#workspace.sandbox.width,
          height: this.#workspace.sandbox.height,
        });
        const entry = buildReferenceFromProject({
          projectId: this.#document.id,
          project: sourceProject,
          name: action.referenceName || 'Drawing reference',
        });
        const nextModel = registerReferenceEntry(currentModel, entry);
        this.#workspace.sandbox.setDrawingModel(nextModel);

        const cleanLayer = this.#workspace.sandbox.layers[0];
        const blank = new Uint8Array(this.#workspace.sandbox.width * this.#workspace.sandbox.height * 4);
        this.#workspace.sandbox.setLayerPixels(cleanLayer.id, blank);
        this.#workspace.sandbox.renameLayer(cleanLayer.id, String(action.cleanLayerName || 'Layer 1').slice(0, 180));
        for (const layer of [...this.#workspace.sandbox.layers].slice(1)) this.#workspace.sandbox.deleteLayer(layer.id);
        this.#workspace.sandbox.setLayerVisibility(cleanLayer.id, true);
        this.#workspace.sandbox.setLayerLocked(cleanLayer.id, false);
        this.#workspace.sandbox.setLayerOpacity(cleanLayer.id, 1);
        this.#workspace.sandbox.setActiveLayer(cleanLayer.id);

        this.#sandboxAnimation = {
          format: 'pixelforge-animation',
          version: 1,
          width: this.#workspace.sandbox.width,
          height: this.#workspace.sandbox.height,
          layerIds: [cleanLayer.id],
          fps: this.#sandboxAnimation.fps || 12,
          loop: this.#sandboxAnimation.loop !== false,
          activeFrameIndex: 0,
          frames: [],
        };
        this.#animationDirty = this.#animationDiffersFromCommitted();
        return {
          ok: true,
          action: action.name,
          result: {
            packaged: true,
            referenceId: entry.id,
            sourceRevision: sourceProject.serverRevision ?? sourceProject.revision ?? 0,
            source: {
              canvas: { width: sourceProject.width, height: sourceProject.height },
              layerCount: sourceProject.layers?.length || 0,
              frameCount: sourceProject.animation?.frames?.length || 0,
            },
            cleanEditor: {
              canvas: { width: this.#workspace.sandbox.width, height: this.#workspace.sandbox.height },
              layerCount: this.#workspace.sandbox.layers.length,
              layers: this.#workspace.sandbox.layers.map(layer => ({ id: layer.id, name: layer.name })),
              frameCount: this.#sandboxAnimation.frames.length,
            },
            referenceCenter: { entryId: entry.id, immutableSnapshot: true },
          },
        };
      } catch (error) {
        return { ok: false, action: action.name, error: { code: 'operation_failed', message: error instanceof Error ? error.message : 'Reference packaging failed.' } };
      }
    }
    if (action?.name === 'drawing.motion.analyze') {
      try {
        const beforeIndex = action.beforeIndex;
        const afterIndex = action.afterIndex;
        const beforeAction = { name: action.layerId ? 'animation.frame.get_cel' : 'animation.frame.get_composite', index: beforeIndex, ...(action.layerId ? { layerId: action.layerId } : {}) };
        const afterAction = { name: action.layerId ? 'animation.frame.get_cel' : 'animation.frame.get_composite', index: afterIndex, ...(action.layerId ? { layerId: action.layerId } : {}) };
        const beforeResult = applyAnimationAction(this.#sandboxAnimation, this.#workspace.sandbox, beforeAction);
        const afterResult = applyAnimationAction(this.#sandboxAnimation, this.#workspace.sandbox, afterAction);
        const result = analyzeMotion({
          beforePixels: deserializeDrawingPixels(beforeResult.result.pixels),
          afterPixels: deserializeDrawingPixels(afterResult.result.pixels),
          width: this.#workspace.sandbox.width,
          height: this.#workspace.sandbox.height,
          gridStep: action.gridStep ?? 8,
        });
        return { ok: true, action: action.name, result: { beforeIndex, afterIndex, ...result } };
      } catch (error) {
        return { ok: false, action: action.name, error: { code: 'operation_failed', message: error instanceof Error ? error.message : 'Motion analysis failed.' } };
      }
    }
    if (action && typeof action.name === 'string' && action.name.startsWith('animation.')) {
      if (this.#workspace.hasProposal && action.name !== 'animation.get_summary') {
        return { ok: false, action: action.name, error: { code: 'proposal_pending', message: 'Accept or discard the pending proposal before making more animation edits.' } };
      }
      try {
        if (action.name === 'animation.undo') {
          if (!this.#animationHistory.length) return { ok: true, action: action.name, result: { changed: false } };
          const previous = this.#animationHistory.pop();
          this.#animationHistoryBytes -= previous.bytes;
          this.#pushAnimationHistory(this.#animationFuture, this.#sandboxAnimation);
          this.#sandboxAnimation = synchronizeAnimationLayers(previous.snapshot, this.#workspace.sandbox);
          this.#animationDirty = this.#animationDiffersFromCommitted();
          return { ok: true, action: action.name, result: { changed: true, summary: summarizeAnimationTimeline(this.#sandboxAnimation) } };
        }
        if (action.name === 'animation.redo') {
          if (!this.#animationFuture.length) return { ok: true, action: action.name, result: { changed: false } };
          const next = this.#animationFuture.pop();
          this.#animationHistoryBytes -= next.bytes;
          this.#pushAnimationHistory(this.#animationHistory, this.#sandboxAnimation);
          this.#sandboxAnimation = synchronizeAnimationLayers(next.snapshot, this.#workspace.sandbox);
          this.#animationDirty = this.#animationDiffersFromCommitted();
          return { ok: true, action: action.name, result: { changed: true, summary: summarizeAnimationTimeline(this.#sandboxAnimation) } };
        }
        const before = JSON.parse(JSON.stringify(this.#sandboxAnimation));
        const outcome = applyAnimationAction(this.#sandboxAnimation, this.#workspace.sandbox, action);
        const changed = JSON.stringify(before) !== JSON.stringify(outcome.timeline);
        if (changed) {
          this.#clearAnimationFuture();
          this.#pushAnimationHistory(this.#animationHistory, before);
        }
        this.#sandboxAnimation = outcome.timeline;
        this.#animationDirty = this.#animationDiffersFromCommitted();
        const contextActions = new Set([
          'animation.frame.add_from_layer',
          'animation.frame.capture_composite',
          'animation.frame.capture_document',
          'animation.frame.duplicate',
          'animation.frame.set_cel',
        ]);
        const enrichedResult = { ...outcome.result, changed };
        if (contextActions.has(action.name) && this.#sandboxAnimation.frames.length) {
          const context = applyAnimationAction(
            this.#sandboxAnimation,
            this.#workspace.sandbox,
            { name: 'animation.frame.get_context', index: outcome.result.index ?? action.index ?? this.#sandboxAnimation.activeFrameIndex, layerId: action.layerId }
          );
          enrichedResult.previousFrameContext = context.result;
        }
        return { ok: true, action: action.name, result: enrichedResult };
      } catch (error) {
        return { ok: false, action: action.name, error: {
          code: error instanceof RangeError ? 'out_of_bounds_or_limit' : error instanceof TypeError ? 'invalid_arguments' : 'operation_failed',
          message: error instanceof Error ? error.message : 'Animation operation failed.',
        } };
      }
    }
    if (action?.name === 'canvas.crop' && this.#sandboxAnimation.frames.length) {
      return {
        ok: false,
        action: action.name,
        error: {
          code: 'animation_dimension_change_requires_frame_transform',
          message: 'Cropping an animated project requires applying the same crop to every frame cel. This operation is blocked rather than leaving frame dimensions inconsistent.',
        },
      };
    }
    const commandResult = this.#commands.execute(action);
    if (commandResult.ok) {
      if (['drawing.reference.copy_part', 'drawing.reference.copy_frame'].includes(action?.name) &&
          this.#sandboxAnimation.frames.length) {
        const activeLayer = this.#workspace.sandbox.activeLayer;
        const activeFrame = this.#sandboxAnimation.frames[this.#sandboxAnimation.activeFrameIndex];
        const activeCel = activeFrame?.cels?.find(cel => cel.layerId === activeLayer?.id);
        if (activeCel && activeLayer) activeCel.pixels = encodeBase64(activeLayer.pixels);
        this.#animationDirty = this.#animationDiffersFromCommitted();
      }
      const before = JSON.stringify(this.#sandboxAnimation);
      const synchronized = synchronizeAnimationLayers(this.#sandboxAnimation, this.#workspace.sandbox);
      if (JSON.stringify(synchronized) !== before) {
        this.#sandboxAnimation = synchronized;
        this.#animationDirty = this.#animationDiffersFromCommitted();
      }
    }
    return commandResult;
  }

  executeBatch(actions) {
    if (!Array.isArray(actions) || actions.length < 1 || actions.length > 500) {
      throw new RangeError('A headless batch must contain between 1 and 500 actions.');
    }
    const results = [];
    for (let index = 0; index < actions.length; index++) {
      const result = this.execute(actions[index]);
      results.push({ index, ...result });
      if (!result.ok) return { ok: false, failedIndex: index, results, error: result.error };
    }
    return { ok: true, results };
  }

  inspect() {
    const source = this.#document;
    const sandbox = this.#workspace.sandbox;
    return {
      mode: 'headless',
      project: {
        id: source.id, name: source.name, width: source.width, height: source.height,
        revision: source.revision, serverRevision: source.serverRevision,
        layerCount: source.layers.length,
        vectorObjectCount: source.getVectorModel()?.objects?.length || 0,
        vectorAudit: source.getVectorModel() ? auditVectorModel(createVectorModel(source.width, source.height, source.getVectorModel())) : null,
        layers: source.layers.map((layer, index) => ({
          index, id: layer.id, name: layer.name, visible: layer.visible,
          locked: layer.locked, opacity: layer.opacity,
        })),
      },
      sandbox: {
        width: sandbox.width, height: sandbox.height, revision: sandbox.revision,
        layerCount: sandbox.layers.length, hasChanges: this.#workspace.hasSandboxChanges,
        vectorObjectCount: sandbox.getVectorModel()?.objects?.length || 0,
        vectorAudit: sandbox.getVectorModel() ? auditVectorModel(createVectorModel(sandbox.width, sandbox.height, sandbox.getVectorModel())) : null,
      },
      proposal: this.#workspace.proposalSummary,
      animation: { ...summarizeAnimationTimeline(this.#sandboxAnimation), hasChanges: this.#animationDirty },
      capabilities: HEADLESS_CAPABILITIES,
    };
  }

  createProposal(summary) {
    if (!this.hasPendingChanges) throw new Error('There are no sandbox or animation changes to propose.');
    return this.#commands.createProposal(summary);
  }

  getDiff() {
    const raster = this.#workspace.getVisualDiff();
    const committedAnimation = this.#committedAnimationForSandbox();
    const animation = diffAnimationTimelines(committedAnimation, this.#sandboxAnimation);
    return {
      width: raster.width,
      height: raster.height,
      changedPixels: raster.changedPixels + animation.changedPixels,
      rasterChangedPixels: raster.changedPixels,
      animationChangedPixels: animation.changedPixels,
      bounds: raster.bounds,
      pixels: raster.pixels,
      vector: {
        changed: JSON.stringify(this.#document.getVectorModel()) !== JSON.stringify(this.#workspace.sandbox.getVectorModel()),
        beforeObjectCount: this.#document.getVectorModel()?.objects?.length || 0,
        afterObjectCount: this.#workspace.sandbox.getVectorModel()?.objects?.length || 0,
        audit: this.#workspace.sandbox.getVectorModel() ? auditVectorModel(createVectorModel(this.#workspace.sandbox.width, this.#workspace.sandbox.height, this.#workspace.sandbox.getVectorModel())) : null,
      },
      animation,
    };
  }

  acceptProposal() {
    const hadRasterChanges = this.#workspace.hasSandboxChanges;
    const hadAnimationChanges = this.#animationDirty;
    const committedAnimation = remapAnimationLayerIds(
      this.#sandboxAnimation,
      this.#workspace.mapSandboxLayerIdsToSource(this.#sandboxAnimation.layerIds),
    );
    const result = this.#workspace.acceptProposal();
    if (result.status === 'applied') {
      this.#animation = committedAnimation;
      if (hadAnimationChanges) this.#hasAnimation = this.#animation.frames.length > 0;
      const nextSandboxLayerIds = this.#workspace.mapSourceLayerIdsToSandbox(this.#animation.layerIds);
      this.#sandboxAnimation = remapAnimationLayerIds(this.#animation, nextSandboxLayerIds);
      this.#animationDirty = false;
      this.#clearAnimationHistory();
      if (!hadRasterChanges && hadAnimationChanges) {
        this.#document.revision++;
        this.#document.saveVersion++;
      }
      if (hadRasterChanges || hadAnimationChanges) this.#document.dirty = true;
    }
    return result;
  }

  discardProposal() {
    const hadAnimationChanges = this.#animationDirty;
    const discarded = this.#workspace.discardProposal();
    this.#sandboxAnimation = remapAnimationLayerIds(this.#animation, this.#workspace.mapSourceLayerIdsToSandbox(this.#animation.layerIds));
    this.#animationDirty = false;
    this.#clearAnimationHistory();
    return discarded || hadAnimationChanges;
  }
  discardSandboxChanges() {
    const hadAnimationChanges = this.#animationDirty;
    const discarded = this.#workspace.discardSandboxChanges();
    this.#sandboxAnimation = remapAnimationLayerIds(this.#animation, this.#workspace.mapSourceLayerIdsToSandbox(this.#animation.layerIds));
    this.#animationDirty = false;
    this.#clearAnimationHistory();
    return discarded || hadAnimationChanges;
  }
  syncFromSource(options) {
    const result = this.#workspace.syncFromUser(options);
    if (result.status === 'synced') {
      this.#sandboxAnimation = remapAnimationLayerIds(this.#animation, this.#workspace.mapSourceLayerIdsToSandbox(this.#animation.layerIds));
      this.#animationDirty = false;
      this.#clearAnimationHistory();
    }
    return result;
  }

  toJSON() {
    if (this.#workspace.hasProposal || this.hasPendingChanges) {
      throw new Error('Unreviewed sandbox changes cannot be serialized. Create and accept a proposal first.');
    }
    const project = this.#document.toJSON();
    project.drawingConfiguration = structuredClone(this.#drawingConfiguration);
    if (this.#hasAnimation || this.#animation.frames.length > 0) project.animation = JSON.parse(JSON.stringify(this.#animation));
    return project;
  }

  static fromJSON(project) { return new HeadlessEditorRuntime({ project }); }
}

export function createHeadlessRuntime(options) {
  return new HeadlessEditorRuntime(options);
}
