const PATCH_FORMAT = 'pixelforge-cel-patch';
const PATCH_VERSION = 2;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function equal(a, b) { return JSON.stringify(stable(a)) === JSON.stringify(stable(b)); }
function indexTiles(tiles, ownership = false) {
  if (!Array.isArray(tiles)) throw new TypeError('Invalid tiled cel data.');
  const result = new Map();
  for (const tile of tiles) {
    const dataKey = ownership ? 'owners' : 'rgba';
    if (!tile || !Number.isInteger(tile.x) || !Number.isInteger(tile.y) ||
        !Number.isInteger(tile.width) || !Number.isInteger(tile.height) ||
        typeof tile.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(tile.sha256) ||
        typeof tile[dataKey] !== 'string') throw new TypeError('Invalid tiled cel tile.');
    const key = tile.x + ':' + tile.y;
    if (result.has(key)) throw new TypeError('Duplicate tile coordinate.');
    result.set(key, tile);
  }
  return result;
}
function diffPlane(before, after, ownership = false) {
  const a = indexTiles(before || [], ownership), b = indexTiles(after || [], ownership), operations = [];
  const dataKey = ownership ? 'owners' : 'rgba';
  for (const [key, tile] of a) if (!b.has(key)) operations.push({ type: ownership ? 'ownership.remove' : 'tile.remove', x: tile.x, y: tile.y });
  for (const [key, tile] of b) {
    const old = a.get(key);
    if (!old || old.sha256 !== tile.sha256 || old[dataKey] !== tile[dataKey] || old.width !== tile.width || old.height !== tile.height) {
      operations.push({ type: ownership ? 'ownership.put' : 'tile.put', x: tile.x, y: tile.y, width: tile.width, height: tile.height, sha256: tile.sha256, [dataKey]: tile[dataKey] });
    }
  }
  return operations;
}
function celFreeProject(project) {
  // Build a metadata-only comparison view without cloning large base64 tile
  // payloads. The editor already holds the previous confirmed snapshot and the
  // freshly serialized snapshot; copying both full manifests here multiplies
  // peak memory for high-resolution projects.
  const copy = { ...project };
  delete copy.revision; delete copy.saveVersion; delete copy.serverRevision; delete copy.dirty;
  if (Array.isArray(project.layers)) {
    copy.layers = project.layers.map(layer => {
      const metadata = { ...layer };
      delete metadata.cel;
      return metadata;
    });
  }
  if (project.animation && Array.isArray(project.animation.frames)) {
    copy.animation = {
      ...project.animation,
      frames: project.animation.frames.map(frame => ({
        ...frame,
        cels: (frame.cels || []).map(entry => {
          const metadata = { ...entry };
          delete metadata.cel;
          return metadata;
        }),
      })),
    };
  }
  return copy;
}

/** Conservative single-cel diff. Returns null for structural/multi-cel changes. */
export function createCelPatch(previous, next, { operationId = globalThis.crypto?.randomUUID?.().replace(/-/g, '') } = {}) {
  const frames = next?.animation?.frames;
  if (!previous || !next || previous.format !== 'pixelforge-tiled-project' || next.format !== previous.format ||
      previous.id !== next.id || !Number.isSafeInteger(previous.serverRevision) || previous.serverRevision < 0 ||
      next.animation?.format !== 'pixelforge-tiled-animation' || previous.animation?.format !== next.animation.format ||
      !Number.isInteger(next.animation.width) || !Number.isInteger(next.animation.height) ||
      !Array.isArray(frames) || !frames.length || !frames[0]?.cels?.[0]?.cel ||
      ![32, 64, 128].includes(frames[0].cels[0].cel.tileSize) ||
      typeof operationId !== 'string' || !/^[-A-Za-z0-9_]{1,180}$/.test(operationId)) return null;
  if (!equal(celFreeProject(previous), celFreeProject(next))) return null;
  const beforeFrames = previous.animation.frames || [];
  if (beforeFrames.length !== frames.length) return null;
  const changed = [];
  for (let i = 0; i < frames.length; i++) {
    const a = beforeFrames[i], b = frames[i];
    if (a.id !== b.id || !Array.isArray(a.cels) || !Array.isArray(b.cels) || a.cels.length !== b.cels.length) return null;
    for (let j = 0; j < a.cels.length; j++) {
      const ac = a.cels[j], bc = b.cels[j];
      if (ac.layerId !== bc.layerId || !equal(ac.metadata, bc.metadata)) return null;
      if (!equal(ac.cel, bc.cel)) changed.push({ frameId: b.id, layerId: bc.layerId, before: ac.cel, after: bc.cel });
    }
  }
  if (changed.length !== 1) return null;
  const { frameId, layerId, before, after } = changed[0];
  const { width, height } = next.animation, tileSize = after?.tileSize;
  if (!before || !after || before.format !== 'pixelforge-tiled-cel' || after.format !== before.format ||
      before.version !== after.version || before.width !== width || after.width !== width ||
      before.height !== height || after.height !== height || ![32, 64, 128].includes(tileSize) || before.tileSize !== tileSize) return null;
  let operations;
  try { operations = [...diffPlane(before.tiles, after.tiles), ...diffPlane(before.ownershipTiles || [], after.ownershipTiles || [], true)]; }
  catch { return null; }
  if (!operations.length || operations.length > 4096) return null;
  operations.sort((a, b) => a.y - b.y || a.x - b.x || a.type.localeCompare(b.type));
  return { format: PATCH_FORMAT, version: PATCH_VERSION, projectId: next.id, baseRevision: previous.serverRevision,
    operationId, frameId, layerId, canvas: { width, height, tileSize }, operations };
}
