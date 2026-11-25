/**
 * Bounded, transactional undo/redo for sparse tiled brush strokes.
 *
 * Stores only changed dab rectangles, never a full-canvas snapshot. A stroke
 * exceeding its configured byte budget is rolled back atomically.
 */
import { applyTiledBrushDab } from './raster-tiled-brush.mjs';

function dabRegion(document, x, y, size) {
  const offset = Math.floor((Math.round(size) - 1) / 2);
  const left = Math.max(0, x - offset), top = Math.max(0, y - offset);
  return {
    x: left, y: top,
    width: Math.min(document.width - 1, x - offset + Math.round(size) - 1) - left + 1,
    height: Math.min(document.height - 1, y - offset + Math.round(size) - 1) - top + 1,
  };
}

function copyPixels(pixels) {
  return new Uint8ClampedArray(pixels);
}

export class TiledRasterStrokeHistory {
  #document;
  #maxBytes;
  #maxCommands;
  #undo = [];
  #redo = [];
  #active = null;
  #disposed = false;

  constructor(document, { maxBytes = 16 * 1024 * 1024, maxCommands = 50 } = {}) {
    if (!document || typeof document.readRegion !== 'function' || typeof document.writeRegion !== 'function') {
      throw new TypeError('A tile-aware raster project document is required.');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 8 || !Number.isSafeInteger(maxCommands) || maxCommands < 1) {
      throw new RangeError('History limits must be positive safe integers.');
    }
    this.#document = document;
    this.#maxBytes = maxBytes;
    this.#maxCommands = maxCommands;
  }

