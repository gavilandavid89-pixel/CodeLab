const assert = require('node:assert/strict');
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

    // 7. Verify server persistence, reload the app, and reopen the same project.
    await page.selectOption('#designFrameSize', 'desktop');
    await waitForPersistedProject(page, PROJECT_NAME);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('syncLoadingModal')?.classList.contains('hidden'), null, { timeout: 15000 });
    const projectCard = page.locator('#projectsGrid > div').filter({ hasText: PROJECT_NAME });
    await projectCard.locator('button[data-action="open"]').click();
    await page.waitForFunction(() => {
      const design = document.getElementById('designStudioPanel');
      return design && !design.classList.contains('hidden') &&
        document.querySelector('#designCanvas [data-design-id]');
    }, { timeout: 10000 });
    assert.equal(await page.locator('#designCanvas [data-design-id]').first().innerText(), 'Prueba integral CodeLab',
      'edited design should survive a real server-backed reload');

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
    console.log('Full design workflow E2E passed: create → edit → undo/redo → drag → duplicate/delete → responsive presets → server persistence/reload → convert to web → insert component and persist.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error('Full design workflow E2E failed:', error);
  process.exitCode = 1;
});
