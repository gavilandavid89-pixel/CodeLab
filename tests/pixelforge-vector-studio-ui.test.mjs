import assert from 'node:assert/strict';
import test from 'node:test';
import { VectorStudio } from '../public/pixelforge/src/vector-studio.js';

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.children = [];
    this.listeners = {};
    this.textContent = '';
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setPointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; }
}

function createStudio(seed = {}) {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousDOMParser = globalThis.DOMParser;
  globalThis.document = {
    createElement: tag => {
      const element = new FakeElement(tag);
      if (tag === 'input') element.click = () => {
        element.files = [{ text: async () => '<svg><rect x="1" y="2" width="3" height="4"/><ellipse cx="8" cy="9" rx="2" ry="3"/><line x1="1" y1="2" x2="3" y2="4"/><text x="5" y="6">Hello</text><path d="M 1 2 L 3 4"/></svg>' }];
        return element.onchange?.();
      };
      return element;
    },
    createElementNS: (_ns, tag) => new FakeElement(tag),
  };
  globalThis.window = {
    addEventListener() {},
    prompt: () => 'Vector label',
  };
  globalThis.DOMParser = class {
    parseFromString() {
      const node = (tagName, attrs = {}, textContent = '') => ({ tagName, textContent, getAttribute: name => attrs[name] ?? null });
      return {
        querySelector: () => null,
        querySelectorAll: () => [
          node('rect', { x: '1', y: '2', width: '3', height: '4' }),
          node('ellipse', { cx: '8', cy: '9', rx: '2', ry: '3' }),
          node('line', { x1: '1', y1: '2', x2: '3', y2: '4' }),
          node('text', { x: '5', y: '6' }, 'Hello'),
          node('path', { d: 'M 1 2 L 3 4' }),
        ],
      };
    }
  };
  const host = new FakeElement('host');
  const doc = { width: 100, height: 100, name: 'Test' };
  const saved = [];
  const studio = new VectorStudio({
    host,
    getDocument: () => doc,
    getModel: () => ({ width: 100, height: 100, snap: false, ...seed }),
    setModel: model => saved.push(structuredClone(model)),
    onChanged() {},
    status() {},
  });
  return {
    studio, host, saved,
    restore() {
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
      if (previousDOMParser === undefined) delete globalThis.DOMParser;
      else globalThis.DOMParser = previousDOMParser;
    },
  };
}

const pointer = (x, y) => ({ clientX: x, clientY: y, pointerId: 1, target: { matches: () => false } });

test('vector mode toggle and toolbar expose every editing action', () => {
  const env = createStudio();
  try {
    const { studio } = env;
    const actions = [...studio.bar.children].map(button => button.dataset.vectorTool);
    for (const action of [
      'select', 'rect', 'ellipse', 'line', 'pen', 'node', 'text', 'group',
      'ungroup', 'duplicate', 'mirror', 'grad', 'align-left', 'align-center',
      'align-right', 'align-top', 'align-middle', 'align-bottom', 'grid',
      'import', 'export', 'undo', 'redo', 'delete',
    ]) assert.ok(actions.includes(action), `missing toolbar action: ${action}`);
    assert.equal(studio.toggle(), true);
    assert.equal(studio.svg.style.display, 'block');
    assert.equal(studio.toggle(), false);
    assert.equal(studio.svg.style.display, 'none');
  } finally { env.restore(); }
});

test('rectangle, ellipse, line, pen and text tools create editable objects', () => {
  const env = createStudio();
  try {
    const { studio } = env;
    for (const tool of ['rect', 'ellipse', 'line']) {
      studio.toolAction(tool);
      studio.down(pointer(10, 12));
      studio.move(pointer(40, 52));
      studio.up();
    }
    studio.toolAction('pen');
    studio.down(pointer(5, 6));
    studio.down(pointer(20, 25));
    studio.finishPen();
    studio.toolAction('text');
    studio.down(pointer(30, 35));
    assert.deepEqual(studio.model.objects.map(o => o.type), ['rect', 'ellipse', 'line', 'path', 'text']);
    assert.equal(studio.model.objects[0].width, 30);
    assert.equal(studio.model.objects[1].height, 40);
    assert.equal(studio.model.objects[2].x2, 40);
    assert.equal(studio.model.objects[3].points.length, 2);
    assert.equal(studio.model.objects[4].text, 'Vector label');
    assert.ok(env.saved.length >= 5);
  } finally { env.restore(); }
});

