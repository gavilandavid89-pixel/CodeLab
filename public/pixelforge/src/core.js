export const MAX_DIMENSION = 2048;
export const MAX_PIXELS = 4_194_304;
export const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;

export function validateDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new RangeError('Canvas dimensions must be positive integers.');
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) throw new RangeError(`Canvas exceeds the initial safe limit (${MAX_DIMENSION} px per side / ${MAX_PIXELS.toLocaleString()} pixels).`);
  return { width, height };
}

export function rasterLinePoints(x0, y0, x1, y1) {
  if (![x0, y0, x1, y1].every(Number.isInteger)) throw new TypeError('Line coordinates must be integers.');
  const points = [], dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let error = dx + dy, x = x0, y = y0;
  while (true) {
    points.push({ x, y });
    if (x === x1 && y === y1) break;
    const twice = 2 * error;
    if (twice >= dy) { error += dy; x += sx; }
    if (twice <= dx) { error += dx; y += sy; }
  }
  return points;
}

export function modifySelectionMask(width, height, mask, operation, radius = 1) {
  validateDimensions(width, height);
  if (!(mask instanceof Uint8Array) || mask.length !== width * height) throw new TypeError('Selection mask must match document dimensions.');
  if (!['invert', 'expand', 'contract'].includes(operation)) throw new TypeError('Unsupported selection-mask operation.');
  if (!Number.isInteger(radius) || radius < 1 || radius > 16) throw new RangeError('Selection radius must be an integer from 1 to 16.');
  if (operation === 'invert') return Uint8Array.from(mask, value => value ? 0 : 1);
  const cap = radius + 1;
  // Two-pass Manhattan distance transform. The previous neighborhood scan
  // revisited O(radius²) offsets for every pixel; this is O(width × height).
  const distance = new Uint8Array(mask.length);
  if (operation === 'expand') {
    for (let i = 0; i < mask.length; i++) distance[i] = mask[i] === 1 ? 0 : cap;
  } else {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const index = y * width + x;
      distance[index] = mask[index] === 1
        ? Math.min(cap, x + 1, y + 1, width - x, height - y)
        : 0;
    }
  }
  // Forward pass: nearest source above or to the left.
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const index = row + x;
      let best = distance[index];
      if (x > 0 && distance[index - 1] + 1 < best) best = distance[index - 1] + 1;
      if (y > 0 && distance[index - width] + 1 < best) best = distance[index - width] + 1;
      distance[index] = best;
    }
  }
  // Backward pass completes exact four-neighbor Manhattan distances.
  for (let y = height - 1; y >= 0; y--) {
    const row = y * width;
    for (let x = width - 1; x >= 0; x--) {
      const index = row + x;
      let best = distance[index];
      if (x + 1 < width && distance[index + 1] + 1 < best) best = distance[index + 1] + 1;
      if (y + 1 < height && distance[index + width] + 1 < best) best = distance[index + width] + 1;
      distance[index] = best;
    }
  }
  const output = new Uint8Array(mask.length);
  for (let i = 0; i < output.length; i++) {
    output[i] = operation === 'expand' ? (distance[i] <= radius ? 1 : 0) : (distance[i] > radius ? 1 : 0);
  }
  return output;
}

export function combineSelectionMasks(width, height, baseMask, nextMask, operation = 'replace') {
  validateDimensions(width, height);
  const size = width * height;
  for (const mask of [baseMask, nextMask]) {
    if (mask !== null && (!(mask instanceof Uint8Array) || mask.length !== size)) {
      throw new TypeError('Selection masks must be Uint8Arrays matching document dimensions.');
    }
  }
  if (!['replace', 'add', 'subtract', 'intersect'].includes(operation)) throw new TypeError('Unsupported selection combination operation.');
  if (operation === 'replace') return nextMask ? new Uint8Array(nextMask) : null;
  if (baseMask === null) return operation === 'add' && nextMask ? new Uint8Array(nextMask) : new Uint8Array(size);
  if (nextMask === null) return operation === 'intersect' ? new Uint8Array(size) : new Uint8Array(baseMask);
  const output = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    const a = baseMask[i] !== 0, b = nextMask[i] !== 0;
    output[i] = (operation === 'add' ? a || b : operation === 'subtract' ? a && !b : a && b) ? 1 : 0;
  }
  return output;
}

export function translateSelectionMask(width, height, mask, dx, dy) {
  validateDimensions(width, height);
  if (!(mask instanceof Uint8Array) || mask.length !== width * height) throw new TypeError('Selection mask must match document dimensions.');
  if (!Number.isInteger(dx) || !Number.isInteger(dy)) throw new TypeError('Selection offset must use integer pixels.');
  const output = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!mask[y * width + x]) continue;
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < width && ny < height) output[ny * width + nx] = 1;
  }
  return output;
}

export function createColorSelectionMask(width, height, pixels, x, y, { tolerance = 0, contiguous = true } = {}) {
  validateDimensions(width, height);
  if (!(pixels instanceof Uint8ClampedArray) || pixels.length !== width * height * 4) throw new TypeError('Color selection pixels must match document dimensions.');
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) throw new RangeError('Color selection point is outside document bounds.');
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 255 || typeof contiguous !== 'boolean') throw new RangeError('Color selection tolerance/mode is invalid.');
  const offset = (y * width + x) * 4, seed = [...pixels.subarray(offset, offset + 4)];
  const matches = index => {
    if (seed[3] === 0 && pixels[index + 3] === 0) return true;
    for (let channel = 0; channel < 4; channel++) if (Math.abs(pixels[index + channel] - seed[channel]) > tolerance) return false;
    return true;
  };
  const mask = new Uint8Array(width * height);
  if (!contiguous) {
    for (let pixel = 0; pixel < mask.length; pixel++) if (matches(pixel * 4)) mask[pixel] = 1;
    return mask;
  }
  const queue = new Int32Array(width * height); let head = 0, tail = 0;
  const start = y * width + x; queue[tail++] = start; mask[start] = 1;
  while (head < tail) {
    const pixel = queue[head++], px = pixel % width, py = Math.floor(pixel / width);
    const add = next => {
      if (next < 0 || next >= mask.length || mask[next] || !matches(next * 4)) return;
      mask[next] = 1; queue[tail++] = next;
    };
    if (px > 0) add(pixel - 1);
    if (px + 1 < width) add(pixel + 1);
    if (py > 0) add(pixel - width);
    if (py + 1 < height) add(pixel + width);
  }
  return mask;
}

export function createSelectionMask(width, height, selection) {
  validateDimensions(width, height);
  if (selection === null) return null;
  if (!selection || ![selection.x, selection.y, selection.width, selection.height].every(Number.isInteger) ||
      selection.width < 1 || selection.height < 1 || !['rect', 'ellipse', 'polygon'].includes(selection.shape ?? 'rect')) {
    throw new TypeError('Selection must have integer bounds and a supported rect/ellipse/polygon shape.');
  }
  if (selection.shape === 'polygon' && (!Array.isArray(selection.points) || selection.points.length < 3 || selection.points.length > 4096 ||
      selection.points.some(point => !point || !Number.isInteger(point.x) || !Number.isInteger(point.y)))) {
    throw new TypeError('Polygon selection requires 3–4096 integer points.');
  }
  const mask = new Uint8Array(width * height);
  const left = Math.max(0, selection.x), top = Math.max(0, selection.y);
  const right = Math.min(width, selection.x + selection.width), bottom = Math.min(height, selection.y + selection.height);
  if ((selection.shape ?? 'rect') === 'rect') {
    for (let y = top; y < bottom; y++) mask.fill(1, y * width + left, y * width + right);
  } else if (selection.shape === 'ellipse') {
    const cx = selection.x + (selection.width - 1) / 2, cy = selection.y + (selection.height - 1) / 2;
    const rx = Math.max(.5, (selection.width - 1) / 2), ry = Math.max(.5, (selection.height - 1) / 2);
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) mask[y * width + x] = 1;
    }
  } else {
    const points = selection.points;
    // Scanline filling changes polygon rasterization from O(area × vertices) to
    // O(height × vertices + filled area), which matters for detailed freehand lassos.
    const intersections = [];
    for (let y = top; y < bottom; y++) {
      intersections.length = 0;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const a = points[j], b = points[i];
        if ((a.y > y) === (b.y > y) || a.y === b.y) continue;
        intersections.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y));
      }
      intersections.sort((a, b) => a - b);
      for (let i = 0; i + 1 < intersections.length; i += 2) {
        const start = Math.max(left, Math.ceil(intersections[i] - 1e-9));
        const end = Math.min(right - 1, Math.floor(intersections[i + 1] + 1e-9));
        if (end >= start) mask.fill(1, y * width + start, y * width + end + 1);
      }
    }
    // Include the polygon boundary consistently, including horizontal edges.
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      const dx = Math.abs(b.x - a.x), sx = a.x < b.x ? 1 : -1;
      const dy = -Math.abs(b.y - a.y), sy = a.y < b.y ? 1 : -1;
      let error = dx + dy, x = a.x, y = a.y;
      while (true) {
        if (x >= 0 && y >= 0 && x < width && y < height) mask[y * width + x] = 1;
        if (x === b.x && y === b.y) break;
        const twice = 2 * error;
        if (twice >= dy) { error += dy; x += sx; }
        if (twice <= dx) { error += dx; y += sy; }
      }
    }
  }
  return mask;
}

