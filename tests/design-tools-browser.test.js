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
  const modal = extractDivById(html, 'designToolsModal');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 390, height: 844 } });
    const fixtureHtml = '<!doctype html><html lang="es"><body class="bg-slate-950 text-white"><button id="openDesignTools">Herramientas</button>' + modal + '</body></html>';
    await page.route('http://codelab.test/**', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixtureHtml }));
    await page.goto('http://codelab.test/');
    await page.addScriptTag({ path: path.resolve('public/design-tools.js') });
    await page.click('#openDesignTools');
    await page.waitForSelector('#designToolsModal:not(.hidden)');
    await page.evaluate(() => {
      const input = document.getElementById('colorPrimary');
      input.value = '#ff0000';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.match(await page.locator('#designPalettePreview').innerText(), /#ff0000/i);
    await page.click('#designToolsTab-accessibility');
    await page.evaluate(() => {
      const fg = document.getElementById('contrastForeground');
      const bg = document.getElementById('contrastBackground');
      fg.value = '#777777'; fg.dispatchEvent(new Event('input', { bubbles: true }));
      bg.value = '#ffffff'; bg.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.match(await page.locator('#contrastResult').innerText(), /4\.48:1/);
    assert.match(await page.locator('#contrastResult').innerText(), /AA texto normal[\s\S]*No cumple/);
    await page.click('#designToolsTab-tokens');
    await page.evaluate(() => {
      const input = document.getElementById('baseFont');
      input.value = '18'; input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.match(await page.locator('#designTokensCss').inputValue(), /--font-size-base: 18px;/);
    await page.evaluate(() => {
      window.getCurrentProject = () => ({ id: 'web-fixture', name: 'Web Fixture', type: 'web' });
      window.getEditorValue = () => '.existing { color: red; }';
      window.setEditorValue = (lang, value) => { window.__appliedCss = value; };
      window.updatePreview = () => { window.__previewUpdated = true; };
      window.showToast = (message) => { window.__toolToast = message; };
    });
    await page.click('#applyDesignTokens');
    const applied = await page.evaluate(() => window.__appliedCss || '');
    assert.match(applied, /--color-primary: #ff0000;/);
    assert.match(applied, /CodeLab Design Tokens START/);
    assert.match(applied, /\.existing \{ color: red; \}/);
    assert.equal(await page.evaluate(() => window.__previewUpdated), true);
    await page.click('#saveDesignSystem');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('codelab-design-system-v1')).primary), '#ff0000');
    const downloadPromise = page.waitForEvent('download');
    await page.click('#exportDesignSystemJson');
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'codelab-design-system.json');
    const filePath = await download.path();
    const json = JSON.parse(await fs.readFile(filePath, 'utf8'));
    assert.equal(json.format, 'codelab-design-system');
    assert.equal(json.colors.primary, '#ff0000');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#designToolsModal.hidden');
    console.log('Design tools browser test passed: modal interaction, live palette, WCAG contrast, token updates, local save and JSON export.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
