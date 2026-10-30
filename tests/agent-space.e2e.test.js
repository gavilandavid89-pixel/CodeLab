const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE_URL = process.env.CODELAB_E2E_BASE_URL || 'http://127.0.0.1:3188';

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    await page.goto(BASE_URL + '/agent-space/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    assert.match(await page.title(), /Agent Space/, 'the isolated cockpit route should load');
    const app = page.frameLocator('#appFrame');
    await app.locator('#syncLoadingModal').waitFor({ state: 'hidden', timeout: 20000 });

    await page.locator('#refreshState').click();
    await page.waitForFunction(() => document.getElementById('snapshot').textContent.includes('"title"'));
    const snapshot = await page.locator('#snapshot').innerText();
    assert.match(snapshot, /CodeLab/i, 'the bridge should inspect the actual app iframe');

    await page.locator('#selector').fill('#openDesignTools');
    await page.locator('#clickElement').click();
    await app.locator('#designToolsModal').waitFor({ state: 'visible', timeout: 10000 });

    await page.locator('#selector').fill('#closeDesignTools');
    await page.locator('#clickElement').click();
    await app.locator('#designToolsModal').waitFor({ state: 'hidden', timeout: 10000 });

    assert.deepEqual(errors, [], 'Agent Space must not produce uncaught page errors');
    console.log('Agent Space E2E passed: isolated route, same-origin app inspection, real UI click-through, modal close, and no uncaught page errors.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error('Agent Space E2E failed:', error);
  process.exitCode = 1;
});
