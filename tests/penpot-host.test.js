const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { TextEncoder } = require('node:util');

const bridgeSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'penpot-host.js'), 'utf8');

function createHost(fetchImpl) {
  const events = [];
  const context = {
    fetch: fetchImpl,
    TextEncoder,
    AbortController,
    setTimeout,
    clearTimeout,
    CustomEvent: class CustomEvent {
      constructor(type, options) { this.type = type; this.detail = options && options.detail; }
    },
    dispatchEvent(event) { events.push(event); },
    saveLocalProjectsSnapshot() { this.localSnapshotSaved = true; },
    localSnapshotSaved: false
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(
    "let workspaceId='ws_admin'; let currentProjectId='proj_1'; let workspaceToken='signed-token'; " +
    "let workspaceRevision=4; let currentUser={id:'admin',username:'ADMIN',role:'admin'}; " +
    "let projects=[{id:'proj_1',name:'Tienda',type:'design',design:{elements:[]}}];",
    context
  );
  vm.runInContext(bridgeSource, context);
  return { context, events };
}

test('host exposes only the active CodeLab workspace/project context', () => {
  const host = createHost(async () => { throw new Error('fetch should not run'); });
  assert.deepEqual(host.context.CodeLabPenpotHost.getContext(), {
    workspaceId: 'ws_admin',
    projectId: 'proj_1',
    workspaceRevision: 4,
    projectName: 'Tienda',
    user: { id: 'admin', username: 'ADMIN', role: 'admin' }
  });
});

test('loadDocument reads the persisted Penpot document and adopts workspace revision', async () => {
  const host = createHost(async (url, options) => {
    assert.match(url, /\/api\/workspace\/ws_admin\/projects\/proj_1\/penpot-document$/);
    assert.equal(options.method, 'GET');
    assert.equal(options.headers['x-workspace-token'], 'signed-token');
    return { ok: true, json: async () => ({
      document: { pages: [{ id: 'page-1', name: 'Inicio' }] },
      documentRevision: 2,
      workspaceRevision: 7
    }) };
  });
  const result = await host.context.CodeLabPenpotHost.loadDocument();
  assert.equal(result.documentRevision, 2);
  assert.equal(host.context.CodeLabPenpotHost.getContext().workspaceRevision, 7);
  assert.equal(host.events[0].type, 'codelab:penpot-document-loaded');
});

test('saveDocument persists optimistically and updates the in-memory CodeLab project', async () => {
  const document = { pages: [{ id: 'page-1', name: 'Inicio' }] };
  const host = createHost(async (_url, options) => {
    assert.equal(options.method, 'PUT');
    assert.equal(options.headers['x-workspace-token'], 'signed-token');
    const body = JSON.parse(options.body);
    assert.equal(body.baseRevision, 4);
    assert.deepEqual(body.document, document);
    return { ok: true, json: async () => ({
      ok: true, documentRevision: 1, workspaceRevision: 5, updatedAt: '2026-11-10T00:00:00.000Z'
    }) };
  });
  const result = await host.context.CodeLabPenpotHost.saveDocument(document);
  assert.equal(result.workspaceRevision, 5);
  assert.equal(host.context.CodeLabPenpotHost.getContext().workspaceRevision, 5);
  assert.equal(host.context.localSnapshotSaved, true);
  assert.equal(host.events[0].type, 'codelab:penpot-document-saved');
});

test('saveDocument reports revision conflicts without overwriting the server copy', async () => {
  const localDocument = { pages: [{ id: 'local', name: 'Local' }] };
  const host = createHost(async () => ({
    ok: false,
    status: 409,
    json: async () => ({
      error: 'revision_conflict',
      document: { pages: [{ id: 'server', name: 'Servidor' }] },
      documentRevision: 3,
      workspaceRevision: 8
    })
  }));
  await assert.rejects(host.context.CodeLabPenpotHost.saveDocument(localDocument), /revision_conflict/);
  assert.equal(host.events[0].type, 'codelab:penpot-conflict');
  assert.equal(host.events[0].detail.serverDocument.pages[0].id, 'server');
});

test('saveDocument rejects non-object and oversized payloads before network access', async () => {
  let calls = 0;
  const host = createHost(async () => { calls += 1; throw new Error('unexpected network call'); });
  await assert.rejects(host.context.CodeLabPenpotHost.saveDocument(null), /penpot_document_must_be_an_object/);
  await assert.rejects(
    host.context.CodeLabPenpotHost.saveDocument({ data: 'x'.repeat(8 * 1024 * 1024) }),
    /penpot_document_too_large/
  );
  assert.equal(calls, 0);
});
