/**
 * CodeLab XD Studio Pro v2.6.7
 * HTTP nativo + OAuth GitHub/Google + workspaces por usuario + rate limit
 */
process.env.PLAYWRIGHT_BROWSERS_PATH ||= '0';
const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Pool, Client } = require('pg');
const net = require('net');
const { URL } = require('url');
const designTools = require('./public/design-tools.js');
const pixelForgeUploads = require('./pixelforge-upload-store.js');
const neonEvidence = require('./neon-pixelforge-evidence.js');

const PORT = process.env.PORT || 3000;
const AGENT_INLINE_ARTIFACT_CHUNK_BYTES = 1024 * 1024;
const AGENT_INLINE_ARTIFACT_MAX_BYTES = 256 * 1024 * 1024;
const DATA_DIR = process.env.CODELAB_DATA_DIR || path.join(__dirname, 'data');
const WORKSPACES_DIR = path.join(DATA_DIR, 'workspaces');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PUBLIC_REAL_DIR = fs.realpathSync(PUBLIC_DIR);
const SECRET_FILE = path.join(DATA_DIR, '.workspace-secret');
const configuredMaxBodyBytes = Number.parseInt(process.env.CODELAB_MAX_BODY_BYTES || '', 10);
const MAX_BODY_BYTES = Number.isInteger(configuredMaxBodyBytes) && configuredMaxBodyBytes > 0
  ? Math.min(50 * 1024 * 1024, Math.max(1024, configuredMaxBodyBytes))
  : 10 * 1024 * 1024;
const configuredMaxProjects = Number.parseInt(process.env.CODELAB_MAX_PROJECTS || '', 10);
const MAX_PROJECTS = Number.isInteger(configuredMaxProjects) && configuredMaxProjects > 0
  ? Math.min(500, configuredMaxProjects)
  : 50;
// PixelForge has a dedicated high-resolution asset budget. Keep these limits
// scoped to its project API; do not inflate unrelated CodeLab request bodies.
// Keep individual JSON requests bounded; larger project payloads are uploaded as 6 MiB chunks.
const PIXELFORGE_MAX_BODY_BYTES = 32 * 1024 * 1024;
const PIXELFORGE_MAX_CHUNK_BODY_BYTES = 9 * 1024 * 1024;
const PIXELFORGE_MAX_PROJECT_BYTES = 96 * 1024 * 1024;
// Keep the server-side raster allocation ceiling identical to the editor's
// MAX_DOCUMENT_BYTES. This is the aggregate raw RGBA budget across all layers.
const PIXELFORGE_MAX_RASTER_BYTES = 64 * 1024 * 1024;
const PIXELFORGE_MAX_ACCOUNT_BYTES = 512 * 1024 * 1024;
// Account-backed PixelForge is the default. Temporary guest mode is opt-in for isolated demos/tests.
const PIXELFORGE_GUEST_MODE = String(process.env.PIXELFORGE_GUEST_MODE || 'false').toLowerCase() === 'true';
const PIXELFORGE_GUEST_WORKSPACE_ID = 'ws_pixelforge_guest';
const configuredUpstreamTimeout = Number.parseInt(process.env.CODELAB_UPSTREAM_TIMEOUT_MS || '60000', 10);
const UPSTREAM_TIMEOUT_MS = Number.isInteger(configuredUpstreamTimeout)
  ? Math.min(300000, Math.max(1000, configuredUpstreamTimeout))
  : 60000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_REQUESTS = 120;
const APP_VERSION = '2.7.0';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const configuredSessionCleanupInterval = Number.parseInt(process.env.CODELAB_SESSION_CLEANUP_INTERVAL_MS || '', 10);
const SESSION_CLEANUP_INTERVAL_MS = Number.isInteger(configuredSessionCleanupInterval) && configuredSessionCleanupInterval > 0
  ? Math.min(60 * 60 * 1000, Math.max(1000, configuredSessionCleanupInterval))
  : 15 * 60 * 1000;
const COOKIE_NAME = 'codelab_sid';
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const ADMIN_BOOTSTRAP_PASSWORD = process.env.ADMIN_BOOTSTRAP_PASSWORD || '';
const DATABASE_URL = process.env.DATABASE_URL || ''; 
const AGENT_BRIDGE_CONTROL_SECRET = String(process.env.CODELAB_AGENT_BRIDGE_CONTROL_SECRET || '').trim();
let agentBridgeWorker = null;
let agentBridgeStopping = false;
let agentBridgeWakeClient = null;
let agentBridgeWakeReconnectTimer = null;
let agentBridgeWakeReconnectAttempt = 0;

function databaseUrlForWakeListener() {
  if (!DATABASE_URL) return '';
  try {
    const url = new URL(DATABASE_URL);
    // Neon pooled endpoints are intended for request traffic; LISTEN/NOTIFY
    // needs a stable backend connection, so prefer the matching direct Neon
    // hostname when the configured URL is a Neon -pooler endpoint.
    if (url.hostname.includes('-pooler.')) url.hostname = url.hostname.replace('-pooler.', '.');
    return url.toString();
  } catch {
    return DATABASE_URL;
  }
}

function scheduleAgentBridgeWakeReconnect(reason) {
  if (!accountPool || agentBridgeWakeReconnectTimer || agentBridgeStopping) return;
  const attempt = Math.min(++agentBridgeWakeReconnectAttempt, 6);
  const delayMs = Math.min(60000, 1000 * Math.pow(2, attempt - 1));
  console.error('[CodeLab Native Bridge] scheduling Neon wake listener reconnect:', {
    attempt,
    delayMs,
    reason: reason ? String(reason.message || reason).slice(0, 300) : 'connection_unavailable'
  });
  agentBridgeWakeReconnectTimer = setTimeout(() => {
    agentBridgeWakeReconnectTimer = null;
    ensureAgentBridgeWakeListener().catch(reconnectError => {
      console.error('[CodeLab Native Bridge] Neon wake listener reconnect failed:', reconnectError.message);
      scheduleAgentBridgeWakeReconnect(reconnectError);
    });
  }, delayMs);
}

