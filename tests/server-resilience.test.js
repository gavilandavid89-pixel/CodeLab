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

    const oversized = '{"padding":"' + 'x'.repeat(10 * 1024 * 1024) + '"}';
    const oversizedResponse = await fetch(BASE_URL + '/api/workspace/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversized
    });
    assert.equal(oversizedResponse.status, 413, 'Oversized request should receive a proper HTTP 413 response');
    const oversizedResult = await oversizedResponse.json();
    assert.equal(oversizedResult.error, 'payload_too_large');

    const initResponse = await fetch(BASE_URL + '/api/workspace/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(initResponse.status, 200);
    const workspace = await initResponse.json();
    const designSystemUrl = BASE_URL + '/api/workspace/' + encodeURIComponent(workspace.workspaceId) + '/design-system';
    const authHeaders = { 'x-workspace-token': workspace.token };

    const emptySettingsResponse = await fetch(designSystemUrl, { headers: authHeaders });
    assert.equal(emptySettingsResponse.status, 200);
    assert.equal((await emptySettingsResponse.json()).settings, null);

    const saveSettingsResponse = await fetch(designSystemUrl, {
      method: 'PUT',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { name: 'Persisted system', primary: '#123456', baseFont: 18 } })
    });
    assert.equal(saveSettingsResponse.status, 200);
    const savedSettings = await saveSettingsResponse.json();
    assert.equal(savedSettings.settings.name, 'Persisted system');
    assert.equal(savedSettings.settings.primary, '#123456');
    assert.equal(savedSettings.settings.baseFont, 18);

    const reloadSettingsResponse = await fetch(designSystemUrl, { headers: authHeaders });
    assert.equal(reloadSettingsResponse.status, 200);
    const reloadedSettings = await reloadSettingsResponse.json();
    assert.equal(reloadedSettings.settings.name, 'Persisted system');
    assert.equal(reloadedSettings.settings.primary, '#123456');

    const unauthorizedResponse = await fetch(designSystemUrl, { headers: { 'x-workspace-token': 'invalid-token' } });
    assert.equal(unauthorizedResponse.status, 401, 'Design-system settings must remain workspace-authorized');

    let lastRateLimitStatus = 0;
    for (let index = 1; index <= 121; index++) {
      const response = await fetch(BASE_URL + '/api/health', {
        headers: { 'x-forwarded-for': '198.51.100.' + index + ', 203.0.113.7' }
      });
      lastRateLimitStatus = response.status;
    }
    assert.equal(lastRateLimitStatus, 429,
      'Rate limiting should use the rightmost proxy-appended IP rather than spoofable leftmost values');
    console.log('Server resilience passed: malformed cookies, oversized bodies, workspace settings auth/persistence, and forwarded-IP rate limiting.');
  } finally {
    server.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 100));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
