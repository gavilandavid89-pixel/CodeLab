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
    let remoteSettings = null;
    let remoteWrites = 0;
    let failNextPutWithRateLimit = false;
    let delayNextPut = false;
    let releaseDelayedPut = null;
    await page.route('http://codelab.test/**', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixtureHtml }));
    await page.route('http://codelab.test/api/workspace/**', async route => {
      const request = route.request();
      if (!new URL(request.url()).pathname.endsWith('/design-system')) return route.continue();
      if (request.method() === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ settings: remoteSettings }) });
      }
      if (request.method() === 'PUT') {
        const incomingSettings = request.postDataJSON().settings;
        remoteWrites++;
        if (failNextPutWithRateLimit) {
          failNextPutWithRateLimit = false;
          return route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'rate_limited' }) });
        }
        if (delayNextPut) {
          delayNextPut = false;
          await page.evaluate(() => { window.__delayedPutStarted = true; });
          await new Promise(resolve => { releaseDelayedPut = resolve; });
        }
        remoteSettings = incomingSettings;
        await page.evaluate(settings => { window.__remoteDesignSystem = settings; }, remoteSettings);
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, settings: remoteSettings }) });
      }
      return route.fulfill({ status: 405, contentType: 'application/json', body: '{}' });
    });
    await page.addInitScript(() => {
      localStorage.setItem('codelab_xd_workspace_v4', 'ws_browser_fixture');
      localStorage.setItem('codelab_xd_workspace_token_v1', 'fixture-workspace-token');
      window.codelabWorkspaceReady = true;
    });
    await page.goto('http://codelab.test/');
    await page.addScriptTag({ path: path.resolve('public/design-tools.js') });
    await page.waitForFunction(() => document.getElementById('designToolsStatus')?.textContent.includes('sincronizado con tu workspace'), null, { timeout: 5000 });
    await page.click('#openDesignTools');
    await page.waitForSelector('#designToolsModal:not(.hidden)');
    const designFocusEnds = await page.evaluate(() => {
      const modal = document.getElementById('designToolsModal');
      const focusable = Array.from(modal.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),iframe:not([tabindex="-1"]),[tabindex]:not([tabindex="-1"])'))
        .filter(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
      focusable[0].focus();
      return { first: focusable[0].id, last: focusable[focusable.length - 1].id };
    });
    assert.ok(designFocusEnds.first && designFocusEnds.last, 'Design tools should expose visible focusable controls');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), designFocusEnds.last, 'Shift+Tab from the first control should wrap to the last control');
    await page.locator('#' + designFocusEnds.last).focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), designFocusEnds.first, 'Tab from the last control should wrap to the first control');
    await page.evaluate(() => {
      const input = document.getElementById('colorPrimary');
      input.value = '#ff0000';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.match(await page.locator('#designPalettePreview').innerText(), /#ff0000/i);
    await page.click('#closeDesignTools');
    await page.waitForSelector('#designToolsModal.hidden');
    await page.click('#openDesignTools');
    assert.equal(await page.locator('#colorPrimary').inputValue(), '#ff0000', 'unsaved edits should remain available when reopening the modal');
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
      window.getEditorValue = (kind) => kind === 'html' ? '<html><head><title>Broken</title></head><body><h1>Title</h1><h3>Skip</h3><img src="hero.png"><button></button></body></html>' : '.existing { color: red; }';
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

    // Token application must not push CSS beyond the server's per-field cap.
    await page.evaluate(() => {
      window.__tokenSetCalls = 0;
      window.getEditorValue = kind => kind === 'html' ? '<html><body></body></html>' : 'x'.repeat(500000);
      window.setEditorValue = () => { window.__tokenSetCalls++; };
    });
    await page.click('#applyDesignTokens');
    assert.equal(await page.evaluate(() => window.__tokenSetCalls), 0,
      'oversized token application must be rejected before modifying the CSS editor');
    assert.match(await page.locator('#designToolsStatus').textContent(), /500\.000 caracteres/,
      'the design tool should explain the CSS size limit');

    // Restore the normal editor fixture before continuing sync/export checks.
    await page.evaluate(() => {
      window.getEditorValue = kind => kind === 'html'
        ? '<html><head><title>Broken</title></head><body><h1>Title</h1><h3>Skip</h3><img src="hero.png"><button></button></body></html>'
        : '.existing { color: red; }';
      window.setEditorValue = (lang, value) => { window.__appliedCss = value; };
    });
    const writesBeforeRateLimit = remoteWrites;
    failNextPutWithRateLimit = true;
    await page.click('#saveDesignSystem');
    await page.waitForFunction(() => window.__remoteDesignSystem?.primary === '#ff0000', null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('codelab-design-system-v1')).primary), '#ff0000');
    assert.equal(await page.evaluate(() => window.__remoteDesignSystem.primary), '#ff0000');
    assert.ok(remoteWrites >= writesBeforeRateLimit + 2, 'a 429 response should be retried and the design system should still persist remotely');
    const downloadPromise = page.waitForEvent('download');
    await page.click('#exportDesignSystemJson');
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'codelab-design-system.json');
    const filePath = await download.path();
    const json = JSON.parse(await fs.readFile(filePath, 'utf8'));
    assert.equal(json.format, 'codelab-design-system');
    assert.equal(json.colors.primary, '#ff0000');
    const importFixture = {
      format: 'codelab-design-system', version: 1, name: 'Sistema importado',
      colors: { primary: '#123456', secondary: '#234567', accent: '#345678', surface: '#456789', background: '#56789a', text: '#abcdef' },
      typography: { baseFontPx: 20, ratio: 1.3, scale: [{ name: 'base', px: 20 }] },
      spacing: [{ name: 'space-1', px: 8 }], radius: [{ name: 'radius-lg', px: 16 }],
      accessibility: { foreground: '#ffffff', background: '#000000', contrastRatio: 21 }
    };
    await page.locator('#designSystemJsonFile').setInputFiles({
      name: 'imported-design-system.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(importFixture))
    });
    await page.waitForFunction(() => document.querySelector('#systemName')?.value === 'Sistema importado', null, { timeout: 5000 });
    assert.equal(await page.locator('#systemName').inputValue(), 'Sistema importado');
    assert.equal(await page.locator('#colorPrimary').inputValue(), '#123456');
    assert.equal(await page.locator('#baseFont').inputValue(), '20');
    assert.equal(await page.locator('#baseSpacing').inputValue(), '8');
    assert.equal(await page.locator('#baseRadius').inputValue(), '16');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('codelab-design-system-v1')).primary), '#123456');
    await page.waitForFunction(() => window.__remoteDesignSystem?.primary === '#123456', null, { timeout: 5000 });

    // Force two saves to overlap at the UI level: the first network write stalls,
    // then a newer color is saved. The final server state must be the newer value.
    delayNextPut = true;
    await page.evaluate(() => {
      const input = document.getElementById('colorPrimary');
      input.value = '#111111';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('#saveDesignSystem');
    await page.waitForFunction(() => window.__delayedPutStarted === true, null, { timeout: 5000 });
    while (typeof releaseDelayedPut !== 'function') await new Promise(resolve => setTimeout(resolve, 10));
    await page.evaluate(() => {
      const input = document.getElementById('colorPrimary');
      input.value = '#222222';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('#saveDesignSystem');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('codelab-design-system-v1')).primary), '#222222');
    releaseDelayedPut();
    await page.waitForFunction(() => window.__remoteDesignSystem?.primary === '#222222', null, { timeout: 5000 });

    await page.locator('#designSystemJsonFile').setInputFiles({
      name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'other', version: 1 }))
    });
    await page.waitForFunction(() => /no es un sistema visual CodeLab compatible/i.test(document.querySelector('#designToolsStatus')?.textContent || ''), null, { timeout: 5000 });
    assert.match(await page.locator('#designToolsStatus').innerText(), /no es un sistema visual CodeLab compatible/i);
    assert.equal(await page.locator('#colorPrimary').inputValue(), '#222222', 'invalid import must not overwrite the current system');
    const invalidColorFixture = {
      format: 'codelab-design-system', version: 1, name: 'No debe aplicarse',
      colors: { primary: 'not-a-color', secondary: '#234567', accent: '#345678', surface: '#456789', background: '#56789a', text: '#abcdef' },
      typography: { baseFontPx: 20, ratio: 1.3, scale: [{ name: 'base', px: 20 }] },
      spacing: [{ name: 'space-1', px: 8 }], radius: [{ name: 'radius-lg', px: 16 }],
      accessibility: { foreground: '#ffffff', background: '#000000', contrastRatio: 21 }
    };
    await page.locator('#designSystemJsonFile').setInputFiles({
      name: 'invalid-color.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalidColorFixture))
    });
    await page.waitForFunction(() => /colores inválidos/i.test(document.querySelector('#designToolsStatus')?.textContent || ''), null, { timeout: 5000 });
    assert.equal(await page.locator('#systemName').inputValue(), 'Sistema importado', 'malformed color data must not partially replace settings');
    assert.equal(await page.locator('#colorPrimary').inputValue(), '#222222', 'malformed color data must preserve the current system');
    const outOfRangeFixture = { ...invalidColorFixture, name: 'Fuera de rango', colors: { ...invalidColorFixture.colors, primary: '#123456' }, typography: { baseFontPx: 99, ratio: 1.3, scale: [{ name: 'base', px: 99 }] } };
    await page.locator('#designSystemJsonFile').setInputFiles({
      name: 'out-of-range.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(outOfRangeFixture))
    });
    await page.waitForFunction(() => /fuera de rango/i.test(document.querySelector('#designToolsStatus')?.textContent || ''), null, { timeout: 5000 });
    assert.equal(await page.locator('#colorPrimary').inputValue(), '#222222', 'out-of-range token values must not be silently clamped during import');
    await page.click('#designToolsTab-audit');
    await page.click('#runAccessibilityAudit');
    const auditText = await page.locator('#accessibilityAuditResults').innerText();
    assert.match(auditText, /image-missing-alt/);
    assert.match(auditText, /button-no-name/);
    assert.match(auditText, /missing-lang/);
    const auditDownloadPromise = page.waitForEvent('download');
    await page.click('#exportAccessibilityAudit');
    const auditDownload = await auditDownloadPromise;
    assert.equal(auditDownload.suggestedFilename(), 'codelab-accessibility-audit.json');
    const auditJson = JSON.parse(await fs.readFile(await auditDownload.path(), 'utf8'));
    assert.equal(auditJson.format, 'codelab-accessibility-audit');
    assert.ok(auditJson.summary.errors >= 2);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#designToolsModal.hidden');
    console.log('Design tools browser test passed: modal interaction, live palette, WCAG contrast, token updates, workspace sync, token application, accessibility audit and JSON exports.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
