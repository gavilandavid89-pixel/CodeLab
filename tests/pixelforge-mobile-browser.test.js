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
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.goto(base + '/pixelforge/index.html', { waitUntil: 'networkidle' });
      const authResponse = await page.request.get(base + '/api/auth/status');
      const authStatus = await authResponse.json();
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
          JSON.stringify({ authUser: authStatus.user, diagnostics, pageErrors }) + '; cause=' + error.message);
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
