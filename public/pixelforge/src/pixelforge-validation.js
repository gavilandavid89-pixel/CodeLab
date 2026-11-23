import { auditVectorModel } from './vector-studio.js';
import { MAX_DIMENSION, MAX_PIXELS, MAX_DOCUMENT_BYTES } from './core.js';

export const PIXELFORGE_VALIDATION_VERSION = 2;

function expectedBase64Length(byteLength) {
  return Math.ceil(byteLength / 3) * 4;
}

function validBase64Buffer(value, byteLength) {
  if (typeof value !== 'string' || value.length !== expectedBase64Length(byteLength)) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  const padding = byteLength % 3 === 0 ? '' : byteLength % 3 === 1 ? '==' : '=';
  return value.endsWith(padding);
}

function issue(code, severity, message, details = {}) {
  return { code, severity, message, ...details };
}

function finite(value) { return Number.isFinite(Number(value)); }

function validateRasterProject(project) {
  const issues = [];
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    return { ok: false, score: 0, issues: [issue('invalid_project', 'error', 'Project must be an object.')] };
  }
  if (project.format !== 'pixelforge-project') issues.push(issue('invalid_format', 'error', 'Unsupported PixelForge project format.'));
  if (!Number.isInteger(project.width) || project.width < 1 || project.width > MAX_DIMENSION) issues.push(issue('invalid_width', 'error', 'Project width must be a positive integer within the raster limit.', { actual: project.width }));
  if (!Number.isInteger(project.height) || project.height < 1 || project.height > MAX_DIMENSION) issues.push(issue('invalid_height', 'error', 'Project height must be a positive integer within the raster limit.', { actual: project.height }));
  const dimensionsValid = Number.isInteger(project.width) && Number.isInteger(project.height) &&
    project.width > 0 && project.height > 0 && project.width <= MAX_DIMENSION &&
    project.height <= MAX_DIMENSION && project.width * project.height <= MAX_PIXELS;
  if (Number.isInteger(project.width) && Number.isInteger(project.height) &&
      project.width > 0 && project.height > 0 && project.width * project.height > MAX_PIXELS) {
    issues.push(issue('pixel_count_limit_exceeded', 'error', 'Project exceeds the maximum pixel count.', { actual: project.width * project.height, maximum: MAX_PIXELS }));
  }
  if (dimensionsValid && Array.isArray(project.layers) &&
      project.width * project.height * 4 * project.layers.length > MAX_DOCUMENT_BYTES) {
    issues.push(issue('raster_memory_limit_exceeded', 'error', 'Project layers exceed the total RGBA memory budget.', { maximumBytes: MAX_DOCUMENT_BYTES }));
  }
  if (!Array.isArray(project.layers) || project.layers.length < 1) issues.push(issue('missing_layers', 'error', 'Project must contain at least one layer.'));
  if (Array.isArray(project.layers)) {
    const ids = new Set();
    for (const layer of project.layers) {
      if (!layer || typeof layer !== 'object') {
        issues.push(issue('invalid_layer', 'error', 'Layer entry must be an object.'));
        continue;
      }
      if (!layer.id) issues.push(issue('missing_layer_id', 'error', 'Layer has no id.'));
      else if (ids.has(layer.id)) issues.push(issue('duplicate_layer_id', 'error', 'Duplicate layer id.', { layerId: layer.id }));
      else ids.add(layer.id);
      if (typeof layer.name !== 'string' || !layer.name.trim()) issues.push(issue('invalid_layer_name', 'warning', 'Layer name is empty.', { layerId: layer.id }));
      if (layer.opacity !== undefined && (!finite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1)) {
        issues.push(issue('invalid_layer_opacity', 'error', 'Layer opacity must be between 0 and 1.', { layerId: layer.id, actual: layer.opacity }));
      }
      if (typeof layer.visible !== 'boolean') issues.push(issue('invalid_layer_visibility', 'error', 'Layer visibility must be boolean.', { layerId: layer.id }));
      if (typeof layer.locked !== 'boolean') issues.push(issue('invalid_layer_lock', 'error', 'Layer lock flag must be boolean.', { layerId: layer.id }));
      if (typeof layer.pixels !== 'string' || !layer.pixels) {
        issues.push(issue('missing_layer_pixels', 'error', 'Layer pixel buffer is missing.', { layerId: layer.id }));
      } else if (dimensionsValid) {
        const expectedBytes = project.width * project.height * 4;
        if (!validBase64Buffer(layer.pixels, expectedBytes)) {
          issues.push(issue('invalid_layer_pixel_buffer', 'error', 'Layer pixel data must be canonical Base64 containing exactly width × height × 4 RGBA bytes.', {
            layerId: layer.id, expectedBytes, expectedBase64Length: expectedBase64Length(expectedBytes),
            actualBase64Length: layer.pixels.length,
          }));
        }
      }
    }
    if (project.activeLayerId && !ids.has(project.activeLayerId)) {
      issues.push(issue('invalid_active_layer', 'error', 'Active layer does not exist.', { layerId: project.activeLayerId }));
    }
  }
  const vector = project.vectorModel;
  if (vector) {
    const vectorResult = validateVectorModel(vector, { width: project.width, height: project.height });
    issues.push(...vectorResult.issues);
  }
  const errors = issues.filter(x => x.severity === 'error').length;
  const warnings = issues.filter(x => x.severity === 'warning').length;
  return { ok: errors === 0, score: Math.max(0, 100 - errors * 20 - warnings * 5), issues };
}

