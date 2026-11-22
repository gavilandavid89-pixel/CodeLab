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
    ['assets', 'frames', 'frames', 'frames', 'frames', 'project-files', 'scenes'].sort());
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
