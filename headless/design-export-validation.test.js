'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { importDesignJson } = require('./design-export');

function backupWithColors(colors) {
  return {
    format: 'codelab-design-project',
    version: 1,
    project: {
      name: 'Color import fixture',
      type: 'design',
      code: { html: '', css: '', js: '' },
      design: {
        frame: 'desktop',
        background: colors.canvas,
        elements: [
          { id: 'bad-short', type: 'rectangle', color: colors.fiveDigit, background: colors.sevenDigit },
          { id: 'valid-alpha', type: 'rectangle', color: colors.fourDigit, background: colors.eightDigit },
          { id: 'valid-css', type: 'text', color: colors.named, background: colors.rgba }
        ]
      }
    }
  };
}

test('design import rejects unsupported CSS hex lengths by falling back safely', () => {
  const imported = importDesignJson(backupWithColors({
    canvas: '#12345',
    fiveDigit: '#12345',
    sevenDigit: '#1234567',
    fourDigit: '#abcd',
    eightDigit: '#12345678',
    named: 'rebeccapurple',
    rgba: 'rgba(10, 20, 30, 0.5)'
  }));
  assert.equal(imported.design.background, '#ffffff');
  assert.equal(imported.design.elements[0].color, '#111827');
  assert.equal(imported.design.elements[0].background, 'transparent');
  assert.equal(imported.design.elements[1].color, '#abcd');
  assert.equal(imported.design.elements[1].background, '#12345678');
  assert.equal(imported.design.elements[2].color, 'rebeccapurple');
  assert.equal(imported.design.elements[2].background, 'rgba(10, 20, 30, 0.5)');
});