test('selection dragging and node editing update object geometry', () => {
  const env = createStudio({
    objects: [
      { id: 'path-1', type: 'path', points: [{ x: 10, y: 10 }, { x: 30, y: 30 }], transform: {} },
    ],
  });
  try {
    const { studio } = env;
    studio.toolAction('select');
    studio.down(pointer(10, 10));
    studio.move(pointer(20, 25));
    studio.up();
    assert.deepEqual(studio.model.objects[0].points[0], { x: 20, y: 25 });

    studio.toolAction('node');
    studio.down(pointer(20, 25));
    studio.move(pointer(28, 32));
    studio.up();
    assert.deepEqual(studio.model.objects[0].points[0], { x: 28, y: 32 });
  } finally { env.restore(); }
});

test('duplicate, group, ungroup, mirror, align and delete mutate the selected objects', () => {
  const env = createStudio({
    objects: [
      { id: 'a', type: 'rect', x: 10, y: 10, width: 10, height: 10, transform: {} },
      { id: 'b', type: 'rect', x: 40, y: 30, width: 20, height: 20, transform: {} },
    ],
  });
  try {
    const { studio } = env;
    studio.selected = new Set(['a']);
    studio.duplicateSelected();
    assert.equal(studio.model.objects.length, 3);
    assert.equal(studio.model.objects[2].x, 18);

    studio.selected = new Set(['a', 'b']);
    studio.groupSelected();
    assert.equal(studio.model.objects.length, 2);
    const group = studio.model.objects.find(o => o.type === 'group');
    assert.equal(group.children.length, 2);

    studio.selected = new Set([group.id]);
    studio.ungroupSelected();
    assert.equal(studio.model.objects.filter(o => o.type !== 'group').length, 3);

    studio.selected = new Set(['a', 'b']);
    studio.mirrorSelected();
    const mirroredA = studio.model.objects.find(o => o.id === 'a');
    assert.equal(mirroredA.x, 50);

    studio.align('left');
    assert.equal(studio.model.objects.find(o => o.id === 'a').x, studio.model.objects.find(o => o.id === 'b').x);
    studio.selected = new Set(['a']);
    studio.deleteSelected();
    assert.equal(studio.model.objects.some(o => o.id === 'a'), false);
  } finally { env.restore(); }
});

test('gradient, transforms, keyframes, snapping and animation frame application work', () => {
  const env = createStudio({
    objects: [{ id: 'shape', type: 'rect', x: 10, y: 10, width: 20, height: 20, transform: {} }],
  });
  try {
    const { studio } = env;
    studio.selected = new Set(['shape']);
    studio.addGradient('linear');
    assert.equal(studio.model.objects[0].gradient.type, 'linear');
    studio.setTransform({ rotation: 45, scaleX: 2 });
    assert.equal(studio.model.objects[0].transform.rotation, 45);
    studio.addKeyframe(0, { x: 10, opacity: 1 });
    studio.addKeyframe(10, { x: 40, opacity: 0.5, rotation: 90 });
    assert.equal(studio.model.objects[0].keyframes.length, 2);
    studio.setAnimationFrame(10);
    assert.equal(studio.model.objects[0].x, 40);
    assert.equal(studio.model.objects[0].opacity, 0.5);
    assert.equal(studio.model.objects[0].transform.rotation, 90);

    studio.model.snap = true;
    studio.model.grid = 8;
    assert.deepEqual(studio.point(pointer(13, 17)), { x: 16, y: 16 });
    studio.toolAction('grid');
    assert.equal(studio.model.snap, false);
  } finally { env.restore(); }
});


test('SVG import parses editable shapes and path coordinates', async () => {
  let resolveSaved;
  const savedModel = new Promise(resolve => { resolveSaved = resolve; });
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousDOMParser = globalThis.DOMParser;
  const env = createStudio();
  try {
    const { studio } = env;
    const originalSetModel = studio.setModel;
    studio.setModel = model => { originalSetModel?.(model); resolveSaved(model); };
    studio.importSVG();
    const imported = await savedModel;
    assert.deepEqual(imported.objects.map(object => object.type), ['rect', 'ellipse', 'line', 'text', 'path']);
    assert.deepEqual(imported.objects.at(-1).points, [{ x: 1, y: 2 }, { x: 3, y: 4 }]);
    assert.equal(imported.objects[3].text, 'Hello');
  } finally {
    env.restore();
    if (previousDocument !== undefined) globalThis.document = previousDocument;
    if (previousWindow !== undefined) globalThis.window = previousWindow;
    if (previousDOMParser !== undefined) globalThis.DOMParser = previousDOMParser;
  }
});