async function ensureAgentBridgeWakeListener() {
  if (!accountPool || agentBridgeWakeClient) return;
  if (agentBridgeWakeReconnectTimer) {
    clearTimeout(agentBridgeWakeReconnectTimer);
    agentBridgeWakeReconnectTimer = null;
  }
  const client = new Client({ connectionString: databaseUrlForWakeListener(), ssl: DATABASE_SSL, application_name: 'codelab-agent-bridge-wake-listener' });
  try {
    await client.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.codelab_agent_commands (
        command_id text PRIMARY KEY,
        workspace_id text NOT NULL,
        action text NOT NULL,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        status text NOT NULL DEFAULT 'queued',
        result jsonb,
        proposal jsonb,
        proposal_token text,
        created_at timestamptz NOT NULL DEFAULT now(),
        started_at timestamptz,
        finished_at timestamptz,
        expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.codelab_agent_commands'::regclass
            AND conname = 'codelab_agent_commands_action_check'
        ) THEN
          ALTER TABLE public.codelab_agent_commands DROP CONSTRAINT codelab_agent_commands_action_check;
        END IF;
        ALTER TABLE public.codelab_agent_commands
          ADD CONSTRAINT codelab_agent_commands_action_check
          CHECK (action = ANY (ARRAY[
            'status','pixelforge_create','pixelforge_list','pixelforge_inspect',
            'pixelforge_propose','pixelforge_approve','pixelforge_discard',
            'pixelforge_animation_frame_context','pixelforge_export_image',
            'pixelforge_capture_interface','pixelforge_export_animation_video',
            'pixelforge_intelligence','codelab_project_import','codelab_project_create',
            'codelab_project_convert_to_web','codelab_project_inspect',
            'codelab_project_connect','codelab_project_get_code',
            'codelab_project_update_code','codelab_project_capture_png',
            'codelab_project_record_video','codelab_ui_execute','codelab_validate','neon_function_invoke'
          ]));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.codelab_agent_bridge_state (
        state_id text PRIMARY KEY,
        workspace_id text NOT NULL,
        state text NOT NULL CHECK (state IN ('starting','running','sleeping','stopping','error')),
        wake_required boolean NOT NULL DEFAULT false,
        wake_reason text,
        signal_version bigint NOT NULL DEFAULT 0,
        last_signal_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION public.codelab_agent_bridge_wake() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.status = 'queued' THEN
          PERFORM pg_notify(
            'codelab_agent_bridge_wake',
            json_build_object('commandId', NEW.command_id, 'workspaceId', NEW.workspace_id)::text
          );
        END IF;
        RETURN NEW;
      END;
      $fn$
    `);
    await client.query('DROP TRIGGER IF EXISTS codelab_agent_bridge_wake_trigger ON public.codelab_agent_commands');
    await client.query(`
      CREATE TRIGGER codelab_agent_bridge_wake_trigger
      AFTER INSERT OR UPDATE OF status ON public.codelab_agent_commands
      FOR EACH ROW EXECUTE FUNCTION public.codelab_agent_bridge_wake()
    `);
    await client.query('LISTEN codelab_agent_bridge_wake');
    // LISTEN has an intentional startup race: a notification committed while the
    // listener is being registered may be missed. Reconcile durable queued state
    // once after LISTEN is active, then rely only on notifications afterward.
    const pendingWake = await client.query(
      "SELECT command_id, workspace_id FROM public.codelab_agent_commands WHERE status='queued' AND expires_at > now() ORDER BY created_at LIMIT 1"
    );
    if (pendingWake.rowCount) {
      console.log('[CodeLab Native Bridge] durable wake state found at listener startup:', pendingWake.rows[0].command_id);
      try {
        const status = startAgentBridge();
        console.log('[CodeLab Native Bridge] startup reconciliation bridge state:', status);
      } catch (error) {
        console.error('[CodeLab Native Bridge] startup wake reconciliation failed:', error.message);
      }
    }
    client.on('notification', message => {
      if (message.channel !== 'codelab_agent_bridge_wake' || agentBridgeStopping) return;
      try {
        const payload = JSON.parse(message.payload || '{}');
        console.log('[CodeLab Native Bridge] wake signal received from Neon:', payload.commandId || 'unknown');
      } catch (_) {
        console.log('[CodeLab Native Bridge] wake signal received from Neon.');
      }
      try {
        const status = startAgentBridge();
        console.log('[CodeLab Native Bridge] on-demand bridge state:', status);
      } catch (error) {
        console.error('[CodeLab Native Bridge] on-demand wake failed:', error.message);
      }
    });
    client.on('error', error => {
      console.error('[CodeLab Native Bridge] Neon wake listener error:', error.message);
      if (agentBridgeWakeClient === client) agentBridgeWakeClient = null;
      scheduleAgentBridgeWakeReconnect(error);
      void client.end().catch(() => {});
    });
    agentBridgeWakeClient = client;
    agentBridgeWakeReconnectAttempt = 0;
    console.log('[CodeLab Native Bridge] Neon wake listener armed; no polling/interval is used to wake the bridge.');
  } catch (error) {
    try { await client.end(); } catch (_) {}
    scheduleAgentBridgeWakeReconnect(error);
    throw error;
  }
}

function agentBridgeStatus() {
  return {
    enabled: !!DATABASE_URL && process.env.CODELAB_AGENT_BRIDGE_ENABLED !== '0',
    running: !!agentBridgeWorker,
    pid: agentBridgeWorker?.pid ?? null
  };
}

function startAgentBridge() {
  if (!DATABASE_URL) throw new Error('database_not_configured');
  if (process.env.CODELAB_AGENT_BRIDGE_ENABLED === '0') throw new Error('agent_bridge_disabled');
  if (agentBridgeWorker) return agentBridgeStatus();

  const workerPath = path.join(__dirname, 'agent-bridge-worker.mjs');
  agentBridgeStopping = false;
  agentBridgeWorker = spawn(process.execPath, [workerPath], {
    cwd: __dirname,
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit']
  });
  agentBridgeWorker.on('error', error => {
    console.error('[CodeLab Native Bridge] worker launch failed:', error.message);
  });
  agentBridgeWorker.on('exit', (code, signal) => {
    console.error('[CodeLab Native Bridge] worker exited:', { code, signal });
    agentBridgeWorker = null;
  });
  return agentBridgeStatus();
}

function stopAgentBridge() {
  agentBridgeStopping = true;
  if (agentBridgeWorker) {
    agentBridgeWorker.kill('SIGTERM');
    agentBridgeWorker = null;
  }
}
// Production uses TLS by default; local PostgreSQL integration tests can opt out explicitly.
const DATABASE_SSL = process.env.CODELAB_DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false };
const accountPool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: DATABASE_SSL, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 }) : null;
let authSessionTableReady = false;
const localLoginAttempts = new Map();
const LOCAL_LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOCAL_LOGIN_MAX_ATTEMPTS = 8;

function allowLocalLoginAttempt(req, username) {
  const now = Date.now();
  const key = clientIp(req) + ':' + username;
  let entry = localLoginAttempts.get(key);
  if (!entry || now - entry.startedAt > LOCAL_LOGIN_WINDOW_MS) {
    entry = { startedAt: now, count: 0 };
    localLoginAttempts.set(key, entry);
  }
  entry.count += 1;
  if (localLoginAttempts.size > 5000) {
    for (const [k, value] of localLoginAttempts) {
      if (now - value.startedAt > LOCAL_LOGIN_WINDOW_MS) localLoginAttempts.delete(k);
    }
  }
  return entry.count <= LOCAL_LOGIN_MAX_ATTEMPTS;
}

async function readLocalAccounts() {
  if (!accountPool) throw new Error('database_not_configured');
  const result = await accountPool.query('SELECT username, id, role, salt, password_hash, created_at, password_changed_at, must_change_password FROM codelab_accounts');
  const accounts = {};
  for (const row of result.rows) {
    accounts[row.username] = {
      id: row.id, username: row.username, role: row.role, salt: row.salt,
      passwordHash: row.password_hash,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      passwordChangedAt: row.password_changed_at ? new Date(row.password_changed_at).toISOString() : null,
      mustChangePassword: !!row.must_change_password
    };
  }
  return accounts;
}

async function writeLocalAccounts(accounts) {
  if (!accountPool) throw new Error('database_not_configured');
  const client = await accountPool.connect();
  try {
    await client.query('BEGIN');
    for (const [username, account] of Object.entries(accounts)) {
      await client.query(
        'INSERT INTO codelab_accounts (username, id, role, salt, password_hash, created_at, password_changed_at, must_change_password) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (username) DO UPDATE SET id=EXCLUDED.id, role=EXCLUDED.role, salt=EXCLUDED.salt, password_hash=EXCLUDED.password_hash, password_changed_at=EXCLUDED.password_changed_at, must_change_password=EXCLUDED.must_change_password',
        [username, String(account.id), account.role || 'user', account.salt, account.passwordHash, account.createdAt || new Date().toISOString(), account.passwordChangedAt || null, !!account.mustChangePassword]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function passwordHash(password, salt) {
  return crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
}

function safeTokenEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
}

function safePasswordEqual(a, b) {
  const aa = Buffer.from(String(a || ''), 'hex');
  const bb = Buffer.from(String(b || ''), 'hex');
  return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
}

async function seedAdminAccountIfConfigured() {
  if (!ADMIN_BOOTSTRAP_PASSWORD) {
    console.log('ADMIN bootstrap skipped: ADMIN_BOOTSTRAP_PASSWORD not configured.');
    return;
  }
  if (ADMIN_BOOTSTRAP_PASSWORD.length < 16) {
    console.error('ADMIN_BOOTSTRAP_PASSWORD must contain at least 16 characters; ADMIN bootstrap skipped.');
    return;
  }
  if (!accountPool) {
    console.error('DATABASE_URL is required for native accounts; ADMIN bootstrap skipped.');
    return;
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = passwordHash(ADMIN_BOOTSTRAP_PASSWORD, salt);
  if (process.env.ADMIN_BOOTSTRAP_FORCE_RESET === 'true') {
    await accountPool.query(
      'INSERT INTO codelab_accounts (username,id,role,salt,password_hash,password_changed_at,must_change_password) VALUES ($1,$2,$3,$4,$5,NOW(),FALSE) ON CONFLICT (username) DO UPDATE SET id=EXCLUDED.id, role=EXCLUDED.role, salt=EXCLUDED.salt, password_hash=EXCLUDED.password_hash, password_changed_at=NOW(), must_change_password=FALSE',
      ['ADMIN','admin','admin',salt,hash]
    );
    console.log('ADMIN password synchronized from server environment.');
    return;
  }
  await accountPool.query(
    'INSERT INTO codelab_accounts (username,id,role,salt,password_hash,must_change_password) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (username) DO NOTHING',
    ['ADMIN','admin','admin',salt,hash,true]
  );
}



const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const OAUTH_PUBLIC_URL = (process.env.OAUTH_PUBLIC_URL || '').replace(/\/$/, ''); // e.g. https://app.onrender.com

// AI copiloto (OpenAI-compatible). Optional server-side key avoids browser CORS.
const AI_API_KEY = (process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '').trim();
const AI_BASE_URL = (process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1')
  .trim()
  .replace(/\/$/, '');
const _rawModel = (process.env.AI_MODEL || process.env.OPENAI_MODEL || '').trim();
const configuredAiMaxTokens = Number.parseInt(process.env.AI_MAX_TOKENS || '', 10);
const AI_MAX_TOKENS = Number.isInteger(configuredAiMaxTokens) && configuredAiMaxTokens > 0
  ? Math.min(32768, configuredAiMaxTokens)
  : 4096;
const configuredAiRateMax = Number.parseInt(process.env.AI_RATE_MAX || '', 10);
const AI_RATE_MAX = Number.isInteger(configuredAiRateMax) && configuredAiRateMax > 0
  ? Math.min(1000, configuredAiRateMax)
  : 20; // per window per IP

function isGroqBase(url) {
  return /api\.groq\.com/i.test(url || '');
}
function isOpenRouterBase(url) {
  return /openrouter\.ai/i.test(url || '');
}

/** Normalize / fix common model id mistakes per provider. */
function resolveAiModel(requested, baseUrl) {
  let m = String(requested || '').trim();
  const groq = isGroqBase(baseUrl);
  const openrouter = isOpenRouterBase(baseUrl);

  // Strip accidental quotes/spaces from Render env paste
  m = m.replace(/^["']|["']$/g, '').trim();

  if (groq) {
    // Map broken / short names to working Groq ids
    const aliases = {
      '': 'openai/gpt-oss-120b',
      'llama-3': 'openai/gpt-oss-20b',
      'llama3': 'openai/gpt-oss-20b',
      'llama-3.3': 'openai/gpt-oss-120b',
      'llama-3.3-70b': 'openai/gpt-oss-120b',
      'llama3.3': 'openai/gpt-oss-120b',
      'llama-3.1': 'openai/gpt-oss-20b',
      'llama-3.1-8b': 'openai/gpt-oss-20b',
      'llama-3.1-8b-instant': 'openai/gpt-oss-20b',
      'gpt-4o-mini': 'openai/gpt-oss-20b',
      'gpt-4o': 'openai/gpt-oss-20b',
      'openai/gpt-4o-mini': 'openai/gpt-oss-20b',
      'gpt-oss': 'openai/gpt-oss-20b',
      'gpt-oss-20b': 'openai/gpt-oss-20b',
      'gpt-oss-120b': 'openai/gpt-oss-120b'
    };
    const key = m.toLowerCase();
    if (aliases[key]) m = aliases[key];
    // Groq model IDs may include provider prefixes (e.g. openai/gpt-oss-120b).
    // Preserve those IDs; stripping the prefix makes Groq reject valid models.
    if (!m) m = 'openai/gpt-oss-120b';
    return m;
  }

  if (openrouter) {
    if (!m) return 'openai/gpt-4o-mini';
    // Expand bare gpt ids
    if (m === 'gpt-4o-mini') return 'openai/gpt-4o-mini';
    if (m === 'gpt-4o') return 'openai/gpt-4o';
    // Expand bare llama to meta-llama on OpenRouter
    if (m === 'llama-3.3-70b-versatile' || m === 'llama-3.3-70b') {
      return 'meta-llama/llama-3.3-70b-instruct';
    }
    if (m === 'llama-3.1-8b-instant' || m === 'llama-3') {
      return 'meta-llama/llama-3.1-8b-instruct';
    }
    return m;
  }

  return m || 'gpt-4o-mini';
}

const AI_MODEL = resolveAiModel(_rawModel, AI_BASE_URL);
const GROQ_FALLBACKS = [
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'qwen/qwen3.8-27b'
];
const aiRateMap = new Map();
function checkAiRateLimit(ip) {
  const now = Date.now();
  let entry = aiRateMap.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    entry = { start: now, count: 0 };
    aiRateMap.set(ip, entry);
  }
  entry.count++;
  return entry.count <= AI_RATE_MAX;
}

fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

let SERVER_SECRET = (process.env.CODELAB_WORKSPACE_SECRET || '').trim();
if (!SERVER_SECRET) {
  try { SERVER_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (_) {}
  if (!SERVER_SECRET) {
    const generatedSecret = crypto.randomBytes(32).toString('hex');
    const tempSecretFile = SECRET_FILE + '.tmp.' + process.pid + '.' + crypto.randomBytes(6).toString('hex');
    try {
      // Write the full secret privately first, then atomically publish it with a
      // no-overwrite hard link. Concurrent instances can never observe a partial key.
      fs.writeFileSync(tempSecretFile, generatedSecret, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      });
      try {
        fs.linkSync(tempSecretFile, SECRET_FILE);
        SERVER_SECRET = generatedSecret;
      } catch (error) {
        if (error.code === 'EEXIST') {
          try { SERVER_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (_) {}
        } else {
          throw error;
        }
      }
    } catch (error) {
      throw new Error('CODELAB_WORKSPACE_SECRET is required when the secret file cannot be persisted: ' + error.message);
    } finally {
      try { fs.unlinkSync(tempSecretFile); } catch (_) {}
    }
  }
  if (!SERVER_SECRET) {
    throw new Error('Workspace secret file is empty or unreadable; configure CODELAB_WORKSPACE_SECRET or repair ' + SECRET_FILE);
  }
  // Tighten permissions for an existing secret file as well as newly created ones.
  try { fs.chmodSync(SECRET_FILE, 0o600); } catch (error) {
    console.warn('Could not restrict workspace secret file permissions:', error.message);
  }
}

// --- Rate limit ---
const rateMap = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  let entry = rateMap.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    entry = { start: now, count: 0 };
    rateMap.set(ip, entry);
  }
  entry.count++;
  return entry.count <= RATE_MAX_REQUESTS;
}
setInterval(() => {
  const now = Date.now();
  // Both limiters are keyed by client IP. Expire stale entries in both maps so
  // long-running servers do not retain every IP that has ever called the API.
  for (const [ip, entry] of rateMap) {
    if (now - entry.start > RATE_WINDOW_MS * 2) rateMap.delete(ip);
  }
  for (const [ip, entry] of aiRateMap) {
    if (now - entry.start > RATE_WINDOW_MS * 2) aiRateMap.delete(ip);
  }
}, 60 * 1000).unref();

// OAuth state (CSRF) — HMAC-signed, no shared memory needed (multi-instance safe)
function createOAuthState(provider) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const exp = Date.now() + 10 * 60 * 1000;
  const payload = provider + '.' + exp + '.' + nonce;
  const sig = crypto.createHmac('sha256', SERVER_SECRET).update(payload).digest('hex');
  return payload + '.' + sig;
}
function parseOAuthState(state) {
  if (!state || typeof state !== 'string') return null;
  const parts = state.split('.');
  if (parts.length !== 4) return null;
  const [provider, expStr, nonce, sig] = parts;
  if (provider !== 'github' && provider !== 'google') return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  const payload = provider + '.' + expStr + '.' + nonce;
  const expected = crypto.createHmac('sha256', SERVER_SECRET).update(payload).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { provider };
}

// Rotate through large session directories so entries after the first batch
// are also eventually checked, while keeping each cleanup pass bounded.
let sessionCleanupCursor = 0;
async function cleanupExpiredSessions() {
  if (accountPool && authSessionTableReady) {
    try { await accountPool.query('DELETE FROM codelab_auth_sessions WHERE expires_at <= NOW()'); }
    catch (error) { console.warn('CodeLab session cleanup failed:', error.message); }
    return;
  }
  try {
    const allSessionFiles = fs.readdirSync(SESSIONS_DIR).filter(file => file.endsWith('.json'));
    let files = allSessionFiles;
    if (allSessionFiles.length > 200) {
      const start = sessionCleanupCursor % allSessionFiles.length;
      const end = start + 200;
      files = end <= allSessionFiles.length
        ? allSessionFiles.slice(start, end)
        : allSessionFiles.slice(start).concat(allSessionFiles.slice(0, end - allSessionFiles.length));
      sessionCleanupCursor = end % allSessionFiles.length;
    } else {
      sessionCleanupCursor = 0;
    }
    const now = Date.now();
    for (const file of files) {
      try {
        const sessionFile = path.join(SESSIONS_DIR, file);
        const raw = fs.readFileSync(sessionFile, 'utf8');
        let session;
        try { session = JSON.parse(raw); }
        catch (_) { fs.unlinkSync(sessionFile); continue; }
        if (!session || !Number.isFinite(session.expiresAt) || session.expiresAt < now) fs.unlinkSync(sessionFile);
      } catch (_) {}
    }
  } catch (_) {}
}
cleanupExpiredSessions();
setInterval(cleanupExpiredSessions, SESSION_CLEANUP_INTERVAL_MS).unref();

function safeId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
}
function workspaceFile(id) {
  return path.join(WORKSPACES_DIR, safeId(id) + '.json');
}
function designSystemFile(id) {
  return path.join(WORKSPACES_DIR, safeId(id) + '.design-system.json');
}
function readDesignSystem(id) {
  const file = designSystemFile(id);
  if (!fs.existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    throw new Error('design_system_state_invalid');
  }
  const requiredSettings = [
    'name', 'primary', 'secondary', 'accent', 'surface', 'background', 'text',
    'contrastForeground', 'contrastBackground', 'baseFont', 'typeRatio', 'baseSpacing', 'baseRadius'
  ];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      parsed.version !== 1 || typeof parsed.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(parsed.updatedAt)) ||
      !parsed.settings || typeof parsed.settings !== 'object' || Array.isArray(parsed.settings) ||
      !requiredSettings.every(key => Object.prototype.hasOwnProperty.call(parsed.settings, key))) {
    throw new Error('design_system_state_invalid');
  }
  return designTools.sanitizeSettings(parsed.settings);
}
function writeDesignSystem(id, settings) {
  const file = designSystemFile(id);
  const tmp = file + '.tmp.' + process.pid + '.' + Date.now();
  try {
    fs.writeFileSync(tmp, JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      settings: settings
    }), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    // Keep failed settings writes from leaving sensitive workspace temp files behind.
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw error;
  }
}
function emptyState(owner) {
  return {
    version: 5,
    revision: 0,
    updatedAt: new Date().toISOString(),
    projects: [],
    owner: owner || null
  };
}
function signWorkspace(id) {
  return crypto.createHmac('sha256', SERVER_SECRET).update(String(id)).digest('hex');
}
function userWorkspaceId(user) {
  return safeId('ws_' + user.provider + '_' + user.id);
}

async function resolveAdminAgentWorkspace() {
  if (!accountPool) throw new Error('database_not_configured');
  const result = await accountPool.query(
    "SELECT id FROM codelab_accounts WHERE username = 'ADMIN' AND role = 'admin' LIMIT 1"
  );
  if (!result.rowCount) throw new Error('CodeLab ADMIN account is not configured.');
  return 'ws_local_' + String(result.rows[0].id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
}

const PIXELFORGE_MAX_ANIMATION_BYTES = 64 * 1024 * 1024;

function hasBase64CharactersAndPadding(value, expectedPadding = '') {
  if (typeof value !== 'string') return false;
  if (expectedPadding && !value.endsWith(expectedPadding)) return false;
  const payloadEnd = value.length - expectedPadding.length;
  for (let index = 0; index < payloadEnd; index++) {
    const code = value.charCodeAt(index);
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
          (code >= 48 && code <= 57) || code === 43 || code === 47)) return false;
  }
  return true;
}

function validatePixelForgeAnimation(project) {
  if (!Object.prototype.hasOwnProperty.call(project, 'animation')) return null;
  const animation = project.animation;
  if (!animation || typeof animation !== 'object' || Array.isArray(animation) ||
      animation.format !== 'pixelforge-animation' || animation.version !== 1 ||
      animation.width !== project.width || animation.height !== project.height ||
      !Number.isInteger(animation.fps) || animation.fps < 1 || animation.fps > 60 ||
      !Number.isInteger(animation.activeFrameIndex) ||
      !Array.isArray(animation.layerIds) || animation.layerIds.length !== project.layers.length ||
      !Array.isArray(animation.frames) || animation.frames.length < 1 || animation.frames.length > 240) {
    return 'invalid_pixelforge_animation';
  }

  const projectLayerIds = project.layers.map(layer => layer.id);
  if (animation.layerIds.some((id, index) => typeof id !== 'string' || id !== projectLayerIds[index]) ||
      new Set(animation.layerIds).size !== animation.layerIds.length ||
      animation.activeFrameIndex < 0 || animation.activeFrameIndex >= animation.frames.length) {
    return 'invalid_pixelforge_animation';
  }

  const celBytes = project.width * project.height * 4;
  if (celBytes * animation.layerIds.length * animation.frames.length > PIXELFORGE_MAX_ANIMATION_BYTES) {
    return 'pixelforge_project_too_large';
  }
  const expectedBase64Length = Math.ceil(celBytes / 3) * 4;
  const expectedPadding = celBytes % 3 === 1 ? '==' : celBytes % 3 === 2 ? '=' : '';
  const frameIds = new Set();
  for (const frame of animation.frames) {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame) ||
        typeof frame.id !== 'string' || !frame.id.trim() || frame.id.length > 180 || frameIds.has(frame.id) ||
        !Number.isFinite(frame.durationMs) || frame.durationMs < 1 || frame.durationMs > 10000 ||
        !Array.isArray(frame.cels) || frame.cels.length !== animation.layerIds.length) {
      return 'invalid_pixelforge_animation';
    }
    frameIds.add(frame.id);
    const celLayerIds = new Set();
    for (const cel of frame.cels) {
      if (!cel || typeof cel !== 'object' || Array.isArray(cel) ||
          typeof cel.layerId !== 'string' || !animation.layerIds.includes(cel.layerId) || celLayerIds.has(cel.layerId) ||
          typeof cel.pixels !== 'string' || cel.pixels.length !== expectedBase64Length ||
          !hasBase64CharactersAndPadding(cel.pixels, expectedPadding)) {
        return 'invalid_pixelforge_animation';
      }
      celLayerIds.add(cel.layerId);
    }
    if (celLayerIds.size !== animation.layerIds.length) return 'invalid_pixelforge_animation';
  }
  return null;
}

function validatePixelForgeProjectPayload(project, serializedInput = null) {
  if (!project || typeof project !== 'object' || Array.isArray(project) ||
      project.format !== 'pixelforge-project' || project.version !== 1 ||
      typeof project.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(project.id) ||
      typeof project.name !== 'string' || !project.name.trim() || project.name.length > 180 ||
      !Number.isInteger(project.width) || !Number.isInteger(project.height) ||
      project.width < 1 || project.height < 1 || project.width > 4096 || project.height > 4096 ||
      project.width * project.height > 16_777_216 ||
      !Number.isInteger(project.revision) || project.revision < 0 ||
      !Number.isInteger(project.saveVersion) || project.saveVersion < 0 ||
      (project.serverRevision !== undefined && (!Number.isInteger(project.serverRevision) || project.serverRevision < 0)) ||
      !Array.isArray(project.layers) || project.layers.length < 1 || project.layers.length > 64 ||
      typeof project.activeLayerId !== 'string') {
    return { error: 'invalid_pixelforge_project', status: 400 };
  }
  if (project.width * project.height * 4 * project.layers.length > PIXELFORGE_MAX_RASTER_BYTES) {
    return { error: 'pixelforge_project_too_large', status: 413, maxBytes: PIXELFORGE_MAX_PROJECT_BYTES };
  }
  const pixelBytes = project.width * project.height * 4;
  const expectedPixelBase64Length = Math.ceil(pixelBytes / 3) * 4;
  const expectedPixelPadding = pixelBytes % 3 === 1 ? '==' : pixelBytes % 3 === 2 ? '=' : '';
  const layerIds = new Set();
  for (const layer of project.layers) {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer) ||
        typeof layer.id !== 'string' || !layer.id || layer.id.length > 180 || layerIds.has(layer.id) ||
        typeof layer.name !== 'string' || !layer.name.trim() || layer.name.length > 180 ||
        typeof layer.visible !== 'boolean' || typeof layer.locked !== 'boolean' ||
        !Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1 ||
        typeof layer.pixels !== 'string' || layer.pixels.length !== expectedPixelBase64Length ||
        !hasBase64CharactersAndPadding(layer.pixels, expectedPixelPadding)) {
      return { error: 'invalid_pixelforge_project', status: 400 };
    }
    layerIds.add(layer.id);
  }
  if (!layerIds.has(project.activeLayerId)) return { error: 'invalid_pixelforge_project', status: 400 };
  const animationError = validatePixelForgeAnimation(project);
  if (animationError) {
    return { error: animationError, status: animationError === 'pixelforge_project_too_large' ? 413 : 400 };
  }
  const serialized = typeof serializedInput === 'string' ? serializedInput : JSON.stringify(project);
  const projectBytes = Buffer.byteLength(serialized, 'utf8');
  if (projectBytes > PIXELFORGE_MAX_PROJECT_BYTES) {
    return { error: 'pixelforge_project_too_large', status: 413, maxBytes: PIXELFORGE_MAX_PROJECT_BYTES };
  }
  return { serialized, projectBytes };
}

function decodePixelForgeProjectId(value) {
  try {
    const decoded = decodeURIComponent(value);
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(decoded)) return null;
    return decoded;
  } catch (_) {
    return null;
  }
}

async function ensureWorkspaceStateTable() {
  if (!accountPool) return;
  await accountPool.query(`
    CREATE TABLE IF NOT EXISTS codelab_workspace_states (
      workspace_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0,
      state JSONB NOT NULL,
      owner JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function ensureAuthSessionTable() {
  if (!accountPool) return;
  await accountPool.query("CREATE TABLE IF NOT EXISTS codelab_auth_sessions (session_id VARCHAR(48) PRIMARY KEY CHECK (session_id ~ '^[a-f0-9]{48}$'), user_data JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL, CHECK (jsonb_typeof(user_data) = 'object'))");
  await accountPool.query('CREATE INDEX IF NOT EXISTS codelab_auth_sessions_expiry_idx ON codelab_auth_sessions (expires_at)');
  authSessionTableReady = true;
}

async function migrateLegacySessionsToDatabase() {
  if (!accountPool || !authSessionTableReady) return;
  let files = [];
  try { files = fs.readdirSync(SESSIONS_DIR).filter(file => /^[a-f0-9]{48}\.json$/.test(file)); }
  catch (_) { return; }
  for (const file of files) {
    try {
      const session = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
      if (!session || session.id !== file.slice(0, 48) || !Number.isFinite(session.createdAt) || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now() || !isValidSessionUser(session.user)) continue;
      await accountPool.query('INSERT INTO codelab_auth_sessions (session_id, user_data, created_at, expires_at) VALUES ($1, $2::jsonb, to_timestamp($3 / 1000.0), to_timestamp($4 / 1000.0)) ON CONFLICT (session_id) DO NOTHING', [session.id, JSON.stringify(session.user), session.createdAt, session.expiresAt]);
    } catch (error) { console.warn('Legacy CodeLab session migration skipped:', error.message); }
  }
}
let pixelForgeTableReady = false;

async function ensurePixelForgeTable() {
  if (!accountPool) return;
  await accountPool.query(`
    CREATE TABLE IF NOT EXISTS codelab_pixelforge_projects (
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      updated_at BIGINT NOT NULL,
      last_opened_at BIGINT NOT NULL,
      project JSONB NOT NULL,
      byte_size BIGINT NOT NULL,
      PRIMARY KEY (workspace_id, project_id)
    )
  `);
  await accountPool.query(`
    CREATE INDEX IF NOT EXISTS codelab_pixelforge_recent_idx
    ON codelab_pixelforge_projects (workspace_id, last_opened_at DESC)
  `);
  await pixelForgeUploads.ensureSchema(accountPool);
  // Evidence is an auxiliary capability: a storage/schema issue must not take
  // the PixelForge editor itself offline. Saves remain durable in PostgreSQL.
  try {
    await neonEvidence.ensureEvidenceSchema(accountPool);
  } catch (error) {
    console.warn('PixelForge Neon evidence schema unavailable; continuing without evidence events:', error.message);
  }
  pixelForgeTableReady = true;
}

async function listPixelForgeProjectMetadataFromDatabase(workspaceId) {
  const result = await accountPool.query(
    'SELECT project_id AS id, name, width, height, updated_at AS "updatedAt", last_opened_at AS "lastOpenedAt" FROM codelab_pixelforge_projects WHERE workspace_id = $1 ORDER BY last_opened_at DESC',
    [workspaceId]
  );
  return result.rows.map(row => ({
    id: row.id, name: row.name, width: row.width, height: row.height,
    updatedAt: Number(row.updatedAt), lastOpenedAt: Number(row.lastOpenedAt)
  }));
}

async function loadPixelForgeProjectFromDatabase(workspaceId, projectId) {
  // Opening a project updates its recency atomically with the read, so the
  // dashboard's "recent projects" list reflects actual use, not only saves.
  const result = await accountPool.query(
    'UPDATE codelab_pixelforge_projects SET last_opened_at = GREATEST($3, last_opened_at + 1) WHERE workspace_id = $1 AND project_id = $2 RETURNING project',
    [workspaceId, projectId, Date.now()]
  );
  return result.rowCount ? result.rows[0].project : null;
}

async function deletePixelForgeProjectFromDatabase(workspaceId, projectId) {
  const client = await accountPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [workspaceId]);
    const deleted = await client.query(
      'DELETE FROM codelab_pixelforge_projects WHERE workspace_id = $1 AND project_id = $2',
      [workspaceId, projectId]
    );
    await client.query('COMMIT');
    return deleted.rowCount > 0;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function savePixelForgeProjectToDatabase(workspaceId, project, projectBytes, options = {}) {
  const client = await accountPool.connect();
  try {
    await client.query('BEGIN');
    // A database advisory lock makes per-account quotas safe across server instances.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [workspaceId]);
    const usage = await client.query(
      'SELECT COUNT(*)::int AS count, COALESCE(SUM(byte_size), 0)::bigint AS bytes FROM codelab_pixelforge_projects WHERE workspace_id = $1 AND project_id <> $2',
      [workspaceId, project.id]
    );
    const existing = await client.query(
      'SELECT project, server_revision, content_sha256 FROM codelab_pixelforge_projects WHERE workspace_id = $1 AND project_id = $2',
      [workspaceId, project.id]
    );
    const count = Number(usage.rows[0].count);
    const bytes = Number(usage.rows[0].bytes);
    const storedProject = existing.rowCount ? existing.rows[0].project : null;
    const currentServerRevision = existing.rowCount
      ? Number(existing.rows[0].server_revision || (storedProject && storedProject.serverRevision) || 0) : 0;
    const expectedServerRevision = Number.isInteger(options.expectedServerRevision)
      ? options.expectedServerRevision
      : (Number.isInteger(project.serverRevision) ? project.serverRevision : 0);
    if (existing.rowCount && expectedServerRevision !== currentServerRevision) {
      await client.query('ROLLBACK');
      return { error: 'pixelforge_revision_conflict', status: 409, revision: currentServerRevision };
    }
    const preassignedRevision = options.preassignedServerRevision === true;
    const storedDocument = preassignedRevision ? project : { ...project, serverRevision: currentServerRevision + 1 };
    if (preassignedRevision && storedDocument.serverRevision !== currentServerRevision + 1) {
      await client.query('ROLLBACK');
      return { error: 'pixelforge_revision_conflict', status: 409, revision: currentServerRevision };
    }
    const serializedDocument = typeof options.serializedDocument === 'string'
      ? options.serializedDocument : JSON.stringify(storedDocument);
    const storedDocumentBytes = Buffer.byteLength(serializedDocument, 'utf8');
    if (storedDocumentBytes > PIXELFORGE_MAX_PROJECT_BYTES) {
      await client.query('ROLLBACK');
      return { error: 'pixelforge_project_too_large', status: 413, maxBytes: PIXELFORGE_MAX_PROJECT_BYTES };
    }
    if (!existing.rowCount && count >= MAX_PROJECTS) {
      await client.query('ROLLBACK');
      return { error: 'pixelforge_project_limit', status: 409, maxProjects: MAX_PROJECTS };
    }
    if (bytes + storedDocumentBytes > PIXELFORGE_MAX_ACCOUNT_BYTES) {
      await client.query('ROLLBACK');
      return { error: 'pixelforge_account_storage_limit', status: 413, maxBytes: PIXELFORGE_MAX_ACCOUNT_BYTES };
    }
    const now = Date.now();
    const contentSha256 = options.contentSha256 ||
      crypto.createHash('sha256').update(serializedDocument).digest('hex');
    await client.query(
      'INSERT INTO codelab_pixelforge_projects (workspace_id, project_id, name, width, height, updated_at, last_opened_at, project, byte_size, server_revision, content_sha256) VALUES ($1,$2,$3,$4,$5,$6,$6,$7::jsonb,$8,$9,$10) ON CONFLICT (workspace_id, project_id) DO UPDATE SET name=EXCLUDED.name, width=EXCLUDED.width, height=EXCLUDED.height, updated_at=EXCLUDED.updated_at, last_opened_at=EXCLUDED.last_opened_at, project=EXCLUDED.project, byte_size=EXCLUDED.byte_size, server_revision=EXCLUDED.server_revision, content_sha256=EXCLUDED.content_sha256',
      [workspaceId, project.id, project.name.trim(), project.width, project.height, now,
        serializedDocument, storedDocumentBytes, storedDocument.serverRevision, contentSha256]
    );
    await client.query('COMMIT');
    let evidenceEvent = null;
    try {
      evidenceEvent = await neonEvidence.createChangeEvent(accountPool, {
        workspaceId, projectId: project.id, revision: storedDocument.serverRevision,
        changeKind: 'project-save',
        metadata: { contentSha256, width: project.width, height: project.height }
      });
    } catch (evidenceError) {
      console.error('PixelForge Neon evidence event failed:', evidenceError.message);
    }
    return { status: existing.rowCount ? 200 : 201, now, serverRevision: storedDocument.serverRevision, contentSha256,
      ...(evidenceEvent ? { evidenceEvent } : {}) };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

const pixelForgeAccountQueues = new Map();
async function withPixelForgeAccountLock(workspaceId, operation) {
  const previous = pixelForgeAccountQueues.get(workspaceId) || Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const tail = previous.then(() => gate);
  pixelForgeAccountQueues.set(workspaceId, tail);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (pixelForgeAccountQueues.get(workspaceId) === tail) pixelForgeAccountQueues.delete(workspaceId);
  }
}

let pixelForgeUploadCommitQueue = Promise.resolve();
function withPixelForgeUploadCommitLock(operation) {
  const next = pixelForgeUploadCommitQueue.then(operation, operation);
  pixelForgeUploadCommitQueue = next.catch(() => {});
  return next;
}

const MAX_DESIGN_ELEMENTS = 500;

function validateProjects(projects) {
  if (!Array.isArray(projects)) return 'projects_not_array';
  if (projects.length > MAX_PROJECTS) return 'too_many_projects';
  const projectIds = new Set();
  for (const p of projects) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return 'invalid_project';
    if (typeof p.id !== 'string' || !p.id.trim() || p.id.length > 80) return 'invalid_project_id';
    if (projectIds.has(p.id)) return 'duplicate_project_id';
    projectIds.add(p.id);
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 200) return 'invalid_project_name';
    if (!p.code || typeof p.code !== 'object' || Array.isArray(p.code)) return 'invalid_project_code';
    for (const k of ['html', 'css', 'js']) {
      if (p.code[k] != null && typeof p.code[k] !== 'string') return 'invalid_code_field';
      if (typeof p.code[k] === 'string' && p.code[k].length > 500000) return 'code_too_large';
    }
    if (p.branch != null) {
      if (typeof p.branch !== 'object' || Array.isArray(p.branch)) return 'invalid_project_branch';
      if (p.branch.id != null && (typeof p.branch.id !== 'string' || !p.branch.id.trim() || p.branch.id.length > 100)) {
        return 'invalid_branch_id';
      }
      for (const codeKey of ['code', 'baseCode']) {
        const branchCode = p.branch[codeKey];
        if (branchCode == null) continue;
        if (typeof branchCode !== 'object' || Array.isArray(branchCode)) return 'invalid_branch_code';
        for (const field of ['html', 'css', 'js']) {
          if (branchCode[field] != null && typeof branchCode[field] !== 'string') return 'invalid_branch_code_field';
          if (typeof branchCode[field] === 'string' && branchCode[field].length > 500000) return 'branch_code_too_large';
        }
      }
      for (const timestampKey of ['updatedAt', 'baseMainUpdatedAt']) {
        if (p.branch[timestampKey] != null && typeof p.branch[timestampKey] !== 'string') return 'invalid_branch_timestamp';
      }
    }
    if (p.mergeHistory != null) {
      if (!Array.isArray(p.mergeHistory)) return 'invalid_merge_history';
      if (p.mergeHistory.length > 50) return 'merge_history_too_large';
      for (const entry of p.mergeHistory) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'invalid_merge_history_entry';
        if (entry.code != null) {
          if (typeof entry.code !== 'object' || Array.isArray(entry.code)) return 'invalid_merge_history_code';
          for (const field of ['html', 'css', 'js']) {
            if (entry.code[field] != null && typeof entry.code[field] !== 'string') return 'invalid_merge_history_code_field';
            if (typeof entry.code[field] === 'string' && entry.code[field].length > 500000) return 'merge_history_code_too_large';
          }
        }
        if (entry.branch != null && (typeof entry.branch !== 'object' || Array.isArray(entry.branch))) {
          return 'invalid_merge_history_branch';
        }
      }
    }
    if (p.design != null) {
      if (typeof p.design !== 'object' || Array.isArray(p.design)) return 'invalid_project_design';
      if (p.design.elements != null && !Array.isArray(p.design.elements)) return 'invalid_design_elements';
      if (Array.isArray(p.design.elements)) {
        if (p.design.elements.length > MAX_DESIGN_ELEMENTS) return 'too_many_design_elements';
        const elementIds = new Set();
        for (const element of p.design.elements) {
          if (!element || typeof element !== 'object' || Array.isArray(element)) return 'invalid_design_element';
          if (typeof element.id !== 'string' || !element.id.trim() || element.id.length > 100) return 'invalid_design_element_id';
          if (elementIds.has(element.id)) return 'duplicate_design_element_id';
          elementIds.add(element.id);
        }
      }
    }
  }
  return null;
}

function normalizeWorkspaceState(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('workspace_state_invalid');
  if (Object.prototype.hasOwnProperty.call(parsed, 'projects') && !Array.isArray(parsed.projects)) throw new Error('workspace_projects_invalid');
  if (Array.isArray(parsed.projects)) { const projectError = validateProjects(parsed.projects); if (projectError) throw new Error('workspace_projects_invalid:' + projectError); }
  if (parsed.revision != null && (!Number.isInteger(parsed.revision) || parsed.revision < 0)) throw new Error('workspace_revision_invalid');
  if (parsed.updatedAt != null && typeof parsed.updatedAt !== 'string') throw new Error('workspace_updated_at_invalid');
  if (parsed.owner != null && (typeof parsed.owner !== 'object' || Array.isArray(parsed.owner) || typeof parsed.owner.id !== 'string' || !parsed.owner.id || !['github','google','local'].includes(parsed.owner.provider))) throw new Error('workspace_owner_invalid');
  return { version: 5, revision: Number.isInteger(parsed.revision) ? parsed.revision : 0, updatedAt: parsed.updatedAt || new Date().toISOString(), projects: Array.isArray(parsed.projects) ? parsed.projects : [], owner: parsed.owner || null };
}
async function workspaceExists(id) {
  if (accountPool) { const result = await accountPool.query('SELECT 1 FROM codelab_workspace_states WHERE workspace_id=$1 LIMIT 1', [id]); if (result.rowCount) return true; }
  return fs.existsSync(workspaceFile(id));
}
async function readState(id) {
  if (accountPool) {
    const stored = await accountPool.query('SELECT state, revision, owner, updated_at FROM codelab_workspace_states WHERE workspace_id=$1', [id]);
    if (stored.rowCount) {
      const row = stored.rows[0], parsed = row.state && typeof row.state === 'object' ? row.state : {};
      return normalizeWorkspaceState({ ...parsed, revision: Number(row.revision), owner: row.owner || parsed.owner || null, updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : parsed.updatedAt });
    }
  }
  const file = workspaceFile(id); let parsed = emptyState();
  if (fs.existsSync(file)) { try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { throw new Error('workspace_state_invalid'); } }
  const normalized = normalizeWorkspaceState(parsed);
  if (accountPool) {
    const inserted = await accountPool.query(
      'INSERT INTO codelab_workspace_states (workspace_id, revision, state, owner, updated_at) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5) ON CONFLICT (workspace_id) DO NOTHING RETURNING workspace_id',
      [id, normalized.revision, JSON.stringify(normalized), JSON.stringify(normalized.owner), normalized.updatedAt]
    );
    if (!inserted.rowCount) return readState(id);
  }
  return normalized;
}
async function writeState(id, state, expectedRevision = null) {
  const payload = { version: 5, revision: state.revision, updatedAt: state.updatedAt, projects: state.projects, owner: state.owner || null };
  const serialized = JSON.stringify(payload);
  if (accountPool) {
    if (expectedRevision == null) {
      await accountPool.query('INSERT INTO codelab_workspace_states (workspace_id, revision, state, owner, updated_at) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5) ON CONFLICT (workspace_id) DO NOTHING',
        [id, payload.revision, serialized, JSON.stringify(payload.owner), payload.updatedAt]);
      return;
    }
    const updated = await accountPool.query('UPDATE codelab_workspace_states SET revision=$2,state=$3::jsonb,owner=$4::jsonb,updated_at=$5 WHERE workspace_id=$1 AND revision=$6 RETURNING workspace_id',
      [id, payload.revision, serialized, JSON.stringify(payload.owner), payload.updatedAt, expectedRevision]);
    if (!updated.rowCount) { const error = new Error('workspace_revision_conflict'); error.code = 'WORKSPACE_REVISION_CONFLICT'; throw error; }
    return;
  }
  const file = workspaceFile(id), tmp = file + '.tmp.' + process.pid + '.' + Date.now();
  try { fs.writeFileSync(tmp, serialized, { encoding: 'utf8', mode: 0o600 }); fs.renameSync(tmp, file); }
  catch (error) { try { fs.unlinkSync(tmp); } catch (_) {} throw error; }
}

// --- Cookies & sessions ---
function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i <= 0) return;
    const key = part.slice(0, i).trim();
    const rawValue = part.slice(i + 1).trim();
    // Malformed percent-encoding in an unrelated cookie must not turn every
    // authenticated API request into a 500 response.
    try { out[key] = decodeURIComponent(rawValue); }
    catch (_) { out[key] = rawValue; }
  });
  return out;
}

