const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/pixelforge/index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public/pixelforge/src/editor.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/pixelforge/styles.css'), 'utf8');

assert.match(html, /id="files-tab"/, 'Files tab must exist in the inspector');
assert.match(html, /class="files-section"/, 'Files tab must have an import/export panel');
assert.match(html, /id="import-file"/, 'image and project import must remain available');
assert.match(html, /id="export-project"/, 'editable project export must remain available');
assert.match(html, /id="export-sprite-sheet"/, 'sprite-sheet export must remain available');
assert.match(html, /class="brand" href="\/" aria-label="Back to CodeLab dashboard"/, 'brand must provide a return path to CodeLab');
assert.match(html, /AI proposals currently support pixel edits on existing layers/, 'AI layer-structure limitation must be disclosed');
assert.match(js, /files: '#files-tab'/, 'Files tab must be included in inspector panel state');
assert.match(js, /\$\('#files-tab'\)\.addEventListener\('click'/, 'Files tab must be interactive');
assert.match(css, /\.inspector\[data-panel="files"\] \.inspector-section:not\(\.files-section\)\{display:none\}/, 'mobile Files mode must isolate the Files panel');
assert.match(css, /\.inspector\[data-panel="files"\] \.files-section\{display:block/, 'mobile Files mode must reveal import/export controls');
assert.match(css, /\.top-actions>a\.quiet-button\[href="\/"\]\{display:none\}/, 'mobile header must avoid duplicate CodeLab navigation');
assert.match(css, /max-height:560px/, 'short landscape screens must use the compact layout');

process.stdout.write('PixelForge mobile UI contract checks passed.\n');
