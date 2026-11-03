'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function imageBytes(mimeType, suffix = '') {
  const signatures = {
    'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    'image/jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    'image/gif': Buffer.from('GIF89a'),
    'image/webp': Buffer.from([0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])
  };
  if (!signatures[mimeType]) throw new Error('Unsupported test MIME type: ' + mimeType);
  return Buffer.concat([signatures[mimeType], Buffer.from(suffix)]);
}
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

test('bounds external image URLs independently from Base64 image data URLs', () => {
  const engine = createDesignEngine();
  const oversizedUrl = 'https://example.com/' + 'x'.repeat(9000);
  assert.throws(() => engine.transact(project({ elements: [{ id: 'url-image', type: 'image', src: '' }] }), [
    { type: 'element.update', id: 'url-image', properties: { src: oversizedUrl } }
  ]), /safe image URL/);
});

test('attaches an editor-compatible image file to an image layer', () => {
  const engine = createDesignEngine();
  const pixelBytes = imageBytes('image/webp', 'tiny-image');
  const pixel = pixelBytes.toString('base64');
  const result = engine.transact(project({ elements: [{ id: 'hero', type: 'image', alt: 'Imagen del diseño', src: '' }] }), [
    { type: 'image.attach', id: 'hero', filename: 'hero-banner.webp', dataUrl: 'data:image/webp;base64,' + pixel }
  ]);
  const image = result.project.design.elements[0];
  assert.equal(image.src, 'data:image/webp;base64,' + pixel);
  assert.equal(image.alt, 'hero-banner');
  assert.equal(result.results[0].mimeType, 'image/webp');
  assert.equal(result.results[0].byteLength, pixelBytes.length);
});


test('clamps effective auto image dimensions without mutating stored values', () => {
  const engine = createDesignEngine();
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l6kAAAAASUVORK5CYII=';
  const input = project({ elements: [{
    id: 'auto-image', type: 'image', src: dataUrl,
    width: 10, height: 5000, widthUnit: 'auto', heightUnit: 'auto'
  }] });
  const result = engine.transact(input, [
    { type: 'element.update', id: 'auto-image', properties: { alt: 'bounded image' } }
  ]);
  assert.equal(result.project.design.elements[0].width, 10);
  assert.equal(result.project.design.elements[0].height, 5000);
  assert.match(result.svg, /<image href="data:image\/png;base64,[^"]+" x="0" y="0" width="20" height="4000"/);
});

test('validates image magic bytes for PNG, JPEG, GIF, and WebP and shares policy with source updates', () => {
  const engine = createDesignEngine();
  const fixtures = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  for (const mimeType of fixtures) {
    const dataUrl = 'data:' + mimeType + ';base64,' + imageBytes(mimeType, 'fixture').toString('base64');
    const result = engine.transact(project({ elements: [{ id: 'image-' + mimeType.slice(6), type: 'image', src: '' }] }), [
      { type: 'image.attach', id: 'image-' + mimeType.slice(6), filename: 'fixture.bin', dataUrl }
    ]);
    assert.equal(result.results[0].mimeType, mimeType);
    assert.equal(result.project.design.elements[0].src, dataUrl);
  }

  const mismatched = 'data:image/png;base64,' + imageBytes('image/jpeg', 'wrong-type').toString('base64');
  assert.throws(() => engine.transact(project({ elements: [{ id: 'bad-upload', type: 'image', src: '' }] }), [
    { type: 'image.attach', id: 'bad-upload', filename: 'wrong.png', dataUrl: mismatched }
  ]), /declared MIME type/);
  assert.throws(() => engine.transact(project({ elements: [{ id: 'bad-update', type: 'image', src: '' }] }), [
    { type: 'element.update', id: 'bad-update', properties: { src: mismatched } }
  ]), /safe image URL/);
  assert.throws(() => engine.transact(project({ elements: [{ id: 'random-update', type: 'image', src: '' }] }), [
    { type: 'element.update', id: 'random-update', properties: { src: 'data:image/png;base64,' + Buffer.from('random bytes').toString('base64') } }
  ]), /safe image URL/);
});

test('uses only the image filename when deriving fallback alt text', () => {
  const result = createDesignEngine().transact(project({ elements: [{ id: 'hero', type: 'image', alt: 'Imagen del diseño', src: '' }] }), [
    { type: 'image.attach', id: 'hero', filename: 'C:\\uploads\\hero-banner.webp', dataUrl: 'data:image/webp;base64,' + imageBytes('image/webp', 'image').toString('base64') }
  ]);
  assert.equal(result.project.design.elements[0].alt, 'hero-banner');
});

