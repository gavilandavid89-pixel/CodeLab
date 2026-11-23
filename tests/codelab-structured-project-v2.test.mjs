import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { installCodeLabPackage } from '../codelab-project-package-installer.mjs';

function rgba(width, height, seed) {
  const bytes = Buffer.alloc(width * height * 4);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i + seed) & 0xff;
  return bytes;
}

function baseProject() {
  return {
    format: 'pixelforge-project',
    id: 'structured-v2-test',
    name: 'Structured v2 test',
    width: 2,
    height: 2,
    layers: [
      { id: 'layer.001', name: 'Base', opacity: 1, visible: true, locked: false },
      { id: 'layer.002', name: 'Detail', opacity: 0.8, visible: true, locked: false },
    ],
    drawingModel: { version: 2, palette: {}, objects: [] },
  };
}

function makePackage() {
  const frame1Base = rgba(2, 2, 1);
  const frame1Detail = rgba(2, 2, 2);
  const frame2Base = rgba(2, 2, 3);
  const frame2Detail = rgba(2, 2, 4);
  const referencePixels = rgba(1, 1, 9);
  const files = new Map([
    ['frames/frames.tscn', Buffer.from(JSON.stringify({
      format: 'codelab-frames',
      version: 1,
      canvas: { width: 2, height: 2 },
      fps: 12,
      activeFrameIndex: 0,
      frames: [
        { id: 'frame.001', path: 'frames/frame.001/frame.json' },
        { id: 'frame.002', path: 'frames/frame.002/frame.json' },
      ],
    }))],
    ['frames/frame.001/frame.json', Buffer.from(JSON.stringify({
      id: 'frame.001', index: 0, name: 'Idle', durationMs: 100, width: 2, height: 2, layerCount: 2,
      layers: [
        { id: 'layer.001', name: 'Base', position: { x: 1, y: 2 }, opacity: 1, visible: true, pixelsPath: 'frames/frame.001/layer.001/pixels.bin' },
        { id: 'layer.002', name: 'Detail', position: { x: 3, y: 4 }, opacity: 0.8, visible: true, zIndex: 2, pixelsPath: 'frames/frame.001/layer.002/pixels.bin' },
      ],
    }))],
    ['frames/frame.001/layer.001/pixels.bin', frame1Base],
    ['frames/frame.001/layer.002/pixels.bin', frame1Detail],
    ['frames/frame.002/frame.json', Buffer.from(JSON.stringify({
      id: 'frame.002', index: 1, name: 'Step', durationMs: 100, width: 2, height: 2, layerCount: 2,
      layers: [
        { id: 'layer.001', name: 'Base', position: { x: 2, y: 2 }, opacity: 1, visible: true, pixelsPath: 'frames/frame.002/layer.001/pixels.bin' },
        { id: 'layer.002', name: 'Detail', position: { x: 4, y: 4 }, opacity: 0.8, visible: true, zIndex: 2, pixelsPath: 'frames/frame.002/layer.002/pixels.bin' },
      ],
    }))],
    ['frames/frame.002/layer.001/pixels.bin', frame2Base],
    ['frames/frame.002/layer.002/pixels.bin', frame2Detail],
    ['center.op/center.json', Buffer.from(JSON.stringify({
      format: 'codelab-reference-center',
      version: 1,
      categories: [{
        id: 'personaje',
        folder: 'reference.personaje',
        references: [{ id: 'ref_personaje_1', path: 'reference.personaje/reference.personaje1/reference.json' }],
      }],
    }))],
    ['reference.personaje/reference.personaje1/reference.json', Buffer.from(JSON.stringify({
      id: 'ref_personaje_1', name: 'Hero', type: 'character', version: 1, width: 1, height: 1, sourceRevision: 7,
      transform: { x: 10, y: 20, rotation: 0, scaleX: 1, scaleY: 1 },
      parts: [{
        id: 'part.body', name: 'Body', role: 'character-body', width: 1, height: 1,
        bounds: { x: 0, y: 0, width: 1, height: 1 }, pixelsPath: 'reference.personaje/reference.personaje1/image.bin',
      }],
    }))],
    ['reference.personaje/reference.personaje1/image.bin', referencePixels],
  ]);
  const integrityFiles = Object.fromEntries([...files.entries()].map(([path, bytes]) => [path, {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteSize: bytes.length,
  }]));
  files.set('integrity.json', Buffer.from(JSON.stringify({ format: 'codelab-integrity', version: 1, files: integrityFiles })));
  return {
    manifest: {
      format: 'codelab',
      version: 2,
      schemaVersion: 2,
      layout: 'structured',
      editor: 'pixelforge',
      projectType: 'pixelforge',
      entry: 'project.json',
      frames: { manifestPath: 'frames/frames.tscn' },
      referenceCenter: { manifestPath: 'center.op/center.json' },
      integrityPath: 'integrity.json',
    },
    project: baseProject(),
    files,
  };
}

