/**
 * CodeLab XD Studio Pro v2.6.0
 * HTTP nativo + OAuth GitHub/Google + workspaces por usuario + rate limit
 */
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.CODELAB_DATA_DIR || path.join(__dirname, 'data');
const WORKSPACES_DIR = path.join(DATA_DIR, 'workspaces');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SECRET_FILE = path.join(DATA_DIR, '.workspace-secret');
const MAX_BODY_BYTES = Number(process.env.CODELAB_MAX_BODY_BYTES) || 2 * 1024 * 1024;
const MAX_PROJECTS = Number(process.env.CODELAB_MAX_PROJECTS) || 50;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_REQUESTS = 120;
const APP_VERSION = '2.6.2';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const COOKIE_NAME = 'codelab_sid';

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const OAUTH_PUBLIC_URL = (process.env.OAUTH_PUBLIC_URL || '').replace(/\/$/, ''); // e.g. https://app.onrender.com

// AI copiloto (OpenAI-compatible). Optional server-side key avoids browser CORS.
const AI_API_KEY = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '';
const AI_BASE_URL = (process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const AI_MODEL = process.env.AI_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
const AI_MAX_TOKENS = Number(process.env.AI_MAX_TOKENS) || 4096;
const AI_RATE_MAX = Number(process.env.AI_RATE_MAX) || 20; // per window per IP
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
    SERVER_SECRET = crypto.randomBytes(32).toString('hex');
    try { fs.writeFileSync(SECRET_FILE, SERVER_SECRET, { encoding: 'utf8', mode: 0o600 }); } catch (_) {}
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
  for (const [ip, entry] of rateMap) {
    if (now - entry.start > RATE_WINDOW_MS * 2) rateMap.delete(ip);
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

// Periodic session file cleanup (cheap, max 200 files/scan)
setInterval(() => {
  try {
    const files = fs.readdirSync(SESSIONS_DIR);
    const now = Date.now();
    let n = 0;
    for (const f of files) {
      if (!f.endsWith('.json') || n > 200) break;
      n++;
      try {
        const raw = fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8');
        const s = JSON.parse(raw);
        if (!s.expiresAt || s.expiresAt < now) fs.unlinkSync(path.join(SESSIONS_DIR, f));
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

function validateProjects(projects) {
  if (!Array.isArray(projects)) return 'projects_not_array';
  if (projects.length > MAX_PROJECTS) return 'too_many_projects';
  for (const p of projects) {
    if (!p || typeof p !== 'object') return 'invalid_project';
    if (typeof p.id !== 'string' || p.id.length > 80) return 'invalid_project_id';
    if (typeof p.name !== 'string' || p.name.length > 200) return 'invalid_project_name';
    if (!p.code || typeof p.code !== 'object') return 'invalid_project_code';
    for (const k of ['html', 'css', 'js']) {
      if (p.code[k] != null && typeof p.code[k] !== 'string') return 'invalid_code_field';
      if (typeof p.code[k] === 'string' && p.code[k].length > 500000) return 'code_too_large';
    }
  }
  return null;
}

function readState(id) {
  const file = workspaceFile(id);
  if (!fs.existsSync(file)) return emptyState();
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
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
  fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
  fs.renameSync(tmp, file);
}

// --- Cookies & sessions ---
function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
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
  fs.writeFileSync(sessionPath(sid), JSON.stringify(session), { encoding: 'utf8', mode: 0o600 });
  return session;
}

function readSession(sid) {
  if (!sid) return null;
  try {
    const raw = fs.readFileSync(sessionPath(sid), 'utf8');
    const session = JSON.parse(raw);
    if (!session || session.expiresAt < Date.now()) {
      try { fs.unlinkSync(sessionPath(sid)); } catch (_) {}
      return null;
    }
    return session;
  } catch (_) {
    return null;
  }
}

function destroySession(sid) {
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
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('payload_too_large'), { code: 'PAYLOAD_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(Object.assign(new Error('invalid_json'), { code: 'INVALID_JSON' })); }
    });
    req.on('error', reject);
  });
}

function httpsRequest(urlStr, options, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, body: text });
      });
    });
    req.on('error', reject);
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
  if (relToPublic.startsWith('..') || path.isAbsolute(relToPublic)) {
    setSecurityHeaders(res);
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not Found');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      setSecurityHeaders(res);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    setSecurityHeaders(res);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length
    };
    if (ext === '.html') {
      headers['Cache-Control'] = 'no-cache';
    } else if (ext === '.js' || ext === '.css') {
      headers['Cache-Control'] = 'public, max-age=86400';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
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
  return { serverKey: !!AI_API_KEY, baseUrl: AI_BASE_URL, model: AI_MODEL };
}

async function proxyChatCompletions({ apiKey, baseUrl, model, messages, temperature, maxTokens }) {
  const base = (baseUrl || AI_BASE_URL).replace(/\/$/, '');
  const body = JSON.stringify({
    model: model || AI_MODEL,
    temperature: typeof temperature === 'number' ? temperature : 0.3,
    max_tokens: maxTokens || AI_MAX_TOKENS,
    messages: messages
  });
  const res = await httpsRequest(base + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);
  let parsed;
  try {
    parsed = JSON.parse(res.body || '{}');
  } catch (_) {
    throw Object.assign(new Error('ai_invalid_json'), { status: res.status, body: (res.body || '').slice(0, 300) });
  }
  if (res.status < 200 || res.status >= 300) {
    const msg = (parsed && (parsed.error && parsed.error.message)) || ('HTTP ' + res.status);
    throw Object.assign(new Error(String(msg)), { status: res.status });
  }
  const content = ((((parsed.choices || [])[0] || {}).message) || {}).content || '';
  return { content, raw: parsed };
}