  get canUndo() { return this.#undo.length > 0; }
  get canRedo() { return this.#redo.length > 0; }
  get undoStack() { return this.#undo.slice(); }
  get redoStack() { return this.#redo.slice(); }
  get isStrokeActive() { return Boolean(this.#active); }
  get stats() {
    const bytes = stack => stack.reduce((sum, command) =>
      sum + (command.bytes ?? command.entries.reduce((entrySum, entry) => entrySum + entry.before.byteLength + entry.after.byteLength, 0)), 0);
    return {
      undoCommands: this.#undo.length, redoCommands: this.#redo.length,
      activeStrokeBytes: this.#active?.bytes || 0,
      retainedBytes: bytes(this.#undo) + bytes(this.#redo),
      maxBytes: this.#maxBytes, maxCommands: this.#maxCommands,
    };
  }

  async applyTileOperation(layerId, entries, { type = 'tile-operation' } = {}) {
    this.#assertLive();
    if (this.#active) throw new Error('Commit or cancel the active stroke before applying a tile operation.');
    if (!this.#document.layers.some(layer => layer.id === layerId)) throw new Error('Unknown tiled operation layer.');
    if (!Array.isArray(entries) || !entries.length) return false;
    const normalized = entries.map(entry => {
      if (!entry || !Number.isInteger(entry.x) || !Number.isInteger(entry.y) ||
          !(entry.before instanceof Uint8Array || entry.before instanceof Uint8ClampedArray) ||
          !(entry.after instanceof Uint8Array || entry.after instanceof Uint8ClampedArray) ||
          entry.before.byteLength !== entry.after.byteLength) {
        throw new TypeError('Tile operation entries must contain matching before/after tile buffers.');
      }
      return { x: entry.x, y: entry.y, before: copyPixels(entry.before), after: copyPixels(entry.after) };
    });
    const bytes = normalized.reduce((sum, entry) => sum + entry.before.byteLength + entry.after.byteLength, 0);
    if (bytes > this.#maxBytes) throw new RangeError('Tile operation exceeded the sparse undo history byte budget.');
    const result = await this.#document.writeTileBatch(layerId,
      normalized.map(({ x, y, after }) => ({ x, y, pixels: after })), { maxBytes: this.#maxBytes });
    if (!result.changed) return false;
    this.#undo.push({ type, layerId, entries: normalized, bytes });
    for (const command of this.#redo) this.#releaseCommand(command);
    this.#redo = [];
    this.#trimHistory();
    return true;
  }

  recordLayerState(type, before, after) {
    this.#assertLive();
    if (this.#active) throw new Error('Commit or cancel the active stroke before changing layers.');
    if (!before?.layers?.length || !after?.layers?.length) throw new TypeError('Layer history requires complete before/after states.');
    const estimate = state => JSON.stringify({
      activeLayerId: state.activeLayerId,
      layers: state.layers.map(({ celId, ...metadata }) => metadata),
    }).length * 2;
    const bytes = estimate(before) + estimate(after);
    if (bytes > this.#maxBytes) {
      throw new RangeError('Layer operation exceeded the sparse undo history byte budget.');
    }
    for (const command of this.#redo) this.#releaseCommand(command);
    this.#redo = [];
    this.#undo.push({ type: 'layer-state:' + type, before, after, bytes });
    this.#trimHistory();
    return true;
  }

  #releaseCommand(command) {
    if (command?.type?.startsWith('layer-state:')) {
      this.#document.releaseLayerState(command.before);
      this.#document.releaseLayerState(command.after);
    }
  }

  #trimHistory() {
    while (this.#undo.length > this.#maxCommands ||
      this.#undo.reduce((sum, item) => sum + item.bytes, 0) > this.#maxBytes) {
      this.#releaseCommand(this.#undo.shift());
    }
  }

  beginStroke(layerId, settings = {}) {
    this.#assertLive();
    if (this.#active) throw new Error('A tiled brush stroke is already active.');
    if (!this.#document.layers.some(layer => layer.id === layerId)) throw new Error('Unknown tiled brush layer.');
    this.#active = { type: 'pixels', layerId, settings: { ...settings }, entries: [], bytes: 0 };
    return this.#active;
  }

  async dab(x, y) {
    this.#assertActive();
    const stroke = this.#active;
    const size = Math.round(stroke.settings.size ?? 1);
    const region = dabRegion(this.#document, x, y, size);
    const before = copyPixels(this.#document.readRegion(stroke.layerId, region));
    const entryBytes = before.byteLength * 2;
    if (stroke.bytes + entryBytes > this.#maxBytes) {
      await this.cancelStroke();
      throw new RangeError('Stroke exceeded the sparse undo history byte budget and was rolled back.');
    }
    const result = await applyTiledBrushDab(this.#document, stroke.layerId, x, y, stroke.settings);
    if (!result.changed) return result;
    const after = copyPixels(this.#document.readRegion(stroke.layerId, region));
    stroke.entries.push({ region, before, after });
    stroke.bytes += before.byteLength + after.byteLength;
    return result;
  }

  async segment(from, to) {
    this.#assertActive();
    if (!from || !to || !Number.isInteger(from.x) || !Number.isInteger(from.y) ||
        !Number.isInteger(to.x) || !Number.isInteger(to.y)) {
      throw new TypeError('Brush segment endpoints must be integer document coordinates.');
    }
    const dx = to.x - from.x, dy = to.y - from.y;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) * 1.5));
    let changedDabs = 0, changedPixels = 0;
    for (let index = 1; index <= steps; index++) {
      const x = Math.round(from.x + dx * index / steps);
      const y = Math.round(from.y + dy * index / steps);
      const result = await this.dab(x, y);
      if (result.changed) changedDabs++;
      changedPixels += result.changedPixels || 0;
    }
    return { changed: changedDabs > 0, changedDabs, changedPixels };
  }

  commitStroke() {
    this.#assertActive();
    const command = this.#active;
    this.#active = null;
    if (!command.entries.length) return false;
    this.#undo.push(command);
    for (const command of this.#redo) this.#releaseCommand(command);
    this.#redo = [];
    while (this.#undo.length > this.#maxCommands ||
      this.#undo.reduce((sum, item) => sum + item.bytes, 0) > this.#maxBytes) {
      this.#undo.shift();
    }
    return true;
  }

  async cancelStroke() {
    this.#assertActive();
    const command = this.#active;
    this.#active = null;
    for (let index = command.entries.length - 1; index >= 0; index--) {
      const entry = command.entries[index];
      await this.#document.writeRegion(command.layerId, entry.region, entry.before);
    }
    return command.entries.length > 0;
  }

  async undo() {
    this.#assertLive();
    if (this.#active) throw new Error('Commit or cancel the active stroke before undo.');
    const command = this.#undo.pop();
    if (!command) return false;
    if (command.type?.startsWith('layer-state:')) {
      try { this.#document.restoreLayerState(command.before); }
      catch (error) { this.#undo.push(command); throw error; }
      this.#redo.push(command);
      return true;
    }
    if (command.entries[0]?.region) {
      for (let index = command.entries.length - 1; index >= 0; index--) {
        const entry = command.entries[index];
        await this.#document.writeRegion(command.layerId, entry.region, entry.before);
      }
    } else {
      await this.#document.writeTileBatch(command.layerId, command.entries.map(({ x, y, before }) => ({ x, y, pixels: before })), { maxBytes: this.#maxBytes, allowLocked: true });
    }
    this.#redo.push(command);
    return true;
  }

  async redo() {
    this.#assertLive();
    if (this.#active) throw new Error('Commit or cancel the active stroke before redo.');
    const command = this.#redo.pop();
    if (!command) return false;
    if (command.type?.startsWith('layer-state:')) {
      try { this.#document.restoreLayerState(command.after); }
      catch (error) { this.#redo.push(command); throw error; }
      this.#undo.push(command);
      return true;
    }
    if (command.entries[0]?.region) {
      for (const entry of command.entries) await this.#document.writeRegion(command.layerId, entry.region, entry.after);
    } else {
      await this.#document.writeTileBatch(command.layerId, command.entries.map(({ x, y, after }) => ({ x, y, pixels: after })), { maxBytes: this.#maxBytes, allowLocked: true });
    }
    this.#undo.push(command);
    return true;
  }

  clear() {
    this.#assertLive();
    if (this.#active) throw new Error('Cancel the active stroke before clearing history.');
    for (const command of [...this.#undo, ...this.#redo]) this.#releaseCommand(command);
    this.#undo = [];
    this.#redo = [];
  }

  dispose() {
    for (const command of [...this.#undo, ...this.#redo]) this.#releaseCommand(command);
    this.#undo = [];
    this.#redo = [];
    this.#active = null;
    this.#disposed = true;
  }

  #assertLive() {
    if (this.#disposed) throw new Error('Tiled raster history has been disposed.');
  }
  #assertActive() {
    this.#assertLive();
    if (!this.#active) throw new Error('Begin a tiled brush stroke first.');
  }
}
