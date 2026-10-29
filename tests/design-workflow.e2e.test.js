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

    // 2. Add an element and edit its real property input.
    await page.locator('button[onclick="addDesignElement(\'heading\')"]').click();
    const element = page.locator('#designCanvas [data-design-id]').first();
    await element.waitFor();
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

    // 5. Duplicate and delete through the production layer controls.
    await page.locator('button[onclick="duplicateDesignElement()"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#designCanvas [data-design-id]').length === 2);
    await page.locator('button[onclick="deleteDesignElement()"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#designCanvas [data-design-id]').length === 1);
    assert.equal(await page.locator('#designCanvas [data-design-id]').first().innerText(), 'Prueba integral CodeLab');

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
    await page.selectOption('#designCaptureScale', '3');
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
    assert.ok(captureContext.elementCount >= 1, 'capture context should include the canvas element');
    assert.equal(captureContext.canvas.scale, 3, 'design capture context should record the selected 3× resolution');
    assert.equal(captureContext.canvas.pixelWidth, captureContext.canvas.width * 3, 'context pixel width should match the selected scale');
    assert.equal(captureContext.canvas.pixelHeight, captureContext.canvas.height * 3, 'context pixel height should match the selected scale');
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

    // 6c. Verify the three explicit export formats through the real UI.
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
    assert.match(exportedHtml, /transform:"scale\("\+s\+"\)"/, 'HTML export should scale the fixed design canvas to smaller screens');

    await page.click('#designExportMenuButton');
    await page.waitForSelector('#designExportMenu:not(.hidden)');
    const svgExportReady = page.waitForEvent('download');
    await page.click('#exportDesignSvgOption');
    const svgExport = await svgExportReady;
    assert.match(svgExport.suggestedFilename(), /\.svg$/i, 'SVG export should have an SVG filename');
    assert.match(await fs.readFile(await svgExport.path(), 'utf8'), /<svg[\s>]/i, 'SVG export should preserve vector markup');

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
    // Simulate one server-side rate limit and verify the client retries the real save.
    let injectedWorkspaceRateLimit = false;
    let injectedWorkspaceTooLarge = false;
    let allowWorkspaceTooLarge = false;
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

    await page.unroute('**/api/workspace/**');
    assert.equal(injectedWorkspaceRateLimit, true, 'E2E should inject one workspace rate limit');
    assert.ok(workspacePutRequests >= 3, 'E2E should observe saves, retry, and size-limit recovery');

    assert.deepEqual(failures, [], 'production page should not throw uncaught JavaScript errors');
    console.log('Full CodeLab system E2E passed: design create/edit → responsive canvas → AI PNG/JSON capture → reload/offline recovery → web conversion → workspace design-system save/export/reload → component insertion → 429 retry → 413 recovery → server persistence.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error('Full design workflow E2E failed:', error);
  process.exitCode = 1;
});
