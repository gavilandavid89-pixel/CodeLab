'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const flowSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'design-flow.js'), 'utf8');

function extract(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, 'missing source marker: ' + startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, 'missing end marker: ' + endMarker);
  return source.slice(start, end);
}

test('hidden layers stay in the layer tree but do not consume layout or canvas space', () => {
  const layout = extract('function getDesignLayoutPositions', 'function setDesignLayoutMode');
  const renderer = extract('function renderDesignWorkspace', 'function pDesignElementsWithoutCurrent');
  assert.match(layout, /filter\(el => !!el && typeof el === 'object' && !el\.hidden\)/);
  assert.match(renderer, /node\.style\.visibility = el\.hidden \? 'hidden' : 'visible'/);
  assert.match(renderer, /node\.style\.display = el\.hidden \? 'none' : 'flex'/);
  assert.match(renderer, /el\.hidden \? 'none' : 'flex'/);
});

test('locked layers cannot be edited or deleted, and duplicate attempts explain why', () => {
  const update = extract('function updateDesignProperty', 'function bindDesignCanvasEvents');
  const duplicate = extract('function duplicateDesignElement', 'function deleteDesignElement');
  const remove = extract('function deleteDesignElement', 'function openDesignFlowGraph');
  const align = extract('function alignDesignElement', 'function downloadDesignAsset');
  assert.match(update, /if \(el\.locked\)/);
  assert.match(duplicate, /if \(selected\[i\]\.locked\)/);
  assert.match(duplicate, /Desbloquea la capa antes de duplicarla/);
  assert.match(duplicate, /const duplicatedConnections = existingConnections/);
  assert.match(duplicate, /duplicateIds\.has\(connection\.sourceElementId\)/);
  assert.match(duplicate, /sourceElementId: duplicateIds\.get\(connection\.sourceElementId\)/);
  assert.match(remove, /selectedIds\.has\(el\.id\) && !el\.locked/);
  assert.match(remove, /Desbloquea la capa antes de eliminarla/);
  assert.match(align, /!selected\.length && el\.locked/);
});

