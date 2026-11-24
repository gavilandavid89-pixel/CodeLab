import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sceneWorkspaceSections,
  readSceneWorkspaceState,
  stripSceneWorkspaceState,
  attachSceneWorkspaceState,
  createSceneWorkspaceSnapshot,
} from '../public/pixelforge/src/scene-workspaces.js';

function makeProject() {
  return {
    format: 'pixelforge-project',
    version: 1,
    id: 'parent-project',
    name: 'Parent project',
    width: 4,
    height: 3,
    activeLayerId: 'parent-layer',
    revision: 2,
    saveVersion: 2,
    serverRevision: 7,
    layers: [{
      id: 'parent-layer',
      name: 'Parent layer',
      visible: true,
      opacity: 1,
      locked: false,
      pixels: Buffer.alloc(4 * 3 * 4, 255).toString('base64'),
    }],
    drawingModel: { layerRoles: { 'parent-layer': { role: 'environment' } } },
    animation: null,
  };
}

test('PixelForge exposes exactly five named independent scene workspaces', () => {
  assert.deepEqual(sceneWorkspaceSections().map(section => section.key), [
    'environment', 'effects', 'details', 'elements', 'objects',
  ]);
});

test('new scene workspaces start with independent blank layers and their own one-frame timeline', () => {
  const base = makeProject();
  const environment = createSceneWorkspaceSnapshot(base, 'environment');
  const effects = createSceneWorkspaceSnapshot(base, 'effects');

  assert.equal(environment.format, 'pixelforge-project');
  assert.equal(environment.width, base.width);
  assert.equal(environment.height, base.height);
  assert.notEqual(environment.id, base.id);
  assert.notEqual(environment.layers[0].id, base.layers[0].id);
  assert.notEqual(environment.layers[0].id, effects.layers[0].id);
  assert.equal(environment.layers.length, 1);
  assert.equal(environment.layers[0].name, 'Environment · Layer 1');
  assert.deepEqual([...Buffer.from(environment.layers[0].pixels, 'base64')], Array(4 * 3 * 4).fill(0));
  assert.equal(environment.animation.frames.length, 1);
  assert.deepEqual(environment.animation.layerIds, [environment.layers[0].id]);
  assert.deepEqual(environment.animation.frames[0].cels.map(cel => cel.layerId), [environment.layers[0].id]);
  assert.equal(environment.animation.width, environment.width);
  assert.equal(environment.animation.height, environment.height);
  assert.deepEqual(environment.drawingModel.layerRoles, {});
});

test('workspace registry round-trips without recursively embedding its own registry', () => {
  const parent = makeProject();
  const environment = createSceneWorkspaceSnapshot(parent, 'environment');
  const state = {
    version: 1,
    activeSection: 'environment',
    parentWorkspace: stripSceneWorkspaceState(parent),
    workspaces: { environment: stripSceneWorkspaceState(environment) },
  };
  const persisted = attachSceneWorkspaceState(parent, state, 'environment');
  const restoredState = readSceneWorkspaceState(persisted.drawingModel);

  assert.equal(restoredState.activeSection, 'environment');
  assert.equal(restoredState.parentWorkspace.name, 'Parent project');
  assert.equal(restoredState.workspaces.environment.name, 'Environment workspace');
  assert.equal(restoredState.workspaces.environment.drawingModel.sceneWorkspaceState, undefined);
  const clean = stripSceneWorkspaceState(persisted);
  assert.equal(clean.drawingModel.sceneWorkspaceState, undefined);
  assert.equal(persisted.drawingModel.sceneWorkspaceState.activeSection, 'environment');
});

test('unknown section names are rejected and invalid active section falls back to main', () => {
  assert.throws(() => createSceneWorkspaceSnapshot(makeProject(), 'characters'), /Unknown PixelForge scene workspace/);
  const state = readSceneWorkspaceState({ sceneWorkspaceState: { activeSection: 'unknown', workspaces: { unknown: {} } } });
  assert.equal(state.activeSection, 'main');
  assert.deepEqual(state.workspaces, {});
});
