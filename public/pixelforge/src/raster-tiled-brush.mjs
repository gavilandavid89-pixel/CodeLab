/**
 * Sparse tile-backed brush/eraser rasterization.
 *
 * This is an opt-in primitive for the tiled editor migration. It intentionally
 * writes only the brush's bounded dirty rectangle and does not materialize a
 * full layer. Undo/history and editor pointer integration remain separate gates.
 */
import { parseHexColor } from './core.js';

function validateSettings(settings = {}) {
  const {
    color = '#20202a', size = 1, mode = 'draw', opacity = 1,
    shape = 'square', hardness = 1,
  } = settings;
  if (!Number.isFinite(size) || size < 1 || size > 128) {
    throw new RangeError('Brush size must be between 1 and 128 pixels.');
  }
  if (!['draw', 'erase'].includes(mode)) throw new TypeError('Unsupported tiled brush mode.');
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    throw new RangeError('Brush opacity must be between 0 and 1.');
  }
  if (!['square', 'circle'].includes(shape)) throw new TypeError('Brush shape must be square or circle.');
  if (!Number.isFinite(hardness) || hardness < 0 || hardness > 1) {
    throw new RangeError('Brush hardness must be between 0 and 1.');
  }
  return { color: parseHexColor(color), size: Math.round(size), mode, opacity, shape, hardness };
}

/**
 * Apply one brush dab using the same coverage and alpha-compositing rules as
 * RasterDocument.#dab, but read/write only the dab's clipped document region.
 */
export async function applyTiledBrushDab(document, layerId, x, y, settings = {}) {
  if (!document || typeof document.readRegion !== 'function' || typeof document.writeRegionWithOwnership !== 'function' ||
      !Number.isInteger(document.width) || !Number.isInteger(document.height)) {
    throw new TypeError('A tile-aware raster project document is required.');
  }
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= document.width || y >= document.height) {
    throw new RangeError('Brush coordinates are outside the document bounds.');
  }
  const layer = document.layers.find(item => item.id === layerId);
  if (!layer) throw new Error('Unknown tiled brush layer.');
  if (layer.locked) throw new Error('The active layer is locked.');
  const brush = validateSettings(settings);
  const authoringMode = settings.authoringMode ?? document.drawingConfiguration?.activeMode ?? layer.authoringMode;
  if (!['illustration', 'pixel-art'].includes(authoringMode)) throw new TypeError('Tiled brush requires an explicit Illustration or Pixel Art authoringMode.');
  if (brush.opacity <= 0) return { changed: false, changedTiles: 0 };

  const offset = Math.floor((brush.size - 1) / 2);
  const region = {
    x: Math.max(0, x - offset),
    y: Math.max(0, y - offset),
    width: Math.min(document.width - 1, x - offset + brush.size - 1) - Math.max(0, x - offset) + 1,
    height: Math.min(document.height - 1, y - offset + brush.size - 1) - Math.max(0, y - offset) + 1,
  };
  const before = document.readRegion(layerId, region);
  const pixels = new Uint8ClampedArray(before);
  const selectionMask = document.selectionMask;
  let changedPixels = 0;
  for (let py = 0; py < region.height; py++) {
    for (let px = 0; px < region.width; px++) {
      const documentX = region.x + px, documentY = region.y + py;
      if (selectionMask && !selectionMask[documentY * document.width + documentX]) continue;
      let coverage = 1;
      if (brush.shape === 'circle') {
        const centerOffset = brush.size % 2 === 0 ? 0.5 : 0;
        const radius = brush.size / 2;
        const distance = Math.hypot(documentX - (x + centerOffset), documentY - (y + centerOffset));
        if (distance >= radius) continue;
        const innerRadius = radius * brush.hardness;
        coverage = distance <= innerRadius || brush.hardness >= 1
          ? 1
          : Math.max(0, Math.min(1, (radius - distance) / Math.max(0.0001, radius - innerRadius)));
        if (coverage <= 0) continue;
      }
      const effectiveOpacity = brush.opacity * coverage;
      const index = (py * region.width + px) * 4;
      const alpha = pixels[index + 3];
      let nextAlpha = alpha;
      let red = pixels[index], green = pixels[index + 1], blue = pixels[index + 2];
      if (brush.mode === 'erase') {
        nextAlpha = Math.round(alpha * (1 - effectiveOpacity));
        if (nextAlpha === 0) red = green = blue = 0;
      } else {
        const destinationAlpha = alpha / 255, sourceAlpha = effectiveOpacity;
        const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
        if (outputAlpha <= 0) continue;
        red = Math.round((brush.color[0] * sourceAlpha + red * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
        green = Math.round((brush.color[1] * sourceAlpha + green * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
        blue = Math.round((brush.color[2] * sourceAlpha + blue * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
        nextAlpha = Math.round(outputAlpha * 255);
      }
      if (red === pixels[index] && green === pixels[index + 1] &&
          blue === pixels[index + 2] && nextAlpha === pixels[index + 3]) continue;
      pixels[index] = red; pixels[index + 1] = green; pixels[index + 2] = blue; pixels[index + 3] = nextAlpha;
      changedPixels++;
    }
  }
  if (!changedPixels) return { changed: false, changedTiles: 0, changedPixels: 0, blockedPixels: 0 };
  const result = await document.writeRegionWithOwnership(layerId, region, pixels, { authoringMode, operation: brush.mode === 'erase' ? 'erase' : 'draw' });
  return { ...result, changedPixels: result.changedPixels || 0, blockedPixels: result.blockedPixels || 0 };
}

/**
 * Rasterize a continuous segment with the same 1.5× distance sampling used by
 * RasterDocument.strokeTo. Each dab remains bounded and is committed in order.
 */
export async function applyTiledBrushSegment(document, layerId, from, to, settings = {}) {
  if (!from || !to || !Number.isInteger(from.x) || !Number.isInteger(from.y) ||
      !Number.isInteger(to.x) || !Number.isInteger(to.y)) {
    throw new TypeError('Brush segment endpoints must be integer document coordinates.');
  }
  const dx = to.x - from.x, dy = to.y - from.y;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) * 1.5));
  const results = [];
  for (let index = 1; index <= steps; index++) {
    const x = Math.round(from.x + dx * index / steps);
    const y = Math.round(from.y + dy * index / steps);
    results.push(await applyTiledBrushDab(document, layerId, x, y, settings));
  }
  return {
    changed: results.some(result => result.changed),
    changedDabs: results.filter(result => result.changed).length,
    changedPixels: results.reduce((sum, result) => sum + (result.changedPixels || 0), 0),
    changedTiles: results.reduce((sum, result) => sum + (result.changedTiles || 0), 0),
  };
}
