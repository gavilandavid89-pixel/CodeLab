'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

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
