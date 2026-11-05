import { createRequire } from 'node:module';
import { randomBytes, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { HeadlessEditorRuntime } from './public/pixelforge/src/headless.js';
import chromium from '@sparticuz/chromium';
import { chromium as playwrightChromium } from 'playwright-core';
import { createVisionSnapshot } from './public/pixelforge/src/headless-vision.js';

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
let pixelForgeWorkspaceId = 'ws_pixelforge_guest';

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
    [pixelForgeWorkspaceId, projectId]
  );
  if (!result.rowCount) throw new Error('PixelForge project not found in the ADMIN workspace.');
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
async function mutateAdminWorkspace(transform) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await loadAdminWorkspace();
    const nextProjects = await transform(current.projects);
    if (nextProjects === null) return { state: current, unchanged: true };
    try {
      const saved = await workspaceApi('PUT', { projects: nextProjects, baseRevision: current.revision });
      return { state: { ...current, revision: saved.revision, projects: nextProjects }, unchanged: false };
    } catch (error) {
      if (error.status === 409 && attempt < 2) continue;
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
  const width = Math.max(320, Math.min(2400, Number(design.canvasWidth || design.width) || 1280));
  const height = Math.max(240, Math.min(4000, Number(design.canvasHeight || design.height) || 800));
  const background = exportColor(design.background, '#ffffff');
  const autoLayout = design.layoutMode === 'auto';
  const direction = design.layoutDirection === 'column' ? 'column' : 'row';
  const gap = Math.max(0, Math.min(200, Number(design.layoutGap) || 0));
  const padding = Math.max(0, Math.min(200, Number(design.layoutPadding) || 0));
  const markup = elements.map((element, index) => {
    const id = 'design-layer-' + index;
    const type = String(element.type || 'text');
    const tag = type === 'heading' ? 'h1' : type === 'button' ? 'button' : 'div';
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
    if (type === 'button') return '<button id="' + id + '" type="button" data-codelab-demo style="' + style + 'justify-content:center;cursor:pointer;border:0;">' + (text || 'Probar interacción') + '</button>';
    if (type === 'rectangle' || type === 'ellipse') return '<div id="' + id + '" aria-hidden="true" style="' + style + '"></div>';
    if (type === 'image') return '<div id="' + id + '" role="img" aria-label="' + escapeHtml(element.alt || 'Imagen') + '" style="' + style + '">Imagen pendiente</div>';
    return '<' + tag + ' id="' + id + '" style="' + style + '">' + text + '</' + tag + '>';
  }).join('');
  const frameStyle = autoLayout
    ? 'position:relative;width:100%;max-width:' + width + 'px;min-height:' + height + 'px;display:flex;flex-direction:' + direction + ';flex-wrap:' + (direction === 'row' ? 'wrap' : 'nowrap') + ';gap:' + gap + 'px;padding:' + padding + 'px;align-items:flex-start;background:' + background + ';margin:0 auto;'
    : 'position:relative;width:' + width + 'px;height:' + height + 'px;min-height:' + height + 'px;background:' + background + ';transform-origin:top left;margin:0 auto;';
  const mobile = autoLayout
    ? '@media(max-width:768px){.design-frame.auto-layout{flex-direction:column;flex-wrap:nowrap;align-items:stretch}.design-frame.auto-layout>*{max-width:100%}}'
    : '';
  return '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escapeHtml(project.name) + '</title><style>*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:Inter,Arial,sans-serif;overflow-x:hidden}.design-viewport{position:relative;width:100%;overflow:hidden}.design-frame{transform-origin:top left}.demo-status{position:fixed;left:16px;bottom:16px;padding:8px 12px;border-radius:8px;background:#0f172a;color:#fff;font:14px system-ui;z-index:10}' + mobile + '</style></head><body><div class="design-viewport"><main id="designFrame" class="design-frame' + (autoLayout ? ' auto-layout' : '') + '" style="' + frameStyle + '">' + markup + '</main></div><p class="demo-status" id="demoStatus" role="status" aria-live="polite">Diseño convertido · listo</p><script>(function(){var f=document.getElementById("designFrame"),v=f.parentNode,w=' + width + ',h=' + height + ';function fit(){if(f.classList.contains("auto-layout")){f.style.transform="none";v.style.height="auto";return;}var s=Math.min(1,Math.max(.1,window.innerWidth/w));f.style.transform="scale("+s+")";v.style.height=(h*s)+"px";}window.addEventListener("resize",fit,{passive:true});fit();document.querySelectorAll("[data-codelab-demo]").forEach(function(b){b.addEventListener("click",function(){document.getElementById("demoStatus").textContent="Interacción funcionando ✓";});});})();<\/script></body></html>';
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
async function inspectCodeLabProject(command) {
  const projectId = command.payload?.project_id;
  if (typeof projectId !== 'string' || !/^proj_[a-zA-Z0-9_-]{1,100}$/.test(projectId)) {
    throw new Error('A valid CodeLab project_id is required.');
  }
  const state = await loadAdminWorkspace();
  const project = state.projects.find(item => item && item.id === projectId);
  if (!project) throw new Error('CodeLab project not found in ADMIN workspace.');
  return {
    projectId, name: project.name, type: project.type,
    revision: state.revision, designElements: project.design?.elements?.length || 0,
    hasDesignSpace: !!project.hasDesignSpace, hasWebSpace: !!project.hasWebSpace,
    htmlBytes: Buffer.byteLength(project.code?.html || '', 'utf8'),
    hasInteractiveDemo: /data-codelab-demo/.test(project.code?.html || ''),
    updatedAt: project.updatedAt,
  };
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
     ON CONFLICT (workspace_id, project_id) DO NOTHING`,
    [pixelForgeWorkspaceId, workspaceId]
  );
  console.log('[PixelForge] temporary guest workspace ready; copied projects:', copied.rowCount);
}

async function capturePixelForgeInterface(payload = {}) {
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
      colorScheme: 'dark',
      reducedMotion: 'reduce'
    });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('pageerror', error => consoleErrors.push(String(error.message || error).slice(0, 300)));
    page.on('console', message => {
      if (message.type() === 'error' && consoleErrors.length < 20) consoleErrors.push(message.text().slice(0, 300));
    });
    const response = await page.goto(baseUrl + '/pixelforge/index.html?capture=1', {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });
    if (!response || !response.ok()) throw new Error('PixelForge page returned HTTP ' + (response?.status() || 'no response'));
    await page.locator('#canvas').waitFor({ state: 'visible', timeout: 45000 });
    await page.waitForTimeout(1600);
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
    return {
      captureMethod: 'playwright-chromium-real-browser',
      visionProtocol: 'pixelforge-headless-vision/v1',
      url: baseUrl + '/pixelforge/index.html',
      title: await page.title(),
      viewport: { width, height, zoom, fullPage: payload.full_page !== false },
      visionContext: vision.context,
      images: vision.images.map(item => ({
        role: item.role,
        label: item.label,
        mimeType: 'image/png',
        dataBase64: item.dataUrl.slice('data:image/png;base64,'.length)
      })),
      pageErrors: consoleErrors
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function processCommand(command) {
  if (command.workspace_id !== workspaceId) throw new Error('Workspace is not authorized for this bridge.');
  if (new Date(command.expires_at).getTime() < Date.now()) {
    await finish(command.command_id, 'expired', { error: 'command_expired' });
    return;
  }
  const payload = command.payload || {};
  switch (command.action) {
    case 'codelab_project_create':
      await finish(command.command_id, 'succeeded', await createCodeLabProject(command));
      return;
    case 'codelab_project_convert_to_web':
      await finish(command.command_id, 'succeeded', await convertCodeLabProjectToWeb(command));
      return;
    case 'codelab_project_inspect':
      await finish(command.command_id, 'succeeded', await inspectCodeLabProject(command));
      return;
    case 'status':
      await finish(command.command_id, 'succeeded', {
        status: 'online', protocol: 'codelab-native-headless/v1',
        workspaceId, runtime: 'PixelForge Headless',
        approvalRequired: true, persistence: 'PostgreSQL',
      });
      return;
    case 'pixelforge_create':
      await finish(command.command_id, 'succeeded', await createProject(payload));
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
    case 'pixelforge_capture_interface':
      await finish(command.command_id, 'succeeded', await capturePixelForgeInterface(payload));
      return;
    case 'pixelforge_export_image': {
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
  workspaceId = await resolveAdminWorkspace();
  if (String(process.env.PIXELFORGE_GUEST_MODE || 'true').toLowerCase() === 'false') {
    pixelForgeWorkspaceId = workspaceId;
  } else {
    await migrateAdminPixelForgeProjectsToGuest();
  }
  console.log('[CodeLab Native Bridge] online for mailbox workspace', workspaceId, 'and PixelForge workspace', pixelForgeWorkspaceId);
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
