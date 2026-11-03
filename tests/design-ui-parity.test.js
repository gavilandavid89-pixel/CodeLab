'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function extract(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, 'missing source marker: ' + startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, 'missing end marker: ' + endMarker);
  return source.slice(start, end);
}

function makeContext() {
  const context = {
    getDesignCanvasWidth: design => Number(design && design.canvasWidth) || 390,
    getDesignCanvasHeight: design => Number(design && design.canvasHeight) || 0,
    designXmlEscape: value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    safeDesignImageSource: value => typeof value === 'string' && /^https?:\/\//i.test(value) ? value : ''
  };
  vm.createContext(context);
  vm.runInContext(extract('function designCoordinateToPixels(design, element, axis) {', '\nfunction getDesignLayoutPositions'), context);
  vm.runInContext(extract('function getDesignLayoutPositions(design) {', '\nfunction setDesignLayoutMode'), context);
  return context;
}

test('shared coordinate helpers preserve percentage units when positioning layers', () => {
  const context = makeContext();
  const design = { canvasWidth: 720, canvasHeight: 1600 };
  const element = { x: 25, y: 50, xUnit: '%', yUnit: '%' };
  assert.equal(context.designCoordinateToPixels(design, element, 'x'), 180);
  assert.equal(context.designCoordinateToPixels(design, element, 'y'), 800);
  context.setDesignCoordinateFromPixels(design, element, 'x', 360);
  context.setDesignCoordinateFromPixels(design, element, 'y', 400);
  assert.equal(element.x, 50);
  assert.equal(element.y, 25);
});

test('local design layout excludes hidden layers and resolves percentage positions', () => {
  const context = makeContext();
  const design = {
    frame: 'mobile',
    canvasWidth: 720,
    canvasHeight: 1600,
    layoutMode: 'free',
    elements: [
      { id: 'el_visible', x: 25, y: 50, xUnit: '%', yUnit: '%', width: 100, height: 40 },
      { id: 'el_hidden', x: 0, y: 0, visible: false, width: 100, height: 40 }
    ]
  };
  const layout = context.getDesignLayoutPositions(design);
  assert.deepEqual({ x: layout.positions.get('el_visible').x, y: layout.positions.get('el_visible').y }, { x: 180, y: 800 });
  assert.equal(layout.positions.has('el_hidden'), false, 'hidden layers must not take part in free or auto layout');
});

test('inspector unit changes preserve the layer position in pixels', () => {
  const context = makeContext();
  const element = { id: 'el_units', x: 180, y: 800 };
  const project = { design: { canvasWidth: 720, canvasHeight: 1600 } };
  context.selectedDesignElement = () => element;
  context.activeDesignProject = () => project;
  context.renderDesignWorkspace = () => {};
  context.scheduleAutosave = () => {};
  vm.runInContext(extract('function updateDesignProperty(key, value) {', 'function bindDesignCanvasEvents'), context);

  context.updateDesignProperty('xUnit', '%');
  context.updateDesignProperty('yUnit', '%');
  assert.equal(element.x, 25);
  assert.equal(element.y, 50);
  assert.equal(element.xUnit, '%');
  assert.equal(element.yUnit, '%');

  context.updateDesignProperty('xUnit', 'px');
  context.updateDesignProperty('yUnit', 'px');
  assert.equal(element.x, 180);
  assert.equal(element.y, 800);
});

test('inspector numeric bounds allow the origin and clamp supported dimensions/styles', () => {
  const context = makeContext();
  const element = { id: 'el_bounds', x: 10, y: 10, width: 100, height: 50, radius: 8, opacity: 1, rotation: 0 };
  const project = { design: { canvasWidth: 720, canvasHeight: 1600, layoutMode: 'free', elements: [element] } };
  context.selectedDesignElement = () => element;
  context.activeDesignProject = () => project;
  context.renderDesignWorkspace = () => {};
  context.document = { querySelectorAll: () => [] };
  context.getDesignLayoutPositions = () => ({ positions: new Map() });
  context.scheduleAutosave = () => {};
  vm.runInContext(extract('function updateDesignProperty(key, value) {', 'function bindDesignCanvasEvents'), context);

  context.updateDesignProperty('x', '0');
  context.updateDesignProperty('y', '0');
  context.updateDesignProperty('width', '99999');
  context.updateDesignProperty('height', '0');
  context.updateDesignProperty('radius', '0');
  context.updateDesignProperty('opacity', '1.5');
  context.updateDesignProperty('rotation', '99999');

  assert.equal(element.x, 0, 'X=0 is a valid canvas origin');
  assert.equal(element.y, 0, 'Y=0 is a valid canvas origin');
  context.updateDesignProperty('xUnit', '%');
  context.updateDesignProperty('yUnit', '%');
  context.updateDesignProperty('x', '101');
  context.updateDesignProperty('y', '-1');
  assert.equal(element.x, 100, 'percentage X must not exceed 100%');
  assert.equal(element.y, 0, 'percentage Y must not be negative');
  assert.equal(element.width, 4000);
  assert.equal(element.height, 20);
  assert.equal(element.radius, 0);
  assert.equal(element.opacity, 1);
  assert.equal(element.rotation, 3600);
});

