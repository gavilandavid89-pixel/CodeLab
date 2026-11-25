/**
 * Agent-oriented drawing intelligence.
 *
 * Keeps perception/geometry separate from raster editing so the agent can ask
 * for a whole object's coordinates, proportions and relationships instead of
 * reconstructing them pixel-by-pixel.
 */

export const DRAWING_SHEET_PRESETS = Object.freeze({
  pixel32: { width: 32, height: 32, gridStep: 1, brushMin: 1 },
  pixel64: { width: 64, height: 64, gridStep: 1, brushMin: 1 },
  hybrid128: { width: 128, height: 128, gridStep: 2, brushMin: 1 },
  digital256: { width: 256, height: 256, gridStep: 4, brushMin: 1 },
  digital512: { width: 512, height: 512, gridStep: 8, brushMin: 1 },
  sheet1024: { width: 1024, height: 1024, gridStep: 8, brushMin: 1 },
  sheet2048: { width: 2048, height: 2048, gridStep: 8, brushMin: 1 },
});

export const SEMANTIC_PALETTE = Object.freeze({
  warm: {
    skinLight: '#F6C393', skin: '#E1A37A', skinShadow: '#9E634C',
    red: '#B94A48', orange: '#D9783C', gold: '#D4A84F',
  },
  cool: {
    blue: '#4E79A7', cyan: '#55B8C8', teal: '#3D8E8A',
    violet: '#7C6FB0', coldShadow: '#34445C',
  },
  metallic: {
    steelDark: '#454545', steel: '#6F6F6A', steelLight: '#B8B6AF',
    silver: '#D2D0C9', goldMetal: '#B88932', bronze: '#8D623F',
  },
  neutral: {
    outline: '#141211', black: '#1C1D1F', white: '#EEE7D3', gray: '#808080',
  },
});

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function assertFiniteInt(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(label + ' must be a non-negative integer.');
  return value;
}

function rgbaFromBase64(value) {
  if (typeof value !== 'string') throw new TypeError('pixels must be a base64 string.');
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function rgbaBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

function pixelBounds(pixels, width, height) {
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const a = pixels[(y * width + x) * 4 + 3];
    if (!a) continue;
    count++;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, pixelCount: count };
}

function centroid(pixels, width, height) {
  let sx = 0, sy = 0, weight = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const a = pixels[(y * width + x) * 4 + 3];
    if (!a) continue;
    sx += x * a; sy += y * a; weight += a;
  }
  return weight ? { x: sx / weight, y: sy / weight } : null;
}

function coordinateRuns(coordinates) {
  const rows = new Map();
  for (const point of coordinates) {
    if (!rows.has(point.y)) rows.set(point.y, []);
    rows.get(point.y).push(point.x);
  }
  const runs = [];
  for (const [y, xs] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    xs.sort((a, b) => a - b);
    let start = xs[0], previous = xs[0];
    for (let i = 1; i < xs.length; i++) {
      if (xs[i] === previous + 1) { previous = xs[i]; continue; }
      runs.push({ y, x: start, length: previous - start + 1 });
      start = previous = xs[i];
    }
    runs.push({ y, x: start, length: previous - start + 1 });
  }
  return runs;
}

function boundaryRuns(pixels, width, height) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const runs = [];
    let start = -1;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const occupied = pixels[i + 3] > 0;
      let boundary = false;
      if (occupied) {
        const neighbors = [[-1,0],[1,0],[0,-1],[0,1]];
        boundary = neighbors.some(([dx,dy]) => {
          const nx=x+dx, ny=y+dy;
          return nx<0 || ny<0 || nx>=width || ny>=height || pixels[(ny*width+nx)*4+3]===0;
        });
      }
      if (boundary && start < 0) start = x;
      if (!boundary && start >= 0) { runs.push([start, x - 1]); start = -1; }
    }
    if (start >= 0) runs.push([start, width - 1]);
    if (runs.length) rows.push({ y, runs });
  }
  return rows;
}

