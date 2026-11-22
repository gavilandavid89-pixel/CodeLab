import test from 'node:test';
import assert from 'node:assert/strict';
import { installCodeLabPackage } from '../codelab-project-package-installer.mjs';

function fixture() {
  const project = {
    format: 'pixelforge-project', version: 1, id: 'project-1', name: 'Test',
    width: 2, height: 1, layers: [
      { id: 'layer-base', name: 'Base', pixels: 'AAAAAAAAAAA=' },
      { id: 'layer-detail', name: 'Detail', pixels: 'AAAAAAAAAAA=' },
    ],
  };
  const rgbaA = Buffer.from([255, 0, 0, 255, 0, 0, 0, 0]);
  const rgbaB = Buffer.from([0, 255, 0, 255, 0, 0, 0, 0]);
  const rgbaC = Buffer.from([0, 0, 255, 255, 0, 0, 0, 0]);
  const rgbaD = Buffer.from([255, 255, 0, 255, 0, 0, 0, 0]);
  const files = new Map([
    ['frames/0001/base.rgba', rgbaA], ['frames/0001/detail.rgba', rgbaB],
    ['frames/0002/base.rgba', rgbaC], ['frames/0002/detail.rgba', rgbaD],
    ['assets/reference.txt', Buffer.from('reference')],
    ['scenes/intro.json', Buffer.from('{}')],
    ['custom-data/readme.txt', Buffer.from('extra')],
    ['reference/moodboard/character.png', Buffer.from('image')],
    ['audio/theme.ogg', Buffer.from('audio')],
    ['ui/button.css', Buffer.from('css')],
    ['unknown.blob', Buffer.from('opaque')],
  ]);
  const manifest = {
    format: 'codelab', version: 1, editor: 'pixelforge', projectType: 'pixelforge', entry: 'project.json',
    animation: {
      fps: 12, activeFrameIndex: 1, loop: true,
      frames: [
        { id: 'frame-1', durationMs: 80, cels: [
          { layerId: 'layer-base', path: 'frames/0001/base.rgba', encoding: 'rgba8' },
          { layerId: 'layer-detail', path: 'frames/0001/detail.rgba', encoding: 'rgba8' },
        ] },
        { id: 'frame-2', durationMs: 100, cels: [
          { layerId: 'layer-base', path: 'frames/0002/base.rgba', encoding: 'rgba8' },
          { layerId: 'layer-detail', path: 'frames/0002/detail.rgba', encoding: 'rgba8' },
        ] },
      ],
    },
  };
  return { project, manifest, files };
}

test('installs declared frame cels into native PixelForge animation and routes package files', () => {
  const { project, manifest, files } = fixture();
  const result = installCodeLabPackage({ manifest, project, files });
  assert.deepEqual(result.installed, { animationFrames: 2, animationCels: 4 });
  assert.equal(project.animation.format, 'pixelforge-animation');
  assert.equal(project.animation.fps, 12);
  assert.equal(project.animation.activeFrameIndex, 1);
  assert.deepEqual(project.animation.layerIds, ['layer-base', 'layer-detail']);
  assert.equal(Buffer.from(project.animation.frames[0].cels[0].pixels, 'base64').toString('hex'),
    'ff0000ff00000000');
  assert.equal(Buffer.from(project.animation.frames[1].cels[1].pixels, 'base64').toString('hex'),
    'ffff00ff00000000');
  assert.deepEqual(result.destinations.map(item => item.destination).sort(),
    ['assets', 'frames', 'frames', 'frames', 'frames', 'documents', 'reference-center', 'audio', 'styles', 'project-files', 'scenes'].sort());
});

test('does not guess that arbitrary images are frames without manifest animation mapping', () => {
  const { project, manifest, files } = fixture();
  delete manifest.animation;
  const result = installCodeLabPackage({ manifest, project, files });
  assert.equal(project.animation, undefined);
  assert.equal(result.installed.animationFrames, 0);
});

test('rejects incomplete frame-to-layer mappings and missing resource paths', () => {
  const { project, manifest, files } = fixture();
  manifest.animation.frames[0].cels.pop();
  assert.throws(() => installCodeLabPackage({ manifest, project, files }), /exactly one cel for every project layer/);
  const next = fixture();
  next.manifest.animation.frames[0].cels[0].path = 'frames/missing.rgba';
  assert.throws(() => installCodeLabPackage({ manifest: next.manifest, project: next.project, files: next.files }), /references missing file/);
});

test('rejects unsafe paths, wrong RGBA sizes and invalid frame dimensions', () => {
  const first = fixture();
  first.manifest.animation.frames[0].cels[0].path = '../outside.rgba';
  assert.throws(() => installCodeLabPackage(first), /invalid or duplicate layer cel reference/);
  const second = fixture();
  second.files.set('frames/0001/base.rgba', Buffer.from([1, 2, 3]));
  assert.throws(() => installCodeLabPackage(second), /RGBA8 cel byte length/);
});

import { deflateSync } from 'node:zlib';

