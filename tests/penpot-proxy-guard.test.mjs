import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const port = 3197;
const base = 'http://127.0.0.1:' + port;

test('Penpot proxy never exposes the upstream before CodeLab SSO is ready', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'codelab-penpot-proxy-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), CODELAB_DATA_DIR: dataDir,
      CODELAB_WORKSPACE_SECRET: 'test-penpot-proxy-secret',
      PENPOT_FRONTEND_URL: 'http://127.0.0.1:1' },
    stdio: 'ignore'
  });
  try {
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try { const response = await fetch(base + '/api/health'); if (response.ok) { ready = true; break; } } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(ready, true, 'CodeLab should start for the proxy guard test');
    const response = await fetch(base + '/penpot/');
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'penpot_codelab_session_required' });
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 150));
    await rm(dataDir, { recursive: true, force: true });
  }
});
