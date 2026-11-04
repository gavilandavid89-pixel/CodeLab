import { AIWorkspace } from './workspaces.js';
import { createSelectionMask, createColorSelectionMask, modifySelectionMask, combineSelectionMasks, translateSelectionMask } from './core.js';

const COLOR = /^#[0-9a-f]{6}$/i;
const DENIED_ACTIONS = new Set([
  'project.delete', 'document.delete', 'project.export', 'document.export',
  'canvas.export', 'project.upload', 'project.publish',
]);

function integer(value, label) {
  if (!Number.isInteger(value)) throw new TypeError(`${label} must be an integer.`);
  return value;
}

function color(value, label = 'color') {
  if (typeof value !== 'string' || !COLOR.test(value)) throw new TypeError(`${label} must use #RRGGBB format.`);
  return value.toUpperCase();
}

function coordinate(doc, x, y) {
  integer(x, 'x'); integer(y, 'y');
  if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) throw new RangeError('Coordinates are outside the canvas.');
}

function rectangle(doc, x, y, width, height) {
  integer(x, 'x'); integer(y, 'y'); integer(width, 'width'); integer(height, 'height');
  if (width < 1 || height < 1 || x < 0 || y < 0 || x + width > doc.width || y + height > doc.height) {
    throw new RangeError('Rectangle must fit completely inside the canvas.');
  }
}

function plainResult(value) {
  return JSON.parse(JSON.stringify(value));
}

function encodeBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

function symmetryPoints(doc, point, mode) {
  if (mode === 0) return [point];
  const cx = (doc.width - 1) / 2, cy = (doc.height - 1) / 2;
  const dx = point.x - cx, dy = point.y - cy;
  let offsets;
  if (mode === 2) offsets = [[dx, dy], [-dx, dy]];
  else if (mode === 4) offsets = [[dx, dy], [-dx, dy], [dx, -dy], [-dx, -dy]];
  else offsets = [[dx, dy], [-dy, dx], [-dx, -dy], [dy, -dx], [-dx, dy], [-dy, -dx], [dx, -dy], [dy, dx]];
  return offsets.map(([ox, oy]) => {
    const x = Math.round(cx + ox), y = Math.round(cy + oy);
    return x < 0 || y < 0 || x >= doc.width || y >= doc.height ? null : { x, y };
  });
}

function strokeToWithSymmetry(doc, stroke, x, y, mode) {
  if (mode === 0) { doc.strokeTo(stroke, x, y); return; }
  const points = symmetryPoints(doc, { x, y }, mode);
  const previous = stroke.symmetryLastPoints ?? [];
  const next = [];
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    if (!point) { next[index] = null; continue; }
    stroke.last = previous[index] ?? null;
    doc.strokeTo(stroke, point.x, point.y);
    next[index] = stroke.last;
  }
  stroke.symmetryLastPoints = next;
  stroke.last = next[0] ?? null;
}

/**
 * Provider-independent, allowlisted tool executor. It can only reach the AI
 * sandbox and only exposes structured actions; no arbitrary code or I/O.
 */
export class AICommandSession {
  #workspace;
  #clipboard = null;

  constructor(workspace) {
    if (!(workspace instanceof AIWorkspace)) throw new TypeError('Expected an AIWorkspace.');
    this.#workspace = workspace;
  }

