import { HeadlessEditorRuntime } from './headless.js';

const sessions = new Map();
const SESSION_TTL_MS = 10 * 60 * 1000;

function assertProjectId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) {
    throw new TypeError('A valid PixelForge project ID is required.');
  }
  return value;
}

function cleanExpiredSessions(now = Date.now()) {
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(id);
  }
}

async function readJson(response, label) {
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error(label + ' returned an invalid response.'); }
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.error || (label + ' failed with HTTP ' + response.status));
    error.status = response.status;
    error.code = payload?.error || 'headless_request_failed';
    error.revision = payload?.revision;
    throw error;
  }
  return payload;
}

function diffPreviewDataUrl(runtime) {
  const diff = runtime.getDiff();
  if (!diff.changedPixels) return null;
  const canvas = document.createElement('canvas');
  canvas.width = diff.width;
  canvas.height = diff.height;
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) throw new Error('Could not create a proposal preview surface.');
  context.putImageData(new ImageData(new Uint8ClampedArray(diff.pixels), diff.width, diff.height), 0, 0);
  return canvas.toDataURL('image/png');
}

/**
 * Load a project through CodeLab's same-origin authenticated API, run actions
 * in an isolated PixelForge sandbox, and hold the proposal for explicit review.
 */
export async function preparePixelForgeProposal({ projectId, actions, summary, fetcher = fetch } = {}) {
  cleanExpiredSessions();
  projectId = assertProjectId(projectId);
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 500) {
    throw new RangeError('A proposal must contain between 1 and 500 actions.');
  }
  if (typeof summary !== 'string' || !summary.trim() || summary.length > 500) {
    throw new TypeError('A short proposal summary is required.');
  }
  const loaded = await readJson(await fetcher('/api/pixelforge/projects/' + encodeURIComponent(projectId), {
    method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' },
  }), 'PixelForge project load');
  if (!loaded.project || loaded.project.id !== projectId) throw new Error('The authenticated API returned a different project.');
  const runtime = HeadlessEditorRuntime.fromJSON(loaded.project);
  const batch = runtime.executeBatch(actions);
  if (!batch.ok) {
    return { status: 'rejected', projectId, failedIndex: batch.failedIndex, results: batch.results, error: batch.error };
  }
  const proposal = runtime.createProposal(summary);
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, { runtime, projectId, fetcher, expiresAt: Date.now() + SESSION_TTL_MS });
  return {
    status: 'proposal',
    sessionId,
    projectId,
    proposal,
    results: batch.results,
    inspection: runtime.inspect(),
    diff: { changedPixels: runtime.getDiff().changedPixels, previewDataUrl: diffPreviewDataUrl(runtime) },
    expiresInMs: SESSION_TTL_MS,
  };
}

/**
 * Persist only after the caller explicitly confirms approval. The server's
 * serverRevision token remains the final concurrency guard; conflicts are
 * returned without overwriting or silently retrying another user's work.
 */
export async function acceptPixelForgeProposal({ sessionId, approved = false } = {}) {
  cleanExpiredSessions();
  if (approved !== true) throw new Error('Explicit approved:true is required to persist a PixelForge proposal.');
  const session = sessions.get(sessionId);
  if (!session) throw new Error('The PixelForge proposal session is missing or expired.');
  const accepted = session.runtime.acceptProposal();
  if (accepted.status !== 'applied') {
    sessions.delete(sessionId);
    return { status: 'rejected', projectId: session.projectId, result: accepted };
  }
  const project = session.runtime.toJSON();
  let response;
  try {
    response = await session.fetcher('/api/pixelforge/projects/' + encodeURIComponent(session.projectId), {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ project }),
    });
    const saved = await readJson(response, 'PixelForge project save');
    if (!Number.isInteger(saved?.project?.serverRevision)) throw new Error('PixelForge save did not return a valid server revision.');
    session.runtime.document.serverRevision = saved.project.serverRevision;
    sessions.delete(sessionId);
    return {
      status: 'saved',
      projectId: session.projectId,
      serverRevision: saved.project.serverRevision,
      result: accepted,
      inspection: session.runtime.inspect(),
    };
  } catch (error) {
    if (error.status === 409) sessions.delete(sessionId);
    throw error;
  }
}

export function discardPixelForgeProposal({ sessionId } = {}) {
  const session = sessions.get(sessionId);
  if (!session) return { discarded: false, reason: 'missing-or-expired' };
  session.runtime.discardProposal();
  sessions.delete(sessionId);
  return { discarded: true, projectId: session.projectId };
}

export function inspectPixelForgeProposal({ sessionId } = {}) {
  cleanExpiredSessions();
  const session = sessions.get(sessionId);
  if (!session) return null;
  return { projectId: session.projectId, inspection: session.runtime.inspect(), expiresAt: session.expiresAt };
}
