import { RasterDocument } from './core.js';
import { AIWorkspace } from './workspaces.js';
import { AICommandSession } from './ai-tools.js';

/**
 * DOM-free, provider-independent PixelForge automation runtime.
 * Mutations stay in an isolated sandbox until an explicit proposal is accepted.
 */
export class HeadlessEditorRuntime {
  #document;
  #workspace;
  #commands;

  constructor({ width = 128, height = 128, name = 'Untitled artwork', project = null } = {}) {
    this.#document = project === null
      ? new RasterDocument(width, height, name)
      : RasterDocument.fromJSON(project);
    this.#resetWorkspace();
  }

  #resetWorkspace() {
    this.#workspace = new AIWorkspace(this.#document);
    this.#commands = new AICommandSession(this.#workspace);
  }

  get document() { return this.#document; }
  get sandbox() { return this.#workspace.sandbox; }
  get workspace() { return this.#workspace; }
  get hasPendingChanges() { return this.#workspace.hasSandboxChanges; }
  get hasPendingProposal() { return this.#workspace.hasProposal; }

  execute(action) { return this.#commands.execute(action); }

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
    };
  }

  createProposal(summary) {
    if (!this.#workspace.hasSandboxChanges) throw new Error('There are no sandbox changes to propose.');
    return this.#commands.createProposal(summary);
  }

  getDiff() {
    const diff = this.#workspace.getVisualDiff();
    return { width: diff.width, height: diff.height, changedPixels: diff.changedPixels, bounds: diff.bounds, pixels: diff.pixels };
  }

  acceptProposal() {
    const result = this.#workspace.acceptProposal();
    if (result.status === 'applied') this.#document.dirty = true;
    return result;
  }

  discardProposal() { return this.#workspace.discardProposal(); }
  discardSandboxChanges() { return this.#workspace.discardSandboxChanges(); }
  syncFromSource(options) { return this.#workspace.syncFromUser(options); }

  toJSON() {
    if (this.#workspace.hasProposal || this.#workspace.hasSandboxChanges) {
      throw new Error('Unreviewed sandbox changes cannot be serialized. Create and accept a proposal first.');
    }
    return this.#document.toJSON();
  }

  static fromJSON(project) { return new HeadlessEditorRuntime({ project }); }
}

export function createHeadlessRuntime(options) {
  return new HeadlessEditorRuntime(options);
}