export function screenToDocument(point, viewport, dimensions) {
  const x = Math.floor((point.x - viewport.panX) / viewport.zoom);
  const y = Math.floor((point.y - viewport.panY) / viewport.zoom);
  return { x, y, inside: x >= 0 && y >= 0 && x < dimensions.width && y < dimensions.height };
}

function makeLayer(id, name, width, height) {
  return { id, name, visible: true, opacity: 1, locked: false, pixels: new Uint8ClampedArray(width * height * 4) };
}
function clonePixels(pixels) { return new Uint8ClampedArray(pixels); }
function cloneLayer(layer) { return { ...layer, pixels: clonePixels(layer.pixels) }; }
const TILE_SIZE = 64;
function entryBytes(entry) {
  if (entry.type === 'pixels') return entry.tiles.reduce((sum, tile) => sum + tile.before.byteLength + tile.after.byteLength, 64);
  if (entry.type === 'document-crop') return entry.before.layers.reduce((sum, layer) => sum + layer.pixels.byteLength, 256);
  if (entry.type === 'pixels-batch') return entry.layers.reduce((sum, layer) => sum + layer.tiles.reduce((tileSum, tile) => tileSum + tile.before.byteLength + tile.after.byteLength, 0), 64);
  if (entry.type === 'layer-add') return (entry.addedLayer?.pixels.byteLength ?? 0) + 128;
  if (entry.type === 'layer-delete') return (entry.removedLayer?.pixels.byteLength ?? 0) + 128;
  return 128;
}

