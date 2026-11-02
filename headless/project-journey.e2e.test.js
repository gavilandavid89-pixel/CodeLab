'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { applyHeadlessBatch, queryHeadlessWorkspace } = require('./workspace-runtime');

function workspace(projects = []) {
  return { version: 5, revision: 0, updatedAt: new Date(0).toISOString(), projects, owner: { provider: 'local', id: 'integral-e2e' } };
}

function batch(state, operationId, operations) {
  return applyHeadlessBatch(state, {
    operationId,
    baseRevision: state.revision,
    operations
  });
}

test('integral project journey: create, design, revise, convert, read back, and interact in Chromium', async t => {
  const projectId = 'proj_integral_e2e';
  let saved = workspace();

  // Stage 1: create the project, then keep using this exact project and state.
  let result = batch(saved, 'integral_create_001', [
    { type: 'project.create', projectId, name: 'Pril — proyecto integral', projectType: 'design' }
  ]);
  saved = result.state;
  assert.equal(saved.projects.length, 1);
  assert.equal(saved.projects[0].id, projectId);
  assert.equal(saved.revision, 1);

  // Stage 2: build the mobile canvas and layers in one real design transaction.
  result = batch(saved, 'integral_design_002', [
    { type: 'design.batch', projectId, expectedDesignRevision: 0, operations: [
      { type: 'canvas.set', width: 720, height: 1600, background: '#f7f8fc' },
      { type: 'layout.set', mode: 'free' },
      { type: 'element.add', elementType: 'heading', id: 'el_title', properties: {
        text: 'Pril', label: 'Marca', x: 32, y: 48, width: 400, height: 80,
        fontSize: 48, color: '#18233a'
      } },
      { type: 'element.add', elementType: 'button', id: 'el_action', properties: {
        text: 'Explorar videos', label: 'Acción principal', x: 32, y: 160, width: 280, height: 64,
        background: '#4f46e5', color: '#ffffff'
      } }
    ] }
  ]);
  saved = result.state;
  assert.equal(saved.projects[0].design.canvasWidth, 720);
  assert.equal(saved.projects[0].design.canvasHeight, 1600);
  assert.equal(saved.projects[0].design.elements.length, 2);

  // Stage 3: revise the same saved design, duplicate/reorder a layer, then remove
  // the duplicate. This intentionally chains operations against its current revision.
  const designRevision = saved.projects[0].design.revision;
  result = batch(saved, 'integral_revise_003', [
    { type: 'design.batch', projectId, expectedDesignRevision: designRevision, operations: [
      { type: 'element.update', id: 'el_title', properties: { text: 'Pril Videos' } },
      { type: 'element.duplicate', id: 'el_action', newId: 'el_action_copy' },
      { type: 'element.reorder', id: 'el_action_copy', targetIndex: 0 },
      { type: 'elements.delete', ids: ['el_action_copy'] }
    ] }
  ]);
  saved = result.state;
  assert.equal(saved.projects[0].design.elements.length, 2);
  assert.equal(saved.projects[0].design.elements.find(e => e.id === 'el_title').text, 'Pril Videos');
  assert.equal(saved.projects[0].design.elements.some(e => e.id === 'el_action_copy'), false);

  // Stage 4: convert this same design project into web code and add real behavior.
  result = batch(saved, 'integral_convert_004', [
    { type: 'design.convert.toWeb', projectId },
    { type: 'web.code.write', projectId, mode: 'replace',
      html: '<main class="app"><h1 id="brand">Pril Videos</h1><button id="explore" type="button">Explorar videos</button><p id="status" aria-live="polite">Listo</p></main>',
      css: ':root{font-family:system-ui,sans-serif;color:#18233a;background:#f7f8fc}body{margin:0;min-height:100vh;display:grid;place-items:center}.app{padding:32px}h1{font-size:clamp(2rem,8vw,3rem)}button{padding:16px 24px;border:0;border-radius:12px;background:#4f46e5;color:white;font-size:1rem;cursor:pointer}button:focus-visible{outline:3px solid #18233a;outline-offset:3px}',
      js: "document.getElementById('explore').addEventListener('click',()=>{document.getElementById('status').textContent='Videos listos para explorar';});"
    }
  ]);
  saved = result.state;
  assert.equal(saved.projects[0].type, 'web');
  assert.equal(saved.projects[0].design.canvasWidth, 720, 'conversion must preserve the original design data');
  assert.match(saved.projects[0].code.html, /Pril Videos/);
  assert.match(saved.projects[0].code.js, /addEventListener/);

  // Stage 5: re-read the saved project through the runtime query interface rather
  // than relying on stale references captured before the writes.
  const reread = queryHeadlessWorkspace(saved, {
    action: 'project.code.read',
    args: { projectId, languages: ['html', 'css', 'js'] }
  });
  assert.equal(reread.result.projectId, projectId);
  assert.equal(reread.result.fields.html.value, saved.projects[0].code.html);
  assert.equal(reread.result.fields.css.value, saved.projects[0].code.css);
  assert.equal(reread.result.fields.js.value, saved.projects[0].code.js);
  const projectAfterRead = saved.projects.find(p => p.id === projectId);
  assert.equal(projectAfterRead.code.html, reread.result.fields.html.value);
  assert.equal(projectAfterRead.design.elements.find(e => e.id === 'el_title').text, 'Pril Videos');

  // Stage 6: open the code from that same saved project in Chromium and verify
  // both visual output and actual interaction. Browser is always closed.
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(saved.projects[0].code.html.replace('</main>', '</main>') +
      '<style>' + saved.projects[0].code.css + '</style><script>' +
      saved.projects[0].code.js + '</script>', { waitUntil: 'load' });
    await expectVisible(page, '#brand');
    assert.equal(await page.locator('#brand').innerText(), 'Pril Videos');
    await page.locator('#explore').click();
    assert.equal(await page.locator('#status').innerText(), 'Videos listos para explorar');
    assert.deepEqual(errors, [], 'the final project must run without browser JavaScript errors');
  } finally {
    await browser.close();
  }

  t.diagnostic('Completed one chained project across create → design → edit → convert → persisted-state read → Chromium interaction.');
});

async function expectVisible(page, selector) {
  await page.locator(selector).waitFor({ state: 'visible' });
}