function connectedComponent(pixels, width, height, x, y) {
  const seed = (y * width + x) * 4;
  if (pixels[seed + 3] === 0) return null;
  const total = width * height;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0, tail = 0, count = 0;
  queue[tail++] = y * width + x; visited[y * width + x] = 1;
  let minX=width, minY=height, maxX=-1, maxY=-1, sx=0, sy=0;
  const coordinates = [];
  while (head < tail) {
    const p = queue[head++], px = p % width, py = Math.floor(p / width);
    const a = pixels[p * 4 + 3];
    if (!a) continue;
    count++; minX=Math.min(minX,px); minY=Math.min(minY,py); maxX=Math.max(maxX,px); maxY=Math.max(maxY,py);
    sx += px * a; sy += py * a;
    if (coordinates.length < 20000) coordinates.push({ x:px, y:py });
    const neighbors = [p-1,p+1,p-width,p+width];
    if (px > 0 && !visited[p-1]) { visited[p-1]=1; queue[tail++]=p-1; }
    if (px+1 < width && !visited[p+1]) { visited[p+1]=1; queue[tail++]=p+1; }
    if (py > 0 && !visited[p-width]) { visited[p-width]=1; queue[tail++]=p-width; }
    if (py+1 < height && !visited[p+width]) { visited[p+width]=1; queue[tail++]=p+width; }
  }
  return {
    pixelCount: count,
    bounds: maxX < 0 ? null : { x:minX, y:minY, width:maxX-minX+1, height:maxY-minY+1 },
    centroid: count ? { x:sx/count, y:sy/count } : null,
    coordinates: coordinates.length === count ? coordinates : null,
    coordinatesTruncated: coordinates.length !== count,
  };
}

function normalizeSheet(settings = {}) {
  const preset = settings.preset && DRAWING_SHEET_PRESETS[settings.preset] ? DRAWING_SHEET_PRESETS[settings.preset] : null;
  const merged = { ...(preset || {}), ...settings };
  const width = assertFiniteInt(merged.width ?? 128, 'width');
  const height = assertFiniteInt(merged.height ?? width, 'height');
  if (width < 1 || height < 1 || width > 4096 || height > 4096) throw new RangeError('Drawing sheet must be between 1 and 4096 pixels.');
  const gridStep = assertFiniteInt(merged.gridStep ?? 8, 'gridStep');
  if (gridStep < 1 || gridStep > 256) throw new RangeError('gridStep must be between 1 and 256.');
  return {
    mode: String(merged.mode || 'digital-sheet'),
    preset: merged.preset || null,
    width, height, gridStep,
    brushMin: Math.max(1, Number(merged.brushMin ?? 1)),
    finePrecision: merged.finePrecision !== false,
  };
}

export function createDrawingModel({ sheet = {}, palette = SEMANTIC_PALETTE } = {}) {
  return {
    version: 1,
    sheet: normalizeSheet(sheet),
    palette: clone(palette),
    objects: [],
    referenceCenter: {
      version: 2,
      entries: [],
      activeEntryId: null,
      viewContext: { previousOpacity: 0.25, nextOpacity: 0.15, previousCount: 1, nextCount: 1 },
    },
    currentState: { version: 1, entries: [], activeEntryId: null },
    environmentHistory: { version: 1, entries: [], activeEntryId: null },
    layerRoles: {},
  };
}

export function normalizeDrawingModel(model, { width = 128, height = 128 } = {}) {
  const base = createDrawingModel({ sheet: { width, height } });
  const input = model && typeof model === 'object' ? model : {};
  return {
    ...base,
    ...clone(input),
    sheet: normalizeSheet({ ...base.sheet, ...(input.sheet || {}), width: input.sheet?.width ?? width, height: input.sheet?.height ?? height }),
    palette: clone(input.palette || SEMANTIC_PALETTE),
    objects: Array.isArray(input.objects) ? clone(input.objects) : [],
    referenceCenter: {
      ...base.referenceCenter,
      ...(input.referenceCenter || {}),
      entries: Array.isArray(input.referenceCenter?.entries) ? clone(input.referenceCenter.entries) : [],
      viewContext: { ...base.referenceCenter.viewContext, ...(input.referenceCenter?.viewContext || {}) },
    },
    currentState: {
      ...base.currentState,
      ...(input.currentState || {}),
      entries: Array.isArray(input.currentState?.entries) ? clone(input.currentState.entries) : [],
    },
    environmentHistory: {
      ...base.environmentHistory,
      ...(input.environmentHistory || {}),
      entries: Array.isArray(input.environmentHistory?.entries) ? clone(input.environmentHistory.entries) : [],
    },
    layerRoles: input.layerRoles && typeof input.layerRoles === 'object' ? clone(input.layerRoles) : {},
  };
}

