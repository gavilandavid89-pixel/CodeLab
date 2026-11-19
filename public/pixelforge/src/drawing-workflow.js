/**
 * Provider-independent drawing workflow.
 *
 * Turns the useful part of the "AI artist" proposal into an auditable state
 * machine: structured strokes + editable layers + visual checkpoints +
 * pause/correct/resume. It never invokes an AI provider.
 */
export const DRAWING_STAGES = Object.freeze([
  'sketch',
  'lineart',
  'flats',
  'lighting-shadows',
  'details',
  'review',
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class DrawingWorkflow {
  #state;

  constructor({ workflowId, projectId = null, stage = 'sketch', revision = 0 } = {}) {
    if (!workflowId || typeof workflowId !== 'string') throw new TypeError('workflowId is required.');
    if (projectId !== null && typeof projectId !== 'string') throw new TypeError('projectId must be a string or null.');
    if (!DRAWING_STAGES.includes(stage)) throw new RangeError('Unknown drawing stage.');
    this.#state = {
      workflowId,
      projectId,
      stage,
      status: 'active',
      revision,
      checkpoint: null,
      history: [],
    };
  }

  getState() {
    return clone(this.#state);
  }

  recordAction(action) {
    if (!action || typeof action !== 'object' || typeof action.name !== 'string') {
      throw new TypeError('A structured drawing action is required.');
    }
    if (this.#state.status !== 'active') throw new Error('Workflow is paused; resume it before applying actions.');
    this.#state.history.push({ revision: ++this.#state.revision, type: 'action', action: clone(action) });
    return this.getState();
  }

  attachVisualFeedback({ snapshotId, summary = '', metrics = {} } = {}) {
    if (!snapshotId || typeof snapshotId !== 'string') throw new TypeError('snapshotId is required.');
    if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) throw new TypeError('metrics must be an object.');
    const feedback = {
      snapshotId,
      summary: String(summary).slice(0, 2000),
      metrics: clone(metrics),
    };
    this.#state.history.push({ revision: ++this.#state.revision, type: 'visual-feedback', feedback });
    this.#state.checkpoint = {
      stage: this.#state.stage,
      revision: this.#state.revision,
      feedback: clone(feedback),
    };
    return this.getState();
  }

  pause(reason = '') {
    if (this.#state.status === 'completed') throw new Error('Completed workflow cannot be paused.');
    this.#state.status = 'paused';
    this.#state.history.push({ revision: ++this.#state.revision, type: 'pause', reason: String(reason).slice(0, 500) });
    return this.getState();
  }

  resume() {
    if (this.#state.status !== 'paused') throw new Error('Workflow is not paused.');
    this.#state.status = 'active';
    this.#state.history.push({ revision: ++this.#state.revision, type: 'resume' });
    return this.getState();
  }

  advanceStage({ feedbackRequired = false } = {}) {
    if (this.#state.status !== 'active') throw new Error('Workflow must be active.');
    if (feedbackRequired && !this.#state.checkpoint) throw new Error('Visual feedback checkpoint is required before advancing.');
    const current = DRAWING_STAGES.indexOf(this.#state.stage);
    if (current === DRAWING_STAGES.length - 1) {
      this.#state.status = 'completed';
      return this.getState();
    }
    this.#state.stage = DRAWING_STAGES[current + 1];
    this.#state.checkpoint = null;
    this.#state.history.push({ revision: ++this.#state.revision, type: 'stage-advance', stage: this.#state.stage });
    return this.getState();
  }

  correct({ stage = this.#state.stage, reason = '', actions = [] } = {}) {
    if (this.#state.status !== 'active') throw new Error('Workflow must be active.');
    if (!DRAWING_STAGES.includes(stage)) throw new RangeError('Unknown correction stage.');
    if (!Array.isArray(actions)) throw new TypeError('Correction actions must be an array.');
    this.#state.stage = stage;
    this.#state.history.push({
      revision: ++this.#state.revision,
      type: 'correction',
      stage,
      reason: String(reason).slice(0, 1000),
      actionCount: actions.length,
    });
    return this.getState();
  }
}

export function createDrawingWorkflow(options) {
  return new DrawingWorkflow(options);
}