  execute(action) {
    if (!action || typeof action !== 'object' || Array.isArray(action) ||
        typeof action.name !== 'string' || !action.name.trim()) {
      return { ok: false, error: { code: 'invalid_action', message: 'Action must be an object with a name.' } };
    }
    if (DENIED_ACTIONS.has(action.name)) {
      return { ok: false, error: { code: 'permission_denied', message: 'AI tools cannot delete, export, upload, or publish a project.' } };
    }
    const readOnlyActions = new Set(['document.get_summary', 'canvas.get_reference', 'canvas.get_pixel', 'canvas.get_region', 'canvas.preview_transform_region']);
    if (this.#workspace.hasProposal && !readOnlyActions.has(action.name)) {
      return { ok: false, action: action.name, error: { code: 'proposal_pending', message: 'Accept or discard the pending proposal before making more sandbox edits.' } };
    }
    try {
      const doc = this.#workspace.sandbox;
      let result;
      switch (action.name) {
        case 'document.get_summary':
          result = {
            name: doc.name, width: doc.width, height: doc.height,
            revision: doc.revision, activeLayerId: doc.activeLayerId,
            layerCount: doc.layers.length,
            layers: doc.layers.map((layer, index) => ({
              index, id: layer.id, name: layer.name, visible: layer.visible,
              locked: layer.locked, opacity: layer.opacity,
            })),
          };
          break;
        case 'document.rename':
          result = { renamed: doc.renameDocument(action.newName), name: doc.name };
          break;
        case 'canvas.get_reference': {
          const gridStep = action.gridStep ?? 8;
          integer(gridStep, 'gridStep');
          if (gridStep < 1 || gridStep > 256) throw new RangeError('gridStep must be between 1 and 256 pixels.');
          const maxX = doc.width - 1, maxY = doc.height - 1;
          const point = (x, y) => ({ x: Math.round(x), y: Math.round(y) });
          const at = (xRatio, yRatio) => point(maxX * xRatio, maxY * yRatio);
          const xLines = [], yLines = [];
          for (let x = 0; x <= maxX && xLines.length < 512; x += gridStep) xLines.push(x);
          for (let y = 0; y <= maxY && yLines.length < 512; y += gridStep) yLines.push(y);
          if (xLines[xLines.length - 1] !== maxX) xLines.push(maxX);
          if (yLines[yLines.length - 1] !== maxY) yLines.push(maxY);
          const active = doc.activeLayer;
          result = {
            coordinateSystem: { unit: 'pixel', origin: 'top-left', xAxis: 'right', yAxis: 'down', integerCoordinates: 'pixel indices; (0,0) is the top-left pixel', bounds: { minX: 0, minY: 0, maxX, maxY, width: doc.width, height: doc.height } },
            landmarks: {
              topLeft: point(0, 0), topCenter: at(0.5, 0), topRight: point(maxX, 0),
              middleLeft: at(0, 0.5), center: at(0.5, 0.5), middleRight: at(1, 0.5),
              bottomLeft: point(0, maxY), bottomCenter: at(0.5, 1), bottomRight: point(maxX, maxY),
              quarterPoints: { topLeft: at(0.25, 0.25), topRight: at(0.75, 0.25), bottomLeft: at(0.25, 0.75), bottomRight: at(0.75, 0.75) },
            },
            grid: { step: gridStep, xLines, yLines, includesCanvasEdges: true },
            activeLayer: { id: active.id, name: active.name, index: doc.layers.findIndex(layer => layer.id === active.id), visible: active.visible, locked: active.locked, opacity: active.opacity },
            layers: doc.layers.map((layer, index) => ({ id: layer.id, name: layer.name, index, visible: layer.visible, locked: layer.locked, opacity: layer.opacity })),
          };
          break;
        }
        case 'canvas.get_pixel': {
          coordinate(doc, action.x, action.y);
          const merged = action.merged ?? true;
          if (typeof merged !== 'boolean') throw new TypeError('merged must be a boolean.');
          result = { x: action.x, y: action.y, color: doc.sampleColorAt(action.x, action.y, { merged }) };
          break;
        }
        case 'canvas.get_region': {
          const { x, y, width, height } = action;
          rectangle(doc, x, y, width, height);
          if (width > 32 || height > 32 || width * height > 1024) {
            throw new RangeError('Region reads are limited to 32 × 32 pixels (1,024 pixels total) so agent responses remain complete.');
          }
          const merged = action.merged ?? true;
          if (typeof merged !== 'boolean') throw new TypeError('merged must be a boolean.');
          if (merged && action.layerId !== undefined) throw new TypeError('layerId cannot be used when merged is true.');
          const layer = merged ? null : action.layerId === undefined
            ? doc.activeLayer
            : doc.layers.find(item => item.id === action.layerId);
          if (!merged && !layer) throw new Error('Requested raster layer was not found.');
          const source = merged ? doc.composite() : layer.pixels;
          const pixels = new Uint8ClampedArray(width * height * 4);
          for (let row = 0; row < height; row++) {
            const start = ((y + row) * doc.width + x) * 4;
            pixels.set(source.subarray(start, start + width * 4), row * width * 4);
          }
          result = {
            origin: { x, y }, width, height, merged,
            layerId: layer?.id ?? null,
            encoding: 'rgba8-base64',
            pixels: encodeBase64(pixels),
          };
          break;
        }
        case 'canvas.draw_line': {
          const { x0, y0, x1, y1 } = action;
          coordinate(doc, x0, y0); coordinate(doc, x1, y1);
          const paintColor = color(action.color);
          const size = action.size ?? 1;
          integer(size, 'size');
          if (size < 1 || size > 128) throw new RangeError('Brush size must be between 1 and 128 pixels.');
          const symmetryMode = action.symmetryMode ?? 0;
          if (![0, 2, 4, 8].includes(symmetryMode)) throw new RangeError('symmetryMode must be 0, 2, 4, or 8.');
          const stroke = doc.beginStroke({ color: paintColor, size });
          try {
            strokeToWithSymmetry(doc, stroke, x0, y0, symmetryMode);
            strokeToWithSymmetry(doc, stroke, x1, y1, symmetryMode);
            result = { changed: doc.endStroke(stroke), symmetryMode, bounds: { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0) + 1, height: Math.abs(y1 - y0) + 1 } };
          } catch (error) {
            doc.endStroke(stroke, { commit: false });
            throw error;
          }
          break;
        }
        case 'canvas.draw_stroke': {
          if (!Array.isArray(action.points) || action.points.length < 1 || action.points.length > 4096) throw new TypeError('points must contain 1–4096 coordinates.');
          for (const point of action.points) coordinate(doc, point?.x, point?.y);
          const size = action.size ?? 1, opacity = action.opacity ?? 1, hardness = action.hardness ?? 1;
          integer(size, 'size');
          if (size < 1 || size > 128 || !Number.isFinite(opacity) || opacity < 0 || opacity > 1 ||
              !Number.isFinite(hardness) || hardness < 0 || hardness > 1) throw new RangeError('Brush size, opacity or hardness is outside the supported range.');
          const mode = action.mode ?? 'draw', shape = action.shape ?? 'square';
          const symmetryMode = action.symmetryMode ?? 0;
          if (!['draw', 'erase'].includes(mode) || !['square', 'circle'].includes(shape)) throw new TypeError('Unsupported brush mode or shape.');
          if (![0, 2, 4, 8].includes(symmetryMode)) throw new RangeError('symmetryMode must be 0, 2, 4, or 8.');
          const stroke = doc.beginStroke({ color: color(action.color), size, opacity, hardness, shape, mode });
          try {
            for (const point of action.points) strokeToWithSymmetry(doc, stroke, point.x, point.y, symmetryMode);
            result = { changed: doc.endStroke(stroke), pointCount: action.points.length, symmetryMode };
          } catch (error) {
            doc.endStroke(stroke, { commit: false });
            throw error;
          }
          break;
        }
        case 'layer.add': {
          const layer = doc.addLayer(action.layerName ?? undefined);
          result = { layerId: layer.id, name: layer.name, index: doc.layers.length - 1 };
          break;
        }
        case 'layer.select':
          if (typeof action.layerId !== 'string') throw new TypeError('layerId is required.');
          doc.setActiveLayer(action.layerId);
          result = { activeLayerId: doc.activeLayerId };
          break;
        case 'layer.move': {
          if (typeof action.layerId !== 'string') throw new TypeError('layerId is required.');
          result = { moved: doc.moveLayer(action.layerId, integer(action.targetIndex, 'targetIndex')) };
          break;
        }
        case 'layer.rename': {
          if (typeof action.layerId !== 'string') throw new TypeError('layerId is required.');
          result = { renamed: doc.renameLayer(action.layerId, action.newName), layerId: action.layerId };
          break;
        }
        case 'layer.set_opacity': {
          if (typeof action.layerId !== 'string') throw new TypeError('layerId is required.');
          if (!Number.isFinite(action.opacity)) throw new TypeError('opacity must be a finite number.');
          result = { changed: doc.setLayerOpacity(action.layerId, action.opacity) };
          break;
        }
        case 'layer.set_visibility': {
          if (typeof action.layerId !== 'string' || typeof action.visible !== 'boolean') throw new TypeError('layerId and boolean visible are required.');
          doc.setLayerVisibility(action.layerId, action.visible);
          result = { layerId: action.layerId, visible: action.visible };
          break;
        }
        case 'layer.set_locked': {
          if (typeof action.layerId !== 'string' || typeof action.locked !== 'boolean') throw new TypeError('layerId and boolean locked are required.');
          doc.setLayerLocked(action.layerId, action.locked);
          result = { layerId: action.layerId, locked: action.locked };
          break;
        }
        case 'layer.duplicate': {
          if (typeof action.layerId !== 'string') throw new TypeError('layerId is required.');
          const layer = doc.duplicateLayer(action.layerId, action.layerName);
          result = { layerId: layer.id, name: layer.name, index: doc.layers.findIndex(item => item.id === layer.id) };
          break;
        }
        case 'layer.delete': {
          if (typeof action.layerId !== 'string') throw new TypeError('layerId is required.');
          const removed = doc.deleteLayer(action.layerId);
          result = { deletedLayerId: removed.id, activeLayerId: doc.activeLayerId };
          break;
        }
        case 'canvas.fill': {
          coordinate(doc, action.x, action.y);
          const tolerance = action.tolerance ?? 0;
          integer(tolerance, 'tolerance');
          if (tolerance < 0 || tolerance > 255) throw new RangeError('Tolerance must be between 0 and 255.');
          const contiguous = action.contiguous ?? true;
          if (typeof contiguous !== 'boolean') throw new TypeError('contiguous must be a boolean.');
          const pattern = action.pattern ?? 'solid';
          if (!['solid', 'checker'].includes(pattern)) throw new TypeError('pattern must be solid or checker.');
          const secondaryColor = color(action.secondaryColor ?? '#FFFFFF', 'secondaryColor');
          const scale = action.scale ?? 1;
          integer(scale, 'scale');
          if (scale < 1 || scale > 16) throw new RangeError('Dither scale must be between 1 and 16.');
          result = { changedPixels: doc.fillAt(action.x, action.y, {
            color: color(action.color), tolerance, contiguous, pattern, secondaryColor, scale,
          }), pattern, scale };
          break;
        }
        case 'canvas.clear_region':
          rectangle(doc, action.x, action.y, action.width, action.height);
          result = { changedPixels: doc.clearRect(action.x, action.y, action.width, action.height) };
          break;
        case 'canvas.copy_region': {
          rectangle(doc, action.x, action.y, action.width, action.height);
          this.#clipboard = doc.copyRect(action.x, action.y, action.width, action.height);
          result = { copied: true, x: this.#clipboard.x, y: this.#clipboard.y,
            width: this.#clipboard.width, height: this.#clipboard.height,
            selectedPixels: this.#clipboard.mask.reduce((sum, value) => sum + value, 0) };
          break;
        }
        case 'canvas.paste_region': {
          if (!this.#clipboard) throw new Error('There is no copied PixelForge region in this Headless session.');
          const x = integer(action.x ?? this.#clipboard.x, 'x');
          const y = integer(action.y ?? this.#clipboard.y, 'y');
          if (x < -doc.width || y < -doc.height || x > doc.width || y > doc.height) {
            throw new RangeError('Paste position is too far outside the canvas.');
          }
          result = { changedPixels: doc.pasteRect(this.#clipboard, { x, y }), x, y,
            width: this.#clipboard.width, height: this.#clipboard.height };
          break;
        }
        case 'canvas.crop':
          rectangle(doc, action.x, action.y, action.width, action.height);
          result = { changed: doc.cropCanvas(action.x, action.y, action.width, action.height), width: action.width, height: action.height };
          break;
        case 'canvas.draw_shape': {
          const shape = action.shape;
          rectangle(doc, action.x, action.y, action.width, action.height);
          if (!['rectangle', 'ellipse'].includes(shape)) throw new TypeError('shape must be rectangle or ellipse.');
          const size = action.size ?? 1;
          integer(size, 'size');
          if (size < 1 || size > 128) throw new RangeError('Shape stroke size must be between 1 and 128 pixels.');
          let points;
          if (shape === 'rectangle') {
            points = [
              { x: action.x, y: action.y },
              { x: action.x + action.width - 1, y: action.y },
              { x: action.x + action.width - 1, y: action.y + action.height - 1 },
              { x: action.x, y: action.y + action.height - 1 },
              { x: action.x, y: action.y },
            ];
          } else {
            const cx = action.x + (action.width - 1) / 2, cy = action.y + (action.height - 1) / 2;
            const rx = Math.max(0.5, (action.width - 1) / 2), ry = Math.max(0.5, (action.height - 1) / 2);
            const count = Math.min(4096, Math.max(24, Math.ceil(2 * Math.PI * Math.max(rx, ry) * 1.5)));
            points = Array.from({ length: count + 1 }, (_, index) => {
              const angle = index / count * Math.PI * 2;
              return { x: Math.max(action.x, Math.min(action.x + action.width - 1, Math.round(cx + rx * Math.cos(angle)))),
                y: Math.max(action.y, Math.min(action.y + action.height - 1, Math.round(cy + ry * Math.sin(angle)))) };
            });
          }
          const stroke = doc.beginStroke({ color: color(action.color), size });
          try {
            for (const point of points) doc.strokeTo(stroke, point.x, point.y);
            result = { changed: doc.endStroke(stroke), shape, pointCount: points.length };
          } catch (error) {
            doc.endStroke(stroke, { commit: false });
            throw error;
          }
          break;
        }
        case 'canvas.fill_gradient': {
          coordinate(doc, action.x0, action.y0); coordinate(doc, action.x1, action.y1);
          const opacity = action.opacity ?? 1;
          if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new RangeError('Gradient opacity must be between 0 and 1.');
          result = { changedPixels: doc.fillGradient(action.x0, action.y0, action.x1, action.y1, {
            startColor: color(action.startColor, 'startColor'), endColor: color(action.endColor, 'endColor'), opacity
          }) };
          break;
        }
        case 'canvas.flip_region': {
          rectangle(doc, action.x, action.y, action.width, action.height);
          if (!['horizontal', 'vertical'].includes(action.axis)) throw new TypeError('axis must be horizontal or vertical.');
          result = { changedPixels: doc.flipRect(action.x, action.y, action.width, action.height, action.axis) };
          break;
        }
        case 'canvas.create_outline':
          result = { changedPixels: doc.createOutline(color(action.color), { diagonals: action.diagonals !== false }) };
          break;
        case 'canvas.replace_color': {
          const tolerance = action.tolerance ?? 0;
          integer(tolerance, 'tolerance');
          if (tolerance < 0 || tolerance > 255) throw new RangeError('Tolerance must be between 0 and 255.');
          result = { changedPixels: doc.replaceColor(color(action.from, 'from'), color(action.to, 'to'), tolerance) };
          break;
        }
        case 'canvas.preview_transform_region': {
          rectangle(doc, action.x, action.y, action.width, action.height);
          const dx = action.dx ?? 0, dy = action.dy ?? 0, rotate = action.rotate ?? 0;
          const scaleX = action.scaleX ?? 1, scaleY = action.scaleY ?? 1;
          const skewX = action.skewX ?? 0, skewY = action.skewY ?? 0;
          const interpolation = action.interpolation ?? 'nearest';
          integer(dx, 'dx'); integer(dy, 'dy'); integer(rotate, 'rotate');
          if (![0, 90, 180, 270].includes(rotate)) throw new RangeError('rotate must be 0, 90, 180, or 270 degrees.');
          if (![scaleX, scaleY, skewX, skewY].every(Number.isFinite)) throw new TypeError('scaleX, scaleY, skewX and skewY must be finite numbers.');
          if (!['nearest', 'bilinear'].includes(interpolation)) throw new TypeError('interpolation must be nearest or bilinear.');
          const preview = doc.previewTransformRect(action.x, action.y, action.width, action.height, {
            dx, dy, rotate, scaleX, scaleY, skewX, skewY, interpolation,
          });
          result = { selectedPixels: preview.selectedPixels, bounds: preview.bounds,
            rect: preview.rect, options: preview.options };
          break;
        }
        case 'canvas.transform_region': {
          rectangle(doc, action.x, action.y, action.width, action.height);
          const dx = action.dx ?? 0, dy = action.dy ?? 0, rotate = action.rotate ?? 0;
          const scaleX = action.scaleX ?? 1, scaleY = action.scaleY ?? 1;
          const skewX = action.skewX ?? 0, skewY = action.skewY ?? 0;
          const interpolation = action.interpolation ?? 'nearest';
          integer(dx, 'dx'); integer(dy, 'dy'); integer(rotate, 'rotate');
          if (![0, 90, 180, 270].includes(rotate)) throw new RangeError('rotate must be 0, 90, 180, or 270 degrees.');
          if (![scaleX, scaleY, skewX, skewY].every(Number.isFinite)) throw new TypeError('scaleX, scaleY, skewX and skewY must be finite numbers.');
          if (!['nearest', 'bilinear'].includes(interpolation)) throw new TypeError('interpolation must be nearest or bilinear.');
          const transformed = doc.transformRect(action.x, action.y, action.width, action.height, {
            dx, dy, rotate, scaleX, scaleY, skewX, skewY, interpolation,
          });
          result = { changedPixels: transformed.changedPixels, selectedPixels: transformed.selectedPixels, bounds: transformed.bounds };
          break;
        }
        case 'selection.clear': {
          const cleared = Boolean(doc.selectionMask);
          doc.setSelectionMask(null);
          result = { cleared };
          break;
        }
        case 'selection.create_rect': {
          rectangle(doc, action.x, action.y, action.width, action.height);
          const mask = new Uint8Array(doc.width * doc.height);
          for (let y = action.y; y < action.y + action.height; y++) {
            mask.fill(1, y * doc.width + action.x, y * doc.width + action.x + action.width);
          }
          doc.setSelectionMask(mask);
          result = { x: action.x, y: action.y, width: action.width, height: action.height, selectedPixels: action.width * action.height };
          break;
        }
        case 'selection.create_ellipse':
        case 'selection.create_lasso': {
          rectangle(doc, action.x, action.y, action.width, action.height);
          const selection = action.name === 'selection.create_ellipse'
            ? { x: action.x, y: action.y, width: action.width, height: action.height, shape: 'ellipse' }
            : { x: action.x, y: action.y, width: action.width, height: action.height, shape: 'polygon', points: action.points };
          const mask = createSelectionMask(doc.width, doc.height, selection);
          doc.setSelectionMask(mask);
          result = { x: action.x, y: action.y, width: action.width, height: action.height, selectedPixels: mask.reduce((sum, value) => sum + value, 0) };
          break;
        }
        case 'selection.create_magic': {
          coordinate(doc, action.x, action.y);
          const tolerance = action.tolerance ?? 0;
          integer(tolerance, 'tolerance');
          if (tolerance < 0 || tolerance > 255) throw new RangeError('Color-selection tolerance must be between 0 and 255.');
          const contiguous = action.contiguous ?? true;
          if (typeof contiguous !== 'boolean') throw new TypeError('contiguous must be a boolean.');
          const operation = action.operation ?? 'replace';
          if (!['replace', 'add', 'subtract', 'intersect'].includes(operation)) throw new TypeError('Selection operation must be replace, add, subtract, or intersect.');
          const nextMask = createColorSelectionMask(doc.width, doc.height, doc.activeLayer.pixels, action.x, action.y, { tolerance, contiguous });
          const mask = combineSelectionMasks(doc.width, doc.height, doc.selectionMask, nextMask, operation);
          doc.setSelectionMask(mask);
          result = { operation, tolerance, contiguous, selectedPixels: mask.reduce((sum, value) => sum + value, 0) };
          break;
        }
        case 'selection.modify': {
          const operation = action.operation;
          const current = doc.selectionMask;
          if (!current) throw new Error('There is no active selection to modify.');
          const mask = modifySelectionMask(doc.width, doc.height, current, operation, action.radius ?? 1);
          doc.setSelectionMask(mask);
          result = { operation, selectedPixels: mask.reduce((sum, value) => sum + value, 0) };
          break;
        }
        case 'selection.combine': {
          const operation = action.operation ?? 'replace';
          const nextMask = action.selection === null ? null : createSelectionMask(doc.width, doc.height, action.selection);
          const mask = combineSelectionMasks(doc.width, doc.height, doc.selectionMask, nextMask, operation);
          doc.setSelectionMask(mask);
          result = { operation, selectedPixels: mask ? mask.reduce((sum, value) => sum + value, 0) : 0 };
          break;
        }
        case 'selection.translate': {
          if (!doc.selectionMask) throw new Error('There is no active selection to translate.');
          const dx = integer(action.dx, 'dx'), dy = integer(action.dy, 'dy');
          const mask = translateSelectionMask(doc.width, doc.height, doc.selectionMask, dx, dy);
          doc.setSelectionMask(mask);
          result = { dx, dy, selectedPixels: mask.reduce((sum, value) => sum + value, 0) };
          break;
        }
        case 'history.undo':
          result = { changed: doc.undo() };
          break;
        case 'history.redo':
          result = { changed: doc.redo() };
          break;
        default:
          return { ok: false, error: { code: 'unknown_action', message: `Unsupported AI action: ${action.name}` } };
      }
      return { ok: true, action: action.name, result: plainResult(result) };
    } catch (error) {
      return {
        ok: false,
        action: action.name,
        error: {
          code: error instanceof RangeError ? 'out_of_bounds_or_limit' : error instanceof TypeError ? 'invalid_arguments' : 'operation_failed',
          message: error instanceof Error ? error.message : 'The operation failed.',
        },
      };
    }
  }

  isForWorkspace(workspace) { return this.#workspace === workspace; }

  createProposal(summary) {
    return this.#workspace.createProposal(summary);
  }
}
