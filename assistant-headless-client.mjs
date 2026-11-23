import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { ensureNativeArtifactSchema, stageNativeArtifact, readNativeArtifact, deleteNativeArtifact } from './native-agent-artifacts.mjs';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');

export const NATIVE_ACTIONS = Object.freeze([
  'status',
  'codelab_project_create',
  'codelab_project_convert_to_web',
  'codelab_project_inspect',
  'codelab_project_connect',
  'codelab_project_get_code',
  'codelab_project_update_code',
  'codelab_project_capture_png',
  'codelab_project_record_video',
  'codelab_ui_execute',
  'codelab_project_import',
  'codelab_validate',
  'neon_function_invoke',
  'pixelforge_create',
  'pixelforge_list',
  'pixelforge_inspect',
  'pixelforge_intelligence',
  'pixelforge_animation_frame_context',
  'pixelforge_capture_interface',
  'pixelforge_preview_evidence_video',
  'pixelforge_export_image',
  'pixelforge_export_animation_video',
  'pixelforge_import_zip',
  'pixelforge_export_zip',
  'pixelforge_video_composer',
  'pixelforge_propose',
  'pixelforge_approve',
  'pixelforge_discard'
]);

export function validateCommandInput(action, payload = {}, ttlMs = 120000) {
  if (!NATIVE_ACTIONS.includes(action)) throw new TypeError('Unsupported CodeLab native action: ' + action);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('Native command payload must be a JSON object.');
  }
  if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 15 * 60 * 1000) {
    throw new RangeError('Native command TTL must be between 1 second and 15 minutes.');
  }
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > 2 * 1024 * 1024) {
    throw new RangeError('Native command payload exceeds 2 MiB.');
  }
  return { action, payload: JSON.parse(serialized), ttlMs };
}

