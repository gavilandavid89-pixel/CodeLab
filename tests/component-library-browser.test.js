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
    assert.equal(await page.locator('[data-component-id]').count(), 8);
    await page.selectOption('#componentLibraryCategory', 'Tarjetas');
    assert.equal(await page.locator('[data-component-id]').count(), 2);
    await page.fill('#componentLibrarySearch', 'precios');
    assert.equal(await page.locator('[data-component-id]').count(), 0, 'category filter should combine with search');
    await page.selectOption('#componentLibraryCategory', 'Todas');
    await page.fill('#componentLibrarySearch', 'dashboard');
    assert.equal(await page.locator('[data-component-id]').count(), 1);
    await page.click('[data-component-id="dashboard"]');
    assert.match(await page.locator('#componentLibraryCode').inputValue(), /role="progressbar"/);
    await page.evaluate(() => {
      window.getCurrentProject = () => ({ id: 'fixture', type: 'web' });
      window.getEditorValue = kind => kind === 'html' ? '<!doctype html><html><body><main>Existing content</main></body></html>' : '';
      window.setEditorValue = (kind, value) => { window.__insertedHtml = value; };
      window.saveCurrentCodeToActiveProject = () => { window.__saved = true; };
      window.updatePreview = () => { window.__previewUpdated = true; };
    });
    await page.click('#componentLibraryInsert');
    const inserted = await page.evaluate(() => window.__insertedHtml);
    assert.match(inserted, /Existing content/);
    assert.match(inserted, /Resumen del proyecto/);
    assert.match(inserted, /<\/body>/);
    assert.equal(await page.evaluate(() => window.__saved && window.__previewUpdated), true);
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
