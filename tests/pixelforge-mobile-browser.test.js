const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');


async function readZipDownload(download) {
  const { readStoredZip } = await import('../public/pixelforge/src/video-composer-core.mjs');
  const archivePath = await download.path();
  return readStoredZip(new Blob([fs.readFileSync(archivePath)]));
}

const base = process.env.CODELAB_E2E_BASE_URL || 'http://127.0.0.1:3188';
const dataDir = process.env.CODELAB_DATA_DIR || path.join(__dirname, '..', 'data');
const sessionId = 'd'.repeat(48);
const sessionsDir = path.join(dataDir, 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });
fs.writeFileSync(path.join(sessionsDir, sessionId + '.json'), JSON.stringify({
  id: sessionId,
  user: { id: 'pixelforge-mobile-ui-user', provider: 'local', name: 'PIXELFORGE_MOBILE_TEST', role: 'user' },
  createdAt: Date.now(),
  expiresAt: Date.now() + 60 * 60 * 1000
}), { mode: 0o600 });

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const viewport of [
      { width: 390, height: 844, label: 'mobile portrait', mobile: true },
      { width: 320, height: 640, label: 'narrow mobile', mobile: true },
      { width: 667, height: 375, label: 'mobile landscape', mobile: true },
      { width: 720, height: 1600, label: '720x1600 mobile target', mobile: true },
      { width: 1280, height: 800, label: 'desktop' }
    ]) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, isMobile: !!viewport.mobile, hasTouch: !!viewport.mobile, deviceScaleFactor: viewport.mobile ? 1 : undefined });
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
            response.request().method() === 'PUT' && response.ok(), { timeout: 10000 });
          await page.locator('#save').click();
          await responsePromise;
        };
        await saveResponse();

        // First click creates the timeline around the current raster document.
        await page.locator('#animation-add-frame').click();
        assert.equal(await page.locator('#animation-frames .animation-frame').count(), 1,
          'starting the timeline must preserve the current artwork as frame 1');

        const guideToggle = page.locator('#reference-guides-toggle');
        assert.equal(await guideToggle.getAttribute('aria-pressed'), 'false', 'coordinate guides start hidden');
        await guideToggle.click();
        assert.equal(await guideToggle.getAttribute('aria-pressed'), 'true', 'coordinate guides can be enabled');
        assert.match(await guideToggle.textContent(), /Guides: On/);
        await guideToggle.click();
        assert.equal(await guideToggle.getAttribute('aria-pressed'), 'false', 'coordinate guides can be disabled without changing artwork');

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

        // Add a second raster layer inside the active timeline. Editing it must
        // not overwrite the original layer's cel in this same frame.
        await page.locator('#layers-tab').click();
        await page.locator('#add-layer').click();
        await drawAtCenter('#00cc88');

        // A blank frame must not inherit either layer's pixels from frame 1.
        await page.locator('#animation-add-frame').click();
        assert.equal(await page.locator('#animation-frames .animation-frame').count(), 2,
          'adding a frame must create exactly one additional timeline item');
        await drawAtCenter('#3080ff');

        // Switching back and forth must restore independent cels per layer.
        await page.locator('#animation-frames .animation-frame').nth(0).click();
        await page.locator('#animation-frames .animation-frame').nth(1).click();
        await page.locator('#animation-fps').evaluate(node => {
          node.value = '24'; node.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.locator('#animation-duration').evaluate(node => {
          node.value = '120'; node.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.locator('#animation-onion').check();
        await page.waitForTimeout(80);
        await page.locator('#animation-onion').uncheck();

        // Playback must start and stop through the visible controls.
        await page.locator('#animation-play').click();
        await page.waitForFunction(() => !document.querySelector('#animation-stop')?.disabled,
          null, { timeout: 3000 });
        await page.locator('#animation-stop').click();
        await page.waitForFunction(() => document.querySelector('#animation-stop')?.disabled);
        await page.locator('#animation-frames .animation-frame').nth(1).click();
        await page.locator('#animation-loop').uncheck();

        // The animation sprite sheet and manifest are delivered as one ZIP file.
        const animationZipPromise = page.waitForEvent('download');
        await page.locator('#animation-export-sheet').click();
        const animationZipDownload = await animationZipPromise;
        assert.match(animationZipDownload.suggestedFilename(), /-animation-sheet\.zip$/);
        const animationZipEntries = await readZipDownload(animationZipDownload);
        assert.ok(animationZipEntries.has('animation-manifest.json'));

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
        assert.equal(savedProject.animation.layerIds.length, 2, 'the timeline must preserve both raster layers');
        assert.ok(savedProject.animation.frames.every(frame => frame.cels.length === savedProject.layers.length),
          'every frame must persist an independent cel for every raster layer');
        const pixelsFor = (frame, layer) => {
          const cel = frame.cels.find(item => item.layerId === layer.id);
          assert.ok(cel && typeof cel.pixels === 'string', 'each frame/layer pair must persist its own cel');
          return Buffer.from(cel.pixels, 'base64');
        };
        const baseFirst = pixelsFor(savedProject.animation.frames[0], savedProject.layers[0]);
        const baseSecond = pixelsFor(savedProject.animation.frames[1], savedProject.layers[0]);
        const overlayFirst = pixelsFor(savedProject.animation.frames[0], savedProject.layers[1]);
        const overlaySecond = pixelsFor(savedProject.animation.frames[1], savedProject.layers[1]);
        assert.ok(baseFirst.some(value => value !== 0), 'drawing on the base layer must persist in frame 1');
        assert.equal(baseSecond.some(value => value !== 0), false, 'drawing on the overlay must not modify the base layer in frame 2');
        assert.ok(overlayFirst.some(value => value !== 0), 'drawing on the overlay must persist in frame 1');
        assert.ok(overlaySecond.some(value => value !== 0), 'drawing on the overlay must persist in frame 2');
        assert.notDeepEqual(overlayFirst, overlaySecond, 'the same layer must retain independent pixel buffers across frames');

        // Cross-mode proof: the Headless runtime opens the exact project just created by the visual editor.
        const headlessResult = await page.evaluate(async projectId => {
          const bridge = await import('/pixelforge/src/headless-bridge.js');
          const proposal = await bridge.preparePixelForgeProposal({
            projectId,
            summary: 'Headless adds a raster mark and a third animation frame',
            actions: [
              { name: 'canvas.draw_line', x0: 2, y0: 2, x1: 8, y1: 2, color: '#16C784', size: 2 },
              { name: 'animation.frame.capture_document', durationMs: 150, frameName: 'Headless pose' },
              { name: 'animation.frame.set_active', index: 2 },
              { name: 'animation.set_fps', fps: 18 },
              { name: 'animation.set_loop', loop: false },
              { name: 'animation.frame.set_duration', index: 2, durationMs: 150 }
            ]
          });
          if (proposal.status !== 'proposal') throw new Error('Headless did not create an isolated review proposal: ' + JSON.stringify(proposal));
          const beforeApproval = await (await fetch('/api/pixelforge/projects/' + encodeURIComponent(projectId))).json();
          if (beforeApproval.project.animation.frames.length !== 2) throw new Error('Headless wrote before explicit approval.');
          const accepted = await bridge.acceptPixelForgeProposal({ sessionId: proposal.sessionId, approved: true });
          if (accepted.status !== 'saved') throw new Error('Headless approval did not persist: ' + JSON.stringify(accepted));
          const afterApproval = await (await fetch('/api/pixelforge/projects/' + encodeURIComponent(projectId))).json();
          return {
            proposalStatus: proposal.status,
            changedPixels: proposal.diff.changedPixels,
            acceptedStatus: accepted.status,
            serverRevision: afterApproval.project.serverRevision,
            animation: afterApproval.project.animation,
            rasterPixels: afterApproval.project.layers.find(layer => layer.id === beforeApproval.project.layers[1].id).pixels,
            headlessFramePixels: afterApproval.project.animation.frames[2].cels.find(cel => cel.layerId === beforeApproval.project.layers[1].id).pixels
          };
        }, savedSummary.id);
        assert.equal(headlessResult.proposalStatus, 'proposal', 'Headless must produce a reviewable proposal from the visual project');
        assert.ok(headlessResult.changedPixels > 0, 'Headless raster drawing must produce a visible pixel diff');
        assert.equal(headlessResult.acceptedStatus, 'saved', 'explicit approval must persist the Headless proposal');
        assert.equal(headlessResult.animation.frames.length, 3, 'Headless must add a third frame to the visual editor timeline');
        assert.equal(headlessResult.animation.fps, 18, 'Headless animation timing changes must persist');
        assert.equal(headlessResult.animation.loop, false, 'Headless loop changes must persist');
        assert.equal(headlessResult.animation.frames[2].durationMs, 150, 'Headless frame duration must persist');
        const savedRaster = Buffer.from(savedProject.layers[1].pixels, 'base64');
        const headlessRaster = Buffer.from(headlessResult.rasterPixels, 'base64');
        assert.notDeepEqual(headlessRaster, savedRaster, 'Headless drawing must change the same raster layer saved by the visual editor');
        const headlessFramePixels = Buffer.from(headlessResult.headlessFramePixels, 'base64');
        let capturedHeadlessColor = false;
        for (let offset = 0; offset < headlessFramePixels.length; offset += 4) {
          if (headlessFramePixels[offset] === 22 && headlessFramePixels[offset + 1] === 199 &&
              headlessFramePixels[offset + 2] === 132 && headlessFramePixels[offset + 3] === 255) {
            capturedHeadlessColor = true;
            break;
          }
        }
        assert.ok(capturedHeadlessColor, 'Headless animation capture must include the new raster artwork in its third frame');

        // A fresh editor session must reconstruct the timeline from the account-backed project.
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForFunction(() => {
          const status = document.querySelector('#status')?.textContent || '';
          return status.includes('tus proyectos se guardan') || status.includes('Proyecto recuperado de tu cuenta');
        }, null, { timeout: 15000 });
        assert.equal(await page.locator('#animation-frames .animation-frame').count(), 3,
          'reopening the saved project must restore both visual frames and the Headless-added third frame');
        assert.equal(await page.locator('#animation-fps').inputValue(), '18',
          'reopening the saved project must restore its FPS');
        assert.equal(await page.locator('#animation-duration').inputValue(), '150',
          'reopening the saved project must restore the active frame duration');
        assert.equal(await page.locator('#animation-loop').isChecked(), false,
          'reopening the saved project must restore its loop setting');
        await page.locator('#animation-frames .animation-frame').nth(0).click();
        await page.locator('#animation-frames .animation-frame').nth(2).click();
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
