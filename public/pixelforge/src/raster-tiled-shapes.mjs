/**
 * Transactional raster shape outlines for sparse tiled PixelForge documents.
 *
 * Shapes are rasterized as bounded brush dabs and grouped into one history
 * command. No full-canvas buffer is allocated; the history budget rolls the
 * whole gesture back if the outline cannot be retained safely.
 */

function resolveMappedPoints(point, mapPoint, width, height) {
  const mapped = mapPoint ? mapPoint(point) : [point];
  if (!Array.isArray(mapped)) throw new TypeError('Shape point mapping must return an array.');
  const unique = new Map();
  for (const candidate of mapped) {
    if (candidate === null || candidate === undefined) continue;
    if (!Number.isInteger(candidate.x) || !Number.isInteger(candidate.y)) {
      throw new TypeError('Mapped shape points must use integer document coordinates.');
    }
    if (candidate.x < 0 || candidate.y < 0 || candidate.x >= width || candidate.y >= height) continue;
    unique.set(candidate.y * width + candidate.x, { x: candidate.x, y: candidate.y });
  }
  return [...unique.values()];
}

/**
 * Draw an already-rasterized line/rectangle/ellipse path.
 *
 * mapPoint can expand each source point for symmetry. A complete preflight
 * checks coordinates and the dab cap before the first pixel is changed.
 */
export async function drawTiledShape(document, layerId, points, settings = {}, {
  mapPoint,
  history = document?.strokeHistory,
  maxDabs = 120_000,
} = {}) {
  if (!document || document.isTiled !== true || typeof document.readRegion !== 'function' ||
      typeof document.writeRegion !== 'function') {
    throw new TypeError('A sparse tiled raster project document is required.');
  }
  if (!Array.isArray(points) || !points.length) return { changed: false, changedDabs: 0, changedPixels: 0 };
  if (!history || typeof history.beginStroke !== 'function' || typeof history.dab !== 'function' ||
      typeof history.commitStroke !== 'function' || typeof history.cancelStroke !== 'function') {
    throw new TypeError('A transactional tiled stroke history is required.');
  }
  if (!Number.isSafeInteger(maxDabs) || maxDabs < 1) throw new RangeError('Shape dab limit must be a positive safe integer.');

  let plannedDabs = 0;
  const mappedPath = [];
  for (const point of points) {
    if (!point || !Number.isInteger(point.x) || !Number.isInteger(point.y) ||
        point.x < 0 || point.y < 0 || point.x >= document.width || point.y >= document.height) {
      throw new RangeError('Shape path contains coordinates outside the document.');
    }
    const mappedPoints = resolveMappedPoints(point, mapPoint, document.width, document.height);
    plannedDabs += mappedPoints.length;
    if (plannedDabs > maxDabs) throw new RangeError('Shape exceeded the sparse raster dab limit before drawing.');
    mappedPath.push(...mappedPoints);
  }
  if (!plannedDabs) return { changed: false, changedDabs: 0, changedPixels: 0 };

  history.beginStroke(layerId, settings);
  let changedDabs = 0, changedPixels = 0;
  try {
    for (const mapped of mappedPath) {
      const result = await history.dab(mapped.x, mapped.y);
      if (result.changed) changedDabs++;
      changedPixels += result.changedPixels || 0;
    }
    const changed = history.commitStroke();
    return { changed, changedDabs, changedPixels };
  } catch (error) {
    if (history.isStrokeActive) await history.cancelStroke();
    throw error;
  }
}
