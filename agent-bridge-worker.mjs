import { createRequire } from 'node:module';
import { randomBytes, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { HeadlessEditorRuntime } from './public/pixelforge/src/headless.js';
import chromium from '@sparticuz/chromium';
import { chromium as playwrightChromium } from 'playwright-core';
import { createVisionSnapshot } from './public/pixelforge/src/headless-vision.js';
import { executeCodeLabBrowserActions } from './native-headless-browser.mjs';
import { importCodeLabArtifact } from './codelab-project-artifact-import.mjs';
import { exportPixelForgeAnimationVideo as exportPixelForgeAnimationVideoComposer } from './pixelforge-video-composer-export.mjs';
import { createPixelForgeProjectZip, parsePixelForgeProjectZip } from './pixelforge-agent-zip.mjs';
import { controlPixelForgeVideoComposer } from './pixelforge-video-composer-control.mjs';
import { ensureNativeArtifactSchema, stageNativeArtifact, readNativeArtifact, deleteNativeArtifact } from './native-agent-artifacts.mjs';

const require = createRequire(import.meta.url);
const { Pool, Client } = require('pg');
const neonEvidence = require('./neon-pixelforge-evidence.js');
const os = require('node:os');
const DATABASE_URL = process.env.DATABASE_URL || '';
if (!DATABASE_URL) throw new Error('DATABASE_URL is required for the CodeLab native agent bridge.');

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.CODELAB_DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false },
  max: 2,
  idleTimeoutMillis: 15000,
  connectionTimeoutMillis: 10000,
});
const MAX_PROJECT_BYTES = 96 * 1024 * 1024;
const MAX_ACCOUNT_BYTES = 512 * 1024 * 1024;
const MAX_PROJECTS = 50;
// PostgreSQL notifications wake the worker only when a queued command commits.
let wakeClient = null;
let wakeVersion = 0;
let wakeWaiter = null;

function signalCommandWake() {
  wakeVersion += 1;
  if (wakeWaiter) {
    const resolve = wakeWaiter;
    wakeWaiter = null;
    resolve();
  }
}

function directDatabaseUrl() {
  const url = new URL(DATABASE_URL);
  if (url.hostname.includes('-pooler.')) url.hostname = url.hostname.replace('-pooler.', '.');
  return url.toString();
}

async function connectCommandWakeListener() {
  if (wakeClient || stopping) return;
  const client = new Client({
    connectionString: directDatabaseUrl(),
    ssl: process.env.CODELAB_DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false },
    application_name: 'codelab-agent-bridge-command-listener',
  });
  client.on('notification', message => {
    if (message.channel === 'codelab_agent_bridge_wake') signalCommandWake();
  });
  client.on('error', error => {
    console.error('[CodeLab Native Bridge] command wake listener error:', error.message);
    if (wakeClient === client) wakeClient = null;
    signalCommandWake();
    void client.end().catch(() => {});
  });
  await client.connect();
  await client.query('LISTEN codelab_agent_bridge_wake');
  wakeClient = client;
  console.log('[CodeLab Native Bridge] command listener armed; idle polling disabled.');
}

async function waitForCommandWake(observedVersion) {
  if (wakeVersion !== observedVersion) return;
  if (!wakeClient) {
    await delay(5000);
    if (!stopping) {
      try {
        await connectCommandWakeListener();
        // Reconcile durable queue state after reconnecting, including notifications
        // that may have been missed while the listener was disconnected.
        signalCommandWake();
      } catch (error) {
        console.error('[CodeLab Native Bridge] command listener reconnect failed:', error.message);
      }
    }
    return;
  }
  await new Promise(resolve => {
    if (wakeVersion !== observedVersion || stopping) {
      resolve();
      return;
    }
    wakeWaiter = resolve;
  });
}
const PROPOSAL_TTL_MS = 15 * 60 * 1000;
const NATIVE_VALIDATION_ENABLED = String(process.env.CODELAB_NATIVE_VALIDATION_ENABLED || 'true').toLowerCase() !== 'false';
let stopping = false;
let shutdownSignalPromise = null;
let workspaceId;
let pixelForgeWorkspaceId = 'ws_pixelforge_guest';

