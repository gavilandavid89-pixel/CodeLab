const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 3193;
const BASE_URL = 'http://127.0.0.1:' + PORT;

(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codelab-server-resilience-'));
  const sessionsDir = path.join(dataDir, 'sessions');
  await fs.mkdir(sessionsDir, { recursive: true });
  const staleSessionPaths = Array.from({ length: 201 }, (_, index) =>
    path.join(sessionsDir, 'expired-regression-' + String(index).padStart(3, '0') + '.json'));
  const unrelatedSessionTempPath = path.join(sessionsDir, '000-unrelated.tmp');
  for (const stalePath of staleSessionPaths) {
    await fs.writeFile(stalePath, JSON.stringify({ expiresAt: Date.now() - 1000 }));
  }
  await fs.writeFile(unrelatedSessionTempPath, 'keep this unrelated file');
  let server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      CODELAB_DATA_DIR: dataDir,
      CODELAB_WORKSPACE_SECRET: '   ',
      CODELAB_SESSION_CLEANUP_INTERVAL_MS: '3000',
      CODELAB_MAX_BODY_BYTES: '-1',
      CODELAB_MAX_PROJECTS: '-1',
      CODELAB_TRUSTED_PROXY_HOPS: '2',
      GITHUB_CLIENT_ID: 'test-github-client',
      GITHUB_CLIENT_SECRET: 'test-github-secret',
      GOOGLE_CLIENT_ID: 'test-google-client',
      GOOGLE_CLIENT_SECRET: 'test-google-secret',
      AI_API_KEY: 'test-only-server-ai-key',
      AI_BASE_URL: 'https://does-not-resolve.invalid'
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
    const expiredAfterStartup = (await fs.readdir(sessionsDir)).filter(file => file.endsWith('.json'));
    assert.equal(expiredAfterStartup.length, 1,
      'Startup cleanup should process one bounded batch of 200 expired sessions');
    const cleanupDeadline = Date.now() + 6000;
    let remainingExpiredSessions = expiredAfterStartup;
    while (remainingExpiredSessions.length && Date.now() < cleanupDeadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      remainingExpiredSessions = (await fs.readdir(sessionsDir)).filter(file => file.endsWith('.json'));
    }
    assert.equal(remainingExpiredSessions.length, 0,
      'Rotating cleanup batches must eventually reach expired sessions beyond the first 200 files');
    assert.equal(await fs.readFile(unrelatedSessionTempPath, 'utf8'), 'keep this unrelated file',
      'Session cleanup must ignore unrelated temporary files rather than deleting or stopping at them');
    const healthConfigResponse = await fetch(BASE_URL + '/api/health');
    const healthConfig = await healthConfigResponse.json();
    assert.equal(healthConfig.maxBodyBytes, 10 * 1024 * 1024,
      'Invalid body-size configuration must fall back to a safe default');
    assert.equal(healthConfig.maxProjects, 50,
      'Invalid project-count configuration must fall back to a safe default');

    const generatedSecretPath = path.join(dataDir, '.workspace-secret');
    const generatedSecret = await fs.readFile(generatedSecretPath, 'utf8');
    assert.match(generatedSecret, /^[a-f0-9]{64}$/,
      'Without an environment secret, the server must persist a cryptographically random workspace key');
    const generatedSecretStat = await fs.stat(generatedSecretPath);
    assert.equal(generatedSecretStat.mode & 0o077, 0,
      'Persisted workspace HMAC secret must not be readable by group or other users');

    const appAsset = await fetch(BASE_URL + '/app.js');
    assert.equal(appAsset.status, 200, 'Main client script should be served');
    assert.equal(appAsset.headers.get('cache-control'), 'no-cache',
      'Client JavaScript must revalidate after deployment instead of remaining stale for 24 hours');

    const traversalResponse = await fetch(BASE_URL + '/%252e%252e/server.js');
    assert.equal(traversalResponse.status, 404,
      'Encoded path traversal must not expose files outside the public asset directory');
    assert.doesNotMatch(await traversalResponse.text(), /createServer|SERVER_SECRET/,
      'Traversal response must not reveal server source');

    const privateSymlinkPath = path.join(process.cwd(), 'public', '.test-private-link-' + process.pid);
    try {
      await fs.symlink(path.join(process.cwd(), 'server.js'), privateSymlinkPath);
      const symlinkResponse = await fetch(BASE_URL + '/.test-private-link-' + process.pid);
      assert.equal(symlinkResponse.status, 404,
        'Static assets must not expose private files through a symlink inside public/');
      assert.doesNotMatch(await symlinkResponse.text(), /createServer|SERVER_SECRET/,
        'Symlink responses must not reveal server implementation details');
    } finally {
      await fs.rm(privateSymlinkPath, { force: true });
    }

    const response = await fetch(BASE_URL + '/api/auth/status', {
      headers: { Cookie: 'codelab_sid=%E0%A4%A' }
    });
    assert.equal(response.status, 200, 'Malformed cookie encoding must not cause an API 500');
    const status = await response.json();
    assert.equal(status.user, null, 'Malformed session cookie should be treated as unauthenticated');
    assert.equal(typeof status.demoFallback, 'boolean');

    const invalidSessionIdResponse = await fetch(BASE_URL + '/api/auth/status', {
      headers: { Cookie: 'codelab_sid=../../workspace-secret' }
    });
    assert.equal(invalidSessionIdResponse.status, 200,
      'A non-hex session ID must be rejected safely before filesystem lookup');
    assert.equal((await invalidSessionIdResponse.json()).user, null);

    const malformedLogoutResponse = await fetch(BASE_URL + '/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: 'codelab_sid=../../workspace-secret' }
    });
    assert.equal(malformedLogoutResponse.status, 200,
      'Logout must tolerate malformed session IDs without touching unrelated files');
    assert.match(malformedLogoutResponse.headers.get('set-cookie') || '', /Max-Age=0/,
      'Logout must clear the browser session cookie even when its value is malformed');

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

    // Anonymous workspaces must not be able to claim a deterministic ID that
    // will later belong to a GitHub/Google OAuth user.
    for (const provider of ['github', 'google']) {
      const reservedWorkspaceResponse = await fetch(BASE_URL + '/api/workspace/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'ws_' + provider + '_123456789' })
      });
      assert.equal(reservedWorkspaceResponse.status, 400,
        'Anonymous initialization must reject reserved ' + provider + ' user-workspace IDs');
      assert.equal((await reservedWorkspaceResponse.json()).error, 'reserved_workspace_id');
    }

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
    const duplicateProjectIdsResponse = await fetch(BASE_URL + '/api/workspace/' + encodeURIComponent(workspace.workspaceId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspace.token },
      body: JSON.stringify({
        baseRevision: 0,
        projects: [
          { id: 'same-id', name: 'First', code: {} },
          { id: 'same-id', name: 'Second', code: {} }
        ]
      })
    });
    assert.equal(duplicateProjectIdsResponse.status, 400,
      'A workspace update must not persist multiple projects with the same identity');
    assert.equal((await duplicateProjectIdsResponse.json()).detail, 'duplicate_project_id');

    async function submitDesignValidationProject(design) {
      return fetch(BASE_URL + '/api/workspace/' + encodeURIComponent(workspace.workspaceId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-workspace-token': workspace.token },
        body: JSON.stringify({
          baseRevision: 0,
          projects: [{ id: 'design-validation', name: 'Design validation', code: {}, type: 'design', design }]
        })
      });
    }
    const arrayValuedDesignResponse = await submitDesignValidationProject([]);
    assert.equal(arrayValuedDesignResponse.status, 400);
    assert.equal((await arrayValuedDesignResponse.json()).detail, 'invalid_project_design');
    const malformedDesignResponse = await submitDesignValidationProject({ elements: 'not-an-array' });
    assert.equal(malformedDesignResponse.status, 400);
    assert.equal((await malformedDesignResponse.json()).detail, 'invalid_design_elements');
    const duplicateDesignElementResponse = await submitDesignValidationProject({
      elements: [{ id: 'same-layer', type: 'heading' }, { id: 'same-layer', type: 'text' }]
    });
    assert.equal(duplicateDesignElementResponse.status, 400);
    assert.equal((await duplicateDesignElementResponse.json()).detail, 'duplicate_design_element_id');
    const tooManyDesignElementsResponse = await submitDesignValidationProject({
      elements: Array.from({ length: 501 }, (_, index) => ({ id: 'layer-' + index, type: 'heading' }))
    });
    assert.equal(tooManyDesignElementsResponse.status, 400);
    assert.equal((await tooManyDesignElementsResponse.json()).detail, 'too_many_design_elements');

    const corruptInitResponse = await fetch(BASE_URL + '/api/workspace/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'corrupt-state-regression' })
    });
    assert.equal(corruptInitResponse.status, 200);
    const corruptWorkspace = await corruptInitResponse.json();
    const corruptStatePath = path.join(dataDir, 'workspaces', corruptWorkspace.workspaceId + '.json');
    await fs.writeFile(corruptStatePath, '{"truncated":', { mode: 0o600 });
    const corruptStateResponse = await fetch(BASE_URL + '/api/workspace/' + encodeURIComponent(corruptWorkspace.workspaceId), {
      headers: { 'x-workspace-token': corruptWorkspace.token }
    });
    assert.equal(corruptStateResponse.status, 500,
      'Corrupt persisted workspace JSON should return a controlled server error');
    assert.equal((await corruptStateResponse.json()).error, 'workspace_corrupt');
    const corruptInitRetryResponse = await fetch(BASE_URL + '/api/workspace/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-workspace-token': corruptWorkspace.token },
      body: JSON.stringify({ id: corruptWorkspace.workspaceId })
    });
    assert.equal(corruptInitRetryResponse.status, 500,
      'Workspace initialization must report the same controlled corruption error as workspace reads');
    assert.equal((await corruptInitRetryResponse.json()).error, 'workspace_corrupt');
    await fs.rm(corruptStatePath, { force: true });

    const invalidShapeInitResponse = await fetch(BASE_URL + '/api/workspace/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'invalid-shape-state-regression' })
    });
    assert.equal(invalidShapeInitResponse.status, 200);
    const invalidShapeWorkspace = await invalidShapeInitResponse.json();
    const invalidShapePath = path.join(dataDir, 'workspaces', invalidShapeWorkspace.workspaceId + '.json');
    await fs.writeFile(invalidShapePath, JSON.stringify({ revision: 0, projects: null }), { mode: 0o600 });
    const invalidShapeResponse = await fetch(BASE_URL + '/api/workspace/' + encodeURIComponent(invalidShapeWorkspace.workspaceId), {
      headers: { 'x-workspace-token': invalidShapeWorkspace.token }
    });
    assert.equal(invalidShapeResponse.status, 500,
      'Structurally invalid but parseable workspace state must not silently become an empty project list');
    assert.equal((await invalidShapeResponse.json()).error, 'workspace_corrupt');
    await fs.rm(invalidShapePath, { force: true });

    const invalidProjectInitResponse = await fetch(BASE_URL + '/api/workspace/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'invalid-project-state-regression' })
    });
    assert.equal(invalidProjectInitResponse.status, 200);
    const invalidProjectWorkspace = await invalidProjectInitResponse.json();
    const invalidProjectStatePath = path.join(dataDir, 'workspaces', invalidProjectWorkspace.workspaceId + '.json');
    await fs.writeFile(invalidProjectStatePath, JSON.stringify({
      revision: 0,
      projects: [{ id: 'broken-project', name: 'Broken project', code: [] }]
    }), { mode: 0o600 });
    const invalidProjectStateResponse = await fetch(BASE_URL + '/api/workspace/' + encodeURIComponent(invalidProjectWorkspace.workspaceId), {
      headers: { 'x-workspace-token': invalidProjectWorkspace.token }
    });
    assert.equal(invalidProjectStateResponse.status, 500,
      'Parseable persisted state with invalid project records must not reach the editor');
    assert.equal((await invalidProjectStateResponse.json()).error, 'workspace_corrupt');
    await fs.rm(invalidProjectStatePath, { force: true });

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

    const documentationIpv6Response = await fetch(BASE_URL + '/api/ai/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'hello',
        apiKey: 'test-only-key',
        baseUrl: 'https://[3fff::1]',
        model: 'test-model'
      })
    });
    assert.equal(documentationIpv6Response.status, 400,
      'AI proxy must reject reserved/documentation IPv6 ranges before connecting');
    assert.match((await documentationIpv6Response.json()).message, /public IP addresses/i);

    let lastRateLimitStatus = 0;
    for (let index = 1; index <= 121; index++) {
      const response = await fetch(BASE_URL + '/api/health', {
        headers: { 'x-forwarded-for': '198.51.100.' + index + ', not-an-ip, 203.0.113.7' }
      });
      lastRateLimitStatus = response.status;
    }
    assert.equal(lastRateLimitStatus, 429,
      'Malformed forwarded chains must fall back safely instead of shifting the configured trusted-hop selection');

    // Restart against the same data directory without an environment secret:
    // the generated HMAC key must remain stable and existing workspace tokens
    // and persisted design-system settings must continue to work.
    await new Promise(resolve => {
      if (server.exitCode !== null) return resolve();
      server.once('exit', resolve);
      server.kill('SIGTERM');
    });
    server = spawn(process.execPath, ['server.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(PORT),
        CODELAB_DATA_DIR: dataDir,
        CODELAB_WORKSPACE_SECRET: '   ',
        CODELAB_TRUSTED_PROXY_HOPS: '2',
        GITHUB_CLIENT_ID: 'test-github-client',
        GITHUB_CLIENT_SECRET: 'test-github-secret',
        GOOGLE_CLIENT_ID: 'test-google-client',
        GOOGLE_CLIENT_SECRET: 'test-google-secret',
        AI_API_KEY: 'test-only-server-ai-key',
        AI_BASE_URL: 'https://does-not-resolve.invalid'
      },
      stdio: 'ignore'
    });
    healthy = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (server.exitCode !== null) throw new Error('Restarted server exited before becoming healthy.');
      try {
        const response = await fetch(BASE_URL + '/api/health');
        if (response.ok) { healthy = true; break; }
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(healthy, true, 'Server should restart using the persisted workspace secret');
    assert.equal(await fs.readFile(generatedSecretPath, 'utf8'), generatedSecret,
      'Restart must not rotate the generated workspace secret');
    const reloadedWorkspaceResponse = await fetch(BASE_URL + '/api/workspace/' + encodeURIComponent(workspace.workspaceId), {
      headers: { 'x-workspace-token': workspace.token }
    });
    assert.equal(reloadedWorkspaceResponse.status, 200,
      'A workspace token created before restart must remain valid with the persisted secret');
    const reloadedWorkspace = await reloadedWorkspaceResponse.json();
    assert.equal(reloadedWorkspace.revision, 0);
    const reloadedDesignSystemResponse = await fetch(designSystemUrl, { headers: authHeaders });
    assert.equal(reloadedDesignSystemResponse.status, 200);
    assert.equal((await reloadedDesignSystemResponse.json()).settings.name, 'Persisted system',
      'Design-system settings must survive a server restart');
    console.log('Server resilience passed: request validation, session safety, workspace ownership/persistence, secret stability, SSRF protection and rate limiting.');
  } finally {
    server.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 100));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
