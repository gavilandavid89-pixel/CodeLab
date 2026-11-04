import { AICommandSession } from './ai-tools.js';
import { AIWorkspace } from './workspaces.js';

export const AI_ACTION_CONTRACT = Object.freeze([
  { name: 'document.get_summary', description: 'Read document dimensions and layer metadata.', parameters: {} },
  { name: 'canvas.get_reference', description: 'Read exact document-pixel origin, axes, bounds, landmarks, grid and active layer before drawing.', parameters: { gridStep: 'integer 1–256?' } },
  { name: 'canvas.get_pixel', description: 'Sample one pixel.', parameters: { x: 'integer', y: 'integer', merged: 'boolean?' } },
  { name: 'canvas.draw_line', description: 'Draw a raster line on the active sandbox layer.', parameters: { x0: 'integer', y0: 'integer', x1: 'integer', y1: 'integer', color: '#RRGGBB', size: 'integer 1–128?' } },
  { name: 'canvas.fill', description: 'Fill a connected or global color region.', parameters: { x: 'integer', y: 'integer', color: '#RRGGBB', tolerance: 'integer 0–255?', contiguous: 'boolean?' } },
  { name: 'canvas.clear_region', description: 'Clear a bounded rectangle.', parameters: { x: 'integer', y: 'integer', width: 'integer', height: 'integer' } },
  { name: 'canvas.replace_color', description: 'Replace matching colors on the active layer.', parameters: { from: '#RRGGBB', to: '#RRGGBB', tolerance: 'integer 0–255?' } },
  { name: 'canvas.transform_region', description: 'Move or quarter-turn rotate a region.', parameters: { x: 'integer', y: 'integer', width: 'integer', height: 'integer', dx: 'integer?', dy: 'integer?', rotate: '0|90|180|270?' } },
  { name: 'selection.create_rect', description: 'Create a rectangular selection mask.', parameters: { x: 'integer', y: 'integer', width: 'integer', height: 'integer' } },
  { name: 'selection.clear', description: 'Clear the current selection mask.', parameters: {} },
  { name: 'history.undo', description: 'Undo one sandbox edit.', parameters: {} },
  { name: 'history.redo', description: 'Redo one sandbox edit.', parameters: {} },
]);

const SYSTEM_PROMPT = [
  'You are an editing planner for a raster art editor. Return only a JSON object with exactly this shape: {"summary":"short explanation","actions":[{"name":"allowlisted.action","...":"arguments"}]}.',
  'Do not return Markdown, scripts, shell commands, URLs, or arbitrary code.',
  'Only use the allowlisted actions and their documented parameters. Coordinates are integer document pixels; the canvas origin is top-left. Use canvasReference bounds and landmarks, and sample existing colors when matching artwork.'
  'Prefer small, precise, undoable changes. Do not invent layers or dimensions. If the request cannot be performed with these actions, return {"summary":"Cannot safely perform this request with the available tools.","actions":[]}.',
  'Project/document deletion, project/content export, upload and publishing are forbidden. The original document is read-only; all edits are applied to an isolated sandbox.',
  'Available actions: ' + JSON.stringify(AI_ACTION_CONTRACT),
].join('\n');

function isPngDataUrl(value) {
  const prefix = 'data:image/png;base64,';
  return typeof value === 'string' && value.startsWith(prefix) &&
    /^[A-Za-z0-9+/=]+$/.test(value.slice(prefix.length));
}

function validatePlan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Provider response must be a JSON object.');
  if (typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 500) throw new TypeError('Plan summary must contain 1–500 characters.');
  if (!Array.isArray(value.actions) || value.actions.length > 16) throw new TypeError('Plan actions must be an array of at most 16 commands.');
  for (const action of value.actions) {
    if (!action || typeof action !== 'object' || Array.isArray(action) || typeof action.name !== 'string') {
      throw new TypeError('Every plan action must be a named structured command.');
    }
  }
  return { summary: value.summary.trim(), actions: value.actions };
}

function responseText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
  throw new TypeError('Provider response did not contain text.');
}

export class OpenAICompatibleProvider {
  constructor({ endpoint, model, apiKey = '', fetchImpl = globalThis.fetch } = {}) {
    if (typeof endpoint !== 'string' || !endpoint.trim()) throw new TypeError('Provider endpoint is required.');
    const url = new URL(endpoint);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new TypeError('Provider endpoint must be an HTTP(S) URL without embedded credentials.');
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new TypeError('Unencrypted HTTP is allowed only for localhost providers.');
    }
    if (typeof model !== 'string' || !model.trim() || model.length > 180) throw new TypeError('Model name must contain 1–180 characters.');
    if (typeof apiKey !== 'string' || apiKey.length > 4096) throw new TypeError('API key must be text of at most 4096 characters.');
    if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
    this.endpoint = url.href;
    this.model = model.trim();
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
  }

  #apiKey;
  #fetch;

  async generatePlan({ prompt, context, imageDataUrl, imageDataUrls, signal } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) throw new TypeError('Prompt must contain 1–4000 characters.');
    const images = imageDataUrls ?? (imageDataUrl ? [{ label: 'Artwork context', dataUrl: imageDataUrl }] : []);
    if (!Array.isArray(images) || images.length > 24) throw new RangeError('At most 24 visual references may be attached.');
    let imageBytes = 0;
    for (const image of images) {
      if (!image || typeof image.label !== 'string' || image.label.length > 180 || !isPngDataUrl(image.dataUrl)) {
        throw new TypeError('Every visual reference must have a label and PNG data URL.');
      }
      if (image.dataUrl.length > 8 * 1024 * 1024) throw new RangeError('Each visual reference must be no larger than 8 MiB.');
      imageBytes += image.dataUrl.length;
    }
    if (imageBytes > 16 * 1024 * 1024) throw new RangeError('Combined visual references exceed 16 MiB.');
    const serializedContext = JSON.stringify(context ?? {});
    if (serializedContext.length > 50000) throw new RangeError('Editor context exceeds the 50,000-character safety limit.');
    const userText = JSON.stringify({ request: prompt.trim(), editorContext: context ?? {} });
    const content = images.length
      ? [{ type: 'text', text: userText + '\nVisual references (in order): ' + images.map((image, index) => index + ': ' + image.label).join('; ') },
        ...images.map(image => ({ type: 'image_url', image_url: { url: image.dataUrl, detail: 'high' } }))]
      : userText;
    const headers = { 'Content-Type': 'application/json' };
    if (this.#apiKey) headers.Authorization = 'Bearer ' + this.#apiKey;
    const response = await this.#fetch(this.endpoint, {
      method: 'POST', headers, signal,
      body: JSON.stringify({
        model: this.model, temperature: 0.2, max_tokens: 1800,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content },
        ],
      }),
    });
    if (!response?.ok) throw new Error('Provider request failed (HTTP ' + (response?.status ?? 'unknown') + ').');
    const payload = await response.json();
    const text = responseText(payload?.choices?.[0]?.message?.content);
    if (text.length > 50000) throw new RangeError('Provider plan exceeds the 50,000-character safety limit.');
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { throw new TypeError('Provider must return a JSON plan; no edit was applied.'); }
    return validatePlan(parsed);
  }
}

