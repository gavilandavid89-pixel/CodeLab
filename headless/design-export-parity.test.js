'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { exportDesignHtml } = require('./design-export');

function project(elements) {
  return {
    id: 'design-export-parity',
    type: 'design',
    name: 'Export parity',
    design: {
      canvasWidth: 720,
      canvasHeight: 1600,
      background: '#ffffff',
      layoutMode: 'free',
      elements
    }
  };
}

test('semantic HTML export omits hidden layers just like SVG rendering', () => {
  const html = exportDesignHtml(project([
    { id: 'visible-layer', type: 'text', text: 'Visible copy', x: 10, y: 10, width: 200, height: 40 },
    { id: 'hidden-layer', type: 'text', text: 'Secret hidden copy', visible: false, x: 10, y: 60, width: 200, height: 40 }
  ]));

  assert.match(html, /Visible copy/);
  assert.doesNotMatch(html, /Secret hidden copy/);
  assert.match(html, /layer-visible-layer/);
  assert.doesNotMatch(html, /layer-hidden-layer/);
});

test('semantic HTML export preserves safe rotation and opacity values', () => {
  const html = exportDesignHtml(project([
    { id: 'rotated-layer', type: 'rectangle', rotation: 15, opacity: 1, x: 10, y: 10, width: 100, height: 60 },
    { id: 'translucent-layer', type: 'text', text: 'Translucent', opacity: 0.4, x: 10, y: 90, width: 200, height: 40 }
  ]));

  assert.match(html, /transform:rotate\(15deg\);transform-origin:center center;/);
  assert.match(html, /opacity:0\.4;/);
});

test('semantic HTML export preserves safe mailto and tel actions but rejects unsafe schemes', () => {
  const html = exportDesignHtml(project([
    { id: 'email', type: 'button', text: 'Email', href: 'mailto:hello@example.com', x: 10, y: 10, width: 120, height: 40 },
    { id: 'phone', type: 'button', text: 'Call', href: 'tel:+1-555-123-4567', x: 10, y: 60, width: 120, height: 40 },
    { id: 'unsafe', type: 'button', text: 'Unsafe', href: 'javascript:alert(1)', x: 10, y: 110, width: 120, height: 40 }
  ]));

  assert.match(html, /href="mailto:hello@example\.com"/);
  assert.match(html, /href="tel:\+1-555-123-4567"/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /Unsafe/);
});