export function setDrawingLayerRole(model, { layerId, role = 'detail', entityId = null, entityName = null } = {}) {
  if (!layerId || typeof layerId !== 'string') throw new TypeError('layerId is required.');
  const next = normalizeDrawingModel(model);
  const allowed = new Set(['environment', 'character', 'object', 'effect', 'guide', 'detail']);
  if (!allowed.has(String(role))) throw new TypeError('Unsupported layer role.');
  next.layerRoles[layerId] = { role: String(role), entityId: entityId ? String(entityId) : null, entityName: entityName ? String(entityName).slice(0, 120) : null, updatedAt: new Date().toISOString() };
  return next;
}

export function getCurrentState(model, entityId = null) {
  const normalized = normalizeDrawingModel(model);
  if (entityId) return normalized.currentState.entries.find(entry => entry.id === entityId || entry.entityId === entityId) || null;
  return normalized.currentState.activeEntryId ? normalized.currentState.entries.find(entry => entry.id === normalized.currentState.activeEntryId) || null : null;
}

export function setCurrentState(model, state = {}) {
  const normalized = normalizeDrawingModel(model);
  const id = String(state.id || state.entityId || crypto.randomUUID());
  const entry = {
    id, entityId: state.entityId ? String(state.entityId) : id,
    name: String(state.name || state.entityId || 'Current state').slice(0, 120),
    scope: String(state.scope || 'element'), sourceRevision: Number(state.sourceRevision || 0),
    frameIndex: Number.isInteger(state.frameIndex) ? state.frameIndex : null,
    layerIds: Array.isArray(state.layerIds) ? [...new Set(state.layerIds.map(String))] : [],
    appearance: clone(state.appearance || {}), transform: clone(state.transform || {}),
    observedChanges: Array.isArray(state.observedChanges) ? clone(state.observedChanges) : [],
    attachments: Array.isArray(state.attachments) ? clone(state.attachments) : [],
    notes: String(state.notes || '').slice(0, 2000), updatedAt: new Date().toISOString(),
  };
  const existing = normalized.currentState.entries.findIndex(item => item.id === entry.id);
  if (existing >= 0) normalized.currentState.entries[existing] = entry; else normalized.currentState.entries.push(entry);
  normalized.currentState.activeEntryId = entry.id;
  return normalized;
}

export function recordEnvironmentHistory(model, snapshot = {}) {
  const normalized = normalizeDrawingModel(model);
  const entry = {
    id: String(snapshot.id || crypto.randomUUID()), sourceRevision: Number(snapshot.sourceRevision || 0),
    animationId: snapshot.animationId ? String(snapshot.animationId) : null,
    frameIndex: Number.isInteger(snapshot.frameIndex) ? snapshot.frameIndex : null,
    label: String(snapshot.label || 'Environment ' + (Number.isInteger(snapshot.frameIndex) ? snapshot.frameIndex + 1 : normalized.environmentHistory.entries.length + 1)).slice(0, 120),
    environmentLayerIds: Array.isArray(snapshot.environmentLayerIds) ? [...new Set(snapshot.environmentLayerIds.map(String))] : Object.entries(normalized.layerRoles).filter(([, meta]) => meta?.role === 'environment').map(([id]) => id),
    source: String(snapshot.source || 'animation'), replayable: snapshot.replayable !== false,
    createdAt: snapshot.createdAt || new Date().toISOString(),
  };
  normalized.environmentHistory.entries.push(entry);
  if (normalized.environmentHistory.entries.length > 240) normalized.environmentHistory.entries.splice(0, normalized.environmentHistory.entries.length - 240);
  normalized.environmentHistory.activeEntryId = entry.id;
  return normalized;
}