test('inspector and canvas/export renderer expose opacity and font weight consistently', () => {
  const renderer = extract('function renderDesignWorkspace', 'function pDesignElementsWithoutCurrent');
  const update = extract('function updateDesignProperty', 'function bindDesignCanvasEvents');
  const exporter = extract('function exportDesignHtml', 'function setDesignFrame');
  assert.match(renderer, /field\('Opacidad','opacity'/);
  assert.match(renderer, /field\('Peso tipográfico','weight'/);
  assert.match(renderer, /node\.style\.opacity = Math\.max\(0, Math\.min\(1,/);
  assert.match(renderer, /node\.style\.fontWeight = String\(Math\.max\(100, Math\.min\(900,/);
  assert.match(update, /key === 'opacity'/);
  assert.match(update, /weight: \[100, 900\]/);
  assert.match(exporter, /opacity:'\+opacity\+'/);
});

test('numeric property ranges allow coordinate zero and reject non-finite edits', () => {
  const update = extract('function updateDesignProperty', 'function bindDesignCanvasEvents');
  assert.match(update, /const n = Number\(value\); if \(!Number\.isFinite\(n\)\) return;/);
  assert.match(update, /x: \[0,/);
  assert.match(update, /y: \[0,/);
  assert.match(update, /width: \[el\.widthUnit === '%' \? 1 : 20,/);
  assert.match(update, /fontSize: \[8, 256\], weight: \[100, 900\]/);
  assert.match(update, /radius: \[0, 4000\]/);
});

test('auto-sized images use the same effective 20px minimum as export and headless rendering', () => {
  const dimension = extract('function getDesignElementDimension(', 'function getDesignElementDimensionCss(');
  assert.match(dimension, /if \(el\.type === 'image'\) return Math\.max\(20, Math\.min\(4000, value\)\);/);
});

test('rotation, font-size, radius, and opacity ranges match the editor export', () => {
  const renderer = extract('function renderDesignWorkspace', 'function pDesignElementsWithoutCurrent');
  const exporter = extract('function exportDesignHtml', 'function setDesignFrame');
  assert.doesNotMatch(renderer, /Math\.max\(-360, Math\.min\(360, Number\(el\.rotation\)/);
  assert.match(renderer, /Math\.max\(-3600, Math\.min\(3600, Number\(el\.rotation\)/);
  assert.match(exporter, /Math\.max\(-3600, Math\.min\(3600, Number\(el\.rotation\)/);
  assert.match(exporter, /Math\.min\(256, Number\(el\.fontSize\)/);
  assert.match(exporter, /Math\.min\(4000, Number\(el\.radius\)/);
});


test('UI JSON import preserves the same layer contract and remaps flow connection sources', () => {
  const start = source.indexOf('async function importDesignProjectJson');
  assert.notEqual(start, -1, 'missing UI design JSON importer');
  const importer = source.slice(start);
  assert.match(importer, /if \(value == null \|\| \(typeof value === 'string' && !value\.trim\(\)\)\) return fallback;/);
  assert.match(importer, /identifier: typeof raw\.identifier/);
  assert.match(importer, /hidden: raw\.hidden === true \|\| raw\.visible === false/);
  assert.match(importer, /locked: raw\.locked === true/);
  assert.match(importer, /opacity: finite\(raw\.opacity, 1, 0, 1\)/);
  assert.match(importer, /rotation: finite\(raw\.rotation, 0, -3600, 3600\)/);
  assert.match(importer, /flowRole/);
  assert.match(importer, /raw\.widthUnit === '%' \? 1 : 20/);
  assert.match(importer, /normalizeDesignElementIdentifiers\(elements\)/);
  assert.match(importer, /flowConnections: sourceDesign\.flowConnections\.filter/);
  assert.match(importer, /sourceElementId: oldToNewId\.get\(connection\.sourceElementId\)/);
});


test('design-to-web conversion preserves the same layer visibility and visual contract', () => {
  const converter = extract('async function convertDesignToWeb', 'function setupNewProjectModalKeys');
  assert.match(converter, /p\.design\.elements\.filter\(el => el && !el\.hidden\)/);
  assert.match(converter, /const opacity = Math\.max\(0, Math\.min\(1, Number\(el\.opacity \?\? 1\)\)\)/);
  assert.match(converter, /const rotation = Math\.max\(-3600, Math\.min\(3600, Number\(el\.rotation\) \|\| 0\)\)/);
  assert.match(converter, /data-design-identifier/);
  assert.match(converter, /getDesignElementDimensionCss\(el, 'width'\)/);
  assert.match(converter, /buildFlowAwareWebHtml\(p, html\)/);
});


test('multi-screen flow export honors hidden sources, responsive dimensions, opacity, rotation, and identifiers', () => {
  const start = flowSource.indexOf('function buildFlowAwareWebHtml');
  assert.notEqual(start, -1, 'missing multi-screen flow exporter');
  const exporter = flowSource.slice(start);
  assert.match(exporter, /source\.hidden !== true && source\.visible !== false/);
  assert.match(exporter, /d\.elements\.filter\(el=>el && !el\.hidden && el\.visible !== false\)/);
  assert.match(exporter, /flowElementDimension\(el,'width'/);
  assert.match(exporter, /flowElementDimensionCss\(el,'width'\)/);
  assert.match(exporter, /opacity:'\+opacity\+'/);
  assert.match(exporter, /transform:rotate\('\+rotation\+'deg\)/);
  assert.match(exporter, /data-design-identifier/);
  assert.match(exporter, /frameHeight=Math\.max\(flowCanvasHeight\(d\), Number\(layout\.height\)\|\|0\)/);
  assert.match(exporter, /height:'\+frameHeight\+'px/);
  const helpers = flowSource.slice(0, start);
  assert.match(helpers, /function flowLayoutPositions/);
  assert.match(helpers, /element.hidden !== true && element.visible !== false/);
  assert.match(helpers, /unit === '%'\) return Math.max\(20, Math.min\(4000, containerSize \* Math.min\(100, value\) \/ 100\)\)/);
});


test('duplicating a navigation layer clones its outgoing flow connection to the new ID', () => {
  const duplicate = extract('function duplicateDesignElement()', 'function deleteDesignElement()');
  const project = {
    id: 'design-project',
    design: {
      elements: [
        { id: 'nav', type: 'button', label: 'Next', text: 'Next', x: 10, y: 20, width: 100, height: 40, flowRole: 'navigate' },
        { id: 'content', type: 'heading', label: 'Content', text: 'Content', x: 20, y: 80, width: 200, height: 60 }
      ],
      flowConnections: [{ sourceElementId: 'nav', targetProjectId: 'target-screen' }]
    }
  };
  const sandbox = {
    activeDesignProject: () => project,
    selectedDesignElementId: 'nav',
    selectedDesignElementIds: ['nav'],
    MAX_DESIGN_ELEMENTS: 500,
    crypto: { randomUUID: () => 'copy-1' },
    recordDesignHistory: () => {},
    getDesignCanvasWidth: () => 720,
    getDesignCanvasHeight: () => 1600,
    getDesignElementPosition: (element, axis) => Number(element[axis]) || 0,
    nextDesignElementIdentifier: () => 'nav-copy',
    designLayerDomId: id => 'layer-' + id,
    renderDesignWorkspace: () => {},
    saveProjectsToStorage: () => {},
    showToast: () => {}
  };
  vm.runInNewContext(duplicate + '\nduplicateDesignElement();', sandbox);
  assert.equal(project.design.elements.length, 3);
  assert.equal(project.design.flowConnections.length, 2);
  assert.equal(project.design.flowConnections[1].sourceElementId, 'el_copy-1');
  assert.equal(project.design.flowConnections[1].targetProjectId, 'target-screen');
  assert.equal(project.design.elements[2].flowRole, 'navigate');
});

test('inspector updates enforce real numeric bounds and preserve zero coordinates', () => {
  const update = extract('function updateDesignProperty', 'function bindDesignCanvasEvents');
  const project = { design: { layoutMode: 'free', elements: [{
    id: 'target', type: 'button', x: 12, y: 14, width: 100, height: 40,
    fontSize: 16, weight: 400, radius: 4, rotation: 0, opacity: 1
  }] } };
  const sandbox = {
    activeDesignProject: () => project,
    selectedDesignElementId: 'target',
    document: { querySelectorAll: () => [], getElementById: () => null },
    scheduleAutosave: () => {},
    showToast: () => {},
    getDesignCanvasWidth: () => 720,
    getDesignCanvasHeight: () => 1600
  };
  vm.runInNewContext(update + "\nupdateDesignProperty('x', 0);\nupdateDesignProperty('y', 0);\nupdateDesignProperty('opacity', 2);\nupdateDesignProperty('fontSize', 999);\nupdateDesignProperty('weight', 950);\nupdateDesignProperty('radius', 9000);\nupdateDesignProperty('rotation', -9000);", sandbox);
  const layer = project.design.elements[0];
  assert.equal(layer.x, 0);
  assert.equal(layer.y, 0);
  assert.equal(layer.opacity, 1);
  assert.equal(layer.fontSize, 256);
  assert.equal(layer.weight, 900);
  assert.equal(layer.radius, 4000);
  assert.equal(layer.rotation, -3600);
});

test('locked layer inspector rejects property edits without mutating the layer', () => {
  const update = extract('function updateDesignProperty', 'function bindDesignCanvasEvents');
  const layer = { id: 'locked', type: 'button', locked: true, text: 'Original' };
  const project = { design: { elements: [layer] } };
  const messages = [];
  const sandbox = {
    activeDesignProject: () => project,
    selectedDesignElementId: 'locked',
    document: { querySelectorAll: () => [] },
    scheduleAutosave: () => {},
    showToast: message => messages.push(message)
  };
  vm.runInNewContext(update + "\nupdateDesignProperty('text', 'Changed');", sandbox);
  assert.equal(layer.text, 'Original');
  assert.match(messages[0], /Desbloquea la capa/);
});

test('rejected deletion of locked layers does not create an undo-history entry', () => {
  const remove = extract('function deleteDesignElement()', 'function openDesignFlowGraph()');
  const project = { design: { elements: [{ id: 'locked', locked: true }], flowConnections: [] } };
  let historyCalls = 0;
  const sandbox = {
    activeDesignProject: () => project,
    selectedDesignElementId: 'locked',
    selectedDesignElementIds: ['locked'],
    recordDesignHistory: () => { historyCalls++; },
    showToast: () => {},
    renderDesignWorkspace: () => {},
    saveProjectsToStorage: () => {}
  };
  vm.runInNewContext(remove + '\ndeleteDesignElement();', sandbox);
  assert.equal(historyCalls, 0, 'a rejected operation must not pollute undo history');
  assert.equal(project.design.elements.length, 1, 'the locked layer must remain');
});
