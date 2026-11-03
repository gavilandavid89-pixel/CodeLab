'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTransferStore, sha256, imageMime, MAX_CHUNK_CHARS } = require('./transfer-store');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codelab-transfer-'));
  return { root, store: createTransferStore(root), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
test('code chunks may arrive out of order and are assembled only after hash verification', () => {
  const f = fixture();
  try {
    const value = 'A'.repeat(MAX_CHUNK_CHARS + 3) + '🧪 end';
    const parts = [value.slice(0, MAX_CHUNK_CHARS), value.slice(MAX_CHUNK_CHARS)];
    const started = f.store.beginCode({ workspaceId: 'ws1', projectId: 'proj_123', field: 'html', baseRevision: 4, totalChunks: parts.length, sha256: sha256(value) });
    f.store.putCodeChunk({ transferId: started.transferId, workspaceId: 'ws1', index: 1, chunk: parts[1], sha256: sha256(parts[1]) });
    assert.throws(() => f.store.assembleCode({ transferId: started.transferId, workspaceId: 'ws1' }), /incomplete/);
    f.store.putCodeChunk({ transferId: started.transferId, workspaceId: 'ws1', index: 0, chunk: parts[0], sha256: sha256(parts[0]) });
    assert.equal(f.store.assembleCode({ transferId: started.transferId, workspaceId: 'ws1' }).value, value);
  } finally { f.cleanup(); }
});
test('rejects tampered chunks, conflicting replay, wrong owner and oversized chunks', () => {
  const f = fixture();
  try {
    const value = 'safe';
    const started = f.store.beginCode({ workspaceId: 'owner', projectId: 'proj_123', field: 'js', baseRevision: 0, totalChunks: 1, sha256: sha256(value) });
    assert.throws(() => f.store.putCodeChunk({ transferId: started.transferId, workspaceId: 'other', index: 0, chunk: value, sha256: sha256(value) }), /not_found/);
    assert.throws(() => f.store.putCodeChunk({ transferId: started.transferId, workspaceId: 'owner', index: 0, chunk: value, sha256: '0'.repeat(64) }), /invalid_code_chunk/);
    f.store.putCodeChunk({ transferId: started.transferId, workspaceId: 'owner', index: 0, chunk: value, sha256: sha256(value) });
    assert.throws(() => f.store.putCodeChunk({ transferId: started.transferId, workspaceId: 'owner', index: 0, chunk: 'evil', sha256: sha256('evil') }), /conflict/);
    assert.throws(() => f.store.beginCode({ workspaceId: 'owner', projectId: 'proj_123', field: 'html', baseRevision: 0, totalChunks: 71, sha256: sha256(value) }), /invalid/);
  } finally { f.cleanup(); }
});
test('validates actual image signatures and rejects declared MIME mismatches', () => {
  const f = fixture();
  try {
    const png = Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
    assert.equal(imageMime(png), 'image/png');
    assert.throws(() => f.store.putImage({ workspaceId: 'w', projectId: 'p', bytes: png, declaredMime: 'image/jpeg' }), /signature/);
    const saved = f.store.putImage({ workspaceId: 'w', projectId: 'p', bytes: png, declaredMime: 'image/png' });
    assert.equal(f.store.consumeImage({ uploadToken: saved.uploadToken, workspaceId: 'w', projectId: 'p' }).dataUrl, 'data:image/png;base64,' + png.toString('base64'));
    assert.throws(() => f.store.consumeImage({ uploadToken: saved.uploadToken, workspaceId: 'w', projectId: 'p' }), /not_found/);
  } finally { f.cleanup(); }
});

test('expired code and image tokens cannot be replayed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codelab-transfer-expiry-'));
  try {
    let now = 1000;
    const store = createTransferStore(root, () => now);
    const value = 'expire me';
    const code = store.beginCode({ workspaceId: 'owner', projectId: 'proj_123', field: 'css', baseRevision: 1, totalChunks: 1, sha256: sha256(value) });
    store.putCodeChunk({ transferId: code.transferId, workspaceId: 'owner', index: 0, chunk: value, sha256: sha256(value) });
    assert.equal(fs.readdirSync(path.join(root, 'headless-transfers')).filter(name => name.startsWith('code-' + code.transferId + '-chunk-')).length, 1);
    const image = store.putImage({ workspaceId: 'owner', projectId: 'proj_123', bytes: Buffer.from([137,80,78,71,13,10,26,10,1]), declaredMime: 'image/png' });
    now += 10 * 60 * 1000 + 1;
    assert.throws(() => store.assembleCode({ transferId: code.transferId, workspaceId: 'owner' }), /not_found/);
    assert.equal(fs.readdirSync(path.join(root, 'headless-transfers')).filter(name => name.startsWith('code-' + code.transferId + '-chunk-')).length, 0);
    assert.throws(() => store.resolveImage({ uploadToken: image.uploadToken, workspaceId: 'owner', projectId: 'proj_123' }), /not_found/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('chunked image upload verifies chunk hashes, full bytes, signature and one-time token', () => {
  const f = fixture();
  try {
    const png = Buffer.from([137,80,78,71,13,10,26,10,1,2,3,4,5,6,7,8]);
    const base64 = png.toString('base64');
    const parts = [base64.slice(0, 8), base64.slice(8)];
    const started = f.store.beginImage({ workspaceId: 'ws1', projectId: 'design_123', totalChunks: parts.length, sha256: sha256(png), declaredMime: 'image/png' });
    f.store.putImageChunk({ transferId: started.transferId, workspaceId: 'ws1', index: 1, chunk: parts[1], sha256: sha256(parts[1]) });
    assert.throws(() => f.store.commitImage({ transferId: started.transferId, workspaceId: 'ws1' }), /incomplete/);
    f.store.putImageChunk({ transferId: started.transferId, workspaceId: 'ws1', index: 0, chunk: parts[0], sha256: sha256(parts[0]) });
    const upload = f.store.commitImage({ transferId: started.transferId, workspaceId: 'ws1' });
    assert.equal(upload.projectId, 'design_123');
    assert.equal(upload.mime, 'image/png');
    assert.equal(upload.sha256, sha256(png));
    assert.equal(f.store.resolveImage({ uploadToken: upload.uploadToken, workspaceId: 'ws1', projectId: 'design_123' }).dataUrl, 'data:image/png;base64,' + base64);
    assert.throws(() => f.store.putImageChunk({ transferId: started.transferId, workspaceId: 'ws1', index: 0, chunk: parts[0], sha256: sha256(parts[0]) }), /not_found/);
  } finally { f.cleanup(); }
});
test('chunked image upload rejects a changed chunk and invalid full-image hash', () => {
  const f = fixture();
  try {
    const png = Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
    const base64 = png.toString('base64');
    const started = f.store.beginImage({ workspaceId: 'ws1', projectId: 'design_123', totalChunks: 1, sha256: '0'.repeat(64), declaredMime: 'image/png' });
    assert.throws(() => f.store.putImageChunk({ transferId: started.transferId, workspaceId: 'ws1', index: 0, chunk: base64, sha256: '0'.repeat(64) }), /invalid/);
    f.store.putImageChunk({ transferId: started.transferId, workspaceId: 'ws1', index: 0, chunk: base64, sha256: sha256(base64) });
    assert.throws(() => f.store.commitImage({ transferId: started.transferId, workspaceId: 'ws1' }), /hash_mismatch/);
  } finally { f.cleanup(); }
});

test('consumed image token can only be replayed by the same saved operation ID', () => {
  const f = fixture();
  try {
    const png = Buffer.from([137,80,78,71,13,10,26,10,1,9,8,7]);
    const upload = f.store.putImage({ workspaceId: 'ws1', projectId: 'design_123', bytes: png, declaredMime: 'image/png' });
    const operationId = 'design_save_retry_01';
    const first = f.store.consumeImage({ uploadToken: upload.uploadToken, workspaceId: 'ws1', projectId: 'design_123', operationId });
    assert.equal(first.sha256, sha256(png));
    const retry = f.store.resolveImage({ uploadToken: upload.uploadToken, workspaceId: 'ws1', projectId: 'design_123', operationId });
    assert.equal(retry.dataUrl, first.dataUrl);
    assert.throws(() => f.store.resolveImage({ uploadToken: upload.uploadToken, workspaceId: 'ws1', projectId: 'design_123', operationId: 'different_operation_02' }), /already_consumed/);
  } finally { f.cleanup(); }
});

test('starting a new transfer sweeps abandoned expired chunk files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codelab-transfer-sweep-'));
  try {
    let now = 1000;
    const store = createTransferStore(root, () => now);
    const value = 'abandoned';
    const old = store.beginCode({ workspaceId: 'owner', projectId: 'proj_123', field: 'js', baseRevision: 0, totalChunks: 1, sha256: sha256(value) });
    store.putCodeChunk({ transferId: old.transferId, workspaceId: 'owner', index: 0, chunk: value, sha256: sha256(value) });
    const dir = path.join(root, 'headless-transfers');
    assert.ok(fs.readdirSync(dir).some(name => name === 'code-' + old.transferId + '-chunk-0.json'));
    now += 10 * 60 * 1000 + 1;
    store.beginImage({ workspaceId: 'owner', projectId: 'design_123', totalChunks: 1, sha256: 'a'.repeat(64), declaredMime: 'image/png' });
    assert.ok(!fs.readdirSync(dir).some(name => name.includes(old.transferId)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('chunked image commit is idempotent and expired image tokens are swept', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codelab-transfer-commit-retry-'));
  try {
    let now = 1000;
    const store = createTransferStore(root, () => now);
    const png = Buffer.from([137,80,78,71,13,10,26,10,1,2,3,4]);
    const base64 = png.toString('base64');
    const started = store.beginImage({ workspaceId: 'owner', projectId: 'design_123', totalChunks: 1, sha256: sha256(png), declaredMime: 'image/png' });
    store.putImageChunk({ transferId: started.transferId, workspaceId: 'owner', index: 0, chunk: base64, sha256: sha256(base64) });
    const first = store.commitImage({ transferId: started.transferId, workspaceId: 'owner' });
    const retry = store.commitImage({ transferId: started.transferId, workspaceId: 'owner' });
    assert.deepEqual(retry, first);
    assert.equal(retry.uploadToken, started.transferId);
    assert.equal(store.resolveImage({ uploadToken: retry.uploadToken, workspaceId: 'owner', projectId: 'design_123' }).dataUrl, 'data:image/png;base64,' + base64);
    const dir = path.join(root, 'headless-transfers');
    now += 10 * 60 * 1000 + 1;
    store.beginCode({ workspaceId: 'owner', projectId: 'proj_123', field: 'html', baseRevision: 0, totalChunks: 1, sha256: sha256('x') });
    assert.ok(!fs.existsSync(path.join(dir, 'image-' + retry.uploadToken + '.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'image-chunks-' + started.transferId + '.json')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('committed code transfers replay the saved receipt after a lost response', () => {
  const f = fixture();
  try {
    const value = '<main>retry-safe</main>';
    const started = f.store.beginCode({ workspaceId: 'owner', projectId: 'proj_123', field: 'html', baseRevision: 2, totalChunks: 1, sha256: sha256(value) });
    f.store.putCodeChunk({ transferId: started.transferId, workspaceId: 'owner', index: 0, chunk: value, sha256: sha256(value) });
    const receipt = { ok: true, revision: 3, action: 'project.code.write', result: { projectId: 'proj_123', field: 'html', readbackVerified: true } };
    f.store.consumeCode(started.transferId, receipt);
    const retry = f.store.assembleCode({ transferId: started.transferId, workspaceId: 'owner' });
    assert.equal(retry.value, value);
    assert.deepEqual(retry.receipt, receipt);
    assert.equal(retry.committed, true);
    assert.throws(() => f.store.putCodeChunk({ transferId: started.transferId, workspaceId: 'owner', index: 0, chunk: value, sha256: sha256(value) }), /not_found/);
    const dir = path.join(f.root, 'headless-transfers');
    assert.ok(!fs.readdirSync(dir).some(name => name.startsWith('code-' + started.transferId + '-chunk-')));
  } finally { f.cleanup(); }
});


test('direct image uploads sweep expired upload tokens without requiring a chunked transfer', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codelab-direct-image-expiry-'));
  try {
    let now = 1000;
    const store = createTransferStore(root, () => now);
    const png = Buffer.from([137,80,78,71,13,10,26,10,1,2,3,4]);
    const first = store.putImage({ workspaceId: 'owner', projectId: 'design_123', bytes: png, declaredMime: 'image/png' });
    const dir = path.join(root, 'headless-transfers');
    assert.ok(fs.existsSync(path.join(dir, 'image-' + first.uploadToken + '.json')));
    now += 10 * 60 * 1000 + 1;
    const second = store.putImage({ workspaceId: 'owner', projectId: 'design_123', bytes: png, declaredMime: 'image/png' });
    assert.ok(!fs.existsSync(path.join(dir, 'image-' + first.uploadToken + '.json')),
      'an expired direct-upload token should be removed when the next direct upload begins');
    assert.ok(fs.existsSync(path.join(dir, 'image-' + second.uploadToken + '.json')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
