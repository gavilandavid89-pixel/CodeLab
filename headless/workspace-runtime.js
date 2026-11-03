'use strict';

const crypto = require('node:crypto');
const { createDesignEngine } = require('./design-engine');
const componentLibrary = require('../public/component-library');
const designTools = require('../public/design-tools');
const { createDesignTemplate, TEMPLATE_INFO } = require('./design-templates');
const designExport = require('./design-export');
const { auditDesignAccessibility } = require('./design-accessibility');

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

function removeDeletedTargetFromDesignSnapshot(snapshot, targetProjectId) {
  let design;
  try {
    design = typeof snapshot === 'string' ? JSON.parse(snapshot) : clone(snapshot);
  } catch (_) {
    return snapshot;
  }
  if (!design || typeof design !== 'object' || Array.isArray(design)) return snapshot;
  const connections = Array.isArray(design.flowConnections) ? design.flowConnections : [];
  const removedSourceIds = new Set(connections
    .filter(item => item && item.targetProjectId === targetProjectId)
    .map(item => item.sourceElementId));
  design.flowConnections = connections.filter(item => item && item.targetProjectId !== targetProjectId);
  if (Array.isArray(design.elements)) {
    for (const sourceElementId of removedSourceIds) {
      const stillConnected = design.flowConnections.some(item => item && item.sourceElementId === sourceElementId);
      if (stillConnected) continue;
      const source = design.elements.find(item => item && item.id === sourceElementId);
      if (source && source.flowRole === 'navigate') source.flowRole = '';
    }
  }
  return typeof snapshot === 'string' ? JSON.stringify(design) : design;
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
      duplicate.name = typeof operation.name === 'string' && operation.name.trim()
        ? operation.name.trim().slice(0, 200)
        : (String(source.name || 'Project').slice(0, 195) + ' copy').slice(0, 200);
      duplicate.createdAt = new Date().toISOString();
      duplicate.updatedAt = duplicate.createdAt;
      if (duplicate.type === 'design' && duplicate.design && Array.isArray(duplicate.design.flowConnections)) {
        duplicate.design.flowConnections = duplicate.design.flowConnections.map(connection =>
          connection && connection.targetProjectId === source.id
            ? { ...connection, targetProjectId: newProjectId }
            : connection);
      }
      delete duplicate.branch;
      delete duplicate.mergeHistory;
      delete duplicate.designUndoStack;
      delete duplicate.designRedoStack;
      state.projects.push(duplicate);
      return { type: operation.type, sourceProjectId: source.id, projectId: duplicate.id, name: duplicate.name };
    }
    case 'branch.create': {
      const project = findProject(state, operation.projectId);
      assert(project.type !== 'design', 'branch.create requires a web project.');
      if (project.branch && operation.replaceExisting !== true) {
        assert(false, 'A working branch already exists; inspect it or explicitly approve replacing it.');
      }
      if (project.branch && operation.replaceExisting === true) {
        assert(operation.approved === true, 'Replacing an existing branch requires approved:true.');
      }
      const branchId = operation.branchId || 'branch_' + crypto.randomUUID();
      assert(typeof branchId === 'string' && /^branch_[a-zA-Z0-9_-]{1,100}$/.test(branchId),
        'branch.create requires a valid branchId.');
      const baseCode = clone(project.code || { html: '', css: '', js: '' });
      const now = new Date().toISOString();
      project.branch = {
        id: branchId,
        baseCode,
        code: clone(baseCode),
        baseMainUpdatedAt: project.updatedAt || now,
        updatedAt: now
      };
      project.updatedAt = now;
      return { type: operation.type, projectId: project.id, branchId, created: true };
    }
    case 'branch.merge': {
      const project = findProject(state, operation.projectId);
      assert(operation.approved === true, 'Merging a working branch requires approved:true.');
      assert(project.type !== 'design' && project.branch, 'branch.merge requires an existing web-project branch.');
      const main = project.code || {};
      const base = project.branch.baseCode || {};
      const branchCode = project.branch.code || {};
      const merged = {};
      const conflicts = [];
      for (const key of ['html', 'css', 'js']) {
        const mainValue = main[key] || '';
        const baseValue = base[key] || '';
        const branchValue = branchCode[key] || '';
        if (mainValue === baseValue) merged[key] = branchValue;
        else if (branchValue === baseValue || mainValue === branchValue) merged[key] = mainValue;
        else conflicts.push(key.toUpperCase());
      }
      if (conflicts.length) {
        const error = new Error('Branch merge conflict in: ' + conflicts.join(', ') + '. No main-project changes were applied.');
        error.code = 'HEADLESS_BRANCH_CONFLICT';
        error.conflicts = conflicts;
        throw error;
      }
      const now = new Date().toISOString();
      const backup = {
        code: clone(project.code || { html: '', css: '', js: '' }),
        mergedCodeHash: hash(merged),
        updatedAt: project.updatedAt || now,
        branch: clone(project.branch),
        createdAt: now
      };
      project.mergeHistory = Array.isArray(project.mergeHistory) ? project.mergeHistory : [];
      project.mergeHistory.push(backup);
      project.mergeHistory = project.mergeHistory.slice(-10);
      project.code = merged;
      project.updatedAt = now;
      delete project.branch;
      return { type: operation.type, projectId: project.id, mergedFields: ['html', 'css', 'js'], backupCount: project.mergeHistory.length };
    }
    case 'branch.undo_merge': {
      const project = findProject(state, operation.projectId);
      assert(operation.approved === true, 'Undoing a branch merge requires approved:true.');
      assert(Array.isArray(project.mergeHistory) && project.mergeHistory.length > 0,
        'branch.undo_merge requires a saved merge backup.', 'HEADLESS_NO_MERGE_HISTORY');
      const backup = project.mergeHistory[project.mergeHistory.length - 1];
      assert(backup && typeof backup === 'object' && !Array.isArray(backup) &&
        backup.code && typeof backup.code === 'object' && !Array.isArray(backup.code),
        'Saved merge history entry is invalid.', 'HEADLESS_INVALID_MERGE_HISTORY');
      assert(!project.branch,
        'Cannot undo the merge because a new branch was created afterward; inspect it before retrying.',
        'HEADLESS_BRANCH_UNDO_CONFLICT');
      const currentCode = project.code || { html: '', css: '', js: '' };
      const normalizedCurrentCode = {
        html: typeof currentCode.html === 'string' ? currentCode.html : '',
        css: typeof currentCode.css === 'string' ? currentCode.css : '',
        js: typeof currentCode.js === 'string' ? currentCode.js : ''
      };
      const mergedCode = backup.mergedCode;
      const matchesMergedCode = typeof backup.mergedCodeHash === 'string'
        ? hash(normalizedCurrentCode) === backup.mergedCodeHash
        : mergedCode && ['html', 'css', 'js'].every(key =>
          (typeof currentCode[key] === 'string' ? currentCode[key] : '') ===
          (typeof mergedCode[key] === 'string' ? mergedCode[key] : ''));
      const legacyBackupUnchanged = !backup.mergedCodeHash && !mergedCode && backup.createdAt && project.updatedAt === backup.createdAt;
      assert(matchesMergedCode || legacyBackupUnchanged,
        'Cannot undo the merge because main code changed afterward; inspect the new changes before retrying.',
        'HEADLESS_BRANCH_UNDO_CONFLICT');
      project.mergeHistory = project.mergeHistory.slice(0, -1);
      project.code = clone(backup.code || { html: '', css: '', js: '' });
      project.updatedAt = new Date().toISOString();
      if (backup.branch) project.branch = clone(backup.branch);
      else delete project.branch;
      return { type: operation.type, projectId: project.id, restoredBranch: !!backup.branch, remainingBackups: project.mergeHistory.length };
    }
    case 'design.history.undo':
    case 'design.history.redo': {
      const project = findProject(state, operation.projectId);
      assert(project.type === 'design' && project.design, operation.type + ' requires a design project.');
      if (!Array.isArray(project.designUndoStack)) project.designUndoStack = [];
      if (!Array.isArray(project.designRedoStack)) project.designRedoStack = [];
      const undo = operation.type === 'design.history.undo';
      const source = undo ? project.designUndoStack : project.designRedoStack;
      const target = undo ? project.designRedoStack : project.designUndoStack;
      assert(source.length > 0, operation.type + ' has no saved history entry.',
        undo ? 'HEADLESS_NO_DESIGN_UNDO' : 'HEADLESS_NO_DESIGN_REDO');
      const snapshot = source.pop();
      let restored;
      try {
        restored = typeof snapshot === 'string' ? JSON.parse(snapshot) : clone(snapshot);
      } catch (_) {
        assert(false, 'Saved design history entry is invalid.', 'HEADLESS_INVALID_DESIGN_HISTORY');
      }
      assert(restored && typeof restored === 'object' && Array.isArray(restored.elements),
        'Saved design history entry has an invalid shape.', 'HEADLESS_INVALID_DESIGN_HISTORY');
      target.push(JSON.stringify(project.design));
      if (target.length > 60) target.shift();
      const nextRevision = (Number.isInteger(project.design.revision) ? project.design.revision : 0) + 1;
      project.design = restored;
      project.design.revision = nextRevision;
      project.updatedAt = new Date().toISOString();
      return { type: operation.type, projectId: project.id, designRevision: nextRevision, canUndo: project.designUndoStack.length > 0, canRedo: project.designRedoStack.length > 0 };
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
    case 'design.import.json': {
      assert(state.projects.length < 500, 'Workspace project limit reached.');
      assert(typeof operation.json === 'string' && operation.json.length >= 2,
        'design.import.json requires a JSON string.');
      const project = designExport.importDesignJson(operation.json);
      assert(!state.projects.some(item => item.id === project.id), 'Imported project ID already exists.');
      state.projects.push(project);
      return { type: operation.type, projectId: project.id, name: project.name, elementCount: project.design.elements.length };
    }
    case 'design.convert.toWeb': {
      const project = findProject(state, operation.projectId);
      assert(project.type === 'design' && project.design, 'design.convert.toWeb requires a design project.');
      const code = designExport.convertDesignToWeb(project, state.projects);
      assert(code.html.length <= 500000, 'The converted HTML exceeds the 500000 character project limit.');
      project.code = code;
      project.type = 'web';
      project.hasWebSpace = true;
      project.hasDesignSpace = true;
      project.updatedAt = new Date().toISOString();
      return { type: operation.type, projectId: project.id, updatedFields: ['type', 'code'], htmlLength: code.html.length, designPreserved: !!project.design };
    }
    case 'design.template.apply': {
      const project = findProject(state, operation.projectId);
      assert(project.type === 'design' && project.design, 'design.template.apply requires an existing design project.');
      if (Array.isArray(project.design.elements) && project.design.elements.length > 0 && operation.replaceExisting !== true) {
        assert(false, 'The template would replace existing layers; set replaceExisting:true and approved:true to continue.',
          'HEADLESS_TEMPLATE_REPLACE_REQUIRED');
      }
      if (operation.replaceExisting === true) {
        assert(operation.approved === true, 'Replacing design layers with a template requires approved:true.');
      }
      const template = createDesignTemplate(operation.templateId, project.design);
      if (!Array.isArray(project.designUndoStack)) project.designUndoStack = [];
      if (!Array.isArray(project.designRedoStack)) project.designRedoStack = [];
      project.designUndoStack.push(JSON.stringify(project.design));
      if (project.designUndoStack.length > 60) project.designUndoStack.shift();
      project.designRedoStack = [];
      project.design.background = template.background;
      project.design.elements = template.elements;
      project.design.canvasHeight = template.canvasHeight;
      if (project.design.canvas && typeof project.design.canvas === 'object' && !Array.isArray(project.design.canvas)) {
        project.design.canvas.height = template.canvasHeight;
      }
      project.design.revision = (Number.isInteger(project.design.revision) ? project.design.revision : 0) + 1;
      project.updatedAt = new Date().toISOString();
      return {
        type: operation.type, projectId: project.id, templateId: template.templateId,
        elementCount: template.elements.length, canvasWidth: template.canvasWidth,
        canvasHeight: template.canvasHeight, compact: template.compact, designRevision: project.design.revision
      };
    }
    case 'design.batch': {
      const project = findProject(state, operation.projectId);
      assert(project.type === 'design' && project.design, 'design.batch requires an existing design project.');
      assert(Array.isArray(operation.operations) && operation.operations.length > 0 && operation.operations.length <= 500,
        'design.batch requires 1 to 500 design operations.');
      if (!Array.isArray(project.designUndoStack)) project.designUndoStack = [];
      if (!Array.isArray(project.designRedoStack)) project.designRedoStack = [];
      project.designUndoStack.push(JSON.stringify(project.design));
      if (project.designUndoStack.length > 60) project.designUndoStack.shift();
      project.designRedoStack = [];
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
      const existingForSource = sourceProject.design.flowConnections.filter(item => item && item.sourceElementId === source.id);
      if (existingForSource.length === 1 && existingForSource[0].targetProjectId === targetProject.id && source.flowRole === 'navigate') {
        return { type: operation.type, sourceProjectId: sourceProject.id, sourceElementId: source.id, targetProjectId: targetProject.id, designRevision: sourceProject.design.revision || 0, changed: false };
      }
      if (!Array.isArray(sourceProject.designUndoStack)) sourceProject.designUndoStack = [];
      if (!Array.isArray(sourceProject.designRedoStack)) sourceProject.designRedoStack = [];
      sourceProject.designUndoStack.push(JSON.stringify(sourceProject.design));
      if (sourceProject.designUndoStack.length > 60) sourceProject.designUndoStack.shift();
      sourceProject.designRedoStack = [];
      sourceProject.design.flowConnections = sourceProject.design.flowConnections.filter(item => !item || item.sourceElementId !== source.id);
      sourceProject.design.flowConnections.push({ sourceElementId: source.id, targetProjectId: targetProject.id });
      source.flowRole = 'navigate';
      sourceProject.design.revision = (Number.isInteger(sourceProject.design.revision) ? sourceProject.design.revision : 0) + 1;
      sourceProject.updatedAt = new Date().toISOString();
      return { type: operation.type, sourceProjectId: sourceProject.id, sourceElementId: source.id, targetProjectId: targetProject.id, designRevision: sourceProject.design.revision, changed: true };
    }
    case 'design.flow.disconnect': {
      const sourceProject = findProject(state, operation.sourceProjectId);
      assert(sourceProject.type === 'design' && sourceProject.design, 'design.flow.disconnect requires a design source project.');
      assert(typeof operation.sourceElementId === 'string', 'sourceElementId is required.');
      const source = sourceProject.design.elements.find(item => item.id === operation.sourceElementId);
      const connections = Array.isArray(sourceProject.design.flowConnections) ? sourceProject.design.flowConnections : [];
      const remainingConnections = connections.filter(item =>
        !(item && item.sourceElementId === operation.sourceElementId && (!operation.targetProjectId || item.targetProjectId === operation.targetProjectId))
      );
      const removed = connections.length - remainingConnections.length;
      const hasRemainingConnectionForSource = remainingConnections.some(item => item && item.sourceElementId === operation.sourceElementId);
      const clearStaleRole = !!source && source.flowRole === 'navigate' && !hasRemainingConnectionForSource;
      if (removed === 0 && !clearStaleRole) {
        return { type: operation.type, sourceProjectId: sourceProject.id, sourceElementId: operation.sourceElementId, removed: 0, designRevision: sourceProject.design.revision || 0, changed: false };
      }
      if (!Array.isArray(sourceProject.designUndoStack)) sourceProject.designUndoStack = [];
      if (!Array.isArray(sourceProject.designRedoStack)) sourceProject.designRedoStack = [];
      sourceProject.designUndoStack.push(JSON.stringify(sourceProject.design));
      if (sourceProject.designUndoStack.length > 60) sourceProject.designUndoStack.shift();
      sourceProject.designRedoStack = [];
      sourceProject.design.flowConnections = remainingConnections;
      if (clearStaleRole) source.flowRole = '';
      sourceProject.design.revision = (Number.isInteger(sourceProject.design.revision) ? sourceProject.design.revision : 0) + 1;
      sourceProject.updatedAt = new Date().toISOString();
      return { type: operation.type, sourceProjectId: sourceProject.id, sourceElementId: operation.sourceElementId, removed, designRevision: sourceProject.design.revision, changed: true };
    }
    case 'project.delete': {
      assert(operation.approved === true, 'project.delete requires explicit approval.');
      const project = findProject(state, operation.projectId);
      const index = state.projects.findIndex(item => item.id === project.id);
      state.projects.splice(index, 1);
      const changedAt = new Date().toISOString();
      for (const other of state.projects) {
        let changed = false;
        if (other.type === 'design' && other.design && Array.isArray(other.design.flowConnections)) {
          const previousConnections = other.design.flowConnections;
          const removedSourceIds = new Set(previousConnections
            .filter(item => item && item.targetProjectId === project.id)
            .map(item => item.sourceElementId));
          const remainingConnections = previousConnections.filter(item => item && item.targetProjectId !== project.id);
          if (remainingConnections.length !== previousConnections.length) {
            other.design.flowConnections = remainingConnections;
            if (Array.isArray(other.design.elements)) {
              for (const sourceElementId of removedSourceIds) {
                const stillConnected = remainingConnections.some(item => item && item.sourceElementId === sourceElementId);
                if (stillConnected) continue;
                const source = other.design.elements.find(item => item && item.id === sourceElementId);
                if (source && source.flowRole === 'navigate') source.flowRole = '';
              }
            }
            other.design.revision = (Number.isInteger(other.design.revision) ? other.design.revision : 0) + 1;
            for (const historyName of ['designUndoStack', 'designRedoStack']) {
              if (Array.isArray(other[historyName])) {
                other[historyName] = other[historyName].map(snapshot =>
                  removeDeletedTargetFromDesignSnapshot(snapshot, project.id));
              }
            }
            changed = true;
          }
        }
        if (other.sourceDesignProjectId === project.id) {
          delete other.sourceDesignProjectId;
          changed = true;
        }
        if (changed) other.updatedAt = changedAt;
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
    case 'design.capture.context': {
      const project = findProject(inputState, args.projectId);
      assert(project.type === 'design' && project.design, 'design.capture.context requires a design project.', 'HEADLESS_INVALID_QUERY');
      const scale = args.scale === undefined ? 2 : args.scale;
      result = designExport.buildAiDesignCaptureContext(project, scale);
      break;
    }
    case 'design.export.json': {
      const project = findProject(inputState, args.projectId);
      assert(project.type === 'design' && project.design, 'design.export.json requires a design project.', 'HEADLESS_INVALID_QUERY');
      result = designExport.exportDesignJson(project);
      break;
    }
    case 'design.export.svg': {
      const project = findProject(inputState, args.projectId);
      assert(project.type === 'design' && project.design, 'design.export.svg requires a design project.', 'HEADLESS_INVALID_QUERY');
      result = { svg: designExport.exportDesignSvg(project) };
      break;
    }
    case 'design.export.html': {
      const project = findProject(inputState, args.projectId);
      assert(project.type === 'design' && project.design, 'design.export.html requires a design project.', 'HEADLESS_INVALID_QUERY');
      result = { html: designExport.exportDesignHtml(project, inputState.projects) };
      break;
    }
    case 'headless.operation.status': {
      assert(typeof args.operationId === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(args.operationId),
        'headless.operation.status requires a valid operationId.', 'HEADLESS_INVALID_QUERY');
      const requestKey = args.requestKey;
      if (requestKey !== undefined) {
        assert(typeof requestKey === 'string' && /^[a-f0-9]{64}$/i.test(requestKey),
          'headless.operation.status requestKey must be a SHA-256 hex digest.', 'HEADLESS_INVALID_QUERY');
      }
      const receipts = Array.isArray(inputState.headlessOperations) ? inputState.headlessOperations : [];
      const previous = receipts.find(item => item && item.id === args.operationId);
      if (previous && requestKey !== undefined && previous.requestKey !== requestKey) {
        assert(false, 'operationId was already used for a different request.', 'HEADLESS_IDEMPOTENCY_CONFLICT');
      }
      result = previous
        ? { found: true, revision: previous.revision, requestKey: previous.requestKey || null, results: clone(previous.results || []) }
        : { found: false, revision: inputState.revision };
      break;
    }
    case 'design.template.list': {
      result = clone(TEMPLATE_INFO);
      break;
    }
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
    case 'branch.inspect': {
      const project = findProject(inputState, args.projectId);
      result = {
        projectId: project.id,
        exists: !!project.branch,
        mergeHistoryCount: Array.isArray(project.mergeHistory) ? project.mergeHistory.length : 0,
        branch: project.branch ? {
          id: project.branch.id || null,
          baseMainUpdatedAt: project.branch.baseMainUpdatedAt || null,
          updatedAt: project.branch.updatedAt || null,
          codeLengths: Object.fromEntries(['html', 'css', 'js'].map(key => [key, typeof project.branch.code?.[key] === 'string' ? project.branch.code[key].length : 0]))
        } : null
      };
      break;
    }
    case 'design.history.inspect': {
      const project = findProject(inputState, args.projectId);
      assert(project.type === 'design' && project.design, 'design.history.inspect requires a design project.', 'HEADLESS_INVALID_QUERY');
      result = {
        projectId: project.id,
        canUndo: Array.isArray(project.designUndoStack) && project.designUndoStack.length > 0,
        canRedo: Array.isArray(project.designRedoStack) && project.designRedoStack.length > 0,
        undoCount: Array.isArray(project.designUndoStack) ? project.designUndoStack.length : 0,
        redoCount: Array.isArray(project.designRedoStack) ? project.designRedoStack.length : 0
      };
      break;
    }
    case 'project.list': {
      result = {
        count: inputState.projects.length,
        projects: inputState.projects.map(project => ({
          id: project.id,
          name: project.name,
          type: project.type === 'design' ? 'design' : 'web',
          createdAt: project.createdAt || null,
          updatedAt: project.updatedAt || null,
          hasBranch: !!project.branch,
          branchId: project.branch?.id || null,
          branchUpdatedAt: project.branch?.updatedAt || null,
          mergeUndoAvailable: Array.isArray(project.mergeHistory) && project.mergeHistory.length > 0
        }))
      };
      break;
    }
    case 'project.inspect': {
      const project = findProject(inputState, args.projectId);
      result = {
        id: project.id, name: project.name, type: project.type,
        createdAt: project.createdAt || null, updatedAt: project.updatedAt || null,
        codeLengths: Object.fromEntries(['html', 'css', 'js'].map(key => [key, typeof project.code?.[key] === 'string' ? project.code[key].length : 0])),
        mergeHistoryCount: Array.isArray(project.mergeHistory) ? project.mergeHistory.length : 0,
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
      assert(Number.isInteger(maxChars) && maxChars >= 1 && maxChars <= 200000,
        'project.code.read maxChars must be from 1 to 200000.', 'HEADLESS_INVALID_QUERY');
      const offset = args.offset === undefined ? 0 : args.offset;
      assert(Number.isInteger(offset) && offset >= 0 && offset <= 500000,
        'project.code.read offset must be an integer from 0 to 500000.', 'HEADLESS_INVALID_QUERY');
      result = { projectId: project.id, source, offset, maxChars, fields: {} };
      for (const key of languages) {
        const value = typeof target[key] === 'string' ? target[key] : '';
        const end = Math.min(value.length, offset + maxChars);
        result.fields[key] = {
          value: value.slice(offset, end),
          originalLength: value.length,
          offset,
          nextOffset: end < value.length ? end : null,
          truncated: end < value.length
        };
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
          weight: item.weight, radius: item.radius, opacity: item.opacity, rotation: item.rotation,
          textAlign: item.textAlign, href: item.href, alt: item.alt,
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
    case 'design.accessibility.audit': {
      const project = findProject(inputState, args.projectId);
      assert(project.type === 'design' && project.design, 'design.accessibility.audit requires a design project.', 'HEADLESS_INVALID_QUERY');
      result = auditDesignAccessibility(project);
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
  const requestKey = request.operations[0] && request.operations[0].headlessAiRequestKey;
  if (requestKey !== undefined) assert(typeof requestKey === 'string' && /^[a-f0-9]{64}$/i.test(requestKey), 'headlessAiRequestKey must be a SHA-256 hex digest.');
  state.headlessOperations = receipts.concat([{ id: request.operationId, hash: operationHash, revision: state.revision, requestKey: requestKey || null, results: receiptResults }]).slice(-MAX_RECEIPTS);
  return { state, replayed: false, revision: state.revision, results };
}

module.exports = { applyHeadlessBatch, queryHeadlessWorkspace, MAX_OPERATIONS, MAX_RECEIPTS };