export function getEnvironmentHistoryEntry(model, id = null) {
  const normalized = normalizeDrawingModel(model);
  return id ? normalized.environmentHistory.entries.find(entry => entry.id === id) || null
    : normalized.environmentHistory.activeEntryId ? normalized.environmentHistory.entries.find(entry => entry.id === normalized.environmentHistory.activeEntryId) || null
    : normalized.environmentHistory.entries.at(-1) || null;
}

export function createAlphaComponentSelection({ pixels, width, height, x, y } = {}) {
  if (!(pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray) || pixels.length !== width * height * 4) throw new TypeError('RGBA pixels must match width × height × 4.');
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) throw new RangeError('Selection point is outside canvas bounds.');
  const mask = new Uint8Array(width * height);
  const seed = (y * width + x) * 4;
  if (!pixels[seed + 3]) return { mask, selectedPixels: 0, bounds: null };
  const queue = new Int32Array(width * height);
  let head = 0, tail = 0, selectedPixels = 0;
  queue[tail++] = y * width + x; mask[y * width + x] = 1;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  while (head < tail) {
    const p = queue[head++], px = p % width, py = Math.floor(p / width);
    if (!pixels[p * 4 + 3]) continue;
    selectedPixels++; minX=Math.min(minX,px); minY=Math.min(minY,py); maxX=Math.max(maxX,px); maxY=Math.max(maxY,py);
    const add = next => {
      if (next < 0 || next >= mask.length || mask[next] || !pixels[next * 4 + 3]) return;
      mask[next] = 1; queue[tail++] = next;
    };
    if (px > 0) add(p - 1);
    if (px + 1 < width) add(p + 1);
    if (py > 0) add(p - width);
    if (py + 1 < height) add(p + width);
  }
  return {
    mask,
    selectedPixels,
    bounds: maxX < 0 ? null : { x:minX, y:minY, width:maxX-minX+1, height:maxY-minY+1 },
  };
}

export function inspectRasterObject({ pixels, width, height, objectId = null, x = null, y = null, gridStep = 8 } = {}) {
  if (!((pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray)) || pixels.length !== width * height * 4) throw new TypeError('RGBA pixels must match width × height × 4.');
  const component = x !== null && y !== null ? connectedComponent(pixels, width, height, x, y) : pixelBounds(pixels, width, height);
  if (!component) return { found: false };
  const bounds = component.bounds;
  return {
    found: true,
    objectId: objectId || crypto.randomUUID(),
    pixelCount: component.pixelCount,
    bounds,
    centroid: component.centroid,
    proportions: {
      canvas: { widthRatio: bounds.width / width, heightRatio: bounds.height / height },
      relativeToCanvasCenter: { x: (component.centroid.x / Math.max(1, width - 1)) - 0.5, y: (component.centroid.y / Math.max(1, height - 1)) - 0.5 },
      aspectRatio: bounds.width / Math.max(1, bounds.height),
    },
    coordinates: component.coordinates,
    coordinatesTruncated: component.coordinatesTruncated,
    boundaryRuns: boundaryRuns(pixels, width, height),
    grid: {
      step: gridStep,
      boundsInCells: {
        x: Math.floor(bounds.x / gridStep),
        y: Math.floor(bounds.y / gridStep),
        width: Math.ceil(bounds.width / gridStep),
        height: Math.ceil(bounds.height / gridStep),
      },
    },
  };
}

export function inspectLayerPixels(layer, width, height, { gridStep = 8, objectId = null } = {}) {
  return inspectRasterObject({ pixels: layer.pixels, width, height, gridStep, objectId });
}

