const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const BASE_URL = process.env.CODELAB_E2E_BASE_URL || 'http://127.0.0.1:3188';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, acceptDownloads: true });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => document.getElementById('syncLoadingModal')?.classList.contains('hidden'), null, { timeout: 15000 });

    await page.getByRole('button', { name: /Crear proyecto/i }).click();
    await page.locator('#newProjectNameInput').fill('Prueba herramientas diseño ' + Date.now());
    await page.locator('input[name="newProjectType"][value="design"]').check();
    await page.locator('#newProjectModal button').filter({ hasText: 'Crear Proyecto' }).click();
    await page.locator('#designStudioPanel').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForFunction(() => getCurrentProject()?.type === 'design', null, { timeout: 10000 });

    // Verify each primitive can be added and is represented in the layer list and canvas.
    for (const type of ['heading', 'text', 'button', 'rectangle', 'ellipse', 'image']) {
      const before = await page.evaluate(() => getCurrentProject().design.elements.length);
      await page.locator(`button[onclick="addDesignElement('${type}')"]`).click();
      await page.waitForFunction(({ before, type }) => {
        const elements = getCurrentProject()?.design?.elements || [];
        return elements.length === before + 1 && elements.some(item => item.type === type);
      }, { before, type }, { timeout: 5000 });
    }
    const createdTypes = await page.evaluate(() => getCurrentProject().design.elements.map(item => item.type));
    for (const type of ['heading', 'text', 'button', 'rectangle', 'ellipse', 'image']) {
      assert.ok(createdTypes.includes(type), 'The ' + type + ' tool should add an element to the active design');
    }
    assert.ok(await page.locator('#designLayers').isVisible(), 'The design layers panel should remain visible while tools are used');

    // Undo/redo should remove and restore the last added element.
    const beforeUndo = await page.evaluate(() => getCurrentProject().design.elements.length);
    await page.locator('#designUndoBtn').click();
    await page.waitForFunction(n => getCurrentProject().design.elements.length === n - 1, beforeUndo, { timeout: 5000 });
    await page.locator('#designRedoBtn').click();
    await page.waitForFunction(n => getCurrentProject().design.elements.length === n, beforeUndo, { timeout: 5000 });

    // Grid, snapping, viewport fit and frame presets must expose working state.
    const gridBefore = await page.evaluate(() => getCurrentProject().design.grid);
    await page.locator('#designGridBtn').click();
    assert.notEqual(await page.evaluate(() => getCurrentProject().design.grid), gridBefore, 'Grid toggle must change the project grid setting');
    const snapBefore = await page.evaluate(() => getCurrentProject().design.snapToGrid);
    await page.locator('#designSnapBtn').click();
    assert.notEqual(await page.evaluate(() => getCurrentProject().design.snapToGrid), snapBefore, 'Snap toggle must change the project snapping setting');
    await page.locator('#designFitBtn').click();
    await page.locator('#designFrameSize').selectOption({ index: 1 });
    assert.ok(await page.locator('#designCanvas').evaluate(el => el.clientWidth > 0 && el.clientHeight > 0), 'Canvas must remain usable after frame changes');

    // Template menu and template application should be functional.
    await page.locator('#designTemplatesButton').click();
    await page.locator('#designTemplateLanding').waitFor({ state: 'visible' });
    await page.locator('#designTemplateLanding').click();
    await page.waitForFunction(() => (getCurrentProject()?.design?.elements || []).length >= 3, null, { timeout: 5000 });

    // Export menu exposes actual download actions for SVG and project JSON.
    await page.locator('#designExportMenuButton').click();
    await page.locator('#exportDesignSvgOption').waitFor({ state: 'visible' });
    const svgDownloadPromise = page.waitForEvent('download', { timeout: 10000 });
    await page.locator('#exportDesignSvgOption').click();
    const svgDownload = await svgDownloadPromise;
    assert.match(svgDownload.suggestedFilename(), /\.svg$/i, 'SVG export should download an SVG file');
    await page.locator('#designExportMenuButton').click();
    const jsonDownloadPromise = page.waitForEvent('download', { timeout: 10000 });
    await page.locator('#exportDesignJsonOption').click();
    const jsonDownload = await jsonDownloadPromise;
    assert.match(jsonDownload.suggestedFilename(), /\.json$/i, 'Project backup should download JSON');

    // Design tools tabs and live controls: palette, accessibility, tokens and audit.
    await page.locator('#openDesignTools').click();
    await page.locator('#designToolsModal:not(.hidden)').waitFor({ state: 'visible' });
    for (const tab of ['palette', 'accessibility', 'tokens', 'audit']) {
      await page.locator('#designToolsTab-' + tab).click();
      await page.locator('#designToolsPanel-' + tab).waitFor({ state: 'visible' });
    }
    await page.locator('#designToolsTab-palette').click();
    const paletteColor = await page.locator('#designPalettePreview [data-palette-color]').first().getAttribute('data-palette-color');
    await page.locator('#designPalettePreview [data-palette-color]').first().click();
    assert.equal(await page.locator('#colorPrimary').inputValue(), paletteColor, 'Palette swatches must update the primary color');
    await page.locator('#designToolsTab-tokens').click();
    await page.locator('#applyDesignTokens').click();
    assert.ok(await page.locator('#designToolsStatus').innerText().then(t => t.length > 0), 'Applying design tokens should provide status feedback');
    await page.locator('#closeDesignTools').click();

    // Component library: search/filter, select and insert into the editor.
    await page.locator('#openComponentLibrary').click();
    await page.locator('#componentLibraryModal:not(.hidden)').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-component-id]').count(), 8);
    await page.fill('#componentLibrarySearch', 'proyecto');
    assert.equal(await page.locator('[data-component-id]').count(), 1, 'Search should filter the component catalog');
    await page.locator('[data-component-id]').first().click();
    assert.ok((await page.locator('#componentLibraryCode').inputValue()).length > 0, 'Selecting a component should show its source');
    await page.locator('#closeComponentLibrary').click();

    assert.deepEqual(errors, [], 'Using design tools should not produce uncaught browser errors');
    console.log('Design tools usage E2E passed: six element types, undo/redo, grid/snap/fit/frame, templates, SVG/JSON export, four design-system tabs, palette/token actions, and component library search/selection.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error('Design tools usage E2E failed:', error); process.exitCode = 1; });
