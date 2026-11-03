import { AIWorkspace } from './workspaces.js';

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

/**
 * Provider-independent, allowlisted tool executor. It can only reach the AI
 * sandbox and only exposes structured actions; no arbitrary code or I/O.
 */
export class AICommandSession {
  #workspace;

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
    const readOnlyActions = new Set(['document.get_summary', 'canvas.get_pixel']);
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
        case 'canvas.get_pixel': {
          coordinate(doc, action.x, action.y);
          const merged = action.merged ?? true;
          if (typeof merged !== 'boolean') throw new TypeError('merged must be a boolean.');
          result = { x: action.x, y: action.y, color: doc.sampleColorAt(action.x, action.y, { merged }) };
          break;
        }
        case 'canvas.draw_line': {
          const { x0, y0, x1, y1 } = action;
          coordinate(doc, x0, y0); coordinate(doc, x1, y1);
          const paintColor = color(action.color);
          const size = action.size ?? 1;
          integer(size, 'size');
          if (size < 1 || size > 128) throw new RangeError('Brush size must be between 1 and 128 pixels.');
          const stroke = doc.beginStroke({ color: paintColor, size });
          try {
            doc.strokeTo(stroke, x0, y0);
            doc.strokeTo(stroke, x1, y1);
            result = { changed: doc.endStroke(stroke), bounds: { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0) + 1, height: Math.abs(y1 - y0) + 1 } };
          } catch (error) {
            doc.endStroke(stroke, { commit: false });
            throw error;
          }
          break;
        }
        case 'canvas.fill': {
          coordinate(doc, action.x, action.y);
          const tolerance = action.tolerance ?? 0;
          integer(tolerance, 'tolerance');
          if (tolerance < 0 || tolerance > 255) throw new RangeError('Tolerance must be between 0 and 255.');
          const contiguous = action.contiguous ?? true;
          if (typeof contiguous !== 'boolean') throw new TypeError('contiguous must be a boolean.');
          result = { changedPixels: doc.fillAt(action.x, action.y, { color: color(action.color), tolerance, contiguous }) };
          break;
        }
        case 'canvas.clear_region':
          rectangle(doc, action.x, action.y, action.width, action.height);
          result = { changedPixels: doc.clearRect(action.x, action.y, action.width, action.height) };
          break;
        case 'canvas.replace_color': {
          const tolerance = action.tolerance ?? 0;
          integer(tolerance, 'tolerance');
          if (tolerance < 0 || tolerance > 255) throw new RangeError('Tolerance must be between 0 and 255.');
          result = { changedPixels: doc.replaceColor(color(action.from, 'from'), color(action.to, 'to'), tolerance) };
          break;
        }
        case 'canvas.transform_region': {
          rectangle(doc, action.x, action.y, action.width, action.height);
          const dx = action.dx ?? 0, dy = action.dy ?? 0, rotate = action.rotate ?? 0;
          integer(dx, 'dx'); integer(dy, 'dy'); integer(rotate, 'rotate');
          if (![0, 90, 180, 270].includes(rotate)) throw new RangeError('rotate must be 0, 90, 180, or 270 degrees.');
          const transformed = doc.transformRect(action.x, action.y, action.width, action.height, { dx, dy, rotate });
          result = { changedPixels: transformed.changedPixels, selectedPixels: transformed.selectedPixels, bounds: transformed.bounds };
          break;
        }
        case 'selection.clear':
          doc.setSelectionMask(null);
          result = { cleared: true };
          break;
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