export function extractLineGuide({ pixels, width, height, threshold = 28, detail = 1, invert = false } = {}) {
  if (!(pixels instanceof Uint8Array) || pixels.length !== width * height * 4) throw new TypeError('RGBA pixels must match width × height × 4.');
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 255) throw new RangeError('threshold must be 0..255.');
  const source = pixels;
  const out = new Uint8Array(width * height * 4);
  const scale = Math.max(1, Math.min(4, Number(detail) || 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i=(y*width+x)*4;
    const lum = 0.2126*source[i]+0.7152*source[i+1]+0.0722*source[i+2];
    let gx=0, gy=0;
    for (let d=1; d<=scale; d++) {
      const lx=Math.max(0,x-d), rx=Math.min(width-1,x+d), ty=Math.max(0,y-d), by=Math.min(height-1,y+d);
      const l=0.2126*source[(y*width+lx)*4]+0.7152*source[(y*width+lx)*4+1]+0.0722*source[(y*width+lx)*4+2];
      const r=0.2126*source[(y*width+rx)*4]+0.7152*source[(y*width+rx)*4+1]+0.0722*source[(y*width+rx)*4+2];
      const t=0.2126*source[(ty*width+x)*4]+0.7152*source[(ty*width+x)*4+1]+0.0722*source[(ty*width+x)*4+2];
      const b=0.2126*source[(by*width+x)*4]+0.7152*source[(by*width+x)*4+1]+0.0722*source[(by*width+x)*4+2];
      gx += r-l; gy += b-t;
    }
    const edge=Math.min(255, Math.round(Math.hypot(gx,gy)));
    const value = invert ? (edge >= threshold ? 255 : 0) : (edge >= threshold ? 0 : 255);
    const alpha = edge >= threshold ? 255 : 0;
    out[i]=value; out[i+1]=value; out[i+2]=value; out[i+3]=alpha;
  }
  return { pixels: out, width, height, threshold, detail: scale, mimeType: 'image/line-guide' };
}

export function analyzeMotion({ beforePixels, afterPixels, width, height, gridStep = 8 } = {}) {
  if (!(beforePixels instanceof Uint8Array || beforePixels instanceof Uint8ClampedArray) ||
      !(afterPixels instanceof Uint8Array || afterPixels instanceof Uint8ClampedArray) ||
      beforePixels.length !== width * height * 4 || afterPixels.length !== width * height * 4) {
    throw new TypeError('Motion frames must contain matching RGBA pixel buffers.');
  }
  const before = inspectRasterObject({ pixels: beforePixels, width, height, gridStep });
  const after = inspectRasterObject({ pixels: afterPixels, width, height, gridStep });
  if (!before.found || !after.found) return { found: false, reason: 'one_or_both_frames_have_no_opaque_pixels' };
  const dx = after.centroid.x - before.centroid.x, dy = after.centroid.y - before.centroid.y;
  return {
    found: true,
    displacement: { dx, dy, distance: Math.hypot(dx, dy), direction: Math.atan2(dy, dx) * 180 / Math.PI },
    before: { bounds: before.bounds, centroid: before.centroid, proportions: before.proportions },
    after: { bounds: after.bounds, centroid: after.centroid, proportions: after.proportions },
    delta: {
      width: after.bounds.width - before.bounds.width,
      height: after.bounds.height - before.bounds.height,
      widthRatio: after.proportions.canvas.widthRatio - before.proportions.canvas.widthRatio,
      heightRatio: after.proportions.canvas.heightRatio - before.proportions.canvas.heightRatio,
    },
    interpretation: {
      translated: Math.hypot(dx, dy) > 0,
      grew: after.bounds.width > before.bounds.width || after.bounds.height > before.bounds.height,
      shrank: after.bounds.width < before.bounds.width || after.bounds.height < before.bounds.height,
    },
  };
}

