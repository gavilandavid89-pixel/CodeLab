import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const worker = await readFile(new URL('../agent-bridge-worker.mjs', import.meta.url), 'utf8');

test('CodeLab browser QA runs against the persisted project HTML with Chromium', () => {
  assert.match(worker, /async function captureCodeLabProjectBrowser\(/);
  assert.match(worker, /playwrightChromium\.launch/);
  assert.match(worker, /page\.setContent\(html/);
  assert.match(worker, /captureMethod: 'playwright-chromium-saved-html-setcontent'/);
});

test('CodeLab browser QA covers desktop and mobile and tests the actual CTA click', () => {
  assert.match(worker, /name: 'desktop', width: 1440, height: 1000/);
  assert.match(worker, /name: 'mobile', width: 390, height: 844, mobile: true/);
  assert.match(worker, /button\.click\(\{ timeout: 5000 \}\)/);
  assert.match(worker, /Interacción funcionando/);
  assert.match(worker, /noHorizontalOverflow/);
  assert.match(worker, /noPageErrors/);
});

test('CodeLab browser QA returns viewable PNG evidence and is opt-in on project inspection', () => {
  assert.match(worker, /dataBase64: screenshot\.toString\('base64'\)/);
  assert.match(worker, /command\.payload\?\.browser_test === true/);
  assert.match(worker, /inspection\.browserTest = await captureCodeLabProjectBrowser/);
});

test('CodeLab browser QA does not claim the isolated HTML render is the public route', () => {
  assert.match(worker, /not the public app route/);
});
