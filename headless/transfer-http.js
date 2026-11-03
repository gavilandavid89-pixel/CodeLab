'use strict';

function transferErrorResponse(error) {
  if (error && error.code === 'HEADLESS_REVISION_CONFLICT') {
    return { status: 409, body: { error: 'revision_conflict', revision: error.revision } };
  }
  if (error && error.code === 'HEADLESS_IDEMPOTENCY_CONFLICT') {
    return { status: 409, body: { error: 'operation_id_conflict' } };
  }
  const message = error && typeof error.message === 'string' ? error.message : 'code_transfer_failed';
  const status = /incomplete|invalid|mismatch|conflict/.test(message) ? 400 : 404;
  return { status, body: { error: message } };
}

module.exports = { transferErrorResponse };