export function inferReferenceCategory(name = '', type = '') {
  const value = String(name + ' ' + type).toLowerCase();
  if (/dust|powder|smoke|fire|spark|particle|effect|vfx|explosion/.test(value)) return 'effect';
  if (/character|soldier|robot|person|hero|enemy|npc|creature/.test(value)) return 'character';
  if (/scene|background|environment|forest|building|room|landscape/.test(value)) return 'scene';
  if (/part|piece|arm|head|hand|leg|weapon|rifle|sword|object|prop/.test(value)) return 'part';
  return 'object';
}

export function registerReferenceEntry(model, entry) {
  const normalized = {
    id: String(entry.id || crypto.randomUUID()),
    name: String(entry.name || 'Reference').slice(0, 120),
    type: String(entry.type || 'drawing'),
    category: String(entry.category || inferReferenceCategory(entry.name, entry.type)),
    version: Number(entry.version || 1),
    immutableSnapshot: entry.immutableSnapshot !== false,
    createdAt: entry.createdAt || new Date().toISOString(),
    sourceProjectId: entry.sourceProjectId || null,
    sourceRevision: Number(entry.sourceRevision || 0),
    frames: Array.isArray(entry.frames) ? clone(entry.frames) : [],
    parts: Array.isArray(entry.parts) ? clone(entry.parts) : [],
    layerSnapshot: Array.isArray(entry.layerSnapshot) ? clone(entry.layerSnapshot) : [],
    frameLayerMap: Array.isArray(entry.frameLayerMap) ? clone(entry.frameLayerMap) : [],
    animation: clone(entry.animation || null),
    geometry: clone(entry.geometry || {}),
    palette: clone(entry.palette || model.palette),
    preview: clone(entry.preview || null),
    notes: String(entry.notes || '').slice(0, 2000),
  };
  const next = clone(model);
  next.referenceCenter.entries.push(normalized);
  next.referenceCenter.activeEntryId = normalized.id;
  return next;
}

export function getReferenceEntry(model, id) {
  const entry = model?.referenceCenter?.entries?.find(item => item.id === id);
  return entry ? clone(entry) : null;
}

export function normalizeReferenceFrame({ index, durationMs, layers = [] } = {}) {
  return {
    index: assertFiniteInt(index, 'index'),
    durationMs: Math.max(1, Number(durationMs || 100)),
    layers: Array.isArray(layers) ? clone(layers) : [],
  };
}

export function normalizeSemanticPart(part) {
  if (!part || typeof part !== 'object') throw new TypeError('Semantic part must be an object.');
  return {
    id: String(part.id || crypto.randomUUID()),
    name: String(part.name || part.id || 'part').slice(0, 120),
    role: String(part.role || 'detail').slice(0, 80),
    layerId: part.layerId || null,
    frameIndex: Number.isInteger(part.frameIndex) ? part.frameIndex : null,
    bounds: part.bounds ? clone(part.bounds) : null,
    anchors: clone(part.anchors || {}),
    proportions: clone(part.proportions || {}),
    colorRoles: Array.isArray(part.colorRoles) ? [...part.colorRoles] : [],
    z: Number.isFinite(Number(part.z)) ? Number(part.z) : 0,
  };
}

