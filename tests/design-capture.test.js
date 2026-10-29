const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const app = fs.readFileSync('public/app.js', 'utf8');

function extractFunction(name) {
  const marker = 'function ' + name + '(';
  const start = app.indexOf(marker);
  assert.notEqual(start, -1, 'Missing function: ' + name);
  const open = app.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = open; i < app.length; i++) {
    const c = app[i], n = app[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && n === '/') { lineComment = true; i++; continue; }
    if (c === '/' && n === '*') { blockComment = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return app.slice(start, i + 1);
  }
  throw new Error('Unclosed function: ' + name);
}

const sandbox = {};
vm.runInNewContext(
  extractFunction('designXmlEscape') + '\n' + extractFunction('captureDesignSvg') +
  '\nthis.captureDesignSvg = captureDesignSvg;',
  sandbox
);

const design = {
  name: 'CI fixture',
  design: {
    frame: 'mobile',
    background: '#ffffff',
    elements: [
      { id: 't1', type: 'heading', text: 'Hello <AI> & "friends"', x: 10, y: 20, width: 300, height: 70, fontSize: 28, color: '#111827', background: 'transparent', textAlign: 'left', weight: 700 },
      { id: 't2', type: 'text', text: 'Centered', x: 20, y: 110, width: 200, height: 40, fontSize: 16, color: '#334155', background: 'transparent', textAlign: 'center' },
      { id: 't3', type: 'text', text: 'Right', x: 20, y: 160, width: 200, height: 40, fontSize: 16, color: '#334155', background: 'transparent', textAlign: 'right' },
      { id: 'b1', type: 'button', text: 'Continue', x: 20, y: 220, width: 180, height: 48, fontSize: 16, color: '#ffffff', background: '#6d28d9', radius: 8 },
      { id: 'r1', type: 'rectangle', x: 10, y: 290, width: 100, height: 60, background: '#e2e8f0', radius: 4 }
    ]
  }
};
const result = sandbox.captureDesignSvg(design);
assert.equal(result.width, 390, 'Mobile frame width must be 390');
assert.equal(result.height, 900, 'Design capture height must be 900');
assert.match(result.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, 'SVG root must be valid');
assert.match(result.svg, /Hello &lt;AI&gt; &amp; &quot;friends&quot;/, 'Text must be XML-escaped');
assert.match(result.svg, /fill="#6d28d9"/, 'Button background must be exported');
assert.match(result.svg, /width="100" height="60"/, 'Rectangle geometry must be exported');
assert.match(result.svg, /text-anchor="start"/, 'Left text alignment must use SVG start anchor');
assert.match(result.svg, /text-anchor="middle"/, 'Centered text alignment must use SVG middle anchor');
assert.match(result.svg, /text-anchor="end"/, 'Right text alignment must use SVG end anchor');

const desktop = sandbox.captureDesignSvg({ design: { frame: 'desktop', background: '#fff', elements: [] } });
assert.equal(desktop.width, 1440, 'Desktop frame width must be 1440');
assert.match(desktop.svg, /<rect width="100%" height="100%" fill="#fff"\/>/, 'Canvas background must be exported');

const tablet = sandbox.captureDesignSvg({ design: { frame: 'tablet', background: '#000000', elements: [] } });
assert.equal(tablet.width, 768, 'Tablet frame width must be 768');
console.log('Design capture tests passed: mobile/tablet/desktop dimensions, XML escaping, text anchors, button and rectangle export.');
