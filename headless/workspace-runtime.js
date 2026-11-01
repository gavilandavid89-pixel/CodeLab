'use strict';

const crypto = require('node:crypto');
const { createDesignEngine } = require('./design-engine');

const MAX_OPERATIONS = 100;
const MAX_RECEIPTS = 200;
const PROJECT_ID = /^proj_[a-zA-Z0-9_-]{1,100}$/;

function assert(condition, message, code = 'HEADLESS_INVALID_OPERATION') {
  if (!condition) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function findProject(state, id) {
  assert(typeof id === 'string' && PROJECT_ID.test(id), 'A valid projectId is required.');
  const project = state.projects.find(item => item.id === id);
  assert(project, 'Project not found: ' + id, 'HEADLESS_PROJECT_NOT_FOUND');
  return project;
}

function applyOperation(state, operation) {
  assert(operation && typeof operation === 'object' && !Array.isArray(operation), 'Each operation must be an object.');
  switch (operation.type) {
    case 'project.create': {
      assert(state.projects.length < 500, 'Workspace project limit reached.');
      const projectId = operation.projectId || 'proj_' + crypto.randomUUID();
      assert(typeof projectId === 'string' && PROJECT_ID.test(projectId), 'project.create requires a valid projectId.');
      assert(!state.projects.some(item => item.id === projectId), 'Project ID already exists.');
      assert(typeof operation.name === 'string' && operation.name.trim() && operation.name.trim().length <= 200, 'project.create requires a name up to 200 characters.');
      const type = operation.projectType || 'web';
      assert(type === 'web' || type === 'design', 'Project type must be web or design.');
      const now = new Date().toISOString();
      const project = { id: projectId, name: operation.name.trim(), type, code: { html: '', css: '', js: '' }, createdAt: now, updatedAt: now };
      if (type === 'design') project.design = {
        frame: 'desktop', background: '#ffffff', canvasWidth: 1440, canvasHeight: 900, elements: [], revision: 0
      };
      state.projects.push(project);
      return { type: operation.type, projectId: project.id, projectType: project.type };
    }
    case 'project.rename': {
      const project = findProject(state, operation.projectId);
      assert(typeof operation.name === 'string' && operation.name.trim() && operation.name.trim().length <= 200, 'project.rename requires a name up to 200 characters.');
      project.name = operation.name.trim();
      project.updatedAt = new Date().toISOString();
      return { type: operation.type, projectId: project.id, name: project.name };
    }
    case 'project.duplicate': {
      assert(state.projects.length < 500, 'Workspace project limit reached.');
      const source = findProject(state, operation.projectId);
      const newProjectId = operation.newProjectId || 'proj_' + crypto.randomUUID();
      assert(typeof newProjectId === 'string' && PROJECT_ID.test(newProjectId), 'project.duplicate requires a valid newProjectId.');
      assert(!state.projects.some(item => item.id === newProjectId), 'Duplicate project ID already exists.');
      const duplicate = clone(source);
      duplicate.id = newProjectId;
      duplicate.name = typeof operation.name === 'string' && operation.name.trim() ? operation.name.trim().slice(0, 200) : source.name + ' copy';
      duplicate.createdAt = new Date().toISOString();
      duplicate.updatedAt = duplicate.createdAt;
      delete duplicate.branch;
      delete duplicate.mergeHistory;
      state.projects.push(duplicate);
      return { type: operation.type, sourceProjectId: source.id, projectId: duplicate.id, name: duplicate.name };
    }
    case 'web.code.write': {
      const project = findProject(state, operation.projectId);
      assert(project.type !== 'design', 'web.code.write requires a web project.');
      const source = operation.source || 'main';
      assert(source === 'main' || source === 'branch', 'Code source must be main or branch.');
      const target = source === 'branch' ? project.branch?.code : project.code;
      assert(target && typeof target === 'object', 'The requested code branch does not exist.');
      const keys = ['html', 'css', 'js'].filter(key => Object.prototype.hasOwnProperty.call(operation, key));
      assert(keys.length > 0, 'web.code.write requires html, css, or js.');
      for (const key of keys) {
        assert(typeof operation[key] === 'string' && operation[key].length <= 500000, key + ' must be a string up to 500000 characters.');
        target[key] = operation[key];
      }
      project.updatedAt = new Date().toISOString();
      if (source === 'branch') project.branch.updatedAt = project.updatedAt;
      return { type: operation.type, projectId: project.id, source, updatedFields: keys };
    }
    case 'design.batch': {
      const project = findProject(state, operation.projectId);
      assert(project.type === 'design' && project.design, 'design.batch requires an existing design project.');
      assert(Array.isArray(operation.operations) && operation.operations.length > 0 && operation.operations.length <= 500,
        'design.batch requires 1 to 500 design operations.');
      const result = createDesignEngine().transact(project, operation.operations, { expectedRevision: operation.expectedDesignRevision });
      Object.assign(project, result.project);
      project.updatedAt = new Date().toISOString();
      return { type: operation.type, projectId: project.id, designRevision: result.revision, operationResults: result.results, previewSvg: result.svg };
    }
    case 'design.flow.connect': {
      const sourceProject = findProject(state, operation.sourceProjectId);
      const targetProject = findProject(state, operation.targetProjectId);
      assert(sourceProject.type === 'design' && sourceProject.design, 'Flow source must be a design project.');
      assert(targetProject.type === 'design' && targetProject.design, 'Flow target must be a design project.');
      assert(sourceProject.id !== targetProject.id, 'A flow connection must target a different project.');
      const source = sourceProject.design.elements.find(item => item.id === operation.sourceElementId);
      assert(source, 'Flow source layer not found.');
      assert(source.flowRole !== 'menu', 'Menu layers cannot navigate to another project.');
      if (!Array.isArray(sourceProject.design.flowConnections)) sourceProject.design.flowConnections = [];
      sourceProject.design.flowConnections = sourceProject.design.flowConnections.filter(item => item.sourceElementId !== source.id);
      sourceProject.design.flowConnections.push({ sourceElementId: source.id, targetProjectId: targetProject.id });
      source.flowRole = 'navigate';
      sourceProject.updatedAt = new Date().toISOString();
      return { type: operation.type, sourceProjectId: sourceProject.id, sourceElementId: source.id, targetProjectId: targetProject.id };
    }
    case 'design.flow.disconnect': {
      const sourceProject = findProject(state, operation.sourceProjectId);
      assert(sourceProject.type === 'design' && sourceProject.design, 'Flow source must be a design project.');
      assert(typeof operation.sourceElementId === 'string', 'sourceElementId is required.');
      const before = Array.isArray(sourceProject.design.flowConnections) ? sourceProject.design.flowConnections.length : 0;
      sourceProject.design.flowConnections = (sourceProject.design.flowConnections || []).filter(item =>
        !(item.sourceElementId === operation.sourceElementId && (!operation.targetProjectId || item.targetProjectId === operation.targetProjectId))
      );
      const removed = before - sourceProject.design.flowConnections.length;
      if (!sourceProject.design.flowConnections.length) {
        const source = sourceProject.design.elements.find(item => item.id === operation.sourceElementId);
        if (source && source.flowRole === 'navigate') source.flowRole = '';
      }
      sourceProject.updatedAt = new Date().toISOString();
      return { type: operation.type, sourceProjectId: sourceProject.id, sourceElementId: operation.sourceElementId, removed };
    }
    case 'project.delete': {
      assert(operation.approved === true, 'project.delete requires explicit approval.');
      const project = findProject(state, operation.projectId);
      const index = state.projects.findIndex(item => item.id === project.id);
      state.projects.splice(index, 1);
      for (const other of state.projects) {
        if (other.type === 'design' && other.design && Array.isArray(other.design.flowConnections)) {
          other.design.flowConnections = other.design.flowConnections.filter(item => item.targetProjectId !== project.id);
        }
        if (other.sourceDesignProjectId === project.id) delete other.sourceDesignProjectId;
      }
      return { type: operation.type, projectId: project.id, deleted: true };
    }
    default:
      assert(false, 'Unsupported headless operation: ' + String(operation.type));
  }
}

function applyHeadlessBatch(inputState, request) {
  assert(inputState && typeof inputState === 'object' && Array.isArray(inputState.projects), 'A valid workspace state is required.');
  assert(request && typeof request === 'object' && !Array.isArray(request), 'A headless request is required.');
  assert(typeof request.operationId === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(request.operationId), 'operationId must contain 8 to 100 safe characters.');
  assert(Number.isInteger(request.baseRevision) && request.baseRevision >= 0, 'baseRevision must be a non-negative integer.');
  assert(Array.isArray(request.operations) && request.operations.length > 0 && request.operations.length <= MAX_OPERATIONS,
    'A headless batch must contain 1 to ' + MAX_OPERATIONS + ' operations.');
  const operationHash = hash(request.operations);
  const receipts = Array.isArray(inputState.headlessOperations) ? inputState.headlessOperations : [];
  const previous = receipts.find(item => item && item.id === request.operationId);
  if (previous) {
    assert(previous.hash === operationHash, 'operationId was already used with a different payload.', 'HEADLESS_IDEMPOTENCY_CONFLICT');
    return { state: clone(inputState), replayed: true, revision: inputState.revision, results: previous.results };
  }
  if (request.baseRevision !== inputState.revision) {
    const error = new Error('Workspace revision conflict: expected ' + request.baseRevision + ', current ' + inputState.revision + '.');
    error.code = 'HEADLESS_REVISION_CONFLICT';
    error.revision = inputState.revision;
    throw error;
  }
  const state = clone(inputState);
  const results = request.operations.map(operation => applyOperation(state, operation));
  state.revision = inputState.revision + 1;
  state.updatedAt = new Date().toISOString();
  const receiptResults = results.map(item => {
    if (!item || typeof item !== 'object' || typeof item.previewSvg !== 'string') return clone(item);
    const compact = { ...item, previewSvgLength: item.previewSvg.length };
    delete compact.previewSvg;
    return compact;
  });
  state.headlessOperations = receipts.concat([{ id: request.operationId, hash: operationHash, revision: state.revision, results: receiptResults }]).slice(-MAX_RECEIPTS);
  return { state, replayed: false, revision: state.revision, results };
}

module.exports = { applyHeadlessBatch, MAX_OPERATIONS, MAX_RECEIPTS };
