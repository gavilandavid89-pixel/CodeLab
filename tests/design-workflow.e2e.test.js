const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { chromium } = require('playwright');

const BASE_URL = process.env.CODELAB_E2E_BASE_URL || 'http://127.0.0.1:3188';
const PROJECT_NAME = 'Flujo integral E2E ' + Date.now();

async function waitForPersistedProject(page, projectName) {
  await page.waitForFunction(async name => {
    const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
    const token = localStorage.getItem('codelab_xd_workspace_token_v1');
    if (!workspaceId || !token) return false;
    try {
      const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId), {
        headers: { 'x-workspace-token': token }
      });
      if (!response.ok) return false;
      const data = await response.json();
      return Array.isArray(data.projects) && data.projects.some(project =>
        project.name === name &&
        project.type === 'design' &&
        project.design &&
        project.design.elements.some(element => element.text === 'Prueba integral CodeLab')
      );
    } catch (_) {
      return false;
    }
  }, projectName, { timeout: 15000 });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const failures = [];
  try {
    const context = await browser.newContext({
      viewport: { width: 1365, height: 900 },
      acceptDownloads: true
    });
    const page = await context.newPage();
    page.on('pageerror', error => failures.push(error.message));

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => document.getElementById('syncLoadingModal')?.classList.contains('hidden'), null, { timeout: 15000 });

    // The project preview runs scripts in an opaque-origin sandbox. It must not
    // gain same-origin access or let unrelated windows spoof console entries.
    const previewSandbox = await page.locator('#previewIframe').getAttribute('sandbox');
    assert.ok(previewSandbox && !previewSandbox.includes('allow-same-origin'),
      'Preview must not share the app origin or expose its localStorage credentials');
    await page.evaluate(() => window.postMessage({
      type: 'CONSOLE_LOG', logType: 'error', message: 'SPOOFED_CONSOLE_MESSAGE'
    }, '*'));
    await page.waitForTimeout(50);
    assert.equal(await page.locator('#consoleOutput').getByText('SPOOFED_CONSOLE_MESSAGE', { exact: true }).count(), 0,
      'The app must ignore console messages not sent by its own preview iframe');
    await page.evaluate(() => updatePreview());
    // The preview iframe is inside a hidden studio panel during dashboard boot;
    // wait for its document to attach, not for the hidden body to become visible.
    await page.frameLocator('#previewIframe').locator('body').waitFor({ state: 'attached' });
    await page.frameLocator('#previewIframe').locator('body').evaluate(() => {
      window.parent.postMessage({
        type: 'CONSOLE_LOG', logType: 'log', message: 'TRUSTED_PREVIEW_MESSAGE'
      }, '*');
    });
    await page.waitForFunction(() =>
      document.getElementById('consoleOutput')?.textContent.includes('TRUSTED_PREVIEW_MESSAGE')
    , null, { timeout: 3000 });

    // Project creation must respect the same configurable cap enforced by the API.
    const projectLimitCheck = await page.evaluate(() => {
      const previousLimit = maxProjects;
      const before = projects.length;
      maxProjects = before;
      openNewProjectModal();
      document.getElementById('newProjectNameInput').value = 'No debe crearse por límite';
      createNewProjectConfirm();
      const after = projects.length;
      closeNewProjectModal();
      maxProjects = previousLimit;
      return { before, after };
    });
    assert.equal(projectLimitCheck.after, projectLimitCheck.before,
      'The UI must prevent creating a project when the workspace has reached its server-configured limit');
    
    // OAuth local import must obey the same project cap as manual creation.
    const importLimitCheck = await page.evaluate(() => {
      const saved = {
        currentUser,
        projects,
        pendingLocalImportProjects,
        maxProjects,
        saveProjectsToStorage,
        renderProjectsList,
        showToast,
        storePendingLocalImport,
        lsRemove,
        confirm: window.confirm,
        pendingStorage: localStorage.getItem('codelab_xd_pending_local_import_v1')
      };
      try {
        currentUser = { real: true, provider: 'e2e', id: 'import-limit' };
        projects = [{ id: 'existing-project', name: 'Existente', code: { html: '', css: '', js: '' } }];
        pendingLocalImportProjects = [
          { id: 'import-one', name: 'Uno', code: { html: '<p>1</p>' } },
          { id: 'import-two', name: 'Dos', code: { html: '<p>2</p>' } },
          { id: 'import-two', name: 'Dos duplicado', code: { html: '<p>duplicado</p>' } },
          { id: 'import-three', name: 'Tres', code: { html: '<p>3</p>' } }
        ];
        maxProjects = 3;
        let preservedPending = [];
        saveProjectsToStorage = () => {};
        renderProjectsList = () => {};
        showToast = () => {};
        storePendingLocalImport = value => { preservedPending = value; pendingLocalImportProjects = value; return true; };
        lsRemove = () => {};
        window.confirm = () => true;
        maybeOfferLocalImport();
        return { count: projects.length, importedIds: projects.map(project => project.id), preservedPending };
      } finally {
        currentUser = saved.currentUser;
        projects = saved.projects;
        pendingLocalImportProjects = saved.pendingLocalImportProjects;
        maxProjects = saved.maxProjects;
        saveProjectsToStorage = saved.saveProjectsToStorage;
        renderProjectsList = saved.renderProjectsList;
        showToast = saved.showToast;
        storePendingLocalImport = saved.storePendingLocalImport;
        lsRemove = saved.lsRemove;
        window.confirm = saved.confirm;
        if (saved.pendingStorage === null) localStorage.removeItem('codelab_xd_pending_local_import_v1');
        else localStorage.setItem('codelab_xd_pending_local_import_v1', saved.pendingStorage);
      }
    });
    assert.equal(importLimitCheck.count, 3,
      'Local OAuth import must not exceed the configured project cap');
    assert.ok(importLimitCheck.importedIds.includes('existing-project'),
      'Local OAuth import must preserve existing account projects');
    assert.equal(new Set(importLimitCheck.importedIds).size, importLimitCheck.importedIds.length,
      'Local OAuth import must deduplicate IDs within the imported snapshot');
    assert.equal(importLimitCheck.preservedPending.length, 1,
      'Projects omitted because of the cap must remain recoverable for a later import');

    // If overflow cannot be persisted, abort before replacing the original snapshot.
    const failedPendingImportCheck = await page.evaluate(() => {
      const saved = {
        currentUser, projects, pendingLocalImportProjects, maxProjects,
        saveProjectsToStorage, renderProjectsList, showToast,
        storePendingLocalImport, lsRemove, confirm: window.confirm
      };
      let saveCalls = 0;
      let toast = '';
      try {
        currentUser = { real: true, provider: 'e2e', id: 'import-storage-failure' };
        projects = [{ id: 'account-existing', name: 'Existente', code: { html: '' } }];
        pendingLocalImportProjects = [
          { id: 'overflow-one', name: 'Pendiente 1', code: { html: '' } },
          { id: 'overflow-two', name: 'Pendiente 2', code: { html: '' } }
        ];
        maxProjects = 2;
        saveProjectsToStorage = () => { saveCalls++; };
        renderProjectsList = () => {};
        showToast = message => { toast = message; };
        storePendingLocalImport = () => false;
        lsRemove = () => {};
        window.confirm = () => true;
        maybeOfferLocalImport();
        return { ids: projects.map(project => project.id), saveCalls, warned: toast.includes('No se pudo guardar') };
      } finally {
        currentUser = saved.currentUser;
        projects = saved.projects;
        pendingLocalImportProjects = saved.pendingLocalImportProjects;
        maxProjects = saved.maxProjects;
        saveProjectsToStorage = saved.saveProjectsToStorage;
        renderProjectsList = saved.renderProjectsList;
        showToast = saved.showToast;
        storePendingLocalImport = saved.storePendingLocalImport;
        lsRemove = saved.lsRemove;
        window.confirm = saved.confirm;
      }
    });
    assert.deepEqual(failedPendingImportCheck.ids, ['account-existing'],
      'Failed pending-import persistence must abort before mutating account projects');
    assert.equal(failedPendingImportCheck.saveCalls, 0,
      'Failed pending-import persistence must not overwrite the source snapshot');
    assert.equal(failedPendingImportCheck.warned, true,
      'Failed pending-import persistence must explain that the import was aborted');

    // Logout must not erase the account snapshot if neither server sync nor the
    // account-scoped recovery store can preserve unsynced work.
    const failedLogoutRecoveryCheck = await page.evaluate(async () => {
      const saved = {
        currentUser, projects, pendingLocalImportProjects, persistWorkspace,
        storePendingLocalImport, showToast, fetch: window.fetch
      };
      let toast = '';
      let fetchCalls = 0;
      try {
        currentUser = { real: true, provider: 'e2e', id: 'logout-storage-failure' };
        projects = [{ id: 'unsynced-project', name: 'No perder', code: { html: '<p>trabajo</p>' } }];
        pendingLocalImportProjects = null;
        persistWorkspace = async () => false;
        storePendingLocalImport = () => false;
        showToast = message => { toast = message; };
        window.fetch = async () => { fetchCalls++; return { ok: true }; };
        await logoutAuth();
        return {
          stillAuthenticated: !!currentUser && currentUser.real,
          projectIds: projects.map(project => project.id),
          fetchCalls,
          warned: toast.includes('no se pudieron proteger')
        };
      } finally {
        currentUser = saved.currentUser;
        projects = saved.projects;
        pendingLocalImportProjects = saved.pendingLocalImportProjects;
        persistWorkspace = saved.persistWorkspace;
        storePendingLocalImport = saved.storePendingLocalImport;
        showToast = saved.showToast;
        window.fetch = saved.fetch;
      }
    });
    assert.equal(failedLogoutRecoveryCheck.stillAuthenticated, true,
      'Logout must be aborted when unsynced work cannot be persisted for recovery');
    assert.deepEqual(failedLogoutRecoveryCheck.projectIds, ['unsynced-project'],
      'Logout must preserve the active in-memory project list on recovery failure');
    assert.equal(failedLogoutRecoveryCheck.fetchCalls, 0,
      'Logout must not invalidate the server session before recovery is secured');
    assert.equal(failedLogoutRecoveryCheck.warned, true,
      'Aborted logout must explain how to recover safely');

    // 1. Create and open a real design project through the production dashboard.
    await page.locator('button[onclick="openNewProjectModal()"]').click();
    await page.locator('#newProjectNameInput').fill(PROJECT_NAME);
    await page.locator('input[name="newProjectType"][value="design"]').check();
    await page.locator('button[onclick="createNewProjectConfirm()"]').click();
    await page.waitForFunction(() => {
      const studio = document.getElementById('studioView');
      const design = document.getElementById('designStudioPanel');
      return studio && !studio.classList.contains('hidden') &&
        design && !design.classList.contains('hidden');
    }, { timeout: 10000 });
    assert.equal(await page.locator('#designCanvas [data-design-id]').count(), 0,
      'new design project should start with an empty canvas');
    const layerLimitCheck = await page.evaluate(() => {
      const project = window.activeDesignProject();
      project.design = [];
      const normalized = window.activeDesignProject();
      const designShapeValid = !Array.isArray(normalized.design) && Array.isArray(normalized.design.elements);
      normalized.design.elements = Array.from({ length: 500 }, (_, index) => ({
        id: 'limit-layer-' + index, type: 'heading', label: 'Layer ' + index, text: 'Layer'
      }));
      window.addDesignElement('heading');
      const countAfterAdd = normalized.design.elements.length;
      selectedDesignElementId = 'limit-layer-0';
      selectedDesignElementIds = ['limit-layer-0'];
      window.duplicateDesignElement();
      const countAfterDuplicate = normalized.design.elements.length;
      normalized.design.elements = [
        { id: 'overlap-a', x: 0, y: 0, width: 200, height: 100 },
        { id: 'overlap-b', x: 10, y: 0, width: 200, height: 100 },
        { id: 'overlap-c', x: 20, y: 0, width: 200, height: 100 }
      ];
      selectedDesignElementIds = ['overlap-a', 'overlap-b', 'overlap-c'];
      designUndoStack = [];
      window.distributeDesignElements('horizontal');
      const undoStepsAfterRejectedDistribution = designUndoStack.length;
      normalized.design.elements = [];
      selectedDesignElementId = null;
      selectedDesignElementIds = [];
      window.renderDesignWorkspace();
      return { countAfterAdd, countAfterDuplicate, designShapeValid, undoStepsAfterRejectedDistribution };
    });
    assert.equal(layerLimitCheck.designShapeValid, true,
      'Malformed array-valued design state must normalize to a valid design object');
    assert.equal(layerLimitCheck.countAfterAdd, 500,
      'Adding a layer beyond the visual-design limit must be blocked without mutating the project');
    assert.equal(layerLimitCheck.countAfterDuplicate, 500,
      'Duplicating a layer beyond the visual-design limit must be blocked too');
    assert.equal(layerLimitCheck.undoStepsAfterRejectedDistribution, 0,
      'A rejected layer distribution must not create a fake undo step');

    // 2. Add an element and edit its real property input.
    await page.locator('button[onclick="addDesignElement(\'heading\')"]').click();
    const element = page.locator('#designCanvas [data-design-id]').first();
    try {
      await element.waitFor({ timeout: 10000 });
    } catch (error) {
      throw new Error('Design element did not render after addDesignElement. Browser errors: ' + failures.join(' | ') + '. ' + error.message);
    }
    const textField = page.locator('#designProperties input[type="text"]').first();
    await textField.fill('Prueba integral CodeLab');
    await page.waitForFunction(() => {
      const node = document.querySelector('#designCanvas [data-design-id]');
      return node && node.textContent === 'Prueba integral CodeLab';
    });
    assert.equal(await page.locator('#designCanvas [data-design-id]').count(), 1,
      'adding a heading should render one canvas element');

    // 3. Undo/redo the property edit through the visible controls.
    await page.locator('#designUndoBtn').click();
    await page.waitForFunction(() => {
      const node = document.querySelector('#designCanvas [data-design-id]');
      return node && node.textContent === 'Título de tu diseño';
    });
    await page.locator('#designRedoBtn').click();
    await page.waitForFunction(() => {
      const node = document.querySelector('#designCanvas [data-design-id]');
      return node && node.textContent === 'Prueba integral CodeLab';
    });

    // 4. Drag the actual canvas element with pointer events.
    const before = await element.boundingBox();
    assert.ok(before, 'canvas element should have a visible bounding box');
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 + 45, before.y + before.height / 2 + 32, { steps: 5 });
    await page.mouse.up();
    const moved = await element.evaluate(node => ({ left: parseFloat(node.style.left), top: parseFloat(node.style.top) }));
    assert.ok(moved.left >= 120, 'drag should update the element x coordinate');
    assert.ok(moved.top >= 95, 'drag should update the element y coordinate');

    // 4a. Snap-to-grid rounds the dragged layer to the configured grid size.
    await page.selectOption('#designGridSize', '16');
    assert.equal(await page.locator('#designCanvas').evaluate(node => node.style.backgroundSize), '16px 16px',
      'visible grid spacing should match the selected grid size');
    await page.click('#designSnapBtn');
    const snapBefore = await element.boundingBox();
    assert.ok(snapBefore, 'selected layer should be visible before snap drag');
    await page.mouse.move(snapBefore.x + snapBefore.width / 2, snapBefore.y + snapBefore.height / 2);
    await page.mouse.down();
    await page.mouse.move(snapBefore.x + snapBefore.width / 2 + 7, snapBefore.y + snapBefore.height / 2 + 9, { steps: 3 });
    await page.mouse.up();
    const snapped = await element.evaluate(node => ({ left: parseFloat(node.style.left), top: parseFloat(node.style.top) }));
    assert.equal(snapped.left % 16, 0, 'snapped x coordinate should align to 16 px grid');
    assert.equal(snapped.top % 16, 0, 'snapped y coordinate should align to 16 px grid');
    await page.click('#designSnapBtn');
    await element.focus();

    // 4b. Resize the selected layer directly from its canvas handle.
    const sizeBefore = await element.evaluate(node => ({ width: parseFloat(node.style.width), height: parseFloat(node.style.height) }));
    const resizeHandle = page.locator('[data-design-resize-handle]');
    await resizeHandle.waitFor({ state: 'visible' });
    const handleBox = await resizeHandle.boundingBox();
    assert.ok(handleBox, 'selected canvas layer should expose a visible resize handle');
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + handleBox.width / 2 + 32, handleBox.y + handleBox.height / 2 + 24, { steps: 4 });
    await page.mouse.up();
    const sizeAfter = await element.evaluate(node => ({ width: parseFloat(node.style.width), height: parseFloat(node.style.height) }));
    assert.ok(sizeAfter.width >= sizeBefore.width + 25, 'canvas resize handle should increase layer width');
    assert.ok(sizeAfter.height >= sizeBefore.height + 18, 'canvas resize handle should increase layer height');
    await resizeHandle.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowDown');
    const keyboardSize = await element.evaluate(node => ({ width: parseFloat(node.style.width), height: parseFloat(node.style.height) }));
    assert.equal(keyboardSize.width, sizeAfter.width + 1, 'resize handle ArrowRight should increase width by one pixel');
    assert.equal(keyboardSize.height, sizeAfter.height + 10, 'resize handle Shift+ArrowDown should increase height by ten pixels');

    // 4c. Keyboard nudging and duplication shortcuts operate on the selected layer.
    await element.focus();
    const beforeNudge = await element.evaluate(node => ({ left: parseFloat(node.style.left), top: parseFloat(node.style.top) }));
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowDown');
    const afterNudge = await element.evaluate(node => ({ left: parseFloat(node.style.left), top: parseFloat(node.style.top) }));
    assert.equal(afterNudge.left, beforeNudge.left + 1, 'ArrowRight should nudge the selected layer by one pixel');
    assert.equal(afterNudge.top, beforeNudge.top + 10, 'Shift+ArrowDown should nudge the selected layer by ten pixels');
    await page.keyboard.press('Control+d');
    await page.waitForFunction(() => document.querySelectorAll('#designCanvas [data-design-id]').length === 2);
    await page.keyboard.press('Delete');
    await page.waitForFunction(() => document.querySelectorAll('#designCanvas [data-design-id]').length === 1);

    // 4d. Multi-select three layers from the layer list and distribute them evenly.
    const distributionX = [100, 300, 800];
    const distributionY = [420, 500, 600];
    for (let index = 0; index < distributionX.length; index++) {
      await page.locator('button[onclick="addDesignElement(\'rectangle\')"]').click();
      await page.locator('#designProperty-x').fill(String(distributionX[index]));
      await page.locator('#designProperty-y').fill(String(distributionY[index]));
      await page.locator('#designProperty-width').fill('100');
      await page.locator('#designProperty-height').fill('60');
    }
    const layerRows = page.locator('#designLayers [data-design-select]');
    await layerRows.nth(0).click();
    await layerRows.nth(1).click({ modifiers: ['Shift'] });
    await layerRows.nth(2).click({ modifiers: ['Shift'] });
    await page.locator('button[onclick="distributeDesignElements(\'horizontal\')"]').click();
    const distributed = await page.locator('#designCanvas [data-design-id]').evaluateAll(nodes =>
      nodes.map(node => ({ left: parseFloat(node.style.left), width: parseFloat(node.style.width) }))
        .filter(item => item.width === 100 && item.left >= 100 && item.left <= 900)
        .map(item => item.left).sort((a, b) => a - b));
    assert.deepEqual(distributed.slice(0, 3), [100, 450, 800],
      'multi-select distribution should create equal gaps while preserving first/last bounds');
    await page.locator('button[aria-label="Alinear arriba"]').click();
    const alignedTops = await page.locator('#designCanvas [data-design-id]').evaluateAll(nodes =>
      nodes.map(node => ({ top: parseFloat(node.style.top), left: parseFloat(node.style.left), width: parseFloat(node.style.width) }))
        .filter(item => item.width === 100 && item.left >= 100 && item.left <= 900)
        .map(item => item.top));
    assert.deepEqual(alignedTops.slice(0, 3), [420, 420, 420],
      'multi-select alignment should align all selected layer tops to the shared selection edge');

    // 4e. Auto Layout uses direction, spacing and padding to calculate live layer positions.
    await page.locator('#designLayoutMode').selectOption('auto');
    await page.locator('#designLayoutDirection').selectOption('column');
    await page.locator('#designLayoutGap').fill('24');
    await page.locator('#designLayoutGap').dispatchEvent('change');
    await page.locator('#designLayoutPadding').fill('20');
    await page.locator('#designLayoutPadding').dispatchEvent('change');
    const autoLayoutPositions = await page.locator('#designCanvas [data-design-id]').evaluateAll(nodes =>
      nodes.map(node => ({ left: parseFloat(node.style.left), top: parseFloat(node.style.top), width: parseFloat(node.style.width), height: parseFloat(node.style.height) }))
        .filter(item => item.width === 100).sort((a, b) => a.top - b.top));
    assert.equal(autoLayoutPositions.length, 3, 'Auto Layout should keep all selected layers in the flow');
    assert.ok(autoLayoutPositions.every(item => item.left === 20), 'column Auto Layout should apply left padding');
    assert.equal(autoLayoutPositions[1].top - autoLayoutPositions[0].top - autoLayoutPositions[0].height, 24,
      'column Auto Layout should apply configured spacing between layers');
    assert.equal(autoLayoutPositions[2].top - autoLayoutPositions[1].top - autoLayoutPositions[1].height, 24,
      'column Auto Layout should apply configured spacing consistently');
    await page.selectOption('#designFrameSize', 'mobile');
    await page.locator('#designLayoutDirection').selectOption('row');
    const rowLayoutPositions = await page.locator('#designCanvas [data-design-id]').evaluateAll(nodes =>
      nodes.map(node => ({ left: parseFloat(node.style.left), top: parseFloat(node.style.top), width: parseFloat(node.style.width) }))
        .filter(item => item.width === 100).sort((a, b) => a.left - b.left));
    assert.deepEqual(rowLayoutPositions.map(item => item.left), [20, 144, 268],
      'row Auto Layout should wrap the oversized heading and pack the three smaller layers into the mobile frame');
    assert.equal(rowLayoutPositions[0].top, rowLayoutPositions[2].top,
      'layers fitting on the same row should share a top position');
    await page.selectOption('#designFrameSize', 'desktop');
    await page.locator('#designLayoutDirection').selectOption('column');
    await page.locator('button[onclick="deleteDesignElement()"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#designCanvas [data-design-id]').length === 1);
    await element.click();

    // 5. Duplicate and delete through the production layer controls.
    await element.click();
    await page.locator('button[onclick="duplicateDesignElement()"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#designCanvas [data-design-id]').length === 2);
    await page.locator('button[onclick="deleteDesignElement()"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#designCanvas [data-design-id]').length === 1);
    assert.equal(await page.locator('#designCanvas [data-design-id]').first().innerText(), 'Prueba integral CodeLab');

    // 5b. Add a local image file, edit its alt text, and verify it renders as a real layer.
    await page.locator('button[onclick="addDesignElement(\'image\')"]').click();
    const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/3XcAAAAASUVORK5CYII=';
    await page.locator('#designImageFile').setInputFiles({
      name: 'codelab-fixture.png',
      mimeType: 'image/png',
      buffer: Buffer.from(tinyPng, 'base64')
    });
    await page.waitForFunction(() => {
      const image = document.querySelector('#designCanvas [data-design-id] img');
      return image && image.complete && image.naturalWidth > 0;
    }, null, { timeout: 10000 });
    assert.equal(await page.locator('#designProperty-src').inputValue(), '',
      'embedded image bytes should stay in project state, not be copied into a giant URL input value');
    await page.locator('#designProperty-alt').fill('E2E sample image');
    await page.waitForFunction(() => {
      const image = document.querySelector('#designCanvas [data-design-id] img');
      return image && image.alt === 'E2E sample image';
    });
    assert.equal(await page.locator('#designCanvas [data-design-id]').count(), 2,
      'image should be added as a separate editable layer');

    // 5b. Layer order can be changed from the selected-layer properties panel.
    const layerLabels = () => page.locator('#designCanvas [data-design-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
    assert.deepEqual(await layerLabels(), ['Título', 'Imagen']);
    await page.click('#designLayerDown');
    assert.deepEqual(await layerLabels(), ['Imagen', 'Título'], 'sending a layer back should change render order');
    await page.click('#designLayerUp');
    assert.deepEqual(await layerLabels(), ['Título', 'Imagen'], 'bringing a layer forward should restore render order');

    // 5c. Ellipse layers remain oval in the editable canvas.
    await page.locator('button[onclick="addDesignElement(\'ellipse\')"]').click();
    assert.equal(await page.locator('#designCanvas [data-design-id]').count(), 3);
    assert.equal(await page.locator('#designCanvas [data-design-id]').last().evaluate(node => node.style.borderRadius), '50%',
      'ellipse should use a true oval border radius');

    // 5d. Apply a full-page template and undo it without losing the prior design.
    await page.click('#designTemplatesButton');
    await page.waitForSelector('#designTemplatesMenu:not(.hidden)');
    page.once('dialog', dialog => dialog.accept());
    await page.click('#designTemplateDashboard');
    await page.waitForFunction(() => document.querySelectorAll('#designCanvas [data-design-id]').length === 11);
    assert.ok((await page.locator('#designCanvas').innerText()).includes('Panel de control'),
      'dashboard template should populate a complete starter layout');
    assert.equal(await page.locator('#designCanvas').evaluate(node => node.style.backgroundColor), 'rgb(248, 250, 252)');
    await page.click('#designUndoBtn');
    await page.waitForFunction(() => {
      const nodes = Array.from(document.querySelectorAll('#designCanvas [data-design-id]'));
      return nodes.length === 3 && nodes.some(node => node.innerText === 'Prueba integral CodeLab') &&
        !!document.querySelector('#designCanvas [data-design-id] img[alt="E2E sample image"]');
    });
    assert.equal(await page.locator('#designCanvas').evaluate(node => node.style.backgroundColor), 'rgb(255, 255, 255)',
      'undo should restore the original background as well as the original layers');

    // 6. Exercise responsive frame presets and mobile overflow behavior.
    await page.selectOption('#designFrameSize', 'tablet');
    assert.equal(await page.locator('#designCanvas').evaluate(node => node.style.width), '768px');
    await page.selectOption('#designFrameSize', 'mobile');
    assert.equal(await page.locator('#designCanvas').evaluate(node => node.style.width), '390px');
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileLayout = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      canvasWidth: document.getElementById('designCanvas').getBoundingClientRect().width,
      scrollContainerExists: !!document.getElementById('designCanvasScroll')
    }));
    assert.ok(mobileLayout.scrollContainerExists, 'mobile canvas scroll container should exist');
    assert.ok(mobileLayout.documentWidth <= mobileLayout.viewportWidth + 2,
      'mobile app shell should not introduce document-level horizontal overflow');

    // 6b. Exercise the actual AI capture flow and inspect both generated artifacts.
    const captureDownloads = [];
    const captureDownloadsReady = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        page.off('download', onCaptureDownload);
        reject(new Error('AI capture did not produce both context and image artifacts'));
      }, 15000);
      function onCaptureDownload(download) {
        captureDownloads.push(download);
        if (captureDownloads.length >= 2) {
          clearTimeout(timeout);
          page.off('download', onCaptureDownload);
          resolve();
        }
      }
      page.on('download', onCaptureDownload);
    });
    await page.selectOption('#designCaptureScale', '4');
    await page.locator('button[onclick="captureDesignForAI()"]').click();
    await captureDownloadsReady;
    const captureFiles = await Promise.all(captureDownloads.map(async download => ({
      name: download.suggestedFilename(),
      path: await download.path()
    })));
    const contextFile = captureFiles.find(file => /-contexto-ia\.json$/.test(file.name));
    const imageFile = captureFiles.find(file => /-captura-ia\.(png|svg)$/.test(file.name));
    assert.ok(contextFile, 'AI capture should export structured context JSON');
    assert.ok(imageFile, 'AI capture should export a visual artifact (PNG or SVG fallback)');
    const captureContext = JSON.parse(await fs.readFile(contextFile.path, 'utf8'));
    assert.equal(captureContext.format, 'codelab-ai-design-capture');
    assert.equal(captureContext.layout.mode, 'auto', 'AI context should record Auto Layout mode');
    assert.equal(captureContext.layout.direction, 'column', 'AI context should record Auto Layout direction');
    assert.equal(captureContext.layout.gap, 24, 'AI context should record Auto Layout spacing');
    assert.equal(captureContext.layout.padding, 20, 'AI context should record Auto Layout padding');
    assert.ok(captureContext.elementCount >= 1, 'capture context should include the canvas element');
    assert.ok(captureContext.elements.some(item => item.type === 'image' && item.image && item.image.alt === 'E2E sample image'),
      'AI context should preserve image alt text without embedding the base64 payload again');
    assert.equal(captureContext.canvas.scale, 4, 'design capture context should record the selected maximum 4× resolution');
    assert.equal(captureContext.canvas.pixelWidth, captureContext.canvas.width * 4, 'context pixel width should match the selected scale');
    assert.equal(captureContext.canvas.pixelHeight, captureContext.canvas.height * 4, 'context pixel height should match the selected scale');
    assert.ok(captureContext.elements.some(item => item.text === 'Prueba integral CodeLab'),
      'capture context should preserve the actual edited element text');
    if (/\.png$/.test(imageFile.name)) {
      const png = await fs.readFile(imageFile.path);
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a',
        'successful PNG capture should produce a valid PNG signature');
      assert.equal(png.readUInt32BE(16), captureContext.canvas.pixelWidth, 'PNG width should match capture context');
      assert.equal(png.readUInt32BE(20), captureContext.canvas.pixelHeight, 'PNG height should match capture context');
    } else {
      assert.match(await fs.readFile(imageFile.path, 'utf8'), /<svg[\s>]/i,
        'SVG fallback should contain an SVG document');
    }

    // 6c. Configure a safe button destination to exercise prototype navigation.
    await page.locator('button[onclick="addDesignElement(\'button\')"]').click();
    const internalTarget = await page.locator('#designPrototypeTarget option').nth(1).getAttribute('value');
    assert.ok(internalTarget && internalTarget.startsWith('#layer-'), 'prototype editor should offer internal layer destinations');
    await page.locator('#designPrototypeTarget').selectOption(internalTarget);
    assert.equal(await page.evaluate(() => window.activeDesignProject().design.elements.find(item => item.type === 'button')?.href || ''),
      internalTarget, 'choosing an internal target should update the prototype button');
    await page.click('#designExportMenuButton');
    await page.waitForSelector('#designExportMenu:not(.hidden)');
    const internalHtmlReady = page.waitForEvent('download');
    await page.locator('#designExportMenu [role="menuitem"]').filter({ hasText: 'HTML adaptable' }).click();
    const internalHtmlDownload = await internalHtmlReady;
    const internalHtml = await fs.readFile(await internalHtmlDownload.path(), 'utf8');
    assert.ok(internalHtml.includes('href="' + internalTarget + '"'), 'HTML export should preserve internal layer navigation');
    assert.ok(internalHtml.includes('id="' + internalTarget.slice(1) + '"'), 'HTML export should assign stable anchor IDs to target layers');
    await page.locator('#designProperty-href').fill('javascript:alert(1)');
    assert.equal(await page.evaluate(() => window.activeDesignProject().design.elements.find(item => item.type === 'button')?.href || ''),
      '', 'prototype destinations must reject javascript URLs');
    await page.locator('#designProperty-href').fill('https://example.com/docs');
    assert.equal(await page.evaluate(() => {
      const project = window.activeDesignProject();
      return project.design.elements.find(item => item.type === 'button')?.href || '';
    }), 'https://example.com/docs', 'prototype buttons should keep normalized HTTP(S) destinations only');

    // 6d. Verify the three explicit export formats through the real UI.
    await page.click('#designExportMenuButton');
    await page.waitForSelector('#designExportMenu:not(.hidden)');
    const htmlExportReady = page.waitForEvent('download');
    await page.locator('#designExportMenu [role="menuitem"]').filter({ hasText: 'HTML adaptable' }).click();
    const htmlExport = await htmlExportReady;
    assert.match(htmlExport.suggestedFilename(), /\.html$/i, 'HTML export should have an HTML filename');
    const htmlExportPath = await htmlExport.path();
    const exportedHtml = await fs.readFile(htmlExportPath, 'utf8');
    assert.match(exportedHtml, /<!doctype html>/i, 'HTML export should contain a standalone document');
    assert.match(exportedHtml, /class="design-viewport"/, 'HTML export should use a viewport wrapper');
    assert.match(exportedHtml, /addEventListener\("resize",fit/, 'HTML export should recalculate scale on resize');
    assert.match(exportedHtml, /f\.style\.transform/, 'HTML export should apply a visual scale to the fixed design canvas');
    assert.match(exportedHtml, /class="design-frame auto-layout"/, 'HTML export should preserve Auto Layout mode');
    assert.match(exportedHtml, /display:flex;flex-direction:column/, 'HTML export should use a flow layout instead of absolute positioning');
    assert.match(exportedHtml, /gap:24px;padding:20px/, 'HTML export should preserve Auto Layout spacing and padding');
    assert.match(exportedHtml, /window\.innerWidth\/w/, 'HTML export should calculate scale from the current viewport width');
    assert.match(exportedHtml, /<img\b[^>]*\bsrc="data:image\/png;base64,/, 'HTML export should include the embedded image asset regardless of safe attribute ordering');
    assert.match(exportedHtml, /alt="E2E sample image"/, 'HTML export should preserve the image alt text');
    assert.match(exportedHtml, /border-radius:50%/, 'HTML export should preserve ellipse geometry');
    assert.match(exportedHtml, /href="https:\/\/example\.com\/docs" target="_blank" rel="noopener noreferrer"/,
      'HTML export should preserve the safe prototype destination with safe new-tab attributes');

    await page.click('#designExportMenuButton');
    await page.waitForSelector('#designExportMenu:not(.hidden)');
    const svgExportReady = page.waitForEvent('download');
    await page.click('#exportDesignSvgOption');
    const svgExport = await svgExportReady;
    assert.match(svgExport.suggestedFilename(), /\.svg$/i, 'SVG export should have an SVG filename');
    assert.match(await fs.readFile(await svgExport.path(), 'utf8'), /<svg[\s>]/i, 'SVG export should preserve vector markup');
    assert.match(await fs.readFile(await svgExport.path(), 'utf8'), /<image href="data:image\/png;base64,/, 'SVG export should preserve the embedded image layer');
    assert.match(await fs.readFile(await svgExport.path(), 'utf8'), /<ellipse cx=/, 'SVG export should preserve ellipse geometry');

    await page.click('#designExportMenuButton');
    await page.waitForSelector('#designExportMenu:not(.hidden)');
    const jsonExportReady = page.waitForEvent('download');
    await page.click('#exportDesignJsonOption');
    const jsonExport = await jsonExportReady;
    assert.match(jsonExport.suggestedFilename(), /-proyecto\.json$/i, 'Project backup should have a JSON filename');
    const projectBackup = JSON.parse(await fs.readFile(await jsonExport.path(), 'utf8'));
    assert.equal(projectBackup.format, 'codelab-design-project');
    assert.equal(projectBackup.project.type, 'design');
    assert.ok(Array.isArray(projectBackup.project.design.elements), 'JSON backup should preserve editable design elements');
    assert.equal(projectBackup.project.design.elements.find(item => item.type === 'image')?.alt, 'E2E sample image',
      'JSON backup should preserve image metadata');

    // 7. Verify recovery of newer local edits and an offline deletion after reload.
    await page.selectOption('#designFrameSize', 'desktop');
    await waitForPersistedProject(page, PROJECT_NAME);
    const deletedDefaultId = await page.evaluate(name => {
      const projects = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || '[]');
      const storedProject = projects.find(item => item.name === name);
      const project = typeof window.getCurrentProject === 'function' ? window.getCurrentProject() : storedProject;
      const starter = projects.find(item => item.name === 'Mi Primer Proyecto');
      if (!project || !project.design || !project.design.elements.length || !starter) return null;
      // Mutate both the live in-memory project and its local snapshot, so the
      // page's beforeunload handler preserves the simulated offline edit.
      project.design.elements[0].text = 'Edición local recuperada';
      project.updatedAt = new Date().toISOString();
      if (storedProject) {
        storedProject.design = JSON.parse(JSON.stringify(project.design));
        storedProject.updatedAt = project.updatedAt;
      }
      localStorage.setItem('codelab_xd_projects_v2', JSON.stringify(projects));
      // Simulate a deletion that has not yet been confirmed by the server.
      localStorage.setItem('codelab_xd_deleted_project_id_for_e2e', starter.id);
      localStorage.setItem('codelab_xd_deleted_projects_v1', JSON.stringify({
        workspaceId: localStorage.getItem('codelab_xd_workspace_v4'),
        ids: [starter.id]
      }));
      return starter.id;
    }, PROJECT_NAME);
    assert.ok(deletedDefaultId, 'fixture should include the starter project and design project');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('syncLoadingModal')?.classList.contains('hidden'), null, { timeout: 15000 });
    const projectCard = page.locator('#projectsGrid > div').filter({ hasText: PROJECT_NAME });
    await projectCard.locator('button[data-action="open"]').click();
    await page.waitForFunction(() => {
      const design = document.getElementById('designStudioPanel');
      return design && !design.classList.contains('hidden') &&
        document.querySelector('#designCanvas [data-design-id]');
    }, { timeout: 10000 });
    assert.equal(await page.locator('#designCanvas [data-design-id]').first().innerText(), 'Edición local recuperada',
      'a newer local edit must not be overwritten by the server snapshot');
    // Selection is intentionally not persisted; select the element again to edit its properties.
    await page.locator('#designCanvas [data-design-id]').first().click();
    await page.locator('#designProperties input[type="text"]').first().fill('Prueba integral CodeLab');
    await page.waitForFunction(() => document.querySelector('#designCanvas [data-design-id]')?.textContent === 'Prueba integral CodeLab');
    await waitForPersistedProject(page, PROJECT_NAME);
    await page.waitForFunction(async id => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const token = localStorage.getItem('codelab_xd_workspace_token_v1');
      try {
        const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId), {
          headers: { 'x-workspace-token': token }
        });
        if (!response.ok) return false;
        const data = await response.json();
        return !(data.projects || []).some(project => project.id === id);
      } catch (_) { return false; }
    }, deletedDefaultId, { timeout: 10000 });
    await page.evaluate(() => localStorage.removeItem('codelab_xd_deleted_project_id_for_e2e'));

    // 8. Convert the saved design into a web project and inspect the generated HTML.
    await page.locator('button[onclick="convertDesignToWeb()"]').click();
    await page.waitForFunction(() => {
      const design = document.getElementById('designStudioPanel');
      const editor = document.getElementById('editorPanel');
      return design && design.classList.contains('hidden') && editor && !editor.classList.contains('hidden');
    }, { timeout: 10000 });
    const convertedHandle = await page.waitForFunction(async name => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const token = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !token) return false;
      try {
        const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId), {
          headers: { 'x-workspace-token': token }
        });
        if (!response.ok) return false;
        const data = await response.json();
        return (data.projects || []).find(project =>
          project.name === name + ' · Web' &&
          project.type === 'web' &&
          project.code &&
          project.code.html.includes('Prueba integral CodeLab')
        ) || false;
      } catch (_) {
        return false;
      }
    }, PROJECT_NAME, { timeout: 15000 });
    const converted = await convertedHandle.jsonValue();
    assert.equal(converted.type, 'web');
    assert.match(converted.name, /Web/);
    assert.match(converted.code.html, /Prueba integral CodeLab/,
      'converted web project should include the edited design content');
    assert.match(converted.code.html, /name="viewport"/,
      'converted web project should include a responsive viewport meta tag');
    assert.match(converted.code.html, /<img\b[^>]*\bsrc="data:image\/png;base64,/,
      'design-to-web conversion should preserve embedded image layers regardless of safe attribute ordering');
    assert.match(converted.code.html, /border-radius:50%/,
      'design-to-web conversion should preserve ellipse geometry');
    assert.match(converted.code.html, /addEventListener\("resize",fit/,
      'converted page should resize its design frame to the viewport');
    assert.match(converted.code.html, /class="design-frame auto-layout"/,
      'design-to-web conversion should preserve Auto Layout mode');
    assert.match(converted.code.html, /flex-direction:column/,
      'design-to-web conversion should preserve the flow direction');
    assert.match(converted.code.html, /href="https:\/\/example\.com\/docs" target="_blank" rel="noopener noreferrer"/,
      'design-to-web conversion should preserve the safe prototype navigation destination');

    // Monaco loads asynchronously; wait until the editor reflects the active project
    // rather than asserting against the previous design project's stale editor contents.
    await page.waitForFunction(() => {
      const project = typeof window.getCurrentProject === 'function' ? window.getCurrentProject() : null;
      return project && project.type === 'web' &&
        typeof window.getEditorValue === 'function' &&
        window.getEditorValue('html') === project.code.html;
    }, { timeout: 15000 });

    // 9. Return to the dashboard (where the component-library entry point lives),
    // keeping the converted project selected for insertion and persistence checks.
    await page.locator('button[onclick="returnToDashboard()"]').click();
    await page.locator('#welcomeDashboard').waitFor({ state: 'visible' });
    // 9a. Save design tokens through the real dialog, verify server persistence,
    // reload the app, and ensure the UI restores the server-backed settings.
    await page.locator('#openDesignTools').click();
    await page.locator('#designToolsModal').waitFor({ state: 'visible' });
    await page.locator('#systemName').fill('Sistema integral E2E');
    await page.locator('#colorPrimary').evaluate(input => {
      input.value = '#123abc';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('#saveDesignSystem').click();
    await page.waitForFunction(async expected => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const token = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !token) return false;
      try {
        const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/design-system', {
          headers: { 'x-workspace-token': token }
        });
        if (!response.ok) return false;
        const data = await response.json();
        return data.settings && data.settings.name === expected && data.settings.primary === '#123abc';
      } catch (_) { return false; }
    }, 'Sistema integral E2E', { timeout: 15000 });
    // Validate the export artifact as part of the same user journey.
    await page.locator('#designToolsTab-tokens').click();
    const tokenDownloadPromise = page.waitForEvent('download');
    await page.locator('#exportDesignSystemJson').click();
    const tokenDownload = await tokenDownloadPromise;
    const tokenPath = await tokenDownload.path();
    const exportedTokens = JSON.parse(await fs.readFile(tokenPath, 'utf8'));
    assert.equal(exportedTokens.format, 'codelab-design-system');
    assert.equal(exportedTokens.name, 'Sistema integral E2E');
    assert.equal(exportedTokens.colors.primary, '#123abc');

    // Verify export → edit → import round-trip through the actual UI and workspace.
    await page.locator('#colorPrimary').evaluate(input => {
      input.value = '#654321';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('#designSystemJsonFile').setInputFiles({
      name: 'codelab-design-system.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(exportedTokens))
    });
    await page.waitForFunction(() =>
      document.getElementById('systemName')?.value === 'Sistema integral E2E' &&
      document.getElementById('colorPrimary')?.value.toLowerCase() === '#123abc'
    , null, { timeout: 10000 });
    await page.waitForFunction(async () => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const token = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !token) return false;
      try {
        const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId) + '/design-system', {
          headers: { 'x-workspace-token': token }
        });
        if (!response.ok) return false;
        const data = await response.json();
        return data.settings && data.settings.primary === '#123abc';
      } catch (_) { return false; }
    }, null, { timeout: 15000 });

    await page.locator('#designToolsCloseFooter').click();
    // Remove the browser fallback so the next page load must recover these
    // values from the server-backed workspace design-system endpoint.
    await page.evaluate(() => localStorage.removeItem('codelab-design-system-v1'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('syncLoadingModal')?.classList.contains('hidden'), null, { timeout: 15000 });
    await page.locator('#openDesignTools').click();
    await page.locator('#designToolsModal').waitFor({ state: 'visible' });
    await page.waitForFunction(() =>
      document.getElementById('systemName')?.value === 'Sistema integral E2E' &&
      document.getElementById('colorPrimary')?.value.toLowerCase() === '#123abc'
    , null, { timeout: 10000 });
    await page.locator('#designToolsCloseFooter').click();

    // A reload intentionally resets the active editor selection. Re-open the
    // converted project explicitly before testing component insertion so this
    // journey verifies project selection as well as the component dialog.
    const convertedProjectCard = page.locator('#projectsGrid > div').filter({
      has: page.locator('h4', { hasText: PROJECT_NAME + ' · Web' })
    });
    await convertedProjectCard.locator('button[data-action="open"]').click();
    await page.waitForFunction(async name => {
      const project = typeof window.getCurrentProject === 'function' ? window.getCurrentProject() : null;
      return project && project.name === name + ' · Web' && project.type === 'web' &&
        typeof window.getEditorValue === 'function' &&
        window.getEditorValue('html') === project.code.html;
    }, PROJECT_NAME, { timeout: 15000 });
    await page.locator('button[onclick="returnToDashboard()"]').click();
    await page.locator('#welcomeDashboard').waitFor({ state: 'visible' });

    // Exercise the real component-library integration on the converted web project.
    await page.locator('#openComponentLibrary').click();
    await page.locator('#componentLibraryModal').waitFor({ state: 'visible' });
    // A zero-result filter must not leave a stale component available to insert/export.
    // The editor panel is hidden on the dashboard, so its current editor value
    // may be stale/empty. Compare the active project's persisted code instead.
    const htmlBeforeEmptyFilter = await page.evaluate(() => {
      const project = window.getCurrentProject();
      return project && project.code ? project.code.html : '';
    });
    await page.locator('#componentLibrarySearch').fill('no-such-component-should-match');
    await page.waitForFunction(() => document.getElementById('componentLibraryCode')?.value === '');
    for (const id of ['componentLibraryCopy', 'componentLibraryDownload', 'componentLibraryInsert']) {
      assert.equal(await page.locator('#' + id).isDisabled(), true,
        id + ' must be disabled when component search has no results');
    }
    assert.equal(await page.evaluate(() => {
      const project = window.getCurrentProject();
      return project && project.code ? project.code.html : '';
    }), htmlBeforeEmptyFilter,
      'Searching for a missing component must not mutate the active project');
    await page.locator('#componentLibrarySearch').fill('');
    await page.waitForFunction(() => document.querySelectorAll('#componentLibraryList [data-component-id]').length === 8);
    assert.equal(await page.locator('#componentLibraryInsert').isDisabled(), false,
      'Restoring results should re-enable component insertion');
    // Simulate one server-side rate limit and verify the client retries the real save.
    let injectedWorkspaceRateLimit = false;
    let injectedWorkspaceTooLarge = false;
    let allowWorkspaceTooLarge = false;
    let injectedWorkspaceValidationError = false;
    let allowWorkspaceValidationError = false;
    let workspacePutRequests = 0;
    await page.route('**/api/workspace/**', async route => {
      if (route.request().method() === 'PUT') {
        workspacePutRequests += 1;
        if (allowWorkspaceTooLarge && !injectedWorkspaceTooLarge) {
          injectedWorkspaceTooLarge = true;
          await route.fulfill({
            status: 413,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'payload_too_large' })
          });
          return;
        }
        if (allowWorkspaceValidationError && !injectedWorkspaceValidationError) {
          injectedWorkspaceValidationError = true;
          await route.fulfill({
            status: 400,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'invalid_payload', detail: 'duplicate_project_id' })
          });
          return;
        }
        if (!injectedWorkspaceRateLimit) {
          injectedWorkspaceRateLimit = true;
          await route.fulfill({
            status: 429,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'rate_limited', message: 'Test rate limit' })
          });
          return;
        }
      }
      await route.continue();
    });
    await page.locator('#componentLibraryInsert').click();
    const insertedHtml = await page.evaluate(() => window.getEditorValue('html'));
    assert.match(insertedHtml, /cl-hero/,
      'component insertion should update the real HTML editor');
    await page.locator('#closeComponentLibrary').click();
    await page.waitForFunction(async name => {
      const workspaceId = localStorage.getItem('codelab_xd_workspace_v4');
      const token = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!workspaceId || !token) return false;
      try {
        const response = await fetch('/api/workspace/' + encodeURIComponent(workspaceId), {
          headers: { 'x-workspace-token': token }
        });
        if (!response.ok) return false;
        const data = await response.json();
        const project = (data.projects || []).find(item => item.name === name + ' · Web');
        return !!(project && project.code && project.code.html && /cl-hero/.test(project.code.html));
      } catch (_) {
        return false;
      }
    }, PROJECT_NAME, { timeout: 15000 });

    // A 413 is a payload-size condition, not a connectivity outage. The local
    // copy must remain available and a later smaller save must restore sync.
    allowWorkspaceTooLarge = true;
    await page.evaluate(async () => { await window.persistWorkspace(); });
    await page.waitForFunction(() =>
      document.getElementById('dashSyncBadge')?.textContent.includes('Solo local')
    , null, { timeout: 5000 });
    assert.equal(injectedWorkspaceTooLarge, true, 'E2E should inject one workspace payload-size response');
    allowWorkspaceTooLarge = false;
    await page.evaluate(async () => { await window.persistWorkspace(); });
    await page.waitForFunction(() =>
      !document.getElementById('dashSyncBadge')?.textContent.includes('Solo local')
    , null, { timeout: 5000 });

    // A 400 payload-validation response means the server is reachable. The
    // client must keep sync recoverable and succeed when the next save is valid.
    allowWorkspaceValidationError = true;
    await page.evaluate(async () => { await window.persistWorkspace(); });
    await page.waitForFunction(() =>
      document.getElementById('dashSyncBadge')?.textContent.includes('Sincronización pendiente')
    , null, { timeout: 5000 });
    assert.equal(injectedWorkspaceValidationError, true, 'E2E should inject one workspace validation response');
    allowWorkspaceValidationError = false;
    await page.evaluate(async () => { await window.persistWorkspace(); });
    await page.waitForFunction(() =>
      !document.getElementById('dashSyncBadge')?.textContent.includes('Sincronización pendiente')
    , null, { timeout: 5000 });

    await page.unroute('**/api/workspace/**');
    assert.equal(injectedWorkspaceRateLimit, true, 'E2E should inject one workspace rate limit');
    assert.ok(workspacePutRequests >= 3, 'E2E should observe saves, retry, and size-limit recovery');

    // Ctrl+S must reflect the actual persistence result rather than announcing
    // success while the workspace save is rejected.
    const keyboardSaveCheck = await page.evaluate(async () => {
      const saved = {
        inCopyBranch, currentProjectId,
        saveCurrentCodeToActiveProject: window.saveCurrentCodeToActiveProject,
        showToast: window.showToast
      };
      let toast = '', kind = '';
      try {
        const activeProject = getCurrentProject() || projects[0];
        if (!activeProject) return { toast: 'no active project', kind: 'error' };
        currentProjectId = activeProject.id;
        inCopyBranch = false;
        window.saveCurrentCodeToActiveProject = async () => false;
        window.showToast = (message, severity) => { toast = message; kind = severity || ''; };
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: 's', ctrlKey: true, bubbles: true, cancelable: true
        }));
        await new Promise(resolve => setTimeout(resolve, 0));
        return { toast, kind };
      } finally {
        inCopyBranch = saved.inCopyBranch;
        currentProjectId = saved.currentProjectId;
        window.saveCurrentCodeToActiveProject = saved.saveCurrentCodeToActiveProject;
        window.showToast = saved.showToast;
      }
    });
    assert.match(keyboardSaveCheck.toast, /no se confirmó el guardado\/sincronización/i,
      'Ctrl+S must not report a successful save when persistence returns false');
    assert.equal(keyboardSaveCheck.kind, 'warn',
      'an unconfirmed Ctrl+S save should be shown as a warning');

    // Branch creation must not announce server synchronization when persistence fails.
    const branchCreationCheck = await page.evaluate(async () => {
      const project = getCurrentProject();
      if (!project) return { hasProject: false, toast: '' };
      const saved = {
        inCopyBranch, projectBranch: project.branch, copyBaseCode, copyProjectCode,
        copyBranchId, isCopyBranchCreated,
        saveCurrentCodeToActiveProject: window.saveCurrentCodeToActiveProject,
        persistBranch: window.persistBranch,
        updateBranchButtons: window.updateBranchButtons,
        showToast: window.showToast
      };
      let toast = '', kind = '';
      try {
        inCopyBranch = false;
        window.saveCurrentCodeToActiveProject = async () => true;
        window.persistBranch = async () => false;
        window.updateBranchButtons = () => {};
        window.showToast = (message, severity) => { toast = message; kind = severity || ''; };
        await duplicateProject();
        return { hasProject: true, toast, kind };
      } finally {
        inCopyBranch = saved.inCopyBranch;
        if (saved.projectBranch === undefined) delete project.branch;
        else project.branch = saved.projectBranch;
        copyBaseCode = saved.copyBaseCode;
        copyProjectCode = saved.copyProjectCode;
        copyBranchId = saved.copyBranchId;
        isCopyBranchCreated = saved.isCopyBranchCreated;
        window.saveCurrentCodeToActiveProject = saved.saveCurrentCodeToActiveProject;
        window.persistBranch = saved.persistBranch;
        window.updateBranchButtons = saved.updateBranchButtons;
        window.showToast = saved.showToast;
      }
    });
    assert.equal(branchCreationCheck.hasProject, true, 'branch-creation regression requires an active project');
    assert.match(branchCreationCheck.toast, /no se confirmó la sincronización/i,
      'branch creation should warn when server persistence is not confirmed');
    assert.equal(branchCreationCheck.kind, 'warn',
      'unconfirmed branch persistence should use warning severity');

    // A merge must stop if the branch could not be saved or the main workspace
    // could not be refreshed; otherwise a stale server snapshot can discard edits.
    const mergeGuard = await page.evaluate(async () => {
      const project = getCurrentProject();
      const saved = {
        inCopyBranch,
        projectBranch: project && project.branch,
        saveInCopyBranch: window.saveInCopyBranch,
        refreshWorkspaceFromServer: window.refreshWorkspaceFromServer,
        showToast: window.showToast
      };
      let refreshCalled = false;
      let toast = '';
      try {
        if (!project) return { refreshCalled: false, toast: 'no active project' };
        project.branch = { id: 'merge-guard-fixture' };
        inCopyBranch = true;
        window.saveInCopyBranch = async () => false;
        window.refreshWorkspaceFromServer = async () => { refreshCalled = true; return true; };
        window.showToast = message => { toast = message; };
        await mergeToMainProject();
        return { refreshCalled, toast };
      } finally {
        inCopyBranch = saved.inCopyBranch;
        if (project) {
          if (saved.projectBranch === undefined) delete project.branch;
          else project.branch = saved.projectBranch;
        }
        window.saveInCopyBranch = saved.saveInCopyBranch;
        window.refreshWorkspaceFromServer = saved.refreshWorkspaceFromServer;
        window.showToast = saved.showToast;
      }
    });
    assert.equal(mergeGuard.refreshCalled, false,
      'merge must not replace local state with a server snapshot when branch save fails');
    assert.match(mergeGuard.toast, /sincroniza la copia/i,
      'merge should explain why it stopped');

    // Malformed array envelopes must not be treated as account/workspace maps:
    // assigning named keys to arrays is lost by JSON.stringify and would erase
    // deletion tombstones or pending imports on the next write.
    const malformedMapChecks = await page.evaluate(() => {
      const deletedKey = 'codelab_xd_deleted_projects_v1';
      const pendingKey = 'codelab_xd_pending_local_import_v1';
      const oldDeleted = localStorage.getItem(deletedKey);
      const oldPending = localStorage.getItem(pendingKey);
      try {
        localStorage.setItem(deletedKey, JSON.stringify({ byWorkspace: [] }));
        localStorage.setItem(pendingKey, JSON.stringify({ byUser: [] }));
        const deletedMap = readDeletedProjectMap();
        const pendingMap = readPendingLocalImportMap();
        recordDeletedProjectId('malformed-map-test-id');
        const persistedDeleted = JSON.parse(localStorage.getItem(deletedKey) || '{}');
        return {
          deletedMapIsObject: !Array.isArray(deletedMap) && Object.keys(deletedMap).length === 0,
          pendingMapIsObject: !Array.isArray(pendingMap) && Object.keys(pendingMap).length === 0,
          tombstonePersisted: Array.isArray(persistedDeleted.byWorkspace?.[workspaceId]) &&
            persistedDeleted.byWorkspace[workspaceId].includes('malformed-map-test-id')
        };
      } finally {
        if (oldDeleted === null) localStorage.removeItem(deletedKey); else localStorage.setItem(deletedKey, oldDeleted);
        if (oldPending === null) localStorage.removeItem(pendingKey); else localStorage.setItem(pendingKey, oldPending);
      }
    });
    assert.equal(malformedMapChecks.deletedMapIsObject, true, 'deleted-project map reader should reject array envelopes');
    assert.equal(malformedMapChecks.pendingMapIsObject, true, 'pending-import map reader should reject array envelopes');
    assert.equal(malformedMapChecks.tombstonePersisted, true, 'a malformed deleted-project map must not make new tombstones disappear');

    // Deletion must never remove the only visible copy if neither a durable
    // tombstone nor a confirmed server save is available.
    const deletionSafety = await page.evaluate(async () => {
      const saved = {
        projects, currentProjectId, inCopyBranch, isCopyBranchCreated,
        recordDeletedProjectId, saveProjectsToStorage, saveLocalProjectsSnapshot,
        renderProjectsList, showToast, confirm: window.confirm
      };
      const fixture = { id: 'delete-safety-fixture', name: 'Delete safety fixture', code: { html: '', css: '', js: '' } };
      let toast = '';
      try {
        projects = [fixture];
        currentProjectId = null;
        inCopyBranch = false;
        isCopyBranchCreated = false;
        window.confirm = () => true;
        recordDeletedProjectId = () => false;
        saveProjectsToStorage = async () => false;
        saveLocalProjectsSnapshot = () => true;
        renderProjectsList = () => {};
        showToast = message => { toast = message; };
        await deleteProject(fixture.id);
        const retainedWithoutDurability = projects.some(project => project.id === fixture.id);
        projects = [fixture];
        recordDeletedProjectId = () => true;
        await deleteProject(fixture.id);
        const removedWithDurableTombstone = !projects.some(project => project.id === fixture.id);
        return { retainedWithoutDurability, removedWithDurableTombstone, toast };
      } finally {
        projects = saved.projects;
        currentProjectId = saved.currentProjectId;
        inCopyBranch = saved.inCopyBranch;
        isCopyBranchCreated = saved.isCopyBranchCreated;
        recordDeletedProjectId = saved.recordDeletedProjectId;
        saveProjectsToStorage = saved.saveProjectsToStorage;
        saveLocalProjectsSnapshot = saved.saveLocalProjectsSnapshot;
        renderProjectsList = saved.renderProjectsList;
        showToast = saved.showToast;
        window.confirm = saved.confirm;
      }
    });
    assert.equal(deletionSafety.retainedWithoutDurability, true,
      'deletion should roll back if neither local tombstone nor server persistence succeeds');
    assert.equal(deletionSafety.removedWithDurableTombstone, true,
      'deletion may remain local when a durable tombstone protects it from resurrection');
    assert.match(deletionSafety.toast, /marca de eliminación quedó guardada/i,
      'offline deletion should explain that its tombstone is durable');

    // Multiple malformed snapshots must each remain recoverable. Keep the first
    // legacy backup in place and append subsequent raw snapshots without duplicates.
    const multipleRecoveryBackups = await page.evaluate(() => {
      const key = 'codelab_xd_projects_recovery_v1';
      const oldRecovery = localStorage.getItem(key);
      try {
        localStorage.setItem(key, JSON.stringify({
          version: 1, savedAt: '2026-10-01T00:00:00.000Z',
          reason: 'first_invalid_json', raw: '{first-damaged}'
        }));
        const firstWrite = preserveInvalidLocalProjectsSnapshot('{second-damaged}', 'second_invalid_json');
        const secondWrite = preserveInvalidLocalProjectsSnapshot('{second-damaged}', 'second_invalid_json');
        const stored = JSON.parse(localStorage.getItem(key));
        return {
          firstWrite, secondWrite, primaryRaw: stored.raw,
          backups: Array.isArray(stored.backups) ? stored.backups : []
        };
      } finally {
        if (oldRecovery === null) localStorage.removeItem(key);
        else localStorage.setItem(key, oldRecovery);
      }
    });
    assert.equal(multipleRecoveryBackups.firstWrite, true,
      'a second malformed snapshot should be preserved without replacing the first recovery copy');
    assert.equal(multipleRecoveryBackups.secondWrite, true,
      're-preserving the same damaged snapshot should be idempotent');
    assert.equal(multipleRecoveryBackups.primaryRaw, '{first-damaged}',
      'the original recovery backup must remain byte-for-byte intact');
    assert.equal(multipleRecoveryBackups.backups.length, 1,
      'the second recovery snapshot should be stored once, without duplicates');
    assert.equal(multipleRecoveryBackups.backups[0].raw, '{second-damaged}',
      'the additional malformed snapshot must remain recoverable');

    const unreadableRecoverySlot = await page.evaluate(() => {
      const key = 'codelab_xd_projects_recovery_v1';
      const oldRecovery = localStorage.getItem(key);
      try {
        const unreadable = '{recovery-slot-is-corrupt';
        localStorage.setItem(key, unreadable);
        const preserved = preserveInvalidLocalProjectsSnapshot('{new-damaged}', 'invalid_json');
        return { preserved, stored: localStorage.getItem(key), original: unreadable };
      } finally {
        if (oldRecovery === null) localStorage.removeItem(key);
        else localStorage.setItem(key, oldRecovery);
      }
    });
    assert.equal(unreadableRecoverySlot.preserved, false,
      'an unreadable recovery slot must block replacement rather than risking the previous recovery data');
    assert.equal(unreadableRecoverySlot.stored, unreadableRecoverySlot.original,
      'a malformed recovery slot must remain untouched when a safe merge is impossible');

    // Corrupt local project snapshots must be backed up byte-for-byte before
    // normal startup replaces the active snapshot with an empty/default project.
    for (const damagedSnapshot of [
      { raw: '{"projects":"not-an-array"}', reason: 'projects_not_array' },
      { raw: '{"broken-json":', reason: 'invalid_json' }
    ]) {
      const recoveryContext = await browser.newContext({ viewport: { width: 900, height: 700 } });
      const recoveryPage = await recoveryContext.newPage();
      await recoveryPage.addInitScript(({ raw }) => {
        localStorage.setItem('codelab_xd_projects_v2', raw);
      }, damagedSnapshot);
      await recoveryPage.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await recoveryPage.waitForFunction(() =>
        document.getElementById('syncLoadingModal')?.classList.contains('hidden'), null, { timeout: 15000 });
      const recovery = await recoveryPage.evaluate(() => {
        const raw = localStorage.getItem('codelab_xd_projects_recovery_v1');
        return raw ? JSON.parse(raw) : null;
      });
      assert.ok(recovery, 'damaged local project snapshot should have a recovery backup');
      assert.equal(recovery.raw, damagedSnapshot.raw,
        'recovery must preserve the exact original local snapshot');
      assert.equal(recovery.reason, damagedSnapshot.reason,
        'recovery should classify malformed snapshot data');
      await recoveryContext.close();
    }

    assert.deepEqual(failures, [], 'production page should not throw uncaught JavaScript errors');
    console.log('Full CodeLab system E2E passed: design create/edit → responsive canvas → AI PNG/JSON capture → reload/offline recovery → web conversion → workspace design-system save/export/reload → component insertion → 429 retry → 413 recovery → 400 validation recovery → server persistence.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error('Full design workflow E2E failed:', error);
  process.exitCode = 1;
});
