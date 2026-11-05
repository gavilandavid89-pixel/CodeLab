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
    assert.notEqual(await page.locator('#editorPanel').evaluate(el => getComputedStyle(el).display), 'none',
      'web workspace should display its code editor');
    assert.equal(await page.locator('#designStudioPanel').evaluate(el => getComputedStyle(el).display), 'none',
      'web workspace must not show the design toolbar/canvas');

    const bottomBar = page.locator('#mobileBottomBar');
    await bottomBar.waitFor({ state: 'visible' });
    const mobileNavHit = await page.evaluate(() => {
      const button = document.getElementById('mobileTabPreview');
      const r = button.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && (hit === button || button.contains(hit));
    });
    assert.equal(mobileNavHit, true, 'mobile preview control must be the topmost hit target at its center');
    const keyboardViewport = await page.evaluate(() => {
      const descriptor = Object.getOwnPropertyDescriptor(window, 'visualViewport');
      Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        value: { width: 390, height: 350, offsetTop: 0 }
      });
      syncMobileVisualViewport();
      const result = {
        detected: document.documentElement.classList.contains('keyboard-open'),
        bottomBarHidden: getComputedStyle(document.getElementById('mobileBottomBar')).display === 'none',
        shellHeight: getComputedStyle(document.getElementById('studioView')).height
      };
      if (descriptor) Object.defineProperty(window, 'visualViewport', descriptor);
      syncMobileVisualViewport();
      return result;
    });
    assert.equal(keyboardViewport.detected, true, 'mobile visual viewport shrink should detect the virtual keyboard');
    assert.equal(keyboardViewport.bottomBarHidden, true, 'the mobile bottom bar must not cover the editor while the keyboard is open');
    assert.equal(keyboardViewport.shellHeight, '350px', 'the studio shell must follow the shrunken visual viewport');
    await page.locator('#mobileTabPreview').evaluate(button => button.click());
    assert.ok(await page.locator('#studioView').evaluate(el => el.classList.contains('mobile-mode-preview')),
      'Preview bottom-tab should switch the mobile studio to preview mode');
    await page.locator('#mobileTabCode').evaluate(button => button.click());
    assert.ok(await page.locator('#studioView').evaluate(el => el.classList.contains('mobile-mode-code')),
      'Code bottom-tab should restore the mobile editor');

    // K51S landscape is 800 CSS px wide at DPR 2, so it must remain mobile despite
    // crossing the former 767px CSS breakpoint.
    await page.setViewportSize({ width: 800, height: 310 });
    await page.waitForFunction(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--codelab-visible-width').trim() === '800px',
      null, { timeout: 3000 });
    assert.equal(await bottomBar.isVisible(), true, 'K51S landscape must retain the mobile bottom navigation');
    await page.locator('#mobileTabPreview').evaluate(button => button.click());
    assert.equal(await page.locator('#previewPanel').evaluate(el => getComputedStyle(el).display !== 'none'), true,
      'K51S landscape preview mode must show the preview');
    assert.equal(await page.locator('#editorPanel').evaluate(el => getComputedStyle(el).display === 'none'), true,
      'K51S landscape preview mode must hide the code editor');
    await page.locator('#mobileTabCode').evaluate(button => button.click());
    assert.equal(await page.locator('#editorPanel').evaluate(el => getComputedStyle(el).display !== 'none'), true,
      'K51S landscape code mode must restore the editor');
    await page.setViewportSize({ width: 390, height: 844 });
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
    assert.equal(await page.locator('#editorPanel').evaluate(el => getComputedStyle(el).display), 'none',
      'design workspace must hide the web editor toolbar');
    assert.notEqual(await page.locator('#designStudioPanel').evaluate(el => getComputedStyle(el).display), 'none',
      'design workspace should show its own toolbar/canvas');
    assert.equal(await bottomBar.isVisible(), false,
      'design projects must not show the web-only Code/Preview bottom navigation');
    await page.locator('button[onclick="addDesignElement(\'button\')"]').click();
    await page.locator('#designCanvas [data-design-id]').first().waitFor({ state: 'visible' });
    assert.equal(await page.locator('#designProperties').count(), 0,
      'the design editor must not contain a properties panel');
    const touchTargets = await page.locator('#designStudioPanel button:visible').evaluateAll(buttons =>
      buttons.filter(button => {
        const r = button.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44);
      }).length);
    assert.equal(touchTargets, 0, 'visible mobile design-studio buttons should provide 44px touch targets');

    // Browser viewport/zoom changes must refresh the full shell, not only the canvas.
    const initialVisibleWidth = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--codelab-visible-width').trim());
    assert.ok(initialVisibleWidth.endsWith('px'), 'whole-interface viewport width should be tracked');
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForFunction(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--codelab-visible-width').trim() === '844px',
      null, { timeout: 3000 });

    await page.waitForTimeout(100);
    assert.ok(await page.locator('#designCanvas').isVisible(),
      'design canvas should remain available in landscape orientation');
    assert.ok(await page.locator('#designZoom').isVisible(), 'design zoom control remains available');
    assert.ok(await page.locator('#designFitBtn').isVisible(), 'fit-to-canvas action remains available');
    assert.equal((await page.locator('#designLayersPanel').textContent()).includes('Inspector'), true,
      'the former layers panel must be labeled Inspector');
    await page.locator('#toggleDesignInspector').click();
    assert.equal(await page.locator('#designStudioPanel').evaluate(el => el.classList.contains('design-inspector-hidden')), true,
      'Inspector panel can be collapsed');
    await page.locator('#toggleDesignInspector').click();
    assert.equal(await page.locator('#designStudioPanel').evaluate(el => el.classList.contains('design-inspector-hidden')), false,
      'Inspector panel can be reopened');
    assert.equal(await page.locator('#designProperties').count(), 0,
      'property controls must be removed entirely from the design editor');
    assert.equal(await page.locator('#designPropertiesPanel').count(), 0,
      'separate properties panel must be deleted, not hidden');
    assert.equal(await page.locator('#toggleDesignProperties').count(), 0,
      'separate properties toggle must be deleted');
    assert.equal(await page.locator('#designStudioPanel .design-toolbar').count(), 1,
      'design tools must be rendered in one toolbar, without duplicate toolbars');
    assert.ok(await page.locator('#designCanvasScroll').evaluate(el => el.clientWidth > 0),
      'design canvas scroll container should retain a usable width in landscape');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#designUndoBtn').click();
    await page.locator('#designRedoBtn').click();
    // Required target viewport: 720 × 1600 CSS px, excluding browser chrome.
    await page.locator('#designFrameSize').selectOption('mobile-k51s');
    const k51sFrame = await page.evaluate(() => ({
      width: document.getElementById('designCanvas')?.style.width,
      height: document.getElementById('designCanvas')?.style.height,
      zoom: Number(document.getElementById('designCanvas')?.style.zoom || 1)
    }));
    assert.equal(k51sFrame.width, '720px', 'K51S portrait design artboard must retain a 720 CSS-pixel source width');
    assert.equal(k51sFrame.height, '1600px', 'K51S portrait design artboard must retain a 1600 CSS-pixel source height');
    assert.ok(k51sFrame.zoom > 0 && k51sFrame.zoom <= 1, 'large K51S artboard should fit the available editor viewport without changing its source dimensions');
    const restoredK51sFrame = await page.evaluate(() => ({
      width: getDesignCanvasWidth({ frame: 'mobile-k51s' }),
      height: getDesignCanvasHeight({ frame: 'mobile-k51s' }),
      landscapeWidth: getDesignCanvasWidth({ frame: 'mobile-k51s-landscape' }),
      landscapeHeight: getDesignCanvasHeight({ frame: 'mobile-k51s-landscape' })
    }));
    assert.deepEqual(restoredK51sFrame, { width: 720, height: 1600, landscapeWidth: 1600, landscapeHeight: 720 },
      'K51S artboard presets must recover their dimensions even if older imported project JSON omits explicit sizes');

    await page.locator('#designFrameSize').selectOption('mobile-k51s-landscape');
    const k51sLandscapeFrame = await page.evaluate(() => ({
      width: document.getElementById('designCanvas')?.style.width,
      height: document.getElementById('designCanvas')?.style.height
    }));
    assert.equal(k51sLandscapeFrame.width, '1600px', 'K51S landscape artboard must retain a 1600 CSS-pixel source width');
    assert.equal(k51sLandscapeFrame.height, '720px', 'K51S landscape artboard must retain a 720 CSS-pixel source height');

    // Physical target is 720×1600 device pixels. A DPR-2 handset exposes about
    // 360 CSS px; reserve 52 CSS px (104 physical px) for browser/system chrome.
    await page.setViewportSize({ width: 360, height: 748 });
    await page.waitForFunction(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--codelab-visible-width').trim() === '360px',
      null, { timeout: 3000 });
    const targetViewport = await page.evaluate(() => ({
      cssWidth: window.innerWidth,
      cssHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      physicalWidth: Math.round(window.innerWidth * window.devicePixelRatio),
      visibleDocumentWidth: document.documentElement.scrollWidth,
      canvasVisible: !!document.querySelector('#designCanvas') &&
        document.querySelector('#designCanvas').getBoundingClientRect().width > 0,
      toolbarVisible: !!document.querySelector('#designStudioPanel .design-toolbar') &&
        getComputedStyle(document.querySelector('#designStudioPanel .design-toolbar')).display !== 'none'
    }));
    assert.equal(targetViewport.physicalWidth, 720, 'K51S portrait emulation must represent 720 physical display pixels across');
    assert.equal(targetViewport.devicePixelRatio, 2, 'K51S test must use DPR 2 rather than a 720px CSS viewport');
    assert.ok(targetViewport.cssHeight < 800, 'usable web height must leave room for browser and Android system chrome');
    assert.ok(targetViewport.visibleDocumentWidth <= 360, 'the full interface must not create horizontal overflow in the K51S CSS viewport');
    assert.equal(targetViewport.canvasVisible, true, 'design canvas must remain visible in the K51S portrait CSS viewport');
    assert.equal(targetViewport.toolbarVisible, true, 'design toolbar must remain reachable in the K51S portrait CSS viewport');

    // Landscape rotates the same physical screen: 1600×720 device px -> 800×310 CSS px,
    // leaving a reserved 50 CSS px for browser/system chrome.
    await page.setViewportSize({ width: 800, height: 310 });
    await page.waitForFunction(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--codelab-visible-width').trim() === '800px',
      null, { timeout: 3000 });
    const landscapeViewport = await page.evaluate(() => ({
      physicalWidth: Math.round(window.innerWidth * window.devicePixelRatio),
      cssHeight: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth
    }));
    assert.equal(await bottomBar.isVisible(), false,
      'the web-only mobile bottom bar must remain hidden for a design project in landscape');
    assert.equal(landscapeViewport.physicalWidth, 1600, 'K51S landscape emulation must represent 1600 physical display pixels across');
    assert.ok(landscapeViewport.cssHeight < 360, 'landscape web viewport must leave room for browser/system chrome');
    assert.ok(landscapeViewport.documentWidth <= 800, 'landscape interface must not create horizontal page overflow');


    assert.deepEqual(failures, [], 'mobile UI journey should not throw uncaught JavaScript errors');
    console.log('Responsive interface E2E passed: mobile design tools tabs, component search/filter, web/design creation, code/preview switching, mobile menu and AI drawer, touch-sized controls, portrait/landscape and 720×1600 target design canvas.');
    await context.close();
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error('Responsive interface E2E failed:', error);
  process.exitCode = 1;
});
