'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyHeadlessBatch, queryHeadlessWorkspace } = require('./workspace-runtime');
const { buildAiDesignCaptureContext } = require('./design-export');

function state(projects = []) {
  return { version: 5, revision: 3, updatedAt: '2026-11-01T00:00:00.000Z', projects, owner: { provider: 'local', id: 'test' } };
}
function request(operations, overrides = {}) {
  return { operationId: 'test_op_0001', baseRevision: 3, operations, ...overrides };
}
function webProject(id = 'proj_web1') {
  return { id, name: 'Web', type: 'web', code: { html: '<main>old</main>', css: '', js: '' } };
}
function designProject(id = 'proj_design1') {
  return { id, name: 'Design', type: 'design', code: { html: '', css: '', js: '' }, design: { frame: 'desktop', background: '#fff', canvasWidth: 1440, canvasHeight: 900, elements: [], revision: 0 } };
}

test('creates a design project and applies design operations without a browser', () => {
  const result = applyHeadlessBatch(state(), request([
    { type: 'project.create', projectId: 'proj_newdesign', name: 'Mobile concept', projectType: 'design' },
    { type: 'design.batch', projectId: 'proj_newdesign', expectedDesignRevision: 0, operations: [
      { type: 'canvas.set', width: 720, height: 1600 },
      { type: 'element.add', elementType: 'heading', id: 'el_title', properties: { text: 'Hello', textAlign: 'center', width: 400, height: 60 } }
    ] }
  ]));
  const project = result.state.projects[0];
  assert.equal(project.design.canvasWidth, 720);
  assert.equal(project.design.canvasHeight, 1600);
  assert.equal(project.design.elements.length, 1);
  assert.equal(project.design.elements[0].text, 'Hello');
  assert.match(result.results[1].previewSvg, /text-anchor="middle"/);
  assert.equal(result.revision, 4);
});

test('writes web code to an existing project', () => {
  const result = applyHeadlessBatch(state([webProject()]), request([
    { type: 'web.code.write', projectId: 'proj_web1', html: '<h1>Headless</h1>', css: 'h1{color:red}' }
  ]));
  assert.equal(result.state.projects[0].code.html, '<h1>Headless</h1>');
  assert.equal(result.state.projects[0].code.css, 'h1{color:red}');
  assert.equal(result.state.projects[0].code.js, '');
});

test('duplicates project data but does not copy its active branch or merge history', () => {
  const source = { ...webProject(), branch: { id: 'branch_1', code: { html: 'branch', css: '', js: '' } }, mergeHistory: [{ id: 'merge_1' }] };
  const result = applyHeadlessBatch(state([source]), request([
    { type: 'project.duplicate', projectId: source.id, newProjectId: 'proj_copy1', name: 'Copy' }
  ]));
  const copy = result.state.projects[1];
  assert.equal(copy.code.html, source.code.html);
  assert.equal(copy.name, 'Copy');
  assert.equal('branch' in copy, false);
  assert.equal('mergeHistory' in copy, false);
});

test('renames a project without changing its identity or code', () => {
  const original = webProject();
  const result = applyHeadlessBatch(state([original]), request([
    { type: 'project.rename', projectId: original.id, name: 'Renamed' }
  ]));
  assert.equal(result.state.projects[0].id, original.id);
  assert.equal(result.state.projects[0].name, 'Renamed');
  assert.equal(result.state.projects[0].code.html, original.code.html);
});

test('rejects stale workspace revisions', () => {
  assert.throws(() => applyHeadlessBatch(state(), request([
    { type: 'project.create', projectId: 'proj_newone', name: 'New' }
  ], { baseRevision: 2 })), error => error.code === 'HEADLESS_REVISION_CONFLICT' && error.revision === 3);
});

test('replays the same operation ID and payload without applying twice', () => {
  const first = applyHeadlessBatch(state(), request([
    { type: 'project.create', projectId: 'proj_once', name: 'Once' }
  ]));
  const replay = applyHeadlessBatch(first.state, request([
    { type: 'project.create', projectId: 'proj_once', name: 'Once' }
  ], { baseRevision: 3 }));
  assert.equal(first.state.projects.length, 1);
  assert.equal(replay.state.projects.length, 1);
  assert.equal(replay.replayed, true);
  assert.equal(replay.revision, 4);
});

test('rejects reuse of an operation ID with a different payload', () => {
  const first = applyHeadlessBatch(state(), request([
    { type: 'project.create', projectId: 'proj_once', name: 'Once' }
  ]));
  assert.throws(() => applyHeadlessBatch(first.state, request([
    { type: 'project.create', projectId: 'proj_other', name: 'Other' }
  ], { baseRevision: 3 })), error => error.code === 'HEADLESS_IDEMPOTENCY_CONFLICT');
});

test('a failed batch does not mutate the input workspace', () => {
  const original = state([webProject()]);
  const before = JSON.stringify(original);
  assert.throws(() => applyHeadlessBatch(original, request([
    { type: 'project.rename', projectId: 'proj_web1', name: 'Changed' },
    { type: 'web.code.write', projectId: 'proj_missing', html: 'bad' }
  ])));
  assert.equal(JSON.stringify(original), before);
});

test('rejects web code writes against design projects', () => {
  assert.throws(() => applyHeadlessBatch(state([designProject()]), request([
    { type: 'web.code.write', projectId: 'proj_design1', html: '<p>bad</p>' }
  ])), /requires a web project/);
});

test('bounds batch size and requires safe project IDs', () => {
  assert.throws(() => applyHeadlessBatch(state(), request(
    Array.from({ length: 101 }, () => ({ type: 'project.create', projectId: 'proj_newone', name: 'New' }))
  )), /1 to 100 operations/);
  assert.throws(() => applyHeadlessBatch(state(), request([
    { type: 'project.create', projectId: 'not-a-project-id', name: 'New' }
  ])), /valid projectId/);
});

test('generates project IDs when the caller leaves them out', () => {
  const result = applyHeadlessBatch(state(), request([
    { type: 'project.create', name: 'Generated ID' }
  ]));
  assert.match(result.state.projects[0].id, /^proj_[a-f0-9-]{36}$/);
});

test('persists editor-compatible image attachments through an atomic headless design batch', () => {
  const source = designProject();
  source.design.elements = [{ id: 'el_image', type: 'image', src: '', alt: 'Imagen del diseño' }];
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l6kAAAAASUVORK5CYII=';
  const result = applyHeadlessBatch(state([source]), request([
    { type: 'design.batch', projectId: source.id, expectedDesignRevision: 0, operations: [
      { type: 'image.attach', id: 'el_image', filename: 'hero.png', dataUrl }
    ] }
  ]));
  const saved = result.state.projects[0];
  assert.equal(saved.design.elements[0].src, dataUrl);
  assert.equal(saved.design.elements[0].alt, 'hero');
  assert.equal(saved.design.revision, 1);
  assert.equal(saved.designUndoStack.length, 1);
  assert.deepEqual(result.results[0].operationTypes, ['image.attach']);
});

test('stores compact replay receipts instead of large SVG previews', () => {
  const result = applyHeadlessBatch(state([designProject()]), request([
    { type: 'design.batch', projectId: 'proj_design1', operations: [
      { type: 'element.add', elementType: 'heading', id: 'el_h', properties: { text: 'Preview' } }
    ] }
  ]));
  const receipt = result.state.headlessOperations[0];
  assert.equal(typeof result.results[0].previewSvg, 'string');
  assert.equal(typeof receipt.results[0].previewSvg, 'undefined');
  assert.ok(receipt.results[0].previewSvgLength > 0);
  assert.equal(receipt.results[0].operationCount, 1);
  assert.equal(typeof receipt.results[0].operationResults, 'undefined');
});

test('rejects a stale design revision inside a current workspace revision', () => {
  assert.throws(() => applyHeadlessBatch(state([designProject()]), request([
    { type: 'design.batch', projectId: 'proj_design1', expectedDesignRevision: 9, operations: [
      { type: 'element.add', elementType: 'rectangle', id: 'el_rect' }
    ] }
  ])), error => error.code === 'REVISION_CONFLICT');
});


test('connects design flow between separate design projects', () => {
  const source = designProject('proj_source');
  source.design.elements = [{ id: 'el_link', type: 'button', flowRole: '' }];
  const target = designProject('proj_target');
  const result = applyHeadlessBatch(state([source, target]), request([
    { type: 'design.flow.connect', sourceProjectId: source.id, sourceElementId: 'el_link', targetProjectId: target.id }
  ]));
  assert.deepEqual(result.state.projects[0].design.flowConnections, [
    { sourceElementId: 'el_link', targetProjectId: 'proj_target' }
  ]);
  assert.equal(result.state.projects[0].design.elements[0].flowRole, 'navigate');
});

test('locked layers reject headless flow connect and disconnect without mutation', () => {
  const connectSource = designProject('proj_locked_connect');
  connectSource.design.elements = [{ id: 'el_locked', type: 'button', locked: true, flowRole: '' }];
  const connectTarget = designProject('proj_connect_target');
  const connectState = state([connectSource, connectTarget]);
  const beforeConnect = JSON.stringify(connectState);
  assert.throws(() => applyHeadlessBatch(connectState, request([
    { type: 'design.flow.connect', sourceProjectId: connectSource.id, sourceElementId: 'el_locked', targetProjectId: connectTarget.id }
  ], { operationId: 'test_locked_connect_01' })), error => {
    assert.equal(error.code, 'HEADLESS_LOCKED_ELEMENT');
    assert.match(error.message, /locked layer/i);
    return true;
  });
  assert.equal(JSON.stringify(connectState), beforeConnect, 'failed connect must not mutate the workspace');

  const disconnectSource = designProject('proj_locked_disconnect');
  disconnectSource.design.elements = [{ id: 'el_locked', type: 'button', locked: true, flowRole: 'navigate' }];
  disconnectSource.design.flowConnections = [{ sourceElementId: 'el_locked', targetProjectId: 'proj_other_target' }];
  const disconnectState = state([disconnectSource]);
  const beforeDisconnect = JSON.stringify(disconnectState);
  assert.throws(() => applyHeadlessBatch(disconnectState, request([
    { type: 'design.flow.disconnect', sourceProjectId: disconnectSource.id, sourceElementId: 'el_locked' }
  ], { operationId: 'test_locked_disconnect_01' })), error => {
    assert.equal(error.code, 'HEADLESS_LOCKED_ELEMENT');
    assert.match(error.message, /locked layer/i);
    return true;
  });
  assert.equal(JSON.stringify(disconnectState), beforeDisconnect, 'failed disconnect must preserve connections and flow role');
});

test('locked flow operations preserve already-satisfied no-ops', () => {
  const source = designProject('proj_locked_noop');
  source.design.elements = [{ id: 'el_locked', type: 'button', locked: true, flowRole: 'navigate' }];
  source.design.flowConnections = [{ sourceElementId: 'el_locked', targetProjectId: 'proj_noop_target' }];
  const target = designProject('proj_noop_target');
  const connected = applyHeadlessBatch(state([source, target]), request([
    { type: 'design.flow.connect', sourceProjectId: source.id, sourceElementId: 'el_locked', targetProjectId: target.id }
  ], { operationId: 'test_locked_noop_connect_01' }));
  assert.equal(connected.results[0].changed, false);
  assert.equal(connected.state.projects[0].design.revision, 0);

  const disconnected = designProject('proj_locked_noop_disconnect');
  disconnected.design.elements = [{ id: 'el_locked', type: 'button', locked: true, flowRole: '' }];
  const noConnection = applyHeadlessBatch(state([disconnected]), request([
    { type: 'design.flow.disconnect', sourceProjectId: disconnected.id, sourceElementId: 'el_locked' }
  ], { operationId: 'test_locked_noop_disconnect_01' }));
  assert.equal(noConnection.results[0].changed, false);
  assert.equal(noConnection.state.projects[0].design.revision, 0);
  assert.equal(Object.hasOwn(noConnection.state.projects[0].design, 'flowConnections'), false);
});

test('requires explicit approval to delete a project and cleans incoming flow links', () => {
  const source = designProject('proj_source');
  source.design.flowConnections = [{ sourceElementId: 'el_link', targetProjectId: 'proj_target' }];
  const target = designProject('proj_target');
  assert.throws(() => applyHeadlessBatch(state([source, target]), request([
    { type: 'project.delete', projectId: 'proj_target' }
  ])), /explicit approval/);
  const result = applyHeadlessBatch(state([source, target]), request([
    { type: 'project.delete', projectId: 'proj_target', approved: true }
  ]));
  assert.equal(result.state.projects.length, 1);
  assert.deepEqual(result.state.projects[0].design.flowConnections, []);
});


test('appends and prepends bounded web-code chunks without replacing existing code', () => {
  const result = applyHeadlessBatch(state([webProject()]), request([
    { type: 'web.code.write', projectId: 'proj_web1', html: '<section>middle</section>', mode: 'append' },
    { type: 'web.code.write', projectId: 'proj_web1', html: '<header>start</header>', mode: 'prepend' }
  ]));
  assert.equal(result.state.projects[0].code.html, '<header>start</header><main>old</main><section>middle</section>');
});

test('rejects code writes that exceed the total project field limit', () => {
  const original = webProject();
  original.code.html = 'x'.repeat(500000);
  assert.throws(() => applyHeadlessBatch(state([original]), request([
    { type: 'web.code.write', projectId: 'proj_web1', html: 'y', mode: 'append' }
  ])), /500000 character project limit/);
});


test('inserts a real library component into web HTML and stays idempotent across operation IDs', () => {
  const project = webProject();
  project.code.html = '<html><body><main>old</main></body></html>';
  const first = applyHeadlessBatch(state([project]), request([
    { type: 'component.insert', projectId: 'proj_web1', componentId: 'hero' }
  ]));
  const html = first.state.projects[0].code.html;
  assert.match(html, /codelab-component:hero:v1/);
  assert.match(html, /Convierte tus ideas en algo extraordinario/);
  assert.match(html, /<\/body>/);
  const second = applyHeadlessBatch(first.state, request([
    { type: 'component.insert', projectId: 'proj_web1', componentId: 'hero' }
  ], { operationId: 'test_op_0002', baseRevision: 4 }));
  assert.equal(second.state.projects[0].code.html, html);
  assert.equal(second.results[0].alreadyPresent, true);
});

test('rejects unknown components and insertion into design-only projects', () => {
  assert.throws(() => applyHeadlessBatch(state([webProject()]), request([
    { type: 'component.insert', projectId: 'proj_web1', componentId: 'missing' }
  ])), error => error.code === 'HEADLESS_COMPONENT_NOT_FOUND');
  assert.throws(() => applyHeadlessBatch(state([designProject()]), request([
    { type: 'component.insert', projectId: 'proj_design1', componentId: 'hero' }
  ])), /requires a web project/);
});