export class RasterDocument {
  constructor(width = 128, height = 128, name = 'Untitled artwork') {
    validateDimensions(width, height);
    this.id = crypto.randomUUID();
    this.name = typeof name === 'string' ? name.trim().slice(0, 180) || 'Untitled artwork' : 'Untitled artwork';
    this.width = width;
    this.height = height;
    this.layers = [makeLayer(crypto.randomUUID(), 'Layer 1', width, height)];
    this.compositeCache = new Uint8ClampedArray(width * height * 4);
    this.compositeDirtyTiles = new Set();
    this.#markAllCompositeDirty();
    this.activeLayerId = this.layers[0].id;
    this.revision = 0;
    this.saveVersion = 0;
    this.history = [];
    this.future = [];
    this.maxHistory = 30;
    this.maxHistoryBytes = 64 * 1024 * 1024;
    this.historyBytes = 0;
    this.dirty = false;
    this.selectionMask = null;
  }
  setSelectionMask(mask) {
    if (mask === null) { this.selectionMask = null; return; }
    if (!(mask instanceof Uint8Array) || mask.length !== this.width * this.height) throw new TypeError('Selection mask must be a Uint8Array matching document dimensions.');
    this.selectionMask = new Uint8Array(mask);
  }
  get activeLayer() { return this.layers.find(layer => layer.id === this.activeLayerId) ?? this.layers[0]; }
  addLayer(name = `Layer ${this.layers.length + 1}`) {
    if (typeof name !== 'string' || !name.trim() || name.length > 180) throw new TypeError('Layer name must contain 1–180 characters.');
    name = name.trim();
    if (this.layers.length >= 64) throw new RangeError('The initial editor supports up to 64 layers.');
    if ((this.layers.length + 1) * this.width * this.height * 4 > MAX_DOCUMENT_BYTES) throw new RangeError('Adding this layer would exceed the 64 MiB total pixel-memory budget for this document size. Reduce the canvas dimensions or use fewer layers.');
    const layer = makeLayer(crypto.randomUUID(), name, this.width, this.height);
    this.layers.push(layer);
    this.activeLayerId = layer.id;
    this.#record({ type: 'layer-add', index: this.layers.length - 1, beforeActive: this.layers[this.layers.length - 2]?.id, addedLayer: cloneLayer(layer) });
    return layer;
  }
  setActiveLayer(id) {
    if (!this.layers.some(layer => layer.id === id)) throw new Error('Unknown layer ID.');
    if (this.activeLayerId !== id) { this.activeLayerId = id; this.dirty = true; this.saveVersion++; }
  }
  moveLayer(id, targetIndex) {
    if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= this.layers.length) throw new RangeError('Layer target index is outside the layer stack.');
    const beforeIndex = this.layers.findIndex(layer => layer.id === id);
    if (beforeIndex < 0) throw new Error('Unknown layer ID.');
    if (beforeIndex === targetIndex) return false;
    const [layer] = this.layers.splice(beforeIndex, 1);
    this.layers.splice(targetIndex, 0, layer);
    this.#markAllCompositeDirty();
    this.#record({ type: 'layer-move', layerId: id, beforeIndex, afterIndex: targetIndex });
    return true;
  }
  renameLayer(id, name) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 180) throw new TypeError('Layer name must contain 1–180 characters.');
    const layer = this.layers.find(item => item.id === id);
    if (!layer) throw new Error('Unknown layer ID.');
    const after = name.trim();
    if (layer.name === after) return false;
    const before = layer.name;
    layer.name = after;
    this.#record({ type: 'layer-rename', layerId: id, before, after });
    return true;
  }
  setLayerOpacity(id, opacity) {
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new RangeError('Layer opacity must be between 0 and 1.');
    const layer = this.layers.find(item => item.id === id);
    if (!layer) throw new Error('Unknown layer ID.');
    if (layer.opacity === opacity) return false;
    const before = layer.opacity;
    layer.opacity = opacity;
    this.#markAllCompositeDirty();
    this.#record({ type: 'layer-opacity', layerId: id, before, after: opacity });
    return true;
  }
  duplicateLayer(id, name) {
    const sourceIndex = this.layers.findIndex(item => item.id === id);
    if (sourceIndex < 0) throw new Error('Unknown layer ID.');
    if (this.layers.length >= 64) throw new RangeError('The initial editor supports up to 64 layers.');
    if ((this.layers.length + 1) * this.width * this.height * 4 > MAX_DOCUMENT_BYTES) throw new RangeError('Duplicating this layer would exceed the 64 MiB total pixel-memory budget.');
    const source = this.layers[sourceIndex];
    const duplicate = cloneLayer(source);
    duplicate.id = crypto.randomUUID();
    duplicate.name = typeof name === 'string' && name.trim() ? name.trim().slice(0, 180) : `${source.name} copy`.slice(0, 180);
    this.layers.splice(sourceIndex + 1, 0, duplicate);
    const beforeActive = this.activeLayerId;
    this.activeLayerId = duplicate.id;
    this.#markAllCompositeDirty();
    this.#record({ type: 'layer-add', index: sourceIndex + 1, beforeActive, addedLayer: cloneLayer(duplicate) });
    return duplicate;
  }
  deleteLayer(id) {
    if (this.layers.length <= 1) throw new RangeError('A document must keep at least one layer.');
    const index = this.layers.findIndex(item => item.id === id);
    if (index < 0) throw new Error('Unknown layer ID.');
    const beforeActive = this.activeLayerId;
    const [removedLayer] = this.layers.splice(index, 1);
    if (this.activeLayerId === id) this.activeLayerId = this.layers[Math.min(index, this.layers.length - 1)].id;
    const afterActive = this.activeLayerId;
    this.#markAllCompositeDirty();
    this.#record({ type: 'layer-delete', index, beforeActive, afterActive, removedLayer: cloneLayer(removedLayer) });
    return removedLayer;
  }
  setLayerLocked(id, locked) {
    if (typeof locked !== 'boolean') throw new TypeError('Layer lock must be a boolean.');
    const layer = this.layers.find(item => item.id === id);
    if (!layer) throw new Error('Unknown layer ID.');
    if (layer.locked === locked) return;
    const before = layer.locked;
    layer.locked = locked;
    this.#record({ type: 'layer-lock', layerId: id, before, after: locked });
  }
  setLayerVisibility(id, visible) {
    if (typeof visible !== 'boolean') throw new TypeError('Layer visibility must be a boolean.');
    const layer = this.layers.find(item => item.id === id);
    if (!layer) throw new Error('Unknown layer ID.');
    if (layer.visible === Boolean(visible)) return;
    const before = layer.visible;
    layer.visible = visible;
    this.#markAllCompositeDirty();
    this.#record({ type: 'layer-visibility', layerId: id, before, after: layer.visible });
  }
  beginStroke({ color = '#20202a', size = 1, mode = 'draw', opacity = 1, shape = 'square', hardness = 1 } = {}) {
    const layer = this.activeLayer;
    if (layer.locked) throw new Error('The active layer is locked.');
    if (!Number.isFinite(size) || size < 1 || size > 128) throw new RangeError('Brush size must be between 1 and 128 pixels.');
    if (!['draw', 'erase'].includes(mode)) throw new Error('Unsupported stroke mode.');
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new RangeError('Stroke opacity must be between 0 and 1.');
    if (!['square', 'circle'].includes(shape)) throw new TypeError('Brush shape must be square or circle.');
    if (!Number.isFinite(hardness) || hardness < 0 || hardness > 1) throw new RangeError('Brush hardness must be between 0 and 1.');
    return { layerId: layer.id, tilesBefore: new Map(), color: parseHexColor(color), size: Math.round(size), mode, opacity, shape, hardness, last: null, changed: false };
  }
  strokeTo(stroke, x, y) {
    if (!Number.isInteger(x) || !Number.isInteger(y)) throw new TypeError('Stroke coordinates must be integer document coordinates.');
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) throw new RangeError('Stroke coordinates are outside the document bounds.');
    const layer = this.layers.find(item => item.id === stroke.layerId);
    if (!layer) throw new Error('Stroke layer no longer exists.');
    const point = { x, y };
    if (!stroke.last) this.#dab(layer, point.x, point.y, stroke);
    else {
      const dx = point.x - stroke.last.x, dy = point.y - stroke.last.y;
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) * 1.5));
      for (let i = 1; i <= steps; i++) this.#dab(layer, Math.round(stroke.last.x + dx * i / steps), Math.round(stroke.last.y + dy * i / steps), stroke);
    }
    stroke.last = point;
    stroke.changed = true;
  }
  endStroke(stroke, { commit = true } = {}) {
    const layer = this.layers.find(item => item.id === stroke.layerId);
    if (!layer) return false;
    if (!commit) { this.#restoreTiles(layer, stroke.tilesBefore); return false; }
    if (!stroke.changed || stroke.tilesBefore.size === 0) return false;
    const tiles = [...stroke.tilesBefore.entries()].map(([key, before]) => {
      const [tileX, tileY] = key.split(':').map(Number);
      return { tileX, tileY, before, after: this.#captureTile(layer, tileX, tileY) };
    });
    this.#record({ type: 'pixels', layerId: layer.id, tiles });
    return true;
  }
  fillAt(x, y, { color = '#20202a', tolerance = 0, contiguous = true, pattern = 'solid', secondaryColor = '#ffffff', scale = 1 } = {}) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= this.width || y >= this.height) {
      throw new RangeError('Fill coordinates are outside the document bounds.');
    }
    if (typeof contiguous !== 'boolean') throw new TypeError('Fill mode must be contiguous or global.');
    if (!['solid', 'checker'].includes(pattern)) throw new TypeError('Fill pattern must be solid or checker.');
    if (!Number.isInteger(scale) || scale < 1 || scale > 16) throw new RangeError('Dither scale must be an integer from 1 to 16.');
    if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 255) throw new RangeError('Fill tolerance must be an integer from 0 to 255.');
    const layer = this.activeLayer;
    if (layer.locked) throw new Error('The active layer is locked.');
    const replacement = [...parseHexColor(color), 255], secondary = [...parseHexColor(secondaryColor), 255];
    const seedOffset = (y * this.width + x) * 4;
    const seed = Array.from(layer.pixels.subarray(seedOffset, seedOffset + 4));
    const matches = index => {
      // RGB values under zero alpha are invisible and must not split a transparent fill region.
      if (seed[3] === 0 && layer.pixels[index + 3] === 0) return true;
      for (let channel = 0; channel < 4; channel++) {
        if (Math.abs(layer.pixels[index + channel] - seed[channel]) > tolerance) return false;
      }
      return true;
    };
    if (pattern === 'solid' && tolerance === 0 && seed.every((value, channel) => value === replacement[channel])) return 0;
    const tilesBefore = new Map();
    const paint = index => {
      const pixel = index / 4;
      if (this.selectionMask && !this.selectionMask[pixel]) return false;
      if (!matches(index)) return false;
      const px = pixel % this.width, py = Math.floor(pixel / this.width);
      const pixelReplacement = pattern === 'checker' && (Math.floor(px / scale) + Math.floor(py / scale)) % 2 === 1 ? secondary : replacement;
      if (pixelReplacement.every((value, channel) => layer.pixels[index + channel] === value)) return false;
      const tileX = Math.floor(px / TILE_SIZE), tileY = Math.floor(py / TILE_SIZE), key = `${tileX}:${tileY}`;
      if (!tilesBefore.has(key)) tilesBefore.set(key, this.#captureTile(layer, tileX, tileY));
      for (let channel = 0; channel < 4; channel++) layer.pixels[index + channel] = pixelReplacement[channel];
      this.compositeDirtyTiles.add(key);
      return true;
    };
    let changedPixels = 0;
    if (!contiguous) {
      for (let index = 0; index < layer.pixels.length; index += 4) if (paint(index)) changedPixels++;
    } else {
      // Bounded typed buffers ensure each document pixel is visited at most once.
      const pixelCount = this.width * this.height;
      const queue = new Int32Array(pixelCount), visited = new Uint8Array(pixelCount);
      let head = 0, tail = 0;
      const start = y * this.width + x;
      queue[tail++] = start; visited[start] = 1;
      while (head < tail) {
        const pixel = queue[head++], index = pixel * 4;
        if (matches(index) && paint(index)) changedPixels++;
        const px = pixel % this.width, py = Math.floor(pixel / this.width);
        const enqueue = neighbor => {
          if (neighbor < 0 || neighbor >= pixelCount || visited[neighbor]) return;
          visited[neighbor] = 1;
          if (matches(neighbor * 4)) queue[tail++] = neighbor;
        };
        if (px > 0) enqueue(pixel - 1);
        if (px + 1 < this.width) enqueue(pixel + 1);
        if (py > 0) enqueue(pixel - this.width);
        if (py + 1 < this.height) enqueue(pixel + this.width);
      }
    }
    if (changedPixels > 0) {
      const tiles = [...tilesBefore.entries()].map(([key, before]) => {
        const [tileX, tileY] = key.split(':').map(Number);
        return { tileX, tileY, before, after: this.#captureTile(layer, tileX, tileY) };
      });
      this.#record({ type: 'pixels', layerId: layer.id, tiles });
    }
    return changedPixels;
  }
  clearRect(x, y, width, height) {
    if (![x, y, width, height].every(Number.isInteger) || width < 1 || height < 1) throw new RangeError('Clear rectangle coordinates and dimensions must be positive integers.');
    const left = Math.max(0, x), top = Math.max(0, y);
    const right = Math.min(this.width, x + width), bottom = Math.min(this.height, y + height);
    if (left >= right || top >= bottom) return 0;
    const layer = this.activeLayer;
    if (layer.locked) throw new Error('The active layer is locked.');
    const tilesBefore = new Map();
    let changedPixels = 0;
    for (let py = top; py < bottom; py++) for (let px = left; px < right; px++) {
      const pixelIndex = py * this.width + px;
      if (this.selectionMask && !this.selectionMask[pixelIndex]) continue;
      const index = pixelIndex * 4;
      if (layer.pixels[index + 3] === 0 && layer.pixels[index] === 0 && layer.pixels[index + 1] === 0 && layer.pixels[index + 2] === 0) continue;
      const tileX = Math.floor(px / TILE_SIZE), tileY = Math.floor(py / TILE_SIZE), key = `${tileX}:${tileY}`;
      if (!tilesBefore.has(key)) tilesBefore.set(key, this.#captureTile(layer, tileX, tileY));
      layer.pixels[index] = 0; layer.pixels[index + 1] = 0; layer.pixels[index + 2] = 0; layer.pixels[index + 3] = 0;
      this.compositeDirtyTiles.add(key); changedPixels++;
    }
    if (changedPixels) {
      const tiles = [...tilesBefore.entries()].map(([key, before]) => {
        const [tileX, tileY] = key.split(':').map(Number);
        return { tileX, tileY, before, after: this.#captureTile(layer, tileX, tileY) };
      });
      this.#record({ type: 'pixels', layerId: layer.id, tiles });
    }
    return changedPixels;
  }
  createOutline(color = '#20202a', { diagonals = true } = {}) {
    if (typeof diagonals !== 'boolean') throw new TypeError('Outline diagonal mode must be a boolean.');
    const layer = this.activeLayer;
    if (layer.locked) throw new Error('The active layer is locked.');
    const rgb = parseHexColor(color), source = new Uint8ClampedArray(layer.pixels);
    const neighbors = diagonals ? [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]] : [[0,-1],[-1,0],[1,0],[0,1]];
    const tilesBefore = new Map();
    let changedPixels = 0;
    for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) {
      const sourceIndex = (y * this.width + x) * 4;
      if (source[sourceIndex + 3] === 0) continue;
      for (const [dx, dy] of neighbors) {
        const px = x + dx, py = y + dy;
        if (px < 0 || py < 0 || px >= this.width || py >= this.height) continue;
        const pixel = py * this.width + px;
        if (this.selectionMask && !this.selectionMask[pixel]) continue;
        const index = pixel * 4;
        if (source[index + 3] !== 0 || layer.pixels[index + 3] !== 0) continue;
        const tileX = Math.floor(px / TILE_SIZE), tileY = Math.floor(py / TILE_SIZE), key = `${tileX}:${tileY}`;
        if (!tilesBefore.has(key)) tilesBefore.set(key, this.#captureTile(layer, tileX, tileY));
        layer.pixels[index] = rgb[0]; layer.pixels[index + 1] = rgb[1]; layer.pixels[index + 2] = rgb[2]; layer.pixels[index + 3] = 255;
        this.compositeDirtyTiles.add(key); changedPixels++;
      }
    }
    if (changedPixels) {
      const tiles = [...tilesBefore.entries()].map(([key, before]) => {
        const [tileX, tileY] = key.split(':').map(Number);
        return { tileX, tileY, before, after: this.#captureTile(layer, tileX, tileY) };
      });
      this.#record({ type: 'pixels', layerId: layer.id, tiles });
    }
    return changedPixels;
  }
  previewTransformRect(x, y, width, height, { dx = 0, dy = 0, rotate = 0, scaleX = 1, scaleY = 1, skewX = 0, skewY = 0, interpolation = 'nearest' } = {}) {
    if (![x, y, width, height, dx, dy, rotate, scaleX, scaleY, skewX, skewY].every(Number.isFinite) ||
        ![x, y, width, height, dx, dy, rotate].every(Number.isInteger) || width < 1 || height < 1 ||
        ![0, 90, 180, 270].includes(rotate) || scaleX < 0.1 || scaleX > 8 || scaleY < 0.1 || scaleY > 8 ||
        Math.abs(skewX) > 4 || Math.abs(skewY) > 4 || !['nearest', 'bilinear'].includes(interpolation)) {
      throw new TypeError('Transform bounds/offsets must be integers; rotation 0/90/180/270; scale 0.1–8; skew -4–4; interpolation nearest/bilinear.');
    }
    const layer = this.activeLayer;
    if (layer.locked) throw new Error('The active layer is locked.');
    const left = Math.max(0, x), top = Math.max(0, y);
    const right = Math.min(this.width, x + width), bottom = Math.min(this.height, y + height);
    if (left >= right || top >= bottom) throw new RangeError('Transform rectangle is outside document bounds.');
    const sourceMask = this.selectionMask;
    const selected = [];
    for (let sy = top; sy < bottom; sy++) for (let sx = left; sx < right; sx++) {
      const sourceIndex = sy * this.width + sx;
      if (sourceMask && !sourceMask[sourceIndex]) continue;
      selected.push({ x: sx, y: sy, rx: sx - x, ry: sy - y });
    }
    const empty = { changedPixels: 0, selectedPixels: 0, pixels: new Uint8ClampedArray(this.width * this.height * 4), selectionMask: new Uint8Array(this.width * this.height), bounds: null, rect: { x, y, width, height }, options: { dx, dy, rotate, scaleX, scaleY, skewX, skewY, interpolation } };
    if (!selected.length) return empty;
    const theta = rotate * Math.PI / 180, cos = Math.round(Math.cos(theta)), sin = Math.round(Math.sin(theta));
    // Compose rotation with scale + skew around the center of the source rectangle.
    const a = cos * scaleX - sin * skewY;
    const b = cos * skewX - sin * scaleY;
    const c = sin * scaleX + cos * skewY;
    const d = sin * skewX + cos * scaleY;
    const determinant = a * d - b * c;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 0.01) throw new RangeError('Transform matrix is not invertible.');
    const cx = (width - 1) / 2, cy = (height - 1) / 2;
    const txCenter = x + cx + dx, tyCenter = y + cy + dy;
    const corners = [[-.5,-.5],[width-.5,-.5],[-.5,height-.5],[width-.5,height-.5]].map(([px,py]) => ({
      x: txCenter + a * (px - cx) + b * (py - cy),
      y: tyCenter + c * (px - cx) + d * (py - cy),
    }));
    const minX = Math.max(0, Math.floor(Math.min(...corners.map(p => p.x)) + .5));
    const minY = Math.max(0, Math.floor(Math.min(...corners.map(p => p.y)) + .5));
    const maxX = Math.min(this.width - 1, Math.ceil(Math.max(...corners.map(p => p.x)) - .5));
    const maxY = Math.min(this.height - 1, Math.ceil(Math.max(...corners.map(p => p.y)) - .5));
    const pixels = new Uint8ClampedArray(this.width * this.height * 4);
    const nextMask = new Uint8Array(this.width * this.height);
    const selectedAt = (sx, sy) => {
      if (sx < x || sy < y || sx >= x + width || sy >= y + height || sx < 0 || sy < 0 || sx >= this.width || sy >= this.height) return false;
      return !sourceMask || sourceMask[sy * this.width + sx] === 1;
    };
    const sourcePixel = (sx, sy) => {
      if (!selectedAt(sx, sy)) return [0, 0, 0, 0];
      const i = (sy * this.width + sx) * 4;
      return [layer.pixels[i], layer.pixels[i+1], layer.pixels[i+2], layer.pixels[i+3]];
    };
    let count = 0, outLeft = this.width, outTop = this.height, outRight = -1, outBottom = -1;
    for (let py = minY; py <= maxY; py++) for (let px = minX; px <= maxX; px++) {
      const vx = px - txCenter, vy = py - tyCenter;
      const u = (d * vx - b * vy) / determinant + cx + x;
      const v = (-c * vx + a * vy) / determinant + cy + y;
      const sx = Math.round(u), sy = Math.round(v);
      if (!selectedAt(sx, sy)) continue;
      const targetIndex = py * this.width + px, targetOffset = targetIndex * 4;
      if (interpolation === 'nearest') {
        pixels.set(sourcePixel(sx, sy), targetOffset);
      } else {
        const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
        const samples = [
          [x0,y0,(1-fx)*(1-fy)], [x0+1,y0,fx*(1-fy)],
          [x0,y0+1,(1-fx)*fy], [x0+1,y0+1,fx*fy],
        ];
        let alpha = 0, premulR = 0, premulG = 0, premulB = 0;
        for (const [ix,iy,weight] of samples) {
          if (!selectedAt(ix,iy)) continue;
          const si = (iy * this.width + ix) * 4, sa = layer.pixels[si+3] / 255 * weight;
          alpha += sa; premulR += layer.pixels[si] * sa; premulG += layer.pixels[si+1] * sa; premulB += layer.pixels[si+2] * sa;
        }
        pixels[targetOffset+3] = Math.round(alpha * 255);
        if (alpha > 0) {
          pixels[targetOffset] = Math.round(premulR / alpha);
          pixels[targetOffset+1] = Math.round(premulG / alpha);
          pixels[targetOffset+2] = Math.round(premulB / alpha);
        }
      }
      nextMask[targetIndex] = 1; count++;
      outLeft = Math.min(outLeft, px); outTop = Math.min(outTop, py); outRight = Math.max(outRight, px); outBottom = Math.max(outBottom, py);
    }
    let changedPixels = 0;
    for (let i = 0; i < pixels.length; i += 4) if (nextMask[i / 4]) {
      const source = i / 4, sx = source % this.width, sy = Math.floor(source / this.width);
      if (!selectedAt(sx, sy)) continue;
      const oldOffset = i;
      if (layer.pixels[oldOffset] !== pixels[oldOffset] || layer.pixels[oldOffset+1] !== pixels[oldOffset+1] ||
          layer.pixels[oldOffset+2] !== pixels[oldOffset+2] || layer.pixels[oldOffset+3] !== pixels[oldOffset+3]) changedPixels++;
    }
    return {
      changedPixels, selectedPixels: count, pixels, selectionMask: nextMask,
      bounds: outRight < 0 ? null : { x: outLeft, y: outTop, width: outRight - outLeft + 1, height: outBottom - outTop + 1 },
      rect: { x, y, width, height }, options: { dx, dy, rotate, scaleX, scaleY, skewX, skewY, interpolation },
    };
  }
  transformRect(x, y, width, height, options = {}) {
    const preview = this.previewTransformRect(x, y, width, height, options);
    if (!preview.selectedPixels) return preview;
    const layer = this.activeLayer;
    const beforeTiles = new Map();
    const touch = (px, py) => {
      const tileX = Math.floor(px / TILE_SIZE), tileY = Math.floor(py / TILE_SIZE), key = `${tileX}:${tileY}`;
      if (!beforeTiles.has(key)) beforeTiles.set(key, this.#captureTile(layer, tileX, tileY));
      this.compositeDirtyTiles.add(key);
    };
    // Snapshot all source pixels before clearing so overlapping transforms are safe.
    for (let sy = Math.max(0, y); sy < Math.min(this.height, y + height); sy++) for (let sx = Math.max(0, x); sx < Math.min(this.width, x + width); sx++) {
      const index = sy * this.width + sx;
      if (this.selectionMask && !this.selectionMask[index]) continue;
      touch(sx, sy);
      layer.pixels.fill(0, index * 4, index * 4 + 4);
    }
    for (let index = 0; index < preview.selectionMask.length; index++) {
      if (!preview.selectionMask[index]) continue;
      const x2 = index % this.width, y2 = Math.floor(index / this.width);
      touch(x2, y2);
      layer.pixels.set(preview.pixels.subarray(index * 4, index * 4 + 4), index * 4);
    }
    const changedTiles = [];
    let changedPixels = 0;
    for (const [key, before] of beforeTiles) {
      const [tileX, tileY] = key.split(':').map(Number), after = this.#captureTile(layer, tileX, tileY);
      let tileChanged = 0;
      for (let i = 0; i < before.length; i += 4) if (before[i] !== after[i] || before[i+1] !== after[i+1] || before[i+2] !== after[i+2] || before[i+3] !== after[i+3]) tileChanged++;
      if (tileChanged) { changedTiles.push({ tileX, tileY, before, after }); changedPixels += tileChanged; }
    }
    if (changedTiles.length) this.#record({ type: 'pixels', layerId: layer.id, tiles: changedTiles });
    return { ...preview, changedPixels, selectionMask: preview.selectionMask };
  }
  cropCanvas(x, y, width, height) {
    if (![x, y, width, height].every(Number.isInteger) || width < 1 || height < 1 ||
        x < 0 || y < 0 || x + width > this.width || y + height > this.height) {
      throw new RangeError('Crop bounds must be positive integer dimensions fully inside the canvas.');
    }
    if (x === 0 && y === 0 && width === this.width && height === this.height) return false;
    const snapshot = { width: this.width, height: this.height, activeLayerId: this.activeLayerId, layers: this.layers.map(cloneLayer) };
    this.#cropTo(x, y, width, height);
    this.selectionMask = null;
    this.#record({ type: 'document-crop', before: snapshot, x, y, width, height });
    return true;
  }
  #cropTo(x, y, width, height) {
    validateDimensions(width, height);
    if (width * height * 4 * this.layers.length > MAX_DOCUMENT_BYTES) throw new RangeError('Crop exceeds the document pixel-memory budget.');
    this.layers = this.layers.map(layer => {
      const pixels = new Uint8ClampedArray(width * height * 4);
      for (let row = 0; row < height; row++) {
        const from = ((y + row) * this.width + x) * 4;
        pixels.set(layer.pixels.subarray(from, from + width * 4), row * width * 4);
      }
      return { ...layer, pixels };
    });
    this.width = width; this.height = height;
    if (!this.layers.some(layer => layer.id === this.activeLayerId)) this.activeLayerId = this.layers[0].id;
    this.compositeCache = new Uint8ClampedArray(width * height * 4);
    this.compositeDirtyTiles = new Set();
    this.#markAllCompositeDirty();
  }
  #restoreDocument(snapshot) {
    this.width = snapshot.width; this.height = snapshot.height;
    this.layers = snapshot.layers.map(cloneLayer);
    this.activeLayerId = snapshot.activeLayerId;
    this.selectionMask = null;
    this.compositeCache = new Uint8ClampedArray(this.width * this.height * 4);
    this.compositeDirtyTiles = new Set();
    this.#markAllCompositeDirty();
  }
  replaceLayerPixelsBatch(replacements) {
    if (!Array.isArray(replacements) || replacements.length < 1 || replacements.length > 64) {
      throw new TypeError('Pixel replacement must contain between 1 and 64 layers.');
    }
    const seen = new Set();
    const prepared = replacements.map(item => {
      if (!item || typeof item.layerId !== 'string' || seen.has(item.layerId)) throw new TypeError('Each replacement must target a unique layer ID.');
      seen.add(item.layerId);
      const layer = this.layers.find(candidate => candidate.id === item.layerId);
      if (!layer) throw new Error('Unknown layer ID.');
      if (layer.locked) throw new Error(`Layer "${layer.name}" is locked.`);
      if (!(item.pixels instanceof Uint8Array || item.pixels instanceof Uint8ClampedArray) || item.pixels.length !== this.width * this.height * 4) {
        throw new TypeError('Replacement pixels must be a byte array matching the document dimensions.');
      }
      return { layer, pixels: item.pixels };
    });

    const changedLayers = [];
    let changedPixels = 0;
    for (const { layer, pixels } of prepared) {
      const tiles = [];
      for (let tileY = 0; tileY < Math.ceil(this.height / TILE_SIZE); tileY++) {
        for (let tileX = 0; tileX < Math.ceil(this.width / TILE_SIZE); tileX++) {
          const startX = tileX * TILE_SIZE, startY = tileY * TILE_SIZE;
          const tileWidth = Math.min(TILE_SIZE, this.width - startX), tileHeight = Math.min(TILE_SIZE, this.height - startY);
          let tileChangedPixels = 0;
          for (let row = 0; row < tileHeight; row++) {
            const start = ((startY + row) * this.width + startX) * 4;
            for (let col = 0; col < tileWidth; col++) {
              const offset = start + col * 4;
              if (layer.pixels[offset] !== pixels[offset] || layer.pixels[offset + 1] !== pixels[offset + 1] ||
                  layer.pixels[offset + 2] !== pixels[offset + 2] || layer.pixels[offset + 3] !== pixels[offset + 3]) tileChangedPixels++;
            }
          }
          if (!tileChangedPixels) continue;
          const before = this.#captureTile(layer, tileX, tileY);
          for (let row = 0; row < tileHeight; row++) {
            const start = ((startY + row) * this.width + startX) * 4;
            layer.pixels.set(pixels.subarray(start, start + tileWidth * 4), start);
          }
          const after = this.#captureTile(layer, tileX, tileY);
          tiles.push({ tileX, tileY, before, after });
          this.compositeDirtyTiles.add(`${tileX}:${tileY}`);
          changedPixels += tileChangedPixels;
        }
      }
      if (tiles.length) changedLayers.push({ layerId: layer.id, tiles });
    }
    if (changedLayers.length) this.#record({ type: 'pixels-batch', layers: changedLayers });
    return { changedPixels, changedLayers: changedLayers.length };
  }
  flipRect(x, y, width, height, axis = 'horizontal') {
    if (!['horizontal', 'vertical'].includes(axis)) throw new TypeError('Flip axis must be horizontal or vertical.');
    const clipboard = this.copyRect(x, y, width, height);
    const pixels = new Uint8ClampedArray(clipboard.pixels.length), mask = new Uint8Array(clipboard.mask.length);
    for (let dy = 0; dy < clipboard.height; dy++) for (let dx = 0; dx < clipboard.width; dx++) {
      const sourceX = axis === 'horizontal' ? clipboard.width - 1 - dx : dx;
      const sourceY = axis === 'vertical' ? clipboard.height - 1 - dy : dy;
      const sourcePixel = sourceY * clipboard.width + sourceX, targetPixel = dy * clipboard.width + dx;
      const sourceOffset = sourcePixel * 4, targetOffset = targetPixel * 4;
      pixels.set(clipboard.pixels.subarray(sourceOffset, sourceOffset + 4), targetOffset);
      mask[targetPixel] = clipboard.mask[sourcePixel];
    }
    return this.pasteRect({ ...clipboard, pixels, mask }, { x: clipboard.x, y: clipboard.y });
  }
  fillGradient(x0, y0, x1, y1, { startColor = '#20202a', endColor = '#ffffff', opacity = 1 } = {}) {
    if (![x0, y0, x1, y1].every(Number.isInteger) || x0 < 0 || y0 < 0 || x1 < 0 || y1 < 0 ||
        x0 >= this.width || x1 >= this.width || y0 >= this.height || y1 >= this.height) {
      throw new RangeError('Gradient endpoints must be integer document coordinates inside the canvas.');
    }
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new RangeError('Gradient opacity must be between 0 and 1.');
    const layer = this.activeLayer;
    if (layer.locked) throw new Error('The active layer is locked.');
    if (opacity === 0) return 0;
    const start = parseHexColor(startColor), end = parseHexColor(endColor);
    const dx = x1 - x0, dy = y1 - y0, lengthSquared = dx * dx + dy * dy || 1;
    const tilesBefore = new Map();
    let changedPixels = 0;
    for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) {
      const pixel = y * this.width + x;
      if (this.selectionMask && !this.selectionMask[pixel]) continue;
      const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / lengthSquared));
      const gradient = start.map((channel, index) => Math.round(channel + (end[index] - channel) * t));
      const i = pixel * 4, destinationAlpha = layer.pixels[i + 3] / 255;
      const outputAlpha = opacity + destinationAlpha * (1 - opacity);
      const next = [
        Math.round((gradient[0] * opacity + layer.pixels[i] * destinationAlpha * (1 - opacity)) / outputAlpha),
        Math.round((gradient[1] * opacity + layer.pixels[i + 1] * destinationAlpha * (1 - opacity)) / outputAlpha),
        Math.round((gradient[2] * opacity + layer.pixels[i + 2] * destinationAlpha * (1 - opacity)) / outputAlpha),
        Math.round(outputAlpha * 255)
      ];
      if (next.every((value, channel) => value === layer.pixels[i + channel])) continue;
      const tileX = Math.floor(x / TILE_SIZE), tileY = Math.floor(y / TILE_SIZE), key = `${tileX}:${tileY}`;
      if (!tilesBefore.has(key)) tilesBefore.set(key, this.#captureTile(layer, tileX, tileY));
      layer.pixels.set(next, i); this.compositeDirtyTiles.add(key); changedPixels++;
    }
    if (changedPixels) {
      const tiles = [...tilesBefore.entries()].map(([key, before]) => {
        const [tileX, tileY] = key.split(':').map(Number);
        return { tileX, tileY, before, after: this.#captureTile(layer, tileX, tileY) };
      });
      this.#record({ type: 'pixels', layerId: layer.id, tiles });
    }
    return changedPixels;
  }
  replaceColor(sourceColor, targetColor, tolerance = 0) {
    if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 255) throw new RangeError('Color replacement tolerance must be an integer from 0 to 255.');
    const source = parseHexColor(sourceColor), target = parseHexColor(targetColor), layer = this.activeLayer;
    if (layer.locked) throw new Error('The active layer is locked.');
    if (source.every((value, index) => value === target[index]) && tolerance === 0) return 0;
    const tilesBefore = new Map();
    let changedPixels = 0;
    for (let index = 0; index < layer.pixels.length; index += 4) {
      const pixel = index / 4;
      if (this.selectionMask && !this.selectionMask[pixel]) continue;
      if (layer.pixels[index + 3] === 0) continue;
      if (Math.max(Math.abs(layer.pixels[index] - source[0]), Math.abs(layer.pixels[index + 1] - source[1]), Math.abs(layer.pixels[index + 2] - source[2])) > tolerance) continue;
      if (layer.pixels[index] === target[0] && layer.pixels[index + 1] === target[1] && layer.pixels[index + 2] === target[2]) continue;
      const px = pixel % this.width, py = Math.floor(pixel / this.width);
      const tileX = Math.floor(px / TILE_SIZE), tileY = Math.floor(py / TILE_SIZE), key = `${tileX}:${tileY}`;
      if (!tilesBefore.has(key)) tilesBefore.set(key, this.#captureTile(layer, tileX, tileY));
      layer.pixels[index] = target[0]; layer.pixels[index + 1] = target[1]; layer.pixels[index + 2] = target[2];
      this.compositeDirtyTiles.add(key); changedPixels++;
    }
    if (changedPixels) {
      const tiles = [...tilesBefore.entries()].map(([key, before]) => {
        const [tileX, tileY] = key.split(':').map(Number);
        return { tileX, tileY, before, after: this.#captureTile(layer, tileX, tileY) };
      });
      this.#record({ type: 'pixels', layerId: layer.id, tiles });
    }
    return changedPixels;
  }
  copyRect(x, y, width, height) {
    if (![x, y, width, height].every(Number.isInteger) || width < 1 || height < 1) throw new RangeError('Copy rectangle coordinates and dimensions must be positive integers.');
    const left = Math.max(0, x), top = Math.max(0, y), right = Math.min(this.width, x + width), bottom = Math.min(this.height, y + height);
    if (left >= right || top >= bottom) throw new RangeError('Copy rectangle is outside document bounds.');
    const layer = this.activeLayer, clipboardWidth = right - left, clipboardHeight = bottom - top;
    const pixels = new Uint8ClampedArray(clipboardWidth * clipboardHeight * 4), mask = new Uint8Array(clipboardWidth * clipboardHeight);
    for (let row = 0; row < clipboardHeight; row++) {
      for (let col = 0; col < clipboardWidth; col++) {
        const sourcePixel = (top + row) * this.width + left + col, targetPixel = row * clipboardWidth + col;
        if (this.selectionMask && !this.selectionMask[sourcePixel]) continue;
        mask[targetPixel] = 1;
        const sourceOffset = sourcePixel * 4, targetOffset = targetPixel * 4;
        pixels.set(layer.pixels.subarray(sourceOffset, sourceOffset + 4), targetOffset);
      }
    }
    return { x: left, y: top, width: clipboardWidth, height: clipboardHeight, pixels, mask };
  }
  pasteRect(clipboard, { x = clipboard?.x, y = clipboard?.y } = {}) {
    if (!clipboard || !Number.isInteger(clipboard.width) || !Number.isInteger(clipboard.height) || clipboard.width < 1 || clipboard.height < 1 ||
        !(clipboard.pixels instanceof Uint8ClampedArray) || clipboard.pixels.length !== clipboard.width * clipboard.height * 4 ||
        (clipboard.mask !== undefined && (!(clipboard.mask instanceof Uint8Array) || clipboard.mask.length !== clipboard.width * clipboard.height)) ||
        !Number.isInteger(x) || !Number.isInteger(y)) throw new TypeError('Invalid internal pixel clipboard.');
    const layer = this.activeLayer;
    if (layer.locked) throw new Error('The active layer is locked.');
    const left = Math.max(0, x), top = Math.max(0, y), right = Math.min(this.width, x + clipboard.width), bottom = Math.min(this.height, y + clipboard.height);
    if (left >= right || top >= bottom) return 0;
    const tilesBefore = new Map();
    let changedPixels = 0;
    for (let py = top; py < bottom; py++) for (let px = left; px < right; px++) {
      const docPixel = py * this.width + px;
      if (this.selectionMask && !this.selectionMask[docPixel]) continue;
      const srcX = px - x, srcY = py - y, sourcePixel = srcY * clipboard.width + srcX;
      if (clipboard.mask && !clipboard.mask[sourcePixel]) continue;
      const srcOffset = sourcePixel * 4, dstOffset = docPixel * 4;
      let differs = false;
      for (let channel = 0; channel < 4; channel++) if (layer.pixels[dstOffset + channel] !== clipboard.pixels[srcOffset + channel]) { differs = true; break; }
      if (!differs) continue;
      const tileX = Math.floor(px / TILE_SIZE), tileY = Math.floor(py / TILE_SIZE), key = `${tileX}:${tileY}`;
      if (!tilesBefore.has(key)) tilesBefore.set(key, this.#captureTile(layer, tileX, tileY));
      layer.pixels.set(clipboard.pixels.subarray(srcOffset, srcOffset + 4), dstOffset);
      this.compositeDirtyTiles.add(key); changedPixels++;
    }
    if (changedPixels) {
      const tiles = [...tilesBefore.entries()].map(([key, before]) => {
        const [tileX, tileY] = key.split(':').map(Number);
        return { tileX, tileY, before, after: this.#captureTile(layer, tileX, tileY) };
      });
      this.#record({ type: 'pixels', layerId: layer.id, tiles });
    }
    return changedPixels;
  }
  sampleColorAt(x, y, { merged = true } = {}) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= this.width || y >= this.height) {
      throw new RangeError('Sample coordinates are outside the document bounds.');
    }
    if (typeof merged !== 'boolean') throw new TypeError('Sample source must be merged or active layer.');
    const pixels = merged ? this.composite() : this.activeLayer.pixels;
    const offset = (y * this.width + x) * 4;
    if (pixels[offset + 3] === 0) return null;
    return '#' + [...pixels.subarray(offset, offset + 3)].map(channel => channel.toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  getCompositeDirtyTiles() {
    return [...this.compositeDirtyTiles].map(key => {
      const [tileX, tileY] = key.split(':').map(Number);
      return { tileX, tileY, width: Math.min(TILE_SIZE, this.width - tileX * TILE_SIZE), height: Math.min(TILE_SIZE, this.height - tileY * TILE_SIZE) };
    });
  }
  clearCompositeDirtyTiles() { this.compositeDirtyTiles.clear(); }
  composite() {
    if (this.compositeDirtyTiles.size === 0) return this.compositeCache;
    const visibleLayers = this.layers
      .filter(layer => layer.visible && layer.opacity > 0)
      .map(layer => ({ pixels: layer.pixels, opacity: Math.max(0, Math.min(1, layer.opacity)) }));
    for (const key of this.compositeDirtyTiles) {
      const separator = key.indexOf(':');
      const tileX = Number(key.slice(0, separator)), tileY = Number(key.slice(separator + 1));
      const startX = tileX * TILE_SIZE, startY = tileY * TILE_SIZE;
      const width = Math.min(TILE_SIZE, this.width - startX), height = Math.min(TILE_SIZE, this.height - startY);
      for (let row = 0; row < height; row++) {
        let index = ((startY + row) * this.width + startX) * 4;
        const rowEnd = index + width * 4;
        for (; index < rowEnd; index += 4) {
          let red = 0, green = 0, blue = 0, alpha = 0;
          for (let layerIndex = 0; layerIndex < visibleLayers.length; layerIndex++) {
            const layer = visibleLayers[layerIndex], source = layer.pixels;
            const sourceAlpha = source[index + 3];
            if (sourceAlpha === 0) continue;
            const sa = sourceAlpha * (1 / 255) * layer.opacity;
            const remaining = 1 - sa;
            red = source[index] * sa + red * remaining;
            green = source[index + 1] * sa + green * remaining;
            blue = source[index + 2] * sa + blue * remaining;
            alpha = sa + alpha * remaining;
          }
          const inverseAlpha = alpha > 0 ? 1 / alpha : 0;
          this.compositeCache[index] = Math.round(red * inverseAlpha);
          this.compositeCache[index + 1] = Math.round(green * inverseAlpha);
          this.compositeCache[index + 2] = Math.round(blue * inverseAlpha);
          this.compositeCache[index + 3] = Math.round(alpha * 255);
        }
      }
    }
    return this.compositeCache;
  }
  undo() {
    const entry = this.history.pop();
    if (!entry) return false;
    this.#applyEntry(entry, false);
    this.#markAllCompositeDirty();
    this.future.push(entry);
    this.revision++;
    this.saveVersion++;
    this.dirty = true;
    return true;
  }
  redo() {
    const entry = this.future.pop();
    if (!entry) return false;
    this.#applyEntry(entry, true);
    this.#markAllCompositeDirty();
    this.history.push(entry);
    this.revision++;
    this.saveVersion++;
    this.dirty = true;
    return true;
  }
  toJSON() {
    return { format: 'pixelforge-project', version: 1, id: this.id, name: this.name, width: this.width, height: this.height, activeLayerId: this.activeLayerId, revision: this.revision, saveVersion: this.saveVersion,
      layers: this.layers.map(layer => ({ id: layer.id, name: layer.name, visible: layer.visible, opacity: layer.opacity, locked: layer.locked, pixels: bytesToBase64(layer.pixels) })) };
  }
  static fromJSON(data, { newIdentity = false } = {}) {
    if (!data || data.format !== 'pixelforge-project' || data.version !== 1 || !Array.isArray(data.layers)) throw new TypeError('Unsupported or invalid PixelForge project file.');
    validateDimensions(data.width, data.height);
    if (data.layers.length < 1 || data.layers.length > 64) throw new RangeError('Project layer count is outside the supported limit.');
    if (data.width * data.height * 4 * data.layers.length > MAX_DOCUMENT_BYTES) throw new RangeError('Project exceeds the 64 MiB total pixel-memory budget.');
    const projectName = typeof data.name === 'string' ? data.name.trim().slice(0, 180) : '';
    const doc = new RasterDocument(data.width, data.height, projectName || 'Imported project');
    if (newIdentity) doc.name = `${doc.name.slice(0, 169)} (imported)`;
    if (data.id !== undefined && (typeof data.id !== 'string' || !data.id || data.id.length > 180)) throw new TypeError('Invalid project ID.');
    if (!newIdentity && typeof data.id === 'string') doc.id = data.id;
    const layerIds = new Set(), layerIdMap = new Map();
    doc.layers = data.layers.map((item, index) => {
      if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 180 || typeof item.name !== 'string') throw new TypeError('Invalid layer metadata.');
      if ((item.visible !== undefined && typeof item.visible !== 'boolean') || (item.locked !== undefined && typeof item.locked !== 'boolean')) throw new TypeError('Layer visibility and lock flags must be booleans.');
      if (layerIds.has(item.id)) throw new TypeError('Project contains duplicate layer IDs.');
      layerIds.add(item.id);
      const newLayerId = newIdentity ? crypto.randomUUID() : item.id;
      layerIdMap.set(item.id, newLayerId);
      const opacity = Number(item.opacity ?? 1);
      if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new RangeError('Layer opacity must be between 0 and 1.');
      const pixels = base64ToBytes(item.pixels, data.width * data.height * 4);
      if (pixels.length !== data.width * data.height * 4) throw new RangeError('Layer pixel data length does not match document dimensions.');
      return { id: newLayerId, name: item.name.trim().slice(0, 180) || `Layer ${index + 1}`, visible: item.visible !== false, opacity, locked: Boolean(item.locked), pixels };
    });
    doc.compositeCache = new Uint8ClampedArray(doc.width * doc.height * 4);
    doc.compositeDirtyTiles = new Set();
    doc.#markAllCompositeDirty();
    if (data.activeLayerId !== undefined && (typeof data.activeLayerId !== 'string' || !layerIds.has(data.activeLayerId))) throw new TypeError('Active layer ID does not match a project layer.');
    if (data.revision !== undefined && (!Number.isInteger(data.revision) || data.revision < 0)) throw new RangeError('Document revision must be a non-negative integer.');
    if (data.saveVersion !== undefined && (!Number.isInteger(data.saveVersion) || data.saveVersion < 0)) throw new RangeError('Save version must be a non-negative integer.');
    doc.activeLayerId = data.activeLayerId === undefined ? doc.layers[0].id : (newIdentity ? layerIdMap.get(data.activeLayerId) : data.activeLayerId);
    doc.revision = newIdentity ? 0 : (data.revision ?? 0);
    doc.saveVersion = newIdentity ? 0 : (data.saveVersion ?? doc.revision);
    doc.history = []; doc.future = []; doc.historyBytes = 0; doc.dirty = false;
    return doc;
  }
  #dab(layer, x, y, stroke) {
    const offset = Math.floor((stroke.size - 1) / 2);
    const minX = Math.max(0, x - offset), maxX = Math.min(this.width - 1, x - offset + stroke.size - 1);
    const minY = Math.max(0, y - offset), maxY = Math.min(this.height - 1, y - offset + stroke.size - 1);
    for (let py = minY; py <= maxY; py++) for (let px = minX; px <= maxX; px++) {
      const pixelIndex = py * this.width + px;
      if (this.selectionMask && !this.selectionMask[pixelIndex]) continue;
      if (stroke.opacity <= 0) continue;
      let coverage = 1;
      if (stroke.shape === 'circle') {
        const centerOffset = stroke.size % 2 === 0 ? 0.5 : 0;
        const cx = x + centerOffset, cy = y + centerOffset, radius = stroke.size / 2;
        const distance = Math.hypot(px - cx, py - cy);
        if (distance >= radius) continue;
        const innerRadius = radius * stroke.hardness;
        coverage = distance <= innerRadius || stroke.hardness >= 1 ? 1 : Math.max(0, Math.min(1, (radius - distance) / Math.max(.0001, radius - innerRadius)));
        if (coverage <= 0) continue;
      }
      const effectiveOpacity = stroke.opacity * coverage;
      const i = pixelIndex * 4, next = [layer.pixels[i], layer.pixels[i + 1], layer.pixels[i + 2], layer.pixels[i + 3]];
      if (stroke.mode === 'erase') {
        next[3] = Math.round(next[3] * (1 - effectiveOpacity));
        if (next[3] === 0) next[0] = next[1] = next[2] = 0;
      } else {
        const destinationAlpha = next[3] / 255, sourceAlpha = effectiveOpacity;
        const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
        if (outputAlpha <= 0) continue;
        next[0] = Math.round((stroke.color[0] * sourceAlpha + next[0] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
        next[1] = Math.round((stroke.color[1] * sourceAlpha + next[1] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
        next[2] = Math.round((stroke.color[2] * sourceAlpha + next[2] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
        next[3] = Math.round(outputAlpha * 255);
      }
      if (next.every((value, channel) => value === layer.pixels[i + channel])) continue;
      const tileX = Math.floor(px / TILE_SIZE), tileY = Math.floor(py / TILE_SIZE), key = `${tileX}:${tileY}`;
      if (!stroke.tilesBefore.has(key)) stroke.tilesBefore.set(key, this.#captureTile(layer, tileX, tileY));
      layer.pixels.set(next, i);
      this.compositeDirtyTiles.add(key);
    }
  }
  #record(entry) {
    this.historyBytes -= this.future.reduce((sum, item) => sum + entryBytes(item), 0);
    this.future.length = 0;
    this.history.push(entry);
    this.historyBytes += entryBytes(entry);
    while (this.history.length > this.maxHistory || (this.historyBytes > this.maxHistoryBytes && this.history.length > 1)) {
      const removed = this.history.shift();
      this.historyBytes -= entryBytes(removed);
    }
    this.revision++;
    this.saveVersion++;
    this.dirty = true;
  }
  #captureTile(layer, tileX, tileY) {
    const tile = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
    const startX = tileX * TILE_SIZE, startY = tileY * TILE_SIZE;
    const width = Math.min(TILE_SIZE, this.width - startX), height = Math.min(TILE_SIZE, this.height - startY);
    for (let row = 0; row < height; row++) {
      const sourceStart = ((startY + row) * this.width + startX) * 4;
      tile.set(layer.pixels.subarray(sourceStart, sourceStart + width * 4), row * TILE_SIZE * 4);
    }
    return tile;
  }
  #markAllCompositeDirty() {
    for (let y = 0; y < this.height; y += TILE_SIZE) for (let x = 0; x < this.width; x += TILE_SIZE) this.compositeDirtyTiles.add(`${Math.floor(x / TILE_SIZE)}:${Math.floor(y / TILE_SIZE)}`);
  }
  #restoreTiles(layer, tiles) {
    for (const [key, pixels] of tiles) {
      const [tileX, tileY] = key.split(':').map(Number);
      this.#writeTile(layer, tileX, tileY, pixels);
    }
  }
  #writeTile(layer, tileX, tileY, tile) {
    this.compositeDirtyTiles.add(`${tileX}:${tileY}`);
    const startX = tileX * TILE_SIZE, startY = tileY * TILE_SIZE;
    const width = Math.min(TILE_SIZE, this.width - startX), height = Math.min(TILE_SIZE, this.height - startY);
    for (let row = 0; row < height; row++) {
      const targetStart = ((startY + row) * this.width + startX) * 4;
      layer.pixels.set(tile.subarray(row * TILE_SIZE * 4, row * TILE_SIZE * 4 + width * 4), targetStart);
    }
  }
  #applyEntry(entry, forward) {
    if (entry.type === 'document-crop') {
      if (forward) this.#cropTo(entry.x, entry.y, entry.width, entry.height);
      else this.#restoreDocument(entry.before);
    } else if (entry.type === 'pixels-batch') {
      for (const change of entry.layers) {
        const layer = this.layers.find(item => item.id === change.layerId);
        if (layer) for (const tile of change.tiles) this.#writeTile(layer, tile.tileX, tile.tileY, forward ? tile.after : tile.before);
      }
    } else if (entry.type === 'pixels') {
      const layer = this.layers.find(item => item.id === entry.layerId);
      if (layer) for (const tile of entry.tiles) this.#writeTile(layer, tile.tileX, tile.tileY, forward ? tile.after : tile.before);
    } else if (entry.type === 'layer-move') {
      const currentIndex = this.layers.findIndex(item => item.id === entry.layerId);
      if (currentIndex >= 0) {
        const [layer] = this.layers.splice(currentIndex, 1);
        const targetIndex = forward ? entry.afterIndex : entry.beforeIndex;
        this.layers.splice(Math.min(targetIndex, this.layers.length), 0, layer);
        this.#markAllCompositeDirty();
      }
    } else if (entry.type === 'layer-rename') {
      const layer = this.layers.find(item => item.id === entry.layerId);
      if (layer) layer.name = forward ? entry.after : entry.before;
    } else if (entry.type === 'layer-opacity') {
      const layer = this.layers.find(item => item.id === entry.layerId);
      if (layer) layer.opacity = forward ? entry.after : entry.before;
      this.#markAllCompositeDirty();
    } else if (entry.type === 'layer-delete') {
      if (forward) {
        this.layers = this.layers.filter(layer => layer.id !== entry.removedLayer?.id);
        this.activeLayerId = entry.afterActive ?? this.layers[0]?.id;
      } else {
        const existing = this.layers.find(layer => layer.id === entry.removedLayer?.id);
        if (!existing && entry.removedLayer) this.layers.splice(Math.min(entry.index, this.layers.length), 0, cloneLayer(entry.removedLayer));
        this.activeLayerId = entry.beforeActive ?? this.layers[0]?.id;
      }
      this.#markAllCompositeDirty();
    } else if (entry.type === 'layer-lock') {
      const layer = this.layers.find(item => item.id === entry.layerId);
      if (layer) layer.locked = forward ? entry.after : entry.before;
    } else if (entry.type === 'layer-visibility') {
      const layer = this.layers.find(item => item.id === entry.layerId);
      if (layer) layer.visible = forward ? entry.after : entry.before;
    } else if (entry.type === 'layer-add') {
      if (forward) {
        const existing = this.layers.find(layer => layer.id === entry.addedLayer?.id);
        if (!existing && entry.addedLayer) this.layers.splice(Math.min(entry.index, this.layers.length), 0, cloneLayer(entry.addedLayer));
        this.activeLayerId = entry.addedLayer?.id ?? this.activeLayerId;
      } else {
        this.layers = this.layers.filter(layer => layer.id !== entry.addedLayer?.id);
        this.activeLayerId = entry.beforeActive ?? this.layers[0].id;
      }
    }
  }
}

export function parseHexColor(value) {
  const hex = String(value).trim().replace(/^#/, '');
  if (!/^(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex)) throw new TypeError('Color must be a valid 3- or 6-digit hex value.');
  const full = hex.length === 3 ? [...hex].map(ch => ch + ch).join('') : hex;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}
function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
function base64ToBytes(value, expectedLength) {
  if (!Number.isInteger(expectedLength) || expectedLength < 0) throw new RangeError('Invalid expected pixel-buffer length.');
  const expectedEncodedLength = Math.ceil(expectedLength / 3) * 4;
  if (typeof value !== 'string' || value.length !== expectedEncodedLength || value.length > 24_000_000 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError('Invalid or oversized layer data.');
  }
  let binary;
  try { binary = atob(value); } catch { throw new TypeError('Invalid base64 pixel data.'); }
  if (binary.length !== expectedLength || btoa(binary) !== value) throw new TypeError('Invalid or non-canonical base64 pixel data.');
  const bytes = new Uint8ClampedArray(expectedLength);
  for (let i = 0; i < expectedLength; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
