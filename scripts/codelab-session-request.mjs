import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const repo = process.env.GITHUB_REPOSITORY || 'gavilandavid89-pixel/CodeLab';
const sessionId = String(process.env.CODELAB_SESSION_ID || '');
const mailboxBaseUrl = String(process.env.CODELAB_MAILBOX_BASE_URL || 'https://codelab-pbw9.onrender.com').replace(/\\/+$/, '');
const mailboxToken = String(process.env.CODELAB_MAILBOX_TOKEN || createHash('sha256').update('codelab-headless-mailbox:v1:' + sessionId).digest('hex'));
const requestId = randomUUID();
const requestJson = String(process.env.CODELAB_SESSION_REQUEST || '{}');
const timeoutMs = Math.max(1000, Math.min(10 * 60 * 1000, Number(process.env.CODELAB_SESSION_TIMEOUT_MS || 120000)));
if (!sessionId) throw new Error('CODELAB_SESSION_ID is required.');
if (!/^[a-f0-9]{64}$/i.test(mailboxToken)) throw new Error('CODELAB_MAILBOX_TOKEN is invalid.');

async function mailbox(pathname, method='GET', body=null) {
  const response = await fetch(mailboxBaseUrl + pathname, { method, headers: { accept: 'application/json', 'x-codelab-mailbox-token': mailboxToken, ...(body === null ? {} : { 'content-type': 'application/json' }) }, ...(body === null ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  let data = null; try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error('Headless mailbox HTTP ' + response.status + ': ' + JSON.stringify(data));
  return data;
}

function gh(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('gh', args, { env: { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', b => out += b);
    p.stderr.on('data', b => err += b);
    p.on('close', code => code === 0 ? resolve(out) : reject(new Error(err.slice(0, 2000))));
  });
}
const request = JSON.parse(requestJson);
request.requestId = requestId;
request.sessionId = sessionId;
await mailbox('/api/headless/session/request?sessionId=' + encodeURIComponent(sessionId), 'POST', { requestId, payload: request });

const deadline = Date.now() + timeoutMs;
while (Date.now() < deadline) {
  const result = await mailbox('/api/headless/session/result?sessionId=' + encodeURIComponent(sessionId) + '&requestId=' + encodeURIComponent(requestId));
  if (result.status === 'succeeded' || result.status === 'failed' || result.status === 'expired') {
    const normalized = { requestId, sessionId, ok: result.status === 'succeeded', result: result.result };
    console.log(JSON.stringify(normalized));
    process.exit(normalized.ok ? 0 : 1);
  }
  await new Promise(r => setTimeout(r, 5000));
}
throw new Error('Timed out waiting for persistent CodeLab session response.');