import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrbitalShowcase } from '../public/pixelforge/src/showcase-animation.mjs';
import { RasterDocument } from '../public/pixelforge/src/core.js';
import { exportPixelForgeCodeLabPackage, importPixelForgeCodeLabPackage } from '../public/pixelforge/src/codelab-package.js';

function fixture() {
  const showcase = createOrbitalShowcase();
  const project = showcase.doc.toJSON();
  project.id = 'browser-package-fixture';
  project.animation = { ...showcase.animation.toJSON(), loop: showcase.loop };
  project.drawingModel ||= {};
  project.drawingModel.layerRoles = Object.fromEntries(project.layers.map((layer, index) => [
    layer.id, { role: ['environment', 'effect', 'detail', 'element', 'object'][index % 5] },
  ]));
  project.drawingModel.sceneSections = {
    environment: { label: 'Night forest', ambient: { color: '#182030' } },
    effects: { entries: [{ id: 'spark-01', type: 'spark' }] },
    details: { precision: 'pixel-grid' },
    elements: { ordering: 'z-index' },
    objects: { collision: 'none' },
  };
  for (const [index, section] of ['environment', 'effects', 'details', 'elements', 'objects'].entries()) {
    const sceneDocument = new RasterDocument(4, 4, section + ' workspace');
    sceneDocument.layers[0].pixels.set([255, index * 20, 0, 255], 0);
    const workspace = sceneDocument.toJSON();
    workspace.id = project.id + '-' + section;
    workspace.name = section + ' workspace';
    const layer = workspace.layers[0];
    const secondPixels = Uint8Array.from(atob(layer.pixels), char => char.charCodeAt(0));
    secondPixels[1] = (secondPixels[1] + 1) & 0xff;
    workspace.animation = {
      format: 'pixelforge-animation', version: 1,
      width: 4, height: 4, layerIds: [layer.id], fps: 12,
      activeFrameIndex: 1, loop: true, playbackSpeed: 1,
      frames: [
        { id: section + '-frame-1', name: 'Idle', index: 0, durationMs: 100,
          cels: [{ layerId: layer.id, pixels: layer.pixels }] },
        { id: section + '-frame-2', name: 'Move', index: 1, durationMs: 120,
          cels: [{ layerId: layer.id, pixels: btoa(String.fromCharCode(...secondPixels)) }] },
      ],
    };
    project.drawingModel.sceneSections[section].workspace = workspace;
  }
  const resource = new TextEncoder().encode('embedded palette bytes');
  project.packageResourceFiles = [{
    path: 'Entorno/assets/palette.txt',
    contentType: 'text/plain',
    base64: btoa(String.fromCharCode(...resource)),
  }];
  return project;
}

test('browser package exporter writes all six project folders and the named TSCN manifests', async () => {
  const exported = await exportPixelForgeCodeLabPackage(fixture());
  assert.match(exported.filename, /\.codelab-pixelforge$/);
  const installed = await importPixelForgeCodeLabPackage(exported.blob);
  assert.equal(installed.manifest.frames.manifestPath, 'Frames/frames.tscn');
  assert.equal(installed.manifest.scenes.sections.environment.manifestPath, 'Entorno/entorno.tscn');
  assert.equal(installed.metadata.sceneSectionCount, 5);
  assert.equal(installed.project.drawingModel.sceneSections.environment.label, 'Night forest');
  assert.equal(installed.project.drawingModel.sceneSections.effects.entries[0].id, 'spark-01');
  for (const section of ['environment', 'effects', 'details', 'elements', 'objects']) {
    const workspace = installed.project.drawingModel.sceneSections[section].workspace;
    assert.equal(workspace.format, 'pixelforge-project');
    assert.equal(workspace.layers.length, project.layers.length);
    assert.equal(workspace.animation.frames.length, project.animation.frames.length);
    assert.equal(workspace.animation.frames[0].cels.length, workspace.layers.length);
  }
  assert.equal(installed.project.packageResourceFiles[0].path, 'Entorno/assets/palette.txt');
  assert.equal(installed.project.packageResources[0].byteSize, new TextEncoder().encode('embedded palette bytes').length);
  assert.equal(installed.manifest.resources[0].destination, 'environment');
  assert.equal(installed.project.animation.frames.length, fixture().animation.frames.length);
  assert.equal(installed.project.animation.frames[0].layerMetadata[0].parentFrameId, installed.project.animation.frames[0].id);
});

test('browser import preserves package resources and scene metadata through native save and a second export', async () => {
  const first = await exportPixelForgeCodeLabPackage(fixture());
  const imported = await importPixelForgeCodeLabPackage(first.blob);
  const document = RasterDocument.fromJSON(imported.project, { newIdentity: false });
  document.id = 'browser-roundtrip-second-project';
  const saved = document.toJSON();
  saved.animation = imported.project.animation;
  const second = await exportPixelForgeCodeLabPackage(saved);
  const restored = await importPixelForgeCodeLabPackage(second.blob);
  assert.equal(restored.project.packageResourceFiles[0].path, 'Entorno/assets/palette.txt');
  assert.equal(restored.project.packageResourceFiles[0].base64, imported.project.packageResourceFiles[0].base64);
  assert.equal(restored.project.drawingModel.sceneSections.environment.label, 'Night forest');
  for (const section of ['environment', 'effects', 'details', 'elements', 'objects']) {
    const workspace = restored.project.drawingModel.sceneSections[section].workspace;
    assert.equal(workspace.animation.frames.length, imported.project.animation.frames.length);
    assert.equal(workspace.animation.frames[0].cels.length, workspace.layers.length);
  }
  assert.equal(restored.project.animation.frames.length, imported.project.animation.frames.length);
  for (const layer of restored.project.layers) {
    assert.equal(layer.pixels, saved.layers.find(item => item.id === layer.id)?.pixels);
  }
});

test('browser importer rejects tampered resources and invalid scene manifests', async () => {
  const exported = await exportPixelForgeCodeLabPackage(fixture());
  const { readStoredZip } = await import('../public/pixelforge/src/video-composer-core.mjs');
  const { createZipBlob } = await import('../public/pixelforge/src/zip-export.js');
  const entries = await readStoredZip(exported.blob);
  const tampered = [];
  for (const [path, entry] of entries) {
    const bytes = new Uint8Array(await entry.blob.arrayBuffer());
    if (path === 'Entorno/assets/palette.txt') bytes[0] ^= 1;
    tampered.push({ name: path, data: bytes });
  }
  const archive = await createZipBlob(tampered);
  await assert.rejects(() => importPixelForgeCodeLabPackage(archive), /Integrity verification failed/);
});
