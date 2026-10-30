const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const BASE_URL = process.env.CODELAB_E2E_BASE_URL || 'http://127.0.0.1:3188';
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => document.getElementById('syncLoadingModal')?.classList.contains('hidden'), null, { timeout: 15000 });
    async function createDesign(name) {
      await page.getByRole('button', { name: /Crear proyecto/i }).click();
      await page.locator('#newProjectNameInput').fill(name);
      await page.locator('input[name="newProjectType"][value="design"]').check();
      await page.locator('#newProjectModal button').filter({ hasText: 'Crear Proyecto' }).click();
      await page.locator('#designStudioPanel').waitFor({ state: 'visible', timeout: 15000 });
      await page.waitForFunction(expected => {
        const p = typeof getCurrentProject === 'function' ? getCurrentProject() : null;
        return p && p.name === expected && p.type === 'design';
      }, name, { timeout: 10000 });
      return await page.evaluate(() => getCurrentProject().id);
    }
    const sourceName = 'Grafo origen ' + Date.now();
    const targetName = 'Grafo destino ' + Date.now();
    const sourceId = await createDesign(sourceName);
    await page.locator('button[onclick="addDesignElement(\'button\')"]').click();
    const sourceElementId = await page.evaluate(() => getCurrentProject().design.elements.find(e => e.type === 'button').id);
    const targetId = await createDesign(targetName);
    await page.locator('#openDesignFlowGraph').click();
    await page.locator('#designFlowGraphModal').waitFor({ state: 'visible' });
    const overviewToggle = page.locator('#designFlowOverviewToggle');
    await overviewToggle.click();
    await page.locator('#designFlowOverview').waitFor({ state: 'visible' });
    await page.locator('#designFlowOverview').getByText(/Todavía no hay conexiones/).waitFor({ state: 'visible' });
    await overviewToggle.click();
    await page.locator('#designFlowOverview').waitFor({ state: 'hidden' });
    const workspace = page.locator('#designFlowCanvas');
    assert.ok(await workspace.evaluate(el => el.clientWidth > 0 && el.clientHeight > 0), 'node workspace should have a usable viewport');
    await page.locator('[data-flow-source-port="' + sourceElementId + '"]').waitFor({ state: 'visible' });
    await page.locator('[data-flow-target-project="' + targetId + '"]').waitFor({ state: 'visible' });
    await page.locator('#designFlowChoose').click();
    const sourceRow = page.locator('[data-flow-action="' + sourceElementId + '"][data-flow-source-project="' + sourceId + '"]');
    await sourceRow.click();
    await page.waitForFunction(id => {
      const row = document.querySelector('[data-flow-action="' + id + '"]');
      return !!row && row.className.includes('border-yellow-300');
    }, sourceElementId, { timeout: 5000 });
    const source = page.locator('[data-flow-source-port="' + sourceElementId + '"]');
    const target = page.locator('[data-flow-target-project="' + targetId + '"]');
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    assert.ok(sourceBox && targetBox, 'source connector and destination sheet must be visible');
    const sx = sourceBox.x + sourceBox.width / 2, sy = sourceBox.y + sourceBox.height / 2;
    const tx = targetBox.x + targetBox.width / 2, ty = targetBox.y + targetBox.height / 2;
    const length = Math.hypot(tx - sx, ty - sy);
    const gestureX = sx + (tx - sx) / length * 24, gestureY = sy + (ty - sy) / length * 24;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(gestureX, gestureY, { steps: 4 });
    await page.mouse.up();
    await page.waitForFunction(({ sourceId, sourceElementId, targetId }) => {
      const p = projects.find(item => item.id === sourceId);
      return p?.design?.flowConnections?.some(c => c.sourceElementId === sourceElementId && c.targetProjectId === targetId);
    }, { sourceId, sourceElementId, targetId }, { timeout: 10000 });
    assert.equal(await target.evaluate(el => el.tagName), 'ARTICLE', 'the whole destination sheet, not only its header, must be a valid target');
    await page.locator('#designFlowRefresh').click();
    await overviewToggle.click();
    await page.locator('#designFlowOverview').getByText(sourceName, { exact: false }).waitFor({ state: 'visible' });
    await page.locator('#designFlowOverview').getByText(targetName, { exact: false }).waitFor({ state: 'visible' });
    assert.ok(await page.locator('#designFlowWires [data-connection]').count() >= 1, 'connected pages should display a wire');
    assert.ok(await page.locator('#designFlowWires [data-wire-halo]').count() >= 1, 'wire should have a white contrast halo');
    await overviewToggle.click();
    await page.locator('[data-flow-menu="' + sourceElementId + '"]').check();
    await page.waitForFunction(({ sourceId, sourceElementId }) => {
      const p = projects.find(item => item.id === sourceId);
      const el = p?.design?.elements?.find(item => item.id === sourceElementId);
      return el?.flowRole === 'menu' && !p.design.flowConnections.some(c => c.sourceElementId === sourceElementId);
    }, { sourceId, sourceElementId }, { timeout: 10000 });
    await page.locator('[data-flow-menu="' + sourceElementId + '"]').uncheck();
    await page.waitForFunction(({ sourceId, sourceElementId }) => {
      const p = projects.find(item => item.id === sourceId);
      return p?.design?.elements?.find(item => item.id === sourceElementId)?.flowRole !== 'menu';
    }, { sourceId, sourceElementId }, { timeout: 10000 });
    assert.deepEqual(errors, [], 'node graph must not throw browser errors');
    console.log('Design flow graph E2E passed: open graph, connect a specific option to a page, mark/unmark dropdown menus, and remove navigation connections for menus.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error('Design flow graph E2E failed:', error); process.exitCode = 1; });