'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { applyHeadlessBatch, queryHeadlessWorkspace } = require('./workspace-runtime');
const { buildAiDesignCaptureContext } = require('./design-export');

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

  // Keep an immutable snapshot of the exact design revision that will be converted and captured.
  const captureProject = JSON.parse(JSON.stringify(saved.projects[0]));
  const captureContext = buildAiDesignCaptureContext(captureProject, 1);
  assert.equal(captureContext.designRevision, captureProject.design.revision);
  assert.equal(captureContext.canvas.width, 720);
  assert.equal(captureContext.canvas.pixelWidth, 720);

  // Stage 4: convert the same saved design and retain the generated HTML as evidence.
  result = batch(saved, 'integral_convert_004', [
    { type: 'design.convert.toWeb', projectId }
  ]);
  saved = result.state;
  assert.equal(saved.projects[0].type, 'web');
  assert.equal(saved.projects[0].design.canvasWidth, 720, 'conversion must preserve the original design data');
  assert.match(saved.projects[0].code.html, /id="designFrame"/);
  assert.match(saved.projects[0].code.html, /Pril Videos/);
  assert.match(saved.projects[0].code.html, /Explorar videos/);
  const convertedHtml = saved.projects[0].code.html;

  // Stage 5: edit that same converted project only after checking its generated output.
  result = batch(saved, 'integral_edit_005', [
    { type: 'web.code.write', projectId, mode: 'replace',
      html: '<main class="app"><h1 id="brand">Pril Videos</h1><button id="explore" type="button">Explorar videos</button><p id="status" aria-live="polite">Listo</p></main>',
      css: ':root{font-family:system-ui,sans-serif;color:#18233a;background:#f7f8fc}body{margin:0;min-height:100vh;display:grid;place-items:center}.app{padding:32px}h1{font-size:clamp(2rem,8vw,3rem)}button{padding:16px 24px;border:0;border-radius:12px;background:#4f46e5;color:white;font-size:1rem;cursor:pointer}button:focus-visible{outline:3px solid #18233a;outline-offset:3px}',
      js: "document.getElementById('explore').addEventListener('click',()=>{document.getElementById('status').textContent='Videos listos para explorar';});"
    }
  ]);
  saved = result.state;
  assert.equal(saved.projects[0].type, 'web');
  assert.equal(saved.projects[0].design.canvasWidth, 720, 'code editing must preserve the original design data');
  assert.match(saved.projects[0].code.html, /Pril Videos/);
  assert.match(saved.projects[0].code.js, /addEventListener/);

  // Stage 6: re-read the saved project through the runtime query interface rather
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

  // Stage 7: render the actual converted design HTML first, then render and interact
  // with the edited code from the same saved project. Browser is always closed.
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    // Capture the converted HTML for this exact project/revision before code replacement.
    const capturePage = await browser.newPage({
      viewport: { width: captureContext.canvas.width, height: captureContext.canvas.height },
      deviceScaleFactor: 1
    });
    await capturePage.setContent(convertedHtml, { waitUntil: 'load' });
    await expectVisible(capturePage, '#designFrame');
    assert.match(await capturePage.locator('body').innerText(), /Pril Videos/);
    assert.match(await capturePage.locator('body').innerText(), /Explorar videos/);
    const png = await capturePage.screenshot({ type: 'png', fullPage: false, animations: 'disabled' });
    assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a', 'same-project capture must be a PNG binary');
    assert.equal(png.readUInt32BE(16), captureContext.canvas.pixelWidth, 'PNG width must match same-project capture context');
    assert.equal(png.readUInt32BE(20), captureContext.canvas.pixelHeight, 'PNG height must match same-project capture context');
    assert.ok(png.length > 1000, 'same-project PNG must contain rendered content');
    assert.equal(captureContext.designRevision, captureProject.design.revision,
      'capture manifest must identify the design revision captured before conversion');
    await capturePage.close();

    await page.setContent(convertedHtml, { waitUntil: 'load' });
    await expectVisible(page, '#designFrame');
    assert.match(await page.locator('body').innerText(), /Pril Videos/);
    assert.match(await page.locator('body').innerText(), /Explorar videos/,
      'the converted design must render its saved heading and action before code replacement');

    await page.setContent(saved.projects[0].code.html +
      '<style>' + saved.projects[0].code.css + '</style><script>' +
      saved.projects[0].code.js + '</script>', { waitUntil: 'load' });
    await expectVisible(page, '#brand');
    const mobileLayout = await page.evaluate(() => ({ viewportWidth: document.documentElement.clientWidth, contentWidth: document.documentElement.scrollWidth }));
    assert.equal(mobileLayout.viewportWidth, 390, 'integrated browser journey must exercise the 390px mobile viewport');
    assert.ok(mobileLayout.contentWidth <= mobileLayout.viewportWidth, 'mobile code view must not introduce horizontal page overflow');
    assert.equal(await page.locator('#brand').innerText(), 'Pril Videos');
    await page.locator('#explore').click();
    assert.equal(await page.locator('#status').innerText(), 'Videos listos para explorar');
    assert.deepEqual(errors, [], 'generated and edited project HTML must run without browser JavaScript errors');
  } finally {
    await browser.close();
  }

  // Stage 8: exercise a real branch lifecycle on this same persisted web project.
  result = batch(saved, 'integral_branch_create_008', [
    { type: 'branch.create', projectId, branchId: 'branch_integral_e2e' }
  ]);
  saved = result.state;
  assert.equal(saved.projects[0].branch.id, 'branch_integral_e2e');
  assert.equal(saved.projects[0].branch.code.html, saved.projects[0].code.html);

  const branchHtml = saved.projects[0].branch.code.html.replace('>Listo</p>', '>En revisión</p>');
  assert.notEqual(branchHtml, saved.projects[0].code.html);
  result = batch(saved, 'integral_branch_write_009', [
    { type: 'web.code.write', projectId, source: 'branch', mode: 'replace', html: branchHtml }
  ]);
  saved = result.state;
  assert.match(saved.projects[0].branch.code.html, /En revisión/);
  assert.match(saved.projects[0].code.html, />Listo<\/p>/, 'branch edits must not mutate main before approval');

  result = batch(saved, 'integral_branch_merge_010', [
    { type: 'branch.merge', projectId, approved: true }
  ]);
  saved = result.state;
  assert.match(saved.projects[0].code.html, /En revisión/, 'approved merge must apply the branch code to main');
  assert.equal(saved.projects[0].branch, undefined);
  assert.equal(saved.projects[0].mergeHistory.length, 1);

  result = batch(saved, 'integral_branch_undo_011', [
    { type: 'branch.undo_merge', projectId, approved: true }
  ]);
  saved = result.state;
  assert.match(saved.projects[0].code.html, />Listo<\/p>/, 'undo merge must restore the previous main code');
  assert.equal(saved.projects[0].branch.id, 'branch_integral_e2e', 'undo merge must restore the saved branch');
  assert.match(saved.projects[0].branch.code.html, /En revisión/, 'undo merge must preserve the branch work for recovery');

  // Stage 12: create a genuine main-vs-branch conflict and prove failed merge is atomic.
  const conflictingMainHtml = saved.projects[0].code.html.replace('>Listo</p>', '>Principal</p>');
  result = batch(saved, 'integral_main_edit_012', [
    { type: 'web.code.write', projectId, source: 'main', mode: 'replace', html: conflictingMainHtml }
  ]);
  saved = result.state;
  assert.match(saved.projects[0].code.html, />Principal<\/p>/);
  assert.match(saved.projects[0].branch.code.html, />En revisión<\/p>/);
  const beforeConflictingMerge = JSON.stringify(saved);
  assert.throws(() => batch(saved, 'integral_branch_conflict_013', [
    { type: 'branch.merge', projectId, approved: true }
  ]), { code: 'HEADLESS_BRANCH_CONFLICT' });
  assert.equal(JSON.stringify(saved), beforeConflictingMerge,
    'a conflicting merge must not mutate the persisted workspace state');
  assert.match(saved.projects[0].code.html, />Principal<\/p>/,
    'failed merge must preserve main edits');
  assert.match(saved.projects[0].branch.code.html, />En revisión<\/p>/,
    'failed merge must preserve branch edits');

  const finalRead = queryHeadlessWorkspace(saved, {
    action: 'project.code.read',
    args: { projectId, languages: ['html'] }
  });
  assert.equal(finalRead.result.fields.html.value, saved.projects[0].code.html);
  assert.match(finalRead.result.fields.html.value, />Principal<\/p>/);

  t.diagnostic('Completed one chained project across create → design → edit → convert → same-revision PNG capture → persisted-state read → Chromium interaction → branch create/write/approved merge/undo → conflicting merge atomic rollback → readback.');
});

async function expectVisible(page, selector) {
  await page.locator(selector).waitFor({ state: 'visible' });
}
