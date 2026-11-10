/**
 * CodeLab XD Studio Pro v2.6.7
 * HTTP nativo + OAuth GitHub/Google + workspaces por usuario + rate limit
 */
const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Pool } = require('pg');
const net = require('net');
const { URL } = require('url');
const designTools = require('./public/design-tools.js');
const pixelForgeUploads = require('./pixelforge-upload-store.js');
const { createPenpotIdentityAdapter, penpotIdsForUser } = require('./penpot-identity.js');
const { attachPenpotWebSocket } = require('./penpot-websocket.js');

const PORT = process.env.PORT || 3000;
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
// Penpot document payloads live inside the existing CodeLab project/workspace JSON.
// Keep this separate from PixelForge's binary asset budgets.
const PENPOT_MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
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
// Temporary isolated guest workspace for PixelForge. Set PIXELFORGE_GUEST_MODE=false to restore account-scoped access.
const PIXELFORGE_GUEST_MODE = String(process.env.PIXELFORGE_GUEST_MODE || 'true').toLowerCase() !== 'false';
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
  await accountPool.query(
    'INSERT INTO codelab_accounts (username,id,role,salt,password_hash,must_change_password) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (username) DO NOTHING',
    ['ADMIN','admin','admin',salt,passwordHash(ADMIN_BOOTSTRAP_PASSWORD,salt),true]
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
    return { status: existing.rowCount ? 200 : 201, now, serverRevision: storedDocument.serverRevision, contentSha256 };
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

      // Health
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

      if (req.method === 'GET' && pathname === '/api/pixelforge/mode') {
        return sendJson(res, 200, {
          guestMode: PIXELFORGE_GUEST_MODE,
          workspace: PIXELFORGE_GUEST_MODE ? 'temporary-shared' : 'account',
          accountsAvailableForPixelForge: !PIXELFORGE_GUEST_MODE
        });
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

      // Penpot-native document persistence inside the existing CodeLab workspace/project store.
      // No second database, user directory, project store, or durable asset bucket is introduced.
      const penpotDocumentMatch = pathname.match(/^\/api\/workspace\/([^/]+)\/projects\/([^/]+)\/penpot-document$/);
      if (penpotDocumentMatch && (req.method === 'GET' || req.method === 'PUT')) {
        const id = safeId(penpotDocumentMatch[1]);
        let projectId = '';
        try { projectId = decodeURIComponent(penpotDocumentMatch[2]); } catch (_) {}
        if (!id || !/^[A-Za-z0-9_-]{1,80}$/.test(projectId)) {
          return sendJson(res, 400, { error: 'invalid_penpot_document_target' });
        }
        if (!(await isAuthorized(req, id))) return sendJson(res, 401, { error: 'workspace_unauthorized' });
        if (!(await workspaceExists(id))) return sendJson(res, 404, { error: 'workspace_not_found' });

        try {
          const sessionUser = await getSessionUser(req);
          const current = await enforceSessionWorkspaceOwner(id, await readState(id), sessionUser);
          const projectIndex = current.projects.findIndex(project => project.id === projectId);
          if (projectIndex < 0) return sendJson(res, 404, { error: 'project_not_found' });
          const project = current.projects[projectIndex];
          const stored = project.design && project.design.penpotDocument ? project.design.penpotDocument : null;

          if (req.method === 'GET') {
            const penpotIds = sessionUser ? penpotIdsForUser(sessionUser, id, project) : null;
            return sendJson(res, 200, {
              document: stored ? stored.data : null,
              documentRevision: stored ? stored.revision : 0,
              workspaceRevision: current.revision,
              penpotIds
            });
          }

          const body = await readBody(req);
          if (!body || typeof body !== 'object' || Array.isArray(body) ||
              !body.document || typeof body.document !== 'object' || Array.isArray(body.document) ||
              !Number.isInteger(body.baseRevision) || body.baseRevision < 0) {
            return sendJson(res, 400, { error: 'invalid_penpot_document' });
          }
          const serialized = JSON.stringify(body.document);
          const documentBytes = Buffer.byteLength(serialized, 'utf8');
          if (documentBytes > PENPOT_MAX_DOCUMENT_BYTES) {
            return sendJson(res, 413, { error: 'penpot_document_too_large', maxBytes: PENPOT_MAX_DOCUMENT_BYTES });
          }
          if (body.baseRevision !== current.revision) {
            return sendJson(res, 409, {
              error: 'revision_conflict',
              workspaceRevision: current.revision,
              document: stored ? stored.data : null,
              documentRevision: stored ? stored.revision : 0
            });
          }

          const now = new Date().toISOString();
          const nextProjects = current.projects.map((item, index) => {
            if (index !== projectIndex) return item;
            const design = item.design && typeof item.design === 'object' && !Array.isArray(item.design)
              ? item.design : {};
            const previousRevision = stored && Number.isInteger(stored.revision) ? stored.revision : 0;
            return {
              ...item,
              design: {
                ...design,
                penpotDocument: {
                  format: 'penpot-native-document',
                  version: 1,
                  revision: previousRevision + 1,
                  updatedAt: now,
                  data: body.document
                }
              }
            };
          });
          const validationError = validateProjects(nextProjects);
          if (validationError) return sendJson(res, 400, { error: 'invalid_payload', detail: validationError });

          const nextState = {
            revision: current.revision + 1,
            updatedAt: now,
            projects: nextProjects,
            owner: current.owner
          };
          await writeState(id, nextState, current.revision);
          return sendJson(res, 200, {
            ok: true,
            documentRevision: stored && Number.isInteger(stored.revision) ? stored.revision + 1 : 1,
            workspaceRevision: nextState.revision,
            updatedAt: now
          });
        } catch (error) {
          if (error && error.code === 'WORKSPACE_REVISION_CONFLICT') {
            const latest = await readState(id);
            const latestProject = latest.projects.find(project => project.id === projectId);
            const latestDocument = latestProject && latestProject.design && latestProject.design.penpotDocument;
            return sendJson(res, 409, {
              error: 'revision_conflict',
              workspaceRevision: latest.revision,
              document: latestDocument ? latestDocument.data : null,
              documentRevision: latestDocument ? latestDocument.revision : 0
            });
          }
          console.error('penpot_document_persistence_failed', id, projectId, error.message);
          return sendJson(res, 500, { error: 'penpot_document_persistence_failed' });
        }
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

// Penpot notifications reuse the authenticated CodeLab account/workspace.
// File and team subscriptions are resolved against the owner's existing projects.
const penpotIdentityAdapter = createPenpotIdentityAdapter({
  getSessionUser,
  userWorkspaceId,
  readState,
  enforceSessionWorkspaceOwner
});
const penpotWebSocketServer = attachPenpotWebSocket(server, {
  identity: penpotIdentityAdapter
});

try {
  fs.accessSync(DATA_DIR, fs.constants.W_OK);
} catch (e) {
  console.error('WARNING: DATA_DIR not writable:', DATA_DIR, e.message);
}

seedAdminAccountIfConfigured().then(async () => {
  if (accountPool) {
    await accountPool.query('SELECT 1 FROM codelab_workspace_states LIMIT 0');
    await ensureAuthSessionTable();
    await migrateLegacySessionsToDatabase();
    await cleanupExpiredSessions();
  }
  try {
    await ensurePixelForgeTable();
  } catch (error) {
    // A PixelForge schema/connectivity issue must disable PixelForge with a
    // clear 503, not prevent unrelated CodeLab areas from starting.
    pixelForgeTableReady = false;
    console.error('PixelForge database initialization failed; studio API will return 503:', error.message);
  }
  server.listen(PORT, () => {
  if (DATABASE_URL && process.env.CODELAB_AGENT_BRIDGE_ENABLED !== '0') {
    const workerPath = path.join(__dirname, 'agent-bridge-worker.mjs');
    let bridgeWorker = null;
    let bridgeRestartTimer = null;
    let bridgeStopping = false;
    const launchBridgeWorker = () => {
      if (bridgeStopping || bridgeWorker) return;
      bridgeWorker = spawn(process.execPath, [workerPath], {
        cwd: __dirname,
        env: process.env,
        stdio: ['ignore', 'inherit', 'inherit']
      });
      bridgeWorker.on('error', error => {
        console.error('[CodeLab Native Bridge] worker launch failed:', error.message);
      });
      bridgeWorker.on('exit', (code, signal) => {
        bridgeWorker = null;
        if (bridgeStopping) return;
        console.error('[CodeLab Native Bridge] worker exited:', { code, signal });
        bridgeRestartTimer = setTimeout(launchBridgeWorker, 5000);
        if (bridgeRestartTimer.unref) bridgeRestartTimer.unref();
      });
    };
    launchBridgeWorker();
    process.on('SIGTERM', () => {
      bridgeStopping = true;
      if (bridgeRestartTimer) clearTimeout(bridgeRestartTimer);
      if (bridgeWorker) bridgeWorker.kill('SIGTERM');
    });
    process.on('SIGINT', () => {
      bridgeStopping = true;
      if (bridgeRestartTimer) clearTimeout(bridgeRestartTimer);
      if (bridgeWorker) bridgeWorker.kill('SIGINT');
    });
  }
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

function shutdown() {
  console.log('Shutting down…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
