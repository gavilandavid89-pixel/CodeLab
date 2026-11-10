/**
 * Explicit first-slice contract for Penpot 2.19.0 RPC methods.
 *
 * This is a validation/allowlist layer only. It deliberately has no fallback
 * that invokes arbitrary server functions; actual handlers are added only
 * after their CodeLab identity and persistence mappings are implemented.
 */
'use strict';

const transit = require('transit-js');
const { UUID_RE } = require('./penpot-identity');

const METHODS = Object.freeze({
  'get-profile': Object.freeze({
    httpMethod: 'GET',
    scope: 'profile',
    required: [],
    allowed: [],
    source: 'backend/src/app/rpc/commands/profile.clj'
  }),
  'get-teams': Object.freeze({
    httpMethod: 'GET',
    scope: 'workspace',
    required: [],
    allowed: [],
    source: 'backend/src/app/rpc/commands/teams.clj'
  }),
  'get-team': Object.freeze({
    httpMethod: 'GET',
    scope: 'team',
    requiredOneOf: [['id', 'file-id']],
    allowed: ['id', 'file-id'],
    uuidFields: ['id', 'file-id'],
    source: 'backend/src/app/rpc/commands/teams.clj'
  }),
  'get-projects': Object.freeze({
    httpMethod: 'GET',
    scope: 'team',
    required: ['team-id'],
    allowed: ['team-id'],
    uuidFields: ['team-id'],
    source: 'backend/src/app/rpc/commands/projects.clj'
  }),
  'get-project': Object.freeze({
    httpMethod: 'GET',
    scope: 'project',
    required: ['id'],
    allowed: ['id'],
    uuidFields: ['id'],
    source: 'backend/src/app/rpc/commands/projects.clj'
  }),
  'get-project-files': Object.freeze({
    httpMethod: 'GET',
    scope: 'project',
    required: ['project-id'],
    allowed: ['project-id'],
    uuidFields: ['project-id'],
    source: 'backend/src/app/rpc/commands/files.clj'
  }),
  'get-file': Object.freeze({
    httpMethod: 'GET',
    scope: 'file',
    required: ['id'],
    allowed: ['id', 'features'],
    uuidFields: ['id'],
    stringArrayFields: ['features'],
    source: 'backend/src/app/rpc/commands/files.clj'
  }),
  'update-file': Object.freeze({
    httpMethod: 'POST',
    scope: 'file',
    mutation: true,
    required: ['id', 'session-id', 'revn', 'vern'],
    requiredOneOf: [['changes', 'changes-with-metadata']],
    allowed: ['id', 'session-id', 'revn', 'vern', 'features', 'changes',
      'changes-with-metadata', 'skip-validate', 'origin', 'created-at', 'commit-id'],
    uuidFields: ['id', 'session-id'],
    integerFields: ['revn', 'vern'],
    stringArrayFields: ['features'],
    arrayFields: ['changes', 'changes-with-metadata'],
    source: 'backend/src/app/rpc/commands/files_update.clj'
  }),
  'rename-file': Object.freeze({
    httpMethod: 'POST',
    scope: 'file',
    mutation: true,
    required: ['id', 'name'],
    allowed: ['id', 'name'],
    uuidFields: ['id'],
    source: 'backend/src/app/rpc/commands/files.clj'
  }),
  'delete-file': Object.freeze({
    httpMethod: 'POST',
    scope: 'file',
    mutation: true,
    required: ['id'],
    allowed: ['id'],
    uuidFields: ['id'],
    source: 'backend/src/app/rpc/commands/files.clj'
  })
});

function fail(status, code) {
  return Object.assign(new Error(code.toLowerCase()), { status, code });
}

function paramValue(params, key) {
  if (transit.isMap(params)) {
    return params.get(transit.keyword(key)) ?? params.get(key) ?? params.get(':' + key);
  }
  if (params && typeof params.get === 'function') {
    return params.get(key) ?? params.get(':' + key);
  }
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  return Object.prototype.hasOwnProperty.call(params, key) ? params[key] : params[':' + key];
}

