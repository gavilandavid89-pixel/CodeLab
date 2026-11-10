import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { mapPenpotArchive, parsePenpotArchive } from '../lib/penpot-adapter.js';

const fileId = '11111111-1111-4111-8111-111111111111';
const pageId = '22222222-2222-4222-8222-222222222222';
const frameA = '33333333-3333-4333-8333-333333333333';
const frameB = '44444444-4444-4444-8444-444444444444';
const shapeA = '55555555-5555-4555-8555-555555555555';
const imageId = '66666666-6666-4666-8666-666666666666';
const mediaId = '77777777-7777-4777-8777-777777777777';
const storageId = '88888888-8888-4888-8888-888888888888';

function archive() {
  const prefix = 'files/' + fileId + '/';
  const entries = {
    'manifest.json': {
      version: 1, type: 'penpot/export-files', generatedBy: 'penpot/2.19.0',
      files: [{ id: fileId, name: 'Tienda Demo', features: ['components/v2', 'design-tokens/v1'] }]
    },
    ['files/' + fileId + '.json']: { id: fileId, name: 'Tienda Demo', revn: 7 },
    [prefix + 'pages/' + pageId + '.json']: { id: pageId, name: 'Tienda', background: '#f8fafc' },
    [prefix + 'pages/' + pageId + '/' + frameA + '.json']: {
      id: frameA, name: 'Inicio', type: 'frame', x: 0, y: 0, width: 390, height: 844,
      parentId: '00000000-0000-0000-0000-000000000000', shapes: [shapeA, imageId]
    },
    [prefix + 'pages/' + pageId + '/' + frameB + '.json']: {
      id: frameB, name: 'Detalle', type: 'frame', x: 450, y: 0, width: 390, height: 844,
      parentId: '00000000-0000-0000-0000-000000000000', shapes: []
    },
    [prefix + 'pages/' + pageId + '/' + shapeA + '.json']: {
      id: shapeA, name: 'Ver producto', type: 'text', x: 24, y: 40, width: 180, height: 44,
      parentId: frameA, frameId: frameA, content: { children: [{ text: 'Ver producto' }] },
      fills: [{ color: '#2563eb' }], fontSize: 28,
      interactions: [{ eventType: 'click', destinationFrameId: frameB }]
    },
    [prefix + 'pages/' + pageId + '/' + imageId + '.json']: { id: imageId, name: 'Producto', type: 'image', x: 20, y: 100, width: 160, height: 160, parentId: frameA, frameId: frameA, metadata: { id: mediaId } },
    [prefix + 'media/' + mediaId + '.json']: { id: mediaId, mediaId: storageId, name: 'producto.png' },
    ['objects/' + storageId + '.json']: { id: storageId, contentType: 'image/png', size: 8 },
    ['objects/' + storageId + '.png']: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    [prefix + 'tokens.json']: { sets: { core: { tokens: { color: { primary: { value: '#2563eb' } } } } } }
  };
  const encoded = {};
  for (const [name, value] of Object.entries(entries)) encoded[name] = value instanceof Uint8Array ? value : strToU8(JSON.stringify(value));
  return zipSync(encoded);
}

test('reads native Penpot v3 ZIP and maps pages/frames to CodeLab screens', () => {
  const parsed = parsePenpotArchive(Buffer.from(archive()));
  assert.equal(parsed.fileId, fileId);
  assert.equal(parsed.fileName, 'Tienda Demo');
  assert.equal(parsed.revision, 7);
  assert.equal(parsed.pages.length, 1);
  assert.equal(parsed.assets.length, 1);

  const graph = mapPenpotArchive(Buffer.from(archive()));
  assert.equal(graph.screens.length, 2);
  assert.deepEqual(graph.screens.map(screen => screen.name), ['Tienda Demo · Inicio', 'Tienda Demo · Detalle']);
  assert.equal(graph.screens[0].design.width, 390);
  assert.equal(graph.screens[0].design.elements.length, 2);
  assert.equal(graph.screens[0].design.elements[0].type, 'heading');
  assert.equal(graph.screens[0].design.elements[0].text, 'Ver producto');
  assert.equal(graph.assets.length, 1);
  assert.equal(graph.screens[0].design.flowConnections.length, 1);
  assert.equal(graph.screens[0].design.flowConnections[0].targetProjectId, graph.screens[1].id);
  assert.equal(graph.screens[0].design.penpotTokens.sets.core.tokens.color.primary.value, '#2563eb');
});

test('rejects malformed archives and multiple Penpot files instead of silently dropping content', () => {
  assert.throws(() => parsePenpotArchive(Buffer.from('not a zip')), /penpot_archive_/);
  const multiple = zipSync({
    'manifest.json': strToU8(JSON.stringify({
      version: 1, type: 'penpot/export-files',
      files: [{ id: fileId }, { id: pageId }]
    }))
  });
  assert.throws(() => parsePenpotArchive(Buffer.from(multiple)), /multiple_files_not_supported/);
});

test('maps screen identifiers deterministically for repeatable imports', () => {
  const first = mapPenpotArchive(Buffer.from(archive()));
  const second = mapPenpotArchive(Buffer.from(archive()));
  assert.deepEqual(first.screens.map(screen => screen.id), second.screens.map(screen => screen.id));
});
