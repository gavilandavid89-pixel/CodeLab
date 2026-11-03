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

test('visual design review preserves the remote AI analysis flow', () => {
  assert.match(source, /async function callRemoteDesignReviewAi\(screenshotDataUrl, context\)/);
  assert.match(source, /const review = await callRemoteDesignReviewAi\(dataUrl, context\)/,
    'captureDesignForAI must send the generated PNG and structured context to the remote reviewer');
  assert.match(source, /fetch\('\/api\/ai\/design-review'/,
    'remote visual review must use the authenticated design review endpoint');
  assert.match(source, /downloadDesignAsset\(slug \+ '-revision-ia\.json'/,
    'the returned visual review must remain exportable as a JSON report');
});

test('locked layers cannot be edited or deleted, and duplicate attempts explain why', () => {
  const update = extract('function updateDesignProperty', 'function bindDesignCanvasEvents');
  const duplicate = extract('function duplicateDesignElement', 'function deleteDesignElement');
  const remove = extract('function deleteDesignElement', 'function openDesignFlowGraph');
  const align = extract('function alignDesignElement', 'function downloadDesignAsset');
  assert.match(update, /if \(el\.locked\)/);
  assert.match(duplicate, /selected\.some\(item => item\.locked\)/);
  assert.match(duplicate, /Desbloquea todas las capas seleccionadas antes de duplicarlas/);
  assert.match(duplicate, /const duplicatedConnections = existingConnections/);
  assert.match(duplicate, /duplicateIds\.has\(connection\.sourceElementId\)/);
  assert.match(duplicate, /sourceElementId: duplicateIds\.get\(connection\.sourceElementId\)/);
  assert.match(remove, /selectedElements\.some\(el => el\.locked\)/);
  assert.match(remove, /Desbloquea todas las capas seleccionadas antes de eliminarlas/);
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

test('AI design capture retains remote visual review and exports the analysis report', () => {
  assert.match(source, /async function captureDesignForAI\(\)/);
  assert.match(source, /callRemoteDesignReviewAi\(dataUrl, context\)/);
  assert.match(source, /async function callRemoteDesignReviewAi\(screenshotDataUrl, context\)/);
  assert.match(source, /\/api\/ai\/design-review/);
  assert.match(source, /downloadDesignAsset\(slug \+ '-revision-ia\.json'/);
  assert.match(source, /designCaptureMode/);
});

test('distribution resolves mixed px/% units, preserves representable units, and rejects locked selections atomically', () => {
  assert.match(source, /x: finite\(raw\.x, 0, 0, raw\.xUnit === '%' \? 200 : 10000\)/);
  assert.match(source, /y: finite\(raw\.y, 0, 0, raw\.yUnit === '%' \? 200 : 10000\)/);
  const positionStart = source.indexOf('function getDesignElementPosition(');
  assert.notEqual(positionStart, -1, 'missing effective position helper');
  const positionSource = source.slice(positionStart);
  const distribution = extract('function distributeDesignElements', 'function alignDesignElement');
  const makeProject = (locked = false) => ({
    id: 'mixed-units',
    design: {
      layoutMode: 'free', canvasWidth: 500, canvasHeight: 1000,
      elements: [
        { id: 'a', x: 10, xUnit: 'px', width: 100, widthUnit: 'px', y: 0, height: 20 },
        { id: 'b', x: 20, xUnit: '%', width: 10, widthUnit: '%', y: 0, height: 20, locked },
        { id: 'c', x: 50, xUnit: '%', width: 100, widthUnit: 'px', y: 0, height: 20 }
      ]
    }
  });
  const run = project => {
    let history = 0;
    const toasts = [];
    const sandbox = {
      activeDesignProject: () => project,
      selectedDesignElementIds: ['a', 'b', 'c'],
      getDesignCanvasWidth: design => design.canvasWidth,
      getDesignCanvasHeight: design => design.canvasHeight,
      getDesignElementDimension: (el, axis, size) => {
        const unit = el[axis + 'Unit'];
        const raw = Number(el[axis]);
        if (unit === '%') return Math.max(1, Math.min(4000, size * Math.min(100, raw) / 100));
        return Number.isFinite(raw) && raw > 0 ? raw : (axis === 'width' ? 120 : 48);
      },
      recordDesignHistory: () => { history++; },
      renderDesignWorkspace: () => {},
      saveProjectsToStorage: () => {},
      showToast: message => toasts.push(message)
    };
    vm.runInNewContext(positionSource + '\n' + distribution + '\nthis.position = getDesignElementPosition; this.run = distributeDesignElements;', sandbox);
    sandbox.run('horizontal');
    return { project, history, toasts, position: sandbox.position };
  };

  const mixed = run(makeProject());
  const [a, b, c] = mixed.project.design.elements;
  assert.equal(mixed.history, 1);
  assert.equal(a.x, 10);
  assert.equal(a.xUnit, 'px');
  assert.equal(b.xUnit, '%');
  assert.ok(Math.abs(b.x - 31) < 0.01, 'the 155px placement should be stored as 31% of a 500px canvas');
  assert.equal(c.x, 50);
  assert.equal(c.xUnit, '%');
  assert.equal(mixed.position({ y: 200, yUnit: '%' }, 'y', 10000), 20000, 'effective percentage positions must not be capped at 10000px');

  const lockedProject = makeProject(true);
  const locked = run(lockedProject);
  assert.equal(locked.history, 0, 'locked selection must fail before history or mutation');
  assert.deepEqual(locked.project.design.elements.map(el => [el.x, el.xUnit]), [
    [10, 'px'], [20, '%'], [50, '%']
  ]);
  assert.match(locked.toasts[0], /Desbloquea todas las capas seleccionadas/);
});

test('numeric property ranges allow coordinate zero and reject non-finite edits', () => {
  const update = extract('function updateDesignProperty', 'function bindDesignCanvasEvents');
  assert.match(update, /const n = Number\(value\); if \(!Number\.isFinite\(n\)\) return;/);
  assert.match(update, /x: \[0,/);
  assert.match(update, /y: \[0,/);
  assert.match(update, /width: \[el\.widthUnit === '%' \? 1 : el\.widthUnit === 'auto' \? 0 : 20,/);
  assert.match(update, /fontSize: \[8, 256\], weight: \[100, 900\]/);
  assert.match(update, /radius: \[0, 4000\]/);
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
  assert.match(importer, /raw\.widthUnit === '%' \? 1 : raw\.widthUnit === 'auto' \? 0 : 20/);
  assert.match(importer, /raw\.heightUnit === '%' \? 1 : raw\.heightUnit === 'auto' \? 0 : 20/);
  assert.match(importer, /raw\.heightUnit === '%' \? 100 : 4000/);
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
