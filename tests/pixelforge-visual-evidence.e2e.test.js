const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const http = require('node:http');

const BASE_URL = process.env.CODELAB_E2E_BASE_URL || 'http://127.0.0.1:3188';
const ARTIFACT_DIR = process.env.HEADLESS_VISUAL_ARTIFACT_DIR || path.join(os.tmpdir(), 'codelab-visual-evidence');
const EXPECTED_FRAMES = 60;
const EXPECTED_VIDEO_SECONDS = 5;

(async () => {
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const visualDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codelab-visual-server-'));
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), CODELAB_DATA_DIR: visualDataDir, PIXELFORGE_GUEST_MODE: 'true' },
    stdio: ['ignore','ignore','pipe']
  });
  const visualBase = 'http://127.0.0.1:' + port;
  let healthy = false;
  for (let i=0;i<60;i++) {
    try { const h=await fetch(visualBase+'/api/health'); if(h.ok){ healthy=true; break; } }
    catch {}
    await new Promise(r=>setTimeout(r,100));
  }
  assert.ok(healthy, 'visual CodeLab server did not become healthy');

  const browser = await chromium.launch({ headless: true });
  const videoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pixelforge-visual-video-'));
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    recordVideo: { dir: videoDir, size: { width: 1440, height: 960 }, fps: 24 }
  });
  const page = await context.newPage();
  const errors = [];
  const consoleErrors = [];
  const requestFailures = [];
  const dataDir = process.env.CODELAB_DATA_DIR || path.join(__dirname, '..', 'data');
  await fs.mkdir(path.join(dataDir, 'sessions'), { recursive: true });
  const sessionId = 'a'.repeat(48);
  await fs.writeFile(path.join(dataDir, 'sessions', sessionId + '.json'), JSON.stringify({
    id: sessionId,
    user: { id: 'pixelforge-visual-user', provider: 'github', name: 'PIXELFORGE_VISUAL_TEST', role: 'user' },
    createdAt: Date.now(), expiresAt: Date.now() + 10 * 60 * 1000
  }), { mode: 0o600 });
  page.on('pageerror', e => errors.push(String(e.stack || e.message || e)));
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('requestfailed', req => requestFailures.push(`${req.method()} ${req.url()} :: ${req.failure()?.errorText || 'failed'}`));

  try {
    // Use capture=1 for layout only. capture=video starts playback during boot,
    // which can finish before this test reaches its explicit playback assertion.
    await page.goto(visualBase + '/pixelforge/index.html?createDemo=walk-crouch-24&capture=1', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('#canvas').waitFor({ state: 'visible', timeout: 30000 });
    await page.locator('#animation-frame-count').waitFor({ state: 'visible', timeout: 30000 });
    try {
      await page.waitForFunction(() => /\d+ frames/.test(document.getElementById('animation-frame-count')?.textContent || ''), null, { timeout: 30000 });
    } catch (error) {
      const diagnostic = await page.evaluate(() => ({
        frameCountText: document.getElementById('animation-frame-count')?.textContent || '',
        status: document.getElementById('status')?.textContent || '',
        captureState: document.documentElement.dataset.pixelforgeCapture || '',
        captureError: document.documentElement.dataset.pixelforgeCaptureError || '',
      }));
      throw new Error(`animation boot did not expose a frame count: ${JSON.stringify(diagnostic)}; pageErrors=${JSON.stringify(errors)}; consoleErrors=${JSON.stringify(consoleErrors)}; requestFailures=${JSON.stringify(requestFailures)}; cause=${error.message}`);
    }
    await page.locator('#animation-frames .animation-frame').first().waitFor({ state: 'visible', timeout: 30000 });

    const layers = await page.locator('#layer-count').innerText();
    const frames = await page.locator('#animation-frames .animation-frame').count();
    assert.equal(frames, EXPECTED_FRAMES, `visual showcase must expose exactly ${EXPECTED_FRAMES} frames`);
    assert.match(layers, /[2-9]|1[0-9]/, 'visual showcase must render multiple layers');

    const canvas = page.locator('#canvas');
    const before = await canvas.screenshot({ type: 'png', path: path.join(ARTIFACT_DIR, 'polished-drawing.png') });
    const rasterStats = await canvas.evaluate(node => {
      const ctx = node.getContext('2d'); const d = ctx.getImageData(0, 0, node.width, node.height).data;
      let opaque = 0, checksum = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 8) opaque++;
        checksum = (checksum + d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7 + d[i + 3]) % 1000000007;
      }
      const colors = new Set();
      for (let i = 0; i < d.length; i += 4) if (d[i+3] > 8) colors.add(`${d[i]},${d[i+1]},${d[i+2]}`);
      return { width: node.width, height: node.height, opaque, checksum, colors: colors.size };
    });
    assert.ok(before.length > 5000, 'drawing screenshot must contain visual evidence');
    assert.ok(rasterStats.opaque > 1500, 'drawing must not be an almost-empty canvas');
    assert.ok(rasterStats.colors >= 8, 'drawing must contain a meaningful palette, not a single flat color');

    await page.locator('#animation-play').click();
    // The animation loops, so checking only one frame after the full duration can
    // legitimately land on a visually identical frame. Observe playback while it
    // is running and require at least one rendered frame to differ from the baseline.
    const playbackStartedAt = Date.now();
    let playbackChanged = false;
    let observedChecksum = rasterStats.checksum;
    for (let sample = 0; sample < 20; sample++) {
      await page.waitForTimeout(100);
      observedChecksum = await canvas.evaluate(node => {
        const ctx = node.getContext('2d'); const d = ctx.getImageData(0, 0, node.width, node.height).data;
        let checksum = 0;
        for (let i = 0; i < d.length; i += 4) checksum = (checksum + d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7 + d[i + 3]) % 1000000007;
        return checksum;
      });
      if (observedChecksum !== rasterStats.checksum) {
        playbackChanged = true;
        break;
      }
    }
    // Still keep the full recording window so the artifact contains the complete
    // five-second playback rather than stopping after the first changed frame.
    const remainingPlaybackMs = Math.max(0, EXPECTED_VIDEO_SECONDS * 1000 + 350 - (Date.now() - playbackStartedAt));
    if (remainingPlaybackMs) await page.waitForTimeout(remainingPlaybackMs);
    await canvas.screenshot({ type: 'png', path: path.join(ARTIFACT_DIR, 'animation-frame-playback.png') });
    assert.ok(playbackChanged, 'playback must visibly change the rendered frame');
    assert.deepEqual(errors, []);

    const video = page.video();
    await page.close();
    await context.close();
    const videoPath = await video.path();
    const videoBytes = await fs.readFile(videoPath);
    assert.ok(videoBytes.length > 20000, 'visual animation recording must contain substantial video data');
    await fs.copyFile(videoPath, path.join(ARTIFACT_DIR, 'polished-animation.webm'));
  } finally {
    await browser.close().catch(() => {});
    await fs.rm(videoDir, { recursive: true, force: true });
    server.kill('SIGTERM'); await fs.rm(visualDataDir, { recursive: true, force: true });
  }
  console.log(`Visual PixelForge evidence passed: ${EXPECTED_FRAMES}-frame reference-guided animation, full ${EXPECTED_VIDEO_SECONDS}s playback and WebM captured.`);
})();