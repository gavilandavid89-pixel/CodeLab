'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyHeadlessBatch } = require('./workspace-runtime');

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
