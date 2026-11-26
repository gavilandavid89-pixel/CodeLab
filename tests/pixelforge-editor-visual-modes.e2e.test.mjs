import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chromium from '@sparticuz/chromium';
import { chromium as playwrightChromium } from 'playwright-core';
import { importPixelForgeCodeLabPackage } from '../public/pixelforge/src/codelab-package.js';
import { TiledRasterProjectDocument } from '../public/pixelforge/src/raster-tiled-adapter.mjs';
import { TiledAnimationDocument } from '../public/pixelforge/src/animation-tiled-adapter.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const artifactDir = process.env.PIXELFORGE_VISUAL_ARTIFACT_DIR
  ? path.resolve(process.env.PIXELFORGE_VISUAL_ARTIFACT_DIR)
  : path.join(os.tmpdir(), 'pixelforge-editor-visual-matrix');
const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};

function expectedSymmetryPoints(point, width, height, mode) {
  const cx = (width - 1) / 2, cy = (height - 1) / 2;
  const dx = point.x - cx, dy = point.y - cy;
  let offsets = [[dx, dy]];
  if (mode === 2) offsets = [[dx, dy], [-dx, dy]];
  else if (mode === 4) offsets = [[dx, dy], [-dx, dy], [dx, -dy], [-dx, -dy]];
  else if (mode === 8) offsets = [
    [dx, dy], [-dy, dx], [-dx, -dy], [dy, -dx],
    [-dx, dy], [-dy, -dx], [dx, -dy], [dy, dx],
  ];
  return [...new Map(offsets.map(([x, y]) => {
    const px = Math.round(cx + x), py = Math.round(cy + y);
    return [px + ',' + py, { x: px, y: py }];
  })).values()].filter(p => p.x >= 0 && p.y >= 0 && p.x < width && p.y < height);
}

