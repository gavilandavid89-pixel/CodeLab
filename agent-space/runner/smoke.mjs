import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseURL = process.env.CODELAB_E2E_BASE_URL || 'http://127.0.0.1:3188';
const outDir = process.env.AGENT_SPACE_ARTIFACT_DIR || 'artifacts';
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const errors = [];
const consoleErrors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  const response = await page.goto(baseURL + '/agent-space/', {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });
  if (!response || !response.ok()) {
    throw new Error('Agent Space returned HTTP ' + (response?.status() ?? 'no response'));
  }
  if (!/Agent Space/i.test(await page.title())) throw new Error('Agent Space title missing');

  const app = page.frameLocator('#appFrame');
  await app.locator('#syncLoadingModal').waitFor({ state: 'hidden', timeout: 30000 });
  await app.locator('#openDesignTools').waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('#refreshState').click();
  await page.waitForFunction(() => document.querySelector('#snapshot')?.textContent.includes('"title"'));
  const snapshotText = await page.locator('#snapshot').innerText();
  const snapshot = JSON.parse(snapshotText);
  if (!/CodeLab/i.test(snapshot.title || '')) throw new Error('Bridge did not inspect the CodeLab iframe');
  if (!Number.isInteger(snapshot.visibleControls) || snapshot.visibleControls < 1) {
    throw new Error('Bridge reported no visible controls despite the loaded CodeLab UI');
  }

  // Use the native browser for a real user interaction, then let the bridge operate another control.
  await app.locator('#openDesignTools').click();
  await app.locator('#designToolsModal').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('#selector').fill('#designToolsTab-accessibility');
  await page.locator('#clickElement').click();
  await app.locator('#designToolsTab-accessibility').waitFor({ state: 'visible', timeout: 10000 });
  if (await app.locator('#designToolsTab-accessibility').getAttribute('aria-selected') !== 'true') {
    throw new Error('Agent Space did not switch the design tools tab');
  }

  await page.screenshot({ path: path.join(outDir, 'agent-space-live.png'), fullPage: true });
  await page.locator('#selector').fill('#closeDesignTools');
  await page.locator('#clickElement').click();
  await app.locator('#designToolsModal').waitFor({ state: 'hidden', timeout: 10000 });

  const report = {
    ok: errors.length === 0,
    checkedAt: new Date().toISOString(),
    baseURL,
    pageTitle: await page.title(),
    appTitle: snapshot.title,
    visibleControls: snapshot.visibleControls,
    interactions: ['same-origin iframe inspection', 'open design tools', 'switch tab through bridge', 'close modal through bridge'],
    pageErrors: errors,
    consoleErrors
  };
  await fs.writeFile(path.join(outDir, 'agent-space-report.json'), JSON.stringify(report, null, 2));
  if (errors.length) throw new Error('Uncaught page errors: ' + errors.join('; '));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  try {
    const pages = browser.contexts().flatMap(context => context.pages());
    if (pages[0]) await pages[0].screenshot({ path: path.join(outDir, 'agent-space-failure.png'), fullPage: true });
  } catch {}
  throw error;
} finally {
  await browser.close();
}
