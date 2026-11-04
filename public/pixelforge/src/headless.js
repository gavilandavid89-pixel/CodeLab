import { RasterDocument } from './core.js';
import { AIWorkspace } from './workspaces.js';
import { AICommandSession } from './ai-tools.js';
import { applyAnimationAction, summarizeAnimationTimeline, synchronizeAnimationLayers, validateAnimationTimeline } from './animation.js';

const MAX_ANIMATION_HISTORY_STEPS = 100;
const MAX_ANIMATION_HISTORY_BYTES = 16 * 1024 * 1024;

function remapAnimationLayerIds(timeline, targetLayerIds) {
  if (!Array.isArray(targetLayerIds) || targetLayerIds.length !== timeline.layerIds.length) {
    throw new TypeError('Animation layer identity mapping must preserve the complete layer stack.');
  }
  const mapping = new Map(timeline.layerIds.map((id, index) => [id, targetLayerIds[index]]));
  return {
    ...timeline,
    layerIds: [...targetLayerIds],
    frames: timeline.frames.map(frame => ({
      ...frame,
      cels: frame.cels.map(cel => ({ ...cel, layerId: mapping.get(cel.layerId) ?? cel.layerId })),
    })),
  };
}


function decodeCelPixels(value) {
  if (typeof value !== 'string') return null;
  const binary = atob(value);
  const pixels = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) pixels[index] = binary.charCodeAt(index);
  return pixels;
}

function compareCelPixels(before, after, width, height) {
  const previous = decodeCelPixels(before);
  const next = decodeCelPixels(after);
  const length = width * height * 4;
  if ((previous && previous.length !== length) || (next && next.length !== length)) {
    throw new RangeError('Animation cel dimensions do not match the project canvas.');
  }
  let changedPixels = 0, minX = width, minY = height, maxX = -1, maxY = -1;
  for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = pixel * 4;
    let changed = false;
    for (let channel = 0; channel < 4; channel++) {
      if ((previous?.[offset + channel] ?? 0) !== (next?.[offset + channel] ?? 0)) {
        changed = true;
        break;
      }
    }
    if (!changed) continue;
    const x = pixel % width, y = Math.floor(pixel / width);
    changedPixels++;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return {
    changedPixels,
    bounds: maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
  };
}