function sessionPath(sid) {
  return path.join(SESSIONS_DIR, safeId(sid) + '.json');
}

function isValidSessionUser(user) {
  return !!(user && typeof user === 'object' && !Array.isArray(user) &&
    typeof user.id === 'string' && user.id.length > 0 &&
    ['github', 'google', 'local'].includes(user.provider));
}

async function createSession(user) {
  if (!isValidSessionUser({ ...user, id: String(user.id) })) throw new Error('invalid_session_user');
  const sid = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  const session = {
    id: sid,
    user: {
      id: String(user.id),
      provider: user.provider,
      name: user.name || user.login || 'User',
      email: user.email || null,
      avatar: user.avatar || user.avatar_url || null,
      role: user.role || 'user'
    },
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS
  };
  if (accountPool) {
    await accountPool.query(
      'INSERT INTO codelab_auth_sessions (session_id, user_data, created_at, expires_at) VALUES ($1, $2::jsonb, to_timestamp($3 / 1000.0), to_timestamp($4 / 1000.0))',
      [sid, JSON.stringify(session.user), session.createdAt, session.expiresAt]
    );
    return session;
  }
  const file = sessionPath(sid);
  const tmp = file + '.tmp.' + process.pid + '.' + crypto.randomBytes(6).toString('hex');
  try {
    fs.writeFileSync(tmp, JSON.stringify(session), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw error;
  }
  return session;
}

async function readSession(sid) {
  if (typeof sid !== 'string' || !/^[a-f0-9]{48}$/.test(sid)) return null;
  if (accountPool) {
    const result = await accountPool.query(
      'SELECT user_data, (extract(epoch FROM created_at) * 1000)::bigint AS created_at_ms, (extract(epoch FROM expires_at) * 1000)::bigint AS expires_at_ms FROM codelab_auth_sessions WHERE session_id = $1 AND expires_at > NOW()',
      [sid]
    );
    if (!result.rowCount) return null;
    const user = result.rows[0].user_data;
    if (!isValidSessionUser(user)) {
      await accountPool.query('DELETE FROM codelab_auth_sessions WHERE session_id = $1', [sid]);
      return null;
    }
    return { id: sid, user, createdAt: Number(result.rows[0].created_at_ms), expiresAt: Number(result.rows[0].expires_at_ms) };
  }
  const file = sessionPath(sid);
  try {
    const session = JSON.parse(fs.readFileSync(file, 'utf8'));
    const valid = session && typeof session === 'object' && !Array.isArray(session) &&
      session.id === sid && Number.isFinite(session.expiresAt) && session.expiresAt > Date.now() &&
      isValidSessionUser(session.user);
    if (!valid) {
      try { fs.unlinkSync(file); } catch (_) {}
      return null;
    }
    return session;
  } catch (_) {
    return null;
  }
}

async function destroySession(sid) {
  if (typeof sid !== 'string' || !/^[a-f0-9]{48}$/.test(sid)) return;
  if (accountPool) {
    await accountPool.query('DELETE FROM codelab_auth_sessions WHERE session_id = $1', [sid]);
    return;
  }
  try { fs.unlinkSync(sessionPath(sid)); } catch (_) {}
}

async function getSessionUser(req) {
  const cookies = parseCookies(req);
  const session = await readSession(cookies[COOKIE_NAME]);
  return session ? session.user : null;
}

function setSessionCookie(res, sid, req) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    COOKIE_NAME + '=' + encodeURIComponent(sid) +
      '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000) + secure
  );
}

function clearSessionCookie(res, req) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + secure
  );
}

function isSecureRequest(req) {
  if (process.env.NODE_ENV === 'production') return true;
  const proto = req.headers['x-forwarded-proto'];
  return proto === 'https';
}

function publicBaseUrl(req) {
  if (OAUTH_PUBLIC_URL) return OAUTH_PUBLIC_URL;
  // Use the request Host supplied by the front proxy, not X-Forwarded-Host:
  // the latter can be client-controlled on misconfigured proxy chains and must
  // not be allowed to choose the OAuth callback origin.
  const proto = isSecureRequest(req) ? 'https' : 'http';
  const host = req.headers.host || 'localhost:' + PORT;
  return proto + '://' + host;
}

async function isAuthorized(req, id) {
  const token = req.headers['x-workspace-token'] || '';
  const expected = Buffer.from(signWorkspace(id));
  const received = Buffer.from(token);
  if (received.length === expected.length && crypto.timingSafeEqual(received, expected)) {
    return true;
  }
  // Session owner can access their bound workspace
  const user = await getSessionUser(req);
  if (user && userWorkspaceId(user) === id) return true;
  return false;
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-XSS-Protection', '0');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

function sendJson(res, status, body, extraHeaders) {
  setSecurityHeaders(res);
  const data = JSON.stringify(body);
  const headers = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    // API responses can contain workspace content, account metadata, or bearer
    // tokens; never let a browser or intermediary cache them as shared content.
    'Cache-Control': 'no-store'
  }, extraHeaders || {});
  res.writeHead(status, headers);
  res.end(data);
}

function redirect(res, location, extraHeaders) {
  const headers = Object.assign({
    Location: location,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'X-XSS-Protection': '0'
  }, extraHeaders || {});
  if (process.env.NODE_ENV === 'production') {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  res.writeHead(302, headers);
  res.end();
}

function redirectWithCookie(res, location, setCookieValue) {
  redirect(res, location, { 'Set-Cookie': setCookieValue });
}

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', chunk => {
      if (tooLarge || settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        // Keep the request stream alive long enough to return a real HTTP 413
        // instead of resetting the socket before the caller can send JSON.
        fail(Object.assign(new Error('payload_too_large'), { code: 'PAYLOAD_TOO_LARGE', status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge || settled) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        settled = true;
        return resolve({});
      }
      try {
        const parsed = JSON.parse(raw);
        settled = true;
        resolve(parsed);
      } catch (_) {
        fail(Object.assign(new Error('invalid_json'), { code: 'INVALID_JSON', status: 400 }));
      }
    });
    req.on('aborted', () => {
      fail(Object.assign(new Error('request_aborted'), { code: 'REQUEST_ABORTED', status: 400 }));
    });
    req.on('error', error => fail(error));
  });
}

const MAX_UPSTREAM_RESPONSE_BYTES = 5 * 1024 * 1024;

function httpsRequest(urlStr, options, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      hostname: u.hostname,
      port: u.port ? Number(u.port) : 443,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      ...(options.lookup ? { lookup: options.lookup } : {})
    };
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const succeed = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = https.request(opts, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        if (settled) return;
        size += chunk.length;
        if (size > MAX_UPSTREAM_RESPONSE_BYTES) {
          const error = Object.assign(new Error('upstream_response_too_large'), {
            code: 'UPSTREAM_RESPONSE_TOO_LARGE'
          });
          fail(error);
          req.destroy(error);
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const responseText = Buffer.concat(chunks).toString('utf8');
        succeed({ status: res.statusCode, headers: res.headers, body: responseText });
      });
      res.on('aborted', () => {
        fail(Object.assign(new Error('upstream_response_aborted'), { code: 'UPSTREAM_RESPONSE_ABORTED' }));
      });
      res.on('error', fail);
    });
    req.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      const error = Object.assign(new Error('upstream_timeout'), { code: 'UPSTREAM_TIMEOUT' });
      fail(error);
      req.destroy(error);
    });
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

async function readBinaryBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        fail(Object.assign(new Error('payload_too_large'), { code: 'PAYLOAD_TOO_LARGE', status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('aborted', () => fail(Object.assign(new Error('request_aborted'), { code: 'REQUEST_ABORTED', status: 400 })));
    req.on('error', error => fail(error));
  });
}

async function ensureAgentInlineArtifactSchema() {
  if (!accountPool) throw new Error('database_not_configured');
}
async function stageInlineArtifactChunk(artifactId, chunkIndex, bytes) {
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const result = await accountPool.query(
    `SELECT total_chunks, total_bytes FROM public.codelab_agent_artifacts
      WHERE artifact_id=$1 AND workspace_id=$2 AND kind IN ('pixelforge_zip_upload','codelab_zip_upload') AND expires_at>now()`,
    [artifactId, await resolveAdminAgentWorkspace()]
  );
  if (!result.rowCount) throw Object.assign(new Error('agent_artifact_not_found'), { status: 404 });
  const totalChunks = Number(result.rows[0].total_chunks);
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= totalChunks) {
    throw Object.assign(new Error('agent_artifact_chunk_index_invalid'), { status: 400 });
  }
  await accountPool.query(
    `INSERT INTO public.codelab_agent_artifact_chunks
      (artifact_id,chunk_index,chunk_data,chunk_sha256)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (artifact_id,chunk_index) DO UPDATE SET
       chunk_data=EXCLUDED.chunk_data, chunk_sha256=EXCLUDED.chunk_sha256`,
    [artifactId, chunkIndex, bytes, digest]
  );
  return { artifactId, chunkIndex, chunkBytes: bytes.length, chunkSha256: digest };
}

async function commitInlineAgentArtifact(artifactId, expectedSha256) {
  const workspaceId = await resolveAdminAgentWorkspace();
  const meta = await accountPool.query(
    `SELECT * FROM public.codelab_agent_artifacts
      WHERE artifact_id=$1 AND workspace_id=$2 AND kind IN ('pixelforge_zip_upload','codelab_zip_upload') AND expires_at>now()`,
    [artifactId, workspaceId]
  );
  if (!meta.rowCount) throw Object.assign(new Error('agent_artifact_not_found'), { status: 404 });
  const row = meta.rows[0];
  const chunks = await accountPool.query(
    `SELECT chunk_index,chunk_data,chunk_sha256
       FROM public.codelab_agent_artifact_chunks WHERE artifact_id=$1 ORDER BY chunk_index`,
    [artifactId]
  );
  if (chunks.rowCount !== Number(row.total_chunks)) {
    throw Object.assign(new Error('agent_artifact_incomplete'), { status: 409, receivedChunks: chunks.rowCount, totalChunks: Number(row.total_chunks) });
  }
  const parts = [];
  let total = 0;
  const hash = crypto.createHash('sha256');
  for (let i=0;i<chunks.rows.length;i++) {
    const chunk = chunks.rows[i];
    if (Number(chunk.chunk_index) !== i) throw Object.assign(new Error('agent_artifact_chunk_sequence_invalid'), { status: 409 });
    const bytes = Buffer.from(chunk.chunk_data);
    const chunkSha = crypto.createHash('sha256').update(bytes).digest('hex');
    if (chunkSha !== chunk.chunk_sha256) throw Object.assign(new Error('agent_artifact_chunk_integrity_failed'), { status: 422 });
    hash.update(bytes);
    total += bytes.length;
    parts.push(bytes);
  }
  const digest = hash.digest('hex');
  if (total !== Number(row.total_bytes) || digest !== row.sha256 || (expectedSha256 && digest !== String(expectedSha256).toLowerCase())) {
    throw Object.assign(new Error('agent_artifact_integrity_failed'), { status: 422 });
  }
  if (row.metadata?.selfTest) {
    return {
      ok: true, artifactId, status: 'verified',
      sizeBytes: total, chunkCount: Number(row.total_chunks), sha256: digest,
      selfTest: true
    };
  }
  const commandId = crypto.randomUUID();
  const isCodeLabImport = row.kind === 'codelab_zip_upload';
  const payload = isCodeLabImport
    ? {
        native_artifact_id: artifactId,
        import_request_id: row.metadata?.importRequestId || null,
        artifact_filename: row.filename,
        artifact_content_type: row.content_type,
        target_workspace_id: row.metadata?.targetWorkspaceId || PIXELFORGE_GUEST_WORKSPACE_ID,
        wake: true
      }
    : {
        artifact_id: artifactId,
        name: row.metadata?.projectName || row.filename.replace(/\\.codelab$/i, '').replace(/\\.zip$/i, ''),
        target_workspace_id: row.metadata?.targetWorkspaceId || PIXELFORGE_GUEST_WORKSPACE_ID,
        wake: true
      };
  if (isCodeLabImport && !payload.import_request_id) {
    throw Object.assign(new Error('agent_artifact_import_request_missing'), { status: 400 });
  }
  const action = isCodeLabImport ? 'codelab_project_import' : 'pixelforge_import_zip';
  await accountPool.query(
    `INSERT INTO public.codelab_agent_commands
      (command_id,workspace_id,action,payload,status,expires_at,updated_at)
     VALUES ($1,$2,$3,$4::jsonb,'queued',now()+interval '15 minutes',now())`,
    [commandId, workspaceId, action, JSON.stringify(payload)]
  );
  return {
    ok: true, artifactId, commandId, status: 'queued',
    action: isCodeLabImport ? 'codelab_project_import' : 'pixelforge_import_zip',
    sizeBytes: total, chunkCount: Number(row.total_chunks), sha256: digest
  };
}

function serveStatic(req, res, urlPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    setSecurityHeaders(res);
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
    return res.end('Method Not Allowed');
  }
  let rel;
  try {
    rel = decodeURIComponent(urlPath.split('?')[0]);
  } catch (_) {
    setSecurityHeaders(res);
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Bad Request');
  }
  // Reject obvious traversal / null bytes without falling back to SPA
  if (rel.includes('\0') || rel.includes('..') || rel.includes('%2e%2e') || rel.includes('%2E%2E')) {
    setSecurityHeaders(res);
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not Found');
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.resolve(PUBLIC_DIR, '.' + path.sep + rel.replace(/^[/]+/, ''));
  const relToPublic = path.relative(PUBLIC_DIR, filePath);
  if (relToPublic === '..' || relToPublic.startsWith('..' + path.sep) || path.isAbsolute(relToPublic)) {
    setSecurityHeaders(res);
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not Found');
  }
  fs.realpath(filePath, (realpathError, realPath) => {
    if (realpathError) {
      setSecurityHeaders(res);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    // Lexical path checks alone do not stop a symlink inside public/ from
    // pointing at a private server-side file outside the asset directory.
    const realRelative = path.relative(PUBLIC_REAL_DIR, realPath);
    if (realRelative === '..' || realRelative.startsWith('..' + path.sep) || path.isAbsolute(realRelative)) {
      setSecurityHeaders(res);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    fs.stat(realPath, (statError, stat) => {
      if (statError || !stat.isFile()) {
        setSecurityHeaders(res);
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not Found');
      }
      const ext = path.extname(realPath).toLowerCase();
      setSecurityHeaders(res);
      const headers = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': stat.size
      };
      // HTML references stable asset URLs; force revalidation so deployments cannot leave
      // users running stale application logic for a full day after a release.
      if (ext === '.html' || ext === '.js' || ext === '.mjs' || ext === '.css') {
        headers['Cache-Control'] = 'no-cache';
      }
      res.writeHead(200, headers);
      // HEAD needs only metadata; GET streams the file so large static assets do not
      // have to be fully buffered in memory for every concurrent client.
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(realPath);
      res.on('close', () => {
        // Stop disk reads when a client disconnects before the asset finishes.
        if (!res.writableEnded) stream.destroy();
      });
      stream.on('error', error => {
        console.error('static_asset_stream_failed', ext, error.message);
        if (res.headersSent) res.destroy();
        else {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
        }
      });
      stream.pipe(res);
    });
  });
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // Trust only the configured number of proxy-added hops. The default of one
    // matches a single trusted reverse proxy; deployments with a longer trusted
    // chain must set CODELAB_TRUSTED_PROXY_HOPS accordingly.
    const addresses = String(forwarded).split(',').map(value => value.trim());
    const parsedHops = Number.parseInt(process.env.CODELAB_TRUSTED_PROXY_HOPS || '1', 10);
    const trustedHops = Number.isInteger(parsedHops) && parsedHops > 0 ? parsedHops : 1;
    // Preserve hop positions: filtering malformed entries first could shift the
    // selected address and let a crafted header bypass the intended proxy trust.
    if (addresses.length >= trustedHops && addresses.every(address => net.isIP(address))) {
      return addresses[addresses.length - trustedHops];
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

function oauthConfigured() {
  return {
    github: !!(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET),
    google: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET)
  };
}

async function handleGithubCallback(code) {
  const body = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    client_secret: GITHUB_CLIENT_SECRET,
    code
  }).toString();
  const tokenRes = await httpsRequest('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': 'CodeLab-XD-Studio',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);
  const tokenJson = JSON.parse(tokenRes.body || '{}');
  if (!tokenJson.access_token) throw new Error('github_token_failed');
  const userRes = await httpsRequest('https://api.github.com/user', {
    method: 'GET',
    headers: {
      Authorization: 'Bearer ' + tokenJson.access_token,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'CodeLab-XD-Studio'
    }
  });
  const user = JSON.parse(userRes.body || '{}');
  if (!user.id) throw new Error('github_user_failed');
  let email = user.email || null;
  if (!email) {
    try {
      const emailsRes = await httpsRequest('https://api.github.com/user/emails', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + tokenJson.access_token,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'CodeLab-XD-Studio'
        }
      });
      const emails = JSON.parse(emailsRes.body || '[]');
      const primary = (emails || []).find(e => e.primary && e.verified) || (emails || [])[0];
      if (primary) email = primary.email;
    } catch (_) {}
  }
  return {
    id: String(user.id),
    provider: 'github',
    name: user.login || user.name || 'github_user',
    email,
    avatar: user.avatar_url || null
  };
}

