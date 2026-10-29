/**
 * CodeLab XD Studio Pro v2.6.6
 * HTTP nativo + OAuth GitHub/Google + workspaces por usuario + rate limit
 */
const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const net = require('net');
const { URL } = require('url');
const designTools = require('./public/design-tools.js');

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
const configuredMaxProjects = Number.parseInt(process.env.CODELAB_MAX_PROJECTS || '', 10);
const MAX_PROJECTS = Number.isInteger(configuredMaxProjects) && configuredMaxProjects > 0
  ? Math.min(500, configuredMaxProjects)
  : 50;
const configuredUpstreamTimeout = Number.parseInt(process.env.CODELAB_UPSTREAM_TIMEOUT_MS || '60000', 10);
const UPSTREAM_TIMEOUT_MS = Number.isInteger(configuredUpstreamTimeout)
  ? Math.min(300000, Math.max(1000, configuredUpstreamTimeout))
  : 60000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_REQUESTS = 120;
const APP_VERSION = '2.6.6';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const COOKIE_NAME = 'codelab_sid';

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

let SERVER_SECRET = process.env.CODELAB_WORKSPACE_SECRET || '';
if (!SERVER_SECRET) {
  try { SERVER_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (_) {}
  if (!SERVER_SECRET) {
    const generatedSecret = crypto.randomBytes(32).toString('hex');
    try {
      // Exclusive creation prevents two instances sharing a disk from silently
      // replacing one another's HMAC key during concurrent startup.
      fs.writeFileSync(SECRET_FILE, generatedSecret, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      });
      SERVER_SECRET = generatedSecret;
    } catch (error) {
      if (error.code === 'EEXIST') {
        try { SERVER_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (_) {}
      } else {
        throw new Error('CODELAB_WORKSPACE_SECRET is required when the secret file cannot be persisted: ' + error.message);
      }
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

// Periodic session cleanup reads at most 200 JSON session files per scan.
setInterval(() => {
  try {
    const files = fs.readdirSync(SESSIONS_DIR)
      .filter(file => file.endsWith('.json'))
      .slice(0, 200);
    const now = Date.now();
    for (const file of files) {
      try {
        const sessionFile = path.join(SESSIONS_DIR, file);
        const raw = fs.readFileSync(sessionFile, 'utf8');
        const session = JSON.parse(raw);
        if (!session || !Number.isFinite(session.expiresAt) || session.expiresAt < now) {
          fs.unlinkSync(sessionFile);
        }
      } catch (_) {}
    }
  } catch (_) {}
}, 15 * 60 * 1000).unref();

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
  try {
    const parsed = JSON.parse(fs.readFileSync(designSystemFile(id), 'utf8'));
    return parsed && parsed.settings && typeof parsed.settings === 'object'
      ? designTools.sanitizeSettings(parsed.settings)
      : null;
  } catch (_) {
    return null;
  }
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

function readState(id) {
  const file = workspaceFile(id);
  if (!fs.existsSync(file)) return emptyState();
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Do not silently replace malformed persisted fields with empty defaults: that
  // can make a broken workspace look valid and later overwrite recoverable data.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('workspace_state_invalid');
  }
  if (Object.prototype.hasOwnProperty.call(parsed, 'projects') && !Array.isArray(parsed.projects)) {
    throw new Error('workspace_projects_invalid');
  }
  if (parsed.revision != null && (!Number.isInteger(parsed.revision) || parsed.revision < 0)) {
    throw new Error('workspace_revision_invalid');
  }
  if (parsed.updatedAt != null && typeof parsed.updatedAt !== 'string') {
    throw new Error('workspace_updated_at_invalid');
  }
  if (parsed.owner != null && (typeof parsed.owner !== 'object' || Array.isArray(parsed.owner))) {
    throw new Error('workspace_owner_invalid');
  }
  return {
    version: 5,
    revision: Number.isInteger(parsed.revision) ? parsed.revision : 0,
    updatedAt: parsed.updatedAt || new Date().toISOString(),
    projects: Array.isArray(parsed.projects) ? parsed.projects : [],
    owner: parsed.owner || null
  };
}

function writeState(id, state) {
  const file = workspaceFile(id);
  const tmp = file + '.tmp.' + process.pid + '.' + Date.now();
  const payload = {
    version: 5,
    revision: state.revision,
    updatedAt: state.updatedAt,
    projects: state.projects,
    owner: state.owner || null
  };
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    // A failed atomic replace must not leave orphaned workspace temp files behind.
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw error;
  }
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

function createSession(user) {
  const sid = crypto.randomBytes(24).toString('hex');
  const session = {
    id: sid,
    user: {
      id: String(user.id),
      provider: user.provider,
      name: user.name || user.login || 'User',
      email: user.email || null,
      avatar: user.avatar || user.avatar_url || null
    },
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS
  };
  const file = sessionPath(sid);
  const tmp = file + '.tmp.' + process.pid + '.' + crypto.randomBytes(6).toString('hex');
  try {
    fs.writeFileSync(tmp, JSON.stringify(session), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (error) {
    // Session creation must not leave partial credentials or orphaned temp files.
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw error;
  }
  return session;
}

function readSession(sid) {
  // Session IDs are generated as 24 random bytes encoded as lowercase hex.
  // Reject anything else before mapping a cookie value to a filesystem path.
  if (typeof sid !== 'string' || !/^[a-f0-9]{48}$/.test(sid)) return null;
  const file = sessionPath(sid);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const session = JSON.parse(raw);
    const valid =
      session &&
      typeof session === 'object' &&
      !Array.isArray(session) &&
      session.id === sid &&
      Number.isFinite(session.expiresAt) &&
      session.expiresAt > Date.now() &&
      session.user &&
      typeof session.user === 'object' &&
      typeof session.user.id === 'string' &&
      (session.user.provider === 'github' || session.user.provider === 'google');
    if (!valid) {
      try { fs.unlinkSync(file); } catch (_) {}
      return null;
    }
    return session;
  } catch (_) {
    return null;
  }
}

function destroySession(sid) {
  // Logout cookies are untrusted input; only generated session IDs may map to files.
  if (typeof sid !== 'string' || !/^[a-f0-9]{48}$/.test(sid)) return;
  try { fs.unlinkSync(sessionPath(sid)); } catch (_) {}
}

function getSessionUser(req) {
  const cookies = parseCookies(req);
  const session = readSession(cookies[COOKIE_NAME]);
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
  const proto = (req.headers['x-forwarded-proto'] || (isSecureRequest(req) ? 'https' : 'http')).split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:' + PORT;
  return proto + '://' + host;
}

function isAuthorized(req, id) {
  const token = req.headers['x-workspace-token'] || '';
  const expected = Buffer.from(signWorkspace(id));
  const received = Buffer.from(token);
  if (received.length === expected.length && crypto.timingSafeEqual(received, expected)) {
    return true;
  }
  // Session owner can access their bound workspace
  const user = getSessionUser(req);
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
    'Content-Length': Buffer.byteLength(data)
  }, extraHeaders || {});
  res.writeHead(status, headers);
  res.end(data);
}

function redirect(res, location, extraHeaders) {
  const headers = Object.assign({
    Location: location,
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

function readBody(req) {
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
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        // Keep the request stream alive long enough to return a real HTTP 413
        // instead of resetting the socket before the caller can send JSON.
        fail(Object.assign(new Error('payload_too_large'), { code: 'PAYLOAD_TOO_LARGE' }));
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
        fail(Object.assign(new Error('invalid_json'), { code: 'INVALID_JSON' }));
      }
    });
    req.on('aborted', () => {
      fail(Object.assign(new Error('request_aborted'), { code: 'REQUEST_ABORTED' }));
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
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function serveStatic(req, res, urlPath) {
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
    fs.readFile(realPath, (err, data) => {
      if (err) {
        setSecurityHeaders(res);
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not Found');
      }
      const ext = path.extname(realPath).toLowerCase();
      setSecurityHeaders(res);
      const headers = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': data.length
      };
      // HTML references stable asset URLs; force revalidation so deployments cannot leave
      // users running stale application logic for a full day after a release.
      if (ext === '.html' || ext === '.js' || ext === '.css') {
        headers['Cache-Control'] = 'no-cache';
      }
      res.writeHead(200, headers);
      res.end(data);
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

function ensureUserWorkspace(user) {
  const id = userWorkspaceId(user);
  const file = workspaceFile(id);
  if (!fs.existsSync(file)) {
    writeState(id, emptyState({ provider: user.provider, id: user.id }));
  } else {
    try {
      const st = readState(id);
      if (!st.owner) {
        st.owner = { provider: user.provider, id: user.id };
        writeState(id, st);
      }
    } catch (_) {}
  }
  return id;
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
    if (
      ip.startsWith('2001:db8:') ||
      ip.startsWith('2001:0:') ||
      ip.startsWith('2001:10:') ||
      ip.startsWith('2001:20:') ||
      ip.startsWith('2002:') ||
      ip.startsWith('3fff:')
    ) return false;
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
    lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family)
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

  if (pathname.startsWith('/api/')) {
    if (!checkRateLimit(ip)) {
      return sendJson(res, 429, { error: 'rate_limited', message: 'Demasiadas peticiones.' });
    }
    try {
      // Health
      if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/api/health') {
        const cfg = oauthConfigured();
        const body = {
          ok: true,
          version: APP_VERSION,
          persistence: 'server-file',
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
            'Content-Length': Buffer.byteLength(data)
          });
          return res.end();
        }
        return sendJson(res, 200, body);
      }

      // Auth status / me
      if (req.method === 'GET' && pathname === '/api/auth/status') {
        const cfg = oauthConfigured();
        const user = getSessionUser(req);
        return sendJson(res, 200, {
          oauth: cfg,
          demoFallback: !(cfg.github || cfg.google),
          user: user || null,
          workspaceId: user ? userWorkspaceId(user) : null
        });
      }

      if (req.method === 'GET' && pathname === '/api/auth/me') {
        const user = getSessionUser(req);
        if (!user) return sendJson(res, 401, { error: 'not_authenticated' });
        return sendJson(res, 200, {
          user,
          workspaceId: userWorkspaceId(user),
          token: signWorkspace(userWorkspaceId(user))
        });
      }

      if (req.method === 'POST' && pathname === '/api/auth/logout') {
        const cookies = parseCookies(req);
        destroySession(cookies[COOKIE_NAME]);
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
          const session = createSession(user);
          ensureUserWorkspace(user);
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
          const session = createSession(user);
          ensureUserWorkspace(user);
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
        if (!isAuthorized(req, id)) return sendJson(res, 401, { error: 'workspace_unauthorized' });
        if (!fs.existsSync(workspaceFile(id))) return sendJson(res, 404, { error: 'workspace_not_found' });
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

      // Workspace init
      if (req.method === 'POST' && pathname === '/api/workspace/init') {
        const body = await readBody(req);
        const sessionUser = getSessionUser(req);
        let id;
        if (sessionUser) {
          // Logged-in users always use their bound workspace (portable across devices)
          id = userWorkspaceId(sessionUser);
          if (!fs.existsSync(workspaceFile(id))) {
            writeState(id, emptyState({ provider: sessionUser.provider, id: sessionUser.id }));
          }
        } else {
          const requested = safeId(body && body.id);
          id = requested || 'ws_' + crypto.randomUUID();
          const file = workspaceFile(id);
          if (fs.existsSync(file)) {
            // Existing workspaces still require their token; never overwrite or
            // rebind an existing deterministic OAuth workspace anonymously.
            if (!isAuthorized(req, id)) {
              return sendJson(res, 401, { error: 'workspace_unauthorized' });
            }
          } else {
            // Authenticated workspace IDs are deterministic so they sync across devices.
            // Never let anonymous initialization squat on that namespace before its owner
            // signs in; otherwise the returned HMAC token would remain valid after binding.
            if (requested && /^ws_(github|google)_/i.test(requested)) {
              return sendJson(res, 400, { error: 'reserved_workspace_id' });
            }
            writeState(id, emptyState());
          }
        }
        let state;
        try {
          state = readState(id);
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
        if (!isAuthorized(req, id)) return sendJson(res, 401, { error: 'workspace_unauthorized' });
        try {
          return sendJson(res, 200, readState(id));
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
        if (!isAuthorized(req, id)) return sendJson(res, 401, { error: 'workspace_unauthorized' });
        const validationError = validateProjects(body.projects);
        if (validationError) {
          return sendJson(res, 400, { error: 'invalid_payload', detail: validationError });
        }
        try {
          const current = readState(id);
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
          writeState(id, next);
          return sendJson(res, 200, {
            ok: true,
            revision: next.revision,
            updatedAt: next.updatedAt
          });
        } catch (e) {
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

server.listen(PORT, () => {
  console.log('CodeLab XD Studio Pro v' + APP_VERSION + ' — puerto ' + PORT);
  console.log('Data dir: ' + DATA_DIR);
  if (!process.env.CODELAB_DATA_DIR) {
    console.warn('WARNING: CODELAB_DATA_DIR no está configurado; en hosting con disco efímero los workspaces y sesiones pueden perderse tras un redeploy/reinicio.');
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

function shutdown() {
  console.log('Shutting down…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
