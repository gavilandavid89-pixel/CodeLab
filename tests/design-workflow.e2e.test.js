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
    await page.waitForSelector('#syncLoadingModal.hidden', { timeout: 15000 });

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
    await page.waitForSelector('#syncLoadingModal.hidden', { timeout: 15000 });
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
    const generated = await page.evaluate(() => ({
      title: document.getElementById('currentProjectTitle')?.textContent || '',
      html: typeof window.getEditorValue === 'function' ? window.getEditorValue('html') : ''
    }));
    assert.match(generated.title, /Web/);
    assert.match(generated.html, /Prueba integral CodeLab/,
      'converted web project should include the edited design content');
    assert.match(generated.html, /name="viewport"/,
      'converted web project should include a responsive viewport meta tag');

    assert.deepEqual(failures, [], 'production page should not throw uncaught JavaScript errors');
    console.log('Full design workflow E2E passed: create → edit → undo/redo → drag → duplicate/delete → responsive presets → server persistence/reload → convert to web.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error('Full design workflow E2E failed:', error);
  process.exitCode = 1;
});
