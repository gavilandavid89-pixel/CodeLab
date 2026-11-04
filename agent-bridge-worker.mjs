import { createRequire } from 'node:module';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { HeadlessEditorRuntime } from './public/pixelforge/src/headless.js';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');
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
const POLL_MS = 700;
const PROPOSAL_TTL_MS = 15 * 60 * 1000;
let stopping = false;
let workspaceId;

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
      "UPDATE codelab_agent_commands SET status='queued', started_at=NULL, updated_at=now() WHERE status='running' AND started_at < now() - interval '3 minutes' AND expires_at > now()"
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
}
async function loadProject(projectId) {
  const result = await pool.query(
    'SELECT project, server_revision, content_sha256 FROM codelab_pixelforge_projects WHERE workspace_id=$1 AND project_id=$2',
    [workspaceId, projectId]
  );
  if (!result.rowCount) throw new Error('PixelForge project not found in the ADMIN workspace.');
  return {
    project: result.rows[0].project,
    serverRevision: Number(result.rows[0].server_revision || 0),
    contentSha256: result.rows[0].content_sha256,
  };
}
async function listProjects() {
  const result = await pool.query(
    'SELECT project_id AS id, name, width, height, updated_at AS "updatedAt", last_opened_at AS "lastOpenedAt", server_revision AS "serverRevision" FROM codelab_pixelforge_projects WHERE workspace_id=$1 ORDER BY last_opened_at DESC',
    [workspaceId]
  );
  return { workspaceId, count: result.rowCount, projects: result.rows };
}
function assertProjectId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) {
    throw new Error('A valid PixelForge project_id is required.');
  }
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
  const runtime = HeadlessEditorRuntime.fromJSON(loaded.project);
  const batch = runtime.executeBatch(payload.actions);
  if (!batch.ok) throw new Error('Headless batch failed at action ' + batch.failedIndex + ': ' + (batch.error?.message || 'unknown error'));
  if (!runtime.hasPendingChanges) throw new Error('The proposed batch did not change the project.');
  const proposalInfo = runtime.createProposal(payload.summary.trim());
  const diff = runtime.getDiff();
  const inspection = compactInspection(runtime.inspect());
  const proposalToken = randomBytes(32).toString('hex');
  const proposal = {
    projectId: payload.project_id,
    baseServerRevision: loaded.serverRevision,
    actions: payload.actions,
    summary: payload.summary.trim(),
    proposalInfo,
    diff: {
      width: diff.width, height: diff.height,
      changedPixels: diff.changedPixels,
      rasterChangedPixels: diff.rasterChangedPixels,
      animationChangedPixels: diff.animationChangedPixels,
      bounds: diff.bounds,
      animation: diff.animation,
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
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [workspaceId]);
    const current = await client.query(
      'SELECT server_revision FROM codelab_pixelforge_projects WHERE workspace_id=$1 AND project_id=$2 FOR UPDATE',
      [workspaceId, projectId]
    );
    if (!current.rowCount || Number(current.rows[0].server_revision || 0) !== expectedRevision) {
      throw new Error('Revision conflict: saved project changed after the proposal was prepared.');
    }
    const usage = await client.query(
      'SELECT COUNT(*)::int AS count, COALESCE(SUM(byte_size),0)::bigint AS bytes FROM codelab_pixelforge_projects WHERE workspace_id=$1',
      [workspaceId]
    );
    const stored = { ...document, serverRevision: expectedRevision + 1 };
    const serialized = JSON.stringify(stored);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > MAX_PROJECT_BYTES) throw new Error('Project exceeds the PixelForge project storage limit.');
    if (Number(usage.rows[0].bytes) - 0 + bytes > MAX_ACCOUNT_BYTES) {
      const prior = await client.query(
        'SELECT byte_size FROM codelab_pixelforge_projects WHERE workspace_id=$1 AND project_id=$2',
        [workspaceId, projectId]
      );
      if (Number(usage.rows[0].bytes) - Number(prior.rows[0].byte_size) + bytes > MAX_ACCOUNT_BYTES) {
        throw new Error('PixelForge account storage limit reached.');
      }
    }
    const sha = createHash('sha256').update(serialized).digest('hex');
    const now = Date.now();
    await client.query(
      'UPDATE codelab_pixelforge_projects SET name=$3,width=$4,height=$5,updated_at=$6,last_opened_at=$6,project=$7::jsonb,byte_size=$8,server_revision=$9,content_sha256=$10 WHERE workspace_id=$1 AND project_id=$2',
      [workspaceId, projectId, stored.name, stored.width, stored.height, now, serialized, bytes, expectedRevision + 1, sha]
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
async function processCommand(command) {
  if (command.workspace_id !== workspaceId) throw new Error('Workspace is not authorized for this bridge.');
  if (new Date(command.expires_at).getTime() < Date.now()) {
    await finish(command.command_id, 'expired', { error: 'command_expired' });
    return;
  }
  const payload = command.payload || {};
  switch (command.action) {
    case 'status':
      await finish(command.command_id, 'succeeded', {
        status: 'online', protocol: 'codelab-native-headless/v1',
        workspaceId, runtime: 'PixelForge Headless',
        approvalRequired: true, persistence: 'PostgreSQL',
      });
      return;
    case 'pixelforge_list':
      await finish(command.command_id, 'succeeded', await listProjects());
      return;
    case 'pixelforge_inspect': {
      assertProjectId(payload.project_id);
      const loaded = await loadProject(payload.project_id);
      const runtime = HeadlessEditorRuntime.fromJSON(loaded.project);
      await finish(command.command_id, 'succeeded', {
        inspection: compactInspection(runtime.inspect()),
        serverRevision: loaded.serverRevision,
        contentSha256: loaded.contentSha256,
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
  workspaceId = await resolveAdminWorkspace();
  console.log('[CodeLab Native Bridge] online for workspace', workspaceId);
  while (!stopping) {
    try {
      const command = await claimCommand();
      if (!command) {
        await delay(POLL_MS);
        continue;
      }
      try {
        await processCommand(command);
      } catch (error) {
        console.error('[CodeLab Native Bridge] command failed:', command.command_id, error.message);
        await finish(command.command_id, 'failed', {
          error: 'command_failed',
          message: String(error.message || 'Unknown bridge error').slice(0, 1000),
        }).catch(() => {});
      }
    } catch (error) {
      console.error('[CodeLab Native Bridge] poll error:', error.message);
      await delay(2500);
    }
  }
}
process.on('SIGTERM', () => { stopping = true; pool.end().catch(() => {}); });
process.on('SIGINT', () => { stopping = true; pool.end().catch(() => {}); });
main().catch(error => {
  console.error('[CodeLab Native Bridge] fatal:', error);
  process.exitCode = 1;
});
