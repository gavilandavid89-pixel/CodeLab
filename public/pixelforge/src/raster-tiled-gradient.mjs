/**
 * Bounded, transactional linear gradients for sparse tiled raster documents.
 *
 * Reads one source row at a time, stages only changed tiles, and commits the
 * complete gradient through tile-operation history. No canvas-sized RGBA
 * buffer is created.
 */
function parseColor(value, name) {
  if (typeof value !== 'string' || !/^#?(?:[0-9a-f]{6})$/i.test(value)) {
    throw new TypeError(name + ' must be a six-digit hex color.');
  }
  const hex = value.replace('#', '');
  return [0, 2, 4].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

export async function fillTiledGradient(document, layerId, x0, y0, x1, y1, options = {}) {
  if (!document?.isTiled || typeof document.readRegion !== 'function' ||
      typeof document.getLayerTileSize !== 'function' || !document.strokeHistory ||
      typeof document.strokeHistory.applyTileOperation !== 'function') {
    throw new TypeError('A transactional sparse tiled raster document is required.');
  }
  if (![x0, y0, x1, y1].every(Number.isInteger) || x0 < 0 || y0 < 0 || x1 < 0 || y1 < 0 ||
      x0 >= document.width || x1 >= document.width || y0 >= document.height || y1 >= document.height) {
    throw new RangeError('Gradient endpoints must be integer document coordinates inside the canvas.');
  }
  const opacity = options.opacity ?? 1;
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    throw new RangeError('Gradient opacity must be between 0 and 1.');
  }
  const maxBytes = options.maxBytes ?? document.strokeHistory.stats.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 8) throw new RangeError('Gradient byte budget must be at least 8 bytes.');
  const layer = document.layers.find(item => item.id === layerId);
  if (!layer) throw new Error('Gradient target layer does not exist.');
  if (layer.locked) throw new Error('The target layer is locked.');
  if (opacity === 0) return 0;

  const start = parseColor(options.startColor ?? '#20202a', 'Gradient start color');
  const end = parseColor(options.endColor ?? '#ffffff', 'Gradient end color');
  const dx = x1 - x0, dy = y1 - y0, lengthSquared = dx * dx + dy * dy || 1;
  const tileSize = document.getLayerTileSize(layerId);
  if (!Number.isInteger(tileSize) || tileSize < 1) throw new Error('Tiled document did not expose a valid tile size.');
  const selectionMask = document.selectionMask;
  const staged = new Map();
  let stagedBytes = 0, changedPixels = 0;
  const effectiveBudget = Math.min(maxBytes, document.strokeHistory.stats.maxBytes);

  for (let y = 0; y < document.height; y++) {
    const row = document.readRegion(layerId, { x: 0, y, width: document.width, height: 1 });
    for (let x = 0; x < document.width; x++) {
      if (selectionMask && !selectionMask[y * document.width + x]) continue;
      const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / lengthSquared));
      const gradient = start.map((channel, index) => Math.round(channel + (end[index] - channel) * t));
      const sourceOffset = x * 4;
      const destinationAlpha = row[sourceOffset + 3] / 255;
      const outputAlpha = opacity + destinationAlpha * (1 - opacity);
      const next = [
        Math.round((gradient[0] * opacity + row[sourceOffset] * destinationAlpha * (1 - opacity)) / outputAlpha),
        Math.round((gradient[1] * opacity + row[sourceOffset + 1] * destinationAlpha * (1 - opacity)) / outputAlpha),
        Math.round((gradient[2] * opacity + row[sourceOffset + 2] * destinationAlpha * (1 - opacity)) / outputAlpha),
        Math.round(outputAlpha * 255),
      ];
      if (next.every((value, channel) => value === row[sourceOffset + channel])) continue;

      const tileX = Math.floor(x / tileSize) * tileSize;
      const tileY = Math.floor(y / tileSize) * tileSize;
      const key = tileX + ':' + tileY;
      let tile = staged.get(key);
      if (!tile) {
        const width = Math.min(tileSize, document.width - tileX);
        const height = Math.min(tileSize, document.height - tileY);
        const before = document.readRegion(layerId, { x: tileX, y: tileY, width, height });
        const bytes = before.byteLength * 2;
        if (stagedBytes + bytes > effectiveBudget) {
          throw new RangeError('Gradient exceeded the sparse undo byte budget; no pixels were changed.');
        }
        tile = { x: tileX, y: tileY, before, after: new Uint8ClampedArray(before) };
        staged.set(key, tile);
        stagedBytes += bytes;
      }
      const offset = ((y - tileY) * Math.min(tileSize, document.width - tileX) + x - tileX) * 4;
      tile.after.set(next, offset);
      changedPixels++;
    }
  }

  if (!changedPixels) return 0;
  const entries = [...staged.values()].map(tile => ({
    x: tile.x, y: tile.y, before: tile.before, after: tile.after,
  }));
  const committed = await document.strokeHistory.applyTileOperation(layerId, entries, { type: 'gradient' });
  return committed ? changedPixels : 0;
}