test('PixelForge visible editor renders mixed-mode brush/symmetry combinations and edge gestures correctly', {
  timeout: 150000, concurrency: false,
}, async t => {
  await fs.promises.mkdir(artifactDir, { recursive: true });
  const savedProjectSnapshots = [];
  let fullSnapshotSaveCount = 0;
  const receivedCelPatches = [];
  const appliedPatchReceipts = new Map();
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/api/pixelforge/mode') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ guestMode: true }));
      return;
    }
    if (url.pathname === '/api/pixelforge/projects') {
      if (request.method === 'PUT') {
        fullSnapshotSaveCount++;
        let body = '';
        for await (const chunk of request) body += chunk;
        let project = {};
        try { project = JSON.parse(body).project || {}; } catch {}
        const previous = [...savedProjectSnapshots].reverse().find(item => item.id === project.id);
        const persisted = { ...project, serverRevision: previous ? (previous.serverRevision || 1) + 1 : 1 };
        savedProjectSnapshots.push(structuredClone(persisted));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ project: persisted }));
      } else {
        const latest = savedProjectSnapshots.at(-1);
        const projects = latest ? [{ id: latest.id, name: latest.name, width: latest.width, height: latest.height, updatedAt: '2026-11-25T00:00:00.000Z' }] : [];
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ projects }));
      }
      return;
    }
    const patchRoute = url.pathname.match(/^\/api\/pixelforge\/projects\/([^/]+)\/patches$/);
    if (patchRoute && request.method === 'POST') {
      let patch;
      try {
        let body = '';
        for await (const chunk of request) body += chunk;
        patch = JSON.parse(body);
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'invalid_patch' }));
        return;
      }
      const replay = appliedPatchReceipts.get(patch.operationId);
      if (replay) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(replay));
        return;
      }
      const projectId = decodeURIComponent(patchRoute[1]);
      const current = [...savedProjectSnapshots].reverse().find(item => item.id === projectId);
      if (!current || patch.projectId !== projectId || patch.baseRevision !== current.serverRevision) {
        response.writeHead(409, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'pixelforge_revision_conflict' }));
        return;
      }
      const updated = structuredClone(current);
      const frame = updated.animation?.frames?.find(item => item.id === patch.frameId);
      const entry = frame?.cels?.find(item => item.layerId === patch.layerId);
      if (!entry?.cel) {
        response.writeHead(409, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'patch_target_not_found' }));
        return;
      }
      const applyPlane = (items, operation, prefix, dataKey) => {
        const key = item => item.x + ':' + item.y;
        const index = items.findIndex(item => key(item) === operation.x + ':' + operation.y);
        if (operation.type === prefix + '.remove') {
          if (index >= 0) items.splice(index, 1);
        } else if (operation.type === prefix + '.put') {
          const tile = { x: operation.x, y: operation.y, width: operation.width, height: operation.height, sha256: operation.sha256, [dataKey]: operation[dataKey] };
          if (index >= 0) items[index] = tile; else items.push(tile);
        }
      };
      entry.cel.tiles ||= [];
      entry.cel.ownershipTiles ||= [];
      for (const operation of patch.operations || []) {
        if (operation.type.startsWith('tile.')) applyPlane(entry.cel.tiles, operation, 'tile', 'rgba');
        else if (operation.type.startsWith('ownership.')) applyPlane(entry.cel.ownershipTiles, operation, 'ownership', 'owners');
        else {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'invalid_patch_operation' }));
          return;
        }
      }
      entry.cel.tiles.sort((a, b) => a.y - b.y || a.x - b.x);
      entry.cel.ownershipTiles.sort((a, b) => a.y - b.y || a.x - b.x);
      const frameIndex = updated.animation.frames.findIndex(item => item.id === patch.frameId);
      if (frameIndex === updated.animation.activeFrameIndex) {
        const layer = updated.layers?.find(item => item.id === patch.layerId);
        if (layer) layer.cel = structuredClone(entry.cel);
      }
      updated.serverRevision = (current.serverRevision || 1) + 1;
      savedProjectSnapshots.push(updated);
      receivedCelPatches.push(structuredClone(patch));
      const receipt = { project: { ...updated }, operationId: patch.operationId, serverRevision: updated.serverRevision };
      appliedPatchReceipts.set(patch.operationId, receipt);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(receipt));
      return;
    }
    if (url.pathname.startsWith('/api/pixelforge/projects/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/pixelforge/projects/'.length));
      const project = [...savedProjectSnapshots].reverse().find(item => item.id === id) || null;
      response.writeHead(project ? 200 : 404, { 'content-type': 'application/json' });
      response.end(JSON.stringify(project ? { project: { ...project, serverRevision: project.serverRevision } } : { error: 'project_not_found' }));
      return;
    }
    const pathname = decodeURIComponent(url.pathname);
    const file = path.resolve(root, '.' + pathname);
    if (file !== root && !file.startsWith(root + path.sep)) {
      response.writeHead(403); response.end('forbidden'); return;
    }
    fs.readFile(file, (error, bytes) => {
      if (error) { response.writeHead(404); response.end('not found'); return; }
      response.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' });
      response.end(bytes);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  chromium.setGraphicsMode = false;
  const browser = await playwrightChromium.launch({
    args: chromium.args, executablePath: await chromium.executablePath(),
    headless: true, timeout: 60000,
  });
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  });

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error.stack || error.message)));
  await page.goto('http://127.0.0.1:' + server.address().port + '/pixelforge/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.pixelforgeReady === 'true', null, { timeout: 30000 });
  await page.locator('#canvas').waitFor({ state: 'visible' });

  const dimensions = await page.locator('#document-size').textContent();
  let [width, height] = dimensions.split('×').map(value => Number(value.trim()));
  assert.equal(width, 128);
  assert.equal(height, 128);

  const setValue = async (selector, value, eventName = 'input') => page.locator(selector).evaluate((element, next) => {
    element.value = String(next);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  const setColor = async value => setValue('#color', value);
  const setMode = async mode => {
    await page.locator('#drawing-mode').selectOption(mode);
    await page.waitForTimeout(40);
  };
  const setSymmetry = mode => page.locator('#symmetry-mode').selectOption(String(mode));
  const screenPoint = async ({ x, y }) => {
    const screen = await page.locator('#canvas').evaluate((canvas, point) => {
      const work = document.querySelector('#work-area').getBoundingClientRect();
      const rect = canvas.getBoundingClientRect();
      const [width, height] = document.querySelector('#document-size').textContent.split('×').map(v => Number(v.trim()));
      const zoom = Number.parseFloat(document.querySelector('#zoom-label').textContent) / 100;
      return {
        x: rect.left + (work.width - width * zoom) / 2 + (point.x + 0.5) * zoom,
        y: rect.top + (work.height - height * zoom) / 2 + (point.y + 0.5) * zoom,
        zoom, width, height,
      };
    }, { x, y });
    // Calibrate against the editor's own live coordinate readout. This avoids
    // treating CSS box/border rounding as a brush or symmetry defect.
    for (let attempt = 0; attempt < 4; attempt++) {
      await page.mouse.move(screen.x, screen.y);
      const readout = await page.locator('#coordinate-readout').textContent();
      const match = readout.match(/x: (-?\d+) · y: (-?\d+)/);
      if (!match) {
        if (readout === 'outside canvas') {
          screen.x += (x < screen.width / 2 ? 3 : -3) * screen.zoom;
          screen.y += (y < screen.height / 2 ? 3 : -3) * screen.zoom;
          continue;
        }
        break;
      }
      const dx = x - Number(match[1]), dy = y - Number(match[2]);
      if (dx === 0 && dy === 0) return screen;
      screen.x += dx * screen.zoom;
      screen.y += dy * screen.zoom;
    }
    const finalReadout = await page.locator('#coordinate-readout').textContent();
    throw new Error('Could not position pointer at document pixel ' + x + ',' + y + '; editor reports ' + finalReadout);
  };
  const drawAt = async point => {
    const screen = await screenPoint(point);
    await page.mouse.move(screen.x, screen.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const sampleVisible = async (point, hex) => {
    const screen = await screenPoint(point);
    return page.locator('#canvas').evaluate((canvas, p) => {
      const rect = canvas.getBoundingClientRect();
      const dpr = canvas.width / Math.max(1, canvas.clientWidth);
      const centerX = Math.floor((p.x - rect.left) * dpr);
      const centerY = Math.floor((p.y - rect.top) * dpr);
      const context = canvas.getContext('2d');
      const target = [1, 3, 5].map(offset => Number.parseInt(p.hex.slice(offset, offset + 2), 16));
      let best = null;
      // Sample a tiny screen-space neighborhood to tolerate the 1px artboard
      // outline and fractional zoom interpolation without masking missing dabs.
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const x = Math.max(0, Math.min(canvas.width - 1, centerX + dx));
        const y = Math.max(0, Math.min(canvas.height - 1, centerY + dy));
        const rgba = Array.from(context.getImageData(x, y, 1, 1).data);
        const error = rgba.slice(0, 3).reduce((sum, value, index) => sum + Math.abs(value - target[index]), 0);
        if (!best || error < best.error) best = { rgba, offset: { x: dx, y: dy }, error };
      }
      return best;
    }, { ...screen, hex });
  };
  const sampleVisibleExact = async point => {
    const screen = await screenPoint(point);
    return page.locator('#canvas').evaluate((canvas, p) => {
      const rect = canvas.getBoundingClientRect();
      const dpr = canvas.width / Math.max(1, canvas.clientWidth);
      const x = Math.max(0, Math.min(canvas.width - 1, Math.floor((p.x - rect.left) * dpr)));
      const y = Math.max(0, Math.min(canvas.height - 1, Math.floor((p.y - rect.top) * dpr)));
      return Array.from(canvas.getContext('2d').getImageData(x, y, 1, 1).data);
    }, screen);
  };
  const expectedRgb = hex => [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16));
  const assertVisibleColor = async (point, hex, label, tolerance = 20) => {
    await screenPoint(point);
    const readout = await page.locator('#coordinate-readout').textContent();
    assert.equal(readout, 'x: ' + point.x + ' · y: ' + point.y,
      'screen-to-document mapping must identify the same pixel being visually sampled for ' + label);
    const sampled = await sampleVisible(point, hex);
    const actual = sampled.rgba;
    const expected = expectedRgb(hex);
    const channelError = actual.slice(0, 3).map((value, index) => Math.abs(value - expected[index]));
    if (!channelError.every(error => error <= tolerance)) {
      await page.locator('#canvas').screenshot({ path: path.join(artifactDir, 'failure-' + label.replace(/[^a-z0-9-]/gi, '-') + '.png') });
      await fs.promises.writeFile(path.join(artifactDir, 'failure-details.json'), JSON.stringify({ label, point, expected, actual, sampled, readout }, null, 2));
    }
    assert.ok(channelError.every(error => error <= tolerance),
      label + ' must be visibly rendered near document pixel ' + point.x + ',' + point.y +
      '; expected RGB ' + expected.join(',') + ', got ' + actual.slice(0, 3).join(','));
    assert.equal(actual[3], 255, label + ' must be opaque on the visible editor surface');
  };

  // Verify real mode-specific defaults and per-mode custom profile restoration.
  await setMode('illustration');
  assert.equal(await page.locator('#brush-size').inputValue(), '5');
  assert.equal(await page.locator('#brush-shape').inputValue(), 'circle');
  assert.equal(await page.locator('#brush-hardness').inputValue(), '55');
  assert.equal(await page.locator('#fill-tolerance').inputValue(), '24', 'illustration mode should use a forgiving fill tolerance');
  assert.equal(await page.locator('#magic-tolerance').inputValue(), '12', 'illustration mode should use a soft color-selection tolerance');
  assert.equal(await page.locator('#transform-interpolation').inputValue(), 'bilinear');
  await setValue('#fill-tolerance', 37);
  await setValue('#magic-tolerance', 18);
  await setValue('#brush-size', 9);
  await setValue('#brush-hardness', 71);
  await setValue('#brush-opacity', 82);
  await setMode('pixel-art');
  assert.equal(await page.locator('#brush-size').inputValue(), '1');
  assert.equal(await page.locator('#brush-shape').inputValue(), 'square');
  assert.equal(await page.locator('#brush-hardness').inputValue(), '100');
  assert.equal(await page.locator('#fill-tolerance').inputValue(), '0', 'pixel-art mode should require exact color matches for fill by default');
  assert.equal(await page.locator('#magic-tolerance').inputValue(), '0', 'pixel-art mode should require exact color matches for magic selection by default');
  assert.equal(await page.locator('#transform-interpolation').inputValue(), 'nearest');
  await setValue('#fill-tolerance', 4);
  await setValue('#brush-size', 2);
  await setValue('#brush-opacity', 64);
  await setMode('illustration');
  assert.equal(await page.locator('#brush-size').inputValue(), '9', 'illustration custom size must survive a round trip');
  assert.equal(await page.locator('#brush-hardness').inputValue(), '71', 'illustration hardness must be restored');
  assert.equal(await page.locator('#brush-opacity').inputValue(), '82', 'illustration opacity must be restored');
  assert.equal(await page.locator('#fill-tolerance').inputValue(), '37', 'illustration fill tolerance must survive mode switching');
  assert.equal(await page.locator('#magic-tolerance').inputValue(), '18', 'illustration magic-selection tolerance must survive mode switching');
  await setMode('pixel-art');
  assert.equal(await page.locator('#brush-size').inputValue(), '2', 'pixel-art custom size must survive a round trip');
  assert.equal(await page.locator('#brush-opacity').inputValue(), '64', 'pixel-art opacity must be restored');
  assert.equal(await page.locator('#fill-tolerance').inputValue(), '4', 'pixel-art fill tolerance must survive mode switching');

  const matrix = [];
  for (const mode of ['illustration', 'pixel-art']) {
    await setMode(mode);
    if (mode === 'pixel-art') await page.locator('#add-layer').click(); // Keep each mode's visual matrix on an independent, unowned cel.
    const color = mode === 'illustration' ? '#e34b72' : '#39d6a5';
    await setColor(color);
    await setValue('#brush-size', 5);
    await setValue('#brush-hardness', 100);
    await setValue('#brush-opacity', 100);
    for (const shape of ['square', 'circle']) {
      await page.locator('#brush-shape').selectOption(shape);
      for (const symmetry of [0, 2, 4, 8]) {
        await setSymmetry(symmetry);
        const origin = { x: 22, y: 35 };
        await drawAt(origin);
        const points = expectedSymmetryPoints(origin, width, height, symmetry);
        for (const point of points) await assertVisibleColor(point, color, mode + '/' + shape + '/symmetry-' + symmetry);
        matrix.push({ mode, shape, symmetry, visiblePoints: points.length });
      }
    }

    // Real screen-space screenshot for each mode, not a model-only assertion.
    await page.locator('#canvas').screenshot({ path: path.join(artifactDir, 'editor-' + mode + '.png') });
  }
  assert.equal(matrix.length, 16, 'the visual matrix must cover 2 modes × 2 brush shapes × 4 symmetry settings');

  // Check clipped corner dabs and a pointer path that exits and re-enters the artwork.
  await setSymmetry(0);
  await setMode('pixel-art');
  await setColor('#ffffff');
  await setValue('#brush-size', 1);
  await page.locator('#brush-shape').selectOption('square');
  await drawAt({ x: 0, y: 0 });
  await assertVisibleColor({ x: 0, y: 0 }, '#ffffff', 'top-left canvas edge dab');
  await drawAt({ x: 127, y: 127 });
  await assertVisibleColor({ x: 127, y: 127 }, '#ffffff', 'bottom-right canvas edge dab');

  const first = await screenPoint({ x: 12, y: 12 });
  const second = await screenPoint({ x: 18, y: 18 });
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  await page.mouse.move(-4, -4, { steps: 3 });
  await page.mouse.move(second.x, second.y, { steps: 3 });
  await page.mouse.up();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await assertVisibleColor({ x: 18, y: 18 }, '#ffffff', 'stroke must continue after an outside-canvas segment');

  // Verify the actual rendered sampling behavior at a fractional zoom: smooth
  // illustration scaling must blend edge pixels; pixel-art must remain crisp.
  const emptyScreen = await screenPoint({ x: 110, y: 110 });
  const backgroundColor = await page.locator('#canvas').evaluate((canvas, p) => {
    const rect = canvas.getBoundingClientRect();
    const dpr = canvas.width / Math.max(1, canvas.clientWidth);
    const x = Math.floor((p.x - rect.left) * dpr), y = Math.floor((p.y - rect.top) * dpr);
    return Array.from(canvas.getContext('2d').getImageData(x, y, 1, 1).data).slice(0, 3).join(',');
  }, emptyScreen);
  const interpolationEvidence = {};
  for (const mode of ['illustration', 'pixel-art']) {
    await setMode(mode);
    await setSymmetry(0);
    await setColor('#ffffff');
    await setValue('#brush-size', 1);
    await setValue('#brush-opacity', 100);
    await page.locator('#brush-shape').selectOption('square');
    const target = mode === 'illustration' ? { x: 60, y: 60 } : { x: 84, y: 84 };
    await drawAt(target);
    const targetScreen = await screenPoint(target);
    interpolationEvidence[mode] = await page.locator('#canvas').evaluate((canvas, p) => {
      const rect = canvas.getBoundingClientRect();
      const dpr = canvas.width / Math.max(1, canvas.clientWidth);
      const zoom = Number.parseFloat(document.querySelector('#zoom-label').textContent) / 100;
      const radius = Math.max(5, Math.ceil(zoom) + 2);
      const x0 = Math.max(0, Math.floor((p.x - rect.left) * dpr) - radius);
      const y0 = Math.max(0, Math.floor((p.y - rect.top) * dpr) - radius);
      const image = canvas.getContext('2d').getImageData(x0, y0, Math.min(canvas.width - x0, radius * 2 + 1), Math.min(canvas.height - y0, radius * 2 + 1));
      const colors = new Set();
      for (let i = 0; i < image.data.length; i += 4) colors.add(image.data[i] + ',' + image.data[i + 1] + ',' + image.data[i + 2]);
      const white = '255,255,255';
      return { colors: [...colors], hasBlendedEdge: [...colors].some(value => value !== p.backgroundColor && value !== white), zoom };
    }, { ...targetScreen, backgroundColor });
  }
  assert.ok(interpolationEvidence.illustration.hasBlendedEdge,
    'illustration mode must visibly smooth a one-pixel edge at non-integer zoom');
  assert.equal(interpolationEvidence['pixel-art'].hasBlendedEdge, false,
    'pixel-art mode must not introduce blended edge colors at the same viewport scale');

  await page.waitForTimeout(900);
  assert.deepEqual(pageErrors, [], 'visible editor must not throw browser runtime errors');

  // Exercise odd, non-square geometry: symmetry axes must use independent
  // document centers and safely discard mirrored points outside the bounds.
  await page.locator('#new-document').click();
  await page.locator('#new-width').fill('127');
  await page.locator('#new-height').fill('91');
  await page.locator('#create-new').click();
  await page.waitForFunction(() => document.querySelector('#document-size').textContent.includes('127 × 91'));
  [width, height] = (await page.locator('#document-size').textContent()).split('×').map(value => Number(value.trim()));
  assert.equal(width, 127);
  assert.equal(height, 91);
  await setMode('pixel-art');
  await setColor('#f0c674');
  await setValue('#brush-size', 1);
  await setValue('#brush-hardness', 100);
  await setValue('#brush-opacity', 100);
  await page.locator('#brush-shape').selectOption('square');
  for (const symmetry of [2, 4, 8]) {
    await setSymmetry(symmetry);
    const origin = { x: 13, y: 17 };
    await drawAt(origin);
    const points = expectedSymmetryPoints(origin, width, height, symmetry);
    assert.ok(points.length > 0);
    for (const point of points) await assertVisibleColor(point, '#f0c674', '127x91/pixel-art/symmetry-' + symmetry);
  }
  await page.locator('#canvas').screenshot({ path: path.join(artifactDir, 'editor-odd-127x91.png') });

  // Shape coverage must differ visibly: a 5px square includes its diagonal
  // corners, while a 5px circle does not.
  await setSymmetry(0);
  await setColor('#ffffff');
  await setValue('#brush-size', 5);
  await page.locator('#brush-shape').selectOption('square');
  await drawAt({ x: 44, y: 44 });
  await assertVisibleColor({ x: 42, y: 42 }, '#ffffff', 'square brush diagonal corner');
  await setColor('#f0c674');
  await page.locator('#brush-shape').selectOption('circle');
  await drawAt({ x: 78, y: 78 });
  await assertVisibleColor({ x: 78, y: 78 }, '#f0c674', 'circle brush center');
  const circleCorner = await sampleVisibleExact({ x: 76, y: 76 });
  assert.deepEqual(circleCorner.slice(0, 3), backgroundColor.split(',').map(Number),
    'circle brush must leave the square-only diagonal corner untouched');

  // The visible editor intentionally exposes a 32px maximum even though
  // lower-level raster primitives can accept larger brush sizes.
  await setColor('#ffffff');
  await setValue('#brush-size', 128);
  assert.equal(await page.locator('#brush-size').inputValue(), '32', 'the visible brush control must clamp to its documented 32px maximum');
  await page.locator('#brush-shape').selectOption('square');
  await drawAt({ x: 15, y: 15 });
  await assertVisibleColor({ x: 0, y: 0 }, '#ffffff', '32px brush clipped to top-left edge');
  await assertVisibleColor({ x: 31, y: 31 }, '#ffffff', '32px brush reaches its far top-left extent');
  await drawAt({ x: 126, y: 90 });
  await assertVisibleColor({ x: 126, y: 90 }, '#ffffff', '32px brush clipped to bottom-right edge');

  // Cross the real editor's dense-to-tiled threshold and verify the pixels
  // painted by the pointer are actually visible in Chromium, not merely stored.
  await page.locator('#new-document').click();
  await page.locator('#new-width').fill('1024');
  await page.locator('#new-height').fill('1024');
  await page.locator('#create-new').click();
  await page.waitForFunction(() => document.querySelector('#document-size').textContent.includes('1024 × 1024'));
  [width, height] = (await page.locator('#document-size').textContent()).split('×').map(value => Number(value.trim()));
  assert.equal(await page.locator('#canvas').getAttribute('data-storage-mode'), 'tiled',
    'a 1024×1024 project must activate the sparse tiled editor path');
  assert.equal(await page.locator('.reference-center-section').isHidden(), true,
    'dense-only Reference Center controls must be hidden for sparse tiled documents');
  assert.equal(await page.locator('#ai-tab').isDisabled(), true,
    'AI proposals must not remain available against a dense-only workspace adapter');
  for (const selector of ['#add-layer', '#rename-layer', '#duplicate-layer']) {
    assert.equal(await page.locator(selector).isEnabled(), true,
      selector + ' must expose the implemented transactional sparse layer operation');
  }
  assert.equal(await page.locator('#delete-layer').isDisabled(), true,
    'the final sparse raster layer must not be deletable');
  // Baseline edge gesture immediately after creating a tiled document,
  // before the high-volume combination matrix below.
  await setMode('illustration');
  await setSymmetry(0);
  await setColor('#fa527d');
  await setValue('#brush-size', 5);
  await setValue('#brush-hardness', 100);
  await page.locator('#brush-shape').selectOption('square');
  await drawAt({ x: 2, y: 2 });
  await assertVisibleColor({ x: 2, y: 2 }, '#fa527d', 'tiled/initial-top-left-near-edge', 35);

  const tiledMatrix = [];
  for (const mode of ['illustration', 'pixel-art']) {
    await setMode(mode);
    const color = mode === 'illustration' ? '#fa527d' : '#31d7a1';
    await setColor(color);
    await setValue('#brush-size', 5);
    await setValue('#brush-hardness', mode === 'illustration' ? 55 : 100);
    await setValue('#brush-opacity', 100);
    for (const shape of ['square', 'circle']) {
      await page.locator('#brush-shape').selectOption(shape);
      for (const symmetry of [0, 2, 4, 8]) {
        await setSymmetry(symmetry);
        const point = { x: 120 + symmetry * 17 + (shape === 'circle' ? 11 : 0), y: 220 + (mode === 'pixel-art' ? 190 : 0) };
        await drawAt(point);
        const points = expectedSymmetryPoints(point, width, height, symmetry);
        for (const visiblePoint of points) {
          await assertVisibleColor(visiblePoint, color, 'tiled/' + mode + '/' + shape + '/symmetry-' + symmetry, mode === 'illustration' ? 35 : 20);
        }
        tiledMatrix.push({ mode, shape, symmetry, visiblePoints: points.length });
      }
    }
    await page.locator('#canvas').screenshot({ path: path.join(artifactDir, 'editor-tiled-' + mode + '.png') });
  }

  // Exercise clipped edge dabs in both drawing modes, including the last
  // document pixel where the viewport renderer clamps its source rectangle.
  await setSymmetry(0);
  for (const [mode, point, color] of [
    ['illustration', { x: 2, y: 2 }, '#fa527d'],
    ['pixel-art', { x: 1021, y: 1021 }, '#31d7a1'],
  ]) {
    await setMode(mode);
    await setColor(color);
    await setValue('#brush-size', 5);
    await page.locator('#brush-shape').selectOption('square');
    await drawAt(point);
    await assertVisibleColor(point, color, 'tiled/' + mode + '/edge', mode === 'illustration' ? 35 : 20);
  }

  // Undo and redo are checked against the rendered surface, not just history
  // counters: the center of a newly drawn isolated dab must return to baseline.
  await setSymmetry(0);
  await setValue('#brush-size', 9);
  await setColor('#ffffff');
  const historyPoint = { x: 510, y: 510 };
  const historyBaseline = await sampleVisibleExact(historyPoint);
  await drawAt(historyPoint);
  await assertVisibleColor(historyPoint, '#ffffff', 'tiled/history/draw');
  await page.locator('#undo').click();
  await page.waitForTimeout(60);
  assert.deepEqual(await sampleVisibleExact(historyPoint), historyBaseline,
    'undo must restore the same visible pixel that existed before the tiled stroke');
  await page.locator('#redo').click();
  await page.waitForTimeout(60);
  await assertVisibleColor(historyPoint, '#ffffff', 'tiled/history/redo');

  // Repeated short taps can arrive before async tile writes settle. Every tap
  // must become its own visible stroke, not a dropped gesture or uncaught error.
  await setColor('#f5f5f5');
  await setValue('#brush-size', 5);
  const rapidPoints = [{ x: 400, y: 420 }, { x: 420, y: 420 }, { x: 440, y: 420 }, { x: 460, y: 420 }];
  for (const point of rapidPoints) {
    const screen = await screenPoint(point);
    await page.mouse.move(screen.x, screen.y);
    await page.mouse.down();
    await page.mouse.up();
  }
  await page.waitForTimeout(120);
  for (const point of rapidPoints) await assertVisibleColor(point, '#f5f5f5', 'tiled/rapid-tap');

  // Exercise the visible eraser, not only its lower-level raster parity. The
  // eraser must restore the same rendered background sample and participate
  // in undo/redo just like a brush gesture.
  await setMode('pixel-art');
  await setSymmetry(0);
  await page.locator('#brush-tool').click();
  await setColor('#ffffff');
  await setValue('#brush-size', 9);
  await setValue('#brush-hardness', 100);
  await setValue('#brush-opacity', 100);
  const eraserPoint = { x: 560, y: 560 };
  const eraserBaseline = await sampleVisibleExact(eraserPoint);
  await drawAt(eraserPoint);
  await assertVisibleColor(eraserPoint, '#ffffff', 'tiled/eraser/source');
  await page.locator('#eraser-tool').click();
  await drawAt(eraserPoint);
  await page.waitForTimeout(40);
  assert.deepEqual(await sampleVisibleExact(eraserPoint), eraserBaseline,
    'visible eraser must restore the original rendered pixel');
  await page.locator('#undo').click();
  await page.waitForTimeout(40);
  await assertVisibleColor(eraserPoint, '#ffffff', 'tiled/eraser/undo');
  await page.locator('#redo').click();
  await page.waitForTimeout(40);
  assert.deepEqual(await sampleVisibleExact(eraserPoint), eraserBaseline,
    'redo of eraser must restore the original rendered pixel');

  // The tiled document now uses the real editor timeline. Verify frame isolation,
  // independent undo stacks, shared-cel duplication, reorder/delete, onion skin,
  // and sparse persistence through the browser UI.
  await page.locator('#animation-add-frame').click();
  await page.waitForFunction(() => document.querySelector('#animation-frame-count')?.textContent.includes('1 frame'));
  const frame0Point = { x: 650, y: 650 };
  const frame0Baseline = await sampleVisibleExact(frame0Point);
  await setColor('#e84a5f');
  await drawAt(frame0Point);
  await assertVisibleColor(frame0Point, '#e84a5f', 'tiled/timeline/frame-0-paint');

  await page.locator('#animation-add-frame').click();
  await page.waitForFunction(() => document.querySelector('#animation-frame-count')?.textContent.includes('2 frames'));
  assert.equal(await page.locator('.animation-frame').count(), 2);
  const frame1Point = { x: 750, y: 750 };
  const frame1Baseline = await sampleVisibleExact(frame1Point);
  assert.deepEqual(await sampleVisibleExact(frame0Point), frame0Baseline, 'new blank frame must not inherit pixels from frame 0');
  await setColor('#3288ff');
  await drawAt(frame1Point);
  await assertVisibleColor(frame1Point, '#3288ff', 'tiled/timeline/frame-1-paint');
  await page.waitForFunction(() => !document.querySelector('#undo')?.disabled, undefined, { timeout: 8000 });
  await page.locator('#undo').click();
  await page.waitForTimeout(60);
  assert.deepEqual(await sampleVisibleExact(frame1Point), frame1Baseline, 'frame 1 undo must only undo its own stroke');

  await page.locator('.animation-frame').nth(0).click();
  await page.waitForTimeout(60);
  await assertVisibleColor(frame0Point, '#e84a5f', 'tiled/timeline/frame-0-retained');
  await page.locator('#animation-duplicate-frame').click();
  await page.waitForTimeout(60);
  assert.equal(await page.locator('.animation-frame').count(), 3);
  await assertVisibleColor(frame0Point, '#e84a5f', 'tiled/timeline/duplicated-frame');
  await page.locator('#animation-frame-left').click();
  await page.locator('#animation-frame-right').click();
  await page.waitForTimeout(60);
  await page.locator('#animation-delete-frame').click();
  await page.waitForTimeout(60);
  assert.equal(await page.locator('.animation-frame').count(), 2);
  await page.locator('.animation-frame').nth(1).click();
  await page.waitForTimeout(60);
  assert.deepEqual(await sampleVisibleExact(frame0Point), frame0Baseline, 'the original blank frame must remain independent after duplicate/delete');
  await page.locator('.animation-frame').nth(0).click();
  await page.waitForTimeout(60);
  await assertVisibleColor(frame0Point, '#e84a5f', 'tiled/timeline/original-frame-after-delete');
  await page.locator('#animation-onion').check();
  await page.waitForTimeout(40);
  // Wait for the real editor autosave and inspect the payload received by the
  // mock account API. A tiled canvas must persist a tile manifest, not a dense
  // base64 pixel buffer or a legacy project snapshot.
  await page.waitForTimeout(1100);
  const savedTiled = [...savedProjectSnapshots].reverse().find(project => project.format === 'pixelforge-tiled-project');
  assert.ok(savedTiled, 'the editor must autosave the sparse tiled manifest through the account persistence path');
  assert.equal(savedTiled.width, 1024);
  assert.equal(savedTiled.height, 1024);
  assert.equal(savedTiled.layers.length, 1);
  assert.equal(savedTiled.layers[0].authoringMode, 'pixel-art', 'the tiled layer must persist the mode used by the last committed draw/erase operation');
  assert.ok(savedTiled.layers[0].cel, 'each tiled layer must persist its cel manifest');
  assert.ok(!Object.hasOwn(savedTiled.layers[0], 'pixels'),
    'the tiled persistence payload must not contain a full dense layer pixel string');
  assert.equal(savedTiled.animation?.format, 'pixelforge-tiled-animation', 'tiled timeline must persist a sparse animation manifest');
  assert.equal(savedTiled.animation?.frames.length, 2, 'saved timeline must preserve the final frame count');
  assert.ok(!Object.hasOwn(savedTiled.animation.frames[0].cels[0].cel, 'pixels'),
    'tiled animation cels must not serialize full-frame RGBA buffers');

  // Reopen the project through the same account persistence endpoints. The
  // editor must reconstruct the active tiled timeline from the manifest and
  // restore the exact cel contents without a dense animation migration.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.pixelforgeReady === 'true', null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('.animation-frame').length === 2, null, { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#document-size')?.textContent.includes('1024'), null, { timeout: 20000 });
  await page.locator('.animation-frame').nth(1).click();
  await page.waitForTimeout(60);
  assert.deepEqual(await sampleVisibleExact(frame0Point), frame0Baseline,
    'reloaded blank frame must remain independent from the painted first frame');
  await page.locator('.animation-frame').nth(0).click();
  await page.waitForTimeout(60);
  await assertVisibleColor(frame0Point, '#e84a5f', 'tiled/timeline/restored-frame-0');

  // Exercise the actual editor autosave integration: one isolated brush stroke
  // after reload must POST a single-cel patch (not a full project PUT), advance
  // the server revision, and survive another reload from the patched manifest.
  await setMode('pixel-art');
  await setSymmetry(0);
  await setColor('#f0c674');
  // Keep the persisted brush profile unchanged here: this isolates the cel
  // pixel delta from the separate modeOverrides metadata-save path.
  const incrementalPoint = { x: 900, y: 900 };
  const patchCountBeforeIncrementalDraw = receivedCelPatches.length;
  const fullSaveCountBeforeIncrementalDraw = fullSnapshotSaveCount;
  await drawAt(incrementalPoint);
  await assertVisibleColor(incrementalPoint, '#f0c674', 'tiled/incremental-patch/local-draw');
  await page.waitForTimeout(1800);
  assert.ok(receivedCelPatches.length > patchCountBeforeIncrementalDraw,
    'a one-cel drawing edit must reach POST /projects/:id/patches through editor autosave');
  assert.equal(fullSnapshotSaveCount, fullSaveCountBeforeIncrementalDraw,
    'an eligible single-cel edit must not fall back to a full-project PUT');
  const incrementalPatch = receivedCelPatches.at(-1);
  assert.equal(incrementalPatch.format, 'pixelforge-cel-patch');
  assert.equal(incrementalPatch.frameId, savedProjectSnapshots.at(-1).animation.frames[0].id);
  assert.ok(incrementalPatch.operations.some(operation => operation.type === 'tile.put'),
    'the brush edit must be encoded as a tile.put operation');
  const patchedSnapshot = [...savedProjectSnapshots].reverse().find(project => project.id === savedTiled.id);
  assert.ok(patchedSnapshot.serverRevision >= 2, 'successful cel patch must advance the server revision');
  const patchedFrame = patchedSnapshot.animation.frames.find(item => item.id === incrementalPatch.frameId);
  const patchedCel = patchedFrame.cels.find(item => item.layerId === incrementalPatch.layerId).cel;
  assert.ok(patchedCel.tiles.some(tile => tile.sha256 === incrementalPatch.operations.find(operation => operation.type === 'tile.put').sha256),
    'the patch receiver must persist the exact changed tile in the animation cel');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.pixelforgeReady === 'true', null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('.animation-frame').length === 2, null, { timeout: 20000 });
  await page.locator('.animation-frame').nth(0).click();
  await page.waitForTimeout(80);
  await assertVisibleColor(incrementalPoint, '#f0c674', 'tiled/incremental-patch/reloaded-pixel');

  // Export the actual high-resolution tiled editor document through the normal
  // project ZIP action, then validate the native package and import it back
  // through the visible editor. This must preserve sparse tiles, animation,
  // drawing modes and per-pixel ownership without a dense RGBA conversion.
  const [tiledPackageDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#export-project').click(),
  ]);
  const tiledPackagePath = path.join(artifactDir, tiledPackageDownload.suggestedFilename());
  await tiledPackageDownload.saveAs(tiledPackagePath);
  const tiledPackageBytes = await fs.promises.readFile(tiledPackagePath);
  const tiledPackage = await importPixelForgeCodeLabPackage(new Blob([tiledPackageBytes]));
  assert.equal(tiledPackage.project.format, 'pixelforge-tiled-project',
    'the editor ZIP export must retain the native sparse tiled project format');
  assert.equal(tiledPackage.project.width, 1024);
  assert.equal(tiledPackage.project.height, 1024);
  assert.equal(tiledPackage.project.animation.format, 'pixelforge-tiled-animation');
  assert.equal(tiledPackage.project.animation.frames.length, 2);
  assert.ok(!Object.hasOwn(tiledPackage.project.layers[0], 'pixels'),
    'native tiled package must not materialize a dense full-layer RGBA buffer');
  assert.ok(tiledPackage.project.layers[0].cel.tiles.length > 0,
    'native package must contain the layer sparse tile manifest');
  const packageDocument = await TiledRasterProjectDocument.fromManifest(tiledPackage.project);
  const packageAnimation = await TiledAnimationDocument.fromManifest(tiledPackage.project.animation, { store: packageDocument.tileStore });
  assert.deepEqual(packageAnimation.readRegion(0, incrementalPatch.layerId, { x: incrementalPoint.x, y: incrementalPoint.y, width: 1, height: 1 }),
    new Uint8ClampedArray([240, 198, 116, 255]),
    'native package must retain the incremental patch pixel in its animation cel');
  assert.equal(packageAnimation.getLayerMetadata(0, incrementalPatch.layerId).authoringMode, 'pixel-art',
    'native package must retain per-cel authoring mode metadata');
  const packageMode = packageAnimation.getLayerMetadata(0, incrementalPatch.layerId).authoringMode;
  const packageOwnershipTileCount = tiledPackage.project.animation.frames[0].cels[0].cel.ownershipTiles.length;
  assert.ok(packageOwnershipTileCount > 0,
    'native package must retain the sparse mixed-style ownership plane in the cel manifest');
  packageAnimation.dispose();
  packageDocument.dispose();

  await page.locator('#import-file').setInputFiles(tiledPackagePath);
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Import complete and saved'), null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#document-size')?.textContent.includes('1024 × 1024') &&
    document.querySelectorAll('.animation-frame').length === 2, null, { timeout: 20000 });
  await page.locator('.animation-frame').nth(0).click();
  await page.waitForTimeout(80);
  await assertVisibleColor(incrementalPoint, '#f0c674', 'tiled/package-import/reloaded-pixel');
  const reimportedSnapshot = [...savedProjectSnapshots].reverse().find(project =>
    project.format === 'pixelforge-tiled-project' && project.id !== savedTiled.id);
  assert.ok(reimportedSnapshot, 'importing the exported tiled ZIP must persist a new native project');
  assert.equal(reimportedSnapshot.animation.frames.length, 2);
  assert.ok(reimportedSnapshot.animation.frames[0].cels[0].cel.ownershipTiles.length > 0,
    'imported project persistence must retain ownership tiles');

  await fs.promises.writeFile(path.join(artifactDir, 'tiled-package-roundtrip-evidence.json'), JSON.stringify({
    format: tiledPackage.project.format,
    width: tiledPackage.project.width,
    height: tiledPackage.project.height,
    layers: tiledPackage.project.layers.length,
    frames: tiledPackage.project.animation.frames.length,
    mode: packageMode,
    ownershipTileCount: packageOwnershipTileCount,
    reimportedOwnershipTileCount: reimportedSnapshot.animation.frames[0].cels[0].cel.ownershipTiles.length,
    reimportedProjectId: reimportedSnapshot.id,
    pixel: { point: incrementalPoint, rgba: [240, 198, 116, 255] },
  }, null, 2));

  await fs.promises.writeFile(path.join(artifactDir, 'cel-patch-persistence-evidence.json'), JSON.stringify({
    patchCount: receivedCelPatches.length,
    operationId: incrementalPatch.operationId,
    baseRevision: incrementalPatch.baseRevision,
    persistedServerRevision: patchedSnapshot.serverRevision,
    operations: incrementalPatch.operations.map(operation => ({ type: operation.type, x: operation.x, y: operation.y, sha256: operation.sha256 })),
    reloadedPixel: { point: incrementalPoint, color: '#f0c674' },
  }, null, 2));
  await fs.promises.writeFile(path.join(artifactDir, 'tiled-visual-matrix.json'), JSON.stringify(tiledMatrix, null, 2));
  await fs.promises.writeFile(path.join(artifactDir, 'visual-matrix.json'), JSON.stringify({ matrix, interpolationEvidence, tiledMatrix }, null, 2));
  await page.close();
});
