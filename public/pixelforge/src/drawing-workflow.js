/**
 * Provider-independent drawing workflow.
 *
 * Turns the useful part of the "AI artist" proposal into an auditable state
 * machine: structured strokes + editable layers + visual checkpoints +
 * pause/correct/resume + explicit visual-quality gates.
 *
 * It never invokes an AI provider. The quality result is supplied by the
 * responsible agent after inspecting real visual evidence.
 */
export const DRAWING_STAGES = Object.freeze([
  'sketch',
  'lineart',
  'flats',
  'lighting-shadows',
  'details',
  'review',
]);

export const DRAWING_QUALITY_METRICS = Object.freeze([
  'silhouette',
  'anatomy',
  'pose',
  'motion',
  'consistency',
  'detail',
  'presentation',
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeQuality(quality) {
  if (!quality || typeof quality !== 'object' || Array.isArray(quality)) {
    throw new TypeError('quality must be an object.');
  }

  const score = Number(quality.score);
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new RangeError('quality.score must be between 0 and 1.');
  }

  const metrics = {};
  for (const name of DRAWING_QUALITY_METRICS) {
    const value = Number(quality.metrics?.[name]);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError('quality.metrics.' + name + ' must be between 0 and 1.');
    }
    metrics[name] = value;
  }

  return {
    score,
    metrics,
    decision: ['accept', 'correct', 'reject'].includes(quality.decision)
      ? quality.decision
      : null,
    inspectedVisualEvidence: quality.inspectedVisualEvidence === true,
    notes: String(quality.notes || '').slice(0, 2000),
  };
}

export function isDrawingQualityAcceptable(quality, { minScore = 0.8 } = {}) {
  const normalized = normalizeQuality(quality);
  return normalized.inspectedVisualEvidence === true
    && normalized.decision === 'accept'
    && normalized.score >= minScore
    && Object.values(normalized.metrics).every((value) => value >= minScore);
}

export class DrawingWorkflow {
  #state;

  constructor({
    workflowId,
    projectId = null,
    stage = 'sketch',
    revision = 0,
    qualityGate = { enabled: false, minScore: 0.8 },
  } = {}) {
    if (!workflowId || typeof workflowId !== 'string') throw new TypeError('workflowId is required.');
    if (projectId !== null && typeof projectId !== 'string') throw new TypeError('projectId must be a string or null.');
    if (!DRAWING_STAGES.includes(stage)) throw new RangeError('Unknown drawing stage.');
    if (!qualityGate || typeof qualityGate !== 'object') throw new TypeError('qualityGate must be an object.');
    const minScore = Number(qualityGate.minScore ?? 0.8);
    if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) throw new RangeError('qualityGate.minScore must be between 0 and 1.');

    this.#state = {
      workflowId,
      projectId,
      stage,
      status: 'active',
      revision,
      checkpoint: null,
      qualityGate: {
        enabled: qualityGate.enabled === true,
        minScore,
      },
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

  attachVisualFeedback({ snapshotId, summary = '', metrics = {}, quality = null } = {}) {
    if (!snapshotId || typeof snapshotId !== 'string') throw new TypeError('snapshotId is required.');
    if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) throw new TypeError('metrics must be an object.');

    const feedback = {
      snapshotId,
      summary: String(summary).slice(0, 2000),
      metrics: clone(metrics),
      quality: quality === null ? null : normalizeQuality(quality),
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

  advanceStage({ feedbackRequired = false, qualityRequired = false } = {}) {
    if (this.#state.status !== 'active') throw new Error('Workflow must be active.');

    if (feedbackRequired && !this.#state.checkpoint) {
      throw new Error('Visual feedback checkpoint is required before advancing.');
    }

    if (qualityRequired || this.#state.qualityGate.enabled) {
      const quality = this.#state.checkpoint?.feedback?.quality;
      if (!quality) throw new Error('Visual quality evaluation is required before advancing.');
      if (!isDrawingQualityAcceptable(quality, { minScore: this.#state.qualityGate.minScore })) {
        throw new Error('Visual quality gate rejected this stage; correct the artwork before advancing.');
      }
    }

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