function paramKeys(params) {
  if (params && typeof params.keys === 'function' && typeof params.get === 'function') {
    return [...params.keys()].map(key => String(key).replace(/^:/, ''));
  }
  if (!params || typeof params !== 'object' || Array.isArray(params)) return [];
  return Object.keys(params).map(key => key.replace(/^:/, ''));
}

function resolveMethod(methodName, httpMethod) {
  if (typeof methodName !== 'string' || !/^[a-z][a-z0-9-]{1,79}$/.test(methodName)) {
    throw fail(400, 'PENPOT_INVALID_METHOD_NAME');
  }
  const descriptor = METHODS[methodName];
  if (!descriptor) throw fail(404, 'PENPOT_METHOD_NOT_ALLOWED');
  const method = String(httpMethod || '').toUpperCase();
  if (method !== descriptor.httpMethod) {
    throw fail(405, 'PENPOT_METHOD_VERB_NOT_ALLOWED');
  }
  if (method === 'GET' && !methodName.startsWith('get-')) {
    throw fail(405, 'PENPOT_GET_METHOD_NOT_ALLOWED');
  }
  return descriptor;
}

function validateParams(methodName, params) {
  const descriptor = METHODS[methodName];
  if (!descriptor) throw fail(404, 'PENPOT_METHOD_NOT_ALLOWED');
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw fail(400, 'PENPOT_INVALID_PARAMS');
  }

  const keys = paramKeys(params);
  const allowed = new Set(descriptor.allowed);
  for (const key of keys) {
    if (!allowed.has(key)) throw fail(400, 'PENPOT_UNKNOWN_PARAM');
  }

  for (const key of descriptor.required || []) {
    if (paramValue(params, key) === undefined || paramValue(params, key) === null) {
      throw fail(400, 'PENPOT_REQUIRED_PARAM_MISSING');
    }
  }

  for (const group of descriptor.requiredOneOf || []) {
    if (!group.some(key => paramValue(params, key) !== undefined && paramValue(params, key) !== null)) {
      throw fail(400, 'PENPOT_REQUIRED_PARAM_MISSING');
    }
  }

  for (const key of descriptor.uuidFields || []) {
    const value = paramValue(params, key);
    if (value !== undefined && !UUID_RE.test(String(value))) {
      throw fail(400, 'PENPOT_INVALID_UUID_PARAM');
    }
  }

  for (const key of descriptor.integerFields || []) {
    const value = paramValue(params, key);
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw fail(400, 'PENPOT_INVALID_INTEGER_PARAM');
    }
  }

  for (const key of descriptor.stringArrayFields || []) {
    const value = paramValue(params, key);
    if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) {
      throw fail(400, 'PENPOT_INVALID_ARRAY_PARAM');
    }
  }

  for (const key of descriptor.arrayFields || []) {
    const value = paramValue(params, key);
    if (value !== undefined && !Array.isArray(value)) {
      throw fail(400, 'PENPOT_INVALID_ARRAY_PARAM');
    }
  }

  if (methodName === 'rename-file') {
    const name = paramValue(params, 'name');
    if (typeof name !== 'string' || !name.trim() || name.length > 250) {
      throw fail(400, 'PENPOT_INVALID_FILE_NAME');
    }
  }

  if (methodName === 'update-file') {
    const changes = paramValue(params, 'changes');
    const metadataChanges = paramValue(params, 'changes-with-metadata');
    if (changes !== undefined && metadataChanges !== undefined) {
      throw fail(400, 'PENPOT_AMBIGUOUS_CHANGE_PAYLOAD');
    }
  }

  return params;
}

function dispatchWithHandlers({ methodName, httpMethod, params, context, handlers }) {
  const descriptor = resolveMethod(methodName, httpMethod);
  validateParams(methodName, params);
  const handler = handlers && handlers[methodName];
  if (typeof handler !== 'function') {
    throw fail(501, 'PENPOT_METHOD_HANDLER_NOT_IMPLEMENTED');
  }
  return handler({ descriptor, context, params });
}

module.exports = {
  METHODS,
  dispatchWithHandlers,
  resolveMethod,
  validateParams
};