async function handleGoogleCallback(code, redirectUri) {
  const body = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  }).toString();
  const tokenRes = await httpsRequest('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);
  const tokenJson = JSON.parse(tokenRes.body || '{}');
  if (!tokenJson.access_token) throw new Error('google_token_failed');
  const userRes = await httpsRequest('https://www.googleapis.com/oauth2/v2/userinfo', {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + tokenJson.access_token }
  });
  const user = JSON.parse(userRes.body || '{}');
  if (!user.id) throw new Error('google_user_failed');
  return {
    id: String(user.id),
    provider: 'google',
    name: user.name || user.email || 'google_user',
    email: user.email || null,
    avatar: user.picture || null
  };
}

async function ensureUserWorkspace(user) {
  if (!user || (user.provider !== 'github' && user.provider !== 'google' && user.provider !== 'local') ||
      user.id == null || !String(user.id).trim()) {
    throw new Error('workspace_owner_invalid');
  }
  const owner = { provider: user.provider, id: String(user.id) };
  const id = userWorkspaceId(owner);
  if (!(await workspaceExists(id))) { await writeState(id, emptyState(owner), null); return id; }
  // Never treat unreadable or malformed account state as an empty workspace.
  const state = await readState(id);
  if (!state.owner) {
    state.owner = owner;
    await writeState(id, state, state.revision);
  } else if (state.owner.provider !== owner.provider || state.owner.id !== owner.id) {
    throw new Error('workspace_owner_mismatch');
  }
  return id;
}

async function enforceSessionWorkspaceOwner(id, state, user) {
  if (!user || userWorkspaceId(user) !== id) return state;
  const expected = { provider: user.provider, id: String(user.id) };
  if (!state.owner) {
    state.owner = expected;
    await writeState(id, state, state.revision);
  } else if (state.owner.provider !== expected.provider || state.owner.id !== expected.id) {
    throw new Error('workspace_owner_mismatch');
  }
  return state;
}


function aiConfigured() {
  return {
    serverKey: !!AI_API_KEY,
    baseUrl: AI_BASE_URL,
    model: AI_MODEL,
    rawModel: _rawModel || null,
    groq: isGroqBase(AI_BASE_URL),
    openRouter: isOpenRouterBase(AI_BASE_URL)
  };
}

function isPublicProviderIp(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    const value = (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
    const ranges = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
      ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
    ];
    return !ranges.some(([network, bits]) => {
      const n = network.split('.').map(Number);
      const base = (((n[0] * 256 + n[1]) * 256 + n[2]) * 256 + n[3]) >>> 0;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (value & mask) === (base & mask);
    });
  }
  if (family === 6) {
    const ip = address.toLowerCase();
    // Only allow global-unicast IPv6. Explicitly block local, mapped, transition,
    // and documentation ranges to avoid reaching private services through IPv6.
    if (!/^[23][0-9a-f]{0,3}:/.test(ip)) return false;
    if (ip.startsWith('2001:')) {
      // The IANA special-purpose 2001::/23 block includes many reserved
      // subranges; reject it as a whole instead of only matching a few spellings.
      const secondHextet = ip.split(':')[1] || '0';
      const secondValue = Number.parseInt(secondHextet, 16);
      if (Number.isFinite(secondValue) && secondValue <= 0x1ff) return false;
      if (ip.startsWith('2001:db8:')) return false;
    }
    if (ip.startsWith('2002:') || ip.startsWith('3fff:')) return false;
    if (ip.startsWith('::ffff:') || ip === '::' || ip === '::1') return false;
    return true;
  }
  return false;
}

async function resolvePublicProviderTarget(urlString) {
  let target;
  try { target = new URL(urlString); }
  catch (_) { throw Object.assign(new Error('invalid_ai_provider_url'), { status: 400 }); }
  if (target.protocol !== 'https:' || target.username || target.password || target.hash) {
    throw Object.assign(new Error('AI provider URL must use HTTPS without embedded credentials or fragments.'), { status: 400 });
  }
  const hostname = target.hostname.startsWith('[') && target.hostname.endsWith(']')
    ? target.hostname.slice(1, -1)
    : target.hostname;
  let records;
  try { records = await dns.lookup(hostname, { all: true, verbatim: true }); }
  catch (_) { throw Object.assign(new Error('AI provider hostname could not be resolved.'), { status: 400 }); }
  if (!records.length || records.some(record => !isPublicProviderIp(record.address))) {
    throw Object.assign(new Error('AI provider URL must resolve only to public IP addresses.'), { status: 400 });
  }
  // Prefer IPv4 when the provider publishes both families: some hosting
  // networks still have incomplete IPv6 egress, while the full DNS set above
  // has already been checked to ensure no private address is mixed in.
  const pinned = records.find(record => record.family === 4) || records[0];
  return {
    url: target.toString(),
    lookup: (_hostname, options, callback) => {
      // Node may invoke custom lookup with either (hostname, callback) or
      // (hostname, options, callback). Also honor all:true when requested.
      if (typeof options === 'function') {
        callback = options;
        options = {};
      }
      if (options && options.all) {
        return callback(null, [{ address: pinned.address, family: pinned.family }]);
      }
      return callback(null, pinned.address, pinned.family);
    }
  };
}

async function proxyChatCompletions({ apiKey, baseUrl, model, messages, temperature, maxTokens, publicUrl }) {
  const base = (baseUrl || AI_BASE_URL).replace(/\/$/, '');
  const groq = isGroqBase(base);
  const openrouter = isOpenRouterBase(base);
  let useModel = resolveAiModel(model || AI_MODEL, base);

  const headers = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + apiKey
  };
  if (openrouter) {
    headers['HTTP-Referer'] = publicUrl || OAUTH_PUBLIC_URL || 'https://codelab-xd.local';
    headers['X-Title'] = 'CodeLab XD Studio Pro';
  }

  const providerTarget = await resolvePublicProviderTarget(base + '/chat/completions');

  async function doRequest(bodyObj) {
    const body = JSON.stringify(bodyObj);
    const h = Object.assign({}, headers, { 'Content-Length': Buffer.byteLength(body) });
    return httpsRequest(providerTarget.url, { method: 'POST', headers: h, lookup: providerTarget.lookup }, body);
  }

  function buildPayload(modelId, withJsonFormat) {
    const payload = {
      model: modelId,
      temperature: typeof temperature === 'number' ? temperature : 0.2,
      messages: messages
    };
    // Groq prefers max_tokens; keep moderate
    payload.max_tokens = Math.min(maxTokens || AI_MAX_TOKENS, groq ? 8192 : AI_MAX_TOKENS);
    // json_object: OpenAI/OpenRouter only — Groq models often reject or behave badly
    if (withJsonFormat && !groq) {
      payload.response_format = { type: 'json_object' };
    }
    return payload;
  }

  async function attempt(modelId, withJsonFormat) {
    const res = await doRequest(buildPayload(modelId, withJsonFormat));
    let parsed;
    try {
      parsed = JSON.parse(res.body || '{}');
    } catch (_) {
      throw Object.assign(new Error('Respuesta no JSON del proveedor (HTTP ' + res.status + ')'), {
        status: res.status,
        body: (res.body || '').slice(0, 400),
        model: modelId
      });
    }
    return { res, parsed, modelId };
  }

  // Try primary model
  let { res, parsed, modelId } = await attempt(useModel, !groq);

  // Drop response_format on 400
  if (res.status >= 400 && !groq) {
    const errMsg = String((parsed.error && parsed.error.message) || '');
    if (/response_format|json_object|unknown/i.test(errMsg) || res.status === 400) {
      ({ res, parsed, modelId } = await attempt(useModel, false));
    }
  }

  // Model not found / no access → try Groq fallbacks
  if (res.status >= 400) {
    const errMsg = String(
      (parsed.error && (parsed.error.message || parsed.error.code)) ||
        parsed.message ||
        ''
    );
    const modelFail = /model|not found|does not exist|access|decommissioned|invalid/i.test(errMsg);
    if (modelFail && groq) {
      for (const fb of GROQ_FALLBACKS) {
        if (fb === useModel) continue;
        console.warn('AI model failed (' + useModel + '): ' + errMsg + ' → trying ' + fb);
        const trial = await attempt(fb, false);
        if (trial.res.status >= 200 && trial.res.status < 300) {
          res = trial.res;
          parsed = trial.parsed;
          modelId = trial.modelId;
          useModel = fb;
          break;
        }
        res = trial.res;
        parsed = trial.parsed;
        modelId = trial.modelId;
      }
    }
  }

  if (res.status < 200 || res.status >= 300) {
    const msg =
      (parsed && parsed.error && (parsed.error.message || parsed.error.code)) ||
      (parsed && parsed.message) ||
      ('HTTP ' + res.status);
    throw Object.assign(
      new Error(String(msg) + ' [modelo=' + modelId + ']'),
      { status: res.status, body: (res.body || '').slice(0, 400), model: modelId }
    );
  }

  let content = ((((parsed.choices || [])[0] || {}).message) || {}).content || '';
  if (Array.isArray(content)) {
    content = content.map(function (p) {
      return (p && p.text) || (p && p.content) || '';
    }).join('');
  }
  if (!content || !String(content).trim()) {
    throw Object.assign(new Error('El modelo devolvió respuesta vacía [modelo=' + modelId + ']'), {
      status: 502,
      model: modelId
    });
  }
  return { content: String(content), raw: parsed, model: modelId };
}

function buildAiSystemPrompt(code) {
  const html = String((code && code.html) || '').slice(0, 12000);
  const css = String((code && code.css) || '').slice(0, 12000);
  const js = String((code && code.js) || '').slice(0, 12000);
  return (
    'Eres un ingeniero frontend. Debes modificar el código web del usuario.\n' +
    'FORMATO DE RESPUESTA (obligatorio):\n' +
    'Devuelve UN objeto JSON con exactamente 4 claves string: html, css, js, message.\n' +
    'Ejemplo mínimo:\n' +
    '{"html":"<h1>Hola</h1>","css":"h1{color:blue}","js":"console.log(1)","message":"Título azul"}\n' +
    'Reglas:\n' +
    '- Sin markdown, sin ```, sin texto fuera del JSON.\n' +
    '- Si solo cambias una parte, incluye igual las otras claves con el código actual.\n' +
    '- message en español, una frase.\n' +
    '- Código ejecutable en navegador sin bundler.\n\n' +
    'HTML actual:\n' + html + '\n\nCSS actual:\n' + css + '\n\nJS actual:\n' + js
  );
}