function buildAiSystemPrompt(code) {
  const html = String((code && code.html) || '').slice(0, 12000);
  const css = String((code && code.css) || '').slice(0, 12000);
  const js = String((code && code.js) || '').slice(0, 12000);
  return (
    'Eres el copiloto de CodeLab XD Studio, un editor web HTML/CSS/JS.\n' +
    'Responde ÚNICAMENTE con un JSON válido (sin markdown ni fences) con esta forma exacta:\n' +
    '{"html":"...","css":"...","js":"...","message":"resumen breve en español"}\n' +
    'Reglas:\n' +
    '- Si el usuario pide un cambio parcial, devuelve las tres claves; conserva el código no modificado.\n' +
    '- Código limpio, moderno y funcional en el navegador.\n' +
    '- No inventes dependencias externas salvo que el usuario las pida.\n' +
    '- message: una frase corta de lo que hiciste.\n\n' +
    'Código actual del usuario:\n---HTML---\n' + html +
    '\n---CSS---\n' + css +
    '\n---JS---\n' + js
  );
}

function parseAiJsonContent(content, fallbackCode) {
  const code = fallbackCode || { html: '', css: '', js: '' };
  let parsed = null;
  try {
    parsed = JSON.parse(content);
  } catch (_) {
    const m = String(content).match(/\{[\s\S]*\}/);
    if (m) {
      try { parsed = JSON.parse(m[0]); } catch (__) {}
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('ai_bad_shape');
  }
  return {
    html: typeof parsed.html === 'string' ? parsed.html : code.html,
    css: typeof parsed.css === 'string' ? parsed.css : code.css,
    js: typeof parsed.js === 'string' ? parsed.js : code.js,
    message: typeof parsed.message === 'string' ? parsed.message : 'Listo.'
  };
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
          baseUrl: cfg.serverKey ? cfg.baseUrl : null,
          modes: ['local', 'api'],
          hint: cfg.serverKey
            ? 'Servidor listo: puedes usar el copiloto sin pegar API key.'
            : 'Configura AI_API_KEY (o OPENAI_API_KEY) en el servidor, o pega tu key en Ajustes IA.'
        });
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
        const apiKey = AI_API_KEY || clientKey;
        if (!apiKey) {
          return sendJson(res, 503, {
            error: 'ai_not_configured',
            message: 'No hay API key. Configura AI_API_KEY en el servidor o pégala en Ajustes del copiloto.'
          });
        }
        const baseUrl = (body && typeof body.baseUrl === 'string' && body.baseUrl.trim())
          ? body.baseUrl.trim().replace(/\/$/, '')
          : AI_BASE_URL;
        const model = (body && typeof body.model === 'string' && body.model.trim())
          ? body.model.trim()
          : AI_MODEL;
        try {
          const messages = [
            { role: 'system', content: buildAiSystemPrompt(code) },
            { role: 'user', content: prompt }
          ];
          const { content } = await proxyChatCompletions({
            apiKey,
            baseUrl,
            model,
            messages,
            temperature: 0.3,
            maxTokens: AI_MAX_TOKENS
          });
          const result = parseAiJsonContent(content, code);
          return sendJson(res, 200, {
            ok: true,
            html: result.html,
            css: result.css,
            js: result.js,
            message: result.message,
            model: model,
            via: AI_API_KEY && !clientKey ? 'server' : 'client-key'
          });
        } catch (e) {
          console.error('AI proxy error:', e.message);
          const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
          return sendJson(res, status >= 500 ? 502 : status, {
            error: 'ai_upstream_failed',
            message: String(e.message || 'AI request failed').slice(0, 300)
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
        const url =
          'https://github.com/login/oauth/authorize?client_id=' +
          encodeURIComponent(GITHUB_CLIENT_ID) +
          '&redirect_uri=' + encodeURIComponent(redirectUri) +
          '&scope=' + encodeURIComponent('read:user user:email') +
          '&state=' + encodeURIComponent(state);
        return redirect(res, url);
      }

      // GitHub callback
      if (req.method === 'GET' && pathname === '/api/auth/github/callback') {
        const code = searchParams.get('code');
        const st = parseOAuthState(searchParams.get('state'));
        if (!code || !st || st.provider !== 'github') {
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
        const url =
          'https://accounts.google.com/o/oauth2/v2/auth?client_id=' +
          encodeURIComponent(GOOGLE_CLIENT_ID) +
          '&redirect_uri=' + encodeURIComponent(redirectUri) +
          '&response_type=code' +
          '&scope=' + encodeURIComponent('openid email profile') +
          '&state=' + encodeURIComponent(state) +
          '&access_type=online' +
          '&prompt=select_account';
        return redirect(res, url);
      }

      // Google callback
      if (req.method === 'GET' && pathname === '/api/auth/google/callback') {
        const code = searchParams.get('code');
        const st = parseOAuthState(searchParams.get('state'));
        if (!code || !st || st.provider !== 'google') {
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
            if (!isAuthorized(req, id)) {
              return sendJson(res, 401, { error: 'workspace_unauthorized' });
            }
          } else {
            writeState(id, emptyState());
          }
        }
        return sendJson(res, 200, {
          ok: true,
          workspaceId: id,
          token: signWorkspace(id),
          state: readState(id),
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
        if (!id || !Array.isArray(body.projects) || !Number.isInteger(body.baseRevision)) {
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
  const cfg = oauthConfigured();
  console.log('OAuth GitHub:', cfg.github ? 'enabled' : 'disabled');
  console.log('OAuth Google:', cfg.google ? 'enabled' : 'disabled');
  console.log('AI copiloto:', AI_API_KEY ? ('enabled · ' + AI_MODEL) : 'disabled (set AI_API_KEY or use client key)');
});

function shutdown() {
  console.log('Shutting down…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
