const test = require('node:test');
const assert = require('node:assert/strict');
const transit = require('transit-js');
const {
  METHODS,
  dispatchWithHandlers,
  resolveMethod,
  validateParams
} = require('../penpot-rpc-contract');

const uuid = '123e4567-e89b-52d3-a456-426614174000';

function transitParams(entries) {
  const result = transit.map();
  for (const [key, value] of Object.entries(entries)) {
    result.set(transit.keyword(key), value);
  }
  return result;
}

test('first-slice RPC allowlist is explicit and GET/POST verbs match Penpot rules', () => {
  assert.equal(Object.keys(METHODS).length, 10);
  assert.equal(resolveMethod('get-file', 'GET').scope, 'file');
  assert.equal(resolveMethod('update-file', 'POST').mutation, true);
  assert.throws(
    () => resolveMethod('update-file', 'GET'),
    error => error.status === 405 && error.code === 'PENPOT_METHOD_VERB_NOT_ALLOWED'
  );
  assert.throws(
    () => resolveMethod('get-file', 'POST'),
    error => error.status === 405
  );
  assert.throws(
    () => resolveMethod('delete-team', 'POST'),
    error => error.status === 404 && error.code === 'PENPOT_METHOD_NOT_ALLOWED'
  );
});

test('GET methods validate required UUID parameters and one-of rules', () => {
  assert.equal(validateParams('get-projects', { 'team-id': uuid })['team-id'], uuid);
  assert.throws(
    () => validateParams('get-projects', {}),
    error => error.code === 'PENPOT_REQUIRED_PARAM_MISSING'
  );
  assert.throws(
    () => validateParams('get-team', {}),
    error => error.code === 'PENPOT_REQUIRED_PARAM_MISSING'
  );
  assert.equal(validateParams('get-team', { 'file-id': uuid })['file-id'], uuid);
  assert.throws(
    () => validateParams('get-file', { id: 'not-a-uuid' }),
    error => error.code === 'PENPOT_INVALID_UUID_PARAM'
  );
});

test('update-file validates session, version numbers and one native change payload', () => {
  const params = {
    id: uuid,
    'session-id': uuid,
    revn: 3,
    vern: 0,
    changes: [{ type: 'mod-obj', id: uuid }]
  };
  assert.equal(validateParams('update-file', params), params);
  assert.throws(
    () => validateParams('update-file', { id: uuid, revn: 3, vern: 0, changes: [] }),
    error => error.code === 'PENPOT_REQUIRED_PARAM_MISSING'
  );
  assert.throws(
    () => validateParams('update-file', { ...params, revn: -1 }),
    error => error.code === 'PENPOT_INVALID_INTEGER_PARAM'
  );
  assert.throws(
    () => validateParams('update-file', {
      ...params,
      'changes-with-metadata': [{ changes: [] }]
    }),
    error => error.code === 'PENPOT_AMBIGUOUS_CHANGE_PAYLOAD'
  );
  assert.throws(
    () => validateParams('update-file', { ...params, admin: true }),
    error => error.code === 'PENPOT_UNKNOWN_PARAM'
  );
});

test('RPC contract reads Transit keyword-keyed parameter maps', () => {
  const params = transitParams({
    id: transit.uuid(uuid),
    'session-id': transit.uuid(uuid),
    revn: 1,
    vern: 0,
    changes: []
  });
  assert.equal(validateParams('update-file', params), params);
  assert.equal(resolveMethod('update-file', 'POST').scope, 'file');
});

test('dispatcher never falls back to arbitrary methods or missing handlers', async () => {
  assert.throws(
    () => dispatchWithHandlers({
      methodName: 'delete-team',
      httpMethod: 'POST',
      params: {},
      context: {},
      handlers: { 'delete-team': () => 'unsafe' }
    }),
    error => error.status === 404
  );
  assert.throws(
    () => dispatchWithHandlers({
      methodName: 'get-profile',
      httpMethod: 'GET',
      params: {},
      context: {},
      handlers: {}
    }),
    error => error.status === 501 && error.code === 'PENPOT_METHOD_HANDLER_NOT_IMPLEMENTED'
  );
  const result = dispatchWithHandlers({
    methodName: 'get-profile',
    httpMethod: 'GET',
    params: {},
    context: { profileId: uuid },
    handlers: {
      'get-profile': ({ descriptor, context }) => ({
        scope: descriptor.scope,
        profileId: context.profileId
      })
    }
  });
  assert.deepEqual(result, { scope: 'profile', profileId: uuid });
});

test('file rename names are bounded and non-empty', () => {
  assert.equal(validateParams('rename-file', { id: uuid, name: 'Inicio' }).name, 'Inicio');
  assert.throws(
    () => validateParams('rename-file', { id: uuid, name: '   ' }),
    error => error.code === 'PENPOT_INVALID_FILE_NAME'
  );
  assert.throws(
    () => validateParams('rename-file', { id: uuid, name: 'x'.repeat(251) }),
    error => error.code === 'PENPOT_INVALID_FILE_NAME'
  );
});
