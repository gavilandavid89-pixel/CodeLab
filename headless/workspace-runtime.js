'use strict';

const crypto = require('node:crypto');
const { createDesignEngine } = require('./design-engine');
const componentLibrary = require('../public/component-library');
const designTools = require('../public/design-tools');

const MAX_OPERATIONS = 100;
const MAX_RECEIPTS = 200;
const PROJECT_ID = /^proj_[a-zA-Z0-9_-]{1,75}$/;

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
      const mode = operation.mode || 'replace';
      assert(source === 'main' || source === 'branch', 'Code source must be main or branch.');
      assert(['replace', 'append', 'prepend'].includes(mode), 'Code write mode must be replace, append, or prepend.');
      const target = source === 'branch' ? project.branch?.code : project.code;
      assert(target && typeof target === 'object', 'The requested code branch does not exist.');
      const keys = ['html', 'css', 'js'].filter(key => Object.prototype.hasOwnProperty.call(operation, key));
      assert(keys.length > 0, 'web.code.write requires html, css, or js.');
      for (const key of keys) {
        assert(typeof operation[key] === 'string' && operation[key].length <= 50000, key + ' chunk must be a string up to 50000 characters.');
        const current = typeof target[key] === 'string' ? target[key] : '';
        const next = mode === 'append' ? current + operation[key] : mode === 'prepend' ? operation[key] + current : operation[key];
        assert(next.length <= 500000, key + ' exceeds the 500000 character project limit.');
        target[key] = next;
      }
      project.updatedAt = new Date().toISOString();
      if (source === 'branch') project.branch.updatedAt = project.updatedAt;
      return { type: operation.type, projectId: project.id, source, updatedFields: keys };
    }
    case 'component.insert': {
      const project = findProject(state, operation.projectId);
      assert(project.type !== 'design', 'component.insert requires a web project.');
      assert(typeof operation.componentId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(operation.componentId),
        'component.insert requires a valid componentId.');
      const component = componentLibrary.getComponent(operation.componentId);
      assert(component, 'Component not found: ' + operation.componentId, 'HEADLESS_COMPONENT_NOT_FOUND');
      const marker = '<!-- codelab-component:' + component.id + ':v1 -->';
      const current = typeof project.code.html === 'string' ? project.code.html : '';
      if (current.includes(marker)) {
        return { type: operation.type, projectId: project.id, componentId: component.id, alreadyPresent: true };
      }
      const insertion = marker + '\n' + component.html;
      const next = /<\/body\s*>/i.test(current)
        ? current.replace(/<\/body\s*>/i, insertion + '\\n</body>')
        : current + (current ? '\n' : '') + insertion;
      assert(next.length <= 500000, 'component.insert would exceed the 500000 character HTML project limit.');
      project.code.html = next;
      project.updatedAt = new Date().toISOString();
      return { type: operation.type, projectId: project.id, componentId: component.id, componentName: component.name, inserted: true };
    }
    case 'design.tokens.apply': {
      const project = findProject(state, operation.projectId);
      assert(project.type !== 'design', 'design.tokens.apply requires a web project.');
      assert(operation.settings && typeof operation.settings === 'object' && !Array.isArray(operation.settings),
        'design.tokens.apply requires a settings object.');
      const settings = designTools.sanitizeSettings(operation.settings);
      const css = typeof project.code.css === 'string' ? project.code.css : '';
      const next = designTools.injectTokenBlock(css, designTools.toCssVariables(settings));
      assert(next.length <= 500000, 'design.tokens.apply would exceed the 500000 character CSS project limit.');
      project.code.css = next;
      project.updatedAt = new Date().toISOString();
      return {
        type: operation.type,
        projectId: project.id,
        updatedFields: ['css'],
        tokens: designTools.buildDesignTokens(settings)
      };
    }
    case 'design.batch': {
      const project = findProject(state, operation.projectId);
      assert(project.type === 'design' && project.design, 'design.batch requires an existing design project.');
      assert(Array.isArray(operation.operations) && operation.operations.length > 0 && operation.operations.length <= 500,
        'design.batch requires 1 to 500 design operations.');
      const result = createDesignEngine().transact(project, operation.operations, { expectedRevision: operation.expectedDesignRevision });
      Object.assign(project, result.project);
      project.updatedAt = new Date().toISOString();
      return {
        type: operation.type,
        projectId: project.id,
        designRevision: result.revision,
        operationCount: result.results.length,
        operationTypes: result.results.map(item => item.type),
        previewSvg: result.svg
      };
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


function queryHeadlessWorkspace(inputState, request) {
  assert(inputState && typeof inputState === 'object' && Array.isArray(inputState.projects),
    'A valid workspace state is required.', 'HEADLESS_INVALID_QUERY');
  assert(request && typeof request === 'object' && !Array.isArray(request),
    'A headless query is required.', 'HEADLESS_INVALID_QUERY');
  assert(typeof request.action === 'string', 'A query action is required.', 'HEADLESS_INVALID_QUERY');
  const args = request.args && typeof request.args === 'object' && !Array.isArray(request.args) ? request.args : {};
  let result;

  switch (request.action) {
    case 'component.search': {
      const query = args.query === undefined ? '' : args.query;
      const category = args.category === undefined ? '' : args.category;
      const limit = args.limit === undefined ? 20 : args.limit;
      assert(typeof query === 'string' && query.length <= 200, 'component.search query must be a string up to 200 characters.', 'HEADLESS_INVALID_QUERY');
      assert(typeof category === 'string' && category.length <= 100, 'component.search category must be a string up to 100 characters.', 'HEADLESS_INVALID_QUERY');
      assert(Number.isInteger(limit) && limit >= 1 && limit <= 50, 'component.search limit must be from 1 to 50.', 'HEADLESS_INVALID_QUERY');
      result = componentLibrary.searchComponents(query, category).slice(0, limit).map(item => ({
        id: item.id, name: item.name, category: item.category, description: item.description, tags: item.tags
      }));
      break;
    }
    case 'component.inspect': {
      assert(typeof args.componentId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(args.componentId),
        'component.inspect requires a valid componentId.', 'HEADLESS_INVALID_QUERY');
      const component = componentLibrary.getComponent(args.componentId);
      assert(component, 'Component not found: ' + args.componentId, 'HEADLESS_COMPONENT_NOT_FOUND');
      const maxChars = args.maxChars === undefined ? 5000 : args.maxChars;
      assert(Number.isInteger(maxChars) && maxChars >= 1000 && maxChars <= 7000,
        'component.inspect maxChars must be from 1000 to 7000.', 'HEADLESS_INVALID_QUERY');
      const standaloneHtml = componentLibrary.standaloneHtml(component);
      result = {
        id: component.id, name: component.name, category: component.category,
        description: component.description, tags: component.tags,
        standaloneHtml: standaloneHtml.slice(0, maxChars),
        originalLength: standaloneHtml.length,
        truncated: standaloneHtml.length > maxChars
      };
      break;
    }
    case 'design.tokens.generate': {
      assert(args.settings && typeof args.settings === 'object' && !Array.isArray(args.settings),
        'design.tokens.generate requires a settings object.', 'HEADLESS_INVALID_QUERY');
      const settings = designTools.sanitizeSettings(args.settings);
      result = {
        settings,
        tokens: designTools.buildDesignTokens(settings),
        cssVariables: designTools.toCssVariables(settings)
      };
      break;
    }
    case 'project.inspect': {
      const project = findProject(inputState, args.projectId);
      result = {
        id: project.id, name: project.name, type: project.type,
        createdAt: project.createdAt || null, updatedAt: project.updatedAt || null,
        codeLengths: Object.fromEntries(['html', 'css', 'js'].map(key => [key, typeof project.code?.[key] === 'string' ? project.code[key].length : 0])),
        branch: project.branch ? {
          id: project.branch.id || null,
          updatedAt: project.branch.updatedAt || null,
          codeLengths: Object.fromEntries(['html', 'css', 'js'].map(key => [key, typeof project.branch.code?.[key] === 'string' ? project.branch.code[key].length : 0]))
        } : null,
        design: project.design ? {
          frame: project.design.frame || null,
          canvasWidth: project.design.canvasWidth || null,
          canvasHeight: project.design.canvasHeight || null,
          revision: Number.isInteger(project.design.revision) ? project.design.revision : 0,
          elementCount: Array.isArray(project.design.elements) ? project.design.elements.length : 0,
          layoutMode: project.design.layoutMode || 'free'
        } : null
      };
      break;
    }
    case 'project.code.read': {
      const project = findProject(inputState, args.projectId);
      assert(project.type !== 'design', 'project.code.read requires a web project.', 'HEADLESS_INVALID_QUERY');
      const source = args.source || 'main';
      assert(source === 'main' || source === 'branch', 'project.code.read source must be main or branch.', 'HEADLESS_INVALID_QUERY');
      const target = source === 'branch' ? project.branch?.code : project.code;
      assert(target && typeof target === 'object', 'The requested code branch does not exist.', 'HEADLESS_INVALID_QUERY');
      const languages = args.languages === undefined ? ['html', 'css', 'js'] : args.languages;
      assert(Array.isArray(languages) && languages.length >= 1 && languages.length <= 3 &&
        languages.every(key => ['html', 'css', 'js'].includes(key)) && new Set(languages).size === languages.length,
        'project.code.read languages must be unique html/css/js fields.', 'HEADLESS_INVALID_QUERY');
      const maxChars = args.maxChars === undefined ? 20000 : args.maxChars;
      assert(Number.isInteger(maxChars) && maxChars >= 1 && maxChars <= 20000,
        'project.code.read maxChars must be from 1 to 20000.', 'HEADLESS_INVALID_QUERY');
      result = { projectId: project.id, source, fields: {} };
      for (const key of languages) {
        const value = typeof target[key] === 'string' ? target[key] : '';
        result.fields[key] = { value: value.slice(0, maxChars), originalLength: value.length, truncated: value.length > maxChars };
      }
      break;
    }
    case 'design.read': {
      const project = findProject(inputState, args.projectId);
      assert(project.type === 'design' && project.design, 'design.read requires a design project.', 'HEADLESS_INVALID_QUERY');
      const elements = Array.isArray(project.design.elements) ? project.design.elements : [];
      const limit = args.limit === undefined ? 200 : args.limit;
      assert(Number.isInteger(limit) && limit >= 1 && limit <= 500, 'design.read limit must be from 1 to 500.', 'HEADLESS_INVALID_QUERY');
      result = {
        projectId: project.id,
        canvas: {
          frame: project.design.frame || null,
          width: project.design.canvasWidth || 1440,
          height: project.design.canvasHeight || 900,
          background: project.design.background || '#ffffff',
          grid: !!project.design.grid,
          snapToGrid: !!project.design.snapToGrid,
          gridSize: project.design.gridSize || 8
        },
        layout: {
          mode: project.design.layoutMode || 'free',
          direction: project.design.layoutDirection || 'row',
          gap: project.design.layoutGap || 0,
          padding: project.design.layoutPadding || 0
        },
        revision: Number.isInteger(project.design.revision) ? project.design.revision : 0,
        elements: elements.slice(0, limit).map(item => ({
          id: item.id, type: item.type, label: item.label || '', text: String(item.text || '').slice(0, 2000),
          x: item.x, y: item.y, width: item.width, height: item.height,
          color: item.color, background: item.background, fontSize: item.fontSize,
          weight: item.weight, radius: item.radius, href: item.href, alt: item.alt,
          objectFit: item.objectFit, visible: item.visible, locked: item.locked, flowRole: item.flowRole,
          hasImageSource: typeof item.src === 'string' && item.src.length > 0,
          imageSourceLength: typeof item.src === 'string' ? item.src.length : 0
        })),
        elementCount: elements.length,
        truncated: elements.length > limit,
        flowConnections: Array.isArray(project.design.flowConnections) ? clone(project.design.flowConnections) : []
      };
      break;
    }
    case 'accessibility.audit': {
      const project = findProject(inputState, args.projectId);
      assert(project.type !== 'design', 'accessibility.audit requires a web project.', 'HEADLESS_INVALID_QUERY');
      result = designTools.auditHtml(project.code.html || '');
      break;
    }
    default:
      assert(false, 'Unsupported headless query: ' + request.action, 'HEADLESS_INVALID_QUERY');
  }
  return { revision: inputState.revision, action: request.action, result };
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

module.exports = { applyHeadlessBatch, queryHeadlessWorkspace, MAX_OPERATIONS, MAX_RECEIPTS };
