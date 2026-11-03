'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { auditDesignAccessibility, contrastRatio } = require('./design-accessibility');
const { queryHeadlessWorkspace } = require('./workspace-runtime');

function designProject(elements) {
  return {
    id: 'proj_a11y_audit',
    name: 'Accessibility audit fixture',
    type: 'design',
    design: {
      revision: 7,
      canvasWidth: 720,
      canvasHeight: 1600,
      background: '#ffffff',
      elements
    }
  };
}

test('design accessibility audit reports missing accessible names, alt text, small text and low declared contrast', () => {
  const project = designProject([
    { id: 'el_image', type: 'image', label: 'Hero image', src: 'data:image/png;base64,AA==' },
    { id: 'el_button', type: 'button', label: '', text: '' },
    { id: 'el_heading', type: 'heading', label: '', text: '' },
    { id: 'el_caption', type: 'text', label: 'Caption', text: 'Small low contrast', fontSize: 11, weight: 400, color: '#777777', background: '#ffffff' },
    { id: 'el_ok', type: 'text', label: 'Good contrast', text: 'Readable', fontSize: 16, color: '#000000', background: '#ffffff' }
  ]);

  const report = auditDesignAccessibility(project);
  assert.equal(report.projectId, project.id);
  assert.equal(report.designRevision, 7);
  assert.equal(report.elementCount, 5);
  assert.deepEqual(report.findings.map(item => item.ruleId).sort(), [
    'button-name', 'heading-name', 'image-alt', 'small-text', 'text-contrast'
  ]);
  assert.equal(report.counts.error, 2);
  assert.equal(report.counts.warning, 3);
  assert.equal(report.findings.find(item => item.ruleId === 'text-contrast').contrastBasis, 'declared-layer-background');
});

test('design accessibility audit treats null opacity as the default fully opaque layer', () => {
  const report = auditDesignAccessibility(designProject([
    { id: 'null-opacity-copy', type: 'text', text: 'Readable', fontSize: 16, color: '#000000', background: '#ffffff', opacity: null }
  ]));

  assert.equal(report.findings.some(item => item.ruleId === 'text-opacity-contrast'), false);
  assert.equal(report.findings.some(item => item.ruleId === 'text-contrast'), false);
});

test('design accessibility audit warns when partial layer opacity makes contrast uncertain', () => {
  const report = auditDesignAccessibility(designProject([
    { id: 'semi-transparent-copy', type: 'text', text: 'Read me', fontSize: 16, color: '#000000', background: '#ffffff', opacity: 0.5 }
  ]));

  const finding = report.findings.find(item => item.ruleId === 'text-opacity-contrast');
  assert.ok(finding);
  assert.equal(finding.severity, 'warning');
  assert.equal(finding.opacity, 0.5);
  assert.equal(finding.contrastBasis, 'opacity-not-composited');

  const invalidOpacity = auditDesignAccessibility(designProject([
    { id: 'invalid-opacity-copy', type: 'text', text: 'Read me', fontSize: 16, color: '#000000', background: '#ffffff', opacity: 2 }
  ]));
  const invalidFinding = invalidOpacity.findings.find(item => item.ruleId === 'text-opacity-contrast');
  assert.ok(invalidFinding);
  assert.equal(invalidFinding.opacity, 1);
  assert.equal(invalidFinding.declaredOpacity, 2);
});

test('design accessibility audit is read-only and exposed through the canonical query envelope', () => {
  const project = designProject([
    { id: 'el_button', type: 'button', label: 'Continue', text: 'Continue', fontSize: 16, color: '#000000', background: '#ffffff' }
  ]);
  const state = { revision: 12, projects: [project] };
  const before = JSON.stringify(state);

  const response = queryHeadlessWorkspace(state, {
    action: 'design.accessibility.audit',
    args: { projectId: project.id }
  });

  assert.equal(response.action, 'design.accessibility.audit');
  assert.equal(response.revision, 12);
  assert.equal(response.result.findingCount, 0);
  assert.equal(JSON.stringify(state), before, 'an audit must not mutate workspace or design revisions');
});

test('design accessibility audit validates project type and computes WCAG contrast ratios', () => {
  assert.equal(contrastRatio('#000', '#fff'), 21);
  assert.equal(contrastRatio('#777777', '#ffffff') < 4.5, true);
  assert.equal(contrastRatio('transparent', '#ffffff'), null);
  assert.throws(() => auditDesignAccessibility({ type: 'web', code: { html: '' } }), {
    code: 'HEADLESS_INVALID_QUERY'
  });
});
