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
  assert.match(js, /const sourceDrawingMode = project\.drawingConfiguration\?\.activeMode === 'illustration' \? 'illustration' : 'pixel-art'/);
  assert.match(js, /getVideoScalingMode\(sourceDrawingMode\)/);
  assert.match(js, /if \(\['smooth', 'pixelated'\]\.includes\(parsed\.manifest\.scalingMode\)\) \$\('#vc-scaling-mode'\)\.value = parsed\.manifest\.scalingMode/);
});

test('HD capture presets preserve aspect ratio and fit the full artwork without cropping', async () => {
  const { getCaptureDimensions, getVideoCompositionProfile, containRect, getSourceQualityAssessment, drawFrameToCanvas } = await import('../public/pixelforge/src/video-capture-layout.mjs');
  assert.deepEqual(getCaptureDimensions('1080', '16:9', 128, 128), { width: 1920, height: 1080 });
  assert.deepEqual(getCaptureDimensions('720', '9:16', 128, 160), { width: 720, height: 1280 });
  assert.deepEqual(getCaptureDimensions('1080', '1:1', 128, 128), { width: 1080, height: 1080 });
  assert.deepEqual(getCaptureDimensions('1080', '4:5', 1920, 1080), { width: 1080, height: 1350 });
  assert.equal(getVideoCompositionProfile('instagram-feed').aspect, '4:5');
  assert.equal(getVideoCompositionProfile('instagram-feed').platform, 'Instagram');
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

test('native mixed-style composition applies independent sampling to every raster and vector layer', async () => {
  const { drawLayeredFrameToCanvas } = await import('../public/pixelforge/src/video-capture-layout.mjs');
  const draws = [];
  const context = {
    imageSmoothingEnabled: true,
    save() {}, restore() {}, clearRect() {}, fillRect() {},
    translate() {}, rotate() {}, scale() {},
    drawImage(bitmap) { draws.push({ bitmap, smoothing: this.imageSmoothingEnabled, quality: this.imageSmoothingQuality }); },
  };
  const layers = [
    { bitmap: { id: 'illustration' }, authoringMode: 'illustration', opacity: 1 },
    { bitmap: { id: 'pixel-art' }, authoringMode: 'pixel-art', opacity: 1 },
    { bitmap: { id: 'vector-overlay' }, authoringMode: 'illustration', opacity: 1 },
  ];
  const fit = drawLayeredFrameToCanvas(context, layers, 32, 32, 1920, 1080, { fitMode: 'contain' });
  assert.deepEqual(draws.map(item => [item.bitmap.id, item.smoothing]), [
    ['illustration', true], ['pixel-art', false], ['vector-overlay', true],
  ]);
  assert.deepEqual(fit, {
    scale: 33.75, cropX: 0, cropY: 0, offsetX: 420, offsetY: 0, fitMode: 'contain',
  });
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
  assert.match(layout, /options\.fitMode === 'cover'/);
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
  const mixedLayers = [{ blob: new Blob(['pixel-cel']), authoringMode: 'pixel-art' },
    { blob: new Blob(['illustration-cel']), authoringMode: 'illustration' }];
  const source = [
    { id: 'a', durationMs: 100, blob: new Blob(['a']), layers: mixedLayers, width: 1000, height: 1000 },
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
  assert.equal(output[0].layers, mixedLayers, 'CFR resampling must retain per-layer render sources and mode metadata');
  assert.equal(output[0].width, 1000);
  assert.equal(output[0].height, 1000);

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


test('composition guides expose centered safe bounds and video fitting never stretches source frames', async () => {
  const { getCompositionGuide, coverSourceRect, coverSourceRectAtFocalPoint, drawFrameToCanvas } = await import('../public/pixelforge/src/video-capture-layout.mjs');
  const horizontal = getCompositionGuide(1000, 1000, 1920, 1080);
  assert.deepEqual(horizontal.safeArea, { x: 0, y: 219, width: 1000, height: 563 });
  assert.equal(horizontal.aspectRatio, '1920:1080');
  const vertical = getCompositionGuide(1000, 1000, 1080, 1920);
  assert.deepEqual(vertical.safeArea, { x: 219, y: 0, width: 563, height: 1000 });

  const crop = coverSourceRect(1920, 1080, 1080, 1920);
  const rightFocused = coverSourceRectAtFocalPoint(1920, 1080, 1080, 1920, { x: 0.9, y: 0.5 });
  assert.ok(rightFocused.x > crop.x, 'focal-point reframe should move the crop toward the requested subject');
  assert.equal(rightFocused.width, crop.width);
  assert.equal(rightFocused.height, crop.height);
  assert.equal(crop.width, 607.5);
  assert.equal(crop.height, 1080);
  assert.equal(crop.x, 656.25);
  const coverQuality = (await import('../public/pixelforge/src/video-capture-layout.mjs'))
    .getSourceQualityAssessment(1920, 1080, 1080, 1920, { fitMode: 'cover' });
  assert.equal(coverQuality.sourceCrop.width, 607.5);
  assert.equal(coverQuality.scale, 1080 / 607.5);
  assert.equal(coverQuality.contentWidth, 1080);

  const calls = [];
  const context = {
    save() {}, restore() {}, clearRect() {}, fillRect() {},
    drawImage(...args) { calls.push(args); },
  };
  const bitmap = { width: 1000, height: 1000 };
  const fitted = drawFrameToCanvas(context, bitmap, 1920, 1080, { fitMode: 'contain' });
  assert.deepEqual(fitted, { x: 420, y: 0, width: 1080, height: 1080 });
  assert.deepEqual(calls.pop(), [bitmap, 420, 0, 1080, 1080]);
  const covered = drawFrameToCanvas(context, bitmap, 1080, 1920, { fitMode: 'cover' });
  assert.equal(covered.x, 218.75);
  assert.equal(covered.width, 562.5);
  assert.deepEqual(calls.pop(), [bitmap, 218.75, 0, 562.5, 1000, 0, 0, 1080, 1920]);
});


test('Video Composer exposes an agent-readable composition guide and routes fit mode to the export worker', () => {
  const html = fs.readFileSync(new URL('../public/pixelforge/video-composer.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../public/pixelforge/video-composer.js', import.meta.url), 'utf8');
  const encoder = fs.readFileSync(new URL('../public/pixelforge/src/video-webm-encoder.mjs', import.meta.url), 'utf8');
  const worker = fs.readFileSync(new URL('../public/pixelforge/src/video-webm-encoder-worker.mjs', import.meta.url), 'utf8');
  assert.match(html, /id="vc-fit-mode"/);
  assert.match(html, /id="vc-reframe"/);
  assert.match(html, /value="cover" selected/);
  assert.match(html, /id="vc-copy-agent-guide"/);
  assert.match(js, /getCompositionGuide/);
  assert.match(js, /instagram-feed/);
  assert.match(js, /Platform profiles are output presets/);
  assert.match(js, /normalizedSafeArea/);
  assert.match(js, /currentFocalPoint/);
  assert.match(js, /focalPoint: currentFocalPoint\(\)/);
  assert.match(js, /drawingModesPresent/);
  assert.match(js, /layerModesByFrame/);
  assert.match(js, /Keep each layer authoring mode exactly as listed in layerModesByFrame/);
  assert.match(js, /Do not stretch or apply different horizontal and vertical scale factors/);
  assert.match(encoder, /fitMode:options\.fitMode/);
  assert.match(worker, /fitMode = 'contain'/);
  assert.match(worker, /fitMode\s*$/m);
});


test('native video composition scales mixed illustration and pixel-art layers independently without stretching', async () => {
  const { drawLayeredFrameToCanvas } = await import('../public/pixelforge/src/video-capture-layout.mjs');
  const draws = [];
  const scales = [];
  const context = {
    imageSmoothingEnabled: true,
    save() {}, restore() {}, clearRect() {}, fillRect() {},
    translate() {}, rotate() {},
    scale(x, y) { scales.push([x, y]); },
    drawImage(bitmap) { draws.push({ bitmap, smoothing: this.imageSmoothingEnabled }); },
  };
  const pixelLayer = { bitmap: { id: 'pixel' }, authoringMode: 'pixel-art', opacity: 1 };
  const illustrationLayer = { bitmap: { id: 'illustration' }, authoringMode: 'illustration', opacity: 0.8 };
  const result = drawLayeredFrameToCanvas(context, [pixelLayer, illustrationLayer], 1000, 1000, 1080, 1920, {
    fitMode: 'cover', backgroundColor: '#000000',
  });
  assert.equal(result.fitMode, 'cover');
  assert.equal(result.cropX, 218.75);
  assert.deepEqual(draws, [
    { bitmap: pixelLayer.bitmap, smoothing: false },
    { bitmap: illustrationLayer.bitmap, smoothing: true },
  ]);
  const outputScale = scales[0];
  assert.ok(Math.abs(outputScale[0] - outputScale[1]) < 1e-12,
    'cover must use the same scale on both axes and crop instead of stretching');

  scales.length = 0;
  const contained = drawLayeredFrameToCanvas(context, [pixelLayer, illustrationLayer], 1000, 1000, 1920, 1080, {
    fitMode: 'contain',
  });
  assert.equal(contained.fitMode, 'contain');
  assert.ok(Math.abs(scales[0][0] - scales[0][1]) < 1e-12,
    'contain must use uniform scaling and preserve the full source');
  assert.equal(contained.offsetX, 420);
});

test('Video Composer resolves per-cel mode before frame, layer and project defaults for native exports', () => {
  const js = fs.readFileSync(new URL('../public/pixelforge/video-composer.js', import.meta.url), 'utf8');
  const worker = fs.readFileSync(new URL('../public/pixelforge/src/video-webm-encoder-worker.mjs', import.meta.url), 'utf8');
  const encoder = fs.readFileSync(new URL('../public/pixelforge/src/video-webm-encoder.mjs', import.meta.url), 'utf8');
  const exportWorker = fs.readFileSync(new URL('../pixelforge-video-composer-export.mjs', import.meta.url), 'utf8');
  assert.match(exportWorker, /createPixelForgeCodeLabPackageZip/);
  assert.match(exportWorker, /perLayerDrawingModes: true/);
  assert.match(js, /vectorModelToSVG/);
  assert.match(js, /authoringMode: 'illustration'/);
  assert.match(js, /resolveDrawingMode\(\{ cel, frame, layer, project \}\)/);
  assert.match(js, /layers: renderLayers/);
  assert.match(js, /drawingModesPresent/);
  assert.match(encoder, /layers: Array\.isArray\(frame\.layers\)/);
  assert.match(worker, /drawLayeredFrameToCanvas/);
  assert.match(worker, /layer\.blob/);
  assert.match(js, /layers: layerBitmaps/);
  const layout = fs.readFileSync(new URL('../public/pixelforge/src/video-capture-layout.mjs', import.meta.url), 'utf8');
  assert.match(layout, /Array\.isArray\(options\.layers\)/);
  assert.match(layout, /drawLayeredFrameToCanvas\(context, options\.layers/);
});
