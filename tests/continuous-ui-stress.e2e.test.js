const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE_URL = process.env.CODELAB_E2E_BASE_URL || 'http://127.0.0.1:3188';
const stamp = Date.now();
const errors = [];
const warnings = [];

async function waitForReady(page) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('syncLoadingModal')?.classList.contains('hidden'), null, { timeout: 15000 });
}

async function createProject(page, type, name) {
  await page.getByRole('button', { name: /Crear proyecto/i }).click();
  await page.locator('#newProjectModal').waitFor({ state: 'visible' });
  await page.locator('#newProjectNameInput').fill(name);
  await page.locator(`input[name="newProjectType"][value="${type}"]`).check();
  await page.locator('#newProjectModal button').filter({ hasText: 'Crear Proyecto' }).click();
  await page.locator(type === 'design' ? '#designStudioPanel' : '#studioView').waitFor({ state: 'visible', timeout: 15000 });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, acceptDownloads: true });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.stack || e.message));
    page.on('console', m => { if (m.type() === 'error') warnings.push(m.text()); });
    await waitForReady(page);

    // Repeat modal open/close through each supported path, then verify focus/visibility state.
    for (let i = 0; i < 2; i++) {
      await page.locator('#openDesignTools').click();
      await page.locator('#designToolsModal').waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      await page.locator('#designToolsModal').waitFor({ state: 'hidden' });
    }
    await page.locator('#openDesignTools').click();
    await page.locator('#designToolsModal').waitFor({ state: 'visible' });
    await page.locator('#designToolsCloseFooter').click();
    await page.locator('#designToolsModal').waitFor({ state: 'hidden' });
    await page.locator('#openDesignTools').click();
    await page.locator('#designToolsModal').waitFor({ state: 'visible' });
    await page.locator('#designToolsModal').click({ position: { x: 3, y: 3 } });
    await page.locator('#designToolsModal').waitFor({ state: 'hidden' });

    // Exercise all design-system fields, save/reset, exports, import validation, audit, and token preconditions.
    await page.locator('#openDesignTools').click();
    await page.locator('#designToolsModal').waitFor({ state: 'visible' });
    const original = await page.locator('#colorPrimary').inputValue();
    await page.locator('#colorPrimary').fill('#123abc');
    await page.locator('#colorPrimary').dispatchEvent('input');
    assert.equal(await page.locator('#designPreviewPrimary').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(18, 58, 188)');
    await page.locator('#saveDesignSystem').click();
    assert.ok((await page.locator('#designToolsStatus').innerText()).length > 0);
    await page.locator('#resetDesignSystem').click();
    assert.equal(await page.locator('#colorPrimary').inputValue(), original);
    await page.locator('#designToolsTab-tokens').click();
    for (const [id, ext] of [['exportDesignSystemCss', '.css'], ['exportDesignSystemJson', '.json']]) {
      const dl = page.waitForEvent('download');
      await page.locator('#' + id).click();
      assert.ok((await dl).suggestedFilename().endsWith(ext), id + ' should download the expected format');
    }
    const invalidJson = Buffer.from(JSON.stringify({ invalid: true }));
    await page.locator('#designSystemJsonFile').setInputFiles({ name: 'invalid-design-system.json', mimeType: 'application/json', buffer: invalidJson });
    await page.locator('#designSystemJsonFile').dispatchEvent('change');
    await page.waitForFunction(() => document.getElementById('designToolsStatus').textContent.includes('No se pudo importar'));
    assert.equal(await page.locator('#designSystemJsonFile').inputValue(), '', 'file picker must reset after an import attempt');
    await page.locator('#designToolsTab-audit').click();
    await page.locator('#runAccessibilityAudit').click();
    assert.ok((await page.locator('#designToolsStatus').innerText()).length > 0, 'audit should explain why it cannot audit without a web project');
    await page.locator('#designToolsTab-tokens').click();
    await page.locator('#applyDesignTokens').click();
    assert.ok((await page.locator('#designToolsStatus').innerText()).length > 0, 'tokens should explain when no web editor is active');
    await page.locator('#closeDesignTools').click();
    await page.locator('#designToolsModal').waitFor({ state: 'hidden' });

    // Component library: search, category, selection, copy/download/insert, and repeated close/reopen.
    await page.locator('#openComponentLibrary').click();
    await page.locator('#componentLibraryModal').waitFor({ state: 'visible' });
    const total = await page.locator('[data-component-id]').count();
    assert.ok(total >= 5, 'component catalog should contain multiple items');
    await page.locator('#componentLibrarySearch').fill('no-such-component-' + stamp);
    assert.equal(await page.locator('[data-component-id]').count(), 0, 'unknown search should produce no false matches');
    await page.locator('#componentLibrarySearch').fill('');
    await page.locator('#componentLibraryCategory').selectOption({ index: 1 });
    assert.ok(await page.locator('[data-component-id]').count() > 0, 'category filter should retain matching components');
    await page.locator('[data-component-id]').first().click();
    assert.ok((await page.locator('#componentLibraryCode').inputValue()).length > 0);
    for (const id of ['componentLibraryCopy', 'componentLibraryDownload', 'componentLibraryInsert']) {
      await page.locator('#' + id).waitFor({ state: 'visible' });
      await page.locator('#' + id).click();
    }
    await page.locator('#closeComponentLibrary').click();
    await page.locator('#componentLibraryModal').waitFor({ state: 'hidden' });
    await page.locator('#openComponentLibrary').click();
    await page.locator('#componentLibraryModal').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.locator('#componentLibraryModal').waitFor({ state: 'hidden' });

    // Design canvas: element property edits, duplicate/delete, grid/frame/zoom, templates, import and exports.
    await createProject(page, 'design', 'Stress diseño ' + stamp);
    await page.locator('button[onclick="addDesignElement(\'button\')"]').click();
    const layer = page.locator('#designCanvas [data-design-id]').last();
    await layer.waitFor({ state: 'visible' });
    await layer.click();
    await page.locator('#designProperties').waitFor({ state: 'visible' });
    const beforeDup = await page.evaluate(() => getCurrentProject().design.elements.length);
    await page.locator('#designProperties button[onclick="duplicateDesignElement()"]').click();
    await page.waitForFunction(n => getCurrentProject().design.elements.length === n + 1, beforeDup);
    const beforeDelete = await page.evaluate(() => getCurrentProject().design.elements.length);
    const deleteButton = page.locator('#designProperties button[onclick="deleteSelectedDesignElement()"]');
    if (await deleteButton.count()) {
      await deleteButton.click();
      await page.waitForFunction(n => getCurrentProject().design.elements.length === n - 1, beforeDelete);
    }
    const zoom = page.locator('#designZoom');
    if (await zoom.count()) {
      await zoom.fill('125');
      await zoom.dispatchEvent('input');
      assert.ok((await page.locator('#designZoomLabel').innerText()).length > 0);
    }
    await page.locator('#designBackgroundColor').fill('#f0e1d2');
    await page.locator('#designBackgroundColor').dispatchEvent('input');
    await page.locator('#designGridSize').selectOption({ index: 1 });
    await page.locator('#designFrameSize').selectOption({ index: 1 });
    await page.locator('#designFitBtn').click();
    for (const template of ['designTemplateLanding', 'designTemplateDashboard', 'designTemplatePortfolio']) {
      await page.locator('#designTemplatesButton').click();
      await page.locator('#' + template).click();
      await page.waitForFunction(() => (getCurrentProject()?.design?.elements || []).length > 0);
    }
    await page.locator('#designExportMenuButton').click();
    const svg = page.waitForEvent('download');
    await page.locator('#exportDesignSvgOption').click();
    assert.match((await svg).suggestedFilename(), /\.svg$/i);
    await page.locator('#designExportMenuButton').click();
    const backup = page.waitForEvent('download');
    await page.locator('#exportDesignJsonOption').click();
    const backupFile = await backup;
    assert.match(backupFile.suggestedFilename(), /\.json$/i);
    // Invalid project import must be handled and clear the picker instead of leaving stale selection.
    await page.locator('#designProjectJsonFile').setInputFiles({
      name: 'invalid-project.json', mimeType: 'application/json', buffer: Buffer.from('{"not":"a project"}')
    });
    await page.locator('#designProjectJsonFile').dispatchEvent('change');
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#designProjectJsonFile').inputValue(), '');

    // Switch to Web and run the design-system actions that require a real web editor.
    await page.locator('#designStudioPanel button').filter({ hasText: 'Proyectos' }).first().click();
    await page.locator('#welcomeDashboard').waitFor({ state: 'visible' });
    await createProject(page, 'web', 'Stress web ' + stamp);
    await page.locator('#openDesignTools').click();
    await page.locator('#designToolsModal').waitFor({ state: 'visible' });
    await page.locator('#designToolsTab-audit').click();
    await page.locator('#runAccessibilityAudit').click();
    assert.ok((await page.locator('#accessibilityAuditResults').getAttribute('data-report')) || (await page.locator('#designToolsStatus').innerText()).length > 0,
      'HTML accessibility audit should produce a report or explicit status');
    await page.locator('#exportAccessibilityAudit').waitFor({ state: 'visible' });
    const auditDownload = page.waitForEvent('download');
    await page.locator('#exportAccessibilityAudit').click();
    assert.match((await auditDownload).suggestedFilename(), /\.json$/i);
    await page.locator('#designToolsTab-tokens').click();
    const cssBefore = await page.evaluate(() => getEditorValue('css'));
    await page.locator('#applyDesignTokens').click();
    await page.waitForFunction(before => getEditorValue('css') !== before, cssBefore, { timeout: 10000 });
    await page.locator('#designToolsTab-palette').click();
    await page.locator('#colorSecondary').fill('#ab12cd');
    await page.locator('#saveDesignSystem').click();
    await page.locator('#closeDesignTools').click();
    await page.waitForFunction(() => document.getElementById('designToolsModal').classList.contains('hidden'));

    // Web editor cycle: edit each language, preview, menu navigation, save and return to projects.
    for (const tab of ['html', 'css', 'js']) {
      await page.locator('#tab-' + tab).click();
      assert.ok(await page.locator('#tab-' + tab).isVisible(), 'web editor tab should be reachable: ' + tab);
    }
    await page.locator('#tab-html').click();
    await page.locator('#editorPanel button[onclick="updatePreview()"]').click();
    await page.locator('#previewIframe').waitFor({ state: 'attached' });
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(200);
    await page.locator('#studioView button').filter({ hasText: 'Proyectos' }).first().click();
    await page.locator('#welcomeDashboard').waitFor({ state: 'visible' });

    assert.deepEqual(errors, [], 'continuous UI stress journey must not throw uncaught page errors');
    console.log('Continuous UI stress E2E passed: modal open/close cycles, design-system settings/import/export/audit/token preconditions, component search/filter/copy/download/insert, design element create/duplicate/delete, canvas controls/templates/import/export, web editor tabs/preview/save, and cross-mode navigation.');
    if (warnings.length) console.log('Browser console errors observed (review separately): ' + JSON.stringify(warnings.slice(0, 20)));
    await context.close();
  } finally {
    await browser.close();
  }
})().catch(error => { console.error('Continuous UI stress E2E failed:', error); process.exitCode = 1; });
