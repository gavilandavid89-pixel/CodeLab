import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/pixelforge/index.html', import.meta.url), 'utf8');
const editor = readFileSync(new URL('../public/pixelforge/src/editor.js', import.meta.url), 'utf8');

const originalDrawingTools = [
  'brush-tool', 'cursor-mode', 'eraser-tool', 'fill-tool', 'eyedropper-tool',
  'select-tool', 'ellipse-select-tool', 'lasso-select-tool', 'magic-select-tool',
  'line-tool', 'rectangle-tool', 'ellipse-tool', 'gradient-tool', 'pan-tool',
];

const existingFeatureControls = [
  'undo', 'redo', 'save', 'export-png', 'new-document', 'projects-button',
  'grid-toggle', 'symmetry-mode', 'add-layer', 'rename-layer', 'duplicate-layer',
  'delete-layer', 'layer-opacity', 'palette-add', 'palette-import', 'palette-export',
  'replace-color', 'selection-invert', 'selection-expand', 'selection-contract',
  'transform-preview', 'transform-apply', 'transform-cancel', 'crop-preview',
  'crop-apply', 'crop-cancel', 'import-file', 'export-project',
  'export-sprite-sheet', 'ai-sync', 'ai-refresh-preview',
];

test('keeps every original drawing tool available and wired to the existing editor', () => {
  for (const id of originalDrawingTools) {
    assert.match(html, new RegExp('id="' + id + '"'), id + ' must remain in the editor toolbar');
    const selector = new RegExp("\\$\\(['\"]#" + id + "['\"]\\)");
    assert.match(editor, selector, id + ' must remain connected to the editor');
    const variable = editor.match(new RegExp('\\b(?:const|let)\\s+(\\w+)\\s*=\\s*\\$\\([\'"]#' + id + '[\'"]\\)'));
    const hasDirectHandler = editor.includes("$('#" + id + "').addEventListener");
    const hasVariableHandler = variable && editor.includes(variable[1] + '.addEventListener');
    assert.ok(hasDirectHandler || hasVariableHandler, id + ' must retain its editor event handler');
  }
});
test('preserves the original editing, layer, selection, import, export, and AI controls', () => {
  for (const id of existingFeatureControls) {
    assert.match(html, new RegExp('id="' + id + '"'), id + ' must remain in the editor UI');
    assert.ok(editor.includes('#' + id), id + ' must remain connected to editor logic');
  }
  assert.match(editor, /canvas\.addEventListener\('pointerdown'/, 'canvas drawing pointer handling must remain present');
  assert.match(editor, /canvas\.addEventListener\('pointermove'/, 'continuous stroke handling must remain present');
  assert.match(editor, /canvas\.addEventListener\('wheel'/, 'canvas zoom handling must remain present');
  assert.match(editor, /window\.addEventListener\('keydown'/, 'keyboard shortcuts must remain present');
});

test('keeps the mobile Files panel additive rather than replacing existing inspector panels', () => {
  for (const id of ['properties-tab', 'layers-tab', 'ai-tab', 'files-tab']) {
    assert.match(html, new RegExp('id="' + id + '"'), id + ' must remain reachable');
  }
  assert.match(editor, /files: '#files-tab'/, 'Files must be an additive inspector mode');
  assert.match(editor, /properties: '#properties-tab'/, 'Properties must remain an inspector mode');
  assert.match(editor, /layers: '#layers-tab'/, 'Layers must remain an inspector mode');
  assert.match(editor, /ai: '#ai-tab'/, 'AI Space must remain an inspector mode');
});
