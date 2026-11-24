const SECTION_DEFINITIONS = Object.freeze([
  { key: 'environment', label: 'Environment' },
  { key: 'effects', label: 'Effects' },
  { key: 'details', label: 'Details' },
  { key: 'elements', label: 'Elements' },
  { key: 'objects', label: 'Objects' },
]);
const SECTION_KEYS = new Set(SECTION_DEFINITIONS.map(section => section.key));

const clone = value => value == null ? value : structuredClone(value);

export function sceneWorkspaceSections() {
  return SECTION_DEFINITIONS.map(section => ({ ...section }));
}

export function readSceneWorkspaceState(drawingModel) {
  const raw = drawingModel?.sceneWorkspaceState;
  const workspaces = raw?.workspaces && typeof raw.workspaces === 'object' && !Array.isArray(raw.workspaces)
    ? Object.fromEntries(Object.entries(raw.workspaces).filter(([key, value]) => SECTION_KEYS.has(key) && value && typeof value === 'object').map(([key, value]) => [key, clone(value)]))
    : {};
  for (const key of SECTION_KEYS) {
    const importedWorkspace = drawingModel?.sceneSections?.[key]?.workspace;
    if (!workspaces[key] && importedWorkspace && typeof importedWorkspace === 'object') {
      workspaces[key] = clone(importedWorkspace);
    }
  }
  return {
    version: 1,
    activeSection: raw?.activeSection === 'main' || SECTION_KEYS.has(raw?.activeSection) ? raw.activeSection : 'main',
    parentWorkspace: raw?.parentWorkspace && typeof raw.parentWorkspace === 'object' ? clone(raw.parentWorkspace) : null,
    workspaces,
  };
}

export function stripSceneWorkspaceState(snapshot) {
  const clean = clone(snapshot);
  if (clean?.drawingModel && typeof clean.drawingModel === 'object') {
    delete clean.drawingModel.sceneWorkspaceState;
  }
  return clean;
}

export function attachSceneWorkspaceState(snapshot, state, activeSection = state?.activeSection || 'main') {
  const result = clone(snapshot);
  result.drawingModel = result.drawingModel && typeof result.drawingModel === 'object'
    ? result.drawingModel : {};
  result.drawingModel.sceneWorkspaceState = {
    ...readSceneWorkspaceState({ sceneWorkspaceState: state }),
    activeSection: SECTION_KEYS.has(activeSection) ? activeSection : 'main',
  };
  return result;
}

function transparentBase64(byteLength) {
  const bytes = new Uint8Array(byteLength);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x6000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x6000)));
  }
  return btoa(binary);
}

export function createSceneWorkspaceSnapshot(baseSnapshot, sectionKey) {
  if (!SECTION_KEYS.has(sectionKey)) throw new TypeError('Unknown PixelForge scene workspace.');
  if (!baseSnapshot || baseSnapshot.format !== 'pixelforge-project' ||
      !Number.isInteger(baseSnapshot.width) || !Number.isInteger(baseSnapshot.height) ||
      baseSnapshot.width < 1 || baseSnapshot.height < 1) {
    throw new TypeError('A valid PixelForge project is required to create a scene workspace.');
  }
  const section = SECTION_DEFINITIONS.find(item => item.key === sectionKey);
  const layerId = crypto.randomUUID();
  const pixels = transparentBase64(baseSnapshot.width * baseSnapshot.height * 4);
  const drawingModel = clone(baseSnapshot.drawingModel) || {};
  delete drawingModel.sceneWorkspaceState;
  drawingModel.layerRoles = {};
  drawingModel.currentState = { version: 1, entries: [], activeEntryId: null };
  drawingModel.environmentHistory = { version: 1, entries: [], activeEntryId: null };
  const frameId = crypto.randomUUID();
  return {
    format: 'pixelforge-project',
    version: 1,
    id: crypto.randomUUID(),
    name: section.label + ' workspace',
    width: baseSnapshot.width,
    height: baseSnapshot.height,
    activeLayerId: layerId,
    revision: 0,
    saveVersion: 0,
    serverRevision: Number.isInteger(baseSnapshot.serverRevision) ? baseSnapshot.serverRevision : 0,
    layers: [{
      id: layerId,
      name: section.label + ' · Layer 1',
      visible: true,
      opacity: 1,
      locked: false,
      pixels,
    }],
    drawingModel,
    vectorModel: null,
    packageResourceFiles: [],
    packageResources: [],
    animation: {
      format: 'pixelforge-animation',
      version: 1,
      width: baseSnapshot.width,
      height: baseSnapshot.height,
      layerIds: [layerId],
      fps: 12,
      activeFrameIndex: 0,
      loop: true,
      playbackSpeed: 1,
      frames: [{
        id: frameId,
        name: 'Frame 1',
        index: 0,
        durationMs: Math.round(1000 / 12),
        cels: [{ layerId, pixels }],
      }],
    },
  };
}
