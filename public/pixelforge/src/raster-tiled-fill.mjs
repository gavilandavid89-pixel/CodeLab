/**
 * Bounded flood fill for sparse tiled raster documents.
 *
 * Discovery uses scanline spans and a one-bit-per-pixel visited map. Changed
 * pixels are staged in complete tile buffers and committed as one copy-on-write
 * cel replacement, so a budget/validation failure cannot leave a partial fill.
 */
function parseColor(value, name) {
  if (typeof value !== 'string' || !/^#?(?:[0-9a-f]{6})$/i.test(value)) {
    throw new TypeError(name + ' must be a six-digit hex color.');
  }
  const hex = value.replace('#', '');
  return [0, 2, 4].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16)).concat(255);
}

function validateOptions(options) {
  const tolerance = options.tolerance ?? 0;
  const contiguous = options.contiguous ?? true;
  const pattern = options.pattern ?? 'solid';
  const scale = options.scale ?? 1;
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  const maxQueueSegments = options.maxQueueSegments ?? 65536;
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 255) throw new RangeError('Fill tolerance must be an integer from 0 to 255.');
  if (typeof contiguous !== 'boolean') throw new TypeError('Fill mode must be contiguous or global.');
  if (!['solid', 'checker'].includes(pattern)) throw new TypeError('Fill pattern must be solid or checker.');
  if (!Number.isInteger(scale) || scale < 1 || scale > 16) throw new RangeError('Dither scale must be an integer from 1 to 16.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 8) throw new RangeError('Fill byte budget must be at least 8 bytes.');
  if (!Number.isSafeInteger(maxQueueSegments) || maxQueueSegments < 1 || maxQueueSegments > 1_000_000) throw new RangeError('Fill queue limit is invalid.');
  return { tolerance, contiguous, pattern, scale, maxBytes, maxQueueSegments };
}

