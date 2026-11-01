'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDesignEngine, normalizeDesignProject, MAX_ELEMENTS } = require('./design-engine');

function project(overrides = {}) {
  return {
    id: 'proj_test',
    type: 'design',
    design: { elements: [], frame: 'mobile', background: '#ffffff', ...overrides }
  };
}

test('normalizes a legacy project without changing the original', () => {
  const original = project();
  const normalized = normalizeDesignProject(original);
  assert.deepEqual(normalized.design.canvas, { width: 390, height: 844, unit: 'px' });
  assert.equal(original.design.canvas, undefined);
});

test('preserves partial canvas settings and fills the missing dimension', () => {
  const normalized = normalizeDesignProject(project({ canvas: { width: 720 } }));
  assert.deepEqual(normalized.design.canvas, { width: 720, height: 844, unit: 'px' });
});

test('sets an arbitrary canvas size independent of element dimensions', () => {
  const engine = createDesignEngine();
  const result = engine.transact(project(), [{ type: 'canvas.set', width: 720, height: 1600 }]);
  assert.deepEqual(result.project.design.canvas, { width: 720, height: 1600, unit: 'px' });
  assert.match(result.svg, /width="720" height="1600" viewBox="0 0 720 1600"/);
});

test('adds and updates layers through one atomic transaction', () => {
  const engine = createDesignEngine();
  const result = engine.transact(project(), [
    { type: 'element.add', elementType: 'rectangle', id: 'rect-1' },
    { type: 'element.update', id: 'rect-1', properties: { x: 12, y: 34, width: 720, height: 1600, background: '#123456' } }
  ], { expectedRevision: 0 });
  const layer = result.project.design.elements[0];
  assert.deepEqual([layer.x, layer.y, layer.width, layer.height, layer.background], [12, 34, 720, 1600, '#123456']);
  assert.equal(result.revision, 1);
});

test('rejects stale revisions before applying mutations', () => {
  const engine = createDesignEngine();
  assert.throws(
    () => engine.transact(project(), [{ type: 'element.add', elementType: 'rectangle' }], { expectedRevision: 9 }),
    error => error.code === 'REVISION_CONFLICT'
  );
});

test('failed batch leaves the caller project untouched', () => {
  const engine = createDesignEngine();
  const original = project();
  assert.throws(() => engine.transact(original, [
    { type: 'element.add', elementType: 'rectangle', id: 'rect-1' },
    { type: 'element.update', id: 'missing', properties: { x: 1 } }
  ]), /Layer not found/);
  assert.equal(original.design.elements.length, 0);
});

test('rejects unsafe or unsupported layer properties', () => {
  const engine = createDesignEngine();
  assert.throws(() => engine.transact(project(), [
    { type: 'element.add', elementType: 'rectangle', id: 'rect-1' },
    { type: 'element.update', id: 'rect-1', properties: { onclick: 'alert(1)' } }
  ]), /not editable/);
});

test('rejects invalid canvas sizes and enforces layer cap', () => {
  const engine = createDesignEngine();
  assert.throws(() => engine.transact(project(), [{ type: 'canvas.set', width: 0, height: 1600 }]), /canvas.width/);
  const full = project({ elements: Array.from({ length: MAX_ELEMENTS }, (_, i) => ({ id: 'e' + i, type: 'rectangle' })) });
  assert.throws(() => engine.transact(full, [{ type: 'element.add', elementType: 'rectangle' }]), /layer limit/);
});

test('escapes text when rendering SVG', () => {
  const engine = createDesignEngine();
  const result = engine.transact(project(), [
    { type: 'element.add', elementType: 'heading', id: 'heading-1', properties: { text: '<script>alert(1)</script>' } }
  ]);
  assert.match(result.svg, /&lt;script&gt;/);
  assert.doesNotMatch(result.svg, /<script>/);
});

test('deletes only the requested stable layer id', () => {
  const engine = createDesignEngine();
  const result = engine.transact(project({ elements: [
    { id: 'a', type: 'rectangle', x: 0, y: 0, width: 1, height: 1 },
    { id: 'b', type: 'ellipse', x: 0, y: 0, width: 1, height: 1 }
  ] }), [{ type: 'element.delete', id: 'a' }]);
  assert.deepEqual(result.project.design.elements.map(layer => layer.id), ['b']);
});
