const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

function extractDivById(html, id) {
  const start = html.indexOf('id="' + id + '"');
  if (start < 0) throw new Error('Missing element #' + id);
  const opening = html.lastIndexOf('<div', start);
  if (opening < 0) throw new Error('Missing opening div #' + id);
  const token = /<\/?div\b[^>]*>/gi;
  token.lastIndex = opening;
  let depth = 0, match;
  while ((match = token.exec(html))) {
    if (/^<div\b/i.test(match[0])) depth++;
    else depth--;
    if (depth === 0) return html.slice(opening, token.lastIndex);
  }
  throw new Error('Unclosed div #' + id);
}

(async () => {
  const html = await fs.readFile(path.resolve('public/index.html'), 'utf8');
  const modal = extractDivById(html, 'componentLibraryModal');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 390, height: 844 } });
    const fixture = '<!doctype html><html lang="es"><body><button id="openComponentLibrary">Componentes</button>' + modal + '</body></html>';
    await page.route('http://codelab.test/**', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture }));
    await page.goto('http://codelab.test/');
    await page.addScriptTag({ path: path.resolve('public/component-library.js') });
    await page.click('#openComponentLibrary');
    await page.waitForSelector('#componentLibraryModal:not(.hidden)');
    const componentFocusEnds = await page.evaluate(() => {
      const modal = document.getElementById('componentLibraryModal');
      const focusable = Array.from(modal.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),iframe:not([tabindex="-1"]),[tabindex]:not([tabindex="-1"])'))
        .filter(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
      focusable[0].focus();
      return { first: focusable[0].id, last: focusable[focusable.length - 1].id };
    });
    assert.ok(componentFocusEnds.first && componentFocusEnds.last, 'Component library should expose visible focusable controls');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), componentFocusEnds.last, 'Shift+Tab from the first control should wrap to the last control');
    await page.locator('#' + componentFocusEnds.last).focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), componentFocusEnds.first, 'Tab from the last control should wrap to the first control');
    assert.equal(await page.locator('[data-component-id]').count(), 8);
    await page.selectOption('#componentLibraryCategory', 'Tarjetas');
    assert.equal(await page.locator('[data-component-id]').count(), 2);
    await page.fill('#componentLibrarySearch', 'precios');
    assert.equal(await page.locator('[data-component-id]').count(), 0, 'category filter should combine with search');
    assert.equal(await page.locator('#componentLibraryCode').inputValue(), '', 'No-results search must clear the stale component source');
    for (const id of ['componentLibraryCopy', 'componentLibraryDownload', 'componentLibraryInsert']) {
      assert.equal(await page.locator('#' + id).isDisabled(), true, id + ' must be disabled when there is no selection');
    }
    assert.equal(await page.locator('#componentLibrarySelectedName').textContent(), 'Sin selección');
    await page.selectOption('#componentLibraryCategory', 'Todas');
    await page.fill('#componentLibrarySearch', 'proyecto');
    assert.equal(await page.locator('[data-component-id]').count(), 1);
    await page.click('[data-component-id="dashboard"]');
    assert.match(await page.locator('#componentLibraryCode').inputValue(), /role="progressbar"/);
    await page.evaluate(() => {
      window.getCurrentProject = () => ({ id: 'fixture', type: 'web' });
      window.getEditorValue = kind => kind === 'html' ? '<!doctype html><html><body><main>Existing content</main></body></html>' : '';
      window.setEditorValue = (kind, value) => { window.__insertedHtml = value; };
      window.saveCurrentCodeToActiveProject = async () => { window.__saved = true; return true; };
      window.updatePreview = () => { window.__previewUpdated = true; };
    });
    await page.click('#componentLibraryInsert');
    await page.waitForFunction(() => /guardado; sincronización confirmada/i.test(document.querySelector('#componentLibraryStatus')?.textContent || ''), null, { timeout: 3000 });
    const inserted = await page.evaluate(() => window.__insertedHtml);
    assert.match(inserted, /Existing content/);
    assert.match(inserted, /Resumen del proyecto/);
    assert.match(inserted, /<\/body>/);
    assert.equal(await page.evaluate(() => window.__saved && window.__previewUpdated), true);

    // A rejected server save must not be reported as a confirmed successful save.
    await page.evaluate(() => {
      window.getEditorValue = kind => kind === 'html' ? '<!doctype html><html><body></body></html>' : '';
      window.saveCurrentCodeToActiveProject = async () => false;
    });
    await page.click('#componentLibraryInsert');
    await page.waitForFunction(() => /no se confirmó el guardado\/sincronización/i.test(document.querySelector('#componentLibraryStatus')?.textContent || ''), null, { timeout: 3000 });

    // Inserting a reusable tool must respect the same HTML field cap enforced by
    // server-side workspace validation; rejected actions must not mutate editor state.
    await page.evaluate(() => {
      window.__insertCalls = 0;
      window.__insertedHtml = 'previous editor value';
      window.getEditorValue = () => 'x'.repeat(500000);
      window.setEditorValue = () => { window.__insertCalls++; };
      window.saveCurrentCodeToActiveProject = () => { window.__savedAfterReject = true; };
    });
    await page.click('#componentLibraryInsert');
    assert.equal(await page.evaluate(() => window.__insertCalls), 0,
      'oversized component insertion must be rejected before modifying the editor');
    assert.equal(await page.evaluate(() => window.__insertedHtml), 'previous editor value',
      'rejected insertion must preserve existing editor state');
    assert.match(await page.locator('#componentLibraryStatus').textContent(), /500\.000 caracteres/,
      'the tool should explain why insertion was rejected');

    // If the editor persistence hook is unavailable, do not report a successful insertion.
    await page.evaluate(() => {
      window.getEditorValue = () => '<!doctype html><html><body></body></html>';
      window.setEditorValue = () => { window.__insertCalls++; };
      delete window.saveCurrentCodeToActiveProject;
    });
    await page.click('#componentLibraryInsert');
    assert.equal(await page.evaluate(() => window.__insertCalls), 0,
      'insertion must not change the editor when the persistence hook is missing');
    assert.match(await page.locator('#componentLibraryStatus').textContent(), /editor todavía no está listo/,
      'the tool should report when editor persistence is unavailable');

    const downloadPromise = page.waitForEvent('download');
    await page.click('#componentLibraryDownload');
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'codelab-dashboard.html');
    const exported = await fs.readFile(await download.path(), 'utf8');
    assert.match(exported, /<meta name="viewport"/);
    assert.match(exported, /Resumen del proyecto/);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#componentLibraryModal.hidden');
    console.log('Component library browser test passed: responsive modal, category/search filters, preview source, HTML insertion and standalone export.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