export function validateVectorModel(model, { width = model?.width, height = model?.height, tolerance = 2 } = {}) {
  const issues = [];
  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    return { ok: false, score: 0, issues: [issue('invalid_vector_model', 'error', 'Vector model must be an object.')] };
  }
  if (!Number.isInteger(model.version) || model.version < 1) issues.push(issue('invalid_vector_version', 'error', 'Vector model version must be a positive integer.', { actual: model.version }));
  if (!Number.isInteger(model.width) || model.width < 1) issues.push(issue('invalid_vector_width', 'error', 'Vector model width must be positive.', { actual: model.width }));
  if (!Number.isInteger(model.height) || model.height < 1) issues.push(issue('invalid_vector_height', 'error', 'Vector model height must be positive.', { actual: model.height }));
  if (width != null && model.width !== width) issues.push(issue('vector_width_mismatch', 'error', 'Vector width does not match raster document width.', { expected: width, actual: model.width }));
  if (height != null && model.height !== height) issues.push(issue('vector_height_mismatch', 'error', 'Vector height does not match raster document height.', { expected: height, actual: model.height }));
  if (!Number.isInteger(model.grid) || model.grid < 1) issues.push(issue('invalid_grid', 'error', 'Vector grid must be a positive integer.', { actual: model.grid }));
  if (typeof model.snap !== 'boolean') issues.push(issue('invalid_snap', 'error', 'Vector snap flag must be boolean.'));
  if (!Array.isArray(model.objects)) issues.push(issue('invalid_objects', 'error', 'Vector objects must be an array.'));
  if (!Array.isArray(model.frames)) issues.push(issue('invalid_frames', 'error', 'Vector frames must be an array.'));
  if (Array.isArray(model.frames)) {
    const frameIds = new Set();
    for (const frame of model.frames) {
      if (!frame || typeof frame !== 'object') { issues.push(issue('invalid_frame', 'error', 'Animation frame must be an object.')); continue; }
      if (frame.id) {
        if (frameIds.has(frame.id)) issues.push(issue('duplicate_frame_id', 'error', 'Duplicate animation frame id.', { frameId: frame.id }));
        frameIds.add(frame.id);
      }
      if (frame.time !== undefined && (!finite(frame.time) || Number(frame.time) < 0)) issues.push(issue('invalid_frame_time', 'error', 'Animation frame time must be a non-negative finite number.', { frameId: frame.id, actual: frame.time }));
      if (frame.duration !== undefined && (!finite(frame.duration) || Number(frame.duration) < 0)) issues.push(issue('invalid_frame_duration', 'error', 'Animation frame duration must be non-negative.', { frameId: frame.id, actual: frame.duration }));
    }
  }
  if (Array.isArray(model.objects)) {
    const ids = new Set();
    const walk = (objects, parentId = null) => {
      for (const object of objects) {
        if (!object || typeof object !== 'object') {
          issues.push(issue('invalid_vector_object', 'error', 'Vector object must be an object.', { parentId }));
          continue;
        }
        if (!object.id) issues.push(issue('missing_vector_object_id', 'error', 'Vector object has no id.', { parentId }));
        else if (ids.has(object.id)) issues.push(issue('duplicate_vector_object_id', 'error', 'Duplicate vector object id.', { objectId: object.id }));
        else ids.add(object.id);
        if (!['rect','ellipse','line','path','text','group'].includes(object.type)) issues.push(issue('unsupported_vector_type', 'error', 'Unsupported vector object type.', { objectId: object.id, type: object.type }));
        if (object.type === 'path' && (!Array.isArray(object.points) || object.points.length < 2)) issues.push(issue('invalid_path', 'error', 'Path needs at least two points.', { objectId: object.id }));
        if (Array.isArray(object.points)) {
          object.points.forEach((point, index) => {
            if (!point || !finite(point.x) || !finite(point.y)) issues.push(issue('invalid_path_point', 'error', 'Path point has non-finite coordinates.', { objectId: object.id, index }));
            for (const handle of ['c1','c2']) if (point?.[handle] && (!finite(point[handle].x) || !finite(point[handle].y))) {
              issues.push(issue('invalid_path_handle', 'error', 'Bezier handle has non-finite coordinates.', { objectId: object.id, index, handle }));
            }
          });
        }
        if (object.type === 'text' && typeof object.text !== 'string') issues.push(issue('invalid_text', 'error', 'Text object text must be a string.', { objectId: object.id }));
        if (object.type === 'group') {
          if (!Array.isArray(object.children) || !object.children.length) issues.push(issue('empty_group', 'warning', 'Group has no children.', { objectId: object.id }));
          else walk(object.children, object.id);
        }
        if (object.transform && typeof object.transform === 'object') {
          for (const key of ['x','y','rotation','scaleX','scaleY','skewX','skewY']) {
            if (object.transform[key] !== undefined && !finite(object.transform[key])) issues.push(issue('invalid_transform', 'error', 'Transform contains a non-finite value.', { objectId: object.id, field: key }));
          }
          if (object.transform.scaleX === 0 || object.transform.scaleY === 0) issues.push(issue('zero_scale', 'warning', 'Transform scale is zero; object may be invisible.', { objectId: object.id }));
        }
      }
    };
    walk(model.objects);
  }
  const audit = auditVectorModel(model, { tolerance, viewport: true });
  issues.push(...audit.issues.map(item => ({ ...item, source: 'vector-audit' })));
  const errors = issues.filter(x => x.severity === 'error').length;
  const warnings = issues.filter(x => x.severity === 'warning').length;
  return { ok: errors === 0, score: Math.max(0, 100 - errors * 20 - warnings * 5), objectCount: model.objects?.length || 0, issues };
}

export function validatePixelForgeProject(project, options = {}) {
  const raster = validateRasterProject(project);
  const categories = {
    schema: raster.issues.filter(i => /invalid_|missing_|duplicate_|unsupported_/.test(i.code)),
    geometry: raster.issues.filter(i => /geometry|path|point|handle|bounds/.test(i.code)),
    animation: raster.issues.filter(i => /frame|animation/.test(i.code)),
    transforms: raster.issues.filter(i => /transform|scale/.test(i.code)),
  };
  return {
    validatorVersion: PIXELFORGE_VALIDATION_VERSION,
    ok: raster.ok,
    score: raster.score,
    categories: Object.fromEntries(Object.entries(categories).map(([key, items]) => [key, { ok: !items.some(i => i.severity === 'error'), count: items.length, issues: items }])),
    issues: raster.issues,
    options: { tolerance: options.tolerance ?? 2 },
  };
}

export function formatValidationFailure(result) {
  if (result.ok) return 'PixelForge validation passed.';
  const first = result.issues.find(item => item.severity === 'error') || result.issues[0];
  return first ? '[' + first.code + '] ' + first.message + (first.objectId ? ' (object ' + first.objectId + ')' : '') : 'PixelForge validation failed.';
}
