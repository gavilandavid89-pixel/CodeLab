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
      CODELAB_WORKSPACE_SECRET: 'test-only-server-resilience-secret',
      CODELAB_TRUSTED_PROXY_HOPS: '2',
      GITHUB_CLIENT_ID: 'test-github-client',
      GITHUB_CLIENT_SECRET: 'test-github-secret',
      GOOGLE_CLIENT_ID: 'test-google-client',
      GOOGLE_CLIENT_SECRET: 'test-google-secret'
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

    const appAsset = await fetch(BASE_URL + '/app.js');
    assert.equal(appAsset.status, 200, 'Main client script should be served');
    assert.equal(appAsset.headers.get('cache-control'), 'no-cache',
      'Client JavaScript must revalidate after deployment instead of remaining stale for 24 hours');

    const response = await fetch(BASE_URL + '/api/auth/status', {
      headers: { Cookie: 'codelab_sid=%E0%A4%A' }
    });
    assert.equal(response.status, 200, 'Malformed cookie encoding must not cause an API 500');
    const status = await response.json();
    assert.equal(status.user, null, 'Malformed session cookie should be treated as unauthenticated');
    assert.equal(typeof status.demoFallback, 'boolean');

    // OAuth state must be bound to the browser that started the flow, not just
    // signed by the server. A copied authorization URL without its cookie fails.
    for (const provider of ['github', 'google']) {
      const start = await fetch(BASE_URL + '/api/auth/' + provider, { redirect: 'manual' });
      assert.equal(start.status, 302, provider + ' OAuth should start with a redirect');
      const authorizeUrl = new URL(start.headers.get('location'));
      const state = authorizeUrl.searchParams.get('state');
      assert.ok(state, provider + ' OAuth redirect should include signed state');
      assert.match(start.headers.get('set-cookie') || '', new RegExp('codelab_oauth_state_' + provider));
      const callback = await fetch(BASE_URL + '/api/auth/' + provider + '/callback?code=attacker-controlled&state=' + encodeURIComponent(state), {
        redirect: 'manual'
      });
      assert.equal(callback.status, 302);
      assert.match(callback.headers.get('location') || '', /reason=invalid_state/,
        provider + ' callback must reject a valid state copied without its browser cookie');
    }

    const malformedJsonResponse = await fetch(BASE_URL + '/api/workspace/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"broken":'
    });
    assert.equal(malformedJsonResponse.status, 400,
      'Malformed JSON bodies should produce a client error rather than an internal server error');
    assert.equal((await malformedJsonResponse.json()).error, 'invalid_json');

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
    const nullWorkspaceUpdate = await fetch(BASE_URL + '/api/workspace/' + encodeURIComponent(workspace.workspaceId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspace.token },
      body: 'null'
    });
    assert.equal(nullWorkspaceUpdate.status, 400,
      'Null workspace updates should be rejected as invalid input, not crash into HTTP 500');
    assert.equal((await nullWorkspaceUpdate.json()).error, 'invalid_workspace');
    const invalidCodeContainer = await fetch(BASE_URL + '/api/workspace/' + encodeURIComponent(workspace.workspaceId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspace.token },
      body: JSON.stringify({
        baseRevision: 0,
        projects: [{ id: 'bad-code', name: 'Invalid code container', code: [] }]
      })
    });
    assert.equal(invalidCodeContainer.status, 400,
      'Project code must be an object with HTML/CSS/JS fields, not an array');
    const invalidCodeResult = await invalidCodeContainer.json();
    assert.equal(invalidCodeResult.error, 'invalid_payload');
    assert.equal(invalidCodeResult.detail, 'invalid_project_code');
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
    const workspaceFiles = await fs.readdir(path.join(dataDir, 'workspaces'));
    const designSystemFile = workspaceFiles.find(name => name.endsWith('.design-system.json'));
    assert.ok(designSystemFile, 'Saved design system should have a persistent backing file');
    const designSystemStat = await fs.stat(path.join(dataDir, 'workspaces', designSystemFile));
    assert.equal(designSystemStat.mode & 0o077, 0,
      'Design-system persistence file should not grant group or other users access');

    const reloadSettingsResponse = await fetch(designSystemUrl, { headers: authHeaders });
    assert.equal(reloadSettingsResponse.status, 200);
    const reloadedSettings = await reloadSettingsResponse.json();
    assert.equal(reloadedSettings.settings.name, 'Persisted system');
    assert.equal(reloadedSettings.settings.primary, '#123456');

    const unauthorizedResponse = await fetch(designSystemUrl, { headers: { 'x-workspace-token': 'invalid-token' } });
    assert.equal(unauthorizedResponse.status, 401, 'Design-system settings must remain workspace-authorized');

    const privateProviderResponse = await fetch(BASE_URL + '/api/ai/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'hello',
        apiKey: 'test-only-key',
        baseUrl: 'https://127.0.0.1:' + PORT,
        model: 'test-model'
      })
    });
    assert.equal(privateProviderResponse.status, 400,
      'AI proxy must reject private-network provider URLs before opening an outbound connection');
    assert.match((await privateProviderResponse.json()).message, /public IP addresses/i);

    let lastRateLimitStatus = 0;
    for (let index = 1; index <= 121; index++) {
      const response = await fetch(BASE_URL + '/api/health', {
        headers: { 'x-forwarded-for': '198.51.100.' + index + ', not-an-ip, 203.0.113.7' }
      });
      lastRateLimitStatus = response.status;
    }
    assert.equal(lastRateLimitStatus, 429,
      'Malformed forwarded chains must fall back safely instead of shifting the configured trusted-hop selection');
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