export function buildReferenceFromProject({ projectId, project, name = 'Drawing reference' } = {}) {
  if (!project || typeof project !== 'object') throw new TypeError('project is required.');
  const sourceLayers = Array.isArray(project.layers) ? project.layers : [];
  const frames = Array.isArray(project.animation?.frames)
    ? project.animation.frames.map((frame, index) => normalizeReferenceFrame({
      index,
      durationMs: frame.durationMs,
      layers: frame.cels.map(cel => ({
        layerId: cel.layerId,
        pixels: typeof cel.pixels === 'string' ? cel.pixels : null,
        pixelBytes: typeof cel.pixels === 'string' ? Math.floor(cel.pixels.length * 3 / 4) : 0,
      })),
    }))
    : [];
  const parts = sourceLayers.map((layer, index) => normalizeSemanticPart({
    id: layer.id, name: layer.name, role: index === 0 ? 'background' : 'drawing-part',
    layerId: layer.id, frameIndex: null,
    bounds: null,
    proportions: { layerIndex: index / Math.max(1, sourceLayers.length - 1) },
    z: index,
  }));
  return {
    id: crypto.randomUUID(),
    name,
    type: 'project-reference',
    category: inferReferenceCategory(name, 'project-reference'),
    version: 2,
    sourceProjectId: projectId || project.id || null,
    sourceRevision: project.serverRevision ?? project.revision ?? 0,
    createdAt: new Date().toISOString(),
    immutableSnapshot: true,
    frames,
    parts: parts.map(part => ({
      ...part,
      pixels: sourceLayers.find(layer => layer.id === part.layerId)?.pixels || null,
      ownershipTiles: structuredClone(sourceLayers.find(layer => layer.id === part.layerId)?.ownershipTiles || []),
    })),
    geometry: {
      canvas: { width: project.width, height: project.height },
      sheet: project.drawingModel?.sheet || null,
      objectCount: parts.length,
    },
    animation: project.animation ? {
      width: project.animation.width || project.width,
      height: project.animation.height || project.height,
      fps: project.animation.fps || 12,
      loop: project.animation.loop !== false,
      layerIds: Array.isArray(project.animation.layerIds) ? [...project.animation.layerIds] : sourceLayers.map(layer => layer.id),
    } : null,
    palette: project.drawingModel?.palette || SEMANTIC_PALETTE,
    layerSnapshot: sourceLayers.map((layer, index) => ({
      id: layer.id, name: layer.name, index, opacity: layer.opacity, visible: layer.visible, locked: layer.locked,
      pixels: layer.pixels || null,
      ownershipTiles: structuredClone(layer.ownershipTiles || []),
    })),
    frameLayerMap: Array.isArray(project.animation?.frames) ? project.animation.frames.map((frame, index) => ({
      index, frameId: frame.id, durationMs: frame.durationMs,
      layers: frame.cels.map(cel => ({ layerId: cel.layerId, pixels: cel.pixels || null, ownershipTiles: structuredClone(frame.layerMetadata?.find(item => item.layerId === cel.layerId)?.ownershipTiles || []) })),
    })) : [],
  };
}

export function compositeReferenceFrameOwnership(entry, frameIndex, width, height) {
  if (!entry || !Array.isArray(entry.frames)) throw new TypeError('A reference animation is required.');
  const frame = entry.frames.find(item => Number(item.index) === Number(frameIndex));
  if (!frame) throw new Error('Reference frame was not found.');
  const owners = new Uint8Array(width * height);
  for (const source of frame.layers || []) {
    if (typeof source.pixels !== 'string') continue;
    const pixels = deserializePixels(source.pixels);
    if (pixels.length !== width * height * 4) throw new RangeError('Reference frame layer pixels have invalid dimensions.');
    const sourceOwners = new Uint8Array(width * height);
    for (const tile of source.ownershipTiles || []) {
      const tileOwners = deserializePixels(tile.owners);
      if (tileOwners.length !== tile.width * tile.height) throw new RangeError('Reference frame ownership tile has invalid dimensions.');
      for (let row = 0; row < tile.height; row++) {
        const target = (tile.y + row) * width + tile.x;
        sourceOwners.set(tileOwners.subarray(row * tile.width, (row + 1) * tile.width), target);
      }
    }
    for (let pixel = 0; pixel < owners.length; pixel++) if (pixels[pixel * 4 + 3] > 0) owners[pixel] = sourceOwners[pixel];
  }
  const tiles = [];
  for (let y = 0; y < height; y += 64) for (let x = 0; x < width; x += 64) {
    const tileWidth = Math.min(64, width - x), tileHeight = Math.min(64, height - y), bytes = new Uint8Array(tileWidth * tileHeight);
    for (let row = 0; row < tileHeight; row++) bytes.set(owners.subarray((y + row) * width + x, (y + row) * width + x + tileWidth), row * tileWidth);
    if (bytes.some(value => value !== 0)) tiles.push({ x, y, width: tileWidth, height: tileHeight, owners: serializePixels(bytes) });
  }
  return tiles;
}

