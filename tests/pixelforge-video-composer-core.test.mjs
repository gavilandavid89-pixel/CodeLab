import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createZipBlob } from '../public/pixelforge/src/zip-export.js';
import { readStoredZip, parsePixelForgeVideoPackage } from '../public/pixelforge/src/video-composer-core.mjs';

function pngFixture({ corrupt = false } = {}) {
  const bytes = Uint8Array.from(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=',
    'base64'
  ));
  if (corrupt) bytes[45] ^= 0xff;
  return new Blob([bytes], { type: 'image/png' });
}

test('reads a PixelForge ZIP package without inflating the complete archive into memory', async () => {
  const manifest = {
    format: 'pixelforge-video-package', version: 1, width: 1, height: 1,
    fps: 12, loop: true, frameCount: 1, projectFile: 'project/orbital.pforge',
    sourceDrawingMode: 'pixel-art', scalingMode: 'pixelated',
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
  assert.equal(parsed.manifest.sourceDrawingMode, 'pixel-art');
  assert.equal(parsed.manifest.scalingMode, 'pixelated');
  assert.equal(parsed.frames[0].blob.size, 68);
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

test('Video Composer web interface wires every referenced control and includes a mobile layout', () => {
  const html = fs.readFileSync(new URL('../public/pixelforge/video-composer.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../public/pixelforge/video-composer.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/pixelforge/video-composer.css', import.meta.url), 'utf8');
  const ids = [...js.matchAll(/\$\('#([^']+)'\)/g)].map(match => match[1]);
  assert.ok(ids.length > 20, 'the composer should wire its import, preview, timeline and export controls');
  for (const id of new Set(ids)) assert.ok(html.includes('id="' + id + '"'), 'missing UI control: ' + id);
  assert.match(html, /video-composer\.js/);
  assert.match(css, /max-width:620px/);
  assert.match(js, /MediaRecorder/);
  assert.match(js, /getDisplayMedia/);
});

test('native CodeLab project drawing mode selects the matching Video Composer scaling default', () => {
  const js = fs.readFileSync(new URL('../public/pixelforge/video-composer.js', import.meta.url), 'utf8');
  const editor = fs.readFileSync(new URL('../public/pixelforge/src/editor.js', import.meta.url), 'utf8');
  assert.match(editor, /sourceDrawingMode: drawingConfiguration\.activeMode/);
  assert.match(editor, /scalingMode: getVideoScalingMode\(drawingConfiguration\.activeMode\)/);
  assert.match(js, /getVideoScalingMode\(project\.drawingConfiguration\?\.activeMode\)/);
  assert.match(js, /if \(\['smooth', 'pixelated'\]\.includes\(parsed\.manifest\.scalingMode\)\) \$\('#vc-scaling-mode'\)\.value = parsed\.manifest\.scalingMode/);
});

test('HD capture presets preserve aspect ratio and fit the full artwork without cropping', async () => {
  const { getCaptureDimensions, containRect, getSourceQualityAssessment, drawFrameToCanvas } = await import('../public/pixelforge/src/video-capture-layout.mjs');
  assert.deepEqual(getCaptureDimensions('1080', '16:9', 128, 128), { width: 1920, height: 1080 });
  assert.deepEqual(getCaptureDimensions('720', '9:16', 128, 160), { width: 720, height: 1280 });
  assert.deepEqual(getCaptureDimensions('1080', '1:1', 128, 128), { width: 1080, height: 1080 });
  const rect = containRect(128, 160, 0, 0, 1000, 500);
  assert.equal(rect.width / rect.height, 128 / 160);
  assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 1000 && rect.y + rect.height <= 500);

  const upscale = getSourceQualityAssessment(1280, 720, 1920, 1080);
  assert.equal(upscale.upscaled, true);
  assert.equal(upscale.scale, 1.5);
  assert.deepEqual([upscale.contentWidth, upscale.contentHeight], [1920, 1080]);
  const native = getSourceQualityAssessment(1920, 1080, 1920, 1080);
  assert.equal(native.upscaled, false);
  assert.equal(native.downscaled, false);

  const calls = [];
  const context = {
    save() {}, restore() {}, clearRect(...args) { calls.push(['clearRect', ...args]); },
    fillRect(...args) { calls.push(['fillRect', ...args]); },
    drawImage(...args) { calls.push(['drawImage', ...args]); },
  };
  const bitmap = { width: 128, height: 128 };
  const fitted = drawFrameToCanvas(context, bitmap, 1920, 1080, { backgroundColor: '#000', scalingMode: 'smooth' });
  assert.deepEqual(fitted, { x: 420, y: 0, width: 1080, height: 1080 });
  assert.deepEqual(calls.find(call => call[0] === 'drawImage'), ['drawImage', bitmap, 420, 0, 1080, 1080]);
  assert.equal(context.imageSmoothingEnabled, true);
  assert.equal(context.imageSmoothingQuality, 'high');
  drawFrameToCanvas(context, bitmap, 1920, 1080, { scalingMode: 'pixelated' });
  assert.equal(context.imageSmoothingEnabled, false);
});

test('content capture includes a frame strip and keeps pixel-art rendering unsmoothed', () => {
  const html = fs.readFileSync(new URL('../public/pixelforge/video-composer.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../public/pixelforge/video-composer.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/pixelforge/video-composer.css', import.meta.url), 'utf8');
  const layout = fs.readFileSync(new URL('../public/pixelforge/src/video-capture-layout.mjs', import.meta.url), 'utf8');
  assert.match(html, /id="vc-capture-content"/);
  assert.match(html, /id="vc-capture-studio"/);
  assert.match(html, /id="vc-record-studio"/);
  assert.match(js, /drawContentComposition/);
  assert.match(layout, /scalingMode !== 'pixelated'/);
  assert.match(js, /getDisplayMedia/);
  assert.match(html, /id="vc-source-quality"/);
  assert.match(html, /id="vc-motion-quality"/);
  assert.match(html, /id="vc-scaling-mode"/);
  assert.match(css, /data-scaling-mode="smooth"\]\{image-rendering:auto/);
  assert.match(js, /no inventa movimiento intermedio/i);
  assert.match(js, /getSourceQualityAssessment/);
  assert.match(js, /requestAnimationFrame\(playbackTick\)/);
  assert.match(js, /performance\.now\(\) - playbackStartedAt/);
  assert.doesNotMatch(js, /playbackTimer/);
  assert.match(js, /\$\('#vc-output-fps'\)\.value = String\(parsed\.manifest\.fps\);\s*refreshMotionCadence\(\);/);
});

test('rejects PNG frames with broken chunk CRC or dimensions that differ from the manifest', async () => {
  const manifest = {
    format: 'pixelforge-video-package', version: 1, width: 1, height: 1,
    fps: 12, loop: true, frameCount: 1,
    frames: [{ index: 0, file: 'frames/frame-0001.png', durationMs: 83, startMs: 0 }],
  };
  const corrupted = await createZipBlob([
    { name: 'manifest.json', data: JSON.stringify(manifest) },
    { name: 'frames/frame-0001.png', data: pngFixture({ corrupt: true }) },
  ]);
  await assert.rejects(() => parsePixelForgeVideoPackage(corrupted), /PNG .* CRC integrity check/);

  const wrongDimensions = { ...manifest, width: 2 };
  const mismatched = await createZipBlob([
    { name: 'manifest.json', data: JSON.stringify(wrongDimensions) },
    { name: 'frames/frame-0001.png', data: pngFixture() },
  ]);
  await assert.rejects(() => parsePixelForgeVideoPackage(mismatched), /dimensions do not match/);
});

test('rejects ZIP payload corruption even when its central directory remains intact', async () => {
  const good = await createZipBlob([{ name: 'payload.bin', data: 'original payload' }]);
  const bytes = new Uint8Array(await good.arrayBuffer());
  const nameLength = bytes[26] | (bytes[27] << 8);
  const dataOffset = 30 + nameLength;
  bytes[dataOffset] ^= 0xff;
  await assert.rejects(() => readStoredZip(new Blob([bytes])), /failed its CRC integrity check/);
});

test('constant-FPS resampling follows variable-duration source frames and preserves total duration', async () => {
  const { buildConstantFrameRateSequence } = await import('../public/pixelforge/src/video-composer-core.mjs');
  const source = [
    { id: 'a', durationMs: 100, blob: new Blob(['a']) },
    { id: 'b', durationMs: 200, blob: new Blob(['b']) },
    { id: 'c', durationMs: 100, blob: new Blob(['c']) },
  ];
  const output = buildConstantFrameRateSequence(source, 10);
  assert.equal(output.length, 4);
  assert.deepEqual(output.map(frame => frame.id), ['a', 'b', 'b', 'c']);
  assert.deepEqual(output.map(frame => frame.sourceIndex), [0, 1, 1, 2]);
  assert.deepEqual(output.map(frame => frame.timestampMs), [0, 100, 200, 300]);
  assert.equal(output.reduce((sum, frame) => sum + frame.durationMs, 0), 400);
  assert.ok(output.every(frame => frame.blob instanceof Blob));

  const lowCadence = buildConstantFrameRateSequence([
    { id: 'pose-a', durationMs: 1000 / 12, blob: new Blob(['a']) },
    { id: 'pose-b', durationMs: 1000 / 12, blob: new Blob(['b']) },
  ], 60);
  assert.equal(lowCadence.length, 10);
  assert.ok(new Set(lowCadence.map(frame => frame.id)).size < lowCadence.length,
    'higher output FPS must not pretend to create new source poses');
});

test('constant-FPS resampling rejects unsafe frame explosions and invalid timelines', async () => {
  const { buildConstantFrameRateSequence } = await import('../public/pixelforge/src/video-composer-core.mjs');
  assert.throws(() => buildConstantFrameRateSequence([{ durationMs: 10000 }], 60, { maxFrames: 100 }), /safe export limit/);
  assert.throws(() => buildConstantFrameRateSequence([{ durationMs: 0 }], 12), /positive finite duration/);
  assert.throws(() => buildConstantFrameRateSequence([], 12), /non-empty source/);
});