async function ensureBridgeSignalSchema() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS public.codelab_agent_bridge_state (
      state_id text PRIMARY KEY,
      workspace_id text NOT NULL,
      state text NOT NULL CHECK (state IN ('starting','running','sleeping','stopping','error')),
      wake_required boolean NOT NULL DEFAULT false,
      wake_reason text,
      signal_version bigint NOT NULL DEFAULT 0,
      last_signal_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    )`
  );
}

async function writeBridgeSignal(state, { wakeRequired, reason, metadata = {} } = {}) {
  if (!workspaceId) return null;
  await ensureBridgeSignalSchema();
  const result = await pool.query(
    `INSERT INTO public.codelab_agent_bridge_state
      (state_id, workspace_id, state, wake_required, wake_reason, signal_version, last_signal_at, updated_at, metadata)
     VALUES ($1,$2,$3,$4,$5,1,now(),now(),$6::jsonb)
     ON CONFLICT (state_id) DO UPDATE SET
       workspace_id=EXCLUDED.workspace_id,
       state=EXCLUDED.state,
       wake_required=EXCLUDED.wake_required,
       wake_reason=EXCLUDED.wake_reason,
       signal_version=codelab_agent_bridge_state.signal_version+1,
       last_signal_at=now(),
       updated_at=now(),
       metadata=EXCLUDED.metadata
     RETURNING state_id, workspace_id, state, wake_required, wake_reason, signal_version, last_signal_at, updated_at, metadata`,
    ['native-bridge:' + workspaceId, workspaceId, state, !!wakeRequired, reason || null, JSON.stringify(metadata)]
  );
  return result.rows[0] || null;
}

async function emitShutdownSignal(reason = 'shutdown') {
  if (shutdownSignalPromise) return shutdownSignalPromise;
  shutdownSignalPromise = (async () => {
    try {
      const signal = await writeBridgeSignal('sleeping', {
        wakeRequired: true,
        reason,
        metadata: { pid: process.pid, hostname: os.hostname(), source: 'agent-bridge-worker' }
      });
      console.log('[CodeLab Native Bridge] final Neon shutdown signal emitted:', {
        workspaceId: signal?.workspace_id,
        wakeRequired: signal?.wake_required,
        signalVersion: signal?.signal_version,
        reason: signal?.wake_reason
      });
    } catch (error) {
      console.error('[CodeLab Native Bridge] final Neon shutdown signal failed:', error.message);
    }
  })();
  return shutdownSignalPromise;
}

const NEON_FUNCTIONS_URL = String(process.env.NEON_FUNCTIONS_URL || '').trim();
const NEON_FUNCTIONS_EXEC_SECRET = String(process.env.NEON_FUNCTIONS_EXEC_SECRET || '');
async function invokeNeonFunction(payload = {}) {
  if (String(process.env.NEON_FUNCTIONS_ENABLED || '').toLowerCase() !== 'true') throw new Error('Neon Functions execution is disabled.');
  if (!NEON_FUNCTIONS_URL || !NEON_FUNCTIONS_EXEC_SECRET) throw new Error('NEON_FUNCTIONS_URL and NEON_FUNCTIONS_EXEC_SECRET are required.');
  const target = new URL(NEON_FUNCTIONS_URL);
  if (target.protocol !== 'https:' || target.hostname !== 'br-misty-sea-b5qkh03f-codelabfn.compute.c-7.us-east-2.aws.neon.tech' || target.pathname !== '/') throw new Error('Neon Function target is not in the approved CodeLab allowlist.');
  if (payload.function !== 'codelabfn' || payload.operation !== 'health') throw new Error('Only the approved codelabfn health operation is currently enabled.');
  const response = await fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-secret': NEON_FUNCTIONS_EXEC_SECRET },
    body: JSON.stringify({ operation: payload.operation }),
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) throw new Error('Neon Function invocation failed with HTTP ' + response.status + '.');
  return { function: 'codelabfn', operation: 'health', result: data };
}

function safeJson(value) {
  return JSON.parse(JSON.stringify(value));
}
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && aa.length > 0 && timingSafeEqual(aa, bb);
}
function compactInspection(inspection) {
  return {
    ...inspection,
    capabilities: {
      protocol: inspection.capabilities.protocol,
      maxBatchActions: inspection.capabilities.maxBatchActions,
      maxLayers: inspection.capabilities.maxLayers,
      maxFrames: inspection.capabilities.maxFrames,
      proposalApprovalRequired: true,
      authenticatedPersistence: true,
    },
  };
}
async function resolveAdminWorkspace() {
  const result = await pool.query(
    "SELECT id FROM codelab_accounts WHERE username = 'ADMIN' AND role = 'admin' LIMIT 1"
  );
  if (!result.rowCount) throw new Error('CodeLab ADMIN account is not configured.');
  return 'ws_local_' + String(result.rows[0].id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
}
async function claimCommand() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "UPDATE codelab_agent_commands SET status='expired', result=COALESCE(result, '{\"error\":\"command_expired\"}'::jsonb), finished_at=now(), updated_at=now() WHERE workspace_id=$1 AND status='queued' AND expires_at <= now()",
      [workspaceId]
    );
    await client.query(
      `UPDATE codelab_agent_commands SET status='queued', started_at=NULL, expires_at=now() + interval '15 minutes', updated_at=now() WHERE workspace_id=$1 AND status='running' AND action <> 'codelab_validate' AND updated_at < now() - CASE WHEN action = 'pixelforge_export_animation_video' THEN interval '10 minutes' ELSE interval '3 minutes' END AND expires_at > now()`,
      [workspaceId]
    );
    const selected = await client.query(
      "SELECT command_id, workspace_id, action, payload, expires_at FROM codelab_agent_commands WHERE status='queued' AND expires_at > now() AND workspace_id=$1 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",
      [workspaceId]
    );
    if (!selected.rowCount) {
      await client.query('COMMIT');
      return null;
    }
    const command = selected.rows[0];
    await client.query(
      "UPDATE codelab_agent_commands SET status='running', started_at=now(), updated_at=now() WHERE command_id=$1",
      [command.command_id]
    );
    await client.query('COMMIT');
    return command;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}
async function finish(commandId, status, result, proposal = null, token = null) {
  await pool.query(
    'UPDATE codelab_agent_commands SET status=$2, result=$3::jsonb, proposal=$4::jsonb, proposal_token=$5, finished_at=CASE WHEN $2 IN (\'succeeded\',\'rejected\',\'failed\',\'expired\') THEN now() ELSE NULL END, updated_at=now() WHERE command_id=$1',
    [commandId, status, JSON.stringify(result ?? null), proposal === null ? null : JSON.stringify(proposal), token]
  );
  await writeBridgeSignal(status === 'failed' ? 'error' : 'running', {
    wakeRequired: false,
    reason: 'command_' + status,
    metadata: {
      pid: process.pid,
      hostname: os.hostname(),
      source: 'agent-bridge-worker',
      commandId,
      commandStatus: status,
      resultSummary: result && typeof result === 'object' ? {
        error: result.error || null,
        message: result.message || null,
        projectId: result.projectId || result.project_id || null,
        revision: result.revision ?? result.serverRevision ?? null,
        evidenceEventId: result.eventId || result.evidence?.eventId || null
      } : null,
      commandFinishedAt: new Date().toISOString()
    }
  });
}
function targetPixelForgeWorkspace(payload = {}) {
  const target = typeof payload.target_workspace_id === 'string' && payload.target_workspace_id.trim()
    ? payload.target_workspace_id.trim()
    : pixelForgeWorkspaceId;
  if (!/^ws_[a-zA-Z0-9_-]{1,140}$/.test(target)) throw new Error('Invalid target PixelForge workspace.');
  return target;
}
async function loadProject(projectId, targetWorkspace = pixelForgeWorkspaceId) {
  const result = await pool.query(
    'SELECT project, server_revision, content_sha256 FROM codelab_pixelforge_projects WHERE workspace_id=$1 AND project_id=$2',
    [targetWorkspace, projectId]
  );
  if (!result.rowCount) throw new Error('PixelForge project not found in the target workspace.');
  return {
    project: result.rows[0].project,
    serverRevision: Number(result.rows[0].server_revision || 0),
    contentSha256: result.rows[0].content_sha256,
  };
}
async function createProject(payload) {
  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  const width = payload.width === undefined ? 128 : payload.width;
  const height = payload.height === undefined ? 128 : payload.height;
  if (!name || name.length > 100) throw new Error('Project name must contain 1–100 characters.');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16 || width > 1024 || height > 1024 || width * height > 262144) {
    throw new Error('Canvas dimensions must be integers from 16 to 1024 with at most 262144 pixels.');
  }
  const runtime = new HeadlessEditorRuntime({ width, height, name });
  const document = { ...runtime.toJSON(), serverRevision: 1 };
  const serialized = JSON.stringify(document);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_PROJECT_BYTES) throw new Error('New project exceeds the PixelForge project storage limit.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [pixelForgeWorkspaceId]);
    const usage = await client.query(
      'SELECT COUNT(*)::int AS count, COALESCE(SUM(byte_size),0)::bigint AS bytes FROM codelab_pixelforge_projects WHERE workspace_id=$1',
      [pixelForgeWorkspaceId]
    );
    if (Number(usage.rows[0].count) >= MAX_PROJECTS) throw new Error('PixelForge project limit reached.');
    if (Number(usage.rows[0].bytes) + bytes > MAX_ACCOUNT_BYTES) throw new Error('PixelForge account storage limit reached.');
    const now = Date.now();
    const sha = createHash('sha256').update(serialized).digest('hex');
    await client.query(
      'INSERT INTO codelab_pixelforge_projects (workspace_id,project_id,name,width,height,updated_at,last_opened_at,project,byte_size,server_revision,content_sha256) VALUES ($1,$2,$3,$4,$5,$6,$6,$7::jsonb,$8,1,$9)',
      [pixelForgeWorkspaceId, document.id, document.name, document.width, document.height, now, serialized, bytes, sha]
    );
    await client.query('COMMIT');
    return {
      projectId: document.id, name: document.name, width, height,
      serverRevision: 1, byteSize: bytes, contentSha256: sha,
      inspection: compactInspection(HeadlessEditorRuntime.fromJSON(document).inspect()),
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function persistImportedPixelForgeProject(sourceProject) {
  const runtime = HeadlessEditorRuntime.fromJSON(sourceProject);
  const document = { ...runtime.toJSON(), serverRevision: 1 };
  const serialized = JSON.stringify(document);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_PROJECT_BYTES) throw new Error('Imported PixelForge project exceeds the 96 MiB storage limit.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [pixelForgeWorkspaceId]);
    const usage = await client.query(
      'SELECT COUNT(*)::int AS count, COALESCE(SUM(byte_size),0)::bigint AS bytes FROM codelab_pixelforge_projects WHERE workspace_id=$1',
      [pixelForgeWorkspaceId]
    );
    if (Number(usage.rows[0].count) >= MAX_PROJECTS) throw new Error('PixelForge project limit reached.');
    if (Number(usage.rows[0].bytes) + bytes > MAX_ACCOUNT_BYTES) throw new Error('PixelForge account storage limit reached.');
    const now = Date.now();
    const sha = createHash('sha256').update(serialized).digest('hex');
    await client.query(
      'INSERT INTO codelab_pixelforge_projects (workspace_id,project_id,name,width,height,updated_at,last_opened_at,project,byte_size,server_revision,content_sha256) VALUES ($1,$2,$3,$4,$5,$6,$6,$7::jsonb,$8,1,$9)',
      [pixelForgeWorkspaceId, document.id, document.name, document.width, document.height, now, serialized, bytes, sha]
    );
    await client.query('COMMIT');
    return {
      projectId: document.id, name: document.name, width: document.width, height: document.height,
      serverRevision: 1, byteSize: bytes, contentSha256: sha,
      inspection: compactInspection(HeadlessEditorRuntime.fromJSON(document).inspect())
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function listProjects() {
  const result = await pool.query(
    'SELECT project_id AS id, name, width, height, updated_at AS "updatedAt", last_opened_at AS "lastOpenedAt", server_revision AS "serverRevision" FROM codelab_pixelforge_projects WHERE workspace_id=$1 ORDER BY last_opened_at DESC',
    [pixelForgeWorkspaceId]
  );
  return { workspaceId: pixelForgeWorkspaceId, count: result.rowCount, projects: result.rows };
}
function assertProjectId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) {
    throw new Error('A valid PixelForge project_id is required.');
  }
}

function normalizeHeadlessProposalActions(actions) {
  return actions.map(source => {
    const action = JSON.parse(JSON.stringify(source));
    if (!action || typeof action.name !== 'string') return action;
    if (action.name === 'vector.object.create' && action.object && typeof action.object === 'object') {
      const rootId = typeof action.object.id === 'string' && action.object.id
        ? action.object.id : randomBytes(16).toString('hex');
      action.object.id = rootId;
      let index = 0;
      const assign = object => {
        if (!object.id) object.id = rootId + '-' + index;
        index++;
        if (object.type === 'group') for (const child of object.children || []) assign(child);
      };
      assign(action.object);
    } else if (action.name === 'vector.object.duplicate' && !action.new_id) {
      action.new_id = randomBytes(16).toString('hex');
    } else if (action.name === 'vector.group.create' && !action.group_id) {
      action.group_id = randomBytes(16).toString('hex');
    } else if (action.name === 'vector.svg.import' && !action.id_prefix) {
      action.id_prefix = randomBytes(16).toString('hex');
    }
    return action;
  });
}

async function handleProposal(command) {
  const payload = command.payload || {};
  assertProjectId(payload.project_id);
  if (!Array.isArray(payload.actions) || payload.actions.length < 1 || payload.actions.length > 500) {
    throw new Error('A proposal must contain 1–500 structured actions.');
  }
  if (typeof payload.summary !== 'string' || !payload.summary.trim() || payload.summary.length > 500) {
    throw new Error('A short proposal summary is required.');
  }
  const loaded = await loadProject(payload.project_id);
  const normalizedActions = normalizeHeadlessProposalActions(payload.actions);
  const runtime = HeadlessEditorRuntime.fromJSON(loaded.project);
  const batch = runtime.executeBatch(normalizedActions);
  if (!batch.ok) throw new Error('Headless batch failed at action ' + batch.failedIndex + ': ' + (batch.error?.message || 'unknown error'));
  if (!runtime.hasPendingChanges) throw new Error('The proposed batch did not change the project.');
  const proposalInfo = runtime.createProposal(payload.summary.trim());
  const diff = runtime.getDiff();
  const inspection = compactInspection(runtime.inspect());
  const proposalToken = randomBytes(32).toString('hex');
  const proposal = {
    projectId: payload.project_id,
    baseServerRevision: loaded.serverRevision,
    actions: normalizedActions,
    summary: payload.summary.trim(),
    proposalInfo,
    diff: {
      width: diff.width, height: diff.height,
      changedPixels: diff.changedPixels,
      rasterChangedPixels: diff.rasterChangedPixels,
      animationChangedPixels: diff.animationChangedPixels,
      bounds: diff.bounds,
      animation: diff.animation,
      vector: diff.vector,
    },
    inspection,
    expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS).toISOString(),
  };
  await finish(command.command_id, 'awaiting_approval', {
    status: 'awaiting_approval',
    commandId: command.command_id,
    proposalToken,
    proposal,
    message: 'Proposal is isolated. Nothing has been written to the saved project.',
  }, proposal, proposalToken);
}
async function saveApprovedProject(projectId, expectedRevision, document) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [pixelForgeWorkspaceId]);
    const current = await client.query(
      'SELECT server_revision FROM codelab_pixelforge_projects WHERE workspace_id=$1 AND project_id=$2 FOR UPDATE',
      [pixelForgeWorkspaceId, projectId]
    );
    if (!current.rowCount || Number(current.rows[0].server_revision || 0) !== expectedRevision) {
      throw new Error('Revision conflict: saved project changed after the proposal was prepared.');
    }
    const usage = await client.query(
      'SELECT COUNT(*)::int AS count, COALESCE(SUM(byte_size),0)::bigint AS bytes FROM codelab_pixelforge_projects WHERE workspace_id=$1',
      [pixelForgeWorkspaceId]
    );
    const stored = { ...document, serverRevision: expectedRevision + 1 };
    const serialized = JSON.stringify(stored);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > MAX_PROJECT_BYTES) throw new Error('Project exceeds the PixelForge project storage limit.');
    if (Number(usage.rows[0].bytes) - 0 + bytes > MAX_ACCOUNT_BYTES) {
      const prior = await client.query(
        'SELECT byte_size FROM codelab_pixelforge_projects WHERE workspace_id=$1 AND project_id=$2',
        [pixelForgeWorkspaceId, projectId]
      );
      if (Number(usage.rows[0].bytes) - Number(prior.rows[0].byte_size) + bytes > MAX_ACCOUNT_BYTES) {
        throw new Error('PixelForge account storage limit reached.');
      }
    }
    const sha = createHash('sha256').update(serialized).digest('hex');
    const now = Date.now();
    await client.query(
      'UPDATE codelab_pixelforge_projects SET name=$3,width=$4,height=$5,updated_at=$6,last_opened_at=$6,project=$7::jsonb,byte_size=$8,server_revision=$9,content_sha256=$10 WHERE workspace_id=$1 AND project_id=$2',
      [pixelForgeWorkspaceId, projectId, stored.name, stored.width, stored.height, now, serialized, bytes, expectedRevision + 1, sha]
    );
    await client.query('COMMIT');
    return { serverRevision: expectedRevision + 1, contentSha256: sha, byteSize: bytes };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}
async function approveProposal(command) {
  const payload = command.payload || {};
  if (typeof payload.proposal_command_id !== 'string' || typeof payload.proposal_token !== 'string') {
    throw new Error('proposal_command_id and proposal_token are required for approval.');
  }
  const proposalRow = await pool.query(
    "SELECT status, proposal, proposal_token, expires_at FROM codelab_agent_commands WHERE command_id=$1 AND workspace_id=$2",
    [payload.proposal_command_id, workspaceId]
  );
  if (!proposalRow.rowCount || proposalRow.rows[0].status !== 'awaiting_approval') {
    throw new Error('Proposal is missing, expired, already used, or not awaiting approval.');
  }
  const savedProposal = proposalRow.rows[0].proposal;
  if (!sameToken(payload.proposal_token, proposalRow.rows[0].proposal_token)) throw new Error('Proposal approval token is invalid.');
  if (new Date(proposalRow.rows[0].expires_at).getTime() < Date.now() ||
      new Date(savedProposal.expiresAt).getTime() < Date.now()) {
    await pool.query("UPDATE codelab_agent_commands SET status='expired',updated_at=now(),finished_at=now() WHERE command_id=$1", [payload.proposal_command_id]);
    throw new Error('Proposal expired before approval.');
  }
  const loaded = await loadProject(savedProposal.projectId);
  if (loaded.serverRevision !== Number(savedProposal.baseServerRevision)) {
    throw new Error('Revision conflict: project changed after proposal review.');
  }
  const runtime = HeadlessEditorRuntime.fromJSON(loaded.project);
  const batch = runtime.executeBatch(savedProposal.actions);
  if (!batch.ok) throw new Error('Approved batch could not be reproduced: ' + (batch.error?.message || 'unknown error'));
  runtime.createProposal(savedProposal.summary);
  const accepted = runtime.acceptProposal();
  if (accepted?.status !== 'applied') throw new Error('Headless proposal was not accepted by the runtime.');
  const document = runtime.toJSON();
  const saved = await saveApprovedProject(savedProposal.projectId, loaded.serverRevision, document);
  await pool.query(
    "UPDATE codelab_agent_commands SET status='succeeded',updated_at=now(),finished_at=now(),proposal_token=NULL WHERE command_id=$1",
    [payload.proposal_command_id]
  );
  return {
    status: 'saved',
    projectId: savedProposal.projectId,
    serverRevision: saved.serverRevision,
    contentSha256: saved.contentSha256,
    inspection: compactInspection(HeadlessEditorRuntime.fromJSON({ ...document, serverRevision: saved.serverRevision }).inspect()),
    diff: savedProposal.diff,
  };
}

function workspaceTokenFor(id) {
  let secret = String(process.env.CODELAB_WORKSPACE_SECRET || '').trim();
  if (!secret) {
    const dataDir = process.env.CODELAB_DATA_DIR || path.join(process.cwd(), 'data');
    try { secret = fs.readFileSync(path.join(dataDir, '.workspace-secret'), 'utf8').trim(); } catch {}
  }
  if (!secret) throw new Error('CodeLab workspace signing secret is unavailable to the native bridge.');
  return createHmac('sha256', secret).update(String(id)).digest('hex');
}
async function workspaceApi(method, body = null) {
  const token = workspaceTokenFor(workspaceId);
  const base = 'http://127.0.0.1:' + String(process.env.PORT || 3000);
  const response = await fetch(base + (method === 'POST' ? '/api/workspace/init' : '/api/workspace/' + encodeURIComponent(workspaceId)), {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-workspace-token': token,
    },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) {
    const error = new Error('CodeLab workspace API returned HTTP ' + response.status + ': ' + (data.detail || data.error || 'unknown_error'));
    error.status = response.status;
    throw error;
  }
  return data;
}
async function loadAdminWorkspace() {
  const initialized = await workspaceApi('POST', { id: workspaceId });
  if (!initialized || initialized.workspaceId !== workspaceId || !initialized.state || !Array.isArray(initialized.state.projects)) {
    throw new Error('CodeLab workspace initialization returned an invalid state.');
  }
  return initialized.state;
}
async function mutateAdminWorkspace(transform, options = {}) {
  const expectedRevision = options.expectedRevision;
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await loadAdminWorkspace();
    if (expectedRevision !== undefined && Number(expectedRevision) !== Number(current.revision)) {
      throw new Error('Revision conflict: the ADMIN workspace changed before this mutation.');
    }
    const nextProjects = await transform(current.projects);
    if (nextProjects === null) return { state: current, unchanged: true };
    try {
      const saved = await workspaceApi('PUT', { projects: nextProjects, baseRevision: current.revision });
      return { state: { ...current, revision: saved.revision, projects: nextProjects }, unchanged: false };
    } catch (error) {
      if (error.status === 409 && expectedRevision === undefined && attempt < 2) continue;
      throw error;
    }
  }
  throw new Error('Workspace revision conflict persisted after three safe retries.');
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function exportColor(value, fallback) {
  return typeof value === 'string' && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value) ? value : fallback;
}
function exportDesignToHtml(project) {
  const design = project.design || {};
  const elements = Array.isArray(design.elements) ? design.elements : [];
  if (!elements.length) throw new Error('The design has no elements to convert.');
  const width = Math.max(320, Math.min(4000, Number(design.canvasWidth || design.width) || 1280));
  const height = Math.max(240, Math.min(4000, Number(design.canvasHeight || design.height) || 800));
  const background = exportColor(design.background, '#ffffff');
  const autoLayout = design.layoutMode === 'auto';
  const direction = design.layoutDirection === 'column' ? 'column' : 'row';
  const gap = Math.max(0, Math.min(200, Number(design.layoutGap) || 0));
  const padding = Math.max(0, Math.min(200, Number(design.layoutPadding) || 0));
  const outputId = value => 'design-layer-' + String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);
  const elementsById = new Map(elements.filter(item => item && typeof item.id === 'string').map(item => [item.id, item]));
  const connections = Array.isArray(design.flowConnections) ? design.flowConnections : [];
  const localConnections = connections.filter(item =>
    item && item.targetProjectId === project.id && typeof item.targetElementId === 'string'
  );
  const flowTargets = new Map();
  for (const connection of localConnections) {
    if (!elementsById.has(connection.sourceElementId)) {
      throw new Error('A same-canvas navigation source does not exist in the design.');
    }
    if (!elementsById.has(connection.targetElementId)) {
      throw new Error('A same-canvas navigation target does not exist in the design.');
    }
    if (connection.sourceElementId === connection.targetElementId) {
      throw new Error('A same-canvas navigation cannot point to the same element.');
    }
    flowTargets.set(connection.sourceElementId, connection.targetElementId);
  }
  const markup = elements.map((element, index) => {
    const id = outputId(element.id || index);
    const type = String(element.type || 'text');
    const tag = type === 'heading' ? 'h1' : type === 'button' ? 'button' : 'div';
    const typeClass = ['heading','text','button','rectangle','ellipse','image'].includes(type) ? type : 'text';
    const layerClass = typeClass === 'heading'
      ? 'design-layer design-layer-heading'
      : typeClass === 'button'
        ? 'design-layer design-layer-button'
        : 'design-layer design-layer-' + typeClass;
    const text = escapeHtml(element.text || (type === 'image' ? 'Añade una imagen' : ''));
    const color = exportColor(element.color, '#111827');
    const fill = exportColor(element.background, 'transparent');
    const x = Math.max(0, Math.min(10000, Number(element.x) || 0));
    const y = Math.max(0, Math.min(10000, Number(element.y) || 0));
    const w = Math.max(20, Math.min(2400, Number(element.width) || (type === 'button' ? 180 : 320)));
    const h = Math.max(20, Math.min(1200, Number(element.height) || (type === 'heading' ? 72 : 56)));
    const font = Math.max(8, Math.min(120, Number(element.fontSize) || 16));
    const radius = Math.max(0, Math.min(300, Number(element.radius) || 0));
    const align = ['left','center','right'].includes(element.textAlign) ? element.textAlign : 'left';
    const position = autoLayout
      ? 'position:relative;left:auto;top:auto;flex:0 0 auto;max-width:100%;'
      : 'position:absolute;left:' + x + 'px;top:' + y + 'px;';
    const style = position + 'width:' + w + 'px;height:' + h + 'px;min-width:20px;min-height:20px;display:flex;align-items:center;box-sizing:border-box;padding:8px;color:' + color + ';background:' + fill + ';font-size:' + font + 'px;font-weight:' + Math.max(100,Math.min(900,Number(element.weight)||400)) + ';text-align:' + align + ';border-radius:' + (type === 'ellipse' ? '50%' : radius + 'px') + ';';
    const targetElementId = flowTargets.get(element.id);
    const navAttrs = targetElementId && element.flowRole !== 'menu'
      ? ' role="link" tabindex="0" data-flow-to-element="' + escapeHtml(outputId(targetElementId)) + '"'
      : '';
    if (type === 'button') {
      return '<button id="' + id + '" class="' + layerClass + '"' + navAttrs + ' type="button" data-codelab-demo style="' + style + 'justify-content:center;cursor:pointer;border:0;">' + (text || 'Probar interacción') + '</button>';
    }
    if (type === 'rectangle' || type === 'ellipse') {
      return '<div id="' + id + '" class="' + layerClass + '"' + navAttrs + ' aria-hidden="' + (navAttrs ? 'false' : 'true') + '" style="' + style + (navAttrs ? 'cursor:pointer;' : '') + '"></div>';
    }
    if (type === 'image') {
      const imageRole = navAttrs ? navAttrs : ' role="img"';
      return '<div id="' + id + '" class="' + layerClass + '"' + imageRole + ' aria-label="' + escapeHtml(element.alt || 'Imagen') + '" style="' + style + (navAttrs ? 'cursor:pointer;' : '') + '">Imagen pendiente</div>';
    }
    return '<' + tag + ' id="' + id + '" class="' + layerClass + '"' + navAttrs + ' style="' + style + (navAttrs ? 'cursor:pointer;' : '') + '">' + text + '</' + tag + '>';
  }).join('');
  const frameStyle = autoLayout
    ? 'position:relative;width:100%;max-width:' + width + 'px;min-height:' + height + 'px;display:flex;flex-direction:' + direction + ';flex-wrap:' + (direction === 'row' ? 'wrap' : 'nowrap') + ';gap:' + gap + 'px;padding:' + padding + 'px;align-items:flex-start;background:' + background + ';margin:0 auto;'
    : 'position:relative;width:' + width + 'px;height:' + height + 'px;min-height:' + height + 'px;background:' + background + ';transform-origin:top left;margin:0 auto;';
  const mobile = autoLayout
    ? '@media(max-width:768px){.design-frame.auto-layout{flex-direction:column;flex-wrap:nowrap;align-items:stretch}.design-frame.auto-layout>*{max-width:100%}}'
    : '@media(max-width:768px){.design-viewport{min-height:100vh;max-width:100vw;overflow:auto!important;touch-action:pan-x pan-y;-webkit-overflow-scrolling:touch}.design-frame:not(.auto-layout){margin:0!important}}';
  return '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escapeHtml(project.name) + '</title><style>*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:Inter,Arial,sans-serif;overflow-x:hidden}.design-viewport{position:relative;width:100%;max-width:100vw;overflow:auto;overscroll-behavior:contain}.design-frame{transform-origin:top left}.demo-status{position:fixed;left:16px;bottom:16px;padding:8px 12px;border-radius:8px;background:#0f172a;color:#fff;font:14px system-ui;z-index:10}' + mobile + '</style></head><body><div class="design-viewport"><main id="designFrame" class="design-frame' + (autoLayout ? ' auto-layout' : '') + '" style="' + frameStyle + '">' + markup + '</main></div><p class="demo-status" id="demoStatus" role="status" aria-live="polite">Diseño convertido · listo</p><script>(function(){var f=document.getElementById("designFrame"),v=f.parentNode,w=' + width + ',h=' + height + ';function fit(){if(f.classList.contains("auto-layout")){f.style.transform="none";v.style.height="auto";return;}if(w>window.innerWidth){f.style.transform="none";f.style.marginLeft="0";v.style.height=h+"px";return;}var s=Math.min(1,Math.max(.1,window.innerWidth/w));f.style.transform="scale("+s+")";f.style.marginLeft=Math.max(0,(window.innerWidth-w*s)/2)+"px";v.style.height=(h*s)+"px";}function navigate(el){var targetId=el.getAttribute("data-flow-to-element"),target=targetId&&document.getElementById(targetId);if(target)target.scrollIntoView({behavior:"smooth",block:"center",inline:"center"});}document.addEventListener("click",function(event){var nav=event.target.closest&&event.target.closest("[data-flow-to-element]");if(nav){event.preventDefault();navigate(nav);return;}var demo=event.target.closest&&event.target.closest("[data-codelab-demo]");if(demo)document.getElementById("demoStatus").textContent="Interacción funcionando ✓";});document.addEventListener("keydown",function(event){var nav=event.target.closest&&event.target.closest("[data-flow-to-element]");if(nav&&(event.key==="Enter"||event.key===" ")){event.preventDefault();navigate(nav);}});window.addEventListener("resize",fit,{passive:true});fit();})();<\/script></body></html>';
}
function createCodeLabProjectPayload(command, payload) {
  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  if (!name || name.length > 200) throw new Error('Project name must contain 1–200 characters.');
  const projectId = 'proj_native_' + String(command.command_id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60);
  const now = new Date().toISOString();
  const elements = [
    { id: 'hero-title', type: 'heading', text: 'Diseña. Construye. Publica.', x: 72, y: 72, width: 700, height: 88, fontSize: 48, weight: 800, color: '#f8fafc', background: 'transparent' },
    { id: 'hero-copy', type: 'text', text: 'Una interfaz creada en CodeLab y convertida en una web funcional.', x: 76, y: 180, width: 680, height: 72, fontSize: 21, color: '#cbd5e1', background: 'transparent' },
    { id: 'hero-cta', type: 'button', text: 'Probar interacción', x: 76, y: 290, width: 220, height: 58, fontSize: 17, weight: 700, color: '#ffffff', background: '#7c3aed', radius: 14 }
  ];
  return {
    id: projectId, name, type: 'design', updatedAt: now,
    code: { html: '', css: '', js: '' },
    hasWebSpace: true, hasDesignSpace: true,
    design: { elements, frame: 'desktop', background: '#0b1220', grid: true, gridSize: 8, snapToGrid: true, canvasWidth: 1280, canvasHeight: 720, layoutMode: 'absolute' },
    nativeProof: { createdBy: 'codelab-native-bridge', commandId: command.command_id, createdAt: now }
  };
}
async function createCodeLabProject(command) {
  const project = createCodeLabProjectPayload(command, command.payload || {});
  const result = await mutateAdminWorkspace(projects => {
    const existing = projects.find(item => item && item.id === project.id);
    if (existing) return null;
    return [project, ...projects];
  });
  const saved = result.state.projects.find(item => item && item.id === project.id);
  if (!saved) throw new Error('Created CodeLab project could not be confirmed in workspace state.');
  return {
    projectId: project.id, name: project.name, workspaceId,
    revision: result.state.revision, persisted: !result.unchanged,
    designElements: Array.isArray(saved.design?.elements) ? saved.design.elements.length : 0,
    designUrl: '/?projectId=' + encodeURIComponent(project.id),
  };
}
async function connectCodeLabProject(command) {
  const payload = command.payload || {};
  const sourceProjectId = payload.source_project_id;
  const targetProjectId = payload.target_project_id;
  const sourceElementId = payload.source_element_id;
  const targetElementId = payload.target_element_id;
  for (const [label, value] of [['source_project_id', sourceProjectId], ['target_project_id', targetProjectId]]) {
    if (typeof value !== 'string' || !/^proj_[a-zA-Z0-9_-]{1,100}$/.test(value)) {
      throw new Error(label + ' must be a valid CodeLab project id.');
    }
  }
  if (typeof sourceElementId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(sourceElementId)) {
    throw new Error('source_element_id must be a valid design element id.');
  }
  if (targetElementId != null && (typeof targetElementId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(targetElementId))) {
    throw new Error('target_element_id must be a valid design element id.');
  }
  if (sourceProjectId === targetProjectId && !targetElementId) {
    throw new Error('A same-canvas connection must identify a different target element.');
  }
  if (sourceProjectId === targetProjectId && sourceElementId === targetElementId) {
    throw new Error('A navigation connection cannot point to the same element.');
  }
  const result = await mutateAdminWorkspace(projects => {
    const sourceIndex = projects.findIndex(item => item && item.id === sourceProjectId);
    const targetProject = projects.find(item => item && item.id === targetProjectId);
    if (sourceIndex < 0) throw new Error('Source CodeLab project was not found.');
    if (!targetProject) throw new Error('Target CodeLab interface was not found.');
    const sourceProject = { ...projects[sourceIndex] };
    if (!sourceProject.design || !Array.isArray(sourceProject.design.elements)) {
      throw new Error('Source project has no design canvas.');
    }
    if (!targetProject.design || !Array.isArray(targetProject.design.elements)) {
      throw new Error('Target project has no design canvas.');
    }
    const sourceElement = sourceProject.design.elements.find(item => item && item.id === sourceElementId);
    if (!sourceElement) throw new Error('Source design element was not found.');
    if (sourceElement.flowRole === 'menu') {
      throw new Error('A dropdown menu cannot navigate to another interface.');
    }
    if (targetElementId && !targetProject.design.elements.some(item => item && item.id === targetElementId)) {
      throw new Error('Target design element was not found.');
    }
    const design = { ...sourceProject.design };
    const connections = Array.isArray(design.flowConnections) ? design.flowConnections.slice() : [];
    const nextConnection = {
      sourceElementId,
      targetProjectId,
      ...(targetElementId ? { targetElementId } : {})
    };
    const nextConnections = connections.filter(item => item && item.sourceElementId !== sourceElementId);
    nextConnections.push(nextConnection);
    design.flowConnections = nextConnections;
    const elements = design.elements.map(item =>
      item && item.id === sourceElementId ? { ...item, flowRole: 'navigate' } : item
    );
    sourceProject.design = { ...design, elements };
    sourceProject.updatedAt = new Date().toISOString();
    const next = projects.slice();
    next[sourceIndex] = sourceProject;
    return next;
  });
  const saved = result.state.projects.find(item => item && item.id === sourceProjectId);
  const savedConnection = saved?.design?.flowConnections?.find(item =>
    item && item.sourceElementId === sourceElementId &&
    item.targetProjectId === targetProjectId &&
    (targetElementId ? item.targetElementId === targetElementId : !item.targetElementId)
  );
  if (!savedConnection) throw new Error('Connection did not pass post-save verification.');
  const target = result.state.projects.find(item => item && item.id === targetProjectId);
  return {
    sourceProjectId,
    sourceElementId,
    targetProjectId,
    ...(targetElementId ? { targetElementId } : {}),
    sourceProjectName: saved.name,
    targetProjectName: target?.name,
    revision: result.state.revision,
    persisted: !result.unchanged,
    connection: savedConnection
  };
}

async function convertCodeLabProjectToWeb(command) {
  const projectId = command.payload?.project_id;
  if (typeof projectId !== 'string' || !/^proj_[a-zA-Z0-9_-]{1,100}$/.test(projectId)) {
    throw new Error('A valid CodeLab project_id is required.');
  }
  let conversion = null;
  const result = await mutateAdminWorkspace(projects => {
    const index = projects.findIndex(item => item && item.id === projectId);
    if (index < 0) throw new Error('CodeLab project not found in ADMIN workspace.');
    const project = { ...projects[index] };
    if (!project.design || !Array.isArray(project.design.elements) || !project.design.elements.length) {
      throw new Error('The CodeLab project has no design elements to convert.');
    }
    const html = exportDesignToHtml(project);
    project.code = { html, css: '', js: '' };
    project.type = 'web';
    project.hasWebSpace = true;
    project.hasDesignSpace = true;
    project.updatedAt = new Date().toISOString();
    conversion = { htmlBytes: Buffer.byteLength(html, 'utf8'), elementCount: project.design.elements.length };
    const next = projects.slice();
    next[index] = project;
    return next;
  });
  const saved = result.state.projects.find(item => item && item.id === projectId);
  if (!saved || !saved.code?.html || !saved.hasDesignSpace || !saved.hasWebSpace) {
    throw new Error('Converted CodeLab project did not pass post-save verification.');
  }
  return {
    projectId, workspaceId, revision: result.state.revision,
    persisted: !result.unchanged, type: saved.type,
    designElements: conversion?.elementCount || saved.design.elements.length,
    htmlBytes: conversion?.htmlBytes || Buffer.byteLength(saved.code.html, 'utf8'),
    checks: {
      htmlDocument: /<!doctype html>/i.test(saved.code.html),
      responsiveViewport: /name="viewport"/i.test(saved.code.html),
      interactionHandler: /Interacción funcionando/.test(saved.code.html),
      originalDesignPreserved: saved.design.elements.length > 0,
    },
  };
}
async function captureCodeLabProjectBrowser(project, payload = {}) {
  const requireFlowNavigation = payload.require_flow_navigation === true;
  const html = String(project.code?.html || '');
  if (!html || !/<!doctype html>/i.test(html)) throw new Error('The saved project has no complete HTML document to render.');
  if (Buffer.byteLength(html, 'utf8') > 2 * 1024 * 1024) throw new Error('The saved HTML exceeds the 2 MiB browser QA limit.');
  let browser;
  let step = 'launch';
  try {
    chromium.setGraphicsMode = false;
    browser = await playwrightChromium.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
      defaultViewport: null,
      timeout: 60000
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      reducedMotion: 'reduce'
    });
    try {
      step = 'create-page';
      await context.addInitScript(({ id, token }) => {
        localStorage.setItem('codelab_xd_workspace_v4', id);
        localStorage.setItem('codelab_xd_workspace_token_v1', token);
      }, { id: workspaceId, token: workspaceTokenFor(workspaceId) });
      const page = await context.newPage();
      const allPageErrors = [];
      const allConsoleErrors = [];
      page.on('pageerror', error => {
        if (allPageErrors.length < 20) allPageErrors.push(String(error.message || error).slice(0, 300));
      });
      page.on('console', message => {
        if (message.type() === 'error' && allConsoleErrors.length < 40) {
          const location = message.location() || {};
          allConsoleErrors.push({
            message: message.text().slice(0, 300),
            url: String(location.url || '').slice(0, 300),
            lineNumber: Number(location.lineNumber || 0),
            columnNumber: Number(location.columnNumber || 0)
          });
        }
      });
      const viewports = [
        { name: 'desktop', width: 1440, height: 1000 },
        { name: 'mobile', width: 390, height: 844 }
      ];
      const results = [];
      for (const viewport of viewports) {
        step = 'set-viewport-' + viewport.name;
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        step = 'load-html-' + viewport.name;
        await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
        step = 'wait-frame-' + viewport.name;
        await page.locator('#designFrame').waitFor({ state: 'visible', timeout: 10000 });
        const before = await page.evaluate(() => ({
          title: document.title,
          heading: document.querySelector('h1')?.textContent?.trim() || '',
          viewportMeta: !!document.querySelector('meta[name="viewport"]'),
          frameVisible: !!document.querySelector('#designFrame') && getComputedStyle(document.querySelector('#designFrame')).display !== 'none',
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          documentHeight: document.documentElement.scrollHeight
        }));
        const flowLinks = page.locator('[data-flow-to-element]');
        const flowLinkCount = await flowLinks.count();
        let navigationWorks = flowLinkCount > 0;
        for (let index = 0; index < flowLinkCount; index++) {
          const link = flowLinks.nth(index);
          const targetId = await link.getAttribute('data-flow-to-element');
          await link.click({ timeout: 5000 });
          await page.waitForTimeout(350);
          const targetVisible = targetId ? await page.locator('#' + targetId).evaluate(element => {
            const rect = element.getBoundingClientRect();
            return rect.left < window.innerWidth && rect.right > 0 && rect.top < window.innerHeight && rect.bottom > 0;
          }).catch(() => false) : false;
          navigationWorks = navigationWorks && targetVisible;
        }
        step = 'click-cta-' + viewport.name;
        const button = page.locator('[data-codelab-demo]').first();
        const buttonCount = await page.locator('[data-codelab-demo]').count();
        let buttonClicked = false;
        let statusText = '';
        if (buttonCount > 0) {
          await button.click({ timeout: 5000 });
          statusText = String(await page.locator('#demoStatus').textContent().catch(() => '') || '').trim();
          buttonClicked = statusText.includes('Interacción funcionando');
        }
        const metrics = await page.evaluate(() => {
          const button = document.querySelector('[data-codelab-demo]');
          const heading = document.querySelector('h1');
          const buttonRect = button?.getBoundingClientRect();
          return {
            documentWidth: document.documentElement.scrollWidth,
            viewportWidth: window.innerWidth,
            horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
            buttonWidth: buttonRect ? Math.round(buttonRect.width) : 0,
            buttonFontSize: button ? Number.parseFloat(getComputedStyle(button).fontSize) : 0,
            headingFontSize: heading ? Number.parseFloat(getComputedStyle(heading).fontSize) : 0
          };
        });
        step = 'screenshot-' + viewport.name;
        const screenshot = await page.screenshot({ type: 'png', fullPage: true, animations: 'disabled' });
        if (screenshot.length > 3 * 1024 * 1024) throw new Error('CodeLab ' + viewport.name + ' screenshot exceeds 3 MiB.');
        const pageErrors = allPageErrors.slice();
        const consoleErrors = allConsoleErrors.slice();
        results.push({
          viewport: { name: viewport.name, width: viewport.width, height: viewport.height },
          checks: {
            htmlDocument: true,
            viewportMeta: before.viewportMeta,
            frameVisible: before.frameVisible,
            headingVisible: !!before.heading,
            interactionButtonPresent: buttonCount > 0,
            interactionWorks: buttonClicked,
            navigationLinkPresent: !requireFlowNavigation || flowLinkCount > 0,
            navigationWorks: !requireFlowNavigation || navigationWorks,
            noHorizontalOverflow: !metrics.horizontalOverflow,
            mobileControlsReadable: viewport.name !== 'mobile' || (metrics.buttonWidth >= 140 && metrics.buttonFontSize >= 14 && metrics.headingFontSize >= 24),
            noPageErrors: pageErrors.length === 0 && consoleErrors.length === 0
          },
          page: { title: before.title, heading: before.heading, statusText, ...metrics, documentHeight: before.documentHeight },
          pageErrors,
          consoleErrors,
          screenshot: {
            role: viewport.name + '-render',
            label: 'CodeLab converted project — ' + viewport.name,
            mimeType: 'image/png',
            sizeBytes: screenshot.length,
            dataBase64: screenshot.toString('base64')
          }
        });
      }
      step = 'set-route-desktop-viewport';
      await page.setViewportSize({ width: 1440, height: 1000 });
      step = 'load-public-project-route';
      const baseUrl = String(process.env.RENDER_EXTERNAL_URL || process.env.OAUTH_PUBLIC_URL || ('http://127.0.0.1:' + String(process.env.PORT || 3000))).replace(/\/$/, '');
      const routeUrl = baseUrl + '/?projectId=' + encodeURIComponent(project.id);
      const routeErrorStart = allPageErrors.length;
      const routeConsoleStart = allConsoleErrors.length;
      const routeResponse = await page.goto(routeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (!routeResponse || !routeResponse.ok()) throw new Error('Public CodeLab project route returned HTTP ' + (routeResponse?.status() || 'no response'));
      step = 'wait-public-project-open';
      await page.waitForFunction(expectedName => {
        const studio = document.getElementById('studioView');
        const title = document.getElementById('currentProjectTitle');
        return !!studio && !studio.classList.contains('hidden') && !!title && title.textContent.trim() === expectedName;
      }, project.name, { timeout: 45000 });
      step = 'wait-public-preview';
      const preview = page.frameLocator('#previewIframe');
      await preview.locator('h1').first().waitFor({ state: 'visible', timeout: 45000 });
      const routeHeading = String(await preview.locator('h1').first().textContent() || '').trim();
      const routeFlowLinks = preview.locator('[data-flow-to-element]');
      const routeFlowLinkCount = await routeFlowLinks.count();
      let routeNavigationWorks = routeFlowLinkCount > 0;
      for (let index = 0; index < routeFlowLinkCount; index++) {
        const link = routeFlowLinks.nth(index);
        const targetId = await link.getAttribute('data-flow-to-element');
        await link.click({ timeout: 10000 });
        await page.waitForTimeout(350);
        const targetVisible = targetId ? await preview.locator('#' + targetId).evaluate(element => {
          const rect = element.getBoundingClientRect();
          return rect.left < window.innerWidth && rect.right > 0 && rect.top < window.innerHeight && rect.bottom > 0;
        }).catch(() => false) : false;
        routeNavigationWorks = routeNavigationWorks && targetVisible;
      }
      const routeButton = preview.locator('[data-codelab-demo]').first();
      const routeButtonCount = await preview.locator('[data-codelab-demo]').count();
      let routeStatus = '';
      let routeInteractionWorks = false;
      if (routeButtonCount > 0) {
        step = 'click-public-preview-cta';
        await routeButton.click({ timeout: 10000 });
        routeStatus = String(await preview.locator('#demoStatus').textContent().catch(() => '') || '').trim();
        routeInteractionWorks = routeStatus.includes('Interacción funcionando');
      }
      const routePage = await page.evaluate(() => {
        const layout = {};
        for (const id of ['studioView','mainSplit','webWorkspacePanel','previewPanel','previewIframe']) {
          const element = document.getElementById(id);
          if (!element) { layout[id] = null; continue; }
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          layout[id] = {
            x: Math.round(rect.x), y: Math.round(rect.y),
            width: Math.round(rect.width), height: Math.round(rect.height),
            display: style.display, visibility: style.visibility,
            flex: style.flex, classes: String(element.className || '').slice(0, 160)
          };
        }
        return {
          title: document.title,
          projectTitle: document.getElementById('currentProjectTitle')?.textContent?.trim() || '',
          studioVisible: !!document.getElementById('studioView') && !document.getElementById('studioView').classList.contains('hidden'),
          workspaceId: localStorage.getItem('codelab_xd_workspace_v4') || '',
          documentWidth: document.documentElement.scrollWidth,
          documentHeight: document.documentElement.scrollHeight,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          layout
        };
      });
      step = 'screenshot-public-project-route';
      const routeScreenshot = await page.screenshot({ type: 'png', fullPage: true, animations: 'disabled' });
      if (routeScreenshot.length > 3 * 1024 * 1024) throw new Error('CodeLab public route screenshot exceeds 3 MiB.');
      step = 'reload-public-project-route';
      const reloadResponse = await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
      if (!reloadResponse || !reloadResponse.ok()) throw new Error('Public CodeLab project route reload returned HTTP ' + (reloadResponse?.status() || 'no response'));
      await page.waitForFunction(expectedName => {
        const studio = document.getElementById('studioView');
        const title = document.getElementById('currentProjectTitle');
        return !!studio && !studio.classList.contains('hidden') && !!title && title.textContent.trim() === expectedName;
      }, project.name, { timeout: 45000 });
      const reloadedPreview = page.frameLocator('#previewIframe');
      await reloadedPreview.locator('h1').first().waitFor({ state: 'visible', timeout: 45000 });
      const reloadedHeading = String(await reloadedPreview.locator('h1').first().textContent() || '').trim();
      const reloadedButton = reloadedPreview.locator('[data-codelab-demo]').first();
      const reloadedButtonCount = await reloadedPreview.locator('[data-codelab-demo]').count();
      let reloadedStatus = '';
      if (reloadedButtonCount > 0) {
        await reloadedButton.click({ timeout: 10000 });
        reloadedStatus = String(await reloadedPreview.locator('#demoStatus').textContent().catch(() => '') || '').trim();
      }
      const reloadTest = {
        checks: {
          httpOk: reloadResponse.ok(),
          projectRestored: await page.locator('#currentProjectTitle').textContent().then(value => String(value || '').trim() === project.name),
          previewRestored: !!reloadedHeading,
          interactionWorks: reloadedStatus.includes('Interacción funcionando')
        },
        page: { previewHeading: reloadedHeading, statusText: reloadedStatus }
      };
      step = 'set-route-mobile-viewport';
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(250);
      const mobileRoutePage = await page.evaluate(() => {
        const rectFor = id => {
          const element = document.getElementById(id);
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height), display: getComputedStyle(element).display };
        };
        const studioHeader = document.querySelector('#studioView > header');
        const headerRect = studioHeader?.getBoundingClientRect();
        const primaryButton = document.querySelector('#studioView > header button');
        const buttonRect = primaryButton?.getBoundingClientRect();
        const toolbar = document.getElementById('webWorkspaceToolbar');
        const toolbarButtons = [...(toolbar?.querySelectorAll('.web-action') || [])].map(button => {
          const rect = button.getBoundingClientRect();
          return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), height: Math.round(rect.height) };
        });
        const toolbarControlsDoNotOverlap = toolbarButtons.every((rect, index) => index === 0 || rect.left >= toolbarButtons[index - 1].right - 1);
        return {
          viewportWidth: innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          documentHeight: document.documentElement.scrollHeight,
          studioVisible: !!document.getElementById('studioView') && !document.getElementById('studioView').classList.contains('hidden'),
          projectTitle: document.getElementById('currentProjectTitle')?.textContent?.trim() || '',
          mainSplit: rectFor('mainSplit'),
          webWorkspacePanel: rectFor('webWorkspacePanel'),
          previewPanel: rectFor('previewPanel'),
          previewIframe: rectFor('previewIframe'),
          headerHeight: headerRect ? Math.round(headerRect.height) : 0,
          headerButtonHeight: buttonRect ? Math.round(buttonRect.height) : 0,
          toolbarClientWidth: toolbar?.clientWidth || 0,
          toolbarScrollWidth: toolbar?.scrollWidth || 0,
          toolbarButtons,
          toolbarControlsDoNotOverlap
        };
      });
      const mobileCodeScreenshot = await page.screenshot({ type: 'png', fullPage: true, animations: 'disabled' });
      if (mobileCodeScreenshot.length > 3 * 1024 * 1024) throw new Error('CodeLab mobile code-mode screenshot exceeds 3 MiB.');
      const previewTab = page.locator('#mobileTabPreview');
      const previewTabHeight = await previewTab.evaluate(element => Math.round(element.getBoundingClientRect().height)).catch(() => 0);
      step = 'switch-mobile-to-preview';
      await previewTab.click({ timeout: 10000 });
      await page.locator('#previewPanel').waitFor({ state: 'visible', timeout: 10000 });
      await page.frameLocator('#previewIframe').locator('h1').first().waitFor({ state: 'visible', timeout: 15000 });
      const mobilePreviewHeading = String(await page.frameLocator('#previewIframe').locator('h1').first().textContent() || '').trim();
      const mobilePreviewScreenshot = await page.screenshot({ type: 'png', fullPage: true, animations: 'disabled' });
      if (mobilePreviewScreenshot.length > 3 * 1024 * 1024) throw new Error('CodeLab mobile preview-mode screenshot exceeds 3 MiB.');
      step = 'switch-mobile-back-to-code';
      await page.locator('#mobileTabCode').click({ timeout: 10000 });
      await page.locator('#editorPanel').waitFor({ state: 'visible', timeout: 10000 });
      const mobileCodeRestored = await page.locator('#editorPanel').evaluate(element => getComputedStyle(element).display !== 'none');
      const mobileRouteTest = {
        checks: {
          studioVisible: mobileRoutePage.studioVisible,
          projectOpened: mobileRoutePage.projectTitle === project.name,
          noHorizontalOverflow: mobileRoutePage.documentWidth <= mobileRoutePage.viewportWidth + 1,
          toolbarControlsDoNotOverlap: mobileRoutePage.toolbarControlsDoNotOverlap,
          toolbarActionsTouchSized: mobileRoutePage.toolbarButtons.length > 0 && mobileRoutePage.toolbarButtons.every(button => button.width >= 44 && button.height >= 44),
          toolbarScrollsInsteadOfShrinking: mobileRoutePage.toolbarScrollWidth >= mobileRoutePage.toolbarClientWidth,
          workspaceVisible: !!mobileRoutePage.webWorkspacePanel && mobileRoutePage.webWorkspacePanel.width > 0 && mobileRoutePage.webWorkspacePanel.height > 0,
          previewTabTouchSized: previewTabHeight >= 44,
          previewTabSwitchWorks: !!mobilePreviewHeading,
          previewVisibleInPreviewMode: !!mobilePreviewHeading && mobilePreviewHeading === routeHeading,
          codeTabRestoresEditor: mobileCodeRestored
        },
        page: { ...mobileRoutePage, previewTabHeight, mobilePreviewHeading, mobileCodeRestored },
        screenshots: [
          {
            role: 'public-route-mobile-code',
            label: 'CodeLab deployed project route — mobile code mode',
            mimeType: 'image/png',
            sizeBytes: mobileCodeScreenshot.length,
            dataBase64: mobileCodeScreenshot.toString('base64')
          },
          {
            role: 'public-route-mobile-preview',
            label: 'CodeLab deployed project route — mobile preview mode',
            mimeType: 'image/png',
            sizeBytes: mobilePreviewScreenshot.length,
            dataBase64: mobilePreviewScreenshot.toString('base64')
          }
        ]
      };
      step = 'open-design-flow-graph';
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.evaluate(() => {
        if (typeof window.openDesignFlowGraph !== 'function') {
          throw new Error('The deployed design-flow graph launcher is not available.');
        }
        window.openDesignFlowGraph();
      });
      const graphModal = page.locator('#designFlowGraphModal');
      await graphModal.waitFor({ state: 'visible', timeout: 10000 });
      const graphCards = page.locator('#designFlowCards > article');
      await graphCards.first().waitFor({ state: 'visible', timeout: 10000 });
      const storeProjectCard = page.locator('[data-flow-page="proj_native_store-canvas-20261106-01"]');
      await storeProjectCard.waitFor({ state: 'visible', timeout: 10000 });
      const storeProjectConnectionCount = await storeProjectCard.locator('[data-flow-remove]').count();
      await page.locator('#designFlowOverviewToggle').click({ timeout: 10000 });
      await page.locator('#designFlowOverview').waitFor({ state: 'visible', timeout: 10000 });
      const graphOverviewText = String(await page.locator('#designFlowOverview').innerText() || '');
      const previewSandbox = await page.locator('#previewIframe').getAttribute('sandbox').catch(() => '') || '';
      const sandboxIsolationConfirmed = previewSandbox.includes('allow-scripts') && !previewSandbox.includes('allow-same-origin');
      await page.locator('#designFlowOverviewToggle').click({ timeout: 10000 });
      // The preview was already tested above; release its iframe before capturing the graph to stay within the free Render memory budget.
      await page.evaluate(() => { document.getElementById('previewPanel')?.remove(); });
      await page.evaluate(projectId => {
        const cards = Array.from(document.querySelectorAll('#designFlowCards > article'));
        cards.forEach(card => { if (card.dataset.flowPage !== projectId) card.remove(); });
        window.dispatchEvent(new Event('resize'));
      }, 'proj_native_store-canvas-20261106-01');
      const sourceNode = page.locator('[data-flow-source-project="proj_native_store-canvas-20261106-01"][data-flow-action="hero-cta"]');
      const targetNode = page.locator('[data-flow-target-project="proj_native_store-canvas-20261106-01"][data-flow-target-element="catalog-title"]');
      await sourceNode.scrollIntoViewIfNeeded();
      await targetNode.scrollIntoViewIfNeeded();
      await page.waitForTimeout(350);
      const desktopWireCount = await page.locator('#designFlowWires path[data-connection]').count();
      const desktopWireVisuals = await page.locator('#designFlowWires path[data-connection]').evaluateAll(paths => {
        const canvasRect = document.getElementById('designFlowCanvas').getBoundingClientRect();
        const cardRect = document.querySelector('[data-flow-page="proj_native_store-canvas-20261106-01"]').getBoundingClientRect();
        const svg = document.getElementById('designFlowWires');
        const cards = document.getElementById('designFlowCards');
        const source = document.querySelector('[data-flow-source-project="proj_native_store-canvas-20261106-01"][data-flow-action="hero-cta"]');
        const visiblePaths = paths.filter(path => {
          const rect = path.getBoundingClientRect();
          const style = getComputedStyle(path);
          return style.stroke !== 'none' && Number(style.opacity || 1) > 0 &&
            rect.width > 1 && rect.height > 1 &&
            rect.left < canvasRect.right && rect.right > canvasRect.left &&
            rect.top < canvasRect.bottom && rect.bottom > canvasRect.top;
        });
        const outsideCardCount = visiblePaths.filter(path => path.getBoundingClientRect().right > cardRect.right + 2).length;
        return {
          visibleCount: visiblePaths.length,
          outsideCardCount,
          svgZ: Number.parseInt(getComputedStyle(svg).zIndex, 10) || 0,
          cardsZ: Number.parseInt(getComputedStyle(cards).zIndex, 10) || 0,
          rowZ: Number.parseInt(getComputedStyle(source).zIndex, 10) || 0
        };
      });
      const desktopGraphMetrics = await page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        modalVisible: !!document.getElementById('designFlowGraphModal') &&
          !document.getElementById('designFlowGraphModal').classList.contains('hidden'),
        cardCount: document.querySelectorAll('#designFlowCards > article').length,
        storeProjectCardVisible: !!document.querySelector('[data-flow-page="proj_native_store-canvas-20261106-01"]')
      }));
      const desktopGraphScreenshot = await page.locator('#designFlowGraphModal').screenshot({ type: 'png', animations: 'disabled' });
      if (desktopGraphScreenshot.length > 3 * 1024 * 1024) throw new Error('CodeLab desktop node-graph screenshot exceeds 3 MiB.');
      step = 'capture-design-flow-graph-mobile';
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(250);
      await sourceNode.scrollIntoViewIfNeeded();
      await targetNode.scrollIntoViewIfNeeded();
      await page.waitForTimeout(350);
      const mobileWireCount = await page.locator('#designFlowWires path[data-connection]').count();
      const mobileWireVisuals = await page.locator('#designFlowWires path[data-connection]').evaluateAll(paths => {
        const canvasRect = document.getElementById('designFlowCanvas').getBoundingClientRect();
        const cardRect = document.querySelector('[data-flow-page="proj_native_store-canvas-20261106-01"]').getBoundingClientRect();
        const svg = document.getElementById('designFlowWires');
        const cards = document.getElementById('designFlowCards');
        const source = document.querySelector('[data-flow-source-project="proj_native_store-canvas-20261106-01"][data-flow-action="hero-cta"]');
        const visiblePaths = paths.filter(path => {
          const rect = path.getBoundingClientRect();
          const style = getComputedStyle(path);
          return style.stroke !== 'none' && Number(style.opacity || 1) > 0 &&
            rect.width > 1 && rect.height > 1 &&
            rect.left < canvasRect.right && rect.right > canvasRect.left &&
            rect.top < canvasRect.bottom && rect.bottom > canvasRect.top;
        });
        const outsideCardCount = visiblePaths.filter(path => path.getBoundingClientRect().right > cardRect.right + 2).length;
        return {
          visibleCount: visiblePaths.length,
          outsideCardCount,
          svgZ: Number.parseInt(getComputedStyle(svg).zIndex, 10) || 0,
          cardsZ: Number.parseInt(getComputedStyle(cards).zIndex, 10) || 0,
          rowZ: Number.parseInt(getComputedStyle(source).zIndex, 10) || 0
        };
      });
      const mobileGraphMetrics = await page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        modalWidth: Math.round(document.getElementById('designFlowGraphModal')?.getBoundingClientRect().width || 0),
        canvasWidth: document.getElementById('designFlowCanvas')?.clientWidth || 0,
        cardCount: document.querySelectorAll('#designFlowCards > article').length
      }));
      const mobileGraphScreenshot = await page.locator('#designFlowGraphModal').screenshot({ type: 'png', animations: 'disabled' });
      if (mobileGraphScreenshot.length > 3 * 1024 * 1024) throw new Error('CodeLab mobile node-graph screenshot exceeds 3 MiB.');
      const designFlowGraph = {
        checks: {
          modalVisible: desktopGraphMetrics.modalVisible,
          projectCardVisible: desktopGraphMetrics.storeProjectCardVisible,
          storeProjectHasTwoConnections: storeProjectConnectionCount === 2,
          overviewShowsNoBrokenConnections: /0 rotas/.test(graphOverviewText),
          desktopWiresVisible: desktopWireCount >= 2 && desktopWireVisuals.visibleCount >= 2 && desktopWireVisuals.outsideCardCount >= 2 && desktopWireVisuals.svgZ > desktopWireVisuals.cardsZ && desktopWireVisuals.rowZ > desktopWireVisuals.svgZ,
          mobileWiresVisible: mobileWireCount >= 2 && mobileWireVisuals.visibleCount >= 2 && mobileWireVisuals.outsideCardCount >= 2 && mobileWireVisuals.svgZ > mobileWireVisuals.cardsZ && mobileWireVisuals.rowZ > mobileWireVisuals.svgZ,
          mobileNoDocumentOverflow: mobileGraphMetrics.documentWidth <= mobileGraphMetrics.viewportWidth + 1,
          mobileGraphFitsViewport: mobileGraphMetrics.modalWidth === mobileGraphMetrics.viewportWidth
        },
        metrics: { overviewText: graphOverviewText, desktop: desktopGraphMetrics, mobile: mobileGraphMetrics, storeProjectConnectionCount, desktopWireCount, mobileWireCount, desktopWireVisuals, mobileWireVisuals },
        screenshots: [
          {
            role: 'design-flow-graph-desktop',
            label: 'CodeLab — grafo de nodos y conexiones — escritorio',
            mimeType: 'image/png',
            sizeBytes: desktopGraphScreenshot.length,
            dataBase64: desktopGraphScreenshot.toString('base64')
          },
          {
            role: 'design-flow-graph-mobile',
            label: 'CodeLab — grafo de nodos y conexiones — móvil',
            mimeType: 'image/png',
            sizeBytes: mobileGraphScreenshot.length,
            dataBase64: mobileGraphScreenshot.toString('base64')
          }
        ]
      };
      const routeErrors = allPageErrors.slice(routeErrorStart);
      const routeConsoleErrors = allConsoleErrors.slice(routeConsoleStart);
      const expectedSandboxPageErrors = sandboxIsolationConfirmed
        ? routeErrors.filter(item => /Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag/.test(item))
        : [];
      const unexpectedPageErrors = routeErrors.filter(item => !expectedSandboxPageErrors.includes(item));
      const expectedSandboxConsoleErrors = routeConsoleErrors.filter(item =>
        /Failed to read the 'localStorage' property from 'Window'/.test(item.message) &&
        /about:srcdoc|about:blank/.test(item.url)
      );
      const unexpectedConsoleErrors = routeConsoleErrors.filter(item => !expectedSandboxConsoleErrors.includes(item));
      const expectedSandboxWarnings = [
        ...expectedSandboxPageErrors.map(message => ({ source: 'sandboxed-preview-pageerror', message })),
        ...expectedSandboxConsoleErrors.map(item => ({ source: 'sandboxed-preview-console', ...item }))
      ];
      const routeTest = {
        designFlowGraph,
        url: routeUrl,
        captureMethod: 'playwright-chromium-public-route-admin-workspace',
        checks: {
          httpOk: routeResponse.ok(),
          adminWorkspaceLoaded: routePage.workspaceId === workspaceId,
          projectOpened: routePage.studioVisible && routePage.projectTitle === project.name,
          previewRendered: !!routeHeading,
          interactionButtonPresent: routeButtonCount > 0,
          interactionWorks: routeInteractionWorks,
          navigationLinkPresent: !requireFlowNavigation || routeFlowLinkCount > 0,
          navigationWorks: !requireFlowNavigation || routeNavigationWorks,
          noHorizontalOverflow: routePage.documentWidth <= routePage.viewportWidth + 1,
          previewSandboxed: sandboxIsolationConfirmed,
          reloadRestoresProject: Object.values(reloadTest.checks).every(Boolean),
          mobileLayoutPasses: Object.values(mobileRouteTest.checks).every(Boolean),
          designFlowGraphVisible: designFlowGraph.checks.modalVisible && designFlowGraph.checks.projectCardVisible,
          designFlowConnectionsVisible: designFlowGraph.checks.storeProjectHasTwoConnections && designFlowGraph.checks.overviewShowsNoBrokenConnections && designFlowGraph.checks.desktopWiresVisible && designFlowGraph.checks.mobileWiresVisible,
          designFlowGraphMobileFits: designFlowGraph.checks.mobileNoDocumentOverflow && designFlowGraph.checks.mobileGraphFitsViewport,
          noPageErrors: unexpectedPageErrors.length === 0 && unexpectedConsoleErrors.length === 0
        },
        page: { ...routePage, previewHeading: routeHeading, statusText: routeStatus, previewSandbox },
        reload: reloadTest,
        mobile: mobileRouteTest,
        pageErrors: unexpectedPageErrors,
        consoleErrors: unexpectedConsoleErrors,
        expectedSandboxWarnings,
        screenshot: {
          role: 'public-route-desktop',
          label: 'CodeLab deployed project route — ADMIN workspace',
          mimeType: 'image/png',
          sizeBytes: routeScreenshot.length,
          dataBase64: routeScreenshot.toString('base64')
        }
      };
      return {
        captureMethod: 'playwright-chromium-saved-html-and-public-route',
        target: 'persisted HTML plus deployed CodeLab route opened with the ADMIN workspace token',
        passed: results.every(item => Object.values(item.checks).every(Boolean)) && Object.values(routeTest.checks).every(Boolean),
        viewports: results,
        routeTest
      };
    } finally {
      await context.close().catch(() => {});
    }
  } catch (error) {
    const wrapped = new Error('CodeLab browser QA failed at step ' + step + ': ' + String(error.message || error));
    wrapped.cause = error;
    throw wrapped;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
async function captureCodeLabDashboardBrowser(expectedState) {
  const expectedProjects = Array.isArray(expectedState?.projects) ? expectedState.projects : [];
  const expectedNames = expectedProjects.map(project => String(project?.name || 'Sin título'));
  let browser;
  try {
    chromium.setGraphicsMode = false;
    browser = await playwrightChromium.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
      defaultViewport: null,
      timeout: 60000
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      reducedMotion: 'reduce'
    });
    const page = await context.newPage();
    const pageErrors = [];
    const sandboxWarnings = [];
    const consoleErrors = [];
    page.on('pageerror', error => {
      const message = String(error.message || error).slice(0, 300);
      if (/document is sandboxed and lacks the ['"]allow-same-origin['"] flag/i.test(message)) {
        if (sandboxWarnings.length < 20) sandboxWarnings.push(message);
      } else if (pageErrors.length < 20) {
        pageErrors.push(message);
      }
    });
    page.on('console', message => {
      if (message.type() === 'error' && consoleErrors.length < 30) {
        consoleErrors.push(message.text().slice(0, 300));
      }
    });
    const baseUrl = String(process.env.RENDER_EXTERNAL_URL || process.env.OAUTH_PUBLIC_URL || ('http://127.0.0.1:' + String(process.env.PORT || 3000))).replace(/\/$/, '');
    const response = await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!response || !response.ok()) throw new Error('Dashboard returned HTTP ' + (response?.status() || 'no response'));
    await page.waitForFunction(expectedCount => {
      const count = document.getElementById('projectCount');
      const grid = document.getElementById('projectsGrid');
      return !!count && !!grid && Number(count.textContent.trim()) === expectedCount &&
        grid.querySelectorAll(':scope > div').length === expectedCount;
    }, expectedProjects.length, { timeout: 45000 });
    const captures = [];
    for (const viewport of [
      { name: 'desktop', width: 1440, height: 1000 },
      { name: 'mobile', width: 390, height: 844 }
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.waitForTimeout(250);
      const pageData = await page.evaluate(() => {
        const grid = document.getElementById('projectsGrid');
        const count = document.getElementById('projectCount');
        return {
          title: document.title,
          projectCountText: count?.textContent?.trim() || '',
          cardCount: grid ? grid.querySelectorAll(':scope > div').length : 0,
          projectNames: grid ? Array.from(grid.querySelectorAll(':scope > div h4')).map(node => node.textContent.trim()) : [],
          horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
          viewportWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth
        };
      });
      const screenshot = await page.screenshot({ type: 'png', fullPage: true, animations: 'disabled' });
      const projectListScreenshot = await page.locator('#projectsGrid').screenshot({ animations: 'disabled' });
      if (screenshot.length > 3 * 1024 * 1024 || projectListScreenshot.length > 3 * 1024 * 1024) {
        throw new Error('Dashboard ' + viewport.name + ' screenshot exceeds 3 MiB.');
      }
      captures.push({
        viewport,
        page: pageData,
        screenshot: {
          role: 'dashboard-' + viewport.name,
          label: 'CodeLab dashboard — ' + viewport.name,
          mimeType: 'image/png',
          sizeBytes: screenshot.length,
          dataBase64: screenshot.toString('base64')
        },
        projectListScreenshot: {
          role: 'dashboard-project-list-' + viewport.name,
          label: 'CodeLab projects list — ' + viewport.name,
          mimeType: 'image/png',
          sizeBytes: projectListScreenshot.length,
          dataBase64: projectListScreenshot.toString('base64')
        }
      });
    }
    const renderedNames = captures[0]?.page?.projectNames || [];
    const missing = expectedNames.filter(name => !renderedNames.includes(name));
    const unexpected = renderedNames.filter(name => !expectedNames.includes(name));
    return {
      passed: missing.length === 0 && unexpected.length === 0 &&
        captures.every(item => item.page.cardCount === expectedProjects.length) &&
        pageErrors.length === 0 && consoleErrors.length === 0,
      workspaceId,
      revision: expectedState.revision,
      databaseProjectCount: expectedProjects.length,
      expectedProjectNames: expectedNames,
      renderedProjectNames: renderedNames,
      missingProjectNames: missing,
      unexpectedProjectNames: unexpected,
      pageErrors,
      sandboxWarnings,
      consoleErrors,
      captures
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}


function assertCodeLabProjectId(value) {
  if (typeof value !== 'string' || !/^proj_[a-zA-Z0-9_-]{1,100}$/.test(value)) {
    throw new Error('A valid CodeLab project_id is required.');
  }
}
async function getCodeLabProjectCode(command) {
  const payload = command.payload || {};
  assertCodeLabProjectId(payload.project_id);
  const state = await loadAdminWorkspace();
  const project = state.projects.find(item => item && item.id === payload.project_id);
  if (!project) throw new Error('CodeLab project not found in ADMIN workspace.');
  const code = {};
  for (const field of ['html', 'css', 'js']) code[field] = String(project.code?.[field] || '');
  return {
    projectId: project.id,
    name: project.name,
    type: project.type,
    revision: state.revision,
    code,
    bytes: Object.fromEntries(Object.entries(code).map(([field, value]) => [field, Buffer.byteLength(value, 'utf8')])),
    sha256: createHash('sha256').update(JSON.stringify(code)).digest('hex')
  };
}
async function updateCodeLabProjectCode(command) {
  const payload = command.payload || {};
  assertCodeLabProjectId(payload.project_id);
  if (!payload.code || typeof payload.code !== 'object' || Array.isArray(payload.code)) {
    throw new Error('A code object containing html, css and/or js is required.');
  }
  const fields = Object.keys(payload.code);
  if (!fields.length || fields.some(field => !['html', 'css', 'js'].includes(field))) {
    throw new Error('Only html, css and js fields can be updated.');
  }
  for (const field of fields) {
    if (typeof payload.code[field] !== 'string') throw new Error('Code field ' + field + ' must be a string.');
    if (Buffer.byteLength(payload.code[field], 'utf8') > 500000) {
      throw new Error('Code field ' + field + ' exceeds the 500 KiB limit.');
    }
  }
  const before = await loadAdminWorkspace();
  if (payload.base_revision !== undefined && Number(payload.base_revision) !== Number(before.revision)) {
    throw new Error('Revision conflict: the ADMIN workspace changed before this code update.');
  }
  const currentProject = before.projects.find(item => item && item.id === payload.project_id);
  if (!currentProject) throw new Error('CodeLab project not found in ADMIN workspace.');
  const nextCode = { ...(currentProject.code || {}) };
  for (const field of fields) nextCode[field] = payload.code[field];
  if (fields.every(field => nextCode[field] === String(currentProject.code?.[field] || ''))) {
    return { saved: true, unchanged: true, projectId: currentProject.id, revision: before.revision, fields };
  }
  const saved = await mutateAdminWorkspace(projects => {
    const index = projects.findIndex(item => item && item.id === payload.project_id);
    if (index < 0) throw new Error('CodeLab project disappeared during code update.');
    const updated = projects.slice();
    const latestCode = { ...(updated[index].code || {}) };
    for (const field of fields) latestCode[field] = payload.code[field];
    updated[index] = { ...updated[index], code: latestCode, updatedAt: new Date().toISOString() };
    return updated;
  }, { expectedRevision: payload.base_revision });
  const verifiedState = await loadAdminWorkspace();
  const verifiedProject = verifiedState.projects.find(item => item && item.id === payload.project_id);
  if (!verifiedProject || fields.some(field => verifiedProject.code?.[field] !== nextCode[field])) {
    throw new Error('CodeLab code update could not be verified after persistence.');
  }
  const verifiedCode = {};
  for (const field of ['html', 'css', 'js']) verifiedCode[field] = String(verifiedProject.code?.[field] || '');
  return {
    saved: true,
    unchanged: false,
    projectId: verifiedProject.id,
    revision: verifiedState.revision,
    fields,
    bytes: Object.fromEntries(fields.map(field => [field, Buffer.byteLength(verifiedCode[field], 'utf8')])),
    sha256: createHash('sha256').update(JSON.stringify(verifiedCode)).digest('hex'),
    persistenceVerified: true,
    previousRevision: before.revision,
    mutationRevision: saved.state.revision
  };
}


async function resolveAnimationCaptureProjectId(command) {
  if (!command || !String(command.action || '').startsWith('pixelforge_')) return null;
  if (command.action === 'pixelforge_export_animation_video') return null;
  if (command.action === 'pixelforge_animation_frame_context') {
    return typeof command.payload?.project_id === 'string' ? command.payload.project_id : null;
  }
  // A proposal is isolated and has not changed the saved project yet. Capture
  // only after its explicit approval, by reading the original proposal payload.
  if (command.action === 'pixelforge_propose') return null;
  if (command.action === 'pixelforge_approve') {
    const proposalCommandId = String(command.payload?.proposal_command_id || '');
    if (!proposalCommandId) return null;
    const proposal = await pool.query(
      'SELECT payload FROM public.codelab_agent_commands WHERE workspace_id=$1 AND command_id=$2',
      [workspaceId, proposalCommandId]
    );
    const proposalPayload = proposal.rows[0]?.payload || {};
    const actions = proposalPayload.actions;
    if (!Array.isArray(actions) || !actions.some(action =>
      action && typeof action.name === 'string' && action.name.startsWith('animation.')
    )) return null;
    return typeof proposalPayload.project_id === 'string' ? proposalPayload.project_id : null;
  }
  return null;
}

async function startAutomaticAnimationCapture(command) {
  const projectId = await resolveAnimationCaptureProjectId(command);
  if (!projectId) return null;
  assertProjectId(projectId);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codelab-animation-auto-'));
  let browser;
  try {
    chromium.setGraphicsMode = false;
    browser = await playwrightChromium.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
      timeout: 60000
    });
    const width = Number.isInteger(command.payload?.capture_width)
      ? Math.max(640, Math.min(1920, command.payload.capture_width)) : 1280;
    const height = Number.isInteger(command.payload?.capture_height)
      ? Math.max(480, Math.min(1080, command.payload.capture_height)) : 720;
    const fps = Number.isInteger(command.payload?.capture_fps)
      ? Math.max(1, Math.min(30, command.payload.capture_fps)) : 12;
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      recordVideo: { dir: tempDir, size: { width, height }, fps }
    });
    // Authenticate before the post-approval recording page is created. The
    // recorder page itself is created only after the project has been saved.
    const authPage = await context.newPage();
    const baseUrl = String(process.env.RENDER_EXTERNAL_URL || process.env.OAUTH_PUBLIC_URL ||
      ('http://127.0.0.1:' + String(process.env.PORT || 3000))).replace(/\/$/, '');
    const handoff = await mintNativeAdminHandoff();
    const handoffResponse = await authPage.goto(handoff.handoffUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!handoffResponse || !handoffResponse.ok()) {
      throw new Error('Automatic capture ADMIN handoff returned HTTP ' + (handoffResponse?.status() || 'no response'));
    }
    await authPage.close().catch(() => {});
    return {
      projectId,
      tempDir,
      browser,
      context,
      baseUrl,
      routeUrl: baseUrl + '/pixelforge/index.html?projectId=' + encodeURIComponent(projectId) + '&capture=video',
      width,
      height,
      fps
    };
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function prepareAnimationEvidence(command) {
  const projectId = command.payload?.project_id;
  if (typeof projectId !== 'string') return null;
  const commandRow = await pool.query(
    'SELECT status, result FROM codelab_agent_commands WHERE command_id=$1 AND workspace_id=$2',
    [command.command_id, workspaceId]
  );
  const result = commandRow.rows[0]?.result || {};
  const commandStatus = commandRow.rows[0]?.status || 'unknown';
  let revision = Number(result.serverRevision || result.revision || 0);
  let contentSha256 = result.contentSha256 || null;
  if (!revision) {
    const loaded = await loadProject(projectId);
    revision = loaded.serverRevision;
    contentSha256 = loaded.contentSha256;
  }
  const event = await neonEvidence.createChangeEvent(pool, {
    workspaceId: pixelForgeWorkspaceId,
    projectId,
    revision,
    changeKind: 'animation-evidence',
    metadata: {
      commandId: command.command_id,
      action: command.action,
      contentSha256,
      capture: 'automatic-video',
      commandStatus,
      commandError: result?.message || result?.error || null,
      transport: neonEvidence.cloudflareEvidenceConfigured() ? 'cloudflare-r2' : 'neon-postgres-bytea'
    }
  });
  const objectKey = 'pixelforge/' + pixelForgeWorkspaceId + '/' + projectId +
    '/r' + revision + '/' + event.eventId + '.webm';
  let upload = null;
  if (neonEvidence.storageConfigured()) {
    upload = neonEvidence.presignStorageObject({
      objectKey,
      contentType: 'video/webm',
      expiresInSeconds: 900
    });
  }
  return {
    eventId: event.eventId,
    projectId,
    revision,
    objectKey,
    upload,
    publicUrl: upload?.publicUrl || null
  };
}

async function attachAnimationEvidence(evidence) {
  if (!evidence) return null;
  return neonEvidence.attachEvidence(pool, {
    workspaceId: pixelForgeWorkspaceId,
    eventId: evidence.eventId,
    kind: 'video',
    objectKey: evidence.objectKey,
    publicUrl: evidence.publicUrl
  });
}

async function finishAutomaticAnimationCapture(capture, command, evidence = null) {
  if (!capture) return null;
  const { browser, context, tempDir, projectId } = capture;
  let page;
  let video;
  const pageErrors = [];
  const consoleErrors = [];
  let captureState = '';
  try {
    // This page is created after the approved command has been persisted, so
    // it loads the new server revision rather than the pre-approval document.
    page = await context.newPage();
    page.on('pageerror', error => {
      if (pageErrors.length < 20) pageErrors.push(String(error.message || error).slice(0, 300));
    });
    page.on('console', message => {
      if (message.type() === 'error' && consoleErrors.length < 20) {
        consoleErrors.push(message.text().slice(0, 300));
      }
    });
    await page.addInitScript(({ id, token }) => {
      localStorage.setItem('codelab_xd_workspace_v4', id);
      localStorage.setItem('codelab_xd_workspace_token_v1', token);
    }, { id: workspaceId, token: workspaceTokenFor(workspaceId) });
    const response = await page.goto(capture.routeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!response || !response.ok()) {
      throw new Error('Automatic animation capture route returned HTTP ' + (response?.status() || 'no response'));
    }
    await page.waitForFunction(() => {
      const state = document.documentElement.dataset.pixelforgeCapture || '';
      return ['playing', 'complete', 'error', 'auth-required'].includes(state);
    }, null, { timeout: 45000 });
    const startup = await page.evaluate(() => ({
      state: document.documentElement.dataset.pixelforgeCapture || '',
      error: document.documentElement.dataset.pixelforgeCaptureError || ''
    }));
    captureState = startup.state;
    if (startup.state === 'auth-required') {
      throw new Error('Automatic animation capture still requires authentication after ADMIN handoff.');
    }
    if (startup.state === 'error') {
      throw new Error('Automatic animation capture could not start: ' + (startup.error || 'unknown capture error'));
    }
    if (startup.state !== 'complete') {
      await page.waitForFunction(() => document.documentElement.dataset.pixelforgeCapture === 'complete',
        null, { timeout: 70000 });
    }
    captureState = 'complete';
    video = page.video();
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    const videoPath = await video.path();
    const stat = fs.statSync(videoPath);
    if (!stat.isFile() || stat.size < 1000) throw new Error('Automatic animation recorder produced an invalid video.');
    if (stat.size > 24 * 1024 * 1024) throw new Error('Automatic animation video exceeds the 24 MiB artifact limit.');
    const bytes = fs.readFileSync(videoPath);
    let artifact;
    if (evidence?.upload) {
      artifact = await uploadNativeArtifact(evidence.upload, bytes, 'video/webm', 'pixelforge/');
      await attachAnimationEvidence(evidence);
    } else if (evidence) {
      await neonEvidence.attachEvidence(pool, {
        workspaceId: pixelForgeWorkspaceId,
        eventId: evidence.eventId,
        kind: 'video',
        objectKey: evidence.objectKey,
        publicUrl: null,
        data: bytes,
        mimeType: 'video/webm'
      });
      artifact = {
        stored: true,
        provider: 'neon-postgres-bytea',
        access: 'neon-row',
        objectKey: evidence.objectKey,
        mimeType: 'video/webm',
        sizeBytes: bytes.length
      };
    } else if (command.payload?.uploadTarget) {
      artifact = await uploadNativeArtifact(command.payload.uploadTarget, bytes, 'video/webm', 'codelab/exports/');
    } else if (bytes.length <= 8 * 1024 * 1024) {
      artifact = {
        stored: false,
        mimeType: 'video/webm',
        sizeBytes: bytes.length,
        dataBase64: bytes.toString('base64')
      };
    } else {
      throw new Error('Automatic animation video exceeds the inline result limit; provide uploadTarget.');
    }
    return {
      automaticCapture: {
        enabled: true,
        projectId,
        routeUrl: capture.routeUrl,
        format: 'webm',
        sizeBytes: bytes.length,
        viewport: { width: capture.width, height: capture.height },
        fps: capture.fps,
        captureState,
        evidenceState: 'playback-complete',
        artifact,
        ...(evidence ? {
          evidence: {
            eventId: evidence.eventId,
            projectId: evidence.projectId,
            revision: evidence.revision,
            objectKey: evidence.objectKey,
            publicUrl: evidence.publicUrl,
            provider: evidence.upload?.bucket === 'cloudflare-r2' ? 'cloudflare-r2' : 'neon-postgres-bytea',
            status: 'complete'
          }
        } : {}),
        pageErrors,
        consoleErrors,
        passed: captureState === 'complete' && pageErrors.length === 0 && consoleErrors.length === 0
      }
    };
  } finally {
    await browser.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}


async function uploadNativeArtifact(target, bytes, mimeType, keyPrefix) {
  if (!target || typeof target.url !== 'string' || typeof target.objectKey !== 'string' ||
      !target.objectKey.startsWith(keyPrefix) || target.objectKey.includes('..') ||
      !/^[a-zA-Z0-9._/-]+$/.test(target.objectKey)) {
    throw new Error('A valid artifact upload target under ' + keyPrefix + ' is required.');
  }
  const targetUrl = new URL(target.url);
  if (target.bucket === 'cloudflare-r2') {
    const expectedBase = String(process.env.CLOUDFLARE_EVIDENCE_BASE_URL || '').replace(/\/$/, '');
    if (!expectedBase) throw new Error('Cloudflare evidence base URL is not configured.');
    const expected = new URL(expectedBase);
    if (targetUrl.protocol !== 'https:' || targetUrl.hostname !== expected.hostname ||
        targetUrl.port !== expected.port || targetUrl.username || targetUrl.password) {
      throw new Error('Cloudflare evidence upload URL host validation failed.');
    }
  } else {
    const expectedHost = process.env.NEON_STORAGE_HOST || 'br-misty-sea-b5qkh03f.storage.c-7.us-east-2.aws.neon.tech';
    const captureBucket = String(process.env.NEON_CAPTURE_BUCKET || 'codelab-captures-public');
    const pathSegments = targetUrl.pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment));
    if (targetUrl.protocol !== 'https:' || targetUrl.hostname !== expectedHost ||
        targetUrl.port !== '' || targetUrl.username || targetUrl.password ||
        pathSegments[0] !== captureBucket || pathSegments.slice(1).join('/') !== target.objectKey) {
      throw new Error('Neon artifact URL must target the exact object in the configured public capture bucket.');
    }
  }
  const uploaded = await fetch(targetUrl, {
    method: 'PUT',
    redirect: 'error',
    headers: { 'Content-Type': mimeType },
    body: bytes,
    signal: AbortSignal.timeout(45000)
  });
  if (!uploaded.ok) throw new Error((target.bucket === 'cloudflare-r2' ? 'Cloudflare' : 'Neon') + ' artifact upload failed (HTTP ' + uploaded.status + ').');
  return {
    stored: true,
    provider: target.bucket === 'cloudflare-r2' ? 'cloudflare-r2' : 'neon-object-storage',
    bucket: target.bucket || String(process.env.NEON_CAPTURE_BUCKET || 'codelab-captures-public'),
    access: 'public_read',
    objectKey: target.objectKey,
    publicUrl: target.publicUrl || targetUrl.origin + targetUrl.pathname,
    mimeType,
    sizeBytes: bytes.length
  };
}
async function openCodeLabProjectRoute(project, context, page) {
  await context.addInitScript(({ id, token }) => {
    if (window.top !== window) return;
    localStorage.setItem('codelab_xd_workspace_v4', id);
    localStorage.setItem('codelab_xd_workspace_token_v1', token);
  }, { id: workspaceId, token: workspaceTokenFor(workspaceId) });
  const baseUrl = String(process.env.RENDER_EXTERNAL_URL || process.env.OAUTH_PUBLIC_URL ||
    ('http://127.0.0.1:' + String(process.env.PORT || 3000))).replace(/\/$/, '');
  const response = await page.goto(baseUrl + '/?projectId=' + encodeURIComponent(project.id), {
    waitUntil: 'domcontentloaded', timeout: 45000
  });
  if (!response || !response.ok()) {
    throw new Error('CodeLab project route returned HTTP ' + (response?.status() || 'no response'));
  }
  await page.waitForFunction(expectedName => {
    const studio = document.getElementById('studioView');
    const title = document.getElementById('currentProjectTitle');
    return !!studio && !studio.classList.contains('hidden') && !!title &&
      title.textContent.trim() === expectedName;
  }, project.name, { timeout: 45000 });
  await page.frameLocator('#previewIframe').locator('body').waitFor({ state: 'visible', timeout: 45000 });
  return { baseUrl, routeUrl: baseUrl + '/?projectId=' + encodeURIComponent(project.id) };
}
function isExpectedSandboxLocalStorageError(error) {
  return String(error && (error.message || error)).includes(
    "Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag."
  );
}
async function captureCodeLabProjectPng(project, payload = {}) {
  if (!project.code?.html || !/<!doctype html>/i.test(project.code.html)) {
    throw new Error('The saved project has no complete HTML document to capture.');
  }
  let browser;
  try {
    chromium.setGraphicsMode = false;
    browser = await playwrightChromium.launch({
      args: chromium.args, executablePath: await chromium.executablePath(),
      headless: true, timeout: 60000
    });
    const width = Number.isInteger(payload.width) ? Math.max(320, Math.min(2560, payload.width)) : 1440;
    const height = Number.isInteger(payload.height) ? Math.max(240, Math.min(1800, payload.height)) : 1000;
    const context = await browser.newContext({
      viewport: { width, height }, deviceScaleFactor: 1, colorScheme: 'dark'
    });
    const page = await context.newPage();
    const pageErrors = [];
    const warnings = [];
    page.on('pageerror', error => {
      const message = String(error.message || error).slice(0, 300);
      const target = isExpectedSandboxLocalStorageError(error) ? warnings : pageErrors;
      if (target.length < 20) target.push(message);
    });
    const route = await openCodeLabProjectRoute(project, context, page);
    const screenshot = payload.target === 'page'
      ? await page.screenshot({ type: 'png', fullPage: payload.full_page !== false, animations: 'disabled' })
      : await page.frameLocator('#previewIframe').locator('body').screenshot({ type: 'png', animations: 'disabled' });
    if (screenshot.length > 8 * 1024 * 1024) throw new Error('CodeLab PNG exceeds the 8 MiB artifact limit.');
    const staged = await stageNativeArtifact(pool, {
      workspaceId,
      kind: 'codelab_project_png',
      filename: String(project.name || 'codelab-project').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80) + '.png',
      contentType: 'image/png',
      bytes: screenshot,
      metadata: { projectId: project.id, revision: payload.revision ?? null, captureMethod: 'playwright-chromium-real-browser', viewport: { width, height } },
      ttlMs: 60 * 60 * 1000
    });
    const publicBase = String(process.env.RENDER_EXTERNAL_URL || process.env.OAUTH_PUBLIC_URL || '').replace(/\/$/, '');
    const artifact = {
      stored: true,
      provider: 'codelab-postgresql-artifact-store',
      access: 'unlisted_expiring_link',
      ...staged,
      downloadUrl: publicBase ? publicBase + '/api/agent/artifacts/' + staged.artifactId : null,
      mimeType: 'image/png',
      sizeBytes: screenshot.length
    };
    return {
      captureMethod: 'playwright-chromium-real-browser',
      projectId: project.id,
      revision: payload.revision ?? null,
      routeUrl: route.routeUrl,
      viewport: { width, height },
      pageErrors,
      warnings,
      passed: pageErrors.length === 0,
      artifact
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
async function recordCodeLabProjectVideo(project, payload = {}) {
  if (!project.code?.html || !/<!doctype html>/i.test(project.code.html)) {
    throw new Error('The saved project has no complete HTML document to record.');
  }
  const durationMs = Number.isInteger(payload.duration_ms)
    ? payload.duration_ms
    : 5000;
  if (durationMs < 1000 || durationMs > 30000) throw new Error('CodeLab project video duration must be from 1 to 30 seconds.');
  const width = Number.isInteger(payload.width) ? Math.max(320, Math.min(1920, payload.width)) : 1280;
  const height = Number.isInteger(payload.height) ? Math.max(240, Math.min(1080, payload.height)) : 720;
  const fps = Number.isInteger(payload.fps) ? payload.fps : 25;
  if (fps < 1 || fps > 60) throw new Error('CodeLab project video FPS must be from 1 to 60.');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codelab-project-video-'));
  let browser;
  try {
    chromium.setGraphicsMode = false;
    browser = await playwrightChromium.launch({
      args: chromium.args, executablePath: await chromium.executablePath(),
      headless: true, timeout: 60000
    });
    const context = await browser.newContext({
      viewport: { width, height }, deviceScaleFactor: 1,
      colorScheme: 'dark', recordVideo: { dir: tempDir, size: { width, height }, fps }
    });
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    const warnings = [];
    page.on('pageerror', error => {
      const message = String(error.message || error).slice(0, 300);
      const target = isExpectedSandboxLocalStorageError(error) ? warnings : pageErrors;
      if (target.length < 20) target.push(message);
    });
    page.on('console', message => {
      if (message.type() === 'error' && consoleErrors.length < 30) {
        consoleErrors.push(message.text().slice(0, 300));
      }
    });
    const route = await openCodeLabProjectRoute(project, context, page);
    await page.waitForTimeout(durationMs);
    const video = page.video();
    await page.close();
    await context.close();
    const videoPath = await video.path();
    const stat = fs.statSync(videoPath);
    if (!stat.isFile() || stat.size < 1000) throw new Error('Chromium did not produce a valid CodeLab project video.');
    if (stat.size > 24 * 1024 * 1024) throw new Error('CodeLab project video exceeds the 24 MiB artifact limit.');
    const bytes = fs.readFileSync(videoPath);
    const artifact = payload.uploadTarget
      ? await uploadNativeArtifact(payload.uploadTarget, bytes, 'video/webm', 'codelab/exports/')
      : (bytes.length <= 8 * 1024 * 1024
        ? { stored: false, mimeType: 'video/webm', sizeBytes: bytes.length, dataBase64: bytes.toString('base64') }
        : null);
    if (!artifact) throw new Error('Video exceeds the inline result limit; provide a presigned Neon uploadTarget.');
    return {
      captureMethod: 'playwright-chromium-real-browser',
      projectId: project.id,
      routeUrl: route.routeUrl,
      viewport: { width, height },
      format: 'webm',
      durationMs,
      fps,
      pageErrors,
      consoleErrors,
      warnings,
      nonFatalPageErrors: pageErrors.filter(error => error.includes("Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.")),
      passed: pageErrors.every(error => error.includes("Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.")) && consoleErrors.length === 0,
      artifact
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function inspectCodeLabProject(command) {
  const state = await loadAdminWorkspace();
  if (command.payload?.dashboard_test === true) {
    return { dashboardTest: await captureCodeLabDashboardBrowser(state) };
  }
  const projectId = command.payload?.project_id;
  if (typeof projectId !== 'string' || !/^proj_[a-zA-Z0-9_-]{1,100}$/.test(projectId)) {
    throw new Error('A valid CodeLab project_id is required.');
  }
  const project = state.projects.find(item => item && item.id === projectId);
  if (!project) throw new Error('CodeLab project not found in ADMIN workspace.');
  const inspection = {
    projectId, name: project.name, type: project.type,
    revision: state.revision, designElements: project.design?.elements?.length || 0,
    hasDesignSpace: !!project.hasDesignSpace, hasWebSpace: !!project.hasWebSpace,
    htmlBytes: Buffer.byteLength(project.code?.html || '', 'utf8'),
    hasInteractiveDemo: /data-codelab-demo/.test(project.code?.html || ''),
    updatedAt: project.updatedAt,
  };
  if (command.payload?.browser_test === true) {
    inspection.browserTest = await captureCodeLabProjectBrowser(project, command.payload);
  }
  return inspection;
}

function resolveProjectFrame(project, frameIndex) {
  if (frameIndex == null) return project;
  const frames = project?.animation?.frames;
  if (!Array.isArray(frames) || !Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= frames.length) {
    throw new Error('Requested animation frame does not exist.');
  }
  const frame = frames[frameIndex];
  const cels = Array.isArray(frame.cels) ? frame.cels : [];
  return {
    ...project,
    layers: project.layers.map(layer => {
      const cel = cels.find(item => item.layerId === layer.id);
      return cel && typeof cel.pixels === 'string' ? { ...layer, pixels: cel.pixels } : layer;
    }),
  };
}

function renderProjectSvg(project) {
  const width = Number(project?.width), height = Number(project?.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 1048576) throw new Error('Project dimensions are invalid for image export.');
  if (!Array.isArray(project.layers) || !project.layers.length) throw new Error('Project has no raster layers.');
  const layerMarkup = [];
  for (const layer of project.layers) {
    if (!layer || layer.visible === false) continue;
    const opacity = Math.max(0, Math.min(1, Number(layer.opacity ?? 1)));
    if (!opacity) continue;
    const pixels = Buffer.from(String(layer.pixels || ''), 'base64');
    if (pixels.length !== width * height * 4) throw new Error('A raster layer has an invalid RGBA buffer.');
    const paths = new Map();
    for (let y = 0; y < height; y++) {
      let x = 0;
      while (x < width) {
        const offset = (y * width + x) * 4, alpha = pixels[offset + 3] / 255;
        if (!alpha) { x++; continue; }
        const red = pixels[offset], green = pixels[offset + 1], blue = pixels[offset + 2];
        const color = '#' + [red, green, blue].map(value => value.toString(16).padStart(2, '0')).join('');
        const combinedOpacity = Math.round(alpha * opacity * 10000) / 10000, key = color + ':' + combinedOpacity;
        let run = 1;
        while (x + run < width) {
          const next = (y * width + x + run) * 4, nextAlpha = pixels[next + 3] / 255;
          if (!nextAlpha || pixels[next] !== red || pixels[next + 1] !== green || pixels[next + 2] !== blue ||
              Math.round(nextAlpha * opacity * 10000) / 10000 !== combinedOpacity) break;
          run++;
        }
        if (!paths.has(key)) paths.set(key, { color, opacity: combinedOpacity, commands: [] });
        paths.get(key).commands.push('M' + x + ' ' + y + 'h' + run + 'v1h-' + run + 'z');
        x += run;
      }
    }
    const pathMarkup = [...paths.values()].map(item => '<path fill="' + item.color + '" fill-opacity="' + item.opacity + '" d="' + item.commands.join('') + '"/>').join('');
    layerMarkup.push('<g>' + pathMarkup + '</g>');
  }
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '" shape-rendering="crispEdges">' + layerMarkup.join('') + '</svg>';
  return { svg, width, height };
}

async function migrateAdminPixelForgeProjectsToGuest() {
  if (workspaceId === pixelForgeWorkspaceId) return;
  const copied = await pool.query(
    `INSERT INTO codelab_pixelforge_projects
      (workspace_id, project_id, name, width, height, updated_at, last_opened_at, project, byte_size, server_revision, content_sha256)
     SELECT $1, project_id, name, width, height, updated_at, last_opened_at, project, byte_size, server_revision, content_sha256
       FROM codelab_pixelforge_projects WHERE workspace_id=$2
     ON CONFLICT (workspace_id, project_id) DO UPDATE SET
       name=EXCLUDED.name,
       width=EXCLUDED.width,
       height=EXCLUDED.height,
       updated_at=EXCLUDED.updated_at,
       last_opened_at=EXCLUDED.last_opened_at,
       project=EXCLUDED.project,
       byte_size=EXCLUDED.byte_size,
       server_revision=EXCLUDED.server_revision,
       content_sha256=EXCLUDED.content_sha256
     WHERE EXCLUDED.server_revision > codelab_pixelforge_projects.server_revision
        OR (EXCLUDED.server_revision = codelab_pixelforge_projects.server_revision
            AND EXCLUDED.content_sha256 IS DISTINCT FROM codelab_pixelforge_projects.content_sha256
            AND EXCLUDED.updated_at > codelab_pixelforge_projects.updated_at)`,
    [pixelForgeWorkspaceId, workspaceId]
  );
  console.log('[PixelForge] temporary guest workspace ready; copied projects:', copied.rowCount);
}

async function capturePixelForgeInterface(payload = {}) {
  const targetWorkspace = targetPixelForgeWorkspace(payload);
  if (payload.project_id !== undefined) {
    assertProjectId(payload.project_id);
    await loadProject(payload.project_id, targetWorkspace);
  }
  const width = Number.isInteger(payload.width) ? Math.max(640, Math.min(2560, payload.width)) : 1440;
  const height = Number.isInteger(payload.height) ? Math.max(480, Math.min(1800, payload.height)) : 1000;
  const zoom = Number.isFinite(payload.zoom) ? Math.max(1, Math.min(3, payload.zoom)) : 1;
  const baseUrl = String(process.env.RENDER_EXTERNAL_URL || process.env.OAUTH_PUBLIC_URL || ('http://127.0.0.1:' + String(process.env.PORT || 3000))).replace(/\/$/, '');
  let browser;
  try {
    chromium.setGraphicsMode = false;
    browser = await playwrightChromium.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
      defaultViewport: null
    });
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      isMobile: payload.mobile === true,
      hasTouch: payload.mobile === true,
      colorScheme: 'dark',
      reducedMotion: 'reduce'
    });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('pageerror', error => consoleErrors.push(String(error.message || error).slice(0, 300)));
    page.on('console', message => {
      if (message.type() === 'error' && consoleErrors.length < 20) consoleErrors.push(message.text().slice(0, 300));
    });
    // PixelForge's personal-project mode requires a CodeLab session. Establish
    // the same short-lived ADMIN handoff used by the trusted video recorder
    // before opening the capture route, otherwise the auth gate replaces #canvas.
    const handoff = await mintNativeAdminHandoff();
    const handoffResponse = await page.goto(handoff.handoffUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    if (!handoffResponse || !handoffResponse.ok()) {
      throw new Error('PixelForge capture ADMIN handoff returned HTTP ' + (handoffResponse?.status() || 'no response'));
    }
    const captureUrl = baseUrl + '/pixelforge/index.html?capture=1' +
      (payload.project_id ? '&projectId=' + encodeURIComponent(payload.project_id) : '');
    await page.addInitScript(({ id, token }) => {
      localStorage.setItem('codelab_xd_workspace_v4', id);
      localStorage.setItem('codelab_xd_workspace_token_v1', token);
    }, { id: targetWorkspace, token: workspaceTokenFor(targetWorkspace) });
    const response = await page.goto(captureUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });
    if (!response || !response.ok()) throw new Error('PixelForge page returned HTTP ' + (response?.status() || 'no response'));
    await page.waitForFunction(() => {
      const root = document.documentElement;
      return root.dataset.pixelforgeReady === 'true' ||
        root.dataset.pixelforgeCapture === 'auth-required' ||
        root.dataset.pixelforgeCapture === 'error';
    }, null, { timeout: 45000 });
    const bootState = await page.evaluate(() => ({
      ready: document.documentElement.dataset.pixelforgeReady === 'true',
      layout: document.documentElement.dataset.pixelforgeCaptureLayout || 'not-set',
      capture: document.documentElement.dataset.pixelforgeCapture || 'idle',
      error: document.documentElement.dataset.pixelforgeCaptureError || '',
      status: document.querySelector('#status')?.textContent || ''
    }));
    if (!bootState.ready) {
      throw new Error('PixelForge editor did not become capture-ready: ' + JSON.stringify(bootState));
    }
    await page.locator('#canvas').waitFor({ state: 'visible', timeout: 15000 });
    if (zoom !== 1) await page.evaluate(value => { document.documentElement.style.zoom = String(value); }, zoom);
    await page.waitForTimeout(250);
    const screenshot = await page.screenshot({
      type: 'png',
      fullPage: payload.full_page !== false,
      animations: 'disabled'
    });
    const artworkScreenshot = await page.locator('#canvas').screenshot({ type: 'png', animations: 'disabled' });
    if (screenshot.length > 5 * 1024 * 1024 || artworkScreenshot.length > 5 * 1024 * 1024) {
      throw new Error('A capture exceeds the 5 MiB image limit; request a smaller viewport or lower zoom.');
    }
    const interfaceDataUrl = 'data:image/png;base64,' + screenshot.toString('base64');
    const artworkDataUrl = 'data:image/png;base64,' + artworkScreenshot.toString('base64');
    const vision = createVisionSnapshot({
      mode: 'combined',
      interfaceImage: interfaceDataUrl,
      artworkImage: artworkDataUrl,
      project: { title: await page.title(), url: baseUrl + '/pixelforge/index.html' },
      viewport: { width, height, zoom, fullPage: payload.full_page !== false, deviceScaleFactor: 1 }
    });

    // Direct-to-Neon transfer is pinned to the public-read capture bucket.
    // Presigned URLs are supplied per capture by the trusted command issuer.
    // Private-bucket URLs are rejected so the bridge cannot silently keep using the old bucket.
    const captureBucket = String(process.env.NEON_CAPTURE_BUCKET || 'codelab-captures-public');
    if (captureBucket !== 'codelab-captures-public') throw new Error('NEON_CAPTURE_BUCKET must be codelab-captures-public.');
    const uploadTargets = payload.uploadTargets || (payload.uploadToPublic === true ? {
      interface: {
        url: process.env.NEON_CAPTURE_INTERFACE_UPLOAD_URL,
        objectKey: String(payload.interfaceObjectKey || 'pixelforge/captures/interface.png')
      },
      artwork: {
        url: process.env.NEON_CAPTURE_ARTWORK_UPLOAD_URL,
        objectKey: String(payload.artworkObjectKey || 'pixelforge/captures/artwork.png')
      }
    } : undefined);
    let storedImages = null;
    if (uploadTargets !== undefined && uploadTargets !== null) {
      const expectedHost = process.env.NEON_STORAGE_HOST || 'br-misty-sea-b5qkh03f.storage.c-7.us-east-2.aws.neon.tech';
      const uploadImage = async (target, bytes, role) => {
        if (!target || typeof target.url !== 'string' || typeof target.objectKey !== 'string' ||
            !target.objectKey.startsWith('pixelforge/captures/') || target.objectKey.includes('..') ||
            !/^[a-zA-Z0-9._/-]+$/.test(target.objectKey)) {
          throw new Error('Invalid Neon capture upload target for ' + role + '.');
        }
        let targetUrl;
        try { targetUrl = new URL(target.url); } catch { throw new Error('Invalid Neon presigned URL for ' + role + '.'); }
        if (targetUrl.protocol !== 'https:' || targetUrl.hostname !== expectedHost ||
          targetUrl.port !== '' || targetUrl.username || targetUrl.password) {
          throw new Error('Neon capture upload URL host validation failed for ' + role + '.');
        }
        const pathSegments = targetUrl.pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment));
        if (pathSegments[0] !== captureBucket || pathSegments.slice(1).join('/') !== target.objectKey) {
          throw new Error('Neon capture upload URL does not target the configured public bucket for ' + role + '.');
        }
        const uploaded = await fetch(targetUrl, {
          method: 'PUT',
          redirect: 'error',
          headers: { 'Content-Type': 'image/png' },
          body: bytes,
          signal: AbortSignal.timeout(30000)
        });
        if (!uploaded.ok) {
          throw new Error('Neon capture upload failed for ' + role + ' (HTTP ' + uploaded.status + ').');
        }
        return { role, objectKey: target.objectKey, publicUrl: targetUrl.origin + targetUrl.pathname, mimeType: 'image/png', sizeBytes: bytes.length, uploaded: true };
      };
      const [interfaceStored, artworkStored] = await Promise.all([
        uploadImage(uploadTargets.interface, screenshot, 'interface'),
        uploadImage(uploadTargets.artwork, artworkScreenshot, 'artwork')
      ]);
      storedImages = [interfaceStored, artworkStored];
    }

    return {
      captureMethod: 'playwright-chromium-real-browser',
      visionProtocol: 'pixelforge-headless-vision/v1',
      url: baseUrl + '/pixelforge/index.html',
      title: await page.title(),
      viewport: { width, height, zoom, fullPage: payload.full_page !== false },
      visionContext: vision.context,
      images: vision.images.map((item, index) => ({
        role: item.role,
        label: item.label,
        mimeType: 'image/png',
        ...(storedImages
          ? {
              objectKey: storedImages[index]?.objectKey,
              sizeBytes: storedImages[index]?.sizeBytes,
              stored: true,
              ...(payload.returnImagesInline === true
                ? { dataBase64: item.dataUrl.slice('data:image/png;base64,'.length) }
                : {})
            }
          : { dataBase64: item.dataUrl.slice('data:image/png;base64,'.length) })
      })),
      ...(storedImages ? { storage: { provider: 'neon-object-storage', bucket: captureBucket, access: 'public_read', objects: storedImages } } : {}),
      pageErrors: consoleErrors
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}


async function previewPixelForgeEvidenceVideo(payload = {}) {
  const targetWorkspace = targetPixelForgeWorkspace(payload);
  const eventId = String(payload.event_id || '');
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) throw new Error('A valid evidence event_id is required.');
  const result = await pool.query(
    'SELECT video_data, video_mime_type, project_id, revision FROM codelab_pixelforge_change_events WHERE workspace_id = $1 AND event_id = $2',
    [targetWorkspace, eventId]
  );
  const evidence = result.rows[0];
  if (!evidence || !evidence.video_data) throw new Error('Video evidence bytes were not found in Neon.');
  const videoBytes = Buffer.isBuffer(evidence.video_data) ? evidence.video_data : Buffer.from(evidence.video_data);
  let browser;
  try {
    chromium.setGraphicsMode = false;
    browser = await playwrightChromium.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
      timeout: 60000
    });
    const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><html><body style="margin:0;background:#111;display:grid;place-items:center;width:640px;height:480px"><video id="evidence" muted playsinline style="width:640px;height:480px;object-fit:contain"></video></body></html>');
    const sourceMimeType = evidence.video_mime_type || 'video/webm';
    const dataUrl = 'data:' + sourceMimeType + ';base64,' + videoBytes.toString('base64');
    await page.evaluate(src => {
      const video = document.getElementById('evidence');
      video.src = src;
      video.load();
    }, dataUrl);
    await page.waitForFunction(() => {
      const video = document.getElementById('evidence');
      return video && video.readyState >= 2 && Number.isFinite(video.duration) && video.videoWidth > 0;
    }, null, { timeout: 30000 });
    const videoInfo = await page.evaluate(() => {
      const video = document.getElementById('evidence');
      return { duration: video.duration, width: video.videoWidth, height: video.videoHeight, readyState: video.readyState };
    });
    const times = [...new Set([0.02, videoInfo.duration - 2.0, videoInfo.duration - 1.7, videoInfo.duration - 1.4, videoInfo.duration - 1.1, videoInfo.duration - 0.02]
      .map(time => Math.min(Math.max(0, time), Math.max(0, videoInfo.duration - 0.001))))];
    const frames = [];
    for (let index = 0; index < times.length; index += 1) {
      await page.evaluate(time => new Promise((resolve, reject) => {
        const video = document.getElementById('evidence');
        const onSeeked = () => resolve();
        video.addEventListener('seeked', onSeeked, { once: true });
        video.currentTime = time;
        setTimeout(() => reject(new Error('Timed out decoding video frame at ' + time)), 10000);
      }), times[index]);
      const png = await page.locator('#evidence').screenshot({ type: 'png' });
      frames.push({
        index,
        timeSeconds: times[index],
        pngBase64: png.toString('base64'),
        sha256: createHash('sha256').update(png).digest('hex'),
        bytes: png.length
      });
    }
    return {
      eventId,
      projectId: evidence.project_id,
      revision: evidence.revision,
      sourceMimeType,
      sourceBytes: videoBytes.length,
      sourceSha256: createHash('sha256').update(videoBytes).digest('hex'),
      decodedBy: 'Neon BYTEA → Playwright Chromium HTMLVideoElement',
      videoInfo,
      decodedFrameCount: frames.length,
      frames
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function exportPixelForgeAnimationVideo(payload = {}) {
  const targetWorkspace = targetPixelForgeWorkspace(payload);
  assertProjectId(payload.project_id);
  const loaded = await loadProject(payload.project_id, targetWorkspace);
  const project = loaded.project;
  const timeline = project.animation;
  if (!timeline || !Array.isArray(timeline.frames) || timeline.frames.length < 2) {
    throw new Error('The PixelForge project needs at least two animation frames to export a video.');
  }
  if (timeline.frames.length > 240) throw new Error('Animation export is limited to 240 frames.');
  const fps = Number.isInteger(payload.fps) ? payload.fps : Number(timeline.fps || 12);
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw new Error('Video FPS must be an integer from 1 to 60.');
  const frameDurationsMs = timeline.frames.map((frame, index) => {
    const rawDurationMs = Number(frame.durationMs);
    if (!Number.isFinite(rawDurationMs) || rawDurationMs < 20 || rawDurationMs > 10000) {
      throw new Error('Animation frame ' + index + ' has an invalid duration.');
    }
    // FPS-derived durations can be fractional (e.g. 1000 / 3). Quantize to
    // integer milliseconds for the browser recorder without rejecting them.
    return Math.round(rawDurationMs);
  });
  const totalDurationMs = frameDurationsMs.reduce((sum, duration) => sum + duration, 0);
  if (totalDurationMs > 60000) throw new Error('Video export is limited to 60 seconds per pass.');
  const width = Math.max(320, Math.min(1920, Number.isInteger(payload.width) ? payload.width : project.width * 4));
  const height = Math.max(240, Math.min(1080, Number.isInteger(payload.height) ? payload.height : project.height * 4));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codelab-pixelforge-video-'));
  let browser;
  try {
    chromium.setGraphicsMode = false;
    browser = await playwrightChromium.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
      timeout: 60000
    });
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      recordVideo: { dir: tempDir, size: { width, height }, fps }
    });
    await context.addInitScript(({ id, token }) => {
      localStorage.setItem('codelab_xd_workspace_v4', id);
      localStorage.setItem('codelab_xd_workspace_token_v1', token);
    }, { id: workspaceId, token: workspaceTokenFor(workspaceId) });
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', error => {
      if (pageErrors.length < 20) pageErrors.push(String(error.message || error).slice(0, 300));
    });
    page.on('console', message => {
      if (message.type() === 'error' && consoleErrors.length < 30) {
        consoleErrors.push(message.text().slice(0, 300));
      }
    });
    const baseUrl = String(process.env.RENDER_EXTERNAL_URL || process.env.OAUTH_PUBLIC_URL ||
      ('http://127.0.0.1:' + String(process.env.PORT || 3000))).replace(/\/$/, '');
    const routeUrl = baseUrl + '/pixelforge/index.html?projectId=' +
      encodeURIComponent(payload.project_id) + '&capture=video';
    const captureStartedAt = new Date().toISOString();

    // The browser recorder must have a real ADMIN session. A workspace token in
    // localStorage authorizes workspace APIs but does not authenticate the UI.
    const handoff = await mintNativeAdminHandoff();
    const handoffResponse = await page.goto(handoff.handoffUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!handoffResponse || !handoffResponse.ok()) {
      throw new Error('Native ADMIN browser handoff returned HTTP ' + (handoffResponse?.status() || 'no response'));
    }
    pageErrors.length = 0;
    consoleErrors.length = 0;
    await page.addInitScript(({ id, token }) => {
      localStorage.setItem('codelab_xd_workspace_v4', id);
      localStorage.setItem('codelab_xd_workspace_token_v1', token);
    }, { id: targetWorkspace, token: workspaceTokenFor(targetWorkspace) });

    const response = await page.goto(routeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!response || !response.ok()) {
      throw new Error('PixelForge video route returned HTTP ' + (response?.status() || 'no response'));
    }

    // Wait for PixelForge itself to report that the requested project animation
    // is playing or complete. A visible body alone can be the login/error screen.
    await page.waitForFunction(() => {
      const state = document.documentElement.dataset.pixelforgeCapture || '';
      return ['playing', 'complete', 'error', 'auth-required'].includes(state);
    }, null, { timeout: 45000 });
    const startupState = await page.evaluate(() => ({
      state: document.documentElement.dataset.pixelforgeCapture || '',
      error: document.documentElement.dataset.pixelforgeCaptureError || ''
    }));
    if (startupState.state === 'auth-required') {
      throw new Error('PixelForge capture still requires authentication after the native ADMIN handoff.');
    }
    if (startupState.state === 'error') {
      throw new Error('PixelForge could not start the saved animation: ' + (startupState.error || 'unknown capture error'));
    }
    const playbackReadyAt = new Date().toISOString();
    if (startupState.state !== 'complete') {
      await page.waitForFunction(() => document.documentElement.dataset.pixelforgeCapture === 'complete',
        null, { timeout: Math.min(70000, Math.max(15000, totalDurationMs + 15000)) });
    }
    const playbackCompletedAt = new Date().toISOString();
    const video = page.video();
    await page.close();
    await context.close();
    const videoPath = await video.path();
    const stat = fs.statSync(videoPath);
    if (!stat.isFile() || stat.size < 1000) throw new Error('Chromium did not produce a valid PixelForge animation video.');
    if (stat.size > 24 * 1024 * 1024) throw new Error('Animation video exceeds the 24 MiB artifact limit.');
    const videoBytes = fs.readFileSync(videoPath);
    const renderCompletedAt = new Date().toISOString();
    let artifact;
    let evidence = null;
    let uploadStartedAt = null;
    let uploadCompletedAt = null;
    let neonEvidenceAttachedAt = null;
    if (payload.uploadTarget !== undefined && payload.uploadTarget !== null) {
      uploadStartedAt = new Date().toISOString();
      artifact = await uploadNativeArtifact(payload.uploadTarget, videoBytes, 'video/webm', 'pixelforge/exports/');
      uploadCompletedAt = new Date().toISOString();
    } else if (payload.persist_evidence !== false) {
      // Create the Neon event before uploading so the event itself measures the
      // handoff path instead of hiding the upload behind a command result.
      evidence = await neonEvidence.createChangeEvent(pool, {
        workspaceId: targetWorkspace,
        projectId: payload.project_id,
        revision: loaded.serverRevision,
        changeKind: 'animation-evidence',
        metadata: {
          commandId: payload.command_id || null,
          action: 'pixelforge_export_animation_video',
          contentSha256: loaded.contentSha256,
          capture: 'explicit-video-export',
          transport: neonEvidence.cloudflareEvidenceConfigured() ? 'cloudflare-r2' : (neonEvidence.storageConfigured() ? 'neon-object-storage' : 'neon-postgres-bytea'),
          videoDurationMs: totalDurationMs
        }
      });
      const objectKey = 'pixelforge/' + targetWorkspace + '/' + payload.project_id +
        '/r' + loaded.serverRevision + '/' + evidence.eventId + '.webm';
      let upload = null;
      if (neonEvidence.storageConfigured()) {
        upload = neonEvidence.presignStorageObject({
          objectKey,
          contentType: 'video/webm',
          expiresInSeconds: 900
        });
      }
      uploadStartedAt = new Date().toISOString();
      if (upload) {
        artifact = await uploadNativeArtifact(upload, videoBytes, 'video/webm', 'pixelforge/');
        await neonEvidence.attachEvidence(pool, {
          workspaceId: pixelForgeWorkspaceId,
          eventId: evidence.eventId,
          kind: 'video',
          objectKey,
          publicUrl: upload.publicUrl || null
        });
      } else {
        await neonEvidence.attachEvidence(pool, {
          workspaceId: pixelForgeWorkspaceId,
          eventId: evidence.eventId,
          kind: 'video',
          objectKey,
          publicUrl: null,
          data: videoBytes,
          mimeType: 'video/webm'
        });
        artifact = {
          stored: true,
          provider: 'neon-postgres-bytea',
          access: 'neon-row',
          objectKey,
          mimeType: 'video/webm',
          sizeBytes: videoBytes.length
        };
      }
      uploadCompletedAt = new Date().toISOString();
      neonEvidenceAttachedAt = new Date().toISOString();
      evidence = {
        eventId: evidence.eventId,
        objectKey,
        publicUrl: upload?.publicUrl || null,
        provider: upload?.bucket === 'cloudflare-r2' ? 'cloudflare-r2' : 'neon-postgres-bytea',
        status: 'complete'
      };
    } else {
      if (videoBytes.length > 8 * 1024 * 1024) {
        throw new Error('Video exceeds the inline result limit; provide a presigned Neon uploadTarget.');
      }
      artifact = {
        stored: false,
        mimeType: 'video/webm',
        sizeBytes: videoBytes.length,
        dataBase64: videoBytes.toString('base64')
      };
    }
    const timing = {
      captureStartedAt,
      playbackReadyAt,
      playbackCompletedAt,
      renderCompletedAt,
      uploadStartedAt,
      uploadCompletedAt,
      neonEvidenceAttachedAt,
      renderToUploadMs: uploadStartedAt ? Date.parse(uploadStartedAt) - Date.parse(renderCompletedAt) : null,
      uploadMs: uploadStartedAt && uploadCompletedAt ? Date.parse(uploadCompletedAt) - Date.parse(uploadStartedAt) : null,
      renderDurationMs: Date.parse(renderCompletedAt) - Date.parse(captureStartedAt),
      totalToNeonEvidenceMs: neonEvidenceAttachedAt ? Date.parse(neonEvidenceAttachedAt) - Date.parse(captureStartedAt) : null,
      videoDurationMs: totalDurationMs,
      secondsPerVideoSecond: neonEvidenceAttachedAt
        ? ((Date.parse(neonEvidenceAttachedAt) - Date.parse(captureStartedAt)) / 1000) / (totalDurationMs / 1000)
        : null
    };
    return {
      exportMethod: 'playwright-chromium-real-pixelforge-app',
      captureState: 'complete',
      captureStartedState: startupState.state,
      captureError: startupState.error || null,
      projectId: payload.project_id,
      serverRevision: loaded.serverRevision,
      contentSha256: loaded.contentSha256,
      routeUrl,
      format: 'webm',
      timelineFps: fps,
      width,
      height,
      frameCount: timeline.frames.length,
      frameDurationsMs,
      durationMs: totalDurationMs,
      timing,
      evidence,
      pageErrors,
      consoleErrors,
      nonFatalPageErrors: pageErrors.filter(error => /localStorage.*sandboxed.*allow-same-origin/i.test(error)),
      passed: pageErrors.every(error => /localStorage.*sandboxed.*allow-same-origin/i.test(error)) && consoleErrors.length === 0,
      artifact
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function mintNativeAdminHandoff() {
  const token = workspaceTokenFor(workspaceId);
  const base = 'http://127.0.0.1:' + String(process.env.PORT || 3000);
  const response = await fetch(base + '/api/auth/native-handoff/mint', {
    method: 'POST',
    headers: { 'x-workspace-token': token, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok || data.ok !== true || !/^[a-f0-9]{48}$/.test(data.ticket || '')) {
    throw new Error('Native ADMIN handoff mint failed with HTTP ' + response.status + '.');
  }
  const publicBase = String(process.env.CODELAB_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'https://codelab-pbw9.onrender.com').replace(/\/+$/, '');
  return {
    status: 'ready',
    handoffUrl: publicBase + '/api/auth/native-handoff?ticket=' + encodeURIComponent(data.ticket),
    expiresInSeconds: Number(data.expiresInSeconds || 600),
    oneTime: true,
    workspaceId,
  };
}

async function executeExplicitCodeLabBrowser(command) {
  const payload = command.payload || {};
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codelab-browser-actions-'));
  try {
    const baseUrl = String(process.env.RENDER_EXTERNAL_URL || process.env.OAUTH_PUBLIC_URL ||
      ('http://127.0.0.1:' + String(process.env.PORT || 3000))).replace(/\/$/, '');
    return await executeCodeLabBrowserActions({
      ...payload,
      execution_mode: 'browser',
      baseUrl,
      workspaceId,
      workspaceToken: workspaceTokenFor(workspaceId),
      tempDir
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function validateAfterCommand(command) {
  if (!NATIVE_VALIDATION_ENABLED) return null;
  if (!command || !String(command.action || '').startsWith('pixelforge_')) return null;
  if (command.action === 'pixelforge_propose' || command.action === 'pixelforge_export_animation_video') return null;
  const projectId = typeof command.payload?.project_id === 'string' ? command.payload.project_id : null;
  if (!projectId) return null;
  const loaded = await loadProject(projectId);
  const { createNativeCodeLabValidationEngine } = await import('./public/codelab-native-validators.mjs');
  const engine = createNativeCodeLabValidationEngine();
  const result = await engine.validate('pixelforge', loaded.project, { options: { sourceAction: command.action } });
  return {
    status: result.ok ? 'passed' : 'validation_failed',
    ok: result.ok,
    validator: result.validator,
    score: result.score,
    issues: result.issues,
    details: result.details,
    projectId,
    serverRevision: loaded.serverRevision,
    contentSha256: loaded.contentSha256
  };
}

async function processCommand(command) {
  if (command.workspace_id !== workspaceId) throw new Error('Workspace is not authorized for this bridge.');
  await writeBridgeSignal('running', {
    wakeRequired: false,
    reason: 'command_started',
    metadata: {
      pid: process.pid,
      hostname: os.hostname(),
      source: 'agent-bridge-worker',
      commandId: command.command_id,
      action: command.action,
      projectId: command.payload?.project_id || null,
      commandStartedAt: new Date().toISOString()
    }
  });
  if (new Date(command.expires_at).getTime() < Date.now()) {
    await finish(command.command_id, 'expired', { error: 'command_expired' });
    return;
  }
  const payload = command.payload || {};
  const targetWorkspace = targetPixelForgeWorkspace(payload);
  switch (command.action) {
    case 'neon_function_invoke':
      await finish(command.command_id, 'succeeded', await invokeNeonFunction(payload));
      return;
    case 'codelab_project_import': {
      let stagedArtifact = null;
      if (payload.native_artifact_id) {
        stagedArtifact = await readNativeArtifact(
          pool,
          workspaceId,
          String(payload.native_artifact_id),
          'codelab_zip_upload'
        );
      }
      const result = await importCodeLabArtifact(pool, {
        importRequestId: payload.import_request_id,
        workspaceId,
        pixelForgeWorkspaceId,
        targetWorkspaceId: targetWorkspace,
        artifactBuffer: stagedArtifact?.bytes || null,
        artifactBase64: stagedArtifact ? null : (payload.artifact_base64 || payload.artifact?.dataBase64 || null),
        artifactFilename: stagedArtifact?.metadata?.filename || payload.artifact_filename || payload.artifact?.filename || 'project.codelab',
        artifactContentType: stagedArtifact?.metadata?.contentType || payload.artifact_content_type || payload.artifact?.contentType || 'application/zip',
      });
      if (stagedArtifact) {
        await deleteNativeArtifact(pool, workspaceId, String(payload.native_artifact_id));
      }
      const terminalStatus = result.status === 'awaiting_confirmation' ? 'succeeded' : 'succeeded';
      await finish(command.command_id, terminalStatus, result);
      return;
    }
    case 'codelab_project_create':
      await finish(command.command_id, 'succeeded', await createCodeLabProject(command));
      return;
    case 'codelab_project_convert_to_web':
      await finish(command.command_id, 'succeeded', await convertCodeLabProjectToWeb(command));
      return;
    case 'codelab_project_inspect':
      await finish(command.command_id, 'succeeded', await inspectCodeLabProject(command));
      return;
    case 'codelab_project_get_code':
      await finish(command.command_id, 'succeeded', await getCodeLabProjectCode(command));
      return;
    case 'codelab_project_update_code':
      await finish(command.command_id, 'succeeded', await updateCodeLabProjectCode(command));
      return;
    case 'codelab_project_capture_png': {
      const state = await loadAdminWorkspace();
      assertCodeLabProjectId(payload.project_id);
      const project = state.projects.find(item => item && item.id === payload.project_id);
      if (!project) throw new Error('CodeLab project not found in ADMIN workspace.');
      await finish(command.command_id, 'succeeded', await captureCodeLabProjectPng(project, { ...payload, revision: state.revision }));
      return;
    }
    case 'codelab_project_record_video': {
      const state = await loadAdminWorkspace();
      assertCodeLabProjectId(payload.project_id);
      const project = state.projects.find(item => item && item.id === payload.project_id);
      if (!project) throw new Error('CodeLab project not found in ADMIN workspace.');
      await finish(command.command_id, 'succeeded', await recordCodeLabProjectVideo(project, payload));
      return;
    }
    case 'codelab_ui_execute':
      await finish(command.command_id, 'succeeded', await executeExplicitCodeLabBrowser(command));
      return;
    case 'codelab_validate': {
      const { createNativeCodeLabValidationEngine } = await import('./public/codelab-native-validators.mjs');
      const engine = createNativeCodeLabValidationEngine();
      if (payload.operation === 'list') {
        await finish(command.command_id, 'succeeded', {
          ok: true,
          engineVersion: 1,
          validators: engine.list()
        });
        return;
      }
      const target = String(payload.target || '').trim();
      if (!target) throw new Error('validation_target_required');
      const input = payload.input !== undefined ? payload.input : payload;
      const result = await engine.validate(target, input, { options: payload.options || {} });
      await finish(command.command_id, result.ok ? 'succeeded' : 'failed', {
        status: result.ok ? 'passed' : 'validation_failed',
        ok: result.ok,
        engineVersion: result.version,
        validator: result.validator,
        score: result.score,
        issues: result.issues,
        details: result.details,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt
      });
      return;
    }
    case 'codelab_project_connect':
      await finish(command.command_id, 'succeeded', await connectCodeLabProject(command));
      return;
    case 'status':
      if (payload.operation === 'mint_admin_handoff') {
        await finish(command.command_id, 'succeeded', await mintNativeAdminHandoff());
        return;
      }
      await finish(command.command_id, 'succeeded', {
        status: 'online', protocol: 'codelab-native-headless/v1',
        workspaceId, runtime: 'PixelForge Headless',
        approvalRequired: true, persistence: 'PostgreSQL',
      });
      return;
    case 'pixelforge_import_zip': {
      const staged = await readNativeArtifact(pool, workspaceId, payload.artifact_id, 'pixelforge_zip_upload');
      const parsed = await parsePixelForgeProjectZip(staged.bytes, { importedName: payload.name });
      const saved = await persistImportedPixelForgeProject(parsed.project);
      await deleteNativeArtifact(pool, workspaceId, payload.artifact_id);
      await finish(command.command_id, 'succeeded', {
        imported: true,
        project: saved,
        package: { ...parsed.metadata, sha256: staged.metadata.sha256 }
      });
      return;
    }
    case 'pixelforge_export_zip': {
      assertProjectId(payload.project_id);
      const loaded = await loadProject(payload.project_id, targetWorkspace);
      const exported = await createPixelForgeProjectZip(loaded.project);
      const artifact = await stageNativeArtifact(pool, {
        workspaceId,
        kind: 'pixelforge_zip_export',
        filename: exported.metadata.projectName.replace(/[^a-z0-9_-]+/gi, '-') + '.pixelforge.zip',
        contentType: 'application/zip',
        bytes: exported.bytes,
        metadata: { projectId: payload.project_id, serverRevision: loaded.serverRevision, ...exported.metadata },
        ttlMs: 60 * 60 * 1000
      });
      await finish(command.command_id, 'succeeded', {
        exported: true,
        projectId: payload.project_id,
        serverRevision: loaded.serverRevision,
        package: exported.metadata,
        artifact
      });
      return;
    }
    case 'pixelforge_video_composer': {
      const result = await controlPixelForgeVideoComposer(
        { ...payload, target_workspace_id: targetWorkspace },
        {
          loadProject,
          targetPixelForgeWorkspace,
          workspaceTokenFor,
          storeArtifact: artifact => stageNativeArtifact(pool, {
            workspaceId,
            ...artifact,
            ttlMs: 60 * 60 * 1000
          })
        }
      );
      await finish(command.command_id, result.ok ? 'succeeded' : 'failed', result);
      return;
    }
    case 'pixelforge_create':
      await finish(command.command_id, 'succeeded', await createProject(payload));
      return;
    case 'pixelforge_list':
      await finish(command.command_id, 'succeeded', await listProjects());
      return;
    case 'pixelforge_inspect': {
      if (payload.operation === 'preview_video') {
        await finish(command.command_id, 'succeeded', await previewPixelForgeEvidenceVideo(payload));
        return;
      }
      assertProjectId(payload.project_id);
      const loaded = await loadProject(payload.project_id);
      const runtime = HeadlessEditorRuntime.fromJSON(loaded.project);
      if (payload.operation) {
        const operation = String(payload.operation);
        const actionByOperation = {
          model: { name: 'drawing.model.get' },
          sheet: { name: 'drawing.sheet.get' },
          object: { name: 'drawing.object.inspect', layerId: payload.layer_id, x: payload.x, y: payload.y, includeCoordinates: payload.include_coordinates !== false, gridStep: payload.grid_step ?? 8 },
          layer: { name: 'drawing.layer.inspect', layerId: payload.layer_id, includeCoordinates: payload.include_coordinates !== false, gridStep: payload.grid_step ?? 8 },
          references: { name: 'drawing.reference.list' },
          reference: { name: 'drawing.reference.get', referenceId: payload.reference_id },
          vector_model: { name: 'vector.model.get' },
          vector_audit: { name: 'vector.audit' },
          vector_svg: { name: 'vector.svg.export' },
        };
        const action = actionByOperation[operation];
        if (!action) throw new Error('Unsupported intelligence operation.');
        const intelligence = runtime.execute(action);
        if (!intelligence.ok) throw new Error(intelligence.error?.message || 'PixelForge intelligence operation failed.');
        await finish(command.command_id, 'succeeded', {
          inspection: compactInspection(runtime.inspect()),
          serverRevision: loaded.serverRevision,
          contentSha256: loaded.contentSha256,
          intelligence: { operation, result: intelligence.result },
        });
        return;
      }
      await finish(command.command_id, 'succeeded', {
        inspection: compactInspection(runtime.inspect()),
        serverRevision: loaded.serverRevision,
        contentSha256: loaded.contentSha256,
      });
      return;
    }
    case 'pixelforge_intelligence': {
      assertProjectId(payload.project_id);
      const loaded = await loadProject(payload.project_id);
      const runtime = HeadlessEditorRuntime.fromJSON(loaded.project);
      const operation = String(payload.operation || 'model');
      const actionByOperation = {
        model: { name: 'drawing.model.get' },
        sheet: { name: 'drawing.sheet.get' },
        object: {
          name: 'drawing.object.inspect',
          layerId: payload.layer_id,
          x: payload.x,
          y: payload.y,
          includeCoordinates: payload.include_coordinates !== false,
          gridStep: payload.grid_step ?? 8,
        },
        layer: {
          name: 'drawing.layer.inspect',
          layerId: payload.layer_id,
          includeCoordinates: payload.include_coordinates !== false,
          gridStep: payload.grid_step ?? 8,
        },
        references: { name: 'drawing.reference.list' },
        reference: { name: 'drawing.reference.get', referenceId: payload.reference_id },
        vector_model: { name: 'vector.model.get' },
        vector_audit: { name: 'vector.audit' },
        vector_svg: { name: 'vector.svg.export' },
      };
      const action = actionByOperation[operation];
      if (!action) throw new Error('Unsupported intelligence operation.');
      const result = runtime.execute(action);
      if (!result.ok) throw new Error(result.error?.message || 'PixelForge intelligence operation failed.');
      await finish(command.command_id, 'succeeded', {
        projectId: payload.project_id,
        serverRevision: loaded.serverRevision,
        operation,
        result: result.result,
      });
      return;
    }
    case 'pixelforge_animation_frame_context': {
      assertProjectId(payload.project_id);
      const loaded = await loadProject(payload.project_id);
      const runtime = HeadlessEditorRuntime.fromJSON(loaded.project);
      const result = runtime.execute({
        name: 'animation.frame.get_context',
        index: payload.index,
        ...(payload.layer_id ? { layerId: payload.layer_id } : {}),
      });
      if (!result.ok) throw new Error(result.error?.message || 'Animation frame context failed.');
      await finish(command.command_id, 'succeeded', {
        projectId: payload.project_id,
        serverRevision: loaded.serverRevision,
        context: result.result,
      });
      return;
    }
    case 'pixelforge_capture_interface':
      await finish(command.command_id, 'succeeded', await capturePixelForgeInterface({ ...payload, target_workspace_id: targetWorkspace }));
      return;
    case 'pixelforge_export_animation_video': {
      const result = await exportPixelForgeAnimationVideoComposer(
        { ...payload, target_workspace_id: targetWorkspace, command_id: command.command_id },
        { loadProject, targetPixelForgeWorkspace, uploadNativeArtifact, neonEvidence, pool, workspaceTokenFor, workspaceId }
      );
      await finish(command.command_id, result.videoExport?.passed ? 'succeeded' : 'failed', result);
      return;
    }
    case 'pixelforge_preview_evidence_video':
      await finish(command.command_id, 'succeeded', await previewPixelForgeEvidenceVideo(payload));
      return;
    case 'pixelforge_export_image': {
      // Backward-compatible mailbox envelope: the primary DB CHECK constraint
      // may not yet include pixelforge_capture_interface. Reuse this allowed action
      // only when the explicit operation discriminator is present.
      if (payload.operation === 'capture_interface') {
        await finish(command.command_id, 'succeeded', await capturePixelForgeInterface(payload));
        return;
      }
      assertProjectId(payload.project_id);
      const loaded = await loadProject(payload.project_id);
      const frameIndex = payload.frame_index == null ? (loaded.project.animation?.activeFrameIndex ?? null) : payload.frame_index;
      const frameProject = resolveProjectFrame(loaded.project, frameIndex);
      const rendered = renderProjectSvg(frameProject);
      await finish(command.command_id, 'succeeded', {
        projectId: payload.project_id,
        serverRevision: loaded.serverRevision,
        width: rendered.width,
        height: rendered.height,
        frameIndex,
        image: {
          mimeType: 'image/svg+xml',
          fileName: String(loaded.project.name || 'pixelforge-artwork').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80) + '.svg',
          dataBase64: Buffer.from(rendered.svg, 'utf8').toString('base64'),
        },
      });
      return;
    }
    case 'pixelforge_propose':
      await handleProposal(command);
      return;
    case 'pixelforge_approve':
      await finish(command.command_id, 'succeeded', await approveProposal(command));
      return;
    case 'pixelforge_discard': {
      if (typeof payload.proposal_command_id !== 'string' || typeof payload.proposal_token !== 'string') {
        throw new Error('proposal_command_id and proposal_token are required to discard a proposal.');
      }
      const result = await pool.query(
        "UPDATE codelab_agent_commands SET status='rejected',proposal_token=NULL,updated_at=now(),finished_at=now() WHERE command_id=$1 AND workspace_id=$2 AND status='awaiting_approval' AND proposal_token=$3 RETURNING command_id",
        [payload.proposal_command_id, workspaceId, payload.proposal_token]
      );
      if (!result.rowCount) throw new Error('Proposal token is invalid or proposal is no longer pending.');
      await finish(command.command_id, 'succeeded', { discarded: true, proposalCommandId: payload.proposal_command_id });
      return;
    }
    default:
      throw new Error('Unsupported native bridge action.');
  }
}
async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.codelab_agent_commands (
      command_id text PRIMARY KEY,
      workspace_id text NOT NULL,
      action text NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','awaiting_approval','succeeded','rejected','failed','expired')),
      result jsonb,
      proposal jsonb,
      proposal_token text,
      created_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      finished_at timestamptz,
      expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (jsonb_typeof(payload) = 'object')
    );
    CREATE INDEX IF NOT EXISTS codelab_agent_commands_queue_idx
      ON public.codelab_agent_commands (status, created_at)
      WHERE status = 'queued';
    CREATE INDEX IF NOT EXISTS codelab_agent_commands_workspace_idx
      ON public.codelab_agent_commands (workspace_id, created_at DESC);
  `);
  await ensureNativeArtifactSchema(pool);
  await pool.query(`
    DO $codelab_migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'codelab_agent_commands'::regclass
           AND conname = 'codelab_agent_commands_action_check'
           AND pg_get_constraintdef(oid) LIKE '%codelab_project_connect%'
           AND pg_get_constraintdef(oid) LIKE '%pixelforge_export_animation_video%'
           AND pg_get_constraintdef(oid) LIKE '%codelab_project_update_code%'
           AND pg_get_constraintdef(oid) LIKE '%codelab_project_record_video%'
           AND pg_get_constraintdef(oid) LIKE '%codelab_ui_execute%'
           AND pg_get_constraintdef(oid) LIKE '%neon_function_invoke%'
           AND pg_get_constraintdef(oid) LIKE '%codelab_project_capture_png%'
           AND pg_get_constraintdef(oid) LIKE '%pixelforge_import_zip%'
           AND pg_get_constraintdef(oid) LIKE '%pixelforge_export_zip%'
           AND pg_get_constraintdef(oid) LIKE '%pixelforge_video_composer%'
      ) THEN
        ALTER TABLE codelab_agent_commands
          DROP CONSTRAINT IF EXISTS codelab_agent_commands_action_check;
        ALTER TABLE codelab_agent_commands
          ADD CONSTRAINT codelab_agent_commands_action_check
          CHECK (action = ANY (ARRAY[
            'status','pixelforge_create','pixelforge_list','pixelforge_inspect',
            'pixelforge_propose','pixelforge_approve','pixelforge_discard','pixelforge_animation_frame_context',
            'pixelforge_export_image','pixelforge_capture_interface','pixelforge_export_animation_video',
            'pixelforge_intelligence','pixelforge_preview_evidence_video',
            'pixelforge_import_zip','pixelforge_export_zip','pixelforge_video_composer',
            'codelab_project_create','codelab_project_convert_to_web',
            'codelab_project_inspect','codelab_project_connect',
            'codelab_project_get_code','codelab_project_update_code',
            'codelab_project_capture_png','codelab_project_record_video','codelab_ui_execute',
            'codelab_validate','codelab_project_import','neon_function_invoke'
          ]));
      END IF;
    END
    $codelab_migration$;
  `);
  workspaceId = await resolveAdminWorkspace();
  await ensureBridgeSignalSchema();
  await writeBridgeSignal('running', {
    wakeRequired: false,
    reason: 'bridge_started',
    metadata: { pid: process.pid, hostname: os.hostname(), source: 'agent-bridge-worker' }
  });
  await connectCommandWakeListener();
  if (String(process.env.PIXELFORGE_GUEST_MODE || 'false').toLowerCase() === 'false') {
    pixelForgeWorkspaceId = workspaceId;
  } else {
    await migrateAdminPixelForgeProjectsToGuest();
  }
  console.log('[CodeLab Native Bridge] online for mailbox workspace', workspaceId, 'and PixelForge workspace', pixelForgeWorkspaceId);
  while (!stopping) {
    try {
      const observedWakeVersion = wakeVersion;
      const command = await claimCommand();
      if (!command) {
        await waitForCommandWake(observedWakeVersion);
        continue;
      }
      const heartbeatTimer = setInterval(() => {
        pool.query(
          "UPDATE codelab_agent_commands SET updated_at=now() WHERE command_id=$1 AND workspace_id=$2 AND status='running'",
          [command.command_id, workspaceId]
        ).catch(error => console.error('[CodeLab Native Bridge] heartbeat failed:', command.command_id, error.message));
      }, 30000);
      heartbeatTimer.unref?.();
      let automaticAnimationCapture = null;
      let commandError = null;
      try {
        automaticAnimationCapture = await startAutomaticAnimationCapture(command).catch(error => {
          console.error('[CodeLab Native Bridge] automatic animation capture start failed:', command.command_id, error.message);
          return { startupError: String(error.message || 'Automatic animation capture failed.').slice(0, 500) };
        });
        try {
          await processCommand(command);
          const validation = await validateAfterCommand(command).catch(error => ({
            status: 'validation_error',
            ok: false,
            validator: command.action,
            score: 0,
            issues: [{
              code: 'native_validation_exception',
              severity: 'fatal',
              message: String(error.message || error)
            }]
          }));
          if (validation) {
            const validationStatus = validation.ok ? null : 'failed';
            await pool.query(
              "UPDATE codelab_agent_commands SET status=COALESCE($4,status), result=COALESCE(result,'{}'::jsonb) || $2::jsonb, finished_at=CASE WHEN $4='failed' THEN now() ELSE finished_at END, updated_at=now() WHERE command_id=$1 AND workspace_id=$3",
              [command.command_id, JSON.stringify({ nativeValidation: validation }), workspaceId, validationStatus]
            );
            if (!validation.ok && !commandError) {
              commandError = new Error('Native validation failed after command execution.');
            }
          }
        } catch (error) {
          commandError = error;
          console.error('[CodeLab Native Bridge] command failed:', command.command_id, error.message);
          await finish(command.command_id, 'failed', {
            error: 'command_failed',
            message: String(error.message || 'Unknown bridge error').slice(0, 1000),
          }).catch(() => {});
        }

        // Evidence is independent from command success. A failed/partial operation
        // still produces the visual state that the agent needs for diagnosis.
        let animationEvidence = null;
        if (automaticAnimationCapture && !automaticAnimationCapture.startupError) {
          try {
            animationEvidence = await prepareAnimationEvidence(command);
            const captureResult = await finishAutomaticAnimationCapture(automaticAnimationCapture, command, animationEvidence);
            await pool.query(
              "UPDATE codelab_agent_commands SET result=COALESCE(result,'{}'::jsonb) || $2::jsonb, updated_at=now() WHERE command_id=$1 AND workspace_id=$3",
              [command.command_id, JSON.stringify(captureResult), workspaceId]
            );
          } catch (captureError) {
            if (animationEvidence) {
              await pool.query(
                "UPDATE codelab_pixelforge_change_events SET status='failed', metadata=metadata || $2::jsonb, updated_at=now() WHERE workspace_id=$1 AND event_id=$3",
                [pixelForgeWorkspaceId, JSON.stringify({
                  captureError: String(captureError.message || captureError).slice(0, 500),
                  commandError: commandError ? String(commandError.message || commandError).slice(0, 500) : null
                }), animationEvidence.eventId]
              ).catch(() => {});
            }
            await pool.query(
              "UPDATE codelab_agent_commands SET result=COALESCE(result,'{}'::jsonb) || $2::jsonb, updated_at=now() WHERE command_id=$1 AND workspace_id=$3",
              [command.command_id, JSON.stringify({ automaticCapture: { enabled: true, error: String(captureError.message || captureError).slice(0, 500) } }), workspaceId]
            ).catch(() => {});
            console.error('[CodeLab Native Bridge] automatic animation capture finish failed:', command.command_id, captureError.message);
          }
        } else if (automaticAnimationCapture?.startupError) {
          await pool.query(
            "UPDATE codelab_agent_commands SET result=COALESCE(result,'{}'::jsonb) || $2::jsonb, updated_at=now() WHERE command_id=$1 AND workspace_id=$3",
            [command.command_id, JSON.stringify({
              automaticCapture: {
                enabled: true,
                error: automaticAnimationCapture.startupError,
                commandError: commandError ? String(commandError.message || commandError).slice(0, 500) : null
              }
            }), workspaceId]
          ).catch(() => {});
        }
      } finally {
        clearInterval(heartbeatTimer);
      }
    } catch (error) {
      console.error('[CodeLab Native Bridge] mailbox error:', error.message);
      await delay(2500);
    }
  }
}
async function shutdown(reason) {
  stopping = true;
  signalCommandWake();
  await emitShutdownSignal(reason);
  if (wakeClient) {
    try { await wakeClient.end(); } catch (_) {}
    wakeClient = null;
  }
  await pool.end().catch(() => {});
}
process.once('SIGTERM', () => { void shutdown('sigterm'); });
process.once('SIGINT', () => { void shutdown('sigint'); });
main().catch(async error => {
  console.error('[CodeLab Native Bridge] fatal:', error);
  try {
    if (!workspaceId) workspaceId = await resolveAdminWorkspace().catch(() => workspaceId);
    await emitShutdownSignal('fatal');
  } finally {
    await pool.end().catch(() => {});
  }
  process.exitCode = 1;
});
