import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';

test('isolated preview exercises form state, assertions, and bounded file input', async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    const externalRequests = [];
    page.on('request', request => {
      if (!['data:', 'blob:', 'about:'].some(prefix => request.url().startsWith(prefix)) &&
          !request.url().startsWith('http://127.0.0.1')) externalRequests.push(request.url());
    });
    await page.setContent('<!doctype html><html><body><iframe id="preview" title="Isolated test" sandbox="allow-scripts allow-forms"></iframe></body></html>');
    const srcdoc = `<!doctype html><html><head>
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none';">
      </head><body>
      <main>
        <label>Name <input id="name" value=""></label><output id="echo"></output>
        <label><input id="agree" type="checkbox">Agree</label>
        <label>Plan <select id="plan"><option value="basic">Basic</option><option value="pro">Pro</option></select></label>
        <input id="file" type="file" accept=".txt">
        <output id="file-result"></output>
        <button id="save" type="button" disabled>Ready</button>
      </main>
      <script>
        const name = document.querySelector('#name');
        name.addEventListener('input', () => { document.querySelector('#echo').textContent = name.value; });
        document.querySelector('#agree').addEventListener('change', event => {
          document.querySelector('#save').disabled = !event.target.checked;
        });
        document.querySelector('#file').addEventListener('change', event => {
          const file = event.target.files[0];
          document.querySelector('#file-result').textContent = file ? file.name + ':' + file.size + ':' + file.type : '';
        });
      <\/script></body></html>`;
    await page.locator('#preview').evaluate((frame, html) => { frame.srcdoc = html; }, srcdoc);
    const frame = page.frameLocator('#preview');
    await frame.locator('#name').fill('CodeLab');
    await frame.locator('#echo').getByText('CodeLab').waitFor({ timeout: 3000 });
    await frame.locator('#agree').check();
    assert.equal(await frame.locator('#agree').isChecked(), true);
    assert.equal(await frame.locator('#save').isEnabled(), true);
    await frame.locator('#plan').selectOption('pro');
    assert.equal(await frame.locator('#plan').inputValue(), 'pro');
    const fixture = Buffer.from('headless fixture file', 'utf8');
    await frame.locator('#file').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: fixture });
    await frame.locator('#file-result').getByText('fixture.txt:21:text/plain').waitFor({ timeout: 3000 });
    assert.equal(await frame.locator('#file').evaluate(el => el.files.length), 1);
    assert.equal(await frame.locator('#file').evaluate(el => el.files[0].name), 'fixture.txt');
    assert.deepEqual(externalRequests, [], 'preview must not initiate external network requests');
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});