export async function fillTiledLayer(document, layerId, x, y, options = {}) {
  if (!document?.isTiled || typeof document.readRegion !== 'function' ||
      typeof document.writeTileBatch !== 'function' || !document.strokeHistory) {
    throw new TypeError('A transactional tiled raster document is required.');
  }
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= document.width || y >= document.height) {
    throw new RangeError('Fill coordinates are outside the document bounds.');
  }
  const layer = document.layers.find(item => item.id === layerId);
  if (!layer) throw new Error('Fill target layer does not exist.');
  if (layer.locked) throw new Error('The target layer is locked.');
  const settings = validateOptions(options);
  const primary = parseColor(options.color ?? '#20202a', 'Fill color');
  const secondary = parseColor(options.secondaryColor ?? '#ffffff', 'Secondary fill color');
  const tileSize = typeof document.getLayerTileSize === 'function' ? document.getLayerTileSize(layerId) : document.tileSize;
  if (!Number.isInteger(tileSize) || tileSize < 1) throw new Error('Tiled document did not expose a valid tile size.');

  const selectionMask = document.selectionMask;
  if (selectionMask && !selectionMask[y * document.width + x]) return 0;
  const seed = document.readRegion(layerId, { x, y, width: 1, height: 1 });
  const matches = (row, px, rowY) => {
    if (selectionMask && !selectionMask[rowY * document.width + px]) return false;
    const offset = px * 4;
    if (seed[3] === 0 && row[offset + 3] === 0) return true;
    for (let channel = 0; channel < 4; channel++) {
      if (Math.abs(row[offset + channel] - seed[channel]) > settings.tolerance) return false;
    }
    return true;
  };
  const visited = new Uint8Array(Math.ceil(document.width * document.height / 8));
  const wasVisited = index => (visited[index >> 3] & (1 << (index & 7))) !== 0;
  const markVisited = index => { visited[index >> 3] |= 1 << (index & 7); };
  const staged = new Map();
  let stagedBytes = 0, changedPixels = 0;
  const rowCache = new Map();
  const readRow = rowY => {
    if (!rowCache.has(rowY)) {
      rowCache.set(rowY, document.readRegion(layerId, { x: 0, y: rowY, width: document.width, height: 1 }));
      while (rowCache.size > 3) rowCache.delete(rowCache.keys().next().value);
    }
    return rowCache.get(rowY);
  };
  const stagePixel = (px, py) => {
    const tileX = Math.floor(px / tileSize) * tileSize;
    const tileY = Math.floor(py / tileSize) * tileSize;
    const key = tileX + ':' + tileY;
    const replacement = settings.pattern === 'checker' &&
      (Math.floor(px / settings.scale) + Math.floor(py / settings.scale)) % 2 === 1 ? secondary : primary;
    const sourceOffset = px * 4, sourceRow = readRow(py);
    if (sourceRow[sourceOffset] === replacement[0] && sourceRow[sourceOffset + 1] === replacement[1] &&
        sourceRow[sourceOffset + 2] === replacement[2] && sourceRow[sourceOffset + 3] === replacement[3]) return;
    let tile = staged.get(key);
    if (!tile) {
      const width = Math.min(tileSize, document.width - tileX);
      const height = Math.min(tileSize, document.height - tileY);
      const before = document.readRegion(layerId, { x: tileX, y: tileY, width, height });
      const bytes = before.byteLength * 2;
      if (stagedBytes + bytes > settings.maxBytes) {
        throw new RangeError('Fill exceeded the sparse undo byte budget; no pixels were changed.');
      }
      tile = { x: tileX, y: tileY, width, height, before, after: new Uint8ClampedArray(before) };
      staged.set(key, tile);
      stagedBytes += bytes;
    }
    const offset = ((py - tileY) * tile.width + px - tileX) * 4;
    tile.after.set(replacement, offset);
    changedPixels++;
  };

  const seedRow = readRow(y);
  if (!matches(seedRow, x, y)) return 0;
  if (!settings.contiguous) {
    for (let rowY = 0; rowY < document.height; rowY++) {
      const row = readRow(rowY);
      for (let px = 0; px < document.width; px++) if (matches(row, px, rowY)) stagePixel(px, rowY);
    }
  } else {
    // A scanline queue stores one seed per matching run, not one entry per pixel.
    const queue = new Int32Array(settings.maxQueueSegments * 2);
    let head = 0, tail = 0;
    const enqueue = (px, py) => {
      if (tail >= settings.maxQueueSegments) throw new RangeError('Fill exceeded the bounded scanline queue; no pixels were changed.');
      queue[tail * 2] = px; queue[tail * 2 + 1] = py; tail++;
    };
    enqueue(x, y);
    while (head < tail) {
      const px = queue[head * 2], py = queue[head * 2 + 1]; head++;
      const startIndex = py * document.width + px;
      if (wasVisited(startIndex)) continue;
      const row = readRow(py);
      if (!matches(row, px, py)) { markVisited(startIndex); continue; }
      let left = px, right = px;
      while (left > 0 && !wasVisited(py * document.width + left - 1) && matches(row, left - 1)) left--;
      while (right + 1 < document.width && !wasVisited(py * document.width + right + 1) && matches(row, right + 1)) right++;
      for (let scanX = left; scanX <= right; scanX++) {
        markVisited(py * document.width + scanX);
        stagePixel(scanX, py);
      }
      for (const nextY of [py - 1, py + 1]) {
        if (nextY < 0 || nextY >= document.height) continue;
        const nextRow = readRow(nextY);
        let inRun = false;
        for (let scanX = left; scanX <= right; scanX++) {
          const index = nextY * document.width + scanX;
          const eligible = !wasVisited(index) && matches(nextRow, scanX, nextY);
          if (eligible && !inRun) enqueue(scanX, nextY);
          inRun = eligible;
        }
      }
    }
  }

  if (!changedPixels) return 0;
  const entries = [...staged.values()].map(tile => ({
    x: tile.x, y: tile.y, before: tile.before, after: tile.after,
  }));
  const committed = await document.strokeHistory.applyTileOperation(layerId, entries, { type: 'fill' });
  return committed ? changedPixels : 0;
}