test('preserves a custom image alt text when attaching a replacement file', () => {
  const result = createDesignEngine().transact(project({ elements: [{ id: 'hero', type: 'image', alt: 'Descripción accesible', src: '' }] }), [
    { type: 'image.attach', id: 'hero', filename: 'new-image.png', dataUrl: 'data:image/png;base64,' + imageBytes('image/png', 'image').toString('base64') }
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
    { type: 'image.attach', id: 'copy', filename: 'image.png', dataUrl: 'data:image/png;base64,' + imageBytes('image/png', 'x').toString('base64') }
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



test('accepts percentage x/y units and renders positions relative to the saved canvas', () => {
  const engine = createDesignEngine();
  const input = project({
    canvasWidth: 720,
    canvasHeight: 1600,
    elements: [{
      id: 'responsive-card', type: 'rectangle', x: 50, y: 25, xUnit: '%', yUnit: '%',
      width: 100, height: 80, background: '#ffffff', color: '#111827'
    }]
  });
  const result = engine.transact(input, [
    { type: 'element.update', id: 'responsive-card', properties: { x: 50, y: 25, xUnit: '%', yUnit: '%' } }
  ]);
  assert.equal(result.project.design.elements[0].xUnit, '%');
  assert.equal(result.project.design.elements[0].yUnit, '%');
  assert.match(result.svg, /<rect x="360" y="400" width="100" height="80"/);
  assert.equal(input.design.elements[0].x, 50, 'transaction must not mutate the input project');
});

test('rejects unsupported percentage positioning units', () => {
  const engine = createDesignEngine();
  const input = project({ elements: [{ id: 'card', type: 'rectangle', x: 10, y: 20, width: 100, height: 80 }] });
  assert.throws(() => engine.transact(input, [
    { type: 'element.update', id: 'card', properties: { xUnit: 'vw' } }
  ]), /xUnit must be px or %/);
});


test('hidden legacy and current layers do not consume layout space or render', () => {
  const input = project({
    canvasWidth: 720, canvasHeight: 1600, layoutMode: 'auto', layoutDirection: 'column', layoutGap: 10, layoutPadding: 20,
    elements: [
      { id: 'legacy-hidden', type: 'rectangle', hidden: true, width: 300, height: 200, background: '#ff0000' },
      { id: 'current-hidden', type: 'rectangle', visible: false, width: 300, height: 200, background: '#00ff00' },
      { id: 'visible-card', type: 'rectangle', width: 100, height: 40, background: '#ffffff' }
    ]
  });
  const svg = createDesignEngine().renderSvg(input);
  assert.match(svg, /<rect x="20" y="20" width="100" height="40"/);
  assert.doesNotMatch(svg, /fill="#ff0000"|fill="#00ff00"/);
});

test('rejects coercible numeric values and validates percentages by unit', () => {
  const engine = createDesignEngine();
  const input = project({ elements: [{ id: 'numeric', type: 'rectangle', x: 10, y: 10, width: 100, height: 40 }] });
  for (const value of [true, false, '120', null, NaN, Infinity, -Infinity]) {
    assert.throws(() => engine.transact(input, [
      { type: 'element.update', id: 'numeric', properties: { width: value } }
    ]), /finite JSON number/);
  }
  assert.throws(() => engine.transact(input, [
    { type: 'element.update', id: 'numeric', properties: { x: 250, xUnit: '%' } }
  ]), /between 0 and 200/);
  assert.throws(() => engine.transact(input, [
    { type: 'element.update', id: 'numeric', properties: { width: 200, widthUnit: '%' } }
  ]), /between 1 and 100/);
  const valid = engine.transact(input, [
    { type: 'element.update', id: 'numeric', properties: { x: 200, xUnit: '%', width: 100, widthUnit: '%' } }
  ]);
  assert.equal(valid.project.design.elements[0].x, 200);
  assert.equal(valid.project.design.elements[0].width, 100);
  const auto = engine.transact(input, [
    { type: 'element.update', id: 'numeric', properties: { width: 10, widthUnit: 'auto' } }
  ]);
  assert.equal(auto.project.design.elements[0].width, 10);
  const nullableOpacity = engine.transact(input, [
    { type: 'element.update', id: 'numeric', properties: { opacity: null } }
  ]);
  assert.equal(nullableOpacity.project.design.elements[0].opacity, null);
});

test('supports responsive size units, semantic identifiers, and nullable opacity', () => {
  const input = project({
    canvasWidth: 720, canvasHeight: 1600,
    elements: [{
      id: 'hero', type: 'button', text: 'Hello', fontSize: 20,
      x: 10, y: 5, width: 50, height: 10,
      xUnit: '%', yUnit: '%', widthUnit: '%', heightUnit: '%',
      identifier: 'hero-cta', opacity: null, background: '#7c3aed'
    }]
  });
  const result = createDesignEngine().transact(input, [
    { type: 'element.update', id: 'hero', properties: { widthUnit: '%', heightUnit: '%', identifier: 'hero-cta', opacity: null } }
  ]);
  const element = result.project.design.elements[0];
  assert.equal(element.identifier, 'hero-cta');
  assert.equal(element.opacity, null);
  assert.match(result.svg, /<rect x="72" y="80" width="360" height="160"/);
  assert.match(result.svg, /opacity="1"/);
});

test('auto dimensions resolve to content-based sizes in SVG', () => {
  const input = project({
    elements: [{
      id: 'auto-button', type: 'button', text: 'Hello', fontSize: 20,
      x: 10, y: 12, width: 1, height: 1, widthUnit: 'auto', heightUnit: 'auto',
      background: '#7c3aed'
    }]
  });
  const svg = createDesignEngine().renderSvg(input);
  assert.match(svg, /<rect x="10" y="12" width="80" height="46"/);
});

test('locked layers reject mutations but can be explicitly unlocked', () => {
  const engine = createDesignEngine();
  const input = project({
    elements: [
      { id: 'locked', type: 'rectangle', locked: true, x: 10, y: 10, width: 100, height: 40 },
      { id: 'other-a', type: 'rectangle', x: 200, y: 10, width: 100, height: 40 },
      { id: 'other-b', type: 'rectangle', x: 400, y: 10, width: 100, height: 40 }
    ]
  });
  const operations = [
    { type: 'element.update', id: 'locked', properties: { x: 20 } },
    { type: 'element.duplicate', id: 'locked', newId: 'copy' },
    { type: 'element.reorder', id: 'locked', targetIndex: 1 },
    { type: 'element.delete', id: 'locked' },
    { type: 'elements.delete', ids: ['locked', 'other-a'] },
    { type: 'elements.align', ids: ['locked', 'other-a'], mode: 'left' },
    { type: 'elements.distribute', ids: ['locked', 'other-a', 'other-b'], axis: 'horizontal' }
  ];
  for (const operation of operations) {
    assert.throws(() => engine.transact(input, [operation]), /locked layer/);
  }
  const unlocked = engine.transact(input, [{ type: 'element.update', id: 'locked', properties: { locked: false } }]);
  assert.equal(unlocked.project.design.elements[0].locked, false);
});

test('duplicates outgoing prototype connections with the duplicate layer ID', () => {
  const engine = createDesignEngine();
  const connection = { sourceElementId: 'cta', targetProjectId: 'next-screen', trigger: 'click' };
  const input = project({
    elements: [{ id: 'cta', type: 'button', x: 10, y: 20, width: 120, height: 40, href: '#layer-next' }],
    flowConnections: [connection]
  });
  const result = engine.transact(input, [
    { type: 'element.duplicate', id: 'cta', newId: 'cta-copy' }
  ]);
  assert.deepEqual(result.project.design.flowConnections, [
    connection,
    { ...connection, sourceElementId: 'cta-copy' }
  ]);
  assert.equal(input.design.flowConnections.length, 1, 'the transaction must not mutate the input project');
});

test('duplicate and distribute preserve percentage position semantics', () => {
  const engine = createDesignEngine();
  const input = project({
    canvasWidth: 720, canvasHeight: 1600,
    elements: [
      { id: 'a', type: 'rectangle', x: 10, y: 10, xUnit: '%', yUnit: '%', width: 10, height: 10, widthUnit: '%', heightUnit: '%' },
      { id: 'b', type: 'rectangle', x: 40, y: 10, xUnit: '%', yUnit: '%', width: 10, height: 10, widthUnit: '%', heightUnit: '%' },
      { id: 'c', type: 'rectangle', x: 80, y: 10, xUnit: '%', yUnit: '%', width: 10, height: 10, widthUnit: '%', heightUnit: '%' }
    ]
  });
  const duplicated = engine.transact(input, [{ type: 'element.duplicate', id: 'a', newId: 'a-copy' }]);
  const copy = duplicated.project.design.elements.find(el => el.id === 'a-copy');
  assert.ok(Math.abs(copy.x - (10 + 24 / 720 * 100)) < 0.0001);
  assert.ok(Math.abs(copy.y - (10 + 24 / 1600 * 100)) < 0.0001);
  const distributed = engine.transact(input, [{ type: 'elements.distribute', ids: ['a', 'b', 'c'], axis: 'horizontal' }]);
  const middle = distributed.project.design.elements.find(el => el.id === 'b');
  assert.ok(Math.abs(middle.x - 45) < 0.0001);
  assert.equal(middle.xUnit, '%');
});


test('align preserves percentage position units after computing pixel geometry', () => {
  const engine = createDesignEngine();
  const input = project({
    canvasWidth: 720, canvasHeight: 1600,
    elements: [
      { id: 'left', type: 'rectangle', x: 10, y: 10, xUnit: '%', yUnit: '%', width: 10, height: 10, widthUnit: '%', heightUnit: '%' },
      { id: 'right', type: 'rectangle', x: 40, y: 30, xUnit: '%', yUnit: '%', width: 10, height: 10, widthUnit: '%', heightUnit: '%' }
    ]
  });
  const aligned = engine.transact(input, [
    { type: 'elements.align', ids: ['left', 'right'], mode: 'right' },
    { type: 'elements.align', ids: ['left', 'right'], mode: 'bottom' }
  ]).project.design.elements;
  for (const element of aligned) {
    assert.equal(element.xUnit, '%');
    assert.equal(element.yUnit, '%');
    assert.ok(Math.abs(element.x - 40) < 0.0001);
    assert.ok(Math.abs(element.y - 30) < 0.0001);
  }
});
