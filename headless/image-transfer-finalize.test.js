'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { finalizeResolvedImageUploads } = require('./image-transfer-finalize');

test('finalizes resolved image tokens after a replayed save', () => {
  const calls = [];
  const store = { consumeImage: args => calls.push(args) };
  const uploads = [
    { uploadToken: 'token_00000001', projectId: 'proj_00000001' },
    { uploadToken: 'token_00000002', projectId: 'proj_00000002' }
  ];
  finalizeResolvedImageUploads(store, 'workspace_0001', 'design_save_retry_01', uploads);
  assert.deepEqual(calls, [
    { uploadToken: 'token_00000001', workspaceId: 'workspace_0001', projectId: 'proj_00000001', operationId: 'design_save_retry_01' },
    { uploadToken: 'token_00000002', workspaceId: 'workspace_0001', projectId: 'proj_00000002', operationId: 'design_save_retry_01' }
  ]);
});

test('ignores malformed upload entries and unavailable transfer stores', () => {
  const calls = [];
  finalizeResolvedImageUploads({ consumeImage: args => calls.push(args) }, 'ws', 'operation_0001', [
    null, {}, { uploadToken: 'valid_token_01', projectId: 'proj_00000001' }
  ]);
  assert.equal(calls.length, 1);
  assert.doesNotThrow(() => finalizeResolvedImageUploads(null, 'ws', 'operation_0001', []));
});

test('a token finalization failure does not prevent remaining cleanup attempts', () => {
  const calls = [];
  const store = { consumeImage: args => {
    calls.push(args.uploadToken);
    if (args.uploadToken === 'token_00000001') throw new Error('temporary filesystem error');
  } };
  finalizeResolvedImageUploads(store, 'ws', 'operation_0001', [
    { uploadToken: 'token_00000001', projectId: 'proj_00000001' },
    { uploadToken: 'token_00000002', projectId: 'proj_00000002' }
  ]);
  assert.deepEqual(calls, ['token_00000001', 'token_00000002']);
});
