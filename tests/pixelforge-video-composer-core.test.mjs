import test from 'node:test';
import assert from 'node:assert/strict';
import { createZipBlob } from '../public/pixelforge/src/zip-export.js';
import { readStoredZip, parsePixelForgeVideoPackage } from '../public/pixelforge/src/video-composer-core.mjs';

function pngFixture() {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  return new Blob([bytes], { type: 'image/png' });
}

test('reads a PixelForge ZIP package without inflating the complete archive into memory', async () => {
  const manifest = {
    format: 'pixelforge-video-package', version: 1, width: 96, height: 96,
    fps: 12, loop: true, frameCount: 1, projectFile: 'project/orbital.pforge',
    frames: [{ index: 0, file: 'frames/frame-0001.png', durationMs: 83.333, startMs: 0 }],
  };
  const zip = await createZipBlob([
    { name: 'manifest.json', data: JSON.stringify(manifest) },
    { name: 'frames/frame-0001.png', data: pngFixture() },
    { name: 'project/orbital.pforge', data: '{"format":"pixelforge-project"}' },
  ]);
  const entries = await readStoredZip(zip);
  assert.equal(entries.size, 3);
  const parsed = await parsePixelForgeVideoPackage(zip);
  assert.equal(parsed.manifest.frameCount, 1);
  assert.equal(parsed.manifest.totalDurationMs, 83.333);
  assert.equal(parsed.frames[0].blob.size, 24);
  assert.ok(parsed.project instanceof Blob);
});

test('rejects invalid, compressed, incomplete and over-limit video packages', async () => {
  const badManifestZip = await createZipBlob([
    { name: 'manifest.json', data: '{"format":"wrong"}' },
    { name: 'frames/frame-0001.png', data: pngFixture() },
  ]);
  await assert.rejects(() => parsePixelForgeVideoPackage(badManifestZip), /manifest has invalid/);
  await assert.rejects(() => readStoredZip(new Blob(['not a zip'])), /valid PixelForge ZIP/);
  const good = await createZipBlob([{ name: 'a.txt', data: 'a' }]);
  await assert.rejects(() => readStoredZip(good, { maxEntries: 0 }), /too many entries/);
});