test('applies sanitized design tokens through the existing CodeLab token generator', () => {
  const project = webProject();
  project.code.css = 'body{margin:0}';
  const result = applyHeadlessBatch(state([project]), request([
    { type: 'design.tokens.apply', projectId: project.id, settings: {
      name: 'Brand', primary: '#123456', secondary: '#234567', accent: '#345678',
      surface: '#ffffff', background: '#f8fafc', text: '#0f172a',
      contrastForeground: '#0f172a', contrastBackground: '#ffffff',
      baseFont: 18, typeRatio: 1.2, baseSpacing: 6, baseRadius: 10
    } }
  ]));
  const css = result.state.projects[0].code.css;
  assert.match(css, /body\{margin:0\}/);
  assert.match(css, /CodeLab Design Tokens START/);
  assert.match(css, /--color-primary: #123456/);
  assert.equal(result.results[0].tokens.name, 'Brand');
  assert.equal((css.match(/CodeLab Design Tokens START/g) || []).length, 1);
});

test('reapplying design tokens replaces the managed block instead of duplicating it', () => {
  const project = webProject();
  const settings = {
    name: 'Brand', primary: '#123456', secondary: '#234567', accent: '#345678',
    surface: '#ffffff', background: '#f8fafc', text: '#0f172a',
    contrastForeground: '#0f172a', contrastBackground: '#ffffff',
    baseFont: 18, typeRatio: 1.2, baseSpacing: 6, baseRadius: 10
  };
  const first = applyHeadlessBatch(state([project]), request([
    { type: 'design.tokens.apply', projectId: project.id, settings }
  ]));
  const second = applyHeadlessBatch(first.state, request([
    { type: 'design.tokens.apply', projectId: project.id, settings: { ...settings, primary: '#abcdef' } }
  ], { operationId: 'test_op_0002', baseRevision: 4 }));
  const css = second.state.projects[0].code.css;
  assert.match(css, /--color-primary: #abcdef/);
  assert.equal((css.match(/CodeLab Design Tokens START/g) || []).length, 1);
});

test('lists saved projects without relying on editor state or mutating workspace data', () => {
  const original = state([webProject('proj_web1'), designProject('proj_design1')]);
  const before = JSON.stringify(original);
  const listed = queryHeadlessWorkspace(original, { action: 'project.list' });
  assert.equal(listed.result.count, 2);
  assert.deepEqual(listed.result.projects.map(project => project.id), ['proj_web1', 'proj_design1']);
  assert.equal(listed.result.projects[1].type, 'design');
  assert.equal(JSON.stringify(original), before);
});

test('queries the real component catalog without mutating workspace state', () => {
  const original = state([webProject()]);
  const before = JSON.stringify(original);
  const found = queryHeadlessWorkspace(original, { action: 'component.search', args: { query: 'hero', limit: 5 } });
  assert.ok(found.result.some(item => item.id === 'hero'));
  const inspected = queryHeadlessWorkspace(original, { action: 'component.inspect', args: { componentId: 'hero', maxChars: 7000 } });
  assert.match(inspected.result.standaloneHtml, /<!doctype html>/i);
  assert.equal(inspected.result.truncated, false);
  assert.equal(JSON.stringify(original), before);
});

test('generates design tokens and CSS through the shared design-tools module', () => {
  const result = queryHeadlessWorkspace(state(), { action: 'design.tokens.generate', args: { settings: {
    name: 'Query system', primary: '#123456', secondary: '#234567', accent: '#345678',
    surface: '#ffffff', background: '#f8fafc', text: '#0f172a',
    contrastForeground: '#0f172a', contrastBackground: '#ffffff',
    baseFont: 18, typeRatio: 1.2, baseSpacing: 6, baseRadius: 10
  } } });
  assert.equal(result.result.tokens.name, 'Query system');
  assert.match(result.result.cssVariables, /--color-primary: #123456/);
});

test('inspects saved project and reads bounded main or branch code without mutation', () => {
  const project = webProject();
  project.code.html = 'h'.repeat(25000);
  project.branch = { id: 'branch_1', code: { html: 'branch source', css: '', js: '' }, updatedAt: '2026-11-01T00:00:00Z' };
  const original = state([project]);
  const info = queryHeadlessWorkspace(original, { action: 'project.inspect', args: { projectId: project.id } });
  assert.equal(info.result.codeLengths.html, 25000);
  assert.equal(info.result.branch.id, 'branch_1');
  const read = queryHeadlessWorkspace(original, { action: 'project.code.read', args: {
    projectId: project.id, source: 'main', languages: ['html'], maxChars: 100
  } });
  assert.equal(read.result.fields.html.value.length, 100);
  assert.equal(read.result.fields.html.truncated, true);
  assert.equal(read.result.fields.html.offset, 0);
  assert.equal(read.result.fields.html.nextOffset, 100);
  const secondPage = queryHeadlessWorkspace(original, { action: 'project.code.read', args: {
    projectId: project.id, source: 'main', languages: ['html'], maxChars: 100, offset: 100
  } });
  assert.equal(secondPage.result.fields.html.value, 'h'.repeat(100));
  assert.equal(secondPage.result.fields.html.offset, 100);
  assert.equal(secondPage.result.fields.html.nextOffset, 200);
  assert.equal(secondPage.result.fields.html.truncated, true);
  const finalPage = queryHeadlessWorkspace(original, { action: 'project.code.read', args: {
    projectId: project.id, source: 'main', languages: ['html'], maxChars: 100, offset: 24900
  } });
  assert.equal(finalPage.result.fields.html.value, 'h'.repeat(100));
  assert.equal(finalPage.result.fields.html.nextOffset, null);
  assert.equal(finalPage.result.fields.html.truncated, false);
  const branchRead = queryHeadlessWorkspace(original, { action: 'project.code.read', args: {
    projectId: project.id, source: 'branch', languages: ['html']
  } });
  assert.equal(branchRead.result.fields.html.value, 'branch source');
  assert.equal(branchRead.result.fields.html.nextOffset, null);
  assert.throws(() => queryHeadlessWorkspace(original, { action: 'project.code.read', args: {
    projectId: project.id, languages: ['html'], offset: -1
  } }), /offset must be an integer/);
  assert.equal(original.projects[0].code.html.length, 25000);
});

test('design.read preserves responsive metadata and reports text truncation without image payloads', () => {
  const project = designProject();
  project.design.elements = [{
    id: 'el_image', type: 'image', x: 10, y: 20, xUnit: '%', yUnit: '%',
    width: 100, height: 80, widthUnit: 'auto', heightUnit: '%',
    identifier: 'hero-image', hidden: true, visible: false, text: 'T'.repeat(2501),
    src: 'data:image/png;base64,' + 'x'.repeat(5000), alt: 'Preview'
  }];
  const result = queryHeadlessWorkspace(state([project]), { action: 'design.read', args: { projectId: project.id } });
  const element = result.result.elements[0];
  assert.equal(element.hasImageSource, true);
  assert.equal(element.imageSourceLength, 5022);
  assert.equal(Object.prototype.hasOwnProperty.call(element, 'src'), false);
  assert.equal(element.xUnit, '%');
  assert.equal(element.yUnit, '%');
  assert.equal(element.widthUnit, 'auto');
  assert.equal(element.heightUnit, '%');
  assert.equal(element.identifier, 'hero-image');
  assert.equal(element.hidden, true);
  assert.equal(element.visible, false);
  assert.equal(element.text.length, 2000);
  assert.equal(element.textLength, 2501);
  assert.equal(element.textTruncated, true);
});

test('design.read returns all layers through the 500-layer limit when requested', () => {
  const project = designProject();
  project.design.elements = Array.from({ length: 250 }, (_, index) => ({
    id: 'el_' + index, type: 'rectangle', x: index, y: 0, width: 20, height: 20
  }));
  const result = queryHeadlessWorkspace(state([project]), {
    action: 'design.read', args: { projectId: project.id, limit: 500 }
  });
  assert.equal(result.result.elements.length, 250);
  assert.equal(result.result.totalElements, 250);
  assert.equal(result.result.truncated, false);
});

test('runs the existing static accessibility audit against saved web HTML', () => {
  const project = webProject();
  project.code.html = '<html><head></head><body><img src="x.png"></body></html>';
  const result = queryHeadlessWorkspace(state([project]), { action: 'accessibility.audit', args: { projectId: project.id } });
  assert.ok(result.result.issues.some(item => item.code === 'image-missing-alt'));
});

test('rejects invalid headless query types and unknown components', () => {
  assert.throws(() => queryHeadlessWorkspace(state(), { action: 'not.real', args: {} }), error => error.code === 'HEADLESS_INVALID_QUERY');
  assert.throws(() => queryHeadlessWorkspace(state(), { action: 'component.inspect', args: { componentId: 'not-real' } }), error => error.code === 'HEADLESS_COMPONENT_NOT_FOUND');
});

test('generated duplicate project names stay within the 200 character limit', () => {
  const source = webProject();
  source.name = 'S'.repeat(200);
  const duplicated = applyHeadlessBatch(state([source]), request([
    { type: 'project.duplicate', projectId: source.id, newProjectId: 'proj_long_name_copy' }
  ], { operationId: 'test_duplicate_long_name_01' }));
  const duplicate = duplicated.state.projects.find(project => project.id === 'proj_long_name_copy');
  assert.equal(duplicate.name.length, 200);
  assert.ok(duplicate.name.endsWith(' copy'));
  assert.equal(duplicate.name, 'S'.repeat(195) + ' copy');
});

test('creates an isolated branch, performs a three-way merge, and can undo it', () => {
  const initial = state([webProject()]);
  const created = applyHeadlessBatch(initial, request([
    { type: 'branch.create', projectId: 'proj_web1', branchId: 'branch_work1' }
  ], { operationId: 'test_branch_01' }));
  assert.equal(created.state.projects[0].branch.id, 'branch_work1');
  assert.deepEqual(created.state.projects[0].branch.code, initial.projects[0].code);

  const edited = applyHeadlessBatch(created.state, request([
    { type: 'web.code.write', projectId: 'proj_web1', source: 'branch', html: '<h1>Branch work</h1>' },
    { type: 'web.code.write', projectId: 'proj_web1', source: 'main', css: 'body{color:navy}' }
  ], { operationId: 'test_branch_02', baseRevision: 4 }));
  const merged = applyHeadlessBatch(edited.state, request([
    { type: 'branch.merge', projectId: 'proj_web1', approved: true }
  ], { operationId: 'test_branch_03', baseRevision: 5 }));
  assert.equal(merged.state.projects[0].code.html, '<h1>Branch work</h1>');
  assert.equal(merged.state.projects[0].code.css, 'body{color:navy}');
  assert.equal(merged.state.projects[0].branch, undefined);
  assert.equal(merged.state.projects[0].mergeHistory.length, 1);
  const mergeBackup = merged.state.projects[0].mergeHistory[0];
  assert.equal(typeof mergeBackup.mergedCodeHash, 'string');
  assert.equal(mergeBackup.mergedCode, undefined, 'new backups should not duplicate the full merged source');

  const undone = applyHeadlessBatch(merged.state, request([
    { type: 'branch.undo_merge', projectId: 'proj_web1', approved: true }
  ], { operationId: 'test_branch_04', baseRevision: 6 }));
  assert.equal(undone.state.projects[0].code.html, '<main>old</main>');
  assert.equal(undone.state.projects[0].code.css, 'body{color:navy}', 'undo must restore the exact main code state immediately before merge');
  assert.equal(undone.state.projects[0].branch.id, 'branch_work1');
  assert.equal(undone.state.projects[0].branch.code.html, '<h1>Branch work</h1>');
  assert.equal(undone.state.projects[0].mergeHistory.length, 0);
  assert.ok(Date.parse(undone.state.projects[0].updatedAt) >= Date.parse(merged.state.projects[0].updatedAt),
    'undo is a new project mutation and must not move updatedAt backward');
});

test('refuses to undo a merge after later main-code edits', () => {
  const created = applyHeadlessBatch(state([webProject()]), request([
    { type: 'branch.create', projectId: 'proj_web1', branchId: 'branch_undo_guard' }
  ], { operationId: 'test_undo_guard_01' }));
  const edited = applyHeadlessBatch(created.state, request([
    { type: 'web.code.write', projectId: 'proj_web1', source: 'branch', html: '<h1>Merged</h1>' }
  ], { operationId: 'test_undo_guard_02', baseRevision: 4 }));
  const merged = applyHeadlessBatch(edited.state, request([
    { type: 'branch.merge', projectId: 'proj_web1', approved: true }
  ], { operationId: 'test_undo_guard_03', baseRevision: 5 }));
  const laterEdit = applyHeadlessBatch(merged.state, request([
    { type: 'web.code.write', projectId: 'proj_web1', html: '<h1>Newer user work</h1>' }
  ], { operationId: 'test_undo_guard_04', baseRevision: 6 }));

  assert.throws(() => applyHeadlessBatch(laterEdit.state, request([
    { type: 'branch.undo_merge', projectId: 'proj_web1', approved: true }
  ], { operationId: 'test_undo_guard_05', baseRevision: 7 })), error => {
    assert.equal(error.code, 'HEADLESS_BRANCH_UNDO_CONFLICT');
    assert.match(error.message, /code changed afterward/i);
    return true;
  });
  assert.equal(laterEdit.state.projects[0].code.html, '<h1>Newer user work</h1>');
  assert.equal(laterEdit.state.projects[0].mergeHistory.length, 1,
    'a rejected undo must preserve the merge backup for inspection');
  assert.equal(laterEdit.state.projects[0].branch, undefined,
    'a rejected undo must not recreate the old branch');
});

test('rejects malformed merge history before changing project state', () => {
  const malformed = webProject();
  malformed.updatedAt = '2026-11-01T00:00:00.000Z';
  malformed.mergeHistory = [null];
  const initial = state([malformed]);
  assert.throws(() => applyHeadlessBatch(initial, request([
    { type: 'branch.undo_merge', projectId: 'proj_web1', approved: true }
  ], { operationId: 'test_bad_merge_history_01' })), error => {
    assert.equal(error.code, 'HEADLESS_INVALID_MERGE_HISTORY');
    assert.match(error.message, /history entry is invalid/i);
    return true;
  });
  assert.equal(initial.projects[0].code.html, '<main>old</main>');
  assert.deepEqual(initial.projects[0].mergeHistory, [null]);
  assert.equal(initial.projects[0].updatedAt, '2026-11-01T00:00:00.000Z');
});

test('refuses to undo a merge over a branch created afterward', () => {
  const created = applyHeadlessBatch(state([webProject()]), request([
    { type: 'branch.create', projectId: 'proj_web1', branchId: 'branch_before_merge' }
  ], { operationId: 'test_undo_branch_guard_01' }));
  const edited = applyHeadlessBatch(created.state, request([
    { type: 'web.code.write', projectId: 'proj_web1', source: 'branch', html: '<h1>Merged</h1>' }
  ], { operationId: 'test_undo_branch_guard_02', baseRevision: 4 }));
  const merged = applyHeadlessBatch(edited.state, request([
    { type: 'branch.merge', projectId: 'proj_web1', approved: true }
  ], { operationId: 'test_undo_branch_guard_03', baseRevision: 5 }));
  const newBranch = applyHeadlessBatch(merged.state, request([
    { type: 'branch.create', projectId: 'proj_web1', branchId: 'branch_after_merge' },
    { type: 'web.code.write', projectId: 'proj_web1', source: 'branch', html: '<h1>New branch work</h1>' }
  ], { operationId: 'test_undo_branch_guard_04', baseRevision: 6 }));

  assert.throws(() => applyHeadlessBatch(newBranch.state, request([
    { type: 'branch.undo_merge', projectId: 'proj_web1', approved: true }
  ], { operationId: 'test_undo_branch_guard_05', baseRevision: 7 })), error => {
    assert.equal(error.code, 'HEADLESS_BRANCH_UNDO_CONFLICT');
    assert.match(error.message, /new branch was created afterward/i);
    return true;
  });
  assert.equal(newBranch.state.projects[0].branch.id, 'branch_after_merge');
  assert.equal(newBranch.state.projects[0].branch.code.html, '<h1>New branch work</h1>');
  assert.equal(newBranch.state.projects[0].mergeHistory.length, 1);
});

test('rejects conflicting branch merges without changing main or branch data', () => {
  const created = applyHeadlessBatch(state([webProject()]), request([
    { type: 'branch.create', projectId: 'proj_web1', branchId: 'branch_conflict' }
  ], { operationId: 'test_branch_11' }));
  const edited = applyHeadlessBatch(created.state, request([
    { type: 'web.code.write', projectId: 'proj_web1', source: 'branch', html: '<h1>Branch</h1>' },
    { type: 'web.code.write', projectId: 'proj_web1', source: 'main', html: '<h1>Main</h1>' }
  ], { operationId: 'test_branch_12', baseRevision: 4 }));
  assert.throws(() => applyHeadlessBatch(edited.state, request([
    { type: 'branch.merge', projectId: 'proj_web1', approved: true }
  ], { operationId: 'test_branch_13', baseRevision: 5 })), error => {
    assert.equal(error.code, 'HEADLESS_BRANCH_CONFLICT');
    assert.deepEqual(error.conflicts, ['HTML']);
    return true;
  });
  assert.equal(edited.state.projects[0].code.html, '<h1>Main</h1>');
  assert.equal(edited.state.projects[0].branch.code.html, '<h1>Branch</h1>');
});

test('records persistent design undo/redo history and keeps design revisions monotonic', () => {
  const created = applyHeadlessBatch(state([designProject()]), request([
    { type: 'design.batch', projectId: 'proj_design1', expectedDesignRevision: 0, operations: [
      { type: 'element.add', elementType: 'rectangle', id: 'el_box', properties: { x: 10, y: 20, width: 100, height: 80 } }
    ] }
  ]));
  assert.equal(created.state.projects[0].designUndoStack.length, 1);
  assert.equal(created.state.projects[0].design.elements.length, 1);

  const undone = applyHeadlessBatch(created.state, request([
    { type: 'design.history.undo', projectId: 'proj_design1' }
  ], { operationId: 'test_history_02', baseRevision: 4 }));
  assert.equal(undone.state.projects[0].design.elements.length, 0);
  assert.equal(undone.state.projects[0].design.revision, 2);
  assert.equal(undone.state.projects[0].designRedoStack.length, 1);

  const redone = applyHeadlessBatch(undone.state, request([
    { type: 'design.history.redo', projectId: 'proj_design1' }
  ], { operationId: 'test_history_03', baseRevision: 5 }));
  assert.equal(redone.state.projects[0].design.elements.length, 1);
  assert.equal(redone.state.projects[0].design.revision, 3);
  assert.equal(redone.state.projects[0].designUndoStack.length, 1);
});

test('queries branch and design history state without mutating the workspace', () => {
  const project = webProject();
  project.branch = { id: 'branch_inspect', baseCode: project.code, code: { html: 'draft', css: '', js: '' }, updatedAt: '2026-11-01T00:00:00Z' };
  const design = designProject();
  design.designUndoStack = ['{}'];
  const original = state([project, design]);
  const before = JSON.stringify(original);
  const branch = queryHeadlessWorkspace(original, { action: 'branch.inspect', args: { projectId: project.id } });
  assert.equal(branch.result.exists, true);
  assert.equal(branch.result.branch.id, 'branch_inspect');
  const history = queryHeadlessWorkspace(original, { action: 'design.history.inspect', args: { projectId: design.id } });
  assert.equal(history.result.canUndo, true);
  assert.equal(history.result.canRedo, false);
  assert.equal(JSON.stringify(original), before);
});

test('applies responsive landing and dashboard templates through the shared design schema', () => {
  const mobile = designProject();
  mobile.design.canvasWidth = 720;
  mobile.design.canvasHeight = 1600;
  const landing = applyHeadlessBatch(state([mobile]), request([
    { type: 'design.template.apply', projectId: mobile.id, templateId: 'landing' }
  ]));
  const landingDesign = landing.state.projects[0].design;
  assert.equal(landingDesign.elements.length, 4);
  assert.equal(landingDesign.background, '#ffffff');
  assert.equal(landingDesign.elements[0].x, 24);
  assert.equal(landingDesign.elements[0].width, 672);
  assert.equal(landingDesign.elements[0].fontSize, 30);
  assert.equal(landingDesign.elements[3].height, 220);
  assert.equal(landingDesign.revision, 1);
  assert.equal(landing.state.projects[0].designUndoStack.length, 1);

  const desktop = designProject('proj_dashboard');
  desktop.design.canvasWidth = 1440;
  const dashboard = applyHeadlessBatch(state([desktop]), request([
    { type: 'design.template.apply', projectId: desktop.id, templateId: 'dashboard' }
  ]));
  assert.equal(dashboard.state.projects[0].design.elements.length, 11);
  assert.equal(dashboard.state.projects[0].design.background, '#f8fafc');
  assert.equal(dashboard.state.projects[0].design.elements[0].fontSize, 36);
});

test('requires approval before replacing existing design layers with a template', () => {
  const project = designProject();
  project.design.elements = [{ id: 'el_existing', type: 'rectangle', x: 0, y: 0, width: 20, height: 20 }];
  assert.throws(() => applyHeadlessBatch(state([project]), request([
    { type: 'design.template.apply', projectId: project.id, templateId: 'portfolio' }
  ])), error => error.code === 'HEADLESS_TEMPLATE_REPLACE_REQUIRED');
  assert.throws(() => applyHeadlessBatch(state([project]), request([
    { type: 'design.template.apply', projectId: project.id, templateId: 'portfolio', replaceExisting: true }
  ])), /requires approved:true/);
  const result = applyHeadlessBatch(state([project]), request([
    { type: 'design.template.apply', projectId: project.id, templateId: 'portfolio', replaceExisting: true, approved: true }
  ]));
  assert.equal(result.state.projects[0].design.elements.length, 8);
});

test('lists available design templates without changing the workspace and rejects unknown templates', () => {
  const original = state([designProject()]);
  const before = JSON.stringify(original);
  const list = queryHeadlessWorkspace(original, { action: 'design.template.list', args: {} });
  assert.deepEqual(list.result.map(item => item.id), ['landing', 'dashboard', 'portfolio']);
  assert.equal(JSON.stringify(original), before);
  assert.throws(() => applyHeadlessBatch(original, request([
    { type: 'design.template.apply', projectId: 'proj_design1', templateId: 'unknown' }
  ])), error => error.code === 'HEADLESS_TEMPLATE_NOT_FOUND');
});

test('exports design projects as CodeLab JSON, responsive HTML, and SVG without mutation', () => {
  const project = designProject();
  project.name = 'Export demo';
  project.design.canvasWidth = 720;
  project.design.canvasHeight = 1600;
  project.design.elements = [{ id: 'el_title', type: 'heading', label: 'Title', text: 'Export me', x: 20, y: 30, width: 500, height: 70 }];
  const original = state([project]);
  const before = JSON.stringify(original);
  const json = queryHeadlessWorkspace(original, { action: 'design.export.json', args: { projectId: project.id } });
  assert.equal(json.result.payload.format, 'codelab-design-project');
  assert.equal(json.result.payload.version, 1);
  assert.equal(JSON.parse(json.result.json).project.name, 'Export demo');
  const svg = queryHeadlessWorkspace(original, { action: 'design.export.svg', args: { projectId: project.id } });
  assert.match(svg.result.svg, /^<svg/);
  assert.match(svg.result.svg, /width="720"/);
  const html = queryHeadlessWorkspace(original, { action: 'design.export.html', args: { projectId: project.id } });
  assert.match(html.result.html, /<meta name="viewport"/);
  assert.match(html.result.html, /<main id="designFrame"/);
  assert.match(html.result.html, /<h1 id="layer-el_title"/);
  assert.equal(JSON.stringify(original), before);
});

test('imports a CodeLab design backup as a new project with remapped internal links', () => {
  const source = designProject();
  source.name = 'Source design';
  source.code = { html: '<main>included</main>', css: 'h1{color:red}', js: '' };
  source.design.canvasWidth = 720;
  source.design.canvasHeight = 1600;
  source.design.elements = [
    { id: 'el_button', type: 'button', label: 'Go', text: 'Go', href: '#layer-el_box', x: 0, y: 0, width: 100, height: 40 },
    { id: 'el_box', type: 'rectangle', label: 'Box', text: '', x: 120, y: 0, width: 100, height: 100 }
  ];
  const exported = queryHeadlessWorkspace(state([source]), { action: 'design.export.json', args: { projectId: source.id } });
  const imported = applyHeadlessBatch(state([source]), request([
    { type: 'design.import.json', json: exported.result.json }
  ]));
  const project = imported.state.projects[1];
  assert.equal(project.type, 'design');
  assert.equal(project.name, 'Source design (Importado)');
  assert.equal(project.design.canvasWidth, 720);
  assert.equal(project.design.canvasHeight, 1600);
  assert.equal(project.code.html, '<main>included</main>');
  assert.notEqual(project.design.elements[0].id, 'el_button');
  assert.equal(project.design.elements[0].href, '#layer-' + project.design.elements[1].id);
});

test('rejects invalid and unsafe design imports without partially adding a project', () => {
  assert.throws(() => applyHeadlessBatch(state(), request([
    { type: 'design.import.json', json: '{not json' }
  ])), error => error.code === 'HEADLESS_INVALID_DESIGN_IMPORT');
  const unsafe = {
    format: 'codelab-design-project', version: 1,
    project: { type: 'design', name: 'Unsafe', code: {}, design: {
      elements: [{ id: 'el_image', type: 'image', src: 'javascript:alert(1)' }]
    } }
  };
  assert.throws(() => applyHeadlessBatch(state(), request([
    { type: 'design.import.json', json: JSON.stringify(unsafe) }
  ])), error => error.code === 'HEADLESS_INVALID_DESIGN_IMPORT');
});

test('converts a design project to a web project while preserving its design source', () => {
  const project = designProject();
  project.design.elements = [{ id: 'el_title', type: 'heading', label: 'Title', text: 'Converted', x: 10, y: 20, width: 400, height: 60 }];
  const result = applyHeadlessBatch(state([project]), request([
    { type: 'design.convert.toWeb', projectId: project.id }
  ]));
  const converted = result.state.projects[0];
  assert.equal(converted.type, 'web');
  assert.equal(converted.hasWebSpace, true);
  assert.equal(converted.hasDesignSpace, true);
  assert.ok(converted.design);
  assert.match(converted.code.html, /<main id="designFrame"/);
  assert.match(converted.code.html, /<h1 id="layer-el_title"/);
  assert.match(converted.code.html, /Converted/);
  assert.equal(converted.code.css, '');
  assert.equal(converted.code.js, '');
});

test('records and verifies an AI request fingerprint for idempotent headless retries', () => {
  const requestKey = 'a'.repeat(64);
  const saved = applyHeadlessBatch(state([webProject()]), request([
    { type: 'web.code.write', projectId: 'proj_web1', html: '<h1>Generated</h1>', mode: 'replace', headlessAiRequestKey: requestKey }
  ], { operationId: 'test_ai_0001' }));
  const status = queryHeadlessWorkspace(saved.state, { action: 'headless.operation.status', args: {
    operationId: 'test_ai_0001', requestKey
  } });
  assert.equal(status.result.found, true);
  assert.equal(status.result.revision, saved.revision);
  assert.equal(status.result.requestKey, requestKey);
  assert.throws(() => queryHeadlessWorkspace(saved.state, { action: 'headless.operation.status', args: {
    operationId: 'test_ai_0001', requestKey: 'b'.repeat(64)
  } }), error => error.code === 'HEADLESS_IDEMPOTENCY_CONFLICT');
  const missing = queryHeadlessWorkspace(saved.state, { action: 'headless.operation.status', args: {
    operationId: 'test_ai_0002', requestKey: 'c'.repeat(64)
  } });
  assert.equal(missing.result.found, false);
});

test('headless AI operation status verifies idempotent request keys without exposing provider secrets', () => {
  const requestKey = 'a'.repeat(64);
  const saved = applyHeadlessBatch(state([webProject()]), request([
    { type: 'web.code.write', projectId: 'proj_web1', html: '<main>AI output</main>', mode: 'replace', headlessAiRequestKey: requestKey }
  ]));
  const status = queryHeadlessWorkspace(saved.state, {
    action: 'headless.operation.status',
    args: { operationId: 'test_op_0001', requestKey }
  });
  assert.equal(status.result.found, true);
  assert.equal(status.result.revision, saved.revision);
  assert.equal(status.result.requestKey, requestKey);
  assert.throws(() => queryHeadlessWorkspace(saved.state, {
    action: 'headless.operation.status',
    args: { operationId: 'test_op_0001', requestKey: 'b'.repeat(64) }
  }), error => error.code === 'HEADLESS_IDEMPOTENCY_CONFLICT');
  const missing = queryHeadlessWorkspace(saved.state, {
    action: 'headless.operation.status',
    args: { operationId: 'test_op_missing' }
  });
  assert.equal(missing.result.found, false);
});

test('exports connected design projects as semantic HTML with working prototype navigation', () => {
  const first = designProject('proj_flow_first');
  first.name = 'First screen';
  first.design.frame = 'mobile';
  first.design.canvasWidth = 390;
  first.design.canvasHeight = 844;
  first.design.elements = [
    { id: 'el_title', type: 'heading', label: 'Title', text: 'Welcome', x: 20, y: 20, width: 300, height: 60 },
    { id: 'el_next', type: 'button', label: 'Next', text: 'Continue', x: 20, y: 100, width: 300, height: 48 }
  ];
  first.design.flowConnections = [{ sourceElementId: 'el_next', targetProjectId: 'proj_flow_second' }];
  const second = designProject('proj_flow_second');
  second.name = 'Second screen';
  second.design.frame = 'mobile';
  second.design.canvasWidth = 390;
  second.design.canvasHeight = 844;
  second.design.elements = [
    { id: 'el_done', type: 'heading', label: 'Done', text: 'You made it', x: 20, y: 20, width: 300, height: 60 }
  ];
  const workspace = state([first, second]);
  const html = queryHeadlessWorkspace(workspace, {
    action: 'design.export.html',
    args: { projectId: first.id }
  }).result.html;
  assert.match(html, /data-page-id="proj_flow_first"/);
  assert.match(html, /data-page-id="proj_flow_second"/);
  assert.match(html, /data-flow-to="proj_flow_second"/);
  assert.match(html, /id="layer-el_title"/);
  assert.match(html, /<h1[^>]*>Welcome<\/h1>/);
  assert.match(html, /function show\(id\)/);
  assert.match(html, /addEventListener\("keydown"/);
  assert.match(html, /@media\(max-width:768px\)/);
});

test('semantic HTML export sanitizes image and external link sources', () => {
  const project = designProject();
  project.design.elements = [
    { id: 'el_bad', type: 'image', label: 'Bad image', src: 'javascript:alert(1)', x: 0, y: 0, width: 100, height: 100 },
    { id: 'el_link', type: 'button', label: 'Bad link', text: 'Unsafe link', href: 'javascript:alert(1)', x: 0, y: 120, width: 120, height: 40 }
  ];
  const html = queryHeadlessWorkspace(state([project]), {
    action: 'design.export.html',
    args: { projectId: project.id }
  }).result.html;
  assert.doesNotMatch(html, /javascript:/i);
  assert.match(html, /Añade una imagen/);
  assert.match(html, /<button[^>]*>Unsafe link<\/button>/);
});


test('builds AI design capture context headlessly with custom canvas and scaled pixel bounds', () => {
  const project = designProject();
  project.name = 'Mobile Landing';
  project.design.frame = 'mobile';
  project.design.canvasWidth = 720;
  project.design.canvasHeight = 1600;
  project.design.layoutMode = 'free';
  project.design.elements = [
    { id: 'el_title', type: 'heading', label: 'Título', text: 'Hola mundo', x: 12, y: 24, width: 300, height: 80, fontSize: 32, weight: 700, color: '#111827', background: 'transparent' },
    { id: 'el_image', type: 'image', label: 'Imagen', alt: 'Portada', src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l6kAAAAASUVORK5CYII=', x: 20, y: 130, width: 240, height: 160 }
  ];
  const context = buildAiDesignCaptureContext(project, 2);
  assert.equal(context.format, 'codelab-ai-design-capture');
  assert.equal(context.designRevision, project.design.revision, 'capture context must carry the saved design revision');
  assert.equal(context.canvas.width, 720);
  assert.equal(context.canvas.height, 1600);
  assert.equal(context.canvas.pixelWidth, 1440);
  assert.equal(context.canvas.pixelHeight, 3200);
  assert.equal(context.elementCount, 2);
  assert.deepEqual(context.elements[0].bounds, { x: 12, y: 24, width: 300, height: 80 });
  assert.deepEqual(context.elements[1].image, { alt: 'Portada' });
  assert.match(context.aiInstructions, /720 × 1600 px/);
  assert.equal(project.design.canvasWidth, 720, 'capture context must not mutate the source project');
});

test('rejects unsupported AI design capture scales and excessive pixel counts', () => {
  const project = designProject();
  assert.throws(() => buildAiDesignCaptureContext(project, 5), { code: 'HEADLESS_INVALID_CAPTURE_SCALE' });
  project.design.canvasWidth = 4000;
  project.design.canvasHeight = 4000;
  assert.throws(() => buildAiDesignCaptureContext(project, 3), { code: 'HEADLESS_CAPTURE_TOO_LARGE' });
});


test('exposes AI design capture context as a read-only headless query', () => {
  const project = designProject();
  project.design.canvasWidth = 720;
  project.design.canvasHeight = 1600;
  project.design.elements = [{ id: 'el_heading', type: 'heading', text: 'Hola', x: 10, y: 20, width: 200, height: 60 }];
  const before = JSON.stringify(project);
  const workspace = state([project]);
  const result = queryHeadlessWorkspace(workspace, {
    action: 'design.capture.context',
    args: { projectId: project.id, scale: 1 }
  });
  assert.equal(result.result.format, 'codelab-ai-design-capture');
  assert.equal(result.result.designRevision, project.design.revision, 'read-only capture query must expose the same saved design revision');
  assert.equal(result.result.canvas.width, 720);
  assert.equal(result.result.canvas.height, 1600);
  assert.equal(workspace.revision, 3, 'read-only capture query must not increment workspace revision');
  assert.equal(JSON.stringify(project), before, 'capture query must not mutate the saved project');
});

test('[HL-Ω] AI capture context resolves Auto Layout wrapping to concrete layer bounds', () => {
  const project = designProject();
  project.design.frame = 'mobile';
  project.design.canvasWidth = 320;
  project.design.canvasHeight = 100;
  project.design.layoutMode = 'auto';
  project.design.layoutDirection = 'row';
  project.design.layoutGap = 10;
  project.design.layoutPadding = 10;
  project.design.elements = [
    { id: 'hl_omega_first', type: 'rectangle', label: 'First', x: 999, y: 999, width: 200, height: 40 },
    { id: 'hl_omega_second', type: 'rectangle', label: 'Second', x: 999, y: 999, width: 200, height: 40 }
  ];

  const context = buildAiDesignCaptureContext(project, 1);

  assert.equal(context.layout.mode, 'auto');
  assert.equal(context.canvas.width, 320);
  assert.deepEqual(context.elements.map(element => element.bounds), [
    { x: 10, y: 10, width: 200, height: 40 },
    { x: 10, y: 60, width: 200, height: 40 }
  ]);
  assert.equal(context.canvas.pixelWidth, 320);
  assert.equal(context.canvas.pixelHeight, context.canvas.height);
});



test('integrates one saved project from design creation through export, conversion, code edits, and readback', () => {
  let workspace = state();
  const run = (operations, operationId, baseRevision) => applyHeadlessBatch(workspace, {
    operationId, baseRevision, operations
  });

  let result = run([
    { type: 'project.create', projectId: 'proj_fullflow', name: 'Full-flow mobile app', projectType: 'design' },
    { type: 'design.batch', projectId: 'proj_fullflow', expectedDesignRevision: 0, operations: [
      { type: 'canvas.set', frame: 'mobile', width: 720, height: 1600, background: '#f8fafc' },
      { type: 'element.add', elementType: 'heading', id: 'el_heading', properties: { text: 'Mi aplicación', x: 50, y: 8, xUnit: '%', yUnit: '%', width: 360, height: 64 } },
      { type: 'element.add', elementType: 'button', id: 'el_action', properties: { text: 'Continuar', x: 100, y: 300, width: 200, height: 56, flowRole: 'navigate' } },
      { type: 'element.duplicate', id: 'el_action', newId: 'el_action_copy' },
      { type: 'element.reorder', id: 'el_action_copy', targetIndex: 1 },
      { type: 'elements.align', ids: ['el_action', 'el_action_copy'], mode: 'left' }
    ] }
  ], 'fullflow_design_0001', 3);
  workspace = result.state;
  assert.equal(workspace.projects.length, 1);
  let saved = workspace.projects[0];
  assert.equal(saved.design.canvasWidth, 720);
  assert.equal(saved.design.elements.length, 3);
  assert.equal(saved.design.elements[1].id, 'el_action_copy');
  assert.equal(saved.design.elements[1].xUnit, 'px');

  let exported = queryHeadlessWorkspace(workspace, { action: 'design.export.html', args: { projectId: 'proj_fullflow' } });
  assert.match(exported.result.html, /Mi aplicación/);
  assert.match(exported.result.html, /Continuar/);
  const capture = queryHeadlessWorkspace(workspace, { action: 'design.capture.context', args: { projectId: 'proj_fullflow', scale: 2 } });
  assert.equal(capture.result.designRevision, saved.design.revision);
  assert.equal(capture.result.canvas.pixelWidth, 1440);
  assert.equal(capture.result.canvas.pixelHeight, 3200);

  result = applyHeadlessBatch(workspace, {
    operationId: 'fullflow_convert_0002',
    baseRevision: workspace.revision,
    operations: [{ type: 'design.convert.toWeb', projectId: 'proj_fullflow' }]
  });
  workspace = result.state;
  saved = workspace.projects[0];
  assert.equal(saved.type, 'web');
  assert.ok(saved.design, 'conversion must preserve the source design');
  assert.match(saved.code.html, /Mi aplicación/);

  result = applyHeadlessBatch(workspace, {
    operationId: 'fullflow_edit_0003',
    baseRevision: workspace.revision,
    operations: [{ type: 'web.code.write', projectId: 'proj_fullflow', html: saved.code.html + '<footer>Guardado desde headless</footer>', css: 'footer{padding:16px}', js: 'window.headlessFlowReady = true;' }]
  });
  workspace = result.state;
  const readback = queryHeadlessWorkspace(workspace, { action: 'project.code.read', args: { projectId: 'proj_fullflow' } });
  assert.match(readback.result.fields.html.value, /Guardado desde headless/);
  assert.match(readback.result.fields.css.value, /padding:16px/);
  assert.match(readback.result.fields.js.value, /headlessFlowReady/);
  assert.equal(workspace.projects[0].design.elements.length, 3);
  assert.equal(workspace.revision, 6);
});
