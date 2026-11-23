import test from 'node:test';
import assert from 'node:assert/strict';
import { HeadlessEditorRuntime } from '../public/pixelforge/src/headless.js';
import { vectorModelToSVG } from '../public/pixelforge/src/vector-studio.js';

test('Headless vector object edits are isolated until proposal approval and survive JSON reopen', () => {
  const runtime = new HeadlessEditorRuntime({ width: 96, height: 80, name: 'Vector proof' });
  const batch = runtime.executeBatch([
    { name: 'vector.object.create', object: { type: 'rect', name: 'Body', x: 8, y: 10, width: 30, height: 24, fill: '#ff0000' } },
    { name: 'vector.object.create', object: { type: 'ellipse', name: 'Eye', x: 16, y: 16, width: 6, height: 6, fill: '#ffffff' } }
  ]);
  assert.equal(batch.ok, true);
  const ids = runtime.sandbox.getVectorModel().objects.map(item => item.id);
  assert.equal(ids.length, 2);
  const grouped = runtime.execute({ name: 'vector.group.create', object_ids: ids, group_name: 'Character' });
  assert.equal(grouped.ok, true);
  assert.equal(runtime.sandbox.getVectorModel().objects.length, 1);
  const group = runtime.sandbox.getVectorModel().objects[0];
  assert.equal(group.type, 'group');
  assert.equal(group.name, 'Character');
  assert.equal(group.children.length, 2);
  assert.equal(runtime.getDiff().vector.changed, true);
  assert.throws(() => runtime.toJSON(), /Unreviewed sandbox changes/);
  runtime.createProposal('Create vector character');
  assert.equal(runtime.acceptProposal().status, 'applied');
  const saved = runtime.toJSON();
  assert.equal(saved.vectorModel.objects[0].children.length, 2);
  const reopened = HeadlessEditorRuntime.fromJSON(saved);
  const inspection = reopened.inspect();
  assert.equal(inspection.project.vectorObjectCount, 1);
  assert.equal(reopened.execute({ name: 'vector.audit' }).result.ok, true);
  const svg = reopened.execute({ name: 'vector.svg.export' }).result.svg;
  assert.match(svg, /<g/);
  assert.match(vectorModelToSVG(saved.vectorModel), /<ellipse/);
});

test('Headless vector update, duplicate, reorder, ungroup and delete preserve unique IDs', () => {
  const runtime = new HeadlessEditorRuntime({ width: 64, height: 64 });
  assert.equal(runtime.executeBatch([
    { name: 'vector.object.create', object: { type: 'rect', x: 1, y: 1, width: 10, height: 10 } },
    { name: 'vector.object.create', object: { type: 'line', x1: 1, y1: 2, x2: 8, y2: 9 } }
  ]).ok, true);
  let model = runtime.sandbox.getVectorModel();
  const [rect, line] = model.objects;
  assert.equal(runtime.execute({ name: 'vector.object.update', object_id: rect.id, patch: { fill: '#00ff00' } }).ok, true);
  assert.equal(runtime.execute({ name: 'vector.object.duplicate', object_id: rect.id }).ok, true);
  model = runtime.sandbox.getVectorModel();
  assert.equal(new Set(model.objects.map(item => item.id)).size, 3);
  assert.equal(runtime.execute({ name: 'vector.object.reorder', object_id: line.id, index: 0 }).ok, true);
  assert.equal(runtime.sandbox.getVectorModel().objects[0].id, line.id);
  assert.equal(runtime.execute({ name: 'vector.group.create', object_ids: [rect.id, line.id] }).ok, true);
  const group = runtime.sandbox.getVectorModel().objects.find(item => item.type === 'group');
  assert.ok(group);
  assert.equal(runtime.execute({ name: 'vector.group.ungroup', object_id: group.id }).ok, true);
  assert.equal(runtime.execute({ name: 'vector.object.delete', object_id: rect.id }).ok, true);
  assert.equal(runtime.execute({ name: 'vector.audit' }).result.ok, true);
});

test('Headless SVG import and precision metadata are validated', () => {
  const runtime = new HeadlessEditorRuntime({ width: 80, height: 80 });
  const originalDomParser = globalThis.DOMParser;
  let imported;
  try {
    globalThis.DOMParser = undefined;
    imported = runtime.execute({
      name: 'vector.svg.import',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect x="4" y="5" width="20" height="12" fill="#123456"/></svg>'
    });
  } finally {
    if (originalDomParser === undefined) delete globalThis.DOMParser;
    else globalThis.DOMParser = originalDomParser;
  }
  assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.equal(runtime.sandbox.getVectorModel().objects.length, 1);
  const precision = runtime.execute({
    name: 'vector.precision.configure',
    precision: { tolerance: 0.01, anchors: [{ id: 'a1', x: 4, y: 5 }], guides: [{ id: 'g1', axis: 'x', value: 12 }] }
  });
  assert.equal(precision.ok, true);
  assert.equal(runtime.sandbox.getVectorModel().precision.anchors.length, 1);
  const invalid = runtime.execute({
    name: 'vector.object.create',
    object: { type: 'path', points: [{ x: 1, y: 1 }] }
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'invalid_arguments');
});


test('vector inspection remains available while edits are blocked by a pending proposal', () => {
  const runtime = new HeadlessEditorRuntime({ width: 48, height: 48 });
  assert.equal(runtime.execute({ name: 'vector.object.create', object: { type: 'rect', x: 2, y: 2, width: 10, height: 10 } }).ok, true);
  const objectId = runtime.sandbox.getVectorModel().objects[0].id;
  runtime.createProposal('Add a vector object');
  assert.equal(runtime.execute({ name: 'vector.model.get' }).ok, true);
  assert.equal(runtime.execute({ name: 'vector.audit' }).ok, true);
  assert.equal(runtime.execute({ name: 'vector.object.update', object_id: objectId, patch: { fill: '#fff' } }).error.code, 'proposal_pending');
});
