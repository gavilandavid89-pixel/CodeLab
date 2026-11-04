import { RasterDocument } from './core.js';
import { AIWorkspace } from './workspaces.js';
import { AICommandSession } from './ai-tools.js';
import { applyAnimationAction, createAnimationTimeline, summarizeAnimationTimeline, validateAnimationTimeline } from './animation.js';

/**
 * DOM-free, provider-independent PixelForge automation runtime.
 * Mutations stay in an isolated sandbox until an explicit proposal is accepted.
 */
export class HeadlessEditorRuntime {
  #document;
  #workspace;
  #commands;
  #animation;
  #sandboxAnimation;
  #animationDirty = false;
  #hasAnimation = false;

  constructor({ width = 128, height = 128, name = 'Untitled artwork', project = null } = {}) {
    this.#document = project === null
      ? new RasterDocument(width, height, name)
      : RasterDocument.fromJSON(project);
    this.#hasAnimation = Boolean(project?.animation);
    this.#animation = validateAnimationTimeline(project?.animation, this.#document.width, this.#document.height);
    this.#resetWorkspace();
  }

  #resetWorkspace() {
    this.#workspace = new AIWorkspace(this.#document);
    this.#commands = new AICommandSession(this.#workspace);
    this.#sandboxAnimation = JSON.parse(JSON.stringify(this.#animation));
    this.#animationDirty = false;
  }

  get document() { return this.#document; }
  get sandbox() { return this.#workspace.sandbox; }
  get workspace() { return this.#workspace; }
  get hasPendingChanges() { return this.#workspace.hasSandboxChanges || this.#animationDirty; }
  get hasPendingProposal() { return this.#workspace.hasProposal; }

  execute(action) {
    if (action && typeof action.name === 'string' && action.name.startsWith('animation.')) {
      if (this.#workspace.hasProposal && action.name !== 'animation.get_summary') {
        return { ok: false, action: action.name, error: { code: 'proposal_pending', message: 'Accept or discard the pending proposal before making more animation edits.' } };
      }
      try {
        const outcome = applyAnimationAction(this.#sandboxAnimation, this.#workspace.sandbox, action);
        this.#sandboxAnimation = outcome.timeline;
        this.#animationDirty = this.#animationDirty || outcome.changed;
        return { ok: true, action: action.name, result: outcome.result };
      } catch (error) {
        return { ok: false, action: action.name, error: {
          code: error instanceof RangeError ? 'out_of_bounds_or_limit' : error instanceof TypeError ? 'invalid_arguments' : 'operation_failed',
          message: error instanceof Error ? error.message : 'Animation operation failed.',
        } };
      }
    }
    return this.#commands.execute(action);
  }

  executeBatch(actions) {
    if (!Array.isArray(actions) || actions.length < 1 || actions.length > 500) {
      throw new RangeError('A headless batch must contain between 1 and 500 actions.');
    }
    const results = [];
    for (let index = 0; index < actions.length; index++) {
      const result = this.execute(actions[index]);
      results.push({ index, ...result });
      if (!result.ok) return { ok: false, failedIndex: index, results, error: result.error };
    }
    return { ok: true, results };
  }

  inspect() {
    const source = this.#document;
    const sandbox = this.#workspace.sandbox;
    return {
      mode: 'headless',
      project: {
        id: source.id, name: source.name, width: source.width, height: source.height,
        revision: source.revision, serverRevision: source.serverRevision,
        layerCount: source.layers.length,
        layers: source.layers.map((layer, index) => ({
          index, id: layer.id, name: layer.name, visible: layer.visible,
          locked: layer.locked, opacity: layer.opacity,
        })),
      },
      sandbox: {
        width: sandbox.width, height: sandbox.height, revision: sandbox.revision,
        layerCount: sandbox.layers.length, hasChanges: this.#workspace.hasSandboxChanges,
      },
      proposal: this.#workspace.proposalSummary,
      animation: summarizeAnimationTimeline(this.#sandboxAnimation),
    };
  }

  createProposal(summary) {
    if (!this.hasPendingChanges) throw new Error('There are no sandbox or animation changes to propose.');
    return this.#commands.createProposal(summary);
  }

  getDiff() {
    const diff = this.#workspace.getVisualDiff();
    return { width: diff.width, height: diff.height, changedPixels: diff.changedPixels, bounds: diff.bounds, pixels: diff.pixels };
  }

  acceptProposal() {
    const hadRasterChanges = this.#workspace.hasSandboxChanges;
    const hadAnimationChanges = this.#animationDirty;
    const result = this.#workspace.acceptProposal();
    if (result.status === 'applied') {
      if (hadAnimationChanges) {
        this.#animation = JSON.parse(JSON.stringify(this.#sandboxAnimation));
        this.#hasAnimation = true;
        this.#animationDirty = false;
      }
      if (!hadRasterChanges && hadAnimationChanges) {
        this.#document.revision++;
        this.#document.saveVersion++;
      }
      if (hadRasterChanges || hadAnimationChanges) this.#document.dirty = true;
    }
    return result;
  }

  discardProposal() {
    const discarded = this.#workspace.discardProposal();
    if (discarded) this.#sandboxAnimation = JSON.parse(JSON.stringify(this.#animation));
    this.#animationDirty = false;
    return discarded;
  }
  discardSandboxChanges() {
    const discarded = this.#workspace.discardSandboxChanges();
    if (discarded || this.#animationDirty) this.#sandboxAnimation = JSON.parse(JSON.stringify(this.#animation));
    this.#animationDirty = false;
    return discarded || true;
  }
  syncFromSource(options) {
    const result = this.#workspace.syncFromUser(options);
    if (result.status === 'synced') {
      this.#sandboxAnimation = JSON.parse(JSON.stringify(this.#animation));
      this.#animationDirty = false;
    }
    return result;
  }

  toJSON() {
    if (this.#workspace.hasProposal || this.hasPendingChanges) {
      throw new Error('Unreviewed sandbox changes cannot be serialized. Create and accept a proposal first.');
    }
    const project = this.#document.toJSON();
    if (this.#hasAnimation || this.#animation.frames.length > 0) project.animation = JSON.parse(JSON.stringify(this.#animation));
    return project;
  }

  static fromJSON(project) { return new HeadlessEditorRuntime({ project }); }
}

export function createHeadlessRuntime(options) {
  return new HeadlessEditorRuntime(options);
}
