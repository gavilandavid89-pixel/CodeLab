/* CodeLab ↔ Penpot host adapter.
 * This is the native boundary between Penpot's document model and CodeLab's
 * existing account/workspace/project store. It does not embed a remote app.
 */
(function (global) {
  'use strict';

  const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
  const API_TIMEOUT_MS = 20000;
  let saveQueue = Promise.resolve();

  function currentContext() {
    // These identifiers are top-level lexical bindings from app.js. This file
    // is loaded immediately after app.js, in the same classic-script realm.
    if (typeof workspaceId === 'undefined' || !workspaceId ||
        typeof currentProjectId === 'undefined' || !currentProjectId ||
        typeof workspaceToken === 'undefined' || !workspaceToken ||
        typeof projects === 'undefined' || !Array.isArray(projects)) {
      throw new Error('codelab_workspace_not_ready');
    }
    const project = projects.find(item => item && item.id === currentProjectId);
    if (!project) throw new Error('codelab_project_not_found');
    return {
      workspaceId,
      token: workspaceToken,
      projectId: currentProjectId,
      workspaceRevision: Number.isInteger(workspaceRevision) ? workspaceRevision : 0,
      project,
      user: typeof currentUser !== 'undefined' && currentUser
        ? { id: currentUser.id || null, username: currentUser.username || null, role: currentUser.role || null }
        : null
    };
  }

  function endpoint(context) {
    return '/api/workspace/' + encodeURIComponent(context.workspaceId) +
      '/projects/' + encodeURIComponent(context.projectId) + '/penpot-document';
  }

  async function request(method, context, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint(context), {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'x-workspace-token': context.token
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      let payload = null;
      try { payload = await response.json(); } catch (_) {}
      if (!response.ok) {
        const error = new Error(payload && payload.error || 'penpot_request_failed');
        error.status = response.status;
        error.payload = payload;
        throw error;
      }
      return payload || {};
    } finally {
      clearTimeout(timeout);
    }
  }

  function ensureProjectDocument(context, document, revision, updatedAt) {
    const project = context.project;
    if (!project.design || typeof project.design !== 'object' || Array.isArray(project.design)) {
      project.design = {};
    }
    project.design.penpotDocument = {
      format: 'penpot-native-document',
      version: 1,
      revision,
      updatedAt: updatedAt || new Date().toISOString(),
      data: document
    };
  }

  function emit(name, detail) {
    global.dispatchEvent(new CustomEvent(name, { detail }));
  }

  async function loadDocument() {
    const context = currentContext();
    const payload = await request('GET', context);
    if (!Number.isInteger(payload.workspaceRevision) || payload.workspaceRevision < 0) {
      throw new Error('penpot_invalid_workspace_revision');
    }
    workspaceRevision = payload.workspaceRevision;
    if (payload.document && typeof payload.document === 'object' && !Array.isArray(payload.document)) {
      ensureProjectDocument(context, payload.document, Number(payload.documentRevision) || 0);
    }
    emit('codelab:penpot-document-loaded', {
      projectId: context.projectId,
      document: payload.document || null,
      documentRevision: Number(payload.documentRevision) || 0,
      workspaceRevision: payload.workspaceRevision
    });
    return payload;
  }

  function saveDocument(document) {
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      return Promise.reject(new Error('penpot_document_must_be_an_object'));
    }
    let snapshot;
    let serialized;
    try {
      serialized = JSON.stringify(document);
      snapshot = JSON.parse(serialized);
    } catch (_) {
      return Promise.reject(new Error('penpot_document_not_serializable'));
    }
    if (new TextEncoder().encode(serialized).byteLength > MAX_DOCUMENT_BYTES) {
      return Promise.reject(new Error('penpot_document_too_large'));
    }

    // Serialize writes from this browser tab. The server's workspace revision
    // remains the cross-tab/device optimistic concurrency guard.
    const operation = async () => {
      const context = currentContext();
      const baseRevision = Number.isInteger(workspaceRevision) ? workspaceRevision : context.workspaceRevision;
      try {
        const payload = await request('PUT', context, { document: snapshot, baseRevision });
        if (!payload.ok || !Number.isInteger(payload.workspaceRevision)) {
          throw new Error('penpot_invalid_save_response');
        }
        workspaceRevision = payload.workspaceRevision;
        ensureProjectDocument(context, snapshot, Number(payload.documentRevision) || 1, payload.updatedAt);
        if (typeof saveLocalProjectsSnapshot === 'function') saveLocalProjectsSnapshot();
        emit('codelab:penpot-document-saved', {
          projectId: context.projectId,
          documentRevision: payload.documentRevision,
          workspaceRevision: payload.workspaceRevision,
          updatedAt: payload.updatedAt
        });
        return payload;
      } catch (error) {
        if (error.status === 409) {
          emit('codelab:penpot-conflict', {
            projectId: context.projectId,
            localDocument: snapshot,
            serverDocument: error.payload && error.payload.document || null,
            documentRevision: error.payload && error.payload.documentRevision || 0,
            workspaceRevision: error.payload && error.payload.workspaceRevision
          });
        }
        emit('codelab:penpot-save-error', { projectId: context.projectId, code: error.message, status: error.status || 0 });
        throw error;
      }
    };
    const next = saveQueue.then(operation, operation);
    saveQueue = next.catch(() => {});
    return next;
  }

  global.CodeLabPenpotHost = Object.freeze({
    version: 1,
    getContext: () => {
      const context = currentContext();
      return {
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        workspaceRevision: context.workspaceRevision,
        projectName: String(context.project.name || ''),
        user: context.user
      };
    },
    loadDocument,
    saveDocument
  });
})(window);
