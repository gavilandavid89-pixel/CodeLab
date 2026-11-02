'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TEMPLATE_IDS, createDesignTemplate } = require('./design-templates');

test('all responsive design templates keep layer bounds within narrow canvas widths', () => {
  for (const width of [100, 200, 280, 390, 768]) {
    for (const templateId of TEMPLATE_IDS) {
      const template = createDesignTemplate(templateId, { canvasWidth: width }, {
        idFactory: (() => { let id = 0; return () => 'test-' + (++id); })()
      });
      assert.ok(template.elements.length > 0, templateId + ' should produce layers');
      for (const element of template.elements) {
        assert.ok(element.x >= 0, templateId + ' has a negative x at width ' + width);
        assert.ok(element.width > 0, templateId + ' has a non-positive width at ' + width);
        assert.ok(element.x + element.width <= width, templateId + ' overflows width ' + width + ': ' + JSON.stringify(element));
      }
    }
  }
});

test('template sizing falls back for canvas widths outside engine limits', () => {
  const oversized = createDesignTemplate('landing', { frame: 'mobile', canvasWidth: 10000 }, {
    idFactory: (() => { let id = 0; return () => 'oversized-' + (++id); })()
  });
  assert.equal(oversized.canvasWidth, 390);
  assert.ok(oversized.elements.every(element => element.x + element.width <= oversized.canvasWidth));
});
