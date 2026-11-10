import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { zipSync, strToU8 } from 'fflate';

const port = 3198;
const base = 'http://127.0.0.1:' + port;
const fileId = '11111111-1111-4111-8111-111111111111';
const pageId = '22222222-2222-4222-8222-222222222222';
const frameA = '33333333-3333-4333-8333-333333333333';
const frameB = '44444444-4444-4444-8444-444444444444';
const shapeA = '55555555-5555-4555-8555-555555555555';
const imageId = '66666666-6666-4666-8666-666666666666';
const mediaId = '77777777-7777-4777-8777-777777777777';
const storageId = '88888888-8888-4888-8888-888888888888';

function makeArchive() {
  const prefix = 'files/' + fileId + '/';
  const entries = {
    'manifest.json': { version: 1, type: 'penpot/export-files', files: [{ id: fileId, name: 'Tienda Demo', features: [] }] },
    ['files/' + fileId + '.json']: { id: fileId, name: 'Tienda Demo', revn: 1 },
    [prefix + 'pages/' + pageId + '.json']: { id: pageId, name: 'Tienda' },
    [prefix + 'pages/' + pageId + '/' + frameA + '.json']: {
      id: frameA, name: 'Inicio', type: 'frame', x: 0, y: 0, width: 390, height: 844,
      parentId: '00000000-0000-0000-0000-000000000000', shapes: [shapeA, imageId]
    },
    [prefix + 'pages/' + pageId + '/' + frameB + '.json']: {
      id: frameB, name: 'Detalle', type: 'frame', x: 450, y: 0, width: 390, height: 844,
      parentId: '00000000-0000-0000-0000-000000000000', shapes: []
    },
    [prefix + 'pages/' + pageId + '/' + imageId + '.json']: { id: imageId, name: 'Producto', type: 'image', x: 20, y: 100, width: 160, height: 160, parentId: frameA, frameId: frameA, metadata: { id: mediaId } },
    [prefix + 'media/' + mediaId + '.json']: { id: mediaId, mediaId: storageId, name: 'producto.png' },
    ['objects/' + storageId + '.json']: { id: storageId, contentType: 'image/png', size: 8 },
    ['objects/' + storageId + '.png']: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    [prefix + 'pages/' + pageId + '/' + shapeA + '.json']: {
      id: shapeA, name: 'Ver producto', type: 'text', x: 24, y: 40, width: 180, height: 44,
      parentId: frameA, frameId: frameA, content: { children: [{ text: 'Ver producto' }] },
      interactions: [{ eventType: 'click', destinationFrameId: frameB }]
    }
  };
  const encoded = {};
  for (const [name, value] of Object.entries(entries)) encoded[name] = value instanceof Uint8Array ? value : strToU8(JSON.stringify(value));
  return Buffer.from(zipSync(encoded));
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}

test('CodeLab imports Penpot screens and prototype links into its existing workspace idempotently', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'codelab-penpot-import-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), CODELAB_DATA_DIR: dataDir,
      CODELAB_WORKSPACE_SECRET: 'test-penpot-import-secret',
      DATABASE_URL: '', CODELAB_DATABASE_URL: '',
      PENPOT_FRONTEND_URL: '' },
    stdio: 'ignore'
  });
  try {
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try { const response = await fetch(base + '/api/health'); if (response.ok) { ready = true; break; } } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(ready, true, 'CodeLab should start for the import integration test');

    const init = await jsonRequest(base + '/api/workspace/init', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    assert.equal(init.response.status, 200);
    const { workspaceId, token } = init.body;
    const headers = { 'content-type': 'application/json', 'x-workspace-token': token };
    const anchor = { id: 'project_anchor', name: 'Proyecto diseño', type: 'design',
      code: { html: '', css: '', js: '' }, design: { width: 390, height: 844, elements: [] } };
    const save = await jsonRequest(base + '/api/workspace/' + workspaceId, {
      method: 'PUT', headers, body: JSON.stringify({ baseRevision: 0, projects: [anchor] })
    });
    assert.equal(save.response.status, 200);

    const archive = makeArchive();
    const payload = { projectId: anchor.id, baseRevision: 1, fileBase64: archive.toString('base64') };
    const imported = await jsonRequest(base + '/api/workspace/' + workspaceId + '/penpot/import', {
      method: 'POST', headers, body: JSON.stringify(payload)
    });
    assert.equal(imported.response.status, 200, JSON.stringify(imported.body));
    assert.equal(imported.body.importedScreens, 2);
    assert.equal(imported.body.importedElements, 2);
    assert.equal(imported.body.importedAssets, 1);
    assert.equal(imported.body.importedConnections, 1);
    assert.equal(imported.body.designSystemApplied, true);

    const designSystem = await jsonRequest(base + '/api/workspace/' + workspaceId + '/design-system', { headers });
    assert.equal(designSystem.response.status, 200);
    assert.equal(designSystem.body.settings.primary, '#2563eb');
    assert.equal(designSystem.body.settings.name, 'Tienda Demo');

    const state = await jsonRequest(base + '/api/workspace/' + workspaceId, { headers });
    assert.equal(state.response.status, 200);
    assert.equal(state.body.projects.length, 2);
    const source = state.body.projects.find(project => project.design.penpotSource);
    assert.ok(source);
    assert.equal(source.design.elements[0].text, 'Ver producto');
    const image = source.design.elements.find(element => element.type === 'image');
    assert.ok(image && image.src.includes('/penpot/assets/' + fileId + '/' + mediaId));
    const asset = await fetch(base + image.src, { headers: { 'x-workspace-token': token } });
    assert.equal(asset.status, 200);
    const deniedAsset = await fetch(base + image.src);
    assert.equal(deniedAsset.status, 401, 'asset delivery must require the CodeLab workspace token');
    assert.equal(asset.headers.get('content-type'), 'image/png');
    assert.deepEqual(Array.from(new Uint8Array(await asset.arrayBuffer())), [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(source.design.flowConnections[0].targetProjectId, state.body.projects.find(project => project.id !== source.id).id);

    const repeated = await jsonRequest(base + '/api/workspace/' + workspaceId + '/penpot/import', {
      method: 'POST', headers, body: JSON.stringify({ ...payload, baseRevision: 2 })
    });
    assert.equal(repeated.response.status, 200, JSON.stringify(repeated.body));
    const afterRepeat = await jsonRequest(base + '/api/workspace/' + workspaceId, { headers });
    assert.equal(afterRepeat.body.projects.length, 2, 're-import must update, not duplicate, screens');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 200));
    await rm(dataDir, { recursive: true, force: true });
  }
});
