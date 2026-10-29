const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 3193;
const BASE_URL = 'http://127.0.0.1:' + PORT;

(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codelab-server-resilience-'));
  const server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      CODELAB_DATA_DIR: dataDir,
      CODELAB_WORKSPACE_SECRET: 'test-only-server-resilience-secret'
    },
    stdio: 'ignore'
  });

  try {
    let healthy = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (server.exitCode !== null) throw new Error('Server exited before becoming healthy.');
      try {
        const response = await fetch(BASE_URL + '/api/health');
        if (response.ok) {
          healthy = true;
          break;
        }
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(healthy, true, 'Server should start and answer health checks');

    const response = await fetch(BASE_URL + '/api/auth/status', {
      headers: { Cookie: 'codelab_sid=%E0%A4%A' }
    });
    assert.equal(response.status, 200, 'Malformed cookie encoding must not cause an API 500');
    const status = await response.json();
    assert.equal(status.user, null, 'Malformed session cookie should be treated as unauthenticated');
    assert.equal(typeof status.demoFallback, 'boolean');

    const oversized = '{"padding":"' + 'x'.repeat(2 * 1024 * 1024) + '"}';
    const oversizedResponse = await fetch(BASE_URL + '/api/workspace/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversized
    });
    assert.equal(oversizedResponse.status, 413, 'Oversized request should receive a proper HTTP 413 response');
    const oversizedResult = await oversizedResponse.json();
    assert.equal(oversizedResult.error, 'payload_too_large');
    console.log('Server resilience passed: malformed cookies are safe and oversized bodies receive HTTP 413.');
  } finally {
    server.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 100));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