export function createAssistantHeadlessClient(options = {}) {
  const connectionString = String(options.connectionString || process.env.DATABASE_URL || '').trim();
  if (!options.pool && !connectionString) throw new Error('DATABASE_URL is required by the assistant headless client.');
  const pool = options.pool || new Pool({
    connectionString,
    ssl: options.ssl === false || process.env.CODELAB_DATABASE_SSL === 'disable'
      ? false
      : { rejectUnauthorized: false },
    max: 2,
    idleTimeoutMillis: 15000,
    connectionTimeoutMillis: 10000
  });
  const pollIntervalMs = Number.isInteger(options.pollIntervalMs)
    ? Math.max(100, Math.min(5000, options.pollIntervalMs))
    : 200;
  const appBaseUrl = String(options.baseUrl || process.env.CODELAB_BASE_URL ||
    'https://codelab-pbw9.onrender.com').replace(/\/+$/, '');
  const wakeTimeoutMs = Number.isInteger(options.wakeTimeoutMs)
    ? Math.max(5000, Math.min(120000, options.wakeTimeoutMs))
    : 120000;
  let workspaceIdPromise;
  let healthCache = null;

  async function getWorkspaceId() {
    if (!workspaceIdPromise) {
      workspaceIdPromise = pool.query(
        "SELECT id FROM codelab_accounts WHERE username='ADMIN' AND role='admin' LIMIT 1"
      ).then(result => {
        if (!result.rowCount) throw new Error('CodeLab ADMIN account is not configured in the connected database.');
        const id = String(result.rows[0].id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
        if (!id) throw new Error('CodeLab ADMIN workspace identity is invalid.');
        return 'ws_local_' + id;
      }).catch(error => {
        workspaceIdPromise = null;
        throw error;
      });
    }
    return workspaceIdPromise;
  }

  async function wakeWorker() {
    if (healthCache && Date.now() - healthCache.at < 5000) return healthCache.value;
    const response = await fetch(appBaseUrl + '/api/health', {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(wakeTimeoutMs)
    });
    let health;
    try { health = await response.json(); } catch { health = null; }
    if (!response.ok || health?.ok !== true) {
      throw new Error('CodeLab service did not become healthy before native command submission (HTTP ' + response.status + ').');
    }
    const value = { ok: true, version: health.version || null, baseUrl: appBaseUrl };
    healthCache = { at: Date.now(), value };
    return value;
  }

  async function submit(action, payload = {}, commandOptions = {}) {
    const submittedAt = Date.now();
    const ttlMs = commandOptions.ttlMs ?? 120000;
    const normalized = validateCommandInput(action, payload, ttlMs);
    const workspaceId = await getWorkspaceId();
    await wakeWorker();
    const commandId = randomUUID();
    const expiresAt = new Date(Date.now() + normalized.ttlMs);
    await pool.query(
      "INSERT INTO codelab_agent_commands " +
      "(command_id, workspace_id, action, payload, status, expires_at, created_at, updated_at) " +
      "VALUES ($1, $2, $3, $4::jsonb, 'queued', $5, now(), now())",
      [commandId, workspaceId, normalized.action, JSON.stringify(normalized.payload), expiresAt]
    );
    return { commandId, workspaceId, action, expiresAt: expiresAt.toISOString(), submittedAt };
  }

  async function getCommand(commandId) {
    if (typeof commandId !== 'string' || !/^[a-f0-9-]{36}$/i.test(commandId)) {
      throw new TypeError('A valid native command ID is required.');
    }
    const workspaceId = await getWorkspaceId();
    const result = await pool.query(
      'SELECT command_id, action, status, result, proposal, proposal_token, expires_at, ' +
      'created_at, started_at, finished_at, updated_at FROM codelab_agent_commands ' +
      'WHERE command_id=$1 AND workspace_id=$2',
      [commandId, workspaceId]
    );
    if (!result.rowCount) throw new Error('Native command was not found in the ADMIN workspace.');
    const row = result.rows[0];
    return {
      commandId: row.command_id,
      action: row.action,
      status: row.status,
      result: row.result,
      proposal: row.proposal,
      proposalToken: row.proposal_token,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      updatedAt: row.updated_at
    };
  }

  async function wait(commandId, waitOptions = {}) {
    const timeoutMs = Number.isInteger(waitOptions.timeoutMs)
      ? Math.max(1000, Math.min(15 * 60 * 1000, waitOptions.timeoutMs))
      : 120000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const command = await getCommand(commandId);
      if (['succeeded', 'failed', 'rejected', 'expired'].includes(command.status)) {
        const finishedAt = command.finishedAt ? new Date(command.finishedAt).getTime() : Date.now();
        const startedAt = command.startedAt ? new Date(command.startedAt).getTime() : null;
        return { ...command, latency: { totalMs: Math.max(0, finishedAt - (command.createdAt ? new Date(command.createdAt).getTime() : deadline - timeoutMs)), queueMs: startedAt ? Math.max(0, startedAt - new Date(command.createdAt).getTime()) : null, executionMs: startedAt ? Math.max(0, finishedAt - startedAt) : null } };
      }
      if (command.status === 'awaiting_approval') return command;
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    return { ...(await getCommand(commandId)), timedOut: true };
  }

  async function run(action, payload = {}, commandOptions = {}) {
    const submitted = await submit(action, payload, commandOptions);
    const timeoutMs = commandOptions.timeoutMs ?? Math.min(15 * 60 * 1000, (commandOptions.ttlMs ?? 120000) + 5000);
    return { ...submitted, ...(await wait(submitted.commandId, { timeoutMs })) };
  }

  return Object.freeze({
    getWorkspaceId,
    wakeWorker,
    submit,
    getCommand,
    wait,
    run,
    status: () => run('status'),
    importCodeLabArtifact: payload => run('codelab_project_import', payload || {}, { ttlMs: payload?.ttlMs ?? 180000, timeoutMs: payload?.timeoutMs ?? 185000 }),
    validateCodeLab: payload => run('codelab_validate', payload || {}),
    invokeNeonFunction: payload => run('neon_function_invoke', payload || {}),
    createCodeLabProject: options => run('codelab_project_create', options || {}),
    convertCodeLabProjectToWeb: projectId => run('codelab_project_convert_to_web', { project_id: projectId }),
    inspectCodeLabProject: (projectId, options = {}) => run('codelab_project_inspect', {
      project_id: projectId, ...options
    }),
    connectCodeLabProject: options => run('codelab_project_connect', options || {}),
    readCode: projectId => run('codelab_project_get_code', { project_id: projectId }),
    updateCode: (projectId, code, baseRevision) => run('codelab_project_update_code', {
      project_id: projectId, code, ...(baseRevision === undefined ? {} : { base_revision: baseRevision })
    }),
    captureCodeLabPng: (projectId, options = {}) => run('codelab_project_capture_png', {
      project_id: projectId, ...options
    }),
    recordCodeLabVideo: (projectId, options = {}) => run('codelab_project_record_video', {
      project_id: projectId, ...options
    }, { ttlMs: options.ttlMs ?? 180000, timeoutMs: options.timeoutMs ?? 185000 }),
    executeCodeLabUi: (actions, options = {}) => {
      if (!Array.isArray(actions) || actions.length < 1) throw new TypeError('Browser UI execution requires at least one action.');
      return run('codelab_ui_execute', {
        execution_mode: 'browser',
        actions,
        ...(options.start_path ? { start_path: options.start_path } : {}),
        ...(options.width ? { width: options.width } : {}),
        ...(options.height ? { height: options.height } : {})
      }, { ttlMs: options.ttlMs ?? 120000, timeoutMs: options.timeoutMs ?? 125000 });
    },
    createPixelForgeProject: options => run('pixelforge_create', options || {}),
    importPixelForgeZip: async (input, options = {}) => {
      const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
      if (!bytes.length || bytes.length > 256 * 1024 * 1024) throw new RangeError('PixelForge ZIP import must be between 1 byte and 256 MiB.');
      await ensureNativeArtifactSchema(pool);
      const workspaceId = await getWorkspaceId();
      const staged = await stageNativeArtifact(pool, {
        workspaceId,
        kind: 'pixelforge_zip_upload',
        filename: options.filename || 'pixelforge-import.zip',
        contentType: 'application/zip',
        bytes,
        metadata: { source: 'assistant-headless-client' },
        ttlMs: options.ttlMs ?? 60 * 60 * 1000
      });
      try {
        const outcome = await run('pixelforge_import_zip', {
          artifact_id: staged.artifactId,
          ...(options.name ? { name: options.name } : {})
        }, { ttlMs: options.commandTtlMs ?? 15 * 60 * 1000, timeoutMs: options.timeoutMs ?? 15 * 60 * 1000 });
        if (outcome.status !== 'succeeded') await deleteNativeArtifact(pool, workspaceId, staged.artifactId).catch(() => {});
        return outcome;
      } catch (error) {
        await deleteNativeArtifact(pool, workspaceId, staged.artifactId).catch(() => {});
        throw error;
      }
    },
    exportPixelForgeZip: async (projectId, options = {}) => {
      const result = await run('pixelforge_export_zip', { project_id: projectId, ...options }, {
        ttlMs: options.ttlMs ?? 15 * 60 * 1000,
        timeoutMs: options.timeoutMs ?? 15 * 60 * 1000
      });
      const artifactId = result.result?.artifact?.artifactId;
      if (result.status !== 'succeeded' || !artifactId) return result;
      const artifact = await readNativeArtifact(pool, await getWorkspaceId(), artifactId, 'pixelforge_zip_export');
      return { ...result, exportedArtifact: { ...artifact.metadata, bytes: artifact.bytes } };
    },
    downloadPixelForgeZip: async artifactId => {
      await ensureNativeArtifactSchema(pool);
      const workspaceId = await getWorkspaceId();
      const artifact = await readNativeArtifact(pool, workspaceId, artifactId, 'pixelforge_zip_export');
      await deleteNativeArtifact(pool, workspaceId, artifactId);
      return { ...artifact.metadata, bytes: artifact.bytes };
    },
    controlPixelForgeVideoComposer: async (projectId, operations = [{ type: 'inspect' }], options = {}) => {
      const outcome = await run('pixelforge_video_composer', {
        project_id: projectId,
        operations,
        ...(options.viewport ? { viewport: options.viewport } : {})
      }, { ttlMs: options.ttlMs ?? 15 * 60 * 1000, timeoutMs: options.timeoutMs ?? 15 * 60 * 1000 });
      if (!Array.isArray(outcome.result?.artifacts)) return outcome;
      const workspaceId = await getWorkspaceId();
      const evidenceArtifacts = [];
      for (const reference of outcome.result.artifacts) {
        const artifact = await readNativeArtifact(pool, workspaceId, reference.artifactId, reference.kind);
        await deleteNativeArtifact(pool, workspaceId, reference.artifactId);
        evidenceArtifacts.push({ ...artifact.metadata, bytes: artifact.bytes });
      }
      return { ...outcome, evidenceArtifacts };
    },
    listPixelForgeProjects: () => run('pixelforge_list'),
    inspectPixelForgeProject: (projectId, options = {}) => run('pixelforge_inspect', { project_id: projectId, ...options }),
    queryPixelForgeIntelligence: (projectId, operation = 'model', options = {}) => run('pixelforge_intelligence', { project_id: projectId, operation, ...options }),
    previewPixelForgeEvidenceVideo: options => run('pixelforge_preview_evidence_video', options || {}),
    capturePixelForgeInterface: (options = {}) => run('pixelforge_capture_interface', options),
    exportPixelForgeImage: (projectId, options = {}) => run('pixelforge_export_image', { project_id: projectId, ...options }),
    proposePixelForgeChanges: (projectId, actions, summary) => run('pixelforge_propose', { project_id: projectId, actions, summary }),
    getPixelForgeAnimationFrameContext: (projectId, index, layerId, options = {}) => run('pixelforge_animation_frame_context', {
      project_id: projectId,
      index,
      ...(layerId ? { layer_id: layerId } : {}),
      ...options
    }),
    exportAnimationVideo: (projectId, options = {}) => run('pixelforge_export_animation_video', {
      project_id: projectId, ...options
    }, { ttlMs: options.ttlMs ?? 180000, timeoutMs: options.timeoutMs ?? 185000 }),
    approveProposal: (proposalCommandId, proposalToken) => run('pixelforge_approve', {
      proposal_command_id: proposalCommandId, proposal_token: proposalToken
    }),
    discardProposal: (proposalCommandId, proposalToken) => run('pixelforge_discard', {
      proposal_command_id: proposalCommandId, proposal_token: proposalToken
    }),
    close: () => pool.end()
  });
}