function extractJsonObject(text) {
  const s = String(text || '');
  // Direct parse
  try {
    return JSON.parse(s.trim());
  } catch (_) {}
  // Strip fences
  let cleaned = s
    .replace(/^```(?:json|javascript|js)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {}
  // Find outermost { ... }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const slice = cleaned.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch (_) {
      // Try to fix trailing commas
      try {
        return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'));
      } catch (__) {}
    }
  }
  return null;
}

/** If model returned plain code or partial fields, salvage what we can. */
function salvageCodeFromText(text, fallback) {
  const out = {
    html: fallback.html || '',
    css: fallback.css || '',
    js: fallback.js || '',
    message: 'Respuesta adaptada (el modelo no devolvió JSON perfecto).'
  };
  const s = String(text || '');
  // fenced blocks by language
  const htmlM = s.match(/```(?:html)?\s*([\s\S]*?)```/i);
  const cssM = s.match(/```css\s*([\s\S]*?)```/i);
  const jsM = s.match(/```(?:js|javascript)\s*([\s\S]*?)```/i);
  if (htmlM) out.html = htmlM[1].trim();
  if (cssM) out.css = cssM[1].trim();
  if (jsM) out.js = jsM[1].trim();
  // Heuristic: if only one big HTML-looking chunk
  if (!htmlM && /<\/?[a-z][\s\S]*>/i.test(s) && s.length < 50000) {
    const stripped = s.replace(/^```[\s\S]*?\n/, '').replace(/```$/, '').trim();
    if (stripped.startsWith('<') || stripped.includes('<div') || stripped.includes('<!DOCTYPE')) {
      out.html = stripped;
      out.message = 'HTML extraído de la respuesta del modelo.';
    }
  }
  return out;
}

function parseAiJsonContent(content, fallbackCode) {
  const code = {
    html: (fallbackCode && fallbackCode.html) || '',
    css: (fallbackCode && fallbackCode.css) || '',
    js: (fallbackCode && fallbackCode.js) || ''
  };
  const parsed = extractJsonObject(content);
  if (parsed && typeof parsed === 'object') {
    // Accept alternate key names some models invent
    const html = parsed.html ?? parsed.HTML ?? parsed.markup ?? parsed.content;
    const css = parsed.css ?? parsed.CSS ?? parsed.styles ?? parsed.style;
    const js = parsed.js ?? parsed.JS ?? parsed.javascript ?? parsed.script;
    const message = parsed.message ?? parsed.msg ?? parsed.summary ?? parsed.description;
    const hasAny =
      typeof html === 'string' || typeof css === 'string' || typeof js === 'string';
    if (hasAny) {
      return {
        html: typeof html === 'string' ? html : code.html,
        css: typeof css === 'string' ? css : code.css,
        js: typeof js === 'string' ? js : code.js,
        message: typeof message === 'string' ? message : 'Cambios aplicados.'
      };
    }
  }
  // Last resort: salvage fenced code from free-form reply
  const salvaged = salvageCodeFromText(content, code);
  if (
    salvaged.html !== code.html ||
    salvaged.css !== code.css ||
    salvaged.js !== code.js
  ) {
    return salvaged;
  }
  throw new Error(
    'El modelo no devolvió JSON usable. Prueba AI_MODEL=openai/gpt-oss-20b o llama-3.3-70b-versatile.'
  );
}

seedAdminAccountIfConfigured();


let headlessMailboxSchemaPromise = null;
async function ensureHeadlessMailboxSchema() {
  if (!accountPool) throw new Error('database_not_configured');
  if (!headlessMailboxSchemaPromise) {
    headlessMailboxSchemaPromise = accountPool.query(`
      CREATE TABLE IF NOT EXISTS codelab_headless_sessions (
        session_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS codelab_headless_requests (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES codelab_headless_sessions(session_id) ON DELETE CASCADE,
        payload JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','expired')),
        result JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        lease_until TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS codelab_headless_requests_session_status_idx
        ON codelab_headless_requests(session_id, status, created_at);
      CREATE INDEX IF NOT EXISTS codelab_headless_sessions_expires_idx
        ON codelab_headless_sessions(expires_at);
    `);
  }
  await headlessMailboxSchemaPromise;
}
function headlessMailboxHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}
function validHeadlessMailboxToken(token) {
  return typeof token === 'string' && /^[a-f0-9]{64}$/i.test(token);
}
async function authorizeHeadlessMailbox(sessionId, token) {
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(String(sessionId || '')) || !validHeadlessMailboxToken(token)) return null;
  await ensureHeadlessMailboxSchema();
  const row = await accountPool.query(
    'SELECT session_id, expires_at FROM codelab_headless_sessions WHERE session_id=$1 AND token_hash=$2 AND expires_at > NOW()',
    [sessionId, headlessMailboxHash(token)]
  );
  return row.rowCount ? row.rows[0] : null;
}

const server = http.createServer(async (req, res) => {
  const ip = clientIp(req);
  let pathname;
  let searchParams;
  try {
    const u = new URL(req.url || '/', 'http://localhost');
    pathname = u.pathname;
    searchParams = u.searchParams;
  } catch (_) {
    return sendJson(res, 400, { error: 'bad_url' });
  }

  // Agent Space: isolated browser cockpit, served from its own public subdirectory.
  // It only drives the same-origin page in its iframe; it does not expose server-side execution.
  if (pathname === '/agent-space' || pathname === '/agent-space/') {
    return serveStatic(req, res, '/agent-space/index.html');
  }

  if (pathname === '/admin/storage-migration' || pathname === '/admin/storage-migration/') {
    return serveStatic(req, res, '/admin-storage-migration.html');
  }

  if (pathname.startsWith('/api/')) {
    // Admin accounts are exempt from the app-wide API request cap. Keep the
    // exemption tied to a validated local admin session, never a client header
    // or request parameter. The dedicated AI/provider limiter remains separate.
    const apiSessionUser = await getSessionUser(req);
    const isAdminSession = !!(
      apiSessionUser &&
      apiSessionUser.provider === 'local' &&
      apiSessionUser.role === 'admin'
    );
    if (!isAdminSession && !checkRateLimit(ip)) {
      return sendJson(res, 429, { error: 'rate_limited', message: 'Demasiadas peticiones.' });
    }
    try {
      // One-time, local-admin-only migration of the two CodeLab proof captures.
      // Signed URLs stay server-side in Render environment variables and are never
      // returned to the browser or written to logs.
      if (req.method === 'POST' && pathname === '/api/admin/storage-migration') {
        if (!isAdminSession) return sendJson(res, 403, { error: 'admin_required' });
        const expectedHost = 'br-misty-sea-b5qkh03f.storage.c-7.us-east-2.aws.neon.tech';
        const jobs = [
          {
            key: 'pixelforge/2026-11-05/first-proof/interface.png',
            source: process.env.NEON_MIGRATE_INTERFACE_SOURCE_URL,
            target: process.env.NEON_MIGRATE_INTERFACE_TARGET_URL
          },
          {
            key: 'pixelforge/2026-11-05/first-proof/artwork.png',
            source: process.env.NEON_MIGRATE_ARTWORK_SOURCE_URL,
            target: process.env.NEON_MIGRATE_ARTWORK_TARGET_URL
          }
        ];
        if (jobs.some(job => !job.source || !job.target)) {
          return sendJson(res, 503, { error: 'migration_urls_not_configured', message: 'Faltan los enlaces temporales de transferencia.' });
        }
        const copied = await Promise.all(jobs.map(async job => {
          const sourceUrl = new URL(job.source);
          const targetUrl = new URL(job.target);
          if (sourceUrl.protocol !== 'https:' || targetUrl.protocol !== 'https:' ||
              sourceUrl.hostname !== expectedHost || targetUrl.hostname !== expectedHost ||
              !sourceUrl.pathname.startsWith('/codelab-captures/') ||
              !targetUrl.pathname.startsWith('/codelab-captures-public/')) {
            throw new Error('capture_migration_url_validation_failed');
          }
          const download = await fetch(sourceUrl, { method: 'GET', signal: AbortSignal.timeout(30000) });
          if (!download.ok) throw new Error('capture_source_download_failed_' + download.status);
          const bytes = Buffer.from(await download.arrayBuffer());
          const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
          if (bytes.length < 8 || !bytes.subarray(0, 8).equals(pngSignature)) {
            throw new Error('capture_source_not_png');
          }
          const upload = await fetch(targetUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'image/png' },
            body: bytes,
            signal: AbortSignal.timeout(30000)
          });
          if (!upload.ok) throw new Error('capture_destination_upload_failed_' + upload.status);
          return { key: job.key, bytes: bytes.length };
        }));
        return sendJson(res, 200, { ok: true, bucket: 'codelab-captures-public', objects: copied });
      }


      // Persistent headless A<->B mailbox. The high-entropy mailbox token is the
      // capability credential; GitHub issue comments are used only for one-time
      // session discovery, never for request/result polling.
      if (pathname.startsWith('/api/headless/session/')) {
        if (!accountPool) return sendJson(res, 503, { error: 'mailbox_database_not_configured' });
        await ensureHeadlessMailboxSchema();
        if (req.method === 'POST' && pathname === '/api/headless/session/register') {
          const body = await readBody(req);
          const sessionId = String(body.sessionId || '');
          const token = String(body.token || '');
          const expiresAt = new Date(String(body.expiresAt || ''));
          if (!/^[a-zA-Z0-9_-]{16,128}$/.test(sessionId) || !validHeadlessMailboxToken(token) ||
              Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now() ||
              expiresAt.getTime() > Date.now() + 60 * 60 * 1000) {
            return sendJson(res, 400, { error: 'invalid_headless_session' });
          }
          await accountPool.query(
            'INSERT INTO codelab_headless_sessions(session_id,token_hash,expires_at) VALUES($1,$2,$3) ON CONFLICT(session_id) DO UPDATE SET token_hash=EXCLUDED.token_hash, expires_at=EXCLUDED.expires_at',
            [sessionId, headlessMailboxHash(token), expiresAt.toISOString()]
          );
          return sendJson(res, 201, { ok: true, sessionId, expiresAt: expiresAt.toISOString() });
        }

        const requestUrl = new URL(req.url || '/', 'http://localhost');
        const sessionId = String(requestUrl.searchParams.get('sessionId') || '');
        const token = String(req.headers['x-codelab-mailbox-token'] || requestUrl.searchParams.get('token') || '');
        const session = await authorizeHeadlessMailbox(sessionId, token);
        if (!session) return sendJson(res, 404, { error: 'headless_session_not_found' });

        if (req.method === 'POST' && pathname === '/api/headless/session/request') {
          const body = await readBody(req);
          const requestId = String(body.requestId || '');
          const payload = body.payload;
          if (!/^[a-zA-Z0-9_-]{16,128}$/.test(requestId) || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
            return sendJson(res, 400, { error: 'invalid_headless_request' });
          }
          await accountPool.query(
            'INSERT INTO codelab_headless_requests(request_id,session_id,payload) VALUES($1,$2,$3::jsonb)',
            [requestId, sessionId, JSON.stringify(payload)]
          );
          return sendJson(res, 202, { ok: true, requestId });
        }

        if (req.method === 'POST' && pathname === '/api/headless/session/claim') {
          const client = await accountPool.connect();
          try {
            await client.query('BEGIN');
            await client.query(
              "UPDATE codelab_headless_requests SET status='expired', finished_at=NOW() WHERE session_id=$1 AND status IN ('queued','running') AND created_at < NOW() - INTERVAL '15 minutes'",
              [sessionId]
            );
            const picked = await client.query(
              "SELECT request_id,payload FROM codelab_headless_requests WHERE session_id=$1 AND status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",
              [sessionId]
            );
            if (!picked.rowCount) {
              await client.query('COMMIT');
              res.writeHead(204, { 'Cache-Control': 'no-store' });
              return res.end();
            }
            const row = picked.rows[0];
            await client.query(
              "UPDATE codelab_headless_requests SET status='running',started_at=NOW(),lease_until=NOW()+INTERVAL '5 minutes' WHERE request_id=$1",
              [row.request_id]
            );
            await client.query('COMMIT');
            return sendJson(res, 200, { ok: true, requestId: row.request_id, payload: row.payload });
          } catch (error) {
            try { await client.query('ROLLBACK'); } catch {}
            throw error;
          } finally {
            client.release();
          }
        }

        if (req.method === 'POST' && pathname === '/api/headless/session/result') {
          const body = await readBody(req);
          const requestId = String(body.requestId || '');
          const status = body.status === 'failed' ? 'failed' : 'succeeded';
          if (!/^[a-zA-Z0-9_-]{16,128}$/.test(requestId) || body.result === undefined) {
            return sendJson(res, 400, { error: 'invalid_headless_result' });
          }
          const updated = await accountPool.query(
            'UPDATE codelab_headless_requests SET status=$2,result=$3::jsonb,finished_at=NOW(),lease_until=NULL WHERE request_id=$1 AND session_id=$4 AND status=\'running\' RETURNING request_id',
            [requestId, status, JSON.stringify(body.result), sessionId]
          );
          if (!updated.rowCount) return sendJson(res, 409, { error: 'headless_request_not_running' });
          return sendJson(res, 200, { ok: true, requestId });
        }

        if (req.method === 'GET' && pathname === '/api/headless/session/result') {
          const requestId = String(requestUrl.searchParams.get('requestId') || '');
          if (!/^[a-zA-Z0-9_-]{16,128}$/.test(requestId)) return sendJson(res, 400, { error: 'invalid_headless_request_id' });
          const row = await accountPool.query(
            'SELECT request_id,status,result,created_at,started_at,finished_at FROM codelab_headless_requests WHERE request_id=$1 AND session_id=$2',
            [requestId, sessionId]
          );
          if (!row.rowCount) return sendJson(res, 404, { error: 'headless_request_not_found' });
          return sendJson(res, 200, row.rows[0]);
        }

        return sendJson(res, 404, { error: 'headless_mailbox_route_not_found' });
      }

      // Health
      if ((req.method === 'GET' || req.method === 'HEAD') && /^\/api\/agent-commands\/[A-Za-z0-9_-]+\/video$/.test(pathname)) {
        const user = await getSessionUser(req);
        if (!PIXELFORGE_GUEST_MODE && !user) return sendJson(res, 401, { error: 'not_authenticated' });
        const targetWorkspace = PIXELFORGE_GUEST_MODE ? PIXELFORGE_GUEST_WORKSPACE_ID : userWorkspaceId(user);
        const commandId = pathname.split('/')[3];
        const adminWorkspace = await resolveAdminAgentWorkspace();
        const row = await accountPool.query(
          "SELECT COALESCE(result->'video'->>'dataBase64', result->'artifact'->>'dataBase64') AS data_base64, payload->>'target_workspace_id' AS target_workspace_id FROM public.codelab_agent_commands WHERE command_id=$1 AND workspace_id=$2 AND status='succeeded'",
          [commandId, adminWorkspace]
        );
        if (!row.rowCount || row.rows[0].target_workspace_id !== targetWorkspace) return sendJson(res, 404, { error: 'video_not_found' });
        const base64 = row.rows[0]?.data_base64;
        if (!base64) return sendJson(res, 404, { error: 'video_not_found' });
        const bytes = Buffer.from(base64, 'base64');
        setSecurityHeaders(res);
        res.writeHead(200, {
          'Content-Type': 'video/webm',
          'Content-Length': String(bytes.length),
          'Content-Disposition': 'inline; filename="codelab-evidence.webm"',
          'Cache-Control': 'private, max-age=3600'
        });
        if (req.method === 'HEAD') return res.end();
        return res.end(bytes);
      }

      if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/api/health') {
        const cfg = oauthConfigured();
        const body = {
          ok: true,
          version: APP_VERSION,
          persistence: accountPool ? 'postgresql' : 'server-file',
          maxBodyBytes: MAX_BODY_BYTES,
          maxProjects: MAX_PROJECTS,
          oauth: cfg,
          ai: aiConfigured()
        };
        if (req.method === 'HEAD') {
          setSecurityHeaders(res);
          const data = JSON.stringify(body);
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(data),
            'Cache-Control': 'no-store'
          });
          return res.end();
        }
        return sendJson(res, 200, body);
      }

            // Expiring capability URL for native artifacts produced by the ADMIN bridge.
      // The 128-bit random artifact ID is the bearer capability; records are workspace- and kind-scoped.
      const nativeArtifactDownload = (req.method === 'GET' || req.method === 'HEAD')
        ? pathname.match(/^\/api\/agent\/artifacts\/([a-f0-9]{32})$/) : null;
      if (nativeArtifactDownload) {
        if (!accountPool) return sendJson(res, 503, { error: 'database_not_configured' });
        try {
          const admin = await accountPool.query("SELECT id FROM codelab_accounts WHERE username='ADMIN' AND role='admin' LIMIT 1");
          if (!admin.rowCount) return sendJson(res, 404, { error: 'artifact_not_found' });
          const workspaceId = 'ws_local_' + String(admin.rows[0].id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
          const meta = await accountPool.query(
            "SELECT filename,content_type,total_bytes,total_chunks,sha256 FROM public.codelab_agent_artifacts WHERE artifact_id=$1 AND workspace_id=$2 AND kind='codelab_project_png' AND expires_at>now()",
            [nativeArtifactDownload[1], workspaceId]
          );
          if (!meta.rowCount) return sendJson(res, 404, { error: 'artifact_not_found_or_expired' });
          const row = meta.rows[0];
          const chunks = await accountPool.query('SELECT chunk_index,chunk_data,chunk_sha256 FROM public.codelab_agent_artifact_chunks WHERE artifact_id=$1 ORDER BY chunk_index', [nativeArtifactDownload[1]]);
          if (chunks.rowCount !== Number(row.total_chunks)) return sendJson(res, 409, { error: 'artifact_incomplete' });
          const parts = []; const hash = crypto.createHash('sha256'); let total = 0;
          for (let i=0;i<chunks.rows.length;i++) {
            const chunk = chunks.rows[i]; const bytes = Buffer.from(chunk.chunk_data);
            const digest = crypto.createHash('sha256').update(bytes).digest('hex');
            if (Number(chunk.chunk_index)!==i || digest!==chunk.chunk_sha256) return sendJson(res, 422, { error: 'artifact_integrity_failed' });
            hash.update(bytes); total += bytes.length; parts.push(bytes);
          }
          if (total!==Number(row.total_bytes) || hash.digest('hex')!==row.sha256) return sendJson(res, 422, { error: 'artifact_integrity_failed' });
          const bytes = Buffer.concat(parts);
          setSecurityHeaders(res);
          res.writeHead(200, {
            'Content-Type': row.content_type,
            'Content-Length': String(bytes.length),
            'Content-Disposition': 'attachment; filename="' + String(row.filename).replace(/["\\\\\\r\\n]/g, '_') + '"',
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff'
          });
          return req.method === 'HEAD' ? res.end() : res.end(bytes);
        } catch (error) {
          return sendJson(res, 503, { error: String(error.message || 'artifact_download_failed') });
        }
      }

      // Inline native artifact transport: the isolated Headless sends the .codelab
      // through CodeLab itself, never directly to Neon Storage/S3. The payload is
      // chunked at 1 MiB and the final commit enqueues the existing native import command.
      const inlineArtifactBegin = req.method === 'POST' && pathname === '/api/agent/bridge/artifacts';
      const inlineArtifactChunk = req.method === 'PUT'
        ? pathname.match(/^\/api\/agent\/bridge\/artifacts\/([a-f0-9]{32})\/(\d+)$/) : null;
      const inlineArtifactCommit = req.method === 'POST'
        ? pathname.match(/^\/api\/agent\/bridge\/artifacts\/([a-f0-9]{32})\/commit$/) : null;
      if (inlineArtifactBegin || inlineArtifactChunk || inlineArtifactCommit) {
        const supplied = String(req.headers['x-codelab-agent-bridge-token'] || searchParams.get('token') || '');
        const acceptedBridgeToken = String(process.env.AGENT_INLINE_ARTIFACT_SMOKE_TEST || '') === '1' && process.env.AGENT_BRIDGE_CONTROL_SECRET_TEST
          ? String(process.env.AGENT_BRIDGE_CONTROL_SECRET_TEST)
          : AGENT_BRIDGE_CONTROL_SECRET || String(process.env.AGENT_BRIDGE_CONTROL_SECRET_TEST || '');
        if (!acceptedBridgeToken || !safeTokenEqual(supplied, acceptedBridgeToken)) {
          return sendJson(res, 401, { error: 'agent_bridge_unauthorized' });
        }
        if (!accountPool) return sendJson(res, 503, { error: 'database_not_configured' });
        try {
          await ensureAgentInlineArtifactSchema();
          const workspaceId = await resolveAdminAgentWorkspace();
          if (inlineArtifactBegin) {
            const body = await readBody(req, 1024 * 1024);
            const totalBytes = Number(body.total_bytes);
            const totalChunks = Number(body.total_chunks);
            const sha256 = String(body.sha256 || '').toLowerCase();
            const filename = String(body.filename || 'pixelforge.codelab').slice(0, 180);
            const requestedTargetWorkspaceId = body.target_workspace_id == null ? workspaceId : String(body.target_workspace_id);
            if (requestedTargetWorkspaceId !== workspaceId) return sendJson(res, 403, { error: 'agent_artifact_target_must_be_admin' });
            const targetWorkspaceId = workspaceId;
            const artifactKind = String(body.artifact_kind || 'pixelforge_zip_upload');
            let importRequestId = body.import_request_id == null ? null : String(body.import_request_id);
            const editorId = String(body.editor_id || 'pixelforge');
            const sourceProjectId = body.source_project_id == null ? null : String(body.source_project_id).slice(0, 100);
            if (!['pixelforge_zip_upload', 'codelab_zip_upload'].includes(artifactKind) ||
                (artifactKind === 'codelab_zip_upload' &&
                  ((importRequestId && !/^[a-zA-Z0-9_-]{16,128}$/.test(importRequestId)) ||
                   !['web', 'design', 'pixelforge'].includes(editorId)))) {
              return sendJson(res, 400, { error: 'invalid_agent_artifact_kind' });
            }
            if (!Number.isInteger(totalBytes) || totalBytes < 1 || totalBytes > AGENT_INLINE_ARTIFACT_MAX_BYTES ||
                !Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > 256 ||
                !/^[a-f0-9]{64}$/.test(sha256) ||
                !/^ws_[a-zA-Z0-9_-]{1,140}$/.test(targetWorkspaceId)) {
              return sendJson(res, 400, { error: 'invalid_agent_artifact_manifest' });
            }
            const expectedChunks = Math.ceil(totalBytes / AGENT_INLINE_ARTIFACT_CHUNK_BYTES);
            if (expectedChunks !== totalChunks) return sendJson(res, 400, { error: 'agent_artifact_chunk_count_mismatch', expectedChunks });
            if (artifactKind === 'codelab_zip_upload' && body.self_test !== true) {
              importRequestId ||= crypto.randomUUID();
              await accountPool.query(
                `INSERT INTO public.codelab_project_import_requests
                  (import_request_id,workspace_id,editor_id,source_project_id,manifest,status,confirmation_required,confirmation_received,work_score)
                 VALUES ($1,$2,$3,$4,$5::jsonb,'queued',false,false,0)
                 ON CONFLICT (import_request_id) DO NOTHING`,
                [importRequestId, workspaceId, editorId, sourceProjectId,
                 JSON.stringify({ source: 'inline-agent-bridge', targetWorkspaceId, projectName: body.project_name || null })]
              );
              const requestCheck = await accountPool.query(
                'SELECT workspace_id,editor_id,status FROM public.codelab_project_import_requests WHERE import_request_id=$1',
                [importRequestId]
              );
              if (!requestCheck.rowCount || requestCheck.rows[0].workspace_id !== workspaceId ||
                  requestCheck.rows[0].editor_id !== editorId ||
                  !['queued', 'approved'].includes(requestCheck.rows[0].status)) {
                return sendJson(res, 409, { error: 'agent_artifact_import_request_conflict' });
              }
            }
            const artifactId = crypto.randomUUID().replaceAll('-', '');
            await accountPool.query(
              `INSERT INTO public.codelab_agent_artifacts
                (artifact_id,workspace_id,kind,filename,content_type,total_bytes,total_chunks,sha256,metadata,expires_at)
               VALUES ($1,$2,$3,$4,'application/zip',$5,$6,$7,$8::jsonb,now()+interval '1 hour')`,
              [artifactId, workspaceId, artifactKind, filename, totalBytes, totalChunks, sha256,
               JSON.stringify({ targetWorkspaceId, projectName: body.project_name || null, importRequestId, selfTest: body.self_test === true, transport: 'inline-bridge' })]
            );
            return sendJson(res, 201, {
              ok: true, artifactId, importRequestId,
              chunkBytes: AGENT_INLINE_ARTIFACT_CHUNK_BYTES, totalBytes, totalChunks, sha256
            });
          }
          if (inlineArtifactChunk) {
            const bytes = await readBinaryBody(req, AGENT_INLINE_ARTIFACT_CHUNK_BYTES);
            if (!bytes.length) return sendJson(res, 400, { error: 'empty_agent_artifact_chunk' });
            const result = await stageInlineArtifactChunk(inlineArtifactChunk[1], Number(inlineArtifactChunk[2]), bytes);
            return sendJson(res, 200, { ok: true, ...result });
          }
          const body = await readBody(req, 1024 * 1024);
          const result = await commitInlineAgentArtifact(inlineArtifactCommit[1], String(body.sha256 || '').toLowerCase());
          return sendJson(res, 202, result);
        } catch (error) {
          return sendJson(res, error.status || 503, {
            error: error.code || String(error.message || 'agent_artifact_transport_failed'),
            ...(Number.isInteger(error.receivedChunks) ? { receivedChunks: error.receivedChunks } : {}),
            ...(Number.isInteger(error.totalChunks) ? { totalChunks: error.totalChunks } : {})
          });
        }
      }

// Agent-controlled bridge lifecycle. Starting the bridge is an explicit operation:
      // no cron, interval, heartbeat or automatic timer is used to wake the worker.
      // Agent-controlled bridge lifecycle. Starting the bridge is an explicit operation:
      // no cron, interval, heartbeat or automatic timer is used to wake the worker.
      if ((req.method === 'POST' || req.method === 'GET') && pathname === '/api/agent/bridge/ensure') {
        // POST is the canonical agent operation. GET is intentionally supported
        // as a transport fallback for agent runtimes that cannot set headers;
        // the token is still required and the response is never cached.
        const queryToken = url.searchParams.get('token') || '';
        const supplied = String(req.headers['x-codelab-agent-bridge-token'] || queryToken);
        if (!AGENT_BRIDGE_CONTROL_SECRET || !safeTokenEqual(supplied, AGENT_BRIDGE_CONTROL_SECRET)) {
          return sendJson(res, 401, { error: 'agent_bridge_unauthorized' });
        }
        try {
          res.setHeader('Cache-Control', 'no-store');
          return sendJson(res, 200, {
            ok: true,
            operation: 'ensure_bridge',
            message: agentBridgeWorker ? 'bridge_already_running' : 'bridge_started',
            bridge: startAgentBridge()
          });
        } catch (error) {
          return sendJson(res, 503, { error: String(error.message || error) });
        }
      }

      if (req.method === 'GET' && pathname === '/api/agent/bridge/state') {
        const supplied = String(req.headers['x-codelab-agent-bridge-token'] || url.searchParams.get('token') || '');
        if (!AGENT_BRIDGE_CONTROL_SECRET || !safeTokenEqual(supplied, AGENT_BRIDGE_CONTROL_SECRET)) {
          return sendJson(res, 401, { error: 'agent_bridge_unauthorized' });
        }
        if (!accountPool) return sendJson(res, 503, { error: 'database_not_configured' });
        try {
          const admin = await accountPool.query("SELECT id FROM codelab_accounts WHERE username='ADMIN' AND role='admin' LIMIT 1");
          if (!admin.rowCount) return sendJson(res, 503, { error: 'admin_workspace_not_configured' });
          const workspaceId = 'ws_local_' + String(admin.rows[0].id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
          const [bridge, commands, projects, evidence] = await Promise.all([
            accountPool.query('SELECT state_id,workspace_id,state,wake_required,wake_reason,signal_version,last_signal_at,updated_at,metadata FROM public.codelab_agent_bridge_state WHERE state_id=$1', ['native-bridge:' + workspaceId]),
            accountPool.query('SELECT command_id,action,status,payload,result,created_at,started_at,finished_at,expires_at,updated_at FROM public.codelab_agent_commands WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 20', [workspaceId]),
            accountPool.query('SELECT project_id,name,width,height,updated_at,last_opened_at,server_revision,content_sha256 FROM public.codelab_pixelforge_projects WHERE workspace_id=$1 ORDER BY updated_at DESC LIMIT 20', [workspaceId]),
            accountPool.query('SELECT event_id,project_id,revision,change_kind,status,image_key,video_key,image_url,video_url,metadata,created_at,updated_at FROM public.codelab_pixelforge_change_events WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 20', [workspaceId]).catch(() => ({ rows: [] }))
          ]);
          const bridgeState = bridge.rows[0] || { state:'unknown', wake_required:true, wake_reason:'missing_bridge_state' };
          return sendJson(res, 200, {
            ok:true,
            operation:'bridge_state_snapshot',
            generatedAt:new Date().toISOString(),
            workspaceId,
            bridge:bridgeState,
            wake:{
              required:!!bridgeState.wake_required,
              includeWakeCommand:!!bridgeState.wake_required,
              reason:bridgeState.wake_reason || null,
              signalVersion:bridgeState.signal_version ?? null
            },
            runtime:agentBridgeStatus(),
            commands:commands.rows,
            projects:projects.rows,
            evidence:evidence.rows
          });
        } catch (error) {
          return sendJson(res, 503, { error:'agent_bridge_state_unavailable', message:String(error.message || error) });
        }
      }

      if (req.method === 'GET' && pathname === '/api/agent/bridge/status') {
        const supplied = String(req.headers['x-codelab-agent-bridge-token'] || '');
        if (!AGENT_BRIDGE_CONTROL_SECRET || !safeTokenEqual(supplied, AGENT_BRIDGE_CONTROL_SECRET)) {
          return sendJson(res, 401, { error: 'agent_bridge_unauthorized' });
        }
        return sendJson(res, 200, { ok: true, operation: 'bridge_status', bridge: agentBridgeStatus() });
      }

      // Native CodeLab Validation Engine. This runs validators in-process and deliberately
      // has no wall-clock deadline. A long-running validation can only be stopped by its
      // caller (AbortSignal), so vital checks are never cut off by an arbitrary timer.
      if (req.method === 'POST' && pathname === '/api/agent/validate') {
        const supplied = String(req.headers['x-codelab-agent-bridge-token'] || url.searchParams.get('token') || '');
        if (!AGENT_BRIDGE_CONTROL_SECRET || !safeTokenEqual(supplied, AGENT_BRIDGE_CONTROL_SECRET)) {
          return sendJson(res, 401, { error: 'agent_validation_unauthorized' });
        }
        try {
          const body = await readBody(req);
          const { createNativeCodeLabValidationEngine } = await import('./public/codelab-native-validators.mjs');
          const engine = createNativeCodeLabValidationEngine();
          if (body?.operation === 'list') {
            return sendJson(res, 200, { ok: true, engineVersion: 1, validators: engine.list() });
          }
          const target = String(body?.target || '').trim();
          if (!target) return sendJson(res, 400, { error: 'validation_target_required' });
          const result = await engine.validate(target, body?.input, { options: body?.options || {} });
          return sendJson(res, result.ok ? 200 : 422, {
            ok: result.ok,
            engineVersion: result.version,
            validator: result.validator,
            score: result.score,
            issues: result.issues,
            details: result.details,
            startedAt: result.startedAt,
            finishedAt: result.finishedAt
          });
        } catch (error) {
          return sendJson(res, 500, { error: 'native_validation_failed', message: String(error.message || error) });
        }
      }

      // Native CodeLab account login. Public registration is intentionally disabled.
      if (req.method === 'POST' && pathname === '/api/auth/login') {
        const body = await readBody(req);
        const username = typeof body.username === 'string' ? body.username.trim().toUpperCase() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        if (!/^[A-Z0-9_]{3,32}$/.test(username) || password.length < 1 || password.length > 1024) {
          return sendJson(res, 400, { error: 'invalid_credentials_format' });
        }
        if (!allowLocalLoginAttempt(req, username)) {
          return sendJson(res, 429, { error: 'login_rate_limited', message: 'Demasiados intentos. Espera 10 minutos e inténtalo de nuevo.' });
        }
        const accounts = await readLocalAccounts();
        const account = accounts[username];
        // Perform a comparable scrypt operation even when the account does not exist.
        const salt = account?.salt || 'codelab-invalid-login-salt';
        const candidate = passwordHash(password, salt);
        if (!account || !safePasswordEqual(candidate, account.passwordHash)) {
          return sendJson(res, 401, { error: 'invalid_credentials', message: 'Usuario o contraseña incorrectos.' });
        }
        const user = {
          id: account.id,
          provider: 'local',
          name: account.username,
          email: null,
          avatar: null,
          role: account.role
        };
        await ensureUserWorkspace(user);
        const session = await createSession(user);
        setSessionCookie(res, session.id, req);
        return sendJson(res, 200, { ok: true, user, workspaceId: userWorkspaceId(user), mustChangePassword: !!account.mustChangePassword });
      }

      if (req.method === 'POST' && pathname === '/api/auth/change-password') {
        const user = await getSessionUser(req);
        if (!user || user.provider !== 'local') return sendJson(res, 401, { error: 'not_authenticated' });
        const body = await readBody(req);
        const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
        const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
        if (newPassword.length < 16 || newPassword.length > 1024) {
          return sendJson(res, 400, { error: 'password_too_short', message: 'La nueva contraseña debe tener al menos 16 caracteres.' });
        }
        const accounts = await readLocalAccounts();
        const account = accounts[user.name];
        if (!account || !safePasswordEqual(passwordHash(currentPassword, account.salt), account.passwordHash)) {
          return sendJson(res, 401, { error: 'invalid_credentials' });
        }
        const salt = crypto.randomBytes(16).toString('hex');
        account.salt = salt;
        account.passwordHash = passwordHash(newPassword, salt);
        account.mustChangePassword = false;
        account.passwordChangedAt = new Date().toISOString();
        await writeLocalAccounts(accounts);
        const cookies = parseCookies(req);
        await destroySession(cookies[COOKIE_NAME]);
        const session = await createSession({ ...user, id: account.id, role: account.role });
        setSessionCookie(res, session.id, req);
        return sendJson(res, 200, { ok: true, mustChangePassword: false });
      }

      // Minimal administrator-only account directory and user creation.
      if (pathname === '/api/admin/accounts' && (req.method === 'GET' || req.method === 'POST')) {
        const actor = await getSessionUser(req);
        if (!actor || actor.provider !== 'local' || actor.role !== 'admin') {
          return sendJson(res, 403, { error: 'admin_required' });
        }
        const accounts = await readLocalAccounts();
        if (req.method === 'GET') {
          return sendJson(res, 200, {
            accounts: Object.keys(accounts).sort().map(username => ({
              username,
              role: accounts[username].role || 'user',
              createdAt: accounts[username].createdAt || null,
              mustChangePassword: !!accounts[username].mustChangePassword
            }))
          });
        }
        const body = await readBody(req);
        const username = typeof body.username === 'string' ? body.username.trim().toUpperCase() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        if (!/^[A-Z0-9_]{3,32}$/.test(username)) {
          return sendJson(res, 400, { error: 'invalid_username', message: 'El usuario debe tener entre 3 y 32 caracteres: letras, números o guion bajo.' });
        }
        if (password.length < 16 || password.length > 1024) {
          return sendJson(res, 400, { error: 'password_too_short', message: 'La contraseña debe tener al menos 16 caracteres.' });
        }
        if (accounts[username]) return sendJson(res, 409, { error: 'account_exists', message: 'Ese usuario ya existe.' });
        const salt = crypto.randomBytes(16).toString('hex');
        accounts[username] = {
          id: crypto.randomUUID(),
          username,
          role: 'user',
          salt,
          passwordHash: passwordHash(password, salt),
          createdAt: new Date().toISOString(),
          mustChangePassword: false
        };
        await writeLocalAccounts(accounts);
        return sendJson(res, 201, { ok: true, account: { username, role: 'user', createdAt: accounts[username].createdAt } });
      }

      // Auth status / me
      // One-time ADMIN handoff minted only by the trusted native operator.
      // The ticket is a short-lived row in codelab_auth_sessions and is consumed
      // atomically before a normal HttpOnly browser session is issued.
      // Mint a short-lived browser handoff only for the trusted native ADMIN workspace worker.
      if (req.method === 'POST' && pathname === '/api/auth/native-handoff/mint') {
        if (!accountPool) return sendJson(res, 503, { error: 'handoff_unavailable' });
        try {
          const accountResult = await accountPool.query(
            "SELECT id, username, role FROM codelab_accounts WHERE username='ADMIN' AND role='admin' LIMIT 1"
          );
          if (!accountResult.rowCount) return sendJson(res, 404, { error: 'admin_account_not_found' });
          const account = accountResult.rows[0];
          const workspaceId = safeId('ws_local_' + String(account.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100));
          if (!(await isAuthorized(req, workspaceId))) return sendJson(res, 403, { error: 'native_admin_required' });
          const ticket = crypto.randomBytes(24).toString('hex');
          const userData = { id: String(account.id), provider: 'local', name: account.username, role: 'admin' };
          await accountPool.query(
            'INSERT INTO codelab_auth_sessions (session_id, user_data, created_at, expires_at) VALUES ($1, $2::jsonb, NOW(), NOW() + INTERVAL \'10 minutes\')',
            [ticket, JSON.stringify(userData)]
          );
          return sendJson(res, 201, { ok: true, ticket, expiresInSeconds: 600, oneTime: true }, { 'Cache-Control': 'no-store, max-age=0' });
        } catch (error) {
          console.error('native_admin_handoff_mint_failed:', error.message);
          return sendJson(res, 500, { error: 'handoff_unavailable' });
        }
      }

      if (req.method === 'GET' && pathname === '/api/auth/native-handoff') {
        const requestUrl = new URL(req.url, 'http://localhost');
        const ticket = requestUrl.searchParams.get('ticket') || '';
        if (!/^[a-f0-9]{48}$/.test(ticket) || !accountPool) {
          return sendJson(res, 404, { error: 'handoff_not_found' });
        }
        try {
          const accountResult = await accountPool.query(
            "SELECT id, username, role FROM codelab_accounts WHERE username='ADMIN' AND role='admin' LIMIT 1"
          );
          if (!accountResult.rowCount) return sendJson(res, 404, { error: 'handoff_not_found' });
          const account = accountResult.rows[0];
          const consumed = await accountPool.query(
            "DELETE FROM codelab_auth_sessions WHERE session_id=$1 AND expires_at > NOW() AND user_data->>'provider'='local' AND user_data->>'id'=$2 AND user_data->>'role'='admin' RETURNING user_data",
            [ticket, String(account.id)]
          );
          if (!consumed.rowCount) return sendJson(res, 404, { error: 'handoff_expired_or_used' });
          const storedUser = consumed.rows[0].user_data || {};
          const session = await createSession({
            id: String(account.id),
            provider: 'local',
            name: account.username,
            role: 'admin',
            email: storedUser.email || null,
            avatar: storedUser.avatar || null
          });
          setSessionCookie(res, session.id, req);
          setSecurityHeaders(res);
          res.writeHead(303, {
            Location: '/',
            'Cache-Control': 'no-store, max-age=0',
            'Referrer-Policy': 'no-referrer'
          });
          return res.end();
        } catch (error) {
          console.error('native_admin_handoff_failed:', error.message);
          return sendJson(res, 500, { error: 'handoff_unavailable' });
        }
      }

      if (req.method === 'GET' && pathname === '/api/auth/status') {
        const cfg = oauthConfigured();
        const user = await getSessionUser(req);
        return sendJson(res, 200, {
          oauth: cfg,
          demoFallback: !(cfg.github || cfg.google),
          user: user || null,
          workspaceId: user ? userWorkspaceId(user) : null,
          mustChangePassword: !!(user && user.provider === 'local' && (await readLocalAccounts())[user.name]?.mustChangePassword)
        });
      }

      if (req.method === 'GET' && pathname === '/api/auth/me') {
        const user = await getSessionUser(req);
        if (!user) return sendJson(res, 401, { error: 'not_authenticated' });
        return sendJson(res, 200, {
          user,
          workspaceId: userWorkspaceId(user),
          token: signWorkspace(userWorkspaceId(user))
        });
      }

      if (req.method === 'POST' && pathname === '/api/auth/logout') {
        const cookies = parseCookies(req);
        await destroySession(cookies[COOKIE_NAME]);
        clearSessionCookie(res, req);
        return sendJson(res, 200, { ok: true });
      }

      // --- AI copiloto ---
      if (req.method === 'GET' && pathname === '/api/ai/status') {
        const cfg = aiConfigured();
        return sendJson(res, 200, {
          ok: true,
          serverKey: cfg.serverKey,
          model: cfg.model,
          rawModel: cfg.rawModel,
          baseUrl: cfg.serverKey ? cfg.baseUrl : null,
          groq: cfg.groq,
          openRouter: cfg.openRouter,
          maxProjects: MAX_PROJECTS,
          modes: ['auto', 'api', 'local'],
          hint: cfg.serverKey
            ? (cfg.groq
                ? 'Groq listo · modelo ' + cfg.model
                : 'Servidor listo · modelo ' + cfg.model)
            : 'Configura AI_API_KEY + AI_BASE_URL + AI_MODEL en Render.'
        });
      }

      // Quick live test of the AI bridge (does not need a project)
      if (req.method === 'POST' && pathname === '/api/ai/ping') {
        if (!AI_API_KEY) {
          return sendJson(res, 503, { ok: false, error: 'ai_not_configured' });
        }
        if (!checkAiRateLimit(ip)) {
          return sendJson(res, 429, { error: 'ai_rate_limited' });
        }
        try {
          const { content, model } = await proxyChatCompletions({
            apiKey: AI_API_KEY,
            baseUrl: AI_BASE_URL,
            model: AI_MODEL,
            messages: [
              { role: 'system', content: 'Responde solo JSON: {"ok":true,"message":"pong"}' },
              { role: 'user', content: 'ping' }
            ],
            temperature: 0,
            maxTokens: 64,
            publicUrl: publicBaseUrl(req)
          });
          return sendJson(res, 200, {
            ok: true,
            model: model || AI_MODEL,
            preview: String(content).slice(0, 200)
          });
        } catch (e) {
          return sendJson(res, 502, {
            ok: false,
            error: 'ai_upstream_failed',
            message: String(e.message || e).slice(0, 400),
            model: AI_MODEL,
            baseUrl: AI_BASE_URL
          });
        }
      }

      if (req.method === 'POST' && pathname === '/api/ai/design-review') {
        if (!checkAiRateLimit(ip)) return sendJson(res, 429, { error: 'ai_rate_limited', message: 'Demasiadas peticiones de IA. Espera un minuto.' });
        const body = await readBody(req);
        const prompt = body && typeof body.prompt === 'string' ? body.prompt.trim() : '';
        const image = body && typeof body.screenshotDataUrl === 'string' ? body.screenshotDataUrl : '';
        const context = body && body.context && typeof body.context === 'object' ? body.context : null;
        if (!prompt || prompt.length > 4000 || !context) return sendJson(res, 400, { error: 'invalid_design_review' });
        const match = image.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
        if (!match || match[2].length > 8 * 1024 * 1024) return sendJson(res, 413, { error: 'invalid_or_large_screenshot', message: 'La captura debe ser PNG/JPEG/WebP y pesar menos de unos 6 MB.' });
        const clientKey = body && typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
        if (clientKey.length > 4096) return sendJson(res, 400, { error: 'invalid_api_key' });
        const usingServerKey = !clientKey && !!AI_API_KEY;
        const apiKey = clientKey || AI_API_KEY;
        if (!apiKey) return sendJson(res, 503, { error: 'ai_not_configured', message: 'Configura una API compatible con visión en Ajustes del copiloto o en el servidor.' });
        let baseUrl = AI_BASE_URL, model = AI_MODEL;
        if (!usingServerKey) {
          if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) baseUrl = body.baseUrl.trim().replace(/\/$/, '');
          if (typeof body.model === 'string' && body.model.trim()) model = body.model.trim();
        } else if (typeof body.model === 'string' && body.model.trim() && body.model.includes('/')) model = body.model.trim();
        if (baseUrl.length > 2048) return sendJson(res, 400, { error: 'invalid_provider_url' });
        if (model.length > 200) return sendJson(res, 400, { error: 'invalid_model' });
        try {
          const messages = [
            { role: 'system', content: 'Eres un revisor experto de diseño visual y UX. Analiza la imagen real, no infieras elementos que no se vean. Usa el contexto estructurado como apoyo para medidas exactas. Responde en español con resumen, hallazgos observables priorizados y recomendaciones concretas.' },
            { role: 'user', content: [
              { type: 'text', text: prompt + '\\n\\nContexto estructurado del diseño:\\n' + JSON.stringify(context).slice(0, 40000) },
              { type: 'image_url', image_url: { url: image } }
            ] }
          ];
          const result = await proxyChatCompletions({ apiKey, baseUrl, model, messages, temperature: 0.2, maxTokens: Math.min(AI_MAX_TOKENS, 3000), publicUrl: publicBaseUrl(req) });
          return sendJson(res, 200, { ok: true, analysis: String(result.content || ''), model: result.model || model, via: usingServerKey ? 'server' : 'client-key', imageReceived: true });
        } catch (e) {
          return sendJson(res, 502, { error: 'ai_design_review_failed', message: String(e.message || e).slice(0, 400), model });
        }
      }

      if (req.method === 'POST' && pathname === '/api/ai/complete') {
        if (!checkAiRateLimit(ip)) {
          return sendJson(res, 429, { error: 'ai_rate_limited', message: 'Demasiadas peticiones al copiloto. Espera un minuto.' });
        }
        const body = await readBody(req);
        const prompt = body && typeof body.prompt === 'string' ? body.prompt.trim() : '';
        if (!prompt || prompt.length > 8000) {
          return sendJson(res, 400, { error: 'invalid_prompt' });
        }
        const code = {
          html: body && body.code && typeof body.code.html === 'string' ? body.code.html : '',
          css: body && body.code && typeof body.code.css === 'string' ? body.code.css : '',
          js: body && body.code && typeof body.code.js === 'string' ? body.code.js : ''
        };
        // Size guard
        if (code.html.length + code.css.length + code.js.length > 200000) {
          return sendJson(res, 413, { error: 'code_too_large' });
        }
        const clientKey = body && typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
        if (clientKey.length > 4096) {
          return sendJson(res, 400, { error: 'invalid_api_key' });
        }
        // A user-supplied credential belongs to that user's provider settings.
        // Never combine it with the server key: the selected key and endpoint must
        // come from the same source, or the server secret could be sent to a custom URL.
        const usingServerKey = !clientKey && !!AI_API_KEY;
        const apiKey = clientKey || AI_API_KEY;
        if (!apiKey) {
          return sendJson(res, 503, {
            error: 'ai_not_configured',
            message: 'No hay API key. Configura AI_API_KEY en el servidor o pégala en Ajustes del copiloto.'
          });
        }
        let baseUrl = AI_BASE_URL;
        let model = AI_MODEL;
        if (!usingServerKey) {
          if (body && typeof body.baseUrl === 'string' && body.baseUrl.trim()) {
            baseUrl = body.baseUrl.trim().replace(/\/$/, '');
          }
          if (body && typeof body.model === 'string' && body.model.trim()) {
            model = body.model.trim();
          }
        } else {
          // Server key path: only honor client model if it looks explicit (contains / for OpenRouter-style ids)
          if (body && typeof body.model === 'string' && body.model.trim() && body.model.includes('/')) {
            model = body.model.trim();
          }
        }
        if (baseUrl.length > 2048) return sendJson(res, 400, { error: 'invalid_provider_url' });
        if (model.length > 200) return sendJson(res, 400, { error: 'invalid_model' });
        try {
          const messages = [
            { role: 'system', content: buildAiSystemPrompt(code) },
            {
              role: 'user',
              content:
                prompt +
                '\n\nResponde SOLO con JSON: {"html":"...","css":"...","js":"...","message":"..."}'
            }
          ];
          const { content } = await proxyChatCompletions({
            apiKey,
            baseUrl,
            model,
            messages,
            temperature: 0.1,
            maxTokens: AI_MAX_TOKENS,
            publicUrl: publicBaseUrl(req)
          });
          const result = parseAiJsonContent(content, code);
          return sendJson(res, 200, {
            ok: true,
            html: result.html,
            css: result.css,
            js: result.js,
            message: result.message,
            model: model,
            via: usingServerKey ? 'server' : 'client-key'
          });
        } catch (e) {
          console.error('AI proxy error:', e.message, e.body || '');
          const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
          return sendJson(res, status >= 500 ? 502 : status, {
            error: 'ai_upstream_failed',
            message: String(e.message || 'AI request failed').slice(0, 400),
            model: model,
            baseUrl: baseUrl.replace(/\/+$/, '')
          });
        }
      }

      // GitHub OAuth start
      if (req.method === 'GET' && pathname === '/api/auth/github') {
        if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
          return sendJson(res, 503, { error: 'github_not_configured' });
        }
        const state = createOAuthState('github');
        const redirectUri = publicBaseUrl(req) + '/api/auth/github/callback';
        const stateCookie = 'codelab_oauth_state_github=' + encodeURIComponent(state) +
          '; Path=/api/auth/github/callback; HttpOnly; SameSite=Lax; Max-Age=600' + (isSecureRequest(req) ? '; Secure' : '');
        const url =
          'https://github.com/login/oauth/authorize?client_id=' +
          encodeURIComponent(GITHUB_CLIENT_ID) +
          '&redirect_uri=' + encodeURIComponent(redirectUri) +
          '&scope=' + encodeURIComponent('read:user user:email') +
          '&state=' + encodeURIComponent(state);
        return redirect(res, url, { 'Set-Cookie': stateCookie });
      }

      // GitHub callback
      if (req.method === 'GET' && pathname === '/api/auth/github/callback') {
        const code = searchParams.get('code');
        const state = searchParams.get('state');
        const cookies = parseCookies(req);
        const st = parseOAuthState(state);
        if (!code || !st || st.provider !== 'github' || !state || cookies.codelab_oauth_state_github !== state) {
          return redirect(res, '/?auth=error&reason=invalid_state');
        }
        try {
          const user = await handleGithubCallback(code);
          await ensureUserWorkspace(user);
          const session = await createSession(user);
          const secure = isSecureRequest(req) ? '; Secure' : '';
          const cookie =
            COOKIE_NAME + '=' + encodeURIComponent(session.id) +
            '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000) + secure;
          return redirectWithCookie(res, '/?auth=ok&provider=github', cookie);
        } catch (e) {
          console.error('GitHub OAuth error', e.message);
          return redirect(res, '/?auth=error&reason=github');
        }
      }

      // Google OAuth start
      if (req.method === 'GET' && pathname === '/api/auth/google') {
        if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
          return sendJson(res, 503, { error: 'google_not_configured' });
        }
        const state = createOAuthState('google');
        const redirectUri = publicBaseUrl(req) + '/api/auth/google/callback';
        const stateCookie = 'codelab_oauth_state_google=' + encodeURIComponent(state) +
          '; Path=/api/auth/google/callback; HttpOnly; SameSite=Lax; Max-Age=600' + (isSecureRequest(req) ? '; Secure' : '');
        const url =
          'https://accounts.google.com/o/oauth2/v2/auth?client_id=' +
          encodeURIComponent(GOOGLE_CLIENT_ID) +
          '&redirect_uri=' + encodeURIComponent(redirectUri) +
          '&response_type=code' +
          '&scope=' + encodeURIComponent('openid email profile') +
          '&state=' + encodeURIComponent(state) +
          '&access_type=online' +
          '&prompt=select_account';
        return redirect(res, url, { 'Set-Cookie': stateCookie });
      }

      // Google callback
      if (req.method === 'GET' && pathname === '/api/auth/google/callback') {
        const code = searchParams.get('code');
        const state = searchParams.get('state');
        const cookies = parseCookies(req);
        const st = parseOAuthState(state);
        if (!code || !st || st.provider !== 'google' || !state || cookies.codelab_oauth_state_google !== state) {
          return redirect(res, '/?auth=error&reason=invalid_state');
        }
        try {
          const redirectUri = publicBaseUrl(req) + '/api/auth/google/callback';
          const user = await handleGoogleCallback(code, redirectUri);
          await ensureUserWorkspace(user);
          const session = await createSession(user);
          const secure = isSecureRequest(req) ? '; Secure' : '';
          const cookie =
            COOKIE_NAME + '=' + encodeURIComponent(session.id) +
            '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000) + secure;
          return redirectWithCookie(res, '/?auth=ok&provider=google', cookie);
        } catch (e) {
          console.error('Google OAuth error', e.message);
          return redirect(res, '/?auth=error&reason=google');
        }
      }

      // Workspace-scoped design-system settings, kept separate from project payloads.
      const designSystemMatch = pathname.match(/^\/api\/workspace\/([^/]+)\/design-system$/);
      if (designSystemMatch && (req.method === 'GET' || req.method === 'PUT')) {
        const id = safeId(designSystemMatch[1]);
        if (!id) return sendJson(res, 400, { error: 'workspace_id_required' });
        if (!(await isAuthorized(req, id))) return sendJson(res, 401, { error: 'workspace_unauthorized' });
        if (!(await workspaceExists(id))) return sendJson(res, 404, { error: 'workspace_not_found' });
        try {
          await enforceSessionWorkspaceOwner(id, await readState(id), await getSessionUser(req));
        } catch (error) {
          console.error('workspace_corrupt', id, error.message);
          return sendJson(res, 500, { error: 'workspace_corrupt' });
        }
        if (req.method === 'GET') {
          return sendJson(res, 200, { settings: readDesignSystem(id) });
        }
        const body = await readBody(req);
        if (!body || !body.settings || typeof body.settings !== 'object' || Array.isArray(body.settings)) {
          return sendJson(res, 400, { error: 'invalid_design_system' });
        }
        const allowed = ['name', 'primary', 'secondary', 'accent', 'surface', 'background', 'text',
          'contrastForeground', 'contrastBackground', 'baseFont', 'typeRatio', 'baseSpacing', 'baseRadius'];
        const input = {};
        for (const key of allowed) {
          if (Object.prototype.hasOwnProperty.call(body.settings, key)) input[key] = body.settings[key];
        }
        const settings = designTools.sanitizeSettings(input);
        writeDesignSystem(id, settings);
        return sendJson(res, 200, { ok: true, settings: settings });
      }

      // Temporary share URL for generated evidence videos. The token is stored only in the
      // event metadata and is required; this does not expose the general evidence API.
      const neonEvidenceVideoShareMatch = pathname.match(/^\/api\/pixelforge\/evidence\/([0-9a-f-]{36})\/video\/share$/i);
      if (neonEvidenceVideoShareMatch && req.method === 'GET') {
        if (!accountPool || !pixelForgeTableReady) return sendJson(res, 503, { error: 'pixelforge_database_unavailable' });
        const shareToken = String(url.searchParams.get('token') || '');
        if (!/^[a-f0-9]{48,128}$/i.test(shareToken)) return sendJson(res, 401, { error: 'invalid_video_share_token' });
        const result = await accountPool.query(
          'SELECT video_url, video_key, revision FROM codelab_pixelforge_change_events WHERE event_id = $1 AND metadata->>\'videoShareToken\' = $2',
          [neonEvidenceVideoShareMatch[1], shareToken]
        );
        const evidence = result.rows[0];
        if (!evidence) return sendJson(res, 404, { error: 'video_evidence_not_found' });
        let objectUrl = typeof evidence.video_url === 'string' ? evidence.video_url.trim() : '';
        if (!objectUrl && evidence.video_key && process.env.CLOUDFLARE_EVIDENCE_BASE_URL) {
          const base = String(process.env.CLOUDFLARE_EVIDENCE_BASE_URL).replace(/\/+$/, '');
          objectUrl = base + '/evidence/' + String(evidence.video_key).split('/').map(encodeURIComponent).join('/');
        }
        if (!objectUrl) return sendJson(res, 404, { error: 'video_evidence_not_found' });
        return res.writeHead(302, {
          Location: objectUrl,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff'
        }).end();
      }

      // Stream the actual persisted video bytes (not only the evidence metadata).
      // Downloads require the same authenticated workspace session as evidence metadata.
      const neonEvidenceVideoMatch = pathname.match(/^\/api\/pixelforge\/evidence\/([0-9a-f-]{36})\/video$/i);
      if (neonEvidenceVideoMatch && ['GET', 'HEAD'].includes(req.method)) {
        const user = await getSessionUser(req);
        if (!PIXELFORGE_GUEST_MODE && !user) return sendJson(res, 401, { error: 'not_authenticated' });
        if (!accountPool || !pixelForgeTableReady) return sendJson(res, 503, { error: 'pixelforge_database_unavailable' });
        const workspaceId = accountPool ? await resolveAdminAgentWorkspace() : userWorkspaceId(user);
        const result = await accountPool.query(
          'SELECT video_url, video_key, project_id, revision FROM codelab_pixelforge_change_events WHERE workspace_id = $1 AND event_id = $2',
          [workspaceId, neonEvidenceVideoMatch[1]]
        );
        const evidence = result.rows[0];
        if (!evidence) return sendJson(res, 404, { error: 'video_evidence_not_found' });

        // Canonical delivery path: evidence bytes live in object storage.
        // Never select or stream video_data from Neon; that would spend database egress.
        {
          let objectUrl = typeof evidence.video_url === 'string' ? evidence.video_url.trim() : '';
          if (!objectUrl && evidence.video_key && process.env.CLOUDFLARE_EVIDENCE_BASE_URL) {
            const base = String(process.env.CLOUDFLARE_EVIDENCE_BASE_URL).replace(/\/+$/, '');
            objectUrl = base + '/evidence/' + String(evidence.video_key).split('/').map(encodeURIComponent).join('/');
          }
          if (!objectUrl) return sendJson(res, 404, { error: 'video_evidence_not_found' });

          // HEAD remains a metadata probe; GET redirects to the immutable evidence
          // object. This keeps one stable CodeLab URL for every future video.
          if (req.method === 'HEAD') {
            return res.writeHead(302, { Location: objectUrl, 'Cache-Control': 'no-store' }).end();
          }
          return res.writeHead(302, {
            Location: objectUrl,
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff'
          }).end();
        }

        return sendJson(res, 404, { error: 'video_evidence_object_missing' });
      }

      // Evidence API: each saved revision receives an event, and the browser can
      // upload the corresponding PNG/video to the configured evidence object store via a short-lived signed URL.
      const neonEvidenceMatch = pathname.match(/^\/api\/pixelforge\/evidence\/([0-9a-f-]{36})$/i);
      if (neonEvidenceMatch && ['GET', 'POST'].includes(req.method)) {
        const user = await getSessionUser(req);
        if (!PIXELFORGE_GUEST_MODE && !user) return sendJson(res, 401, { error: 'not_authenticated' });
        if (!accountPool || !pixelForgeTableReady) return sendJson(res, 503, { error: 'pixelforge_database_unavailable' });
        const workspaceId = PIXELFORGE_GUEST_MODE ? PIXELFORGE_GUEST_WORKSPACE_ID : userWorkspaceId(user);
        const eventId = neonEvidenceMatch[1];
        if (req.method === 'GET') {
          const event = await neonEvidence.getChangeEvent(accountPool, workspaceId, eventId);
          return event ? sendJson(res, 200, { event }) : sendJson(res, 404, { error: 'evidence_event_not_found' });
        }
        const body = await readBody(req, 1024 * 1024);
        if (!body || !['image', 'video'].includes(body.kind)) return sendJson(res, 400, { error: 'evidence_kind_required' });
        const event = await neonEvidence.getChangeEvent(accountPool, workspaceId, eventId);
        if (!event) return sendJson(res, 404, { error: 'evidence_event_not_found' });
        if (!neonEvidence.storageConfigured()) return sendJson(res, 503, { error: 'evidence_storage_not_configured' });
        const ext = body.kind === 'image' ? 'png' : 'webm';
        const key = 'pixelforge/' + workspaceId + '/' + event.projectId + '/r' + event.revision + '/' + eventId + '.' + ext;
        try {
          const signed = neonEvidence.presignStorageObject({
            objectKey: key,
            contentType: body.kind === 'image' ? 'image/png' : 'video/webm',
            expiresInSeconds: 900
          });
          const publicUrl = signed.publicUrl || null;
          return sendJson(res, 200, { ok: true, eventId, kind: body.kind, key, upload: signed, publicUrl });
        } catch (error) {
          return sendJson(res, 503, { error: error.message || 'evidence_storage_presign_failed' });
        }
      }

      const neonEvidenceCompleteMatch = pathname.match(/^\/api\/pixelforge\/evidence\/([0-9a-f-]{36})\/complete$/i);
      if (req.method === 'POST' && neonEvidenceCompleteMatch) {
        const user = await getSessionUser(req);
        if (!PIXELFORGE_GUEST_MODE && !user) return sendJson(res, 401, { error: 'not_authenticated' });
        if (!accountPool || !pixelForgeTableReady) return sendJson(res, 503, { error: 'pixelforge_database_unavailable' });
        const workspaceId = PIXELFORGE_GUEST_MODE ? PIXELFORGE_GUEST_WORKSPACE_ID : userWorkspaceId(user);
        const body = await readBody(req, 1024 * 1024);
        if (!body || !['image', 'video'].includes(body.kind) || typeof body.key !== 'string') return sendJson(res, 400, { error: 'invalid_evidence_completion' });
        const attached = await neonEvidence.attachEvidence(accountPool, {
          workspaceId, eventId: neonEvidenceCompleteMatch[1], kind: body.kind,
          objectKey: body.key, publicUrl: typeof body.publicUrl === 'string' ? body.publicUrl : null
        });
        return attached ? sendJson(res, 200, { ok: true, evidence: attached }) : sendJson(res, 404, { error: 'evidence_event_not_found' });
      }

      if (req.method === 'GET' && pathname === '/api/pixelforge/mode') {
        return sendJson(res, 200, {
          guestMode: PIXELFORGE_GUEST_MODE,
          workspace: PIXELFORGE_GUEST_MODE ? 'temporary-shared' : 'account',
          accountsAvailableForPixelForge: !PIXELFORGE_GUEST_MODE
        });
      }

            // Remote Video Composer workers (for GitHub Actions) upload only the finished
      // video here. The heavy browser/encoding work stays on the remote runner.
      if (req.method === 'POST' && pathname === '/api/pixelforge/remote-video') {
        const user = await getSessionUser(req);
        if (!PIXELFORGE_GUEST_MODE && !user) return sendJson(res, 401, { error: 'not_authenticated' });
        if (!accountPool || !pixelForgeTableReady) return sendJson(res, 503, { error: 'pixelforge_database_unavailable' });
        const workspaceId = PIXELFORGE_GUEST_MODE ? PIXELFORGE_GUEST_WORKSPACE_ID : userWorkspaceId(user);
        if (user?.name !== 'ADMIN') return sendJson(res, 403, { error: 'admin_required' });
        const body = await readBody(req, 32 * 1024 * 1024);
        const projectId = decodePixelForgeProjectId(body?.project_id);
        const videoBase64 = typeof body?.video_base64 === 'string' ? body.video_base64 : '';
        if (!projectId || !videoBase64) return sendJson(res, 400, { error: 'project_id_and_video_required' });
        const video = Buffer.from(videoBase64, 'base64');
        if (!video.length || video.length > 24 * 1024 * 1024) return sendJson(res, 413, { error: 'video_size_invalid' });
        const project = await loadPixelForgeProjectFromDatabase(workspaceId, projectId);
        if (!project) return sendJson(res, 404, { error: 'project_not_found' });
        const evidence = await neonEvidence.createChangeEvent(accountPool, {
          workspaceId,
          projectId,
          revision: Number(project.serverRevision || 0),
          changeKind: 'animation-video-composer-actions-export',
          metadata: {
            action: 'pixelforge_export_animation_video',
            capture: 'codelab-video-composer-actions',
            frames: Number(body.frames || 0),
            fps: Number(body.fps || 0),
            durationMs: Number(body.duration_ms || 0),
            filename: String(body.filename || 'pixelforge-animation-composer.webm').slice(0, 200)
          }
        });
        let artifact;
        if (neonEvidence.storageConfigured()) {
          const objectKey = 'pixelforge/' + workspaceId + '/' + projectId + '/r' + Number(project.serverRevision || 0) + '/' + evidence.eventId + '-composer.webm';
          const signed = neonEvidence.presignStorageObject({ objectKey, contentType: 'video/webm', expiresInSeconds: 900 });
          const upload = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: video });
          if (!upload.ok) throw new Error('remote_video_storage_upload_failed_' + upload.status);
          artifact = await neonEvidence.attachEvidence(accountPool, {
            workspaceId, eventId: evidence.eventId, kind: 'video', objectKey,
            publicUrl: signed.publicUrl || null
          });
        } else {
          // Large evidence must never fall back to Neon BYTEA. Persisting video bytes
          // in Postgres turns every later read into Neon public-network transfer.
          // Fail closed until object storage is configured instead of consuming quota.
          throw new Error('remote_video_storage_required');
        }
        return sendJson(res, 201, { ok: true, eventId: evidence.eventId, projectId, revision: Number(project.serverRevision || 0), sizeBytes: video.length, artifact });
      }

      // Native capture commands are issued from the authenticated user's workspace
      // but execute through the trusted ADMIN bridge mailbox.
      const pixelforgeCaptureMatch = pathname.match(/^\/api\/pixelforge\/capture(?:\/([A-Za-z0-9_-]+))?$/);
      if (pixelforgeCaptureMatch && (req.method === 'POST' || req.method === 'GET')) {
        const user = await getSessionUser(req);
        if (!PIXELFORGE_GUEST_MODE && !user) return sendJson(res, 401, { error: 'not_authenticated' });
        if (!accountPool) return sendJson(res, 503, { error: 'pixelforge_database_unavailable' });
        const targetWorkspace = PIXELFORGE_GUEST_MODE ? PIXELFORGE_GUEST_WORKSPACE_ID : userWorkspaceId(user);

        if (req.method === 'POST') {
          const body = await readBody(req, 1024 * 1024);
          const projectId = decodePixelForgeProjectId(body?.project_id);
          const kind = body?.kind === 'video' ? 'video' : body?.kind === 'image' ? 'image' : null;
          if (!projectId || !kind) return sendJson(res, 400, { error: 'invalid_pixelforge_capture_request' });
          const project = await loadPixelForgeProjectFromDatabase(targetWorkspace, projectId);
          if (!project) return sendJson(res, 404, { error: 'project_not_found' });
          if (kind === 'video' && (!project.animation || !Array.isArray(project.animation.frames) || project.animation.frames.length < 2)) {
            return sendJson(res, 422, { error: 'pixelforge_animation_required' });
          }

          const adminWorkspace = await resolveAdminAgentWorkspace();
          const commandId = crypto.randomUUID();
          const action = kind === 'video' ? 'pixelforge_export_animation_video' : 'pixelforge_capture_interface';
          const payload = {
            project_id: projectId,
            target_workspace_id: targetWorkspace,
            wake: true,
            ...(kind === 'video'
              ? {
                  ...(Number.isInteger(body.width) ? { width: body.width } : {}),
                  ...(Number.isInteger(body.height) ? { height: body.height } : {}),
                  ...(Number.isInteger(body.fps) ? { fps: body.fps } : {}),
                  persist_evidence: true
                }
              : {
                  width: Number.isInteger(body.width) ? body.width : 1440,
                  height: Number.isInteger(body.height) ? body.height : 1000,
                  full_page: body.full_page !== false,
                  returnImagesInline: true
                })
          };

          await accountPool.query(
            'INSERT INTO public.codelab_agent_commands (command_id, workspace_id, action, payload, status, expires_at, updated_at) VALUES ($1,$2,$3,$4::jsonb,\'queued\',NOW()+INTERVAL \'15 minutes\',NOW())',
            [commandId, adminWorkspace, action, JSON.stringify(payload)]
          );
          return sendJson(res, 202, { ok: true, commandId, status: 'queued', kind, projectId, workspaceId: targetWorkspace });
        }

        const commandId = pixelforgeCaptureMatch[1];
        if (!commandId) return sendJson(res, 400, { error: 'capture_command_id_required' });
        const adminWorkspace = await resolveAdminAgentWorkspace();
        const row = await accountPool.query(
          "SELECT command_id, action, status, result, created_at, started_at, finished_at, expires_at, payload->>'target_workspace_id' AS target_workspace_id FROM public.codelab_agent_commands WHERE command_id=$1 AND workspace_id=$2",
          [commandId, adminWorkspace]
        );
        if (!row.rowCount || row.rows[0].target_workspace_id !== targetWorkspace) return sendJson(res, 404, { error: 'capture_command_not_found' });
        const result = row.rows[0];
        return sendJson(res, 200, { commandId: result.command_id, action: result.action, status: result.status, result: result.result, createdAt: result.created_at, startedAt: result.started_at, finishedAt: result.finished_at, expiresAt: result.expires_at });
      }

      // PixelForge projects belong to the signed-in CodeLab account, not browser-local storage.
      // Large PixelForge projects use authenticated, idempotent PostgreSQL chunks.
      const pixelForgeUploadBegin = pathname === '/api/pixelforge/projects/uploads' && req.method === 'POST';
      const pixelForgeUploadChunk = req.method === 'PUT'
        ? pathname.match(/^\/api\/pixelforge\/projects\/uploads\/([a-f0-9]{32})\/(\d+)$/) : null;
      const pixelForgeUploadCommit = req.method === 'POST'
        ? pathname.match(/^\/api\/pixelforge\/projects\/uploads\/([a-f0-9]{32})\/commit$/) : null;
      const pixelForgeUploadStatus = req.method === 'GET'
        ? pathname.match(/^\/api\/pixelforge\/projects\/uploads\/([a-f0-9]{32})$/) : null;
      const pixelForgeUploadCancel = req.method === 'DELETE'
        ? pathname.match(/^\/api\/pixelforge\/projects\/uploads\/([a-f0-9]{32})$/) : null;
      if (pixelForgeUploadBegin || pixelForgeUploadChunk || pixelForgeUploadCommit || pixelForgeUploadStatus || pixelForgeUploadCancel) {
        const user = await getSessionUser(req);
        if (!PIXELFORGE_GUEST_MODE && !user) return sendJson(res, 401, { error: 'not_authenticated' });
        if (!accountPool || !pixelForgeTableReady) {
          return sendJson(res, 503, { error: 'pixelforge_database_unavailable' });
        }
        const workspaceId = PIXELFORGE_GUEST_MODE ? PIXELFORGE_GUEST_WORKSPACE_ID : userWorkspaceId(user);
        try {
          if (pixelForgeUploadBegin) {
            const body = await readBody(req, 1024 * 1024);
            const result = await pixelForgeUploads.beginUpload(
              accountPool, workspaceId, body,
              PIXELFORGE_MAX_PROJECT_BYTES, PIXELFORGE_MAX_ACCOUNT_BYTES, MAX_PROJECTS
            );
            return sendJson(res, result.status, result);
          }
          if (pixelForgeUploadStatus) {
            const result = await pixelForgeUploads.getUploadStatus(accountPool, workspaceId, pixelForgeUploadStatus[1]);
            return sendJson(res, 200, result);
          }
          if (pixelForgeUploadCancel) {
            const result = await pixelForgeUploads.cancelUpload(accountPool, workspaceId, pixelForgeUploadCancel[1]);
            return sendJson(res, 200, { ok: true, ...result });
          }
          if (pixelForgeUploadChunk) {
            const body = await readBody(req, PIXELFORGE_MAX_CHUNK_BODY_BYTES);
            const result = await pixelForgeUploads.putChunk(
              accountPool, workspaceId, pixelForgeUploadChunk[1], Number(pixelForgeUploadChunk[2]), body
            );
            return sendJson(res, 200, result);
          }
          return await withPixelForgeAccountLock(workspaceId, () => withPixelForgeUploadCommitLock(async () => {
            const uploadId = pixelForgeUploadCommit[1];
            const assembled = await pixelForgeUploads.assembleUpload(accountPool, workspaceId, uploadId);
            if (assembled.committed) return sendJson(res, 200, assembled.receipt);
            let project;
            try { project = JSON.parse(assembled.serialized); }
            catch (_) { return sendJson(res, 400, { error: 'invalid_pixelforge_project' }); }
            const validation = validatePixelForgeProjectPayload(project, assembled.serialized);
            if (validation.error) {
              return sendJson(res, validation.status, {
                error: validation.error,
                ...(validation.maxBytes ? { maxBytes: validation.maxBytes } : {})
              });
            }
            const upload = assembled.upload;
            const expectedRevision = Number(upload.expected_server_revision);
            if (project.id !== upload.project_id || project.serverRevision !== expectedRevision + 1 ||
                validation.projectBytes !== Number(upload.total_bytes)) {
              return sendJson(res, 400, { error: 'pixelforge_upload_manifest_mismatch' });
            }
            const current = await accountPool.query(
              'SELECT name,width,height,updated_at,server_revision,content_sha256 FROM codelab_pixelforge_projects WHERE workspace_id = $1 AND project_id = $2',
              [workspaceId, upload.project_id]
            );
            const currentRevision = current.rowCount ? Number(current.rows[0].server_revision || 0) : 0;
            if (current.rowCount && currentRevision === expectedRevision + 1 &&
                current.rows[0].content_sha256 === assembled.contentSha256) {
              const row = current.rows[0];
              const receipt = { ok: true, project: {
                id: upload.project_id, name: row.name, width: row.width, height: row.height,
                updatedAt: Number(row.updated_at), serverRevision: currentRevision
              } };
              await pixelForgeUploads.markCommitted(accountPool, uploadId, receipt);
              return sendJson(res, 200, receipt);
            }
            if (currentRevision !== expectedRevision) {
              return sendJson(res, 409, { error: 'pixelforge_revision_conflict', revision: currentRevision });
            }
            const saved = await savePixelForgeProjectToDatabase(
              workspaceId, project, validation.projectBytes,
              {
                expectedServerRevision: expectedRevision,
                preassignedServerRevision: true,
                serializedDocument: assembled.serialized,
                contentSha256: assembled.contentSha256
              }
            );
            if (saved.error) {
              if (saved.error === 'pixelforge_revision_conflict') {
                const recovered = await accountPool.query(
                  'SELECT name,width,height,updated_at,server_revision,content_sha256 FROM codelab_pixelforge_projects WHERE workspace_id = $1 AND project_id = $2',
                  [workspaceId, upload.project_id]
                );
                if (recovered.rowCount && Number(recovered.rows[0].server_revision) === expectedRevision + 1 &&
                    recovered.rows[0].content_sha256 === assembled.contentSha256) {
                  const row = recovered.rows[0];
                  const receipt = { ok: true, project: {
                    id: upload.project_id, name: row.name, width: row.width, height: row.height,
                    updatedAt: Number(row.updated_at), serverRevision: Number(row.server_revision)
                  } };
                  await pixelForgeUploads.markCommitted(accountPool, uploadId, receipt);
                  return sendJson(res, 200, receipt);
                }
              }
              return sendJson(res, saved.status, {
                error: saved.error,
                ...(saved.maxProjects ? { maxProjects: saved.maxProjects } : {}),
                ...(saved.maxBytes ? { maxBytes: saved.maxBytes } : {}),
                ...(Number.isInteger(saved.revision) ? { revision: saved.revision } : {})
              });
            }
            const receipt = { ok: true, project: {
              id: project.id, name: project.name.trim(), width: project.width, height: project.height,
              updatedAt: saved.now, serverRevision: saved.serverRevision
            } };
            await pixelForgeUploads.markCommitted(accountPool, uploadId, receipt);
            return sendJson(res, saved.status, receipt);
          }));
        } catch (error) {
          if ((error.status || 500) >= 500) console.error('PixelForge chunk upload failed:', error.message);
          const failureStatus = error.status || (error.code === 'PAYLOAD_TOO_LARGE' ? 413 : ['INVALID_JSON', 'REQUEST_ABORTED'].includes(error.code) ? 400 : 503);
          return sendJson(res, failureStatus, {
            error: error.code || 'pixelforge_upload_failed',
            ...(Number.isInteger(error.maxBytes) ? { maxBytes: error.maxBytes } : {}),
            ...(Number.isInteger(error.maxProjects) ? { maxProjects: error.maxProjects } : {}),
            ...(Number.isInteger(error.revision) ? { revision: error.revision } : {}),
            ...(Number.isInteger(error.receivedChunks) ? { receivedChunks: error.receivedChunks } : {}),
            ...(Number.isInteger(error.totalChunks) ? { totalChunks: error.totalChunks } : {})
          });
        }
      }

      const pixelForgeCollection = pathname === '/api/pixelforge/projects';
      const pixelForgeItemPath = pathname.startsWith('/api/pixelforge/projects/') ? pathname.slice('/api/pixelforge/projects/'.length) : '';
      const pixelForgeItem = pixelForgeItemPath && !pixelForgeItemPath.includes('/') ? [pathname, pixelForgeItemPath] : null;
      if ((pixelForgeCollection || pixelForgeItem) && ['GET', 'PUT', 'DELETE'].includes(req.method)) {
        const user = await getSessionUser(req);
        if (!PIXELFORGE_GUEST_MODE && !user) return sendJson(res, 401, { error: 'not_authenticated', message: 'Inicia sesión en CodeLab para acceder a tus proyectos PixelForge.' });
        // Production must never silently downgrade the studio's durable database
        // contract to local sidecar files. File persistence is retained only for
        // isolated development/E2E environments without DATABASE_URL.
        const hostedProduction = process.env.NODE_ENV === 'production' ||
          process.env.RENDER === 'true' || !!process.env.RENDER_SERVICE_ID;
        if ((!accountPool && hostedProduction) || (accountPool && !pixelForgeTableReady)) {
          return sendJson(res, 503, { error: 'pixelforge_database_unavailable', message: 'El almacenamiento de PixelForge no está disponible. Contacta al administrador de CodeLab.' });
        }
        const workspaceId = PIXELFORGE_GUEST_MODE ? PIXELFORGE_GUEST_WORKSPACE_ID : userWorkspaceId(user);
        return await withPixelForgeAccountLock(workspaceId, async () => {
        const file = workspaceFile(workspaceId) + '.pixelforge.json';
        if (accountPool && pixelForgeCollection && req.method === 'GET') {
          try {
            const projects = await listPixelForgeProjectMetadataFromDatabase(workspaceId);
            return sendJson(res, 200, { projects });
          } catch (error) {
            console.error('PixelForge PostgreSQL list failed:', error.message);
            return sendJson(res, 503, { error: 'pixelforge_database_unavailable' });
          }
        }
        if (accountPool && pixelForgeItem && req.method === 'GET') {
          const id = decodePixelForgeProjectId(pixelForgeItem[1]);
          if (!id) return sendJson(res, 400, { error: 'invalid_project_id' });
          try {
            const project = await loadPixelForgeProjectFromDatabase(workspaceId, id);
            return project
              ? sendJson(res, 200, { project })
              : sendJson(res, 404, { error: 'project_not_found' });
          } catch (error) {
            console.error('PixelForge PostgreSQL load failed:', error.message);
            return sendJson(res, 503, { error: 'pixelforge_database_unavailable' });
          }
        }
        let records = [];
        try {
          if (!accountPool && fs.existsSync(file)) {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (!Array.isArray(parsed)) throw new Error('invalid_pixel_forge_store');
            records = parsed;
          }
        } catch (error) {
          console.error('PixelForge account storage read failed:', error.message);
          return sendJson(res, 500, { error: 'pixelforge_storage_unavailable' });
        }
        if (pixelForgeCollection && req.method === 'GET') {
          return sendJson(res, 200, { projects: records.map(record => ({
            id: record.id, name: record.name, width: record.width, height: record.height,
            updatedAt: record.updatedAt, lastOpenedAt: record.lastOpenedAt
          })).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt) });
        }
        if (pixelForgeItem && req.method === 'GET') {
          const id = decodePixelForgeProjectId(pixelForgeItem[1]);
          if (!id) return sendJson(res, 400, { error: 'invalid_project_id' });
          const record = records.find(item => item.id === id);
          if (!record) return sendJson(res, 404, { error: 'project_not_found' });
          record.lastOpenedAt = Math.max(Date.now(), Number(record.lastOpenedAt || 0) + 1);
          const tmp = file + '.tmp.' + process.pid + '.' + crypto.randomBytes(6).toString('hex');
          try {
            fs.writeFileSync(tmp, JSON.stringify(records), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            fs.renameSync(tmp, file);
          } catch (error) {
            try { fs.unlinkSync(tmp); } catch (_) {}
            console.error('PixelForge recent-project update failed:', error.message);
            return sendJson(res, 500, { error: 'pixelforge_storage_unavailable' });
          }
          return sendJson(res, 200, { project: record.project });
        }
        if (req.method === 'PUT') {
          const body = await readBody(req, Math.max(MAX_BODY_BYTES, PIXELFORGE_MAX_BODY_BYTES));
          const project = body && body.project;
          const validation = validatePixelForgeProjectPayload(project);
          if (validation.error) {
            return sendJson(res, validation.status, {
              error: validation.error,
              ...(validation.maxBytes ? { maxBytes: validation.maxBytes } : {})
            });
          }
          const { serialized, projectBytes } = validation;
          if (accountPool) {
            try {
              const result = await savePixelForgeProjectToDatabase(workspaceId, project, projectBytes);
              if (result.error) return sendJson(res, result.status, { error: result.error, ...(result.maxProjects ? { maxProjects: result.maxProjects } : {}), ...(result.maxBytes ? { maxBytes: result.maxBytes } : {}), ...(Number.isInteger(result.revision) ? { revision: result.revision } : {}) });
              return sendJson(res, result.status, { ok: true, project: { id: project.id, name: project.name.trim(), width: project.width, height: project.height, updatedAt: result.now, serverRevision: result.serverRevision } });
            } catch (error) {
              console.error('PixelForge PostgreSQL write failed:', error.message);
              return sendJson(res, 503, { error: 'pixelforge_database_unavailable' });
            }
          }
          const now = Date.now();
          const existing = records.find(item => item.id === project.id);
          const currentServerRevision = existing && existing.project && Number.isInteger(existing.project.serverRevision) ? existing.project.serverRevision : 0;
          const expectedServerRevision = Number.isInteger(project.serverRevision) ? project.serverRevision : 0;
          if (existing && expectedServerRevision !== currentServerRevision) {
            return sendJson(res, 409, { error: 'pixelforge_revision_conflict', revision: currentServerRevision });
          }
          const storedDocument = { ...project, serverRevision: currentServerRevision + 1 };
          const record = { id: project.id, name: project.name.trim(), width: project.width, height: project.height, updatedAt: now, lastOpenedAt: now, project: storedDocument };
          records = records.filter(item => item.id !== project.id);
          if (!existing && records.length >= MAX_PROJECTS) {
            return sendJson(res, 409, { error: 'pixelforge_project_limit', maxProjects: MAX_PROJECTS });
          }
          records.unshift(record);
          const accountBytes = Buffer.byteLength(JSON.stringify(records), 'utf8');
          if (accountBytes > PIXELFORGE_MAX_ACCOUNT_BYTES) {
            return sendJson(res, 413, { error: 'pixelforge_account_storage_limit', maxBytes: PIXELFORGE_MAX_ACCOUNT_BYTES });
          }
          const tmp = file + '.tmp.' + process.pid + '.' + crypto.randomBytes(6).toString('hex');
          try {
            fs.writeFileSync(tmp, JSON.stringify(records), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            fs.renameSync(tmp, file);
          } catch (error) {
            try { fs.unlinkSync(tmp); } catch (_) {}
            console.error('PixelForge account storage write failed:', error.message);
            return sendJson(res, 500, { error: 'pixelforge_storage_unavailable' });
          }
          return sendJson(res, existing ? 200 : 201, { ok: true, project: { id: record.id, name: record.name, width: record.width, height: record.height, updatedAt: now, serverRevision: storedDocument.serverRevision } });
        }
        if (pixelForgeItem && req.method === 'DELETE') {
          const id = decodePixelForgeProjectId(pixelForgeItem[1]);
          if (!id) return sendJson(res, 400, { error: 'invalid_project_id' });
          if (accountPool) {
            try {
              const deleted = await deletePixelForgeProjectFromDatabase(workspaceId, id);
              return deleted
                ? sendJson(res, 200, { ok: true })
                : sendJson(res, 404, { error: 'project_not_found' });
            } catch (error) {
              console.error('PixelForge PostgreSQL delete failed:', error.message);
              return sendJson(res, 503, { error: 'pixelforge_database_unavailable' });
            }
          }
          const next = records.filter(item => item.id !== id);
          if (next.length === records.length) return sendJson(res, 404, { error: 'project_not_found' });
          const tmp = file + '.tmp.' + process.pid + '.' + crypto.randomBytes(6).toString('hex');
          try {
            fs.writeFileSync(tmp, JSON.stringify(next), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            fs.renameSync(tmp, file);
          } catch (error) {
            try { fs.unlinkSync(tmp); } catch (_) {}
            return sendJson(res, 500, { error: 'pixelforge_storage_unavailable' });
          }
          return sendJson(res, 200, { ok: true });
        }
        });
      }

      // Imported Web/Design package files. Every request is bound to the authenticated
      // workspace and the project registry; file paths are treated as opaque relative paths.
      const projectFilesMatch = pathname.match(/^\/api\/workspace\/([^/]+)\/projects\/([^/]+)\/files(?:\/(.*))?$/);
      if (projectFilesMatch && req.method === 'GET') {
        const id = safeId(projectFilesMatch[1]);
        const projectId = safeId(projectFilesMatch[2]);
        if (!id || !projectId) return sendJson(res, 400, { error: 'invalid_project_reference' });
        if (!(await isAuthorized(req, id))) return sendJson(res, 401, { error: 'workspace_unauthorized' });
        if (!accountPool) return sendJson(res, 503, { error: 'project_files_unavailable' });
        try {
          await enforceSessionWorkspaceOwner(id, await readState(id), await getSessionUser(req));
          const project = await accountPool.query(
            "SELECT editor_id FROM public.codelab_project_registry WHERE workspace_id=$1 AND project_id=$2 AND editor_id IN ('web','design','pixelforge') LIMIT 1",
            [id, projectId]
          );
          if (!project.rowCount) return sendJson(res, 404, { error: 'project_not_found' });
          const requestedPath = projectFilesMatch[3];
          if (!requestedPath) {
            const files = await accountPool.query(
              'SELECT file_path, content_type, byte_size, sha256, updated_at FROM public.codelab_project_files WHERE workspace_id=$1 AND project_id=$2 AND editor_id=$3 ORDER BY file_path',
              [id, projectId, project.rows[0].editor_id]
            );
            return sendJson(res, 200, { files: files.rows.map(file => ({
              path: file.file_path, contentType: file.content_type, byteSize: Number(file.byte_size),
              sha256: file.sha256, updatedAt: file.updated_at
            })) });
          }
          let filePath;
          try { filePath = decodeURIComponent(requestedPath); } catch (_) {
            return sendJson(res, 400, { error: 'invalid_file_path' });
          }
          if (!filePath || filePath.length > 500 || filePath.startsWith('/') ||
              filePath.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\'))) {
            return sendJson(res, 400, { error: 'invalid_file_path' });
          }
          const file = await accountPool.query(
            'SELECT file_path, content_type, byte_size, sha256, content FROM public.codelab_project_files WHERE workspace_id=$1 AND project_id=$2 AND editor_id=$3 AND file_path=$4 LIMIT 1',
            [id, projectId, project.rows[0].editor_id, filePath]
          );
          if (!file.rowCount) return sendJson(res, 404, { error: 'project_file_not_found' });
          const row = file.rows[0];
          return sendJson(res, 200, {
            path: row.file_path, contentType: row.content_type, byteSize: Number(row.byte_size),
            sha256: row.sha256, contentBase64: Buffer.from(row.content).toString('base64')
          });
        } catch (error) {
          if (error && error.message === 'workspace_owner_mismatch') return sendJson(res, 403, { error: 'workspace_forbidden' });
          console.error('project_files_read_failed', error.message);
          return sendJson(res, 500, { error: 'project_files_read_failed' });
        }
      }

      // Workspace init
      if (req.method === 'POST' && pathname === '/api/workspace/init') {
        const body = await readBody(req);
        const sessionUser = await getSessionUser(req);
        let id;
        if (sessionUser) {
          // Logged-in users always use their bound workspace (portable across devices)
          id = userWorkspaceId(sessionUser);
          if (!(await workspaceExists(id))) await writeState(id, emptyState({ provider: sessionUser.provider, id: sessionUser.id }), null);
        } else {
          const requested = safeId(body && body.id);
          id = requested || 'ws_' + crypto.randomUUID();
          if (await workspaceExists(id)) {
            // Existing workspaces still require their token; never overwrite or
            // rebind an existing deterministic OAuth workspace anonymously.
            if (!(await isAuthorized(req, id))) {
              return sendJson(res, 401, { error: 'workspace_unauthorized' });
            }
          } else {
            // Authenticated workspace IDs are deterministic so they sync across devices.
            // Never let anonymous initialization squat on that namespace before its owner
            // signs in; otherwise the returned HMAC token would remain valid after binding.
            if (requested && /^ws_(github|google)_/i.test(requested)) {
              return sendJson(res, 400, { error: 'reserved_workspace_id' });
            }
            await writeState(id, emptyState(), null);
          }
        }
        let state;
        try {
          state = await readState(id);
          state = await enforceSessionWorkspaceOwner(id, state, sessionUser);
        } catch (error) {
          console.error('workspace_corrupt', id, error.message);
          return sendJson(res, 500, { error: 'workspace_corrupt' });
        }
        return sendJson(res, 200, {
          ok: true,
          workspaceId: id,
          token: signWorkspace(id),
          state: state,
          user: sessionUser || null
        });
      }

      const getMatch = pathname.match(/^\/api\/workspace\/([^/]+)$/);
      if (req.method === 'GET' && getMatch) {
        const id = safeId(getMatch[1]);
        if (!id) return sendJson(res, 400, { error: 'workspace_id_required' });
        if (!(await isAuthorized(req, id))) return sendJson(res, 401, { error: 'workspace_unauthorized' });
        try {
          const state = await enforceSessionWorkspaceOwner(id, await readState(id), await getSessionUser(req));
          return sendJson(res, 200, state);
        } catch (e) {
          console.error('workspace_corrupt', id, e.message);
          return sendJson(res, 500, { error: 'workspace_corrupt' });
        }
      }

      if (req.method === 'PUT' && getMatch) {
        const id = safeId(getMatch[1]);
        const body = await readBody(req);
        if (!id || !body || typeof body !== 'object' || Array.isArray(body) ||
            !Array.isArray(body.projects) || !Number.isInteger(body.baseRevision)) {
          return sendJson(res, 400, { error: 'invalid_workspace' });
        }
        if (!(await isAuthorized(req, id))) return sendJson(res, 401, { error: 'workspace_unauthorized' });
        const validationError = validateProjects(body.projects);
        if (validationError) {
          return sendJson(res, 400, { error: 'invalid_payload', detail: validationError });
        }
        try {
          const current = await enforceSessionWorkspaceOwner(id, await readState(id), await getSessionUser(req));
          if (body.baseRevision !== current.revision) {
            return sendJson(res, 409, {
              error: 'revision_conflict',
              revision: current.revision,
              updatedAt: current.updatedAt,
              projects: current.projects
            });
          }
          const next = {
            revision: current.revision + 1,
            updatedAt: new Date().toISOString(),
            projects: body.projects,
            owner: current.owner
          };
          await writeState(id, next, current.revision);
          return sendJson(res, 200, {
            ok: true,
            revision: next.revision,
            updatedAt: next.updatedAt
          });
        } catch (e) {
          if (e && e.code === 'WORKSPACE_REVISION_CONFLICT') {
            const latest = await readState(id);
            return sendJson(res, 409, { error: 'revision_conflict', revision: latest.revision, updatedAt: latest.updatedAt, projects: latest.projects });
          }
          console.error('workspace_write_failed', id, e.message);
          return sendJson(res, 500, { error: 'workspace_write_failed' });
        }
      }

      return sendJson(res, 404, { error: 'not_found' });
    } catch (e) {
      if (e.code === 'PAYLOAD_TOO_LARGE') {
        return sendJson(res, 413, { error: 'payload_too_large', maxBytes: MAX_BODY_BYTES });
      }
      if (e.code === 'INVALID_JSON') {
        return sendJson(res, 400, { error: 'invalid_json' });
      }
      console.error('Unhandled API error:', e);
      return sendJson(res, 500, { error: 'internal_error' });
    }
  }
  serveStatic(req, res, pathname);
});

try {
  fs.accessSync(DATA_DIR, fs.constants.W_OK);
} catch (e) {
  console.error('WARNING: DATA_DIR not writable:', DATA_DIR, e.message);
}

seedAdminAccountIfConfigured().then(async () => {
  if (accountPool) {
    await ensureWorkspaceStateTable();
    await ensureAuthSessionTable();
    await migrateLegacySessionsToDatabase();
    await cleanupExpiredSessions();
  }
  try {
    await ensureAgentBridgeWakeListener();
  } catch (error) {
    console.error('[CodeLab Native Bridge] Neon wake listener unavailable:', error.message);
  }
  // Keep the database notification listener armed, but do not launch the
  // native worker on every web-server startup. The worker starts on the first
  // committed queued command and then sleeps on LISTEN/NOTIFY between commands.
  console.log('[CodeLab Native Bridge] worker is command-driven; no idle worker startup.');
  try {
    await ensurePixelForgeTable();
  } catch (error) {
    // A PixelForge schema/connectivity issue must disable PixelForge with a
    // clear 503, not prevent unrelated CodeLab areas from starting.
    pixelForgeTableReady = false;
    console.error('PixelForge database initialization failed; studio API will return 503:', error.message);
  }
  async function runInlineArtifactSmokeTest() {
  if (String(process.env.AGENT_INLINE_ARTIFACT_SMOKE_TEST || '') !== '1') return;
  const token = String(process.env.AGENT_BRIDGE_CONTROL_SECRET_TEST || '');
  if (!token) throw new Error('inline_artifact_smoke_test_secret_missing');
  const data = Buffer.from('C', 'utf8');
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  const base = 'http://127.0.0.1:' + PORT;
  const headers = { 'x-codelab-agent-bridge-token': token };
  const manifest = await fetch(base + '/api/agent/bridge/artifacts', {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      total_bytes: data.length, total_chunks: 1, sha256,
      filename: 'inline-smoke.codelab', project_name: 'inline-smoke',
      target_workspace_id: PIXELFORGE_GUEST_WORKSPACE_ID, self_test: true
    })
  });
  const manifestBody = await manifest.json();
  if (!manifest.ok) throw new Error('inline_artifact_smoke_manifest_' + manifest.status + ':' + JSON.stringify(manifestBody));
  const artifactId = String(manifestBody.artifactId || '');
  const chunk = await fetch(base + '/api/agent/bridge/artifacts/' + artifactId + '/0', {
    method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: data
  });
  const chunkBody = await chunk.json();
  if (!chunk.ok) throw new Error('inline_artifact_smoke_chunk_' + chunk.status + ':' + JSON.stringify(chunkBody));
  const commit = await fetch(base + '/api/agent/bridge/artifacts/' + artifactId + '/commit', {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ sha256 })
  });
  const commitBody = await commit.json();
  if (!commit.ok || commitBody.status !== 'verified' || commitBody.sha256 !== sha256) {
    throw new Error('inline_artifact_smoke_commit_' + commit.status + ':' + JSON.stringify(commitBody));
  }
  console.log('[Inline Artifact Smoke] PASS manifest -> chunk -> commit -> Neon', JSON.stringify({
    artifactId, bytes: data.length, chunks: 1, sha256
  }));
}

server.listen(PORT, () => {
  void runInlineArtifactSmokeTest().catch(error => {
    console.error('[Inline Artifact Smoke] FAIL', error.message || error);
  });
  console.log('[CodeLab Native Bridge] Neon wake listener ready; worker starts only when a queued command arrives.');
  console.log('CodeLab XD Studio Pro v' + APP_VERSION + ' — puerto ' + PORT);
  console.log('Data dir: ' + DATA_DIR);
  if (!process.env.CODELAB_DATA_DIR) {
    console.warn('WARNING: CODELAB_DATA_DIR no está configurado; el secreto de respaldo y los archivos locales de desarrollo usan disco efímero. Las sesiones y los proyectos del workspace se guardan en PostgreSQL.');
  }
  if (!process.env.CODELAB_WORKSPACE_SECRET) {
    console.warn('WARNING: CODELAB_WORKSPACE_SECRET no está fijado; si se regenera el secreto, los tokens de workspace existentes dejarán de ser válidos.');
  }
  const cfg = oauthConfigured();
  console.log('OAuth GitHub:', cfg.github ? 'enabled' : 'disabled');
  console.log('OAuth Google:', cfg.google ? 'enabled' : 'disabled');
  console.log(
    'AI copiloto:',
    AI_API_KEY
      ? ('enabled · ' + AI_MODEL + ' @ ' + AI_BASE_URL + (isGroqBase(AI_BASE_URL) ? ' (groq)' : ''))
      : 'disabled (set AI_API_KEY or use client key)'
  );
  if (_rawModel && _rawModel !== AI_MODEL) {
    console.log('AI_MODEL normalizado:', JSON.stringify(_rawModel), '→', AI_MODEL);
  }
});
}).catch(error => {
  console.error('Native account database initialization failed:', error.message);
  process.exit(1);
});

let shuttingDown = false;
async function emitAgentBridgeShutdownSignal() {
  if (!accountPool) return;
  try {
    const admin = await accountPool.query("SELECT id FROM codelab_accounts WHERE username='ADMIN' AND role='admin' LIMIT 1");
    if (!admin.rowCount) return;
    const workspaceId = 'ws_local_' + String(admin.rows[0].id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
    await accountPool.query(
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
    await accountPool.query(
      `INSERT INTO public.codelab_agent_bridge_state
        (state_id, workspace_id, state, wake_required, wake_reason, signal_version, last_signal_at, updated_at, metadata)
       VALUES ($1,$2,'sleeping',true,'server_shutdown',1,now(),now(),$3::jsonb)
       ON CONFLICT (state_id) DO UPDATE SET
         state='sleeping', wake_required=true, wake_reason='server_shutdown',
         signal_version=public.codelab_agent_bridge_state.signal_version+1,
         last_signal_at=now(), updated_at=now(), metadata=$3::jsonb`,
      ['native-bridge:' + workspaceId, workspaceId, JSON.stringify({ pid: process.pid, source: 'server-shutdown' })]
    );
    console.log('[CodeLab Native Bridge] final Neon shutdown signal emitted by server.');
  } catch (error) {
    console.error('[CodeLab Native Bridge] final Neon shutdown signal failed:', error.message);
  }
}
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Shutting down…');
  await emitAgentBridgeShutdownSignal();
  stopAgentBridge();
  if (agentBridgeWakeClient) {
    try { await agentBridgeWakeClient.end(); } catch (_) {}
    agentBridgeWakeClient = null;
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });