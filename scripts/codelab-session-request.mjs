import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const repo = process.env.GITHUB_REPOSITORY || 'gavilandavid89-pixel/CodeLab';
const issueNumber = Number(process.env.CODELAB_SESSION_ISSUE);
const sessionId = String(process.env.CODELAB_SESSION_ID || '');
const requestId = randomUUID();
const requestJson = String(process.env.CODELAB_SESSION_REQUEST || '{}');
const timeoutMs = Math.max(1000, Math.min(10 * 60 * 1000, Number(process.env.CODELAB_SESSION_TIMEOUT_MS || 120000)));
if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error('CODELAB_SESSION_ISSUE is required.');
if (!sessionId) throw new Error('CODELAB_SESSION_ID is required.');

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
await gh(['api', '-X', 'POST', `repos/${repo}/issues/${issueNumber}/comments`, '-f', 'body=[CodeLab Session Request]\n' + JSON.stringify(request)]);

const deadline = Date.now() + timeoutMs;
while (Date.now() < deadline) {
  const comments = JSON.parse(await gh(['api', `repos/${repo}/issues/${issueNumber}/comments?per_page=100`]));
  for (const c of comments) {
    const body = String(c.body || '');
    if (!body.startsWith('[CodeLab Session Result]')) continue;
    try {
      const result = JSON.parse(body.slice('[CodeLab Session Result]'.length).trim());
      if (result.requestId === requestId && result.sessionId === sessionId) {
        console.log(JSON.stringify(result));
        process.exit(result.ok ? 0 : 1);
      }
    } catch {}
  }
  await new Promise(r => setTimeout(r, 1000));
}
throw new Error('Timed out waiting for persistent CodeLab session response.');
