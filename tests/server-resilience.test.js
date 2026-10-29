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
    console.log('Server resilience passed: malformed cookie encoding does not crash auth status.');
  } finally {
    server.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 100));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