export function copyReferencePixelsToActiveFrameLayer({ drawingDocument, animation = null, pixels, ownershipTiles = [] } = {}) {
  const layer = drawingDocument?.activeLayer;
  if (!drawingDocument || !layer) throw new TypeError('An active PixelForge layer is required.');
  if (layer.locked) throw new Error('The active PixelForge layer is locked.');
  if (!(pixels instanceof Uint8Array) || pixels.length !== drawingDocument.width * drawingDocument.height * 4) {
    throw new TypeError('Reference pixels must match the active canvas RGBA8 dimensions.');
  }
  const copy = new Uint8Array(pixels);
  const ownerMap = new Map((ownershipTiles || []).map(tile => [`${tile.x / 64}:${tile.y / 64}`, deserializePixels(tile.owners)]));
  if (animation) {
    if (typeof animation.setLayerPixels !== 'function' || !Number.isInteger(animation.activeFrameIndex)) {
      throw new TypeError('The active animation frame cannot accept reference pixels.');
    }
    animation.setLayerPixels(animation.activeFrameIndex, layer.id, new Uint8Array(copy));
    if (typeof animation.setLayerMetadata === 'function') animation.setLayerMetadata(animation.activeFrameIndex, layer.id, { ...animation.getLayerMetadata(animation.activeFrameIndex, layer.id), ownershipTiles: ownerMap });
  }
  drawingDocument.setLayerPixels(layer.id, copy, { restore: true, ownershipTiles: ownerMap });
  drawingDocument.dirty = true;
  return { layerId: layer.id, frameIndex: animation?.activeFrameIndex ?? null, copiedBytes: copy.byteLength };
}

export function compositeReferenceFramePixels(entry, frameIndex, width, height) {
  if (!entry || !Array.isArray(entry.frames)) throw new TypeError('A reference animation is required.');
  const frame = entry.frames.find(item => Number(item.index) === Number(frameIndex));
  if (!frame) throw new Error('Reference frame was not found.');
  const sourceWidth = Number(entry.geometry?.canvas?.width || width);
  const sourceHeight = Number(entry.geometry?.canvas?.height || height);
  if (sourceWidth !== width || sourceHeight !== height) {
    throw new RangeError('Reference frame dimensions must match the current canvas.');
  }
  const output = new Uint8Array(width * height * 4);
  for (const source of frame.layers || []) {
    if (typeof source.pixels !== 'string') continue;
    const pixels = deserializePixels(source.pixels);
    if (pixels.length !== output.length) throw new RangeError('Reference frame layer pixels have invalid dimensions.');
    const metadata = entry.layerSnapshot?.find(layer => layer.id === source.layerId);
    if (metadata?.visible === false) continue;
    const opacity = Math.max(0, Math.min(1, Number(metadata?.opacity ?? 1)));
    if (opacity === 0) continue;
    for (let offset = 0; offset < output.length; offset += 4) {
      const sourceAlpha = (pixels[offset + 3] / 255) * opacity;
      if (sourceAlpha <= 0) continue;
      const targetAlpha = output[offset + 3] / 255;
      const combinedAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
      for (let channel = 0; channel < 3; channel++) {
        output[offset + channel] = Math.round(
          (pixels[offset + channel] * sourceAlpha +
            output[offset + channel] * targetAlpha * (1 - sourceAlpha)) / combinedAlpha
        );
      }
      output[offset + 3] = Math.round(combinedAlpha * 255);
    }
  }
  return output;
}

export function applyReferenceToDrawingModel(model, entry) {
  if (!entry || typeof entry !== 'object') throw new TypeError('reference entry is required.');
  const next = clone(model);
  next.objects = Array.isArray(entry.parts) ? entry.parts.map(part => normalizeSemanticPart(part)) : [];
  next.sheet = normalizeSheet({ ...next.sheet, ...(entry.geometry?.sheet || {}) });
  next.referenceCenter.activeEntryId = entry.id;
  return next;
}

export function serializePixels(bytes) { return rgbaBase64(bytes); }
export function deserializePixels(value) { return rgbaFromBase64(value); }