test('local SVG capture honors canvas dimensions, visibility, opacity, and rotation', () => {
  const context = makeContext();
  vm.runInContext(extract('function captureDesignSvg(project) {', '\nasync function captureDesignForAI'), context);
  const project = {
    design: {
      frame: 'mobile',
      canvasWidth: 720,
      canvasHeight: 8000,
      background: '#ffffff',
      layoutMode: 'free',
      elements: [
        { id: 'el_visible', type: 'rectangle', x: 0, y: 0, width: 80, height: 100, background: '#ff0000', opacity: 0.5, rotation: 30 },
        { id: 'el_default_opacity', type: 'rectangle', x: 100, y: 0, width: 20, height: 20, background: '#0000ff', opacity: null },
        { id: 'el_hidden', type: 'rectangle', x: 0, y: 0, width: 80, height: 100, background: '#00ff00', visible: false }
      ]
    }
  };
  const captured = context.captureDesignSvg(project);
  assert.equal(captured.width, 720, 'capture width must use the custom canvas width');
  assert.equal(captured.height, 8000, 'capture must preserve the explicit canvas height beyond auto-layout cap');
  assert.match(captured.svg, /opacity="0\.5"/);
  assert.match(captured.svg, /opacity="1"/, 'null opacity must keep the engine default of fully visible');
  assert.match(captured.svg, /rotate\(30 40 50\)/);
  assert.doesNotMatch(captured.svg, /#00ff00/, 'hidden layers must not leak into the AI image');
});

test('visible-layer behavior is shared by editor, AI context, and HTML export; locked actions are guarded', () => {
  const render = extract('function renderDesignWorkspace() {', '\nfunction updateDesignProperty');
  const update = extract('function updateDesignProperty(key, value) {', '\nfunction bindDesignCanvasEvents');
  const capture = extract('async function captureDesignForAI() {', '\nfunction safeDesignExportColor');
  const exporter = extract('function exportDesignHtml() {', '\nfunction setDesignFrame');
  const converter = extract('async function convertDesignToWeb() {', '\nfunction setupNewProjectModalKeys');
  const distribute = extract('function distributeDesignElements(axis =', '\nfunction alignDesignElement');
  const align = extract('function alignDesignElement(mode =', '\nfunction downloadDesignAsset');
  const actions = extract('function moveDesignLayer(direction) {', '\nfunction openDesignFlowGraph');

  assert.match(render, /if \(el\.visible === false\) continue/);
  assert.match(render, /el\.locked \? 'cursor-default' : 'cursor-move'/);
  assert.match(render, /&& !el\.locked/);
  assert.match(render, /if \(el\.locked\) \{ ev\.preventDefault\(\); return; \}/);
  assert.match(render, /layerIndex <= 0 \|\| el\.locked/);
  assert.match(render, /layerIndex >= p\.design\.elements\.length - 1 \|\| el\.locked/);
  assert.match(render, /Opacidad \(0–1\)/);
  assert.match(render, /Rotación \(°\)/);
  assert.match(render, /Unidad X/);
  assert.match(render, /Unidad Y/);
  assert.match(render, /type="checkbox" onfocus="recordDesignHistory\(\)"/);
  assert.match(render, /aria-label="Unidad X" onfocus="recordDesignHistory\(\)"/);
  assert.match(render, /Bloqueada/);
  assert.match(update, /key === 'visible' \|\| key === 'locked'/);
  assert.match(update, /x: \[0, el\.xUnit === '%' \? 100 : 10000\], y: \[0, el\.yUnit === '%' \? 100 : 10000\]/);
  assert.match(capture, /el\.visible !== false/);
  assert.match(capture, /opacity: Math\.max/);
  assert.match(capture, /rotation: Math\.max/);
  assert.match(capture, /locked: el\.locked === true/);
  assert.match(exporter, /el\.visible !== false/);
  assert.match(exporter, /opacity:'\+opacity\+';transform:rotate\('\+rotation\+'deg\)/);
  assert.match(converter, /el\.visible !== false/);
  assert.match(converter, /opacity:'\+opacity\+';transform:rotate\('\+rotation\+'deg\)/);
  assert.match(distribute, /selected\.some\(el => el\.locked\)/);
  assert.match(distribute, /designCoordinateToPixels/);
  assert.match(align, /selected\.some\(item => item\.locked\)/);
  assert.match(align, /setDesignCoordinateFromPixels/);
  assert.match(actions, /element\.locked/);
  assert.match(actions, /!el\.locked/);
});
