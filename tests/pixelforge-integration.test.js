const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');

const base = process.env.CODELAB_E2E_BASE_URL || 'http://127.0.0.1:3188';

function makePixelProject(id, name, width = 2, height = 2) {
  const layerId = 'layer-' + id;
  return {
    format: 'pixelforge-project', version: 1, id, name, width, height,
    activeLayerId: layerId, revision: 0, saveVersion: 0,
    layers: [{
      id: layerId, name: 'Layer 1', visible: true, opacity: 1, locked: false,
      pixels: Buffer.alloc(width * height * 4).toString('base64')
    }]
  };
}

async function main() {
  const dashboardResponse = await fetch(base + '/');
  assert.equal(dashboardResponse.status, 200, 'CodeLab dashboard should be served');
  const dashboard = await dashboardResponse.text();
  assert.doesNotMatch(dashboard, /id="studioChooser"/, 'PixelForge should not appear as a separate top-level studio');
  const designPanelStart = dashboard.indexOf('id="designStudioPanel"');
  const pixelForgeEntry = dashboard.indexOf('id="openPixelForgeFromDesign"');
  const designCanvas = dashboard.indexOf('id="designCanvas"');
  assert.ok(designPanelStart >= 0 && pixelForgeEntry > designPanelStart && pixelForgeEntry < designCanvas,
    'PixelForge should be a direct entry inside CodeLab Design, not a separate dashboard destination');
  assert.ok(dashboard.indexOf('src="/studio-core.js"') < dashboard.indexOf('src="/app.js"'), 'CodeLab dashboard must load the shared runtime before its app');
  assert.match(dashboard, /Crear proyecto/, 'existing project creation should remain available');

  const sharedCoreResponse = await fetch(base + '/studio-core.js');
  assert.equal(sharedCoreResponse.status, 200, 'the shared CodeLab studio runtime should be served');
  const sharedCore = await sharedCoreResponse.text();
  assert.match(sharedCore, /getCodeLabSession/, 'shared runtime should own session resolution');
  assert.match(sharedCore, /codeLabRequest/, 'shared runtime should own API request semantics');

  const pageResponse = await fetch(base + '/pixelforge/index.html');
  assert.equal(pageResponse.status, 200, 'PixelForge entry route should serve its own editor page');
  const page = await pageResponse.text();
  assert.match(page, /id="canvas"/, 'PixelForge artwork canvas should be present');
  assert.match(page, /src="\.\/src\/editor\.js"/, 'PixelForge should load its editor module');
  assert.ok(page.indexOf('src="/studio-core.js"') < page.indexOf('src="./src/editor.js"'), 'PixelForge must load the same shared runtime before its editor');
  assert.match(page, /href="\/"[^>]*CodeLab dashboard|href="\/" title="Back to CodeLab dashboard"/, 'PixelForge should provide a return path to CodeLab');

  for (const path of [
    '/pixelforge/styles.css',
    '/pixelforge/src/editor.js',
    '/pixelforge/src/core.js',
    '/pixelforge/src/persistence.js',
    '/pixelforge/src/workspaces.js',
    '/pixelforge/src/ai-tools.js',
    '/pixelforge/src/ai-provider.js',
    '/pixelforge/src/image-import.js',
    '/pixelforge/src/asset-export.js',
    '/pixelforge/src/headless.js',
    '/pixelforge/src/headless-vision.js',
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path + ' should be served');
    assert.ok((await response.text()).length > 0, path + ' should not be empty');
  }
  const pixelForgeHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'pixelforge', 'index.html'), 'utf8');
  assert.match(pixelForgeHtml, /Projects autosave to your CodeLab account/,
    'the studio should describe account-backed persistence, not local-only autosave');
  assert.doesNotMatch(pixelForgeHtml, /Projects autosave locally/,
    'the UI must not imply that local-only storage is the production source of truth');
  const anonymousResponse = await fetch(base + '/api/pixelforge/projects', { headers: { 'x-forwarded-for': '198.51.100.77' } });
  assert.equal(anonymousResponse.status, 401, 'PixelForge project API must require a CodeLab account');
  const anonymousBody = await anonymousResponse.json();
  assert.equal(anonymousBody.error, 'not_authenticated', 'anonymous access should have a clear auth error');

  const malformedProjectIdResponse = await fetch(base + '/api/pixelforge/projects/%E0%A4%A', {
    headers: { 'x-forwarded-for': '198.51.100.78' }
  });
  assert.equal(malformedProjectIdResponse.status, 401, 'authentication must be checked before parsing project IDs');

  // Build a test-only session in the isolated E2E data directory, using the
  // same on-disk session contract as CodeLab's real login flow.
  const dataDir = process.env.CODELAB_DATA_DIR || path.join(__dirname, '..', 'data');
  const sessionId = 'a'.repeat(48);
  const sessionsDir = path.join(dataDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, sessionId + '.json'), JSON.stringify({
    id: sessionId,
    user: { id: 'pixelforge-integration-user', provider: 'github', name: 'PIXELFORGE_TEST', role: 'user' },
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000
  }), { mode: 0o600 });
  const authHeaders = { cookie: 'codelab_sid=' + sessionId, 'x-forwarded-for': '198.51.100.79' };
  const authenticatedMalformedId = await fetch(base + '/api/pixelforge/projects/%E0%A4%A', { headers: authHeaders });
  assert.equal(authenticatedMalformedId.status, 400, 'malformed encoded project IDs should return a client error, not crash the API');
  assert.equal((await authenticatedMalformedId.json()).error, 'invalid_project_id', 'malformed project ID should have a stable error code');
  const coreWorkspaceResponse = await fetch(base + '/api/workspace/init', {
    method: 'POST',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(coreWorkspaceResponse.status, 200, 'PixelForge must use the same authenticated CodeLab workspace identity');
  const coreWorkspace = await coreWorkspaceResponse.json();
  assert.equal(coreWorkspace.workspaceId, 'ws_github_pixelforge-integration-user', 'PixelForge account identity should match CodeLab workspace identity');
  const workspaceFile = path.join(dataDir, 'workspaces', coreWorkspace.workspaceId + '.json');
  assert.ok(fs.existsSync(workspaceFile), 'CodeLab core should own the account workspace used by PixelForge');
  const pixelForgeStoreFile = workspaceFile + '.pixelforge.json';
  // The database may persist between CI runs; clear only this dedicated test
  // account so the assertions remain repeatable without touching real users.
  const priorProjects = await (await fetch(base + '/api/pixelforge/projects', { headers: authHeaders })).json();
  for (const project of priorProjects.projects || []) {
    await fetch(base + '/api/pixelforge/projects/' + encodeURIComponent(project.id), {
      method: 'DELETE', headers: authHeaders
    });
  }
  const health = await (await fetch(base + '/api/health')).json();
  assert.ok(['postgresql', 'server-file'].includes(health.persistence), 'CodeLab should report its active persistence backend');
  const listBefore = await fetch(base + '/api/pixelforge/projects', { headers: authHeaders });
  assert.equal(listBefore.status, 200, 'authenticated CodeLab users should list their PixelForge projects');
  assert.deepEqual((await listBefore.json()).projects, [], 'new account should start with an empty PixelForge project list');

  const fixture = { ...makePixelProject('integration-artwork', 'Account integration artwork'), revision: 2, saveVersion: 2 };
  const saved = await fetch(base + '/api/pixelforge/projects', {
    method: 'PUT',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ project: fixture })
  });
  assert.equal(saved.status, 201, 'first save should create a project in the account');
  fixture.serverRevision = (await saved.json()).project.serverRevision;
  assert.equal(fixture.serverRevision, 1, 'the server should issue the first durable revision token');
  const staleWrite = await fetch(base + '/api/pixelforge/projects', {
    method: 'PUT',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ project: { ...fixture, name: 'Stale session overwrite', revision: 1, saveVersion: 1, serverRevision: 0 } })
  });
  assert.equal(staleWrite.status, 409, 'a stale session must not overwrite a newer saved revision');
  assert.equal((await staleWrite.json()).error, 'pixelforge_revision_conflict',
    'stale project writes should return a stable revision-conflict error');
  const sameRevisionFork = await fetch(base + '/api/pixelforge/projects', {
    method: 'PUT',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ project: { ...fixture, name: 'Concurrent fork with same local revision', revision: fixture.revision, saveVersion: fixture.saveVersion, serverRevision: 0 } })
  });
  assert.equal(sameRevisionFork.status, 409,
    'two divergent sessions with the same local edit revision must still conflict through serverRevision');
  const currentRevisionSave = await fetch(base + '/api/pixelforge/projects', {
    method: 'PUT',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ project: fixture })
  });
  assert.equal(currentRevisionSave.status, 200, 'the current revision token should permit a legitimate subsequent save');
  fixture.serverRevision = (await currentRevisionSave.json()).project.serverRevision;
  assert.equal(fixture.serverRevision, 2, 'a successful update should advance the server revision token');
  if (health.persistence === 'postgresql') {
    assert.equal(fs.existsSync(pixelForgeStoreFile), false, 'PostgreSQL-backed PixelForge projects must not be duplicated in workspace sidecar files');
  } else {
    assert.ok(fs.existsSync(pixelForgeStoreFile), 'file fallback should stay bound to the same CodeLab workspace identity when PostgreSQL is unavailable');
  }
  const malformed = await fetch(base + '/api/pixelforge/projects', {
    method: 'PUT',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ project: { ...fixture, id: 'invalid-artwork', layers: [] } })
  });
  assert.equal(malformed.status, 400, 'the server must reject malformed PixelForge project structures');
  assert.equal((await malformed.json()).error, 'invalid_pixelforge_project');
  const invalidServerRevision = await fetch(base + '/api/pixelforge/projects', {
    method: 'PUT',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ project: { ...fixture, id: 'invalid-server-revision', serverRevision: -1 } })
  });
  assert.equal(invalidServerRevision.status, 400, 'server revision tokens must be non-negative integers');
  assert.equal((await invalidServerRevision.json()).error, 'invalid_pixelforge_project');
  const invalidRasterPaddingProject = { ...fixture, id: 'invalid-raster-padding', layers: fixture.layers.map(layer => ({
    ...layer, pixels: layer.pixels.slice(0, -2) + 'AA'
  })) };
  const invalidRasterPadding = await fetch(base + '/api/pixelforge/projects', {
    method: 'PUT',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ project: invalidRasterPaddingProject })
  });
  assert.equal(invalidRasterPadding.status, 400, 'raster Base64 with noncanonical padding must be rejected');
  assert.equal((await invalidRasterPadding.json()).error, 'invalid_pixelforge_project');

  // The server is the authoritative animation validator; browser-side checks are not a trust boundary.
  const animationProject = makePixelProject('animation-validation', 'Animation validation artwork');
  const animationLayerId = animationProject.layers[0].id;
  animationProject.animation = {
    format: 'pixelforge-animation', version: 1, width: 2, height: 2,
    layerIds: [animationLayerId], fps: 12, activeFrameIndex: 0,
    frames: [{ id: 'frame-1', durationMs: 83.333, cels: [{ layerId: animationLayerId, pixels: Buffer.alloc(16).toString('base64') }] }]
  };
  const animationSaved = await fetch(base + '/api/pixelforge/projects', {
    method: 'PUT', headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ project: animationProject })
  });
  assert.equal(animationSaved.status, 201, 'a structurally valid multi-layer timeline should pass server validation');
  const animationRevision = (await animationSaved.json()).project.serverRevision;
  const animationLoaded = await fetch(base + '/api/pixelforge/projects/' + animationProject.id, { headers: authHeaders });
  assert.deepEqual((await animationLoaded.json()).project.animation, animationProject.animation,
    'animation metadata and cel pixels should round-trip through durable project storage');
  const invalidAnimationCases = [
    { ...animationProject, id: 'animation-invalid-fps', animation: { ...animationProject.animation, fps: 0 } },
    { ...animationProject, id: 'animation-invalid-dimensions', animation: { ...animationProject.animation, width: 3 } },
    { ...animationProject, id: 'animation-invalid-layer-map', animation: { ...animationProject.animation, layerIds: ['unknown-layer'] } },
    { ...animationProject, id: 'animation-missing-cel', animation: { ...animationProject.animation, frames: [{ ...animationProject.animation.frames[0], cels: [] }] } },
    { ...animationProject, id: 'animation-invalid-duration', animation: { ...animationProject.animation, frames: [{ ...animationProject.animation.frames[0], durationMs: 10001 }] } },
    { ...animationProject, id: 'animation-invalid-padding', animation: { ...animationProject.animation, frames: [{ ...animationProject.animation.frames[0], cels: [{ ...animationProject.animation.frames[0].cels[0], pixels: animationProject.animation.frames[0].cels[0].pixels.slice(0, -2) + 'AA' }] }] } },
    { ...animationProject, id: 'animation-too-many-frames', animation: { ...animationProject.animation, frames: Array.from({ length: 241 }, (_, index) => ({ id: 'frame-' + index, durationMs: 83, cels: [] })) } }
  ];
  for (const invalidProject of invalidAnimationCases) {
    const response = await fetch(base + '/api/pixelforge/projects', {
      method: 'PUT', headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ project: invalidProject })
    });
    assert.equal(response.status, 400, invalidProject.id + ' must be rejected by the server');
    assert.equal((await response.json()).error, 'invalid_pixelforge_animation',
      invalidProject.id + ' should return the stable animation validation error');
  }
  await fetch(base + '/api/pixelforge/projects/' + animationProject.id, { method: 'DELETE', headers: authHeaders });
  assert.ok(Number.isInteger(animationRevision) && animationRevision === 1, 'the animation project should receive a server revision token');

    // Chunk transport is intentionally PostgreSQL-backed; local file-mode E2E skips these routes.
  if (process.env.DATABASE_URL) {
// The upload protocol must be resumable, integrity checked, and idempotent.
  const baseChunkFixture = makePixelProject('chunk-api-contract', 'Chunk API contract', 1200, 1200);
  const { layers: chunkLayers, ...chunkMetadata } = baseChunkFixture;
  const chunkSize = 6 * 1024 * 1024;
  const transferPrefix = JSON.stringify({ ...chunkMetadata, serverRevision: 1, transferMarker: '' }).slice(0, -2);
  const transferPrefixBytes = Buffer.byteLength(transferPrefix, 'utf8');
  const transferMarkerPadding = chunkSize - transferPrefixBytes - 1;
  assert.ok(transferMarkerPadding > 0, 'the UTF-8 boundary fixture must fit before the first chunk boundary');
  const chunkFixture = {
    ...chunkMetadata, serverRevision: 1,
    transferMarker: 'x'.repeat(transferMarkerPadding) + '💡',
    layers: chunkLayers
  };
  const chunkSerialized = JSON.stringify(chunkFixture);
  const chunkBytes = Buffer.from(chunkSerialized, 'utf8');
  const malformedUploadManifest = await fetch(base + '/api/pixelforge/projects/uploads', {
    method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: '{'
  });
  assert.equal(malformedUploadManifest.status, 400, 'malformed upload JSON should be a client error, not a server outage');
  assert.equal((await malformedUploadManifest.json()).error, 'INVALID_JSON');
  const uploadId = 'a'.repeat(32);
  const totalChunks = Math.ceil(chunkBytes.length / chunkSize);
  assert.equal(totalChunks, 3, 'the integration fixture must exercise multiple chunks and a split UTF-8 character');
  const uploadBegin = await fetch(base + '/api/pixelforge/projects/uploads', {
    method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({
      uploadId, projectId: chunkFixture.id, expectedServerRevision: 0,
      totalBytes: chunkBytes.length, totalChunks
    })
  });
  assert.equal(uploadBegin.status, 201, 'authenticated project chunk uploads should be initialized');
  const incompleteCommit = await fetch(base + '/api/pixelforge/projects/uploads/' + uploadId + '/commit', {
    method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(incompleteCommit.status, 409, 'commit must not publish a project while chunks are missing');
  assert.equal((await incompleteCommit.json()).error, 'pixelforge_upload_incomplete');
  const chunks = Array.from({ length: totalChunks }, (_, index) => chunkBytes.subarray(index * chunkSize, (index + 1) * chunkSize));
  const firstChunk = chunks[0];
  const firstChunkHash = crypto.createHash('sha256').update(firstChunk).digest('hex');
  const badChunk = await fetch(base + '/api/pixelforge/projects/uploads/' + uploadId + '/0', {
    method: 'PUT', headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ chunk: firstChunk.toString('base64'), sha256: '0'.repeat(64) })
  });
  assert.equal(badChunk.status, 400, 'a chunk with a mismatched SHA-256 must be rejected');
  assert.equal((await badChunk.json()).error, 'pixelforge_chunk_integrity_failed');
  const goodChunk = await fetch(base + '/api/pixelforge/projects/uploads/' + uploadId + '/0', {
    method: 'PUT', headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ chunk: firstChunk.toString('base64'), sha256: firstChunkHash })
  });
  assert.equal(goodChunk.status, 200, 'a verified chunk should be accepted');
  const uploadStatus = await fetch(base + '/api/pixelforge/projects/uploads/' + uploadId, { headers: authHeaders });
  assert.equal(uploadStatus.status, 200, 'owners should be able to inspect upload progress');
  assert.deepEqual((await uploadStatus.json()).receivedChunks, [0], 'upload status should report only chunks already persisted');
  const duplicateChunk = await fetch(base + '/api/pixelforge/projects/uploads/' + uploadId + '/0', {
    method: 'PUT', headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ chunk: firstChunk.toString('base64'), sha256: firstChunkHash })
  });
  assert.equal(duplicateChunk.status, 200, 'retrying the same verified chunk must be idempotent');
  for (let index = 1; index < chunks.length; index++) {
    const bytes = chunks[index];
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const uploaded = await fetch(base + '/api/pixelforge/projects/uploads/' + uploadId + '/' + index, {
      method: 'PUT', headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ chunk: bytes.toString('base64'), sha256: hash })
    });
    assert.equal(uploaded.status, 200, 'each remaining chunk should be accepted with its exact byte length');
  }
  const completeStatus = await fetch(base + '/api/pixelforge/projects/uploads/' + uploadId, { headers: authHeaders });
  assert.deepEqual((await completeStatus.json()).receivedChunks, [0, 1, 2], 'status should report the complete chunk manifest');
  const chunkCommit = await fetch(base + '/api/pixelforge/projects/uploads/' + uploadId + '/commit', {
    method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(chunkCommit.status, 201, 'complete verified uploads should atomically publish the project');
  const chunkReceipt = (await chunkCommit.json()).project;
  assert.equal(chunkReceipt.serverRevision, 1);
  const repeatedCommit = await fetch(base + '/api/pixelforge/projects/uploads/' + uploadId + '/commit', {
    method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(repeatedCommit.status, 200, 'retrying a completed commit must return its saved receipt');
  assert.deepEqual((await (await fetch(base + '/api/pixelforge/projects/' + chunkFixture.id, { headers: authHeaders })).json()).project, chunkFixture,
    'the committed chunked project must round-trip without altering its JSON payload');
  const committedStatus = await fetch(base + '/api/pixelforge/projects/uploads/' + uploadId, { headers: authHeaders });
  assert.equal((await committedStatus.json()).committed, true, 'status should expose a durable receipt after commit');
  const cancelledUploadId = 'b'.repeat(32);
  const cancelBegin = await fetch(base + '/api/pixelforge/projects/uploads', {
    method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ uploadId: cancelledUploadId, projectId: 'cancelled-chunk-project', expectedServerRevision: 0, totalBytes: 4, totalChunks: 1 })
  });
  assert.equal(cancelBegin.status, 201);
  const cancelled = await fetch(base + '/api/pixelforge/projects/uploads/' + cancelledUploadId, {
    method: 'DELETE', headers: authHeaders
  });
  assert.equal(cancelled.status, 200, 'abandoned uploads should be cancellable to release staged quota');
  const cancelledChunk = await fetch(base + '/api/pixelforge/projects/uploads/' + cancelledUploadId + '/0', {
    method: 'PUT', headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ chunk: Buffer.from('test').toString('base64'), sha256: crypto.createHash('sha256').update('test').digest('hex') })
  });
  assert.equal(cancelledChunk.status, 404, 'cancelled uploads must no longer accept chunks');
  const invalidUtf8Id = 'e'.repeat(32);
  const invalidUtf8Bytes = Buffer.from([0xc3, 0x28, 0x7b, 0x7d]);
  const invalidUtf8Begin = await fetch(base + '/api/pixelforge/projects/uploads', {
    method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ uploadId: invalidUtf8Id, projectId: 'invalid-utf8-project', expectedServerRevision: 0, totalBytes: invalidUtf8Bytes.length, totalChunks: 1 })
  });
  assert.equal(invalidUtf8Begin.status, 201);
  const invalidUtf8Chunk = await fetch(base + '/api/pixelforge/projects/uploads/' + invalidUtf8Id + '/0', {
    method: 'PUT', headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ chunk: invalidUtf8Bytes.toString('base64'), sha256: crypto.createHash('sha256').update(invalidUtf8Bytes).digest('hex') })
  });
  assert.equal(invalidUtf8Chunk.status, 200);
  const invalidUtf8Commit = await fetch(base + '/api/pixelforge/projects/uploads/' + invalidUtf8Id + '/commit', {
    method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(invalidUtf8Commit.status, 400, 'invalid UTF-8 must be rejected before JSON parsing or persistence');
  assert.equal((await invalidUtf8Commit.json()).error, 'invalid_pixelforge_upload_encoding');
  await fetch(base + '/api/pixelforge/projects/uploads/' + invalidUtf8Id, { method: 'DELETE', headers: authHeaders });
  await fetch(base + '/api/pixelforge/projects/' + chunkFixture.id, { method: 'DELETE', headers: authHeaders });
  }

  const listed = await fetch(base + '/api/pixelforge/projects', { headers: authHeaders });
  assert.equal((await listed.json()).projects[0].name, fixture.name, 'account list should expose saved project metadata');

  // A fresh session for the same provider/account must resolve the same workspace,
  // matching the cross-device behavior of CodeLab's deterministic account binding.
  const sameAccountSessionId = 'c'.repeat(48);
  fs.writeFileSync(path.join(sessionsDir, sameAccountSessionId + '.json'), JSON.stringify({
    id: sameAccountSessionId,
    user: { id: 'pixelforge-integration-user', provider: 'github', name: 'PIXELFORGE_TEST_NEW_SESSION', role: 'user' },
    createdAt: Date.now(), expiresAt: Date.now() + 60_000
  }), { mode: 0o600 });
  const sameAccountHeaders = { cookie: 'codelab_sid=' + sameAccountSessionId, 'x-forwarded-for': '198.51.100.82' };
  const sameAccountList = await fetch(base + '/api/pixelforge/projects', { headers: sameAccountHeaders });
  assert.equal(sameAccountList.status, 200);
  assert.ok((await sameAccountList.json()).projects.some(project => project.id === fixture.id),
    'a new session for the same CodeLab account must see its saved PixelForge projects');

  const secondSessionId = 'b'.repeat(48);
  fs.writeFileSync(path.join(sessionsDir, secondSessionId + '.json'), JSON.stringify({
    id: secondSessionId,
    user: { id: 'pixelforge-other-user', provider: 'google', name: 'PIXELFORGE_OTHER', role: 'user' },
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000
  }), { mode: 0o600 });
  const otherHeaders = { cookie: 'codelab_sid=' + secondSessionId, 'x-forwarded-for': '198.51.100.80' };
  if (process.env.DATABASE_URL) {
  const ownerUploadId = 'd'.repeat(32);
  const ownerUpload = await fetch(base + '/api/pixelforge/projects/uploads', {
    method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ uploadId: ownerUploadId, projectId: 'private-staged-project', expectedServerRevision: 0, totalBytes: 4, totalChunks: 1 })
  });
  assert.equal(ownerUpload.status, 201);
  assert.equal((await fetch(base + '/api/pixelforge/projects/uploads/' + ownerUploadId, { headers: otherHeaders })).status, 404,
    'another account must not inspect a staged upload');
  assert.equal((await fetch(base + '/api/pixelforge/projects/uploads/' + ownerUploadId + '/0', {
    method: 'PUT', headers: { ...otherHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ chunk: Buffer.from('test').toString('base64'), sha256: crypto.createHash('sha256').update('test').digest('hex') })
  })).status, 404, 'another account must not upload chunks into a staged project');
  const deniedCancel = await fetch(base + '/api/pixelforge/projects/uploads/' + ownerUploadId, { method: 'DELETE', headers: otherHeaders });
  assert.equal(deniedCancel.status, 200);
  assert.equal((await deniedCancel.json()).cancelled, false, 'another account must not cancel a staged upload');
  assert.equal((await fetch(base + '/api/pixelforge/projects/uploads/' + ownerUploadId, { headers: authHeaders })).status, 200,
    'a denied cross-account cancellation must leave the owner upload intact');
  await fetch(base + '/api/pixelforge/projects/uploads/' + ownerUploadId, { method: 'DELETE', headers: authHeaders });
  }
  const otherList = await fetch(base + '/api/pixelforge/projects', { headers: otherHeaders });
  assert.deepEqual((await otherList.json()).projects, [], 'a different CodeLab account must not see another account\'s PixelForge projects');
  assert.equal((await fetch(base + '/api/pixelforge/projects/' + fixture.id, { headers: otherHeaders })).status, 404, 'a different account must not open another account\'s project');
  const crossAccountDelete = await fetch(base + '/api/pixelforge/projects/' + fixture.id, {
    method: 'DELETE', headers: otherHeaders
  });
  assert.equal(crossAccountDelete.status, 404, 'a different account must not delete another account\'s project');
  assert.equal((await fetch(base + '/api/pixelforge/projects/' + fixture.id, { headers: authHeaders })).status, 200,
    'a denied cross-account deletion must leave the owner\'s project intact');

  const concurrentProjects = Array.from({ length: 6 }, (_, index) =>
    makePixelProject('parallel-artwork-' + index, 'Parallel artwork ' + index));
  const concurrentSaves = await Promise.all(concurrentProjects.map(project => fetch(base + '/api/pixelforge/projects', {
    method: 'PUT',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ project })
  })));
  assert.ok(concurrentSaves.every(response => response.status === 201), 'concurrent project creations should all succeed without overwriting each other');
  const afterConcurrentSaves = await (await fetch(base + '/api/pixelforge/projects', { headers: authHeaders })).json();
  for (const project of concurrentProjects) {
    assert.ok(afterConcurrentSaves.projects.some(item => item.id === project.id), 'concurrent write should preserve ' + project.id);
  }
  await Promise.all(concurrentProjects.map(project => fetch(base + '/api/pixelforge/projects/' + project.id, {
    method: 'DELETE', headers: authHeaders
  })));

  const recencyBefore = (await (await fetch(base + '/api/pixelforge/projects', { headers: authHeaders })).json())
    .projects.find(project => project.id === fixture.id);
  assert.ok(recencyBefore, 'saved project metadata should be available before opening the project');
  const loaded = await fetch(base + '/api/pixelforge/projects/' + fixture.id, { headers: authHeaders });
  assert.deepEqual((await loaded.json()).project, fixture, 'saved project should round-trip through account storage');
  const recencyAfter = (await (await fetch(base + '/api/pixelforge/projects', { headers: authHeaders })).json())
    .projects.find(project => project.id === fixture.id);
  assert.ok(recencyAfter.lastOpenedAt > recencyBefore.lastOpenedAt,
    'opening a saved project should update its recent-project timestamp in persistent storage');
  const deleted = await fetch(base + '/api/pixelforge/projects/' + fixture.id, { method: 'DELETE', headers: authHeaders });
  assert.equal(deleted.status, 200, 'account owner should be able to delete their own project');
  assert.equal((await fetch(base + '/api/pixelforge/projects/' + fixture.id, { headers: authHeaders })).status, 404, 'deleted project should no longer be available');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': '198.51.100.78' } }));
    const page = await context.newPage();
    const anonymousPageErrors = [];
    page.on('pageerror', error => anonymousPageErrors.push(error.message));
    const anonymousAuthResponse = await page.request.get(base + '/api/auth/status');
    const anonymousAuth = await anonymousAuthResponse.json();
    assert.equal(anonymousAuth.user, null, 'the anonymous browser context must not inherit an account session');
    await page.goto(base + '/pixelforge/index.html', { waitUntil: 'networkidle' });
    try {
      await page.waitForFunction(() => document.body.innerText.includes('Inicia sesión en CodeLab'), null, { timeout: 10000 });
    } catch (error) {
      const diagnostics = await page.evaluate(() => ({
        bodyText: document.body.innerText.slice(0, 1200),
        status: document.querySelector('#status')?.textContent || null,
        sharedRuntimeAvailable: Boolean(window.CodeLabStudioCore)
      }));
      throw new Error('Anonymous PixelForge sign-in gate did not render; diagnostics=' +
        JSON.stringify({ auth: anonymousAuth, diagnostics, pageErrors: anonymousPageErrors }) + '; cause=' + error.message);
    }
    assert.match(await page.locator('body').innerText(), /Ir a CodeLab e iniciar sesión/, 'anonymous visitors should be directed to CodeLab authentication');
    assert.equal(await page.locator('#canvas').count(), 0, 'editor must not initialize before account authentication');
    await context.close();

    const accountContext = await browser.newContext();
    await accountContext.addInitScript(() => {
      localStorage.setItem('pixelforge.palette.v1:github:pixelforge-integration-user', JSON.stringify(['#A1B2C3']));
      localStorage.setItem('pixelforge.palette.v1', JSON.stringify(['#DEAD00']));
      localStorage.setItem('codelab_xd_ai_settings_v1:github_pixelforge-integration-user', JSON.stringify({
        mode: 'api',
        baseUrl: 'https://api.example.test/v1',
        model: 'test-model',
        apiKey: 'test-user-key-not-a-real-secret'
      }));
    });
    let holdFirstProjectSave = true;
    let failChunkOnce = false;
    let notifyFirstProjectSaveStarted;
    const firstProjectSaveStarted = new Promise(resolve => { notifyFirstProjectSaveStarted = resolve; });
    await accountContext.route('**/*', async route => {
      const headers = { ...route.request().headers(), 'x-forwarded-for': '198.51.100.81' };
      const requestPath = new URL(route.request().url()).pathname;
      if (failChunkOnce && route.request().method() === 'PUT' &&
          /\/uploads\/[a-f0-9]{32}\/2$/.test(requestPath)) {
        failChunkOnce = false;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'simulated_chunk_interruption' }) });
        return;
      }
      if (holdFirstProjectSave && route.request().method() === 'PUT' &&
          requestPath === '/api/pixelforge/projects') {
        holdFirstProjectSave = false;
        notifyFirstProjectSaveStarted();
        const response = await route.fetch({ headers });
        // Keep the first response in flight long enough for another edit to
        // queue an autosave. The queued snapshot must use the new server token.
        await new Promise(resolve => setTimeout(resolve, 1200));
        await route.fulfill({ response });
        return;
      }
      await route.continue({ headers });
    });
    await accountContext.addCookies([{ name: 'codelab_sid', value: sessionId, url: base, httpOnly: true, sameSite: 'Lax' }]);
    const accountPage = await accountContext.newPage();
    await accountPage.goto(base + '/pixelforge/index.html', { waitUntil: 'networkidle' });
    await accountPage.locator('#canvas').waitFor({ state: 'visible' });
    assert.equal(await accountPage.locator('#ai-provider-endpoint').inputValue(), 'https://api.example.test/v1/chat/completions',
      'PixelForge should reuse the authenticated account provider endpoint from CodeLab AI settings');
    assert.equal(await accountPage.locator('#ai-provider-model').inputValue(), 'test-model',
      'PixelForge should reuse the account model from CodeLab AI settings');
    assert.equal(await accountPage.locator('#ai-provider-key').inputValue(), 'test-user-key-not-a-real-secret',
      'PixelForge should prefill the current account key without persisting it in a project');
    assert.equal(await accountPage.locator('#user-palette .palette-item').count(), 1,
      'the signed-in account should load its own palette, not the legacy shared palette');
    await accountPage.locator('#new-document').click();
    await accountPage.locator('#new-dialog').waitFor({ state: 'visible' });
    await accountPage.locator('#new-name').fill('Browser account artwork');
    await accountPage.locator('#new-width').fill('12');
    await accountPage.locator('#new-height').fill('8');
    await accountPage.locator('#create-new').click();
    await accountPage.locator('#new-dialog').waitFor({ state: 'hidden' });
    await Promise.race([
      firstProjectSaveStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error('PixelForge autosave did not start')), 10000))
    ]);
    // Edit while the first autosave response is held. The second queued save
    // must wait for the first serverRevision before capturing its snapshot.
    // A saved-project chooser can be open after account/project recovery; close it
    // explicitly so the modal does not intercept the canvas interaction below.
    const projectsDialog = accountPage.locator('#projects-dialog');
    if (await projectsDialog.isVisible()) await accountPage.locator('#close-projects').click();
    const canvasBox = await accountPage.locator('#canvas').boundingBox();
    assert.ok(canvasBox && canvasBox.width > 0 && canvasBox.height > 0, 'PixelForge canvas should have a drawable viewport');
    await accountPage.locator('#canvas').click({ position: { x: canvasBox.width / 2, y: canvasBox.height / 2 } });
    await accountPage.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Saved to your CodeLab account'), null, { timeout: 15000 });
    assert.doesNotMatch(await accountPage.locator('#status').innerText(), /revision conflict|changed in another session/i,
      'rapid edits during a delayed save must not conflict with the same editor session');
    await accountPage.reload({ waitUntil: 'networkidle' });
    await accountPage.locator('#canvas').waitFor({ state: 'visible' });
    assert.equal(await accountPage.locator('#document-name').innerText(), 'Browser account artwork', 'the editor should recover the account-saved project after reload');
    assert.equal(await accountPage.locator('#document-size').innerText(), '12 × 8', 'the account-saved project dimensions should survive reload');
    const recoveredMetadata = (await (await fetch(base + '/api/pixelforge/projects', { headers: authHeaders })).json())
      .projects.find(project => project.name === 'Browser account artwork');
    assert.ok(recoveredMetadata, 'the browser-created artwork should remain in the account project list');
    const recoveredProject = (await (await fetch(base + '/api/pixelforge/projects/' + recoveredMetadata.id, { headers: authHeaders })).json()).project;
    assert.ok(Buffer.from(recoveredProject.layers[0].pixels, 'base64').some(value => value !== 0),
      'actual edited raster pixels, not only project metadata, should survive autosave and reload');

    // Exercise real raster tools through pointer events, then inspect the
    // account-persisted RGBA buffers (not just button presence or status text).
    const canvasLocator = accountPage.locator('#canvas');
    const documentWidth = 12, documentHeight = 8;
    async function pixelPosition(x, y) {
      const box = await canvasLocator.boundingBox();
      const zoomText = await accountPage.locator('#zoom-label').innerText();
      const zoom = Number.parseFloat(zoomText) / 100;
      assert.ok(box && Number.isFinite(zoom) && zoom > 0, 'canvas viewport and zoom should be measurable');
      return {
        x: box.width / 2 + (x + 0.5 - documentWidth / 2) * zoom,
        y: box.height / 2 + (y + 0.5 - documentHeight / 2) * zoom
      };
    }
    async function clickPixel(x, y) {
      await canvasLocator.click({ position: await pixelPosition(x, y) });
    }
    async function setForegroundColor(value) {
      await accountPage.locator('#color').evaluate((input, color) => {
        input.value = color;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, value);
    }
    async function waitForRasterSave() {
      await accountPage.waitForFunction(() => {
        const save = document.querySelector('#save');
        return save?.dataset.dirty === 'false' &&
          document.querySelector('#status')?.textContent.includes('Saved to your CodeLab account');
      }, null, { timeout: 15000 });
    }
    async function readSavedArtwork() {
      const list = await (await fetch(base + '/api/pixelforge/projects', { headers: authHeaders })).json();
      const metadata = list.projects.find(project => project.name === 'Browser account artwork');
      assert.ok(metadata, 'tool edits should remain attached to the saved account project');
      const response = await fetch(base + '/api/pixelforge/projects/' + metadata.id, { headers: authHeaders });
      assert.equal(response.status, 200, 'tool edits should be readable from persistent project storage');
      return (await response.json()).project;
    }
    function rgbaAt(project, x, y, layerIndex = 0) {
      const bytes = Buffer.from(project.layers[layerIndex].pixels, 'base64');
      const offset = (y * project.width + x) * 4;
      return [...bytes.subarray(offset, offset + 4)];
    }

    // Exercise the actual timeline controls in Chromium and verify that the
    // multi-layer animation survives the authenticated PostgreSQL save path.
    await accountPage.locator('#animation-add-frame').click();
    await accountPage.waitForFunction(() => document.querySelector('#animation-frame-count')?.textContent === '1 frame');
    await accountPage.locator('#animation-duplicate-frame').click();
    await accountPage.waitForFunction(() => document.querySelector('#animation-frame-count')?.textContent === '2 frames');
    await accountPage.locator('#animation-fps').fill('24');
    await accountPage.locator('#animation-fps').press('Tab');
    await accountPage.locator('#animation-duration').fill('250');
    await accountPage.locator('#animation-duration').press('Tab');
    await accountPage.locator('#animation-play').click();
    await accountPage.waitForFunction(() => document.querySelector('#animation-stop')?.disabled === false);
    await accountPage.waitForTimeout(60);
    await accountPage.locator('#animation-stop').click();
    await accountPage.locator('#animation-loop').uncheck();
    await accountPage.locator('#animation-onion').check();
    await accountPage.locator('#animation-add-frame').click();
    await accountPage.waitForFunction(() => document.querySelector('#animation-frame-count')?.textContent === '3 frames');
    await accountPage.locator('#animation-frame-left').click();
    await accountPage.locator('#animation-frame-right').click();
    await accountPage.locator('#animation-delete-frame').click();
    await accountPage.waitForFunction(() => document.querySelector('#animation-frame-count')?.textContent === '2 frames');
    await waitForRasterSave();
    const savedAnimationProject = await readSavedArtwork();
    assert.equal(savedAnimationProject.animation.frames.length, 2, 'timeline add/duplicate/delete actions should persist the expected frame count');
    assert.equal(savedAnimationProject.animation.fps, 24, 'FPS control should persist its new value');
    assert.equal(savedAnimationProject.animation.loop, false, 'loop control should persist its unchecked state');
    assert.equal(savedAnimationProject.animation.frames[1].durationMs, 250, 'per-frame duration control should persist its new value');
    const animationDownloadsPromise = new Promise((resolve, reject) => {
      const downloads = [];
      const onDownload = download => {
        downloads.push(download);
        if (downloads.length === 2) {
          clearTimeout(timeout);
          accountPage.off('download', onDownload);
          resolve(downloads);
        }
      };
      const timeout = setTimeout(() => {
        accountPage.off('download', onDownload);
        reject(new Error('PixelForge animation export did not emit both PNG and JSON downloads'));
      }, 10000);
      accountPage.on('download', onDownload);
    });
    await accountPage.locator('#animation-export-sheet').click();
    const [spriteSheetDownload, animationManifestDownload] = await animationDownloadsPromise;
    assert.match(spriteSheetDownload.suggestedFilename(), /-animation\.png$/);
    assert.match(animationManifestDownload.suggestedFilename(), /-animation\.json$/);

    const compositePngPromise = accountPage.waitForEvent('download');
    await accountPage.locator('#export-png').click();
    const compositePngDownload = await compositePngPromise;
    assert.match(compositePngDownload.suggestedFilename(), /\.png$/);

    const projectBackupPromise = accountPage.waitForEvent('download');
    await accountPage.locator('#export-project').click();
    const projectBackupDownload = await projectBackupPromise;
    assert.match(projectBackupDownload.suggestedFilename(), /\.pforge$/);
    const projectBackupPath = await projectBackupDownload.path();
    const exportedProject = JSON.parse(fs.readFileSync(projectBackupPath, 'utf8'));
    assert.equal(exportedProject.animation.frames.length, 2, 'portable .pforge export must include the complete animation timeline');
    assert.equal(exportedProject.animation.loop, false, 'portable .pforge export must preserve the loop setting');

    const layerSheetDownloadsPromise = new Promise((resolve, reject) => {
      const downloads = [];
      const onDownload = download => {
        downloads.push(download);
        if (downloads.length === 2) {
          clearTimeout(timeout);
          accountPage.off('download', onDownload);
          resolve(downloads);
        }
      };
      const timeout = setTimeout(() => {
        accountPage.off('download', onDownload);
        reject(new Error('Layer sprite-sheet export did not emit both PNG and JSON manifest'));
      }, 10000);
      accountPage.on('download', onDownload);
    });
    await accountPage.locator('#export-sprite-sheet').click();
    const [layerSheetDownload, layerManifestDownload] = await layerSheetDownloadsPromise;
    assert.match(layerSheetDownload.suggestedFilename(), /-spritesheet\.png$/);
    assert.match(layerManifestDownload.suggestedFilename(), /-spritesheet\.json$/);
    const layerManifestPath = await layerManifestDownload.path();
    const layerManifest = JSON.parse(fs.readFileSync(layerManifestPath, 'utf8'));
    assert.equal(layerManifest.format, 'pixelforge-sprite-sheet');
    assert.equal(layerManifest.frames.length, 1, 'layer sprite sheet should include the current raster layer');

    await accountPage.reload({ waitUntil: 'networkidle' });
    await accountPage.locator('#canvas').waitFor({ state: 'visible' });
    assert.equal(await accountPage.locator('#animation-frame-count').innerText(), '2 frames',
      'the timeline should be restored after reloading the saved account project');
    assert.equal(await accountPage.locator('#animation-loop').isChecked(), false,
      'the saved loop setting should be restored after reload');

    await setForegroundColor('#ff0000');
    await accountPage.locator('#brush-tool').click();
    await clickPixel(2, 2);
    await waitForRasterSave();
    let toolProject = await readSavedArtwork();
    assert.deepEqual(rgbaAt(toolProject, 2, 2), [255, 0, 0, 255],
      'pencil pointer input should write the selected color to the expected raster pixel');

    await accountPage.locator('#eraser-tool').click();
    await clickPixel(2, 2);
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.equal(rgbaAt(toolProject, 2, 2)[3], 0, 'eraser should clear the target pixel to transparency');

    await setForegroundColor('#00aa44');
    await accountPage.locator('#fill-tool').click();
    await clickPixel(0, 0);
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.deepEqual(rgbaAt(toolProject, 0, 0), [0, 170, 68, 255],
      'bucket fill should update the selected connected transparent region');

    await accountPage.locator('#undo').click();
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.equal(rgbaAt(toolProject, 0, 0)[3], 0, 'undo should revert the bucket fill in persisted pixels');
    await accountPage.locator('#redo').click();
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.deepEqual(rgbaAt(toolProject, 0, 0), [0, 170, 68, 255],
      'redo should restore the bucket fill in persisted pixels');

    await accountPage.locator('#add-layer').click();
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.equal(toolProject.layers.length, 2, 'add-layer should create a second persisted raster layer');
    await setForegroundColor('#2255ee');
    await accountPage.locator('#line-tool').click();
    const lineStart = await pixelPosition(1, 1), lineEnd = await pixelPosition(10, 6);
    await canvasLocator.hover({ position: lineStart });
    await accountPage.mouse.move((await canvasLocator.boundingBox()).x + lineStart.x, (await canvasLocator.boundingBox()).y + lineStart.y);
    await accountPage.mouse.down();
    const canvasBoxForLine = await canvasLocator.boundingBox();
    await accountPage.mouse.move(canvasBoxForLine.x + lineEnd.x, canvasBoxForLine.y + lineEnd.y, { steps: 8 });
    await accountPage.mouse.up();
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.ok(rgbaAt(toolProject, 1, 1, 1)[3] > 0 && rgbaAt(toolProject, 10, 6, 1)[3] > 0,
      'line tool should rasterize its drag path into the active layer and persist both endpoints');

    await setForegroundColor('#ffffff');
    await accountPage.locator('#gradient-tool').click();
    const gradientStart = await pixelPosition(0, 7), gradientEnd = await pixelPosition(11, 7);
    const gradientBox = await canvasLocator.boundingBox();
    await accountPage.mouse.move(gradientBox.x + gradientStart.x, gradientBox.y + gradientStart.y);
    await accountPage.mouse.down();
    await accountPage.mouse.move(gradientBox.x + gradientEnd.x, gradientBox.y + gradientEnd.y, { steps: 10 });
    await accountPage.mouse.up();
    await waitForRasterSave();
    toolProject = await readSavedArtwork();
    assert.ok(rgbaAt(toolProject, 0, 7, 1)[3] > 0 && rgbaAt(toolProject, 11, 7, 1)[3] > 0,
      'gradient tool should apply and persist a raster gradient across its drag endpoints');


    const deleteFixture = makePixelProject('browser-delete-artwork', 'Browser delete artwork');
    const deleteFixtureResponse = await fetch(base + '/api/pixelforge/projects', {
      method: 'PUT',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ project: deleteFixture })
    });
    assert.equal(deleteFixtureResponse.status, 201, 'a second saved project should be available for UI deletion');
    accountPage.on('dialog', dialog => dialog.accept());
    await accountPage.locator('#projects-button').click();
    await accountPage.locator('#projects-dialog').waitFor({ state: 'visible' });
    await accountPage.locator('.saved-project-open').filter({ hasText: 'Browser account artwork' }).waitFor({ state: 'visible' });
    const deleteRow = accountPage.locator('.saved-project').filter({ hasText: 'Browser delete artwork' });
    await deleteRow.locator('.saved-project-delete').click();
    await deleteRow.waitFor({ state: 'detached' });
    assert.equal((await fetch(base + '/api/pixelforge/projects/browser-delete-artwork', { headers: authHeaders })).status, 404, 'UI deletion must remove the account-owned project from server storage');

    await accountContext.addCookies([{ name: 'codelab_sid', value: secondSessionId, url: base, httpOnly: true, sameSite: 'Lax' }]);
    await accountPage.reload({ waitUntil: 'networkidle' });
    await accountPage.locator('#canvas').waitFor({ state: 'visible' });
    assert.equal(await accountPage.locator('#user-palette .palette-item').count(), 0,
      'switching to another CodeLab account must not reveal the previous account palette');
    assert.equal(await accountPage.locator('#ai-provider-key').inputValue(), '',
      'switching accounts must not carry the previous account API key into PixelForge');
    await accountContext.addCookies([{ name: 'codelab_sid', value: sessionId, url: base, httpOnly: true, sameSite: 'Lax' }]);
    await accountPage.reload({ waitUntil: 'networkidle' });
    await accountPage.locator('#canvas').waitFor({ state: 'visible' });
    assert.equal(await accountPage.locator('#user-palette .palette-item').count(), 1,
      'switching back should restore the original account palette');
    assert.equal(await accountPage.locator('#ai-provider-key').inputValue(), 'test-user-key-not-a-real-secret',
      'switching back should restore only the original account provider settings');

    // Import must persist to the authenticated CodeLab account, not merely
    // report a local save. Verify both the UI result and the stored RGBA data.
    const importFixture = makePixelProject('import-fixture', 'Imported browser artwork', 3, 3);
    const importPixels = Buffer.alloc(3 * 3 * 4);
    importPixels.set([17, 34, 51, 255], (1 * 3 + 2) * 4);
    importFixture.layers[0].pixels = importPixels.toString('base64');
    const importFixturePath = path.join(dataDir, 'pixelforge-import-fixture.pforge');
    fs.writeFileSync(importFixturePath, JSON.stringify(importFixture));
    await accountPage.locator('#import-file').setInputFiles(importFixturePath);
    await accountPage.waitForFunction(() =>
      document.querySelector('#status')?.textContent.includes('Import complete and saved to your CodeLab account'),
      null, { timeout: 15000 });
    const importedMetadata = (await (await fetch(base + '/api/pixelforge/projects', { headers: authHeaders })).json())
      .projects.find(project => project.name === 'Imported browser artwork (imported)');
    assert.ok(importedMetadata, 'imported artwork should be persisted in the signed-in CodeLab account');
    const importedProject = (await (await fetch(base + '/api/pixelforge/projects/' + importedMetadata.id, { headers: authHeaders })).json()).project;
    assert.deepEqual([...Buffer.from(importedProject.layers[0].pixels, 'base64').subarray((1 * 3 + 2) * 4, (1 * 3 + 2) * 4 + 4)],
      [17, 34, 51, 255], 'imported raster pixels should survive account-backed persistence');
    const importedRevisionBeforeEdit = importedProject.serverRevision;
    assert.ok(Number.isInteger(importedRevisionBeforeEdit) && importedRevisionBeforeEdit > 0,
      'the imported live document must retain the server-issued revision token');
    await accountPage.locator('#save').click();
    await accountPage.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Saved to your CodeLab account'),
      null, { timeout: 15000 });
    const importedAfterSave = (await (await fetch(base + '/api/pixelforge/projects/' + importedMetadata.id, { headers: authHeaders })).json()).project;
    assert.equal(importedAfterSave.serverRevision, importedRevisionBeforeEdit + 1,
      'the first explicit save after import must advance the server revision instead of conflicting with its own import');
    const editorSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'pixelforge', 'src', 'editor.js'), 'utf8');
    const importDocAssignmentAt = editorSource.indexOf('doc = importedDoc;');
    const importAnimationRestoreAt = editorSource.indexOf('animation = importedDoc.animationData', importDocAssignmentAt);
    const importWorkspaceRebindAt = editorSource.indexOf('clearSelectionState(); resetAIWorkspaceForDocument();', importAnimationRestoreAt);
    assert.ok(importDocAssignmentAt >= 0 && importAnimationRestoreAt > importDocAssignmentAt && importWorkspaceRebindAt > importAnimationRestoreAt,
      'importing a document must restore its animation, clear stale selection state, and rebind the AI workspace');

    // A 3-layer 2048×1024 document exceeds the single-request threshold but stays within
    // the 64 MiB raw raster budget. The upload is interrupted once and must resume safely.
    const largeFixture = makePixelProject('chunked-import-fixture', 'Large chunked artwork', 2048, 1024);
    const layerBytes = 2048 * 1024 * 4;
    largeFixture.layers[0].pixels = Buffer.alloc(layerBytes).toString('base64');
    for (let index = 2; index <= 3; index++) {
      largeFixture.layers.push({
        id: 'layer-chunked-' + index, name: 'Layer ' + index, visible: true, opacity: 1, locked: false,
        pixels: Buffer.alloc(layerBytes).toString('base64')
      });
    }
    const largeUploadIp = '198.51.100.77';
    const largeUploadHeaders = { ...authHeaders, 'x-forwarded-for': largeUploadIp };
    await accountPage.route('**/api/pixelforge/**', route => route.continue({
      headers: { ...route.request().headers(), 'x-forwarded-for': largeUploadIp }
    }));
    const largeFixturePath = path.join(dataDir, 'pixelforge-large-import-fixture.pforge');
    fs.writeFileSync(largeFixturePath, JSON.stringify(largeFixture));
    assert.ok(fs.statSync(largeFixturePath).size > 24 * 1024 * 1024,
      'the large fixture must exercise chunked rather than single-request persistence');
    await accountPage.locator('#import-file').setInputFiles(largeFixturePath);
    try {
      await accountPage.waitForFunction(() =>
        document.querySelector('#status')?.textContent.includes('Import complete and saved to your CodeLab account'),
        null, { timeout: 60000 });
    } catch (error) {
      const importStatus = await accountPage.locator('#status').innerText();
      const listedProjects = await (await fetch(base + '/api/pixelforge/projects', { headers: largeUploadHeaders })).json();
      throw new Error('Large chunked import did not complete; status=' + importStatus +
        '; listedProjects=' + JSON.stringify(listedProjects.projects?.map(project => project.name)) +
        '; cause=' + error.message);
    }
    const largeMetadata = (await (await fetch(base + '/api/pixelforge/projects', { headers: largeUploadHeaders })).json())
      .projects.find(project => project.name === 'Large chunked artwork (imported)');
    assert.ok(largeMetadata, 'large chunked import must be durably listed in the account');
    const largeStored = (await (await fetch(base + '/api/pixelforge/projects/' + largeMetadata.id, { headers: largeUploadHeaders })).json()).project;
    assert.equal(largeStored.layers.length, 3, 'all raster layers must survive chunked persistence');
    assert.equal(largeStored.serverRevision, 1, 'chunked import must receive the first server revision');
    failChunkOnce = true;
    await accountPage.locator('#add-layer').click();
    await accountPage.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Autosave unavailable'),
      null, { timeout: 60000 });
    await accountPage.locator('#save').click();
    await accountPage.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Saved to your CodeLab account'),
      null, { timeout: 60000 });
    const resumedStored = (await (await fetch(base + '/api/pixelforge/projects/' + largeMetadata.id, { headers: largeUploadHeaders })).json()).project;
    assert.equal(resumedStored.layers.length, 4, 'retry after a dropped chunk must persist the complete edited document');
    assert.equal(resumedStored.serverRevision, 2, 'resumed chunk upload must commit exactly one new server revision');
    fs.rmSync(largeFixturePath, { force: true });
    fs.rmSync(importFixturePath, { force: true });
    // Free the deliberately huge fixture before testing the independent project-count
    // limit; otherwise the account byte quota can reject a small project first.
    const deleteLargeFixture = await fetch(base + '/api/pixelforge/projects/' + largeMetadata.id, {
      method: 'DELETE', headers: largeUploadHeaders
    });
    assert.equal(deleteLargeFixture.status, 200, 'large upload fixture should be removed before the separate project-count limit test');
    await accountContext.close();

    // Reaching the per-account project cap must never silently evict an older project.
    const capHeaders = { ...authHeaders, 'x-forwarded-for': '198.51.100.78' };
    const status = await (await fetch(base + '/api/ai/status', { headers: capHeaders })).json();
    const maxProjects = status.maxProjects;
    const existingProjects = (await (await fetch(base + '/api/pixelforge/projects', { headers: capHeaders })).json()).projects;
    assert.ok(existingProjects.length < maxProjects, 'the test account should have room to exercise the project cap');
    for (let index = existingProjects.length; index < maxProjects; index++) {
      const response = await fetch(base + '/api/pixelforge/projects', {
        method: 'PUT',
        headers: { ...capHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ project: makePixelProject('limit-project-' + index, 'Limit project ' + index) })
      });
      const responseBody = await response.text();
      assert.ok(response.status === 200 || response.status === 201,
        'projects below the account limit should save; index=' + index + '; maxProjects=' + maxProjects +
        '; existing=' + existingProjects.length + '; status=' + response.status + '; body=' + responseBody.slice(0, 500));
    }
    const overflow = await fetch(base + '/api/pixelforge/projects', {
      method: 'PUT',
      headers: { ...capHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ project: makePixelProject('limit-project-overflow', 'Overflow project') })
    });
    assert.equal(overflow.status, 409, 'saving beyond the account project cap should return a conflict');
    assert.equal((await overflow.json()).error, 'pixelforge_project_limit');
    const afterLimit = await (await fetch(base + '/api/pixelforge/projects', { headers: capHeaders })).json();
    assert.equal(afterLimit.projects.length, maxProjects, 'hitting the cap must preserve all existing projects');
    assert.ok(afterLimit.projects.some(project => project.name === 'Browser account artwork'), 'existing project records must remain available');
  } finally {
    await browser.close();
    fs.rmSync(path.join(sessionsDir, sessionId + '.json'), { force: true });
    fs.rmSync(path.join(sessionsDir, sameAccountSessionId + '.json'), { force: true });
    fs.rmSync(path.join(sessionsDir, secondSessionId + '.json'), { force: true });
  }
  console.log('PixelForge account gate, project CRUD/isolation, and authenticated browser save/reload verified.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