function diffAnimationTimelines(before, after) {
  const beforeFrames = new Map(before.frames.map((frame, index) => [frame.id, { frame, index }]));
  const afterFrames = new Map(after.frames.map((frame, index) => [frame.id, { frame, index }]));
  const frameIds = [...after.frames.map(frame => frame.id), ...before.frames.map(frame => frame.id).filter(id => !afterFrames.has(id))];
  const frames = [];
  let changedCelCount = 0, changedPixels = 0;
  for (const id of frameIds) {
    const previousEntry = beforeFrames.get(id), nextEntry = afterFrames.get(id);
    const previous = previousEntry?.frame, next = nextEntry?.frame;
    const layerIds = [...(next?.cels.map(cel => cel.layerId) ?? []), ...(previous?.cels.map(cel => cel.layerId) ?? []).filter(layerId => !next?.cels.some(cel => cel.layerId === layerId))];
    const cels = [];
    for (const layerId of layerIds) {
      const previousCel = previous?.cels.find(cel => cel.layerId === layerId);
      const nextCel = next?.cels.find(cel => cel.layerId === layerId);
      const previousPixels = previousCel?.pixels ?? null;
      const nextPixels = nextCel?.pixels ?? null;
      if (previousPixels === nextPixels && Boolean(previousCel) === Boolean(nextCel)) continue;
      const pixelDiff = compareCelPixels(previousPixels, nextPixels, after.width, after.height);
      cels.push({
        layerId,
        change: !previousCel ? 'added' : !nextCel ? 'removed' : 'updated',
        changedPixels: pixelDiff.changedPixels,
        bounds: pixelDiff.bounds,
      });
      changedPixels += pixelDiff.changedPixels;
    }
    const reordered = Boolean(previousEntry && nextEntry && previousEntry.index !== nextEntry.index);
    if (cels.length || reordered || !previousEntry || !nextEntry) {
      changedCelCount += cels.length;
      frames.push({
        id,
        name: next?.name ?? previous?.name ?? null,
        index: nextEntry?.index ?? previousEntry?.index ?? null,
        previousIndex: previousEntry?.index ?? null,
        change: !previousEntry ? 'added' : !nextEntry ? 'removed' : reordered && !cels.length ? 'reordered' : 'updated',
        reordered,
        cels,
      });
    }
  }
  return {
    changedFrameCount: frames.length,
    changedCelCount,
    changedPixels,
    reordered: before.frames.some((frame, index) => after.frames[index]?.id !== frame.id) || before.frames.length !== after.frames.length,
    frames,
  };
}

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
  #animationHistory = [];
  #animationFuture = [];
  #animationHistoryBytes = 0;
  #hasAnimation = false;

  constructor({ width = 128, height = 128, name = 'Untitled artwork', project = null } = {}) {
    this.#document = project === null
      ? new RasterDocument(width, height, name)
      : RasterDocument.fromJSON(project);
    this.#hasAnimation = Boolean(project?.animation);
    this.#animation = validateAnimationTimeline(project?.animation, this.#document.width, this.#document.height, this.#document.layers);
    this.#resetWorkspace();
  }

  #clearAnimationHistory() {
    this.#animationHistory = [];
    this.#animationFuture = [];
    this.#animationHistoryBytes = 0;
  }

  #pushAnimationHistory(stack, snapshot) {
    const bytes = JSON.stringify(snapshot).length;
    stack.push({ snapshot, bytes });
    this.#animationHistoryBytes += bytes;
    while (stack.length > MAX_ANIMATION_HISTORY_STEPS || this.#animationHistoryBytes > MAX_ANIMATION_HISTORY_BYTES) {
      const removed = stack.shift();
      if (!removed) break;
      this.#animationHistoryBytes -= removed.bytes;
    }
  }

  #clearAnimationFuture() {
    for (const entry of this.#animationFuture) this.#animationHistoryBytes -= entry.bytes;
    this.#animationFuture = [];
  }

  #committedAnimationForSandbox() {
    const sandboxIds = this.#workspace.mapSourceLayerIdsToSandbox(this.#animation.layerIds);
    const mapped = remapAnimationLayerIds(this.#animation, sandboxIds);
    return synchronizeAnimationLayers(mapped, this.#workspace.sandbox);
  }

  #animationDiffersFromCommitted() {
    return JSON.stringify(this.#sandboxAnimation) !== JSON.stringify(this.#committedAnimationForSandbox());
  }

  #resetWorkspace() {
    this.#workspace = new AIWorkspace(this.#document);
    this.#commands = new AICommandSession(this.#workspace);
    const sandboxLayerIds = this.#workspace.mapSourceLayerIdsToSandbox(this.#animation.layerIds);
    this.#sandboxAnimation = remapAnimationLayerIds(this.#animation, sandboxLayerIds);
    this.#animationDirty = false;
    this.#clearAnimationHistory();
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
        if (action.name === 'animation.undo') {
          if (!this.#animationHistory.length) return { ok: true, action: action.name, result: { changed: false } };
          const previous = this.#animationHistory.pop();
          this.#animationHistoryBytes -= previous.bytes;
          this.#pushAnimationHistory(this.#animationFuture, this.#sandboxAnimation);
          this.#sandboxAnimation = synchronizeAnimationLayers(previous.snapshot, this.#workspace.sandbox);
          this.#animationDirty = this.#animationDiffersFromCommitted();
          return { ok: true, action: action.name, result: { changed: true, summary: summarizeAnimationTimeline(this.#sandboxAnimation) } };
        }
        if (action.name === 'animation.redo') {
          if (!this.#animationFuture.length) return { ok: true, action: action.name, result: { changed: false } };
          const next = this.#animationFuture.pop();
          this.#animationHistoryBytes -= next.bytes;
          this.#pushAnimationHistory(this.#animationHistory, this.#sandboxAnimation);
          this.#sandboxAnimation = synchronizeAnimationLayers(next.snapshot, this.#workspace.sandbox);
          this.#animationDirty = this.#animationDiffersFromCommitted();
          return { ok: true, action: action.name, result: { changed: true, summary: summarizeAnimationTimeline(this.#sandboxAnimation) } };
        }
        const before = JSON.parse(JSON.stringify(this.#sandboxAnimation));
        const outcome = applyAnimationAction(this.#sandboxAnimation, this.#workspace.sandbox, action);
        const changed = JSON.stringify(before) !== JSON.stringify(outcome.timeline);
        if (changed) {
          this.#clearAnimationFuture();
          this.#pushAnimationHistory(this.#animationHistory, before);
        }
        this.#sandboxAnimation = outcome.timeline;
        this.#animationDirty = this.#animationDiffersFromCommitted();
        return { ok: true, action: action.name, result: { ...outcome.result, changed } };
      } catch (error) {
        return { ok: false, action: action.name, error: {
          code: error instanceof RangeError ? 'out_of_bounds_or_limit' : error instanceof TypeError ? 'invalid_arguments' : 'operation_failed',
          message: error instanceof Error ? error.message : 'Animation operation failed.',
        } };
      }
    }
    if (action?.name === 'canvas.crop' && this.#sandboxAnimation.frames.length) {
      return {
        ok: false,
        action: action.name,
        error: {
          code: 'animation_dimension_change_requires_frame_transform',
          message: 'Cropping an animated project requires applying the same crop to every frame cel. This operation is blocked rather than leaving frame dimensions inconsistent.',
        },
      };
    }
    const commandResult = this.#commands.execute(action);
    if (commandResult.ok) {
      const before = JSON.stringify(this.#sandboxAnimation);
      const synchronized = synchronizeAnimationLayers(this.#sandboxAnimation, this.#workspace.sandbox);
      if (JSON.stringify(synchronized) !== before) {
        this.#sandboxAnimation = synchronized;
        this.#animationDirty = this.#animationDiffersFromCommitted();
      }
    }
    return commandResult;
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
      animation: { ...summarizeAnimationTimeline(this.#sandboxAnimation), hasChanges: this.#animationDirty },
    };
  }

  createProposal(summary) {
    if (!this.hasPendingChanges) throw new Error('There are no sandbox or animation changes to propose.');
    return this.#commands.createProposal(summary);
  }

  getDiff() {
    const raster = this.#workspace.getVisualDiff();
    const committedAnimation = this.#committedAnimationForSandbox();
    const animation = diffAnimationTimelines(committedAnimation, this.#sandboxAnimation);
    return {
      width: raster.width,
      height: raster.height,
      changedPixels: raster.changedPixels + animation.changedPixels,
      rasterChangedPixels: raster.changedPixels,
      animationChangedPixels: animation.changedPixels,
      bounds: raster.bounds,
      pixels: raster.pixels,
      animation,
    };
  }

  acceptProposal() {
    const hadRasterChanges = this.#workspace.hasSandboxChanges;
    const hadAnimationChanges = this.#animationDirty;
    const committedAnimation = remapAnimationLayerIds(
      this.#sandboxAnimation,
      this.#workspace.mapSandboxLayerIdsToSource(this.#sandboxAnimation.layerIds),
    );
    const result = this.#workspace.acceptProposal();
    if (result.status === 'applied') {
      this.#animation = committedAnimation;
      if (hadAnimationChanges && this.#animation.frames.length) this.#hasAnimation = true;
      const nextSandboxLayerIds = this.#workspace.mapSourceLayerIdsToSandbox(this.#animation.layerIds);
      this.#sandboxAnimation = remapAnimationLayerIds(this.#animation, nextSandboxLayerIds);
      this.#animationDirty = false;
      this.#clearAnimationHistory();
      if (!hadRasterChanges && hadAnimationChanges) {
        this.#document.revision++;
        this.#document.saveVersion++;
      }
      if (hadRasterChanges || hadAnimationChanges) this.#document.dirty = true;
    }
    return result;
  }

  discardProposal() {
    const hadAnimationChanges = this.#animationDirty;
    const discarded = this.#workspace.discardProposal();
    this.#sandboxAnimation = remapAnimationLayerIds(this.#animation, this.#workspace.mapSourceLayerIdsToSandbox(this.#animation.layerIds));
    this.#animationDirty = false;
    this.#clearAnimationHistory();
    return discarded || hadAnimationChanges;
  }
  discardSandboxChanges() {
    const hadAnimationChanges = this.#animationDirty;
    const discarded = this.#workspace.discardSandboxChanges();
    this.#sandboxAnimation = remapAnimationLayerIds(this.#animation, this.#workspace.mapSourceLayerIdsToSandbox(this.#animation.layerIds));
    this.#animationDirty = false;
    this.#clearAnimationHistory();
    return discarded || hadAnimationChanges;
  }
  syncFromSource(options) {
    const result = this.#workspace.syncFromUser(options);
    if (result.status === 'synced') {
      this.#sandboxAnimation = remapAnimationLayerIds(this.#animation, this.#workspace.mapSourceLayerIdsToSandbox(this.#animation.layerIds));
      this.#animationDirty = false;
      this.#clearAnimationHistory();
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
