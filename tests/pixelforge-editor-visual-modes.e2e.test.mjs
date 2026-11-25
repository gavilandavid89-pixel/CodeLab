import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chromium from '@sparticuz/chromium';
import { chromium as playwrightChromium } from 'playwright-core';

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
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/api/pixelforge/mode') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ guestMode: true }));
      return;
    }
    if (url.pathname === '/api/pixelforge/projects') {
      if (request.method === 'PUT') {
        let body = '';
        for await (const chunk of request) body += chunk;
        let project = {};
        try { project = JSON.parse(body).project || {}; } catch {}
        savedProjectSnapshots.push(structuredClone(project));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ project: { ...project, serverRevision: 1 } }));
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ projects: [] }));
      }
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
  const assertVisibleColor = async (point, hex, label) => {
    await screenPoint(point);
    const readout = await page.locator('#coordinate-readout').textContent();
    assert.equal(readout, 'x: ' + point.x + ' · y: ' + point.y,
      'screen-to-document mapping must identify the same pixel being visually sampled for ' + label);
    const sampled = await sampleVisible(point, hex);
    const actual = sampled.rgba;
    const expected = expectedRgb(hex);
    const channelError = actual.slice(0, 3).map((value, index) => Math.abs(value - expected[index]));
    if (!channelError.every(error => error <= 20)) {
      await page.locator('#canvas').screenshot({ path: path.join(artifactDir, 'failure-' + label.replace(/[^a-z0-9-]/gi, '-') + '.png') });
      await fs.promises.writeFile(path.join(artifactDir, 'failure-details.json'), JSON.stringify({ label, point, expected, actual, sampled, readout }, null, 2));
    }
    assert.ok(channelError.every(error => error <= 20),
      label + ' must be visibly rendered near document pixel ' + point.x + ',' + point.y +
      '; expected RGB ' + expected.join(',') + ', got ' + actual.slice(0, 3).join(','));
    assert.equal(actual[3], 255, label + ' must be opaque on the visible editor surface');
  };

  // Verify real mode-specific defaults and per-mode custom profile restoration.
  await setMode('illustration');
  assert.equal(await page.locator('#brush-size').inputValue(), '5');
  assert.equal(await page.locator('#brush-shape').inputValue(), 'circle');
  assert.equal(await page.locator('#brush-hardness').inputValue(), '55');
  await setValue('#brush-size', 9);
  await setValue('#brush-hardness', 71);
  await setValue('#brush-opacity', 82);
  await setMode('pixel-art');
  assert.equal(await page.locator('#brush-size').inputValue(), '1');
  assert.equal(await page.locator('#brush-shape').inputValue(), 'square');
  assert.equal(await page.locator('#brush-hardness').inputValue(), '100');
  await setValue('#brush-size', 2);
  await setValue('#brush-opacity', 64);
  await setMode('illustration');
  assert.equal(await page.locator('#brush-size').inputValue(), '9', 'illustration custom size must survive a round trip');
  assert.equal(await page.locator('#brush-hardness').inputValue(), '71', 'illustration hardness must be restored');
  assert.equal(await page.locator('#brush-opacity').inputValue(), '82', 'illustration opacity must be restored');
  await setMode('pixel-art');
  assert.equal(await page.locator('#brush-size').inputValue(), '2', 'pixel-art custom size must survive a round trip');
  assert.equal(await page.locator('#brush-opacity').inputValue(), '64', 'pixel-art opacity must be restored');

  const matrix = [];
  for (const mode of ['illustration', 'pixel-art']) {
    await setMode(mode);
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
          await assertVisibleColor(visiblePoint, color, 'tiled/' + mode + '/' + shape + '/symmetry-' + symmetry);
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
    ['illustration', { x: 0, y: 0 }, '#fa527d'],
    ['pixel-art', { x: 1023, y: 1023 }, '#31d7a1'],
  ]) {
    await setMode(mode);
    await setColor(color);
    await setValue('#brush-size', 1);
    await page.locator('#brush-shape').selectOption('square');
    await drawAt(point);
    await assertVisibleColor(point, color, 'tiled/' + mode + '/edge');
  }

  // Undo and redo are checked against the rendered surface, not just history
  // counters: the center of a newly drawn isolated dab must return to baseline.
  await setSymmetry(0);
  await setValue('#brush-size', 1);
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
  await setValue('#brush-size', 1);
  const rapidPoints = [{ x: 400, y: 420 }, { x: 420, y: 420 }, { x: 440, y: 420 }, { x: 460, y: 420 }];
  for (const point of rapidPoints) {
    const screen = await screenPoint(point);
    await page.mouse.move(screen.x, screen.y);
    await page.mouse.down();
    await page.mouse.up();
  }
  await page.waitForTimeout(120);
  for (const point of rapidPoints) await assertVisibleColor(point, '#f5f5f5', 'tiled/rapid-tap');

  // Wait for the real editor autosave and inspect the payload received by the
  // mock account API. A tiled canvas must persist a tile manifest, not a dense
  // base64 pixel buffer or a legacy project snapshot.
  await page.waitForTimeout(1100);
  const savedTiled = [...savedProjectSnapshots].reverse().find(project => project.format === 'pixelforge-tiled-project');
  assert.ok(savedTiled, 'the editor must autosave the sparse tiled manifest through the account persistence path');
  assert.equal(savedTiled.width, 1024);
  assert.equal(savedTiled.height, 1024);
  assert.equal(savedTiled.layers.length, 1);
  assert.ok(savedTiled.layers[0].cel, 'each tiled layer must persist its cel manifest');
  assert.ok(!Object.hasOwn(savedTiled.layers[0], 'pixels'),
    'the tiled persistence payload must not contain a full dense layer pixel string');

  await fs.promises.writeFile(path.join(artifactDir, 'tiled-visual-matrix.json'), JSON.stringify(tiledMatrix, null, 2));
  await fs.promises.writeFile(path.join(artifactDir, 'visual-matrix.json'), JSON.stringify({ matrix, interpolationEvidence, tiledMatrix }, null, 2));
  await page.close();
});
