const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE_URL = process.env.CODELAB_E2E_BASE_URL || 'http://127.0.0.1:3188';
const name = 'Web editor UI ' + Date.now();
const renamed = name + ' renombrado';
const branchHtml = "<main id=\"editor-check\"><h1>Rama editada</h1><button id=\"preview-action\">Acción</button></main>";
const html = '<main id="editor-check"><h1>CodeLab listo</h1><button id="preview-action">Acción</button></main>';
const css = '#editor-check { color: rgb(1, 2, 3); } #preview-action { background: rgb(4, 5, 6); }';
const js = 'document.getElementById("preview-action").addEventListener("click", () => console.log("action-ok")); console.log("preview-ok");';

async function setCode(page, lang, value) {
  await page.waitForFunction(language =>
    (typeof editors !== 'undefined' && editors[language] && typeof editors[language].getValue === 'function') ||
    (document.getElementById('fallback-' + language) &&
      !document.getElementById('fallback-' + language).classList.contains('hidden')),
    lang, { timeout: 15000 });
  await page.locator('#tab-' + lang).click();
  if (await page.locator('#fallback-' + lang).isVisible()) {
    await page.locator('#fallback-' + lang).fill(value);
  } else {
    const editor = page.locator('#monaco-' + lang + ' .view-lines').first();
    await editor.waitFor({ state: 'visible', timeout: 15000 });
    await editor.click({ position: { x: 80, y: 10 } });
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(value);
  }
  await page.waitForFunction(({ lang, value }) => getEditorValue(lang).trim() === value.trim(),
    { lang, value }, { timeout: 10000 });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => document.getElementById('syncLoadingModal')?.classList.contains('hidden'), null, { timeout: 15000 });

    await page.getByRole('button', { name: /Crear proyecto/i }).click();
    await page.locator('#newProjectNameInput').fill(name);
    await page.locator('input[name="newProjectType"][value="web"]').check();
    await page.locator('#newProjectModal button').filter({ hasText: 'Crear Proyecto' }).click();
    await page.locator('#studioView').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForFunction(expected => document.getElementById('currentProjectTitle')?.textContent === expected, name);

    await setCode(page, 'html', html);
    await setCode(page, 'css', css);
    await setCode(page, 'js', js);
    await page.locator('#tab-html').click();
    await page.locator('#editorPanel button[onclick="updatePreview()"]').click();
    const preview = page.frameLocator('#previewIframe');
    await preview.locator('#preview-action').waitFor({ state: 'visible' });
    assert.equal(await preview.locator('#preview-action').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(4, 5, 6)');
    await preview.locator('#preview-action').click();
    await page.waitForFunction(() => document.getElementById('consoleOutput')?.textContent.includes('action-ok'), null, { timeout: 5000 });

    await page.keyboard.press('Control+s');
    await page.waitForFunction(async expected => {
      const id = localStorage.getItem('codelab_xd_workspace_v4');
      const token = localStorage.getItem('codelab_xd_workspace_token_v1');
      if (!id || !token) return false;
      const response = await fetch('/api/workspace/' + encodeURIComponent(id), { headers: { 'x-workspace-token': token } });
      if (!response.ok) return false;
      const data = await response.json();
      const project = data.projects?.find(item => item.name === expected.name);
      return project?.code?.html === expected.html && project?.code?.css === expected.css && project?.code?.js === expected.js;
    }, { name, html, css, js }, { timeout: 15000 });

    // Create a branch from the real editor, keep main isolated, then merge and undo.
    await page.locator('#desktopProjectActions button[onclick="duplicateProject()"]').click();
    await page.waitForFunction(() => document.getElementById('toggleCopyBranchBtn')?.disabled === false,
      null, { timeout: 10000 });
    await page.locator('#toggleCopyBranchBtn').click();
    await page.locator('#copyAlertBanner').waitFor({ state: 'visible' });
    await setCode(page, 'html', branchHtml);
    await page.locator('button[onclick="saveInCopyBranch()"]').click();
    await page.locator('#toggleCopyBranchBtn').click();
    await page.waitForFunction(() => getEditorValue('html').trim() === "<main id=\"editor-check\"><h1>CodeLab listo</h1><button id=\"preview-action\">Acción</button></main>".trim(),
      null, { timeout: 10000 });
    await page.locator('#toggleCopyBranchBtn').click();
    await page.waitForFunction(() => getEditorValue('html').trim() === "<main id=\"editor-check\"><h1>Rama editada</h1><button id=\"preview-action\">Acción</button></main>".trim(),
      null, { timeout: 10000 });
    page.once('dialog', dialog => dialog.accept());
    await page.locator('button[onclick="mergeToMainProject()"]').click();
    await page.waitForFunction(() => document.getElementById('undoMergeBtn')?.disabled === false,
      null, { timeout: 15000 });
    await page.locator('#toggleCopyBranchBtn').click();
    await page.waitForFunction(() => getEditorValue('html').trim() === "<main id=\"editor-check\"><h1>Rama editada</h1><button id=\"preview-action\">Acción</button></main>".trim(),
      null, { timeout: 10000 });
    await page.locator('#undoMergeBtn').click();
    await page.waitForFunction(() => getEditorValue('html').trim() === "<main id=\"editor-check\"><h1>CodeLab listo</h1><button id=\"preview-action\">Acción</button></main>".trim(),
      null, { timeout: 10000 });

    page.once('dialog', dialog => dialog.accept(renamed));
    await page.locator('#studioView button[onclick="editCurrentProjectName()"]').click();
    await page.waitForFunction(expected => document.getElementById('currentProjectTitle')?.textContent === expected,
      renamed, { timeout: 10000 });
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#desktopProjectActions button[onclick="downloadProject()"]').click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /\\.html?$/i, 'project export should download HTML');

    assert.deepEqual(errors, [], 'web editor should not produce uncaught browser errors');
    console.log('Web editor UI E2E passed: create project, edit HTML/CSS/JS, live preview/console, workspace persistence, isolated branch, merge/undo, rename, and HTML export.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error('Web editor UI E2E failed:', error);
  process.exitCode = 1;
});
