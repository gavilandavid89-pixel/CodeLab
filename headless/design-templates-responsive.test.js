'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TEMPLATE_IDS, createDesignTemplate } = require('./design-templates');
const { applyHeadlessBatch } = require('./workspace-runtime');

test('all responsive design templates keep layer bounds within narrow canvas widths', () => {
  for (const width of [100, 200, 280, 390, 768]) {
    for (const templateId of TEMPLATE_IDS) {
      const template = createDesignTemplate(templateId, { canvasWidth: width, canvasHeight: 160 }, {
        idFactory: (() => { let id = 0; return () => 'test-' + (++id); })()
      });
      assert.ok(template.elements.length > 0, templateId + ' should produce layers');
      assert.ok(template.canvasHeight >= 160, templateId + ' should preserve a valid existing height');
      for (const element of template.elements) {
        assert.ok(element.y + element.height <= template.canvasHeight,
          templateId + ' exceeds computed canvas height at width ' + width);
        assert.ok(element.x >= 0, templateId + ' has a negative x at width ' + width);
        assert.ok(element.width > 0, templateId + ' has a non-positive width at ' + width);
        assert.ok(element.x + element.width <= width, templateId + ' overflows width ' + width + ': ' + JSON.stringify(element));
      }
    }
  }
});

test('applying a template persists its effective fallback canvas width', () => {
  const state = {
    revision: 0,
    projects: [{
      id: 'proj_template_width',
      type: 'design',
      design: {
        frame: 'mobile',
        canvasWidth: 10000,
        canvasHeight: 900,
        canvas: { width: 10000, height: 900, unit: 'px' },
        revision: 0,
        elements: []
      }
    }]
  };
  const applied = applyHeadlessBatch(state, {
    operationId: 'template-width-001',
    baseRevision: 0,
    operations: [{
      type: 'design.template.apply',
      projectId: 'proj_template_width',
      templateId: 'landing'
    }]
  });
  const saved = applied.state.projects[0].design;
  assert.equal(saved.canvasWidth, 390);
  assert.equal(saved.canvas.width, 390);
  assert.equal(applied.results[0].canvasWidth, 390);
  assert.ok(saved.elements.every(element => element.x + element.width <= saved.canvasWidth));
});

test('template sizing falls back for canvas widths outside engine limits', () => {
  const oversized = createDesignTemplate('landing', { frame: 'mobile', canvasWidth: 10000 }, {
    idFactory: (() => { let id = 0; return () => 'oversized-' + (++id); })()
  });
  assert.equal(oversized.canvasWidth, 390);
  assert.ok(oversized.elements.every(element => element.x + element.width <= oversized.canvasWidth));
});

test('applying a template expands persisted canvas height to fit its layers', () => {
  const state = {
    revision: 0,
    projects: [{
      id: 'proj_template_height',
      type: 'design',
      design: {
        canvasWidth: 720,
        canvasHeight: 160,
        canvas: { width: 720, height: 160, unit: 'px' },
        revision: 0,
        elements: []
      }
    }]
  };
  const applied = applyHeadlessBatch(state, {
    operationId: 'template-height-001',
    baseRevision: 0,
    operations: [{
      type: 'design.template.apply',
      projectId: 'proj_template_height',
      templateId: 'portfolio'
    }]
  });
  const saved = applied.state.projects[0].design;
  assert.ok(saved.canvasHeight >= 739);
  assert.equal(saved.canvas.height, saved.canvasHeight);
  assert.equal(applied.results[0].canvasHeight, saved.canvasHeight);
  assert.ok(saved.elements.every(element => element.y + element.height <= saved.canvasHeight));

  const undone = applyHeadlessBatch(applied.state, {
    operationId: 'template-height-undo-001',
    baseRevision: applied.state.revision,
    operations: [{ type: 'design.history.undo', projectId: 'proj_template_height' }]
  });
  const restored = undone.state.projects[0].design;
  assert.equal(restored.canvasHeight, 160);
  assert.equal(restored.canvas.height, 160);
});
