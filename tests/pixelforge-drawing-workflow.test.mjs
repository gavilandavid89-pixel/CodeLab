import assert from 'node:assert/strict';
import test from 'node:test';
import { DrawingWorkflow, DRAWING_STAGES } from '../public/pixelforge/src/drawing-workflow.js';

test('drawing workflow follows staged editable visual-feedback loop', () => {
  const workflow = new DrawingWorkflow({ workflowId: 'wf-1', projectId: 'p-1' });
  assert.deepEqual(DRAWING_STAGES, ['sketch', 'lineart', 'flats', 'lighting-shadows', 'details', 'review']);

  workflow.recordAction({
    name: 'canvas.draw_stroke',
    points: [{ x: 1, y: 1 }, { x: 2, y: 2 }],
    size: 2,
    color: '#112233',
  });

  assert.equal(workflow.getState().history.at(-1).action.name, 'canvas.draw_stroke');

  workflow.attachVisualFeedback({
    snapshotId: 'vision-1',
    summary: 'Silhouette is centered; left arm needs correction.',
    metrics: { silhouetteCoverage: 0.61 },
  });

  workflow.pause('user review');
  assert.equal(workflow.getState().status, 'paused');
  assert.throws(
    () => workflow.recordAction({ name: 'canvas.draw_stroke', points: [{ x: 2, y: 2 }] }),
    /paused/
  );

  workflow.resume();
  workflow.correct({
    stage: 'sketch',
    reason: 'Improve left arm after visual review.',
    actions: [{ name: 'canvas.draw_stroke', points: [{ x: 2, y: 2 }, { x: 3, y: 2 }] }],
  });

  workflow.advanceStage({ feedbackRequired: true });
  assert.equal(workflow.getState().stage, 'lineart');
  assert.equal(workflow.getState().status, 'active');
});

test('visual checkpoint can gate stage transitions', () => {
  const workflow = new DrawingWorkflow({ workflowId: 'wf-2' });
  assert.throws(() => workflow.advanceStage({ feedbackRequired: true }), /feedback checkpoint/);
  workflow.attachVisualFeedback({ snapshotId: 'vision-2' });
  workflow.advanceStage({ feedbackRequired: true });
  assert.equal(workflow.getState().stage, 'lineart');
});

test('final stage completes without inventing another stage', () => {
  const workflow = new DrawingWorkflow({ workflowId: 'wf-3', stage: 'review' });
  workflow.advanceStage();
  assert.equal(workflow.getState().status, 'completed');
  assert.equal(workflow.getState().stage, 'review');
});
