import { RasterDocument } from './core.js';
import { AIWorkspace } from './workspaces.js';
import { AICommandSession } from './ai-tools.js';

/**
 * DOM-free editor runtime for Node.js, workers and automation hosts.
 *
 * The canonical document is created and inspected here, while all agent
 * mutations are routed into an isolated AIWorkspace. This module deliberately
 * has no filesystem, network, browser or export capabilities.
 */
export class HeadlessEditorRuntime {
  #document;
  #workspace;
  #commands;

  constructor({ width = 128, height = 128, name = 'Untitled artwork' } = {}) {
    this.#document = new RasterDocument(width, height, name);
    this.#workspace = new AIWorkspace(this.#document);
    this.#commands = new AICommandSession(this.#workspace);
  }

  get document() { return this.#document; }
  get sandbox() { return this.#workspace.sandbox; }
  get workspace() { return this.#workspace; }

  execute(action) {
    return this.#commands.execute(action);
  }

  inspect() {
    const source = this.#document;
    const sandbox = this.#workspace.sandbox;
    return {
      mode: 'headless',
      source: {
        id: source.id,
        name: source.name,
        width: source.width,
        height: source.height,
        revision: source.revision,
        layerCount: source.layers.length,
      },
      sandbox: {
        id: sandbox.id,
        width: sandbox.width,
        height: sandbox.height,
        revision: sandbox.revision,
        layerCount: sandbox.layers.length,
        hasChanges: this.#workspace.hasSandboxChanges,
      },
      proposal: this.#workspace.proposalSummary,
    };
  }

  createProposal(summary) {
    return this.#commands.createProposal(summary);
  }

  getDiff() {
    const diff = this.#workspace.getVisualDiff();
    return {
      width: diff.width,
      height: diff.height,
      changedPixels: diff.changedPixels,
      bounds: diff.bounds,
      pixels: diff.pixels,
    };
  }

  acceptProposal() {
    return this.#workspace.acceptProposal();
  }

  discardProposal() {
    return this.#workspace.discardProposal();
  }

  discardSandboxChanges() {
    return this.#workspace.discardSandboxChanges();
  }

  syncFromSource(options) {
    return this.#workspace.syncFromUser(options);
  }
}

export function createHeadlessRuntime(options) {
  return new HeadlessEditorRuntime(options);
}
