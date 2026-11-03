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
