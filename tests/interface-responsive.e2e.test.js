const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE_URL = process.env.CODELAB_E2E_BASE_URL || 'http://127.0.0.1:3188';
const suffix = Date.now();
const WEB_NAME = 'UI móvil web ' + suffix;
const DESIGN_NAME = 'UI móvil diseño ' + suffix;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const failures = [];
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
      acceptDownloads: true
    });
    const page = await context.newPage();
    page.on('pageerror', error => failures.push(error.message));
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() =>
      document.getElementById('syncLoadingModal')?.classList.contains('hidden'), null, { timeout: 15000 });

    // The dashboard tools must open, switch tabs, and close on a phone-sized viewport.
    await page.locator('#openDesignTools').click();
    await page.locator('#designToolsModal').waitFor({ state: 'visible' });
    for (const tab of ['palette', 'accessibility', 'tokens', 'audit']) {
      await page.locator('#designToolsTab-' + tab).click();
      assert.equal(await page.locator('#designToolsPanel-' + tab).isVisible(), true,
        'design tools tab should switch to ' + tab + ' on mobile');
    }
    await page.locator('#closeDesignTools').click();
    await page.locator('#designToolsModal').waitFor({ state: 'hidden' });

    await page.locator('#openComponentLibrary').click();
    await page.locator('#componentLibraryModal').waitFor({ state: 'visible' });
    await page.locator('#componentLibrarySearch').fill('hero');
    await page.locator('#componentLibraryList').waitFor({ state: 'visible' });
    assert.ok(await page.locator('#componentLibraryList').locator('button').count() > 0,
      'component search should return selectable results');
    await page.locator('#componentLibraryCategory').selectOption('Secciones');
    await page.locator('#closeComponentLibrary').click();
    await page.locator('#componentLibraryModal').waitFor({ state: 'hidden' });

    // Exercise both creation branches through the visible form, not by calling internals.
    await page.getByRole('button', { name: /Crear proyecto/i }).click();
    await page.locator('#newProjectModal').waitFor({ state: 'visible' });
    await page.locator('#newProjectNameInput').fill(WEB_NAME);
    await page.locator('input[name="newProjectType"][value="web"]').check();
    await page.locator('#newProjectModal button').filter({ hasText: 'Crear Proyecto' }).click();
    await page.locator('#studioView').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForFunction(name => document.getElementById('currentProjectTitle')?.textContent === name,
      WEB_NAME, { timeout: 10000 });

    const bottomBar = page.locator('#mobileBottomBar');
    await bottomBar.waitFor({ state: 'visible' });
    const mobileNavHit = await page.evaluate(() => {
      const button = document.getElementById('mobileTabPreview');
      const r = button.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && (hit === button || button.contains(hit));
    });
    assert.equal(mobileNavHit, true, 'mobile preview control must be the topmost hit target at its center');
    await page.locator('#mobileTabPreview').evaluate(button => button.click());
    assert.ok(await page.locator('#studioView').evaluate(el => el.classList.contains('mobile-mode-preview')),
      'Preview bottom-tab should switch the mobile studio to preview mode');
    await page.locator('#mobileTabCode').evaluate(button => button.click());
    assert.ok(await page.locator('#studioView').evaluate(el => el.classList.contains('mobile-mode-code')),
      'Code bottom-tab should restore the mobile editor');
    await bottomBar.getByRole('button', { name: /Más/i }).evaluate(button => button.click());
    await page.locator('#mobileDropdown').waitFor({ state: 'visible' });
    await page.locator('#mobileDropdown').getByRole('button', { name: /Plantillas IA/i }).click();
    await page.locator('#aiDrawer').waitFor({ state: 'visible' });
    await page.locator('#aiPromptInput').fill('Crea una tarjeta accesible');
    assert.equal(await page.locator('#aiPromptInput').inputValue(), 'Crea una tarjeta accesible');
    await page.locator('#aiSendBtn').waitFor({ state: 'visible' });
    await page.evaluate(() => {
      if (typeof toggleAiPanel === 'function') toggleAiPanel();
    });
    await page.locator('#studioView button').filter({ hasText: 'Proyectos' }).first().click();
    await page.locator('#welcomeDashboard').waitFor({ state: 'visible' });

    // Create a design project on mobile, then check touch-sized canvas controls and landscape layout.
    await page.getByRole('button', { name: /Crear proyecto/i }).click();
    await page.locator('#newProjectNameInput').fill(DESIGN_NAME);
    await page.locator('input[name="newProjectType"][value="design"]').check();
    await page.locator('#newProjectModal button').filter({ hasText: 'Crear Proyecto' }).click();
    await page.locator('#designStudioPanel').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForFunction(name => {
      const project = typeof getCurrentProject === 'function' ? getCurrentProject() : null;
      return project && project.name === name && project.type === 'design';
    }, DESIGN_NAME, { timeout: 10000 });
    await page.locator('button[onclick="addDesignElement(\'button\')"]').click();
    await page.locator('#designCanvas [data-design-id]').first().waitFor({ state: 'visible' });
    assert.ok(await page.locator('#designProperties').isVisible(),
      'adding a design layer on mobile should open its properties');
    const touchTargets = await page.locator('#designStudioPanel button:visible').evaluateAll(buttons =>
      buttons.filter(button => {
        const r = button.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (r.width < 32 || r.height < 32);
      }).length);
    assert.equal(touchTargets, 0, 'visible design-studio buttons should not fall below the 32px minimum target');

    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(100);
    assert.ok(await page.locator('#designCanvas').isVisible(),
      'design canvas should remain available in landscape orientation');
    assert.ok(await page.locator('#designCanvasScroll').evaluate(el => el.clientWidth > 0),
      'design canvas scroll container should retain a usable width in landscape');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#designUndoBtn').click();
    await page.locator('#designRedoBtn').click();

    assert.deepEqual(failures, [], 'mobile UI journey should not throw uncaught JavaScript errors');
    console.log('Responsive interface E2E passed: mobile design tools tabs, component search/filter, web/design creation, code/preview switching, mobile menu and AI drawer, touch-sized controls, portrait/landscape design canvas.');
    await context.close();
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error('Responsive interface E2E failed:', error);
  process.exitCode = 1;
});
