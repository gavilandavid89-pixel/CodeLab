import assert from 'node:assert/strict';
import test from 'node:test';
import { DrawingWorkflow, DRAWING_STAGES, isDrawingQualityAcceptable } from '../public/pixelforge/src/drawing-workflow.js';

const goodQuality = {
  score: 0.9,
  metrics: {
    silhouette: 0.92,
    anatomy: 0.88,
    pose: 0.91,
    motion: 0.9,
    consistency: 0.89,
    detail: 0.87,
    presentation: 0.9,
  },
  decision: 'accept',
  inspectedVisualEvidence: true,
  notes: 'Inspected representative video frames and final render.',
};

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

test('quality gate rejects artwork that was not visually inspected or is below threshold', () => {
  const workflow = new DrawingWorkflow({
    workflowId: 'wf-quality-reject',
    qualityGate: { enabled: true, minScore: 0.8 },
  });

  workflow.attachVisualFeedback({
    snapshotId: 'bad-video',
    summary: 'Movement resembles dancing and the figure loses definition.',
    metrics: { motion: 0.3 },
    quality: {
      score: 0.5,
      metrics: {
        silhouette: 0.5,
        anatomy: 0.5,
        pose: 0.4,
        motion: 0.3,
        consistency: 0.5,
        detail: 0.4,
        presentation: 0.4,
      },
      decision: 'correct',
      inspectedVisualEvidence: true,
      notes: 'Rejected after video inspection.',
    },
  });

  assert.equal(isDrawingQualityAcceptable(workflow.getState().checkpoint.feedback.quality), false);
  assert.throws(
    () => workflow.advanceStage({ feedbackRequired: true }),
    /quality gate rejected/
  );
});

test('quality gate accepts only inspected, explicitly accepted, high-quality evidence', () => {
  const workflow = new DrawingWorkflow({
    workflowId: 'wf-quality-accept',
    qualityGate: { enabled: true, minScore: 0.8 },
  });

  workflow.attachVisualFeedback({
    snapshotId: 'good-video',
    summary: 'Clear silhouette, stable anatomy and coherent walking cycle.',
    metrics: { visualQuality: 0.9 },
    quality: goodQuality,
  });

  assert.equal(isDrawingQualityAcceptable(goodQuality), true);
  workflow.advanceStage({ feedbackRequired: true });
  assert.equal(workflow.getState().stage, 'lineart');
});

test('final stage completes without inventing another stage', () => {
  const workflow = new DrawingWorkflow({ workflowId: 'wf-3', stage: 'review' });
  workflow.advanceStage();
  assert.equal(workflow.getState().status, 'completed');
  assert.equal(workflow.getState().stage, 'review');
});
