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
  assert.deepEqual(normalized.design.canvas, { width: 390, height: 900, unit: 'px' });
  assert.equal(normalized.design.canvasWidth, 390);
  assert.equal(normalized.design.canvasHeight, 900);
  assert.equal(original.design.canvas, undefined);
});

test('preserves partial canvas settings and fills the missing dimension', () => {
  const normalized = normalizeDesignProject(project({ canvas: { width: 720 } }));
  assert.deepEqual(normalized.design.canvas, { width: 720, height: 900, unit: 'px' });
});

test('sets an arbitrary canvas size independent of element dimensions', () => {
  const engine = createDesignEngine();
  const result = engine.transact(project(), [{ type: 'canvas.set', width: 720, height: 1600 }]);
  assert.deepEqual(result.project.design.canvas, { width: 720, height: 1600, unit: 'px' });
  assert.equal(result.project.design.canvasWidth, 720);
  assert.equal(result.project.design.canvasHeight, 1600);
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

test('enforces editor canvas minimum dimensions', () => {
  const engine = createDesignEngine();
  assert.throws(() => engine.transact(project(), [{ type: 'canvas.set', width: 99, height: 1600 }]), /canvas.width/);
  assert.throws(() => engine.transact(project(), [{ type: 'canvas.set', width: 720.5, height: 1600 }]), /integer/);
});

test('reads existing editor canvasWidth and canvasHeight fields as authoritative', () => {
  const normalized = normalizeDesignProject(project({ canvasWidth: 720, canvasHeight: 1600, canvas: { width: 390, height: 844 } }));
  assert.equal(normalized.design.canvas.width, 720);
  assert.equal(normalized.design.canvas.height, 1600);
});

test('preserves existing editor text alignment and rotation in SVG', () => {
  const engine = createDesignEngine();
  const result = engine.transact(project(), [
    { type: 'element.add', elementType: 'heading', id: 'centered', properties: { text: 'Hola', textAlign: 'center', rotation: 12 } }
  ]);
  assert.match(result.svg, /text-anchor="middle"/);
  assert.match(result.svg, /transform="rotate\(12 /);
});

test('rejects unsafe colors, href schemes, and image sources', () => {
  const engine = createDesignEngine();
  assert.throws(() => engine.transact(project(), [
    { type: 'element.add', elementType: 'rectangle', id: 'bad-color', properties: { background: 'url(javascript:alert(1))' } }
  ]), /safe CSS color/);
  assert.throws(() => engine.transact(project(), [
    { type: 'element.add', elementType: 'button', id: 'bad-link', properties: { href: 'javascript:alert(1)' } }
  ]), /safe URL scheme/);
  assert.throws(() => engine.transact(project(), [
    { type: 'element.add', elementType: 'image', id: 'bad-image', properties: { src: 'javascript:alert(1)' } }
  ]), /safe image URL/);
});

test('attaches an editor-compatible image file to an image layer', () => {
  const engine = createDesignEngine();
  const pixel = Buffer.from('tiny-image').toString('base64');
  const result = engine.transact(project({ elements: [{ id: 'hero', type: 'image', alt: 'Imagen del diseño', src: '' }] }), [
    { type: 'image.attach', id: 'hero', filename: 'hero-banner.webp', dataUrl: 'data:image/webp;base64,' + pixel }
  ]);
  const image = result.project.design.elements[0];
  assert.equal(image.src, 'data:image/webp;base64,' + pixel);
  assert.equal(image.alt, 'hero-banner');
  assert.equal(result.results[0].mimeType, 'image/webp');
  assert.equal(result.results[0].byteLength, Buffer.from('tiny-image').length);
});

test('uses only the image filename when deriving fallback alt text', () => {
  const result = createDesignEngine().transact(project({ elements: [{ id: 'hero', type: 'image', alt: 'Imagen del diseño', src: '' }] }), [
    { type: 'image.attach', id: 'hero', filename: 'C:\\uploads\\hero-banner.webp', dataUrl: 'data:image/webp;base64,' + Buffer.from('image').toString('base64') }
  ]);
  assert.equal(result.project.design.elements[0].alt, 'hero-banner');
});

test('preserves a custom image alt text when attaching a replacement file', () => {
  const result = createDesignEngine().transact(project({ elements: [{ id: 'hero', type: 'image', alt: 'Descripción accesible', src: '' }] }), [
    { type: 'image.attach', id: 'hero', filename: 'new-image.png', dataUrl: 'data:image/png;base64,' + Buffer.from('image').toString('base64') }
  ]);
  assert.equal(result.project.design.elements[0].alt, 'Descripción accesible');
});

test('rejects image uploads that do not match the editor file policy', () => {
  const engine = createDesignEngine();
  const image = { elements: [{ id: 'hero', type: 'image', src: '' }] };
  assert.throws(() => engine.transact(project(image), [
    { type: 'image.attach', id: 'hero', filename: 'bad.svg', dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }
  ]), /PNG, JPEG, WebP, or GIF/);
  assert.throws(() => engine.transact(project(image), [
    { type: 'image.attach', id: 'hero', filename: 'bad.png', dataUrl: 'data:image/png;base64,not-valid!' }
  ]), /PNG, JPEG, WebP, or GIF/);
  const tooLarge = Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64');
  assert.throws(() => engine.transact(project(image), [
    { type: 'image.attach', id: 'hero', filename: 'large.png', dataUrl: 'data:image/png;base64,' + tooLarge }
  ]), /2 MB upload limit/);
  assert.throws(() => engine.transact(project({ elements: [{ id: 'copy', type: 'text' }] }), [
    { type: 'image.attach', id: 'copy', filename: 'image.png', dataUrl: 'data:image/png;base64,' + Buffer.from('x').toString('base64') }
  ]), /requires an image layer/);
});

test('supports safe image URLs and text alignment from saved design layers', () => {
  const engine = createDesignEngine();
  const result = engine.transact(project(), [
    { type: 'element.add', elementType: 'image', id: 'hero', properties: { src: 'https://images.example.test/hero.png', objectFit: 'contain' } },
    { type: 'element.add', elementType: 'text', id: 'copy', properties: { text: 'Centered', textAlign: 'right' } }
  ]);
  assert.match(result.svg, /<image href="https:\/\/images\.example\.test\/hero\.png"/);
  assert.match(result.svg, /preserveAspectRatio="xMidYMid meet"/);
  assert.match(result.svg, /text-anchor="end"/);
});


test('renders text layer backgrounds instead of silently dropping them', () => {
  const engine = createDesignEngine();
  const result = engine.transact(project(), [
    { type: 'element.add', elementType: 'text', id: 'card-copy', properties: { text: 'Card', background: '#f1f5f9', width: 200, height: 80 } }
  ]);
  assert.match(result.svg, /<rect x="84" y="165" width="200" height="80" rx="0" fill="#f1f5f9"/);
});


test('configures canvas, grid, snap, and auto layout in one transaction', () => {
  const engine = createDesignEngine();
  const result = engine.transact(project(), [
    { type: 'canvas.set', frame: 'mobile', width: 720, height: 1600, background: '#f8fafc', grid: true, snapToGrid: true, gridSize: 16 },
    { type: 'layout.set', mode: 'auto', direction: 'column', gap: 16, padding: 20 },
    { type: 'element.add', elementType: 'rectangle', id: 'first', properties: { width: 200, height: 100 } },
    { type: 'element.add', elementType: 'rectangle', id: 'second', properties: { width: 200, height: 80 } }
  ]);
  assert.equal(result.project.design.frame, 'mobile');
  assert.equal(result.project.design.canvasWidth, 720);
  assert.equal(result.project.design.canvasHeight, 1600);
  assert.equal(result.project.design.snapToGrid, true);
  assert.equal(result.project.design.gridSize, 16);
  assert.match(result.svg, /<rect x="20" y="20" width="200" height="100"/);
  assert.match(result.svg, /<rect x="20" y="136" width="200" height="80"/);
});

test('duplicates, reorders, aligns, and distributes layers by stable IDs', () => {
  const engine = createDesignEngine();
  const result = engine.transact(project(), [
    { type: 'element.add', elementType: 'rectangle', id: 'a', properties: { x: 10, y: 10, width: 100, height: 50 } },
    { type: 'element.add', elementType: 'rectangle', id: 'b', properties: { x: 200, y: 30, width: 100, height: 50 } },
    { type: 'element.add', elementType: 'rectangle', id: 'c', properties: { x: 400, y: 60, width: 100, height: 50 } },
    { type: 'element.duplicate', id: 'a', newId: 'copy_a' },
    { type: 'element.reorder', id: 'copy_a', targetIndex: 0 },
    { type: 'elements.align', ids: ['a', 'b', 'c'], mode: 'top' },
    { type: 'elements.distribute', ids: ['a', 'b', 'c'], axis: 'horizontal' }
  ]);
  assert.equal(result.project.design.elements[0].id, 'copy_a');
  const byId = Object.fromEntries(result.project.design.elements.map(el => [el.id, el]));
  assert.equal(byId.a.y, 10);
  assert.equal(byId.b.y, 10);
  assert.equal(byId.c.y, 10);
  assert.ok(byId.a.x < byId.b.x && byId.b.x < byId.c.x);
});

test('deleting a layer also removes its visual-flow connection', () => {
  const source = project();
  source.design.flowConnections = [{ sourceElementId: 'linked', targetProjectId: 'proj_other' }];
  source.design.elements = [{ id: 'linked', type: 'button' }];
  const result = createDesignEngine().transact(source, [{ type: 'element.delete', id: 'linked' }]);
  assert.equal(result.project.design.elements.length, 0);
  assert.deepEqual(result.project.design.flowConnections, []);
});


test('preserves the editor flow navigation role', () => {
  const engine = createDesignEngine();
  const result = engine.transact(project(), [
    { type: 'element.add', elementType: 'button', id: 'nav', properties: { text: 'Go' } },
    { type: 'element.update', id: 'nav', properties: { flowRole: 'navigate' } }
  ]);
  assert.equal(result.project.design.elements[0].flowRole, 'navigate');
});

