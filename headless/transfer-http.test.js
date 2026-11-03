'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { transferErrorResponse } = require('./transfer-http');

test('stale transfer commits preserve the HTTP 409 revision-conflict contract', () => {
  const mapped = transferErrorResponse(Object.assign(new Error('Workspace revision conflict.'), {
    code: 'HEADLESS_REVISION_CONFLICT',
    revision: 12
  }));
  assert.deepEqual(mapped, { status: 409, body: { error: 'revision_conflict', revision: 12 } });
});

test('reusing a transfer operation ID with a different payload returns HTTP 409', () => {
  const mapped = transferErrorResponse(Object.assign(new Error('operationId was already used.'), {
    code: 'HEADLESS_IDEMPOTENCY_CONFLICT'
  }));
  assert.deepEqual(mapped, { status: 409, body: { error: 'operation_id_conflict' } });
});

test('malformed and incomplete transfers remain client errors', () => {
  assert.equal(transferErrorResponse(new Error('code_chunks_incomplete')).status, 400);
  assert.equal(transferErrorResponse(new Error('invalid_code_chunk')).status, 400);
  assert.equal(transferErrorResponse(new Error('transfer_not_found')).status, 404);
});