test('installs structured CodeLab v2 frames with explicit per-layer RGBA data', () => {
  const pkg = makePackage();
  const result = installCodeLabPackage(pkg);
  assert.equal(result.installed.animationFrames, 2);
  assert.equal(result.installed.animationCels, 4);
  assert.equal(result.project.animation.version, 2);
  assert.equal(result.project.animation.frames[0].cels[0].pixels.length > 0, true);
  assert.equal(result.project.animation.frames[0].cels[0].metadata.position.x, 1);
  assert.equal(result.project.animation.frames[1].cels[1].metadata.pixelsSha256.length, 64);
});

test('installs Reference Center categories and deep-copyable editable parts', () => {
  const pkg = makePackage();
  const result = installCodeLabPackage(pkg);
  assert.equal(result.installed.referenceCenterEntries, 1);
  const entry = result.project.drawingModel.referenceCenter.entries[0];
  assert.equal(entry.category, 'personaje');
  assert.equal(entry.categoryFolder, 'reference.personaje');
  assert.equal(entry.editable, true);
  assert.equal(entry.materialization.copyPolicy, 'deep-copy');
  assert.equal(entry.parts[0].editable, true);
  assert.equal(entry.parts[0].pixels.length, 8);
  assert.equal(entry.parts[0].pixelsSha256.length, 64);
});

test('rejects a frame that declares the wrong layer count instead of inventing missing layers', () => {
  const pkg = makePackage();
  const frame = JSON.parse(pkg.files.get('frames/frame.001/frame.json').toString('utf8'));
  frame.layerCount = 1;
  pkg.files.set('frames/frame.001/frame.json', Buffer.from(JSON.stringify(frame)));
  const integrity = JSON.parse(pkg.files.get('integrity.json').toString('utf8'));
  integrity.files['frames/frame.001/frame.json'] = {
    sha256: createHash('sha256').update(pkg.files.get('frames/frame.001/frame.json')).digest('hex'),
    byteSize: pkg.files.get('frames/frame.001/frame.json').length,
  };
  pkg.files.set('integrity.json', Buffer.from(JSON.stringify(integrity)));
  assert.throws(() => installCodeLabPackage(pkg), /must declare exactly 2 layers/);
});

function makeGenericPackage(editor) {
  const asset = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>');
  const files = new Map([['assets/mark.svg', asset]]);
  const integrityFiles = Object.fromEntries([...files.entries()].map(([path, bytes]) => [path, {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteSize: bytes.length,
  }]));
  files.set('integrity.json', Buffer.from(JSON.stringify({ format: 'codelab-integrity', version: 1, files: integrityFiles })));
  return {
    manifest: {
      format: 'codelab', version: 2, schemaVersion: 2, layout: 'structured',
      editor, projectType: editor, entry: 'project.json', integrityPath: 'integrity.json',
      resources: [{ path: 'assets/mark.svg', destination: 'assets' }],
    },
    project: {
      id: 'generic-' + editor,
      name: 'Generic ' + editor + ' project',
      code: { html: '<main>Loaded</main>', css: 'main { display:block }', js: 'console.log("loaded")' },
      ...(editor === 'design' ? { design: {
        elements: [{ id: 'hero', type: 'heading', text: 'Loaded', x: 10, y: 20, width: 200, height: 40 }],
        frame: 'desktop', background: '#ffffff', grid: true, gridSize: 8, snapToGrid: false,
      } } : {}),
    },
    files,
  };
}

test('installs structured CodeLab v2 Web projects without PixelForge-only manifests', () => {
  const result = installCodeLabPackage(makeGenericPackage('web'));
  assert.equal(result.project.type, 'web');
  assert.deepEqual(result.project.code, {
    html: '<main>Loaded</main>', css: 'main { display:block }', js: 'console.log("loaded")',
  });
  assert.equal(result.project.hasWebSpace, true);
  assert.equal(result.project.hasDesignSpace, true);
  assert.equal(result.project.packageResources.some(item => item.path === 'assets/mark.svg'), true);
  assert.equal(result.project.codelabSchema.framesManifest, null);
  assert.equal(result.installed.animationFrames, 0);
});

test('installs structured CodeLab v2 Design projects as native editable design documents', () => {
  const result = installCodeLabPackage(makeGenericPackage('design'));
  assert.equal(result.project.type, 'design');
  assert.equal(result.project.design.elements.length, 1);
  assert.equal(result.project.design.elements[0].id, 'hero');
  assert.equal(result.project.code.html, '<main>Loaded</main>');
  assert.equal(result.project.hasDesignSpace, true);
});

test('rejects a structured Design package with no design element list', () => {
  const pkg = makeGenericPackage('design');
  delete pkg.project.design;
  assert.throws(() => installCodeLabPackage(pkg), /design.elements as an array/);
});

