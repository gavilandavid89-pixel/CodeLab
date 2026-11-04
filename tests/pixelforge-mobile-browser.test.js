const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const base = process.env.CODELAB_E2E_BASE_URL || 'http://127.0.0.1:3188';
const dataDir = process.env.CODELAB_DATA_DIR || path.join(__dirname, '..', 'data');
const sessionId = 'd'.repeat(48);
const sessionsDir = path.join(dataDir, 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });
fs.writeFileSync(path.join(sessionsDir, sessionId + '.json'), JSON.stringify({
  id: sessionId,
  user: { id: 'pixelforge-mobile-ui-user', provider: 'github', name: 'PIXELFORGE_MOBILE_TEST', role: 'user' },
  createdAt: Date.now(),
  expiresAt: Date.now() + 60 * 60 * 1000
}), { mode: 0o600 });

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const viewport of [
      { width: 390, height: 844, label: 'mobile portrait' },
      { width: 320, height: 640, label: 'narrow mobile' },
      { width: 667, height: 375, label: 'mobile landscape' },
      { width: 1280, height: 800, label: 'desktop' }
    ]) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      await context.addCookies([{ name: 'codelab_sid', value: sessionId, url: base }]);
      const page = await context.newPage();
      const pageErrors = [];
      const consoleErrors = [];
      const failedResponses = [];
      const pendingRequests = new Map();
      page.on('pageerror', error => pageErrors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
      page.on('response', response => { if (response.status() >= 400) failedResponses.push({ url: response.url(), status: response.status() }); });
      page.on('request', request => pendingRequests.set(request.url(), request.method()));
      page.on('requestfinished', request => pendingRequests.delete(request.url()));
      page.on('requestfailed', request => pendingRequests.delete(request.url()));
      await page.goto(base + '/pixelforge/index.html', { waitUntil: 'networkidle' });
      const authResponse = await page.request.get(base + '/api/auth/status');
      const authStatus = await authResponse.json();
      const projectListResponse = await page.request.get(base + '/api/pixelforge/projects', { timeout: 5000 });
      const projectListBody = await projectListResponse.text();
      assert.ok(authStatus.user, viewport.label + ': the test session must be accepted by /api/auth/status; got ' + JSON.stringify(authStatus));
      try {
        await page.waitForFunction(() => {
          const status = document.querySelector('#status')?.textContent || '';
          return status.includes('tus proyectos se guardan') || status.includes('Proyecto recuperado de tu cuenta');
        }, null, { timeout: 15000 });
      } catch (error) {
        const diagnostics = await page.evaluate(() => ({
          status: document.querySelector('#status')?.textContent || null,
          bodyText: document.body.innerText.slice(0, 1200),
          canvasCount: document.querySelectorAll('#canvas').length
        }));
        throw new Error(viewport.label + ': PixelForge boot did not reach ready state; diagnostics=' +
          JSON.stringify({ authUser: authStatus.user, projectListStatus: projectListResponse.status(),
            projectListBody: projectListBody.slice(0, 500), diagnostics, pageErrors, consoleErrors,
            failedResponses, pendingRequests: [...pendingRequests.entries()] }) + '; cause=' + error.message);
      }

      assert.equal(await page.locator('#files-tab').isVisible(), true, viewport.label + ': Files tab should be visible');
      await page.locator('#files-tab').click();
      assert.equal(await page.locator('.files-section').evaluate(node => getComputedStyle(node).display !== 'none'), true,
        viewport.label + ': Files panel should be revealed');
      assert.equal(await page.locator('label[for="import-file"]').isVisible(), true,
        viewport.label + ': image/project import control should be visible');
      assert.equal(await page.locator('#export-project').isVisible(), true,
        viewport.label + ': editable project export should be visible');
      assert.equal(await page.locator('#export-sprite-sheet').isVisible(), true,
        viewport.label + ': sprite-sheet export should be visible');

      await page.locator('#layers-tab').click();
      assert.equal(await page.locator('.layer-section').evaluate(node => getComputedStyle(node).display !== 'none'), true,
        viewport.label + ': Layers panel should be reachable');
      await page.locator('#ai-tab').click();
      assert.equal(await page.locator('#ai-workspace-panel').evaluate(node => getComputedStyle(node).display !== 'none'), true,
        viewport.label + ': AI workspace should be reachable');
      await page.locator('#properties-tab').click();
      assert.equal(await page.locator('.inspector-section').first().evaluate(node => getComputedStyle(node).display !== 'none'), true,
        viewport.label + ': Properties panel should be reachable');

      if (viewport.label === 'desktop') {
        // Exercise the real editor, not just the timeline's static markup.
        const projectName = 'PixelForge animation E2E ' + Date.now();
        await page.locator('#new-document').click();
        await page.locator('#new-name').fill(projectName);
        await page.locator('#new-width').fill('32');
        await page.locator('#new-height').fill('32');
        await page.locator('#create-new').click();
        await page.waitForFunction(name => document.querySelector('#document-name')?.textContent === name, projectName);
        const saveResponse = async () => {
          const responsePromise = page.waitForResponse(response =>
            response.url().includes('/api/pixelforge/projects') &&
            response.request().method() === 'PUT' && response.status() === 200, { timeout: 10000 });
          await page.locator('#save').click();
          await responsePromise;
        };
        await saveResponse();

        // First click creates the timeline around the current raster document.
        await page.locator('#animation-add-frame').click();
        assert.equal(await page.locator('#animation-frames .animation-frame').count(), 1,
          'starting the timeline must preserve the current artwork as frame 1');

        const canvasBox = await page.locator('#canvas').boundingBox();
        assert.ok(canvasBox && canvasBox.width > 0 && canvasBox.height > 0, 'the raster canvas must be visible');
        const drawAtCenter = async color => {
          await page.locator('#color').evaluate((node, value) => {
            node.value = value;
            node.dispatchEvent(new Event('input', { bubbles: true }));
          }, color);
          await page.locator('#canvas').click({
            position: { x: Math.floor(canvasBox.width / 2), y: Math.floor(canvasBox.height / 2) }
          });
        };
        await drawAtCenter('#ff3030');

        // A blank frame must not inherit frame 1's pixels.
        await page.locator('#animation-add-frame').click();
        assert.equal(await page.locator('#animation-frames .animation-frame').count(), 2,
          'adding a frame must create a second timeline item');
        await drawAtCenter('#3080ff');

        // Switching back and forth must restore the independent raster cel.
        await page.locator('#animation-frames .animation-frame').nth(0).click();
        await page.locator('#animation-frames .animation-frame').nth(1).click();
        await page.locator('#animation-fps').evaluate(node => {
          node.value = '24'; node.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.locator('#animation-duration').evaluate(node => {
          node.value = '120'; node.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.locator('#animation-loop').uncheck();
        await page.locator('#animation-onion').check();
        await page.waitForTimeout(80);
        await page.locator('#animation-onion').uncheck();

        // Playback must start and stop through the visible controls.
        await page.locator('#animation-play').click();
        await page.waitForFunction(() => !document.querySelector('#animation-stop')?.disabled,
          null, { timeout: 3000 });
        await page.locator('#animation-stop').click();
        await page.waitForFunction(() => document.querySelector('#animation-stop')?.disabled);

        // Both outputs are generated from the actual frame cels.
        const pngDownloadPromise = page.waitForEvent('download');
        const manifestDownloadPromise = page.waitForEvent('download');
        await page.locator('#animation-export-sheet').click();
        const [pngDownload, manifestDownload] = await Promise.all([pngDownloadPromise, manifestDownloadPromise]);
        assert.match(pngDownload.suggestedFilename(), /-animation\.png$/);
        assert.match(manifestDownload.suggestedFilename(), /-animation\.json$/);

        await saveResponse();
        const projectListResponse = await page.request.get(base + '/api/pixelforge/projects');
        assert.equal(projectListResponse.status(), 200, 'saved projects must remain available through the account API');
        const projectList = await projectListResponse.json();
        const savedSummary = projectList.projects.find(item => item.name === projectName);
        assert.ok(savedSummary, 'the animation project must appear in the CodeLab account project list');
        const projectResponse = await page.request.get(base + '/api/pixelforge/projects/' + encodeURIComponent(savedSummary.id));
        assert.equal(projectResponse.status(), 200, 'the saved animation project must be readable through the account API');
        const savedBody = await projectResponse.json();
        const savedProject = savedBody.project;
        assert.equal(savedProject.animation?.frames?.length, 2, 'both animation frames must persist');
        assert.equal(savedProject.animation?.fps, 24, 'the selected FPS must persist');
        assert.equal(savedProject.animation?.loop, false, 'the loop setting must persist');
        assert.equal(savedProject.animation?.frames?.[1]?.durationMs, 120, 'the active frame duration must persist');
        const framePixels = savedProject.animation.frames.map(frame => {
          const cel = frame.cels.find(item => item.layerId === savedProject.layers[0].id);
          assert.ok(cel && typeof cel.pixels === 'string', 'each frame must persist one cel for the raster layer');
          return Buffer.from(cel.pixels, 'base64');
        });
        assert.ok(framePixels[0].some(value => value !== 0), 'drawing on frame 1 must change its persisted pixels');
        assert.ok(framePixels[1].some(value => value !== 0), 'drawing on frame 2 must change its persisted pixels');
        assert.notDeepEqual(framePixels[0], framePixels[1], 'frame 1 and frame 2 must retain independent pixel buffers');
      }

      if (viewport.width <= 420) {
        const headerOverflow = await page.locator('.topbar').evaluate(node => node.scrollWidth > node.clientWidth + 1);
        assert.equal(headerOverflow, false, viewport.label + ': topbar must fit without horizontal overflow');
        const contextOverflow = await page.locator('.contextbar').evaluate(node => node.scrollWidth > node.clientWidth + 1);
        assert.equal(contextOverflow, false, viewport.label + ': context toolbar must fit without horizontal overflow');
      }
      if (viewport.label === 'mobile landscape') {
        assert.equal(await page.locator('.bottom-bar').evaluate(node => getComputedStyle(node).display), 'none',
          'short landscape layout should hide the secondary footer');
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  process.stdout.write('PixelForge mobile/desktop browser layout checks passed.\n');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