export class AIEditCoordinator {
  constructor({ workspace, session, provider } = {}) {
    if (!(workspace instanceof AIWorkspace)) throw new TypeError('Expected an AIWorkspace.');
    if (!(session instanceof AICommandSession) || !session.isForWorkspace(workspace)) throw new TypeError('AICommandSession must target the same workspace.');
    if (!provider || typeof provider.generatePlan !== 'function') throw new TypeError('A provider with generatePlan() is required.');
    this.workspace = workspace;
    this.session = session;
    this.provider = provider;
  }

  async requestEdit(prompt, { includeArtwork = false, imageDataUrl, visionSnapshot, signal } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) return { status: 'rejected', reason: 'invalid-prompt' };
    if (this.workspace.hasProposal || this.workspace.hasSandboxChanges) return { status: 'rejected', reason: 'pending-sandbox-work' };
    if ((imageDataUrl !== undefined || visionSnapshot !== undefined) && !includeArtwork) return { status: 'rejected', reason: 'artwork-consent-required' };
    if (includeArtwork && !imageDataUrl && !visionSnapshot) return { status: 'rejected', reason: 'artwork-preview-required' };
    if (visionSnapshot && (!Array.isArray(visionSnapshot.images) || !visionSnapshot.context || visionSnapshot.images.length < 1 || visionSnapshot.images.length > 24)) return { status: 'rejected', reason: 'invalid-vision-snapshot' };
    const imageDataUrls = visionSnapshot?.images?.map(image => ({ label: image.label, dataUrl: image.dataUrl }));
    const baseRevision = this.workspace.baseRevision;
    if (this.workspace.sourceRevision !== baseRevision) {
      this.workspace.syncFromUser();
      return { status: 'rejected', reason: 'stale-source' };
    }
    const summaryResult = this.session.execute({ name: 'document.get_summary' });
    if (!summaryResult.ok) return { status: 'failed', reason: 'context-unavailable', error: summaryResult.error };
    const referenceResult = this.session.execute({ name: 'canvas.get_reference', gridStep: 8 });
    if (!referenceResult.ok) return { status: 'failed', reason: 'coordinate-reference-unavailable', error: referenceResult.error };
    let plan;
    try {
      plan = validatePlan(await this.provider.generatePlan({
        prompt: prompt.trim(),
        context: { document: summaryResult.result, canvasReference: referenceResult.result, availableActions: AI_ACTION_CONTRACT, ...(visionSnapshot ? { visualObservation: visionSnapshot.context } : {}) },
        ...(includeArtwork ? (visionSnapshot ? { imageDataUrls } : { imageDataUrl }) : {}),
        signal,
      }));
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') return { status: 'cancelled' };
      return { status: 'failed', reason: 'provider-error', message: error instanceof Error ? error.message : 'Provider request failed.' };
    }
    if (signal?.aborted) return { status: 'cancelled' };
    if (this.workspace.baseRevision !== baseRevision || this.workspace.sourceRevision !== baseRevision) {
      this.workspace.syncFromUser({ discardSandboxChanges: true });
      return { status: 'rejected', reason: 'stale-source' };
    }
    if (!plan.actions.length) return { status: 'rejected', reason: 'empty-plan', summary: plan.summary };
    const results = [];
    for (let index = 0; index < plan.actions.length; index++) {
      const result = this.session.execute(plan.actions[index]);
      results.push(result);
      if (!result.ok) {
        this.workspace.syncFromUser({ discardSandboxChanges: true });
        return { status: 'failed', reason: 'action-rejected', actionIndex: index, error: result.error };
      }
    }
    if (this.workspace.sourceRevision !== baseRevision || this.workspace.baseRevision !== baseRevision) {
      this.workspace.syncFromUser({ discardSandboxChanges: true });
      return { status: 'rejected', reason: 'stale-source' };
    }
    try {
      const proposal = this.session.createProposal(plan.summary);
      return { status: 'proposal', summary: plan.summary, proposal, actions: results };
    } catch (error) {
      this.workspace.syncFromUser({ discardSandboxChanges: true });
      return { status: 'failed', reason: 'proposal-create-failed', message: error instanceof Error ? error.message : 'Could not create proposal.' };
    }
  }
}