function makeRgbaPng(width, height, rgba) {
  const chunk = (type, data) => {
    const name = Buffer.from(type);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); name.copy(out, 4); data.copy(out, 8);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) Buffer.from([0]).copy(rows, y * (width * 4 + 1));
  for (let y = 0; y < height; y++) Buffer.from(rgba).copy(rows, y * (width * 4 + 1) + 1);
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('decodes PNG cels to the exact RGBA bytes expected by the PixelForge timeline', () => {
  const { project, manifest, files } = fixture();
  const expected = Buffer.from([12, 34, 56, 255, 78, 90, 123, 128]);
  files.set('frames/0001/base.rgba', makeRgbaPng(2, 1, expected));
  manifest.animation.frames[0].cels[0].encoding = 'png';
  const result = installCodeLabPackage({ manifest, project, files });
  assert.equal(result.installed.animationCels, 4);
  assert.deepEqual(Buffer.from(project.animation.frames[0].cels[0].pixels, 'base64'), expected);
});

test('routes extra folders by semantic folder names and file types into usable destinations', () => {
  const project = { format: 'pixelforge-project', width: 1, height: 1, layers: [{ id: 'layer-1' }] };
  const files = new Map([
    ['reference/character/pose.png', Buffer.from('x')],
    ['guides/visual-brief.pdf', Buffer.from('x')],
    ['sounds/hit.wav', Buffer.from('x')],
    ['typography/display.woff2', Buffer.from('x')],
    ['models/prop.glb', Buffer.from('x')],
    ['styles/theme.css', Buffer.from('x')],
    ['components/button.json', Buffer.from('x')],
    ['unknown.custom', Buffer.from('x')],
  ]);
  const result = installCodeLabPackage({ manifest: { editor: 'web' }, project, files });
  const byPath = Object.fromEntries(result.destinations.map(item => [item.path, item]));
  assert.equal(byPath['reference/character/pose.png'].destination, 'reference-center');
  assert.equal(byPath['reference/character/pose.png'].destinationPath, 'reference-center/character/pose.png');
  assert.equal(byPath['guides/visual-brief.pdf'].destination, 'documents');
  assert.equal(byPath['sounds/hit.wav'].destination, 'audio');
  assert.equal(byPath['typography/display.woff2'].destination, 'fonts');
  assert.equal(byPath['models/prop.glb'].destination, 'models');
  assert.equal(byPath['styles/theme.css'].destination, 'styles');
  assert.equal(byPath['components/button.json'].destination, 'components');
  assert.equal(byPath['unknown.custom'].destination, 'project-files');
});

test('manifest resource declarations override inferred folder and extension destinations', () => {
  const project = { format: 'pixelforge-project', width: 1, height: 1, layers: [{ id: 'layer-1' }] };
  const files = new Map([['misc/pose.png', Buffer.from('x')]]);
  const result = installCodeLabPackage({
    manifest: { editor: 'web', resources: [{ path: 'misc/pose.png', destination: 'reference-center' }] },
    project, files,
  });
  assert.equal(result.destinations[0].destination, 'reference-center');
  assert.equal(result.destinations[0].destinationPath, 'reference-center/misc/pose.png');
});

test('uses file signatures as a fallback when an extension gives no clue', () => {
  const project = { format: 'pixelforge-project', width: 1, height: 1, layers: [{ id: 'layer-1' }] };
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
  const files = new Map([['misc/unknown.bin', pngSignature], ['misc/opaque.bin', Buffer.from([1, 2, 3, 4])]]);
  const result = installCodeLabPackage({ manifest: { editor: 'web' }, project, files });
  const byPath = Object.fromEntries(result.destinations.map(item => [item.path, item]));
  assert.equal(byPath['misc/unknown.bin'].destination, 'assets');
  assert.equal(byPath['misc/opaque.bin'].destination, 'project-files');
});

test('installs real image resources into the native PixelForge Reference Center', () => {
  const project = { format: 'pixelforge-project', id: 'ref-project', name: 'References', width: 1, height: 1, layers: [{ id: 'layer-1', name: 'Layer 1', pixels: 'AAAAAA==' }] };
  const image = makeRgbaPng(1, 1, Buffer.from([40, 80, 120, 255]));
  const files = new Map([['reference/characters/hero.png', image], ['guides/brief.pdf', Buffer.from('%PDF-1.4 test')]]);
  const result = installCodeLabPackage({ manifest: { editor: 'pixelforge' }, project, files });
  const reference = project.drawingModel.referenceCenter.entries[0];
  assert.equal(result.resources.referenceImages, 1);
  assert.equal(reference.sourcePath, 'reference-center/characters/hero.png');
  assert.equal(reference.category, 'reference');
  assert.equal(reference.imageDataUrl.startsWith('data:image/png;base64,'), true);
  assert.equal(project.drawingModel.packageResources.length, 2);
  assert.equal(project.drawingModel.packageResources.find(item => item.destination === 'documents').contentType, 'application/pdf');
});
