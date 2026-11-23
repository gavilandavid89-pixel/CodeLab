import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrbitalShowcase } from '../public/pixelforge/src/showcase-animation.mjs';
import { HeadlessEditorRuntime } from '../public/pixelforge/src/headless.js';
import { readStoredZip } from '../public/pixelforge/src/video-composer-core.mjs';
import { installCodeLabPackage } from '../codelab-project-package-installer.mjs';
import { createPixelForgeCodeLabPackageZip } from '../pixelforge-codelab-package.mjs';

async function importPackage(bytes) {
  const entries = await readStoredZip(new Blob([bytes]));
  const files = new Map();
  for (const [path, entry] of entries) {
    if (['project.codelab-pixelforge', 'manifest.json', 'project.json'].includes(path)) continue;
    files.set(path, Buffer.from(await entry.blob.arrayBuffer()));
  }
  const manifest = JSON.parse(await entries.get('manifest.json').blob.text());
  const project = JSON.parse(await entries.get('project.json').blob.text());
  return { entries, manifest, ...installCodeLabPackage({ manifest, project, files }) };
}

function addCharacterReference(project) {
  const layer = project.layers[0];
  project.drawingModel ||= {};
  project.drawingModel.layerRoles = Object.fromEntries(project.layers.map((layer, index) => [layer.id, { role: ['environment', 'effect', 'detail', 'element', 'object'][index % 5] }]));
  project.drawingModel.sceneSections = {
    environment: { label: 'Main world', resourceFolders: ['Entorno/assets'] },
    effects: { blendMode: 'normal' },
    details: { precision: 'pixel' },
    elements: { ordering: 'z-index' },
    objects: { origin: 'native-object-list' },
  };
  project.drawingModel.referenceCenter = {
    version: 3,
    entries: [{
      id: 'hero-master',
      name: 'Hero',
      type: 'asset',
      category: 'character',
      immutableSnapshot: true,
      sourceProjectId: project.id,
      sourceRevision: project.revision || 0,
      geometry: { canvas: { width: project.width, height: project.height }, objectCount: 1 },
      parts: [{
        id: 'hero-body',
        name: 'Body',
        role: 'component',
        layerId: layer.id,
        pixels: layer.pixels,
        bounds: { x: 0, y: 0, width: project.width, height: project.height },
        anchors: { center: { x: project.width / 2, y: project.height / 2 } },
        proportions: { height: 1 },
        colorRoles: ['primary'],
        z: 0,
      }],
      frames: [],
      palette: {},
      notes: 'Round-trip fixture',
    }],
    activeEntryId: 'hero-master',
    viewContext: {},
  };
  return project;
}

test('exports a CodeLab v2 PixelForge package with declared frames, editable references and integrity', async () => {
  const showcase = createOrbitalShowcase();
  const project = addCharacterReference(showcase.doc.toJSON());
  project.id = 'structured_pixelforge_source';
  project.animation = { ...showcase.animation.toJSON(), loop: showcase.loop };
  const exported = createPixelForgeCodeLabPackageZip(project, {
    resources: [{ path: 'Entorno/assets/palette.txt', contentType: 'text/plain', bytes: Buffer.from('palette=warm') }],
  });
  assert.equal(exported.filename.endsWith('.codelab-pixelforge'), true);
  assert.equal(exported.metadata.format, 'codelab');
  assert.equal(exported.metadata.version, 2);

  const imported = await importPackage(exported.bytes);
  assert.equal(imported.manifest.layout, 'structured');
  assert.equal(imported.manifest.editor, 'pixelforge');
  assert.equal(imported.entries.has('project.codelab-pixelforge'), true);
  assert.equal(imported.entries.has('Frames/frames.tscn'), true);
  assert.equal(imported.entries.has('Entorno/entorno.tscn'), true);
  assert.equal(imported.entries.has('Efectos/efectos.tscn'), true);
  assert.equal(imported.entries.has('Detalles/detalles.tscn'), true);
  assert.equal(imported.entries.has('Elementos/elementos.tscn'), true);
  assert.equal(imported.entries.has('Objetos/objetos.tscn'), true);
  assert.equal(imported.manifest.frames.manifestPath, 'Frames/frames.tscn');
  assert.equal(Object.keys(imported.manifest.scenes.sections).length, 5);
  assert.equal(imported.installed.scenes.environment.manifestPath, 'Entorno/entorno.tscn');
  assert.equal(imported.entries.has('center.op/center.json'), true);
  assert.equal(imported.entries.has('reference.personaje/hero-hero-master/reference.json'), true);
  assert.equal(imported.project.animation.frames.length, project.animation.frames.length);
  assert.equal(imported.project.animation.frames[0].cels.length, project.layers.length);
  assert.equal(imported.project.drawingModel.referenceCenter.entries.length, 1);
  assert.equal(imported.project.drawingModel.referenceCenter.entries[0].parts[0].name, 'Body');
  assert.equal(imported.project.packageResources.some(item => item.path === 'Entorno/assets/palette.txt' && item.destination === 'environment'), true);
  assert.equal(imported.installed.referenceCenterEntries, 1);
});

test('survives import, a real Headless edit, save, export and second import', async () => {
  const showcase = createOrbitalShowcase();
  const project = addCharacterReference(showcase.doc.toJSON());
  project.animation = { ...showcase.animation.toJSON(), loop: showcase.loop };
  const firstExport = createPixelForgeCodeLabPackageZip(project);
  const firstImport = await importPackage(firstExport.bytes);

  const runtime = HeadlessEditorRuntime.fromJSON(firstImport.project);
  const originalLayerPixels = firstImport.project.layers.map(layer => layer.pixels);
  const edited = runtime.execute({
    name: 'canvas.draw_line',
    x0: 1, y0: 1, x1: 5, y1: 5,
    color: '#FF00FF',
    size: 1,
  });
  assert.equal(edited.ok, true);
  const proposal = runtime.createProposal('Round-trip edit validation');
  assert.ok(proposal);
  assert.equal(runtime.acceptProposal().status, 'applied');
  const savedProject = runtime.toJSON();
  assert.equal(savedProject.layers.some((layer, index) => layer.pixels !== originalLayerPixels[index]), true);
  const secondExport = createPixelForgeCodeLabPackageZip(savedProject);
  const secondImport = await importPackage(secondExport.bytes);

  assert.equal(secondImport.project.layers.length, savedProject.layers.length);
  assert.equal(secondImport.project.animation.frames.length, savedProject.animation.frames.length);
  assert.equal(secondImport.project.drawingModel.referenceCenter.entries.length, 1);
  assert.equal(secondImport.project.drawingModel.referenceCenter.entries[0].parts[0].pixels.length > 0, true);
  for (const layer of secondImport.project.layers) {
    assert.equal(layer.pixels, savedProject.layers.find(item => item.id === layer.id)?.pixels);
  }
});
