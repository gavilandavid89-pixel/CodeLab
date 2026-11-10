/**
 * Maps CodeLab accounts/workspaces/projects to stable Penpot UUID identities.
 *
 * IDs are identifiers only, never credentials. Every resolver derives the
 * workspace from the authenticated CodeLab session and checks project
 * membership in that workspace before returning a Penpot mapping.
 */
'use strict';

const crypto = require('node:crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function deriveUuid(namespace, ...parts) {
  const name = [namespace, ...parts.map(value => String(value))].join('\0');
  const bytes = crypto.createHash('sha1').update(name, 'utf8').digest().subarray(0, 16);
  // RFC 4122 name-based UUID (version 5) and variant bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join('-');
}

function penpotIdsForUser(user, workspaceId, project) {
  if (!user || !workspaceId || !project || !PROJECT_ID_RE.test(String(project.id || ''))) {
    throw Object.assign(new Error('invalid_penpot_identity_input'), {
      status: 400,
      code: 'INVALID_PENPOT_IDENTITY_INPUT'
    });
  }
  return Object.freeze({
    profileId: deriveUuid('codelab:penpot:profile', user.provider, user.id),
    teamId: deriveUuid('codelab:penpot:team', workspaceId),
    projectId: deriveUuid('codelab:penpot:project', workspaceId, project.id),
    fileId: deriveUuid('codelab:penpot:file', workspaceId, project.id)
  });
}

function createPenpotIdentityAdapter(dependencies) {
  const {
    getSessionUser,
    userWorkspaceId,
    readState,
    enforceSessionWorkspaceOwner
  } = dependencies || {};

  for (const [name, fn] of Object.entries({
    getSessionUser,
    userWorkspaceId,
    readState,
    enforceSessionWorkspaceOwner
  })) {
    if (typeof fn !== 'function') {
      throw new TypeError('penpot_identity_dependency_required:' + name);
    }
  }

  async function resolveWorkspace(req) {
    const user = await getSessionUser(req);
    if (!user || user.id == null || !user.provider) {
      throw Object.assign(new Error('authentication_required'), {
        status: 401,
        code: 'PENPOT_AUTHENTICATION_REQUIRED'
      });
    }

    const workspaceId = userWorkspaceId(user);
    if (typeof workspaceId !== 'string' || !workspaceId) {
      throw Object.assign(new Error('workspace_context_unavailable'), {
        status: 403,
        code: 'PENPOT_WORKSPACE_FORBIDDEN'
      });
    }

    let state;
    try {
      state = await readState(workspaceId);
      state = await enforceSessionWorkspaceOwner(workspaceId, state, user);
    } catch (cause) {
      throw Object.assign(new Error('workspace_access_denied'), {
        status: 403,
        code: 'PENPOT_WORKSPACE_FORBIDDEN',
        cause
      });
    }

    if (!state || !Array.isArray(state.projects)) {
      throw Object.assign(new Error('workspace_state_invalid'), {
        status: 500,
        code: 'PENPOT_WORKSPACE_STATE_INVALID'
      });
    }

    return { user, workspaceId, state };
  }

  async function resolveProject(req, projectId) {
    if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) {
      throw Object.assign(new Error('invalid_project_id'), {
        status: 400,
        code: 'PENPOT_INVALID_PROJECT_ID'
      });
    }
    const context = await resolveWorkspace(req);
    const project = context.state.projects.find(item => item && item.id === projectId);
    if (!project) {
      throw Object.assign(new Error('project_not_found'), {
        status: 404,
        code: 'PENPOT_PROJECT_NOT_FOUND'
      });
    }
    return Object.freeze({
      ...context,
      project,
      ids: penpotIdsForUser(context.user, context.workspaceId, project)
    });
  }

  async function resolveFile(req, fileId) {
    if (typeof fileId !== 'string' || !UUID_RE.test(fileId)) {
      throw Object.assign(new Error('invalid_file_id'), {
        status: 400,
        code: 'PENPOT_INVALID_FILE_ID'
      });
    }
    const context = await resolveWorkspace(req);
    const project = context.state.projects.find(item => {
      if (!item || typeof item.id !== 'string') return false;
      return penpotIdsForUser(context.user, context.workspaceId, item).fileId === fileId;
    });
    if (!project) {
      throw Object.assign(new Error('file_not_found'), {
        status: 404,
        code: 'PENPOT_FILE_NOT_FOUND'
      });
    }
    return Object.freeze({
      ...context,
      project,
      ids: penpotIdsForUser(context.user, context.workspaceId, project)
    });
  }

  async function resolveTeam(req, teamId) {
    if (typeof teamId !== 'string' || !UUID_RE.test(teamId)) {
      throw Object.assign(new Error('invalid_team_id'), {
        status: 400,
        code: 'PENPOT_INVALID_TEAM_ID'
      });
    }
    const context = await resolveWorkspace(req);
    const expected = deriveUuid('codelab:penpot:team', context.workspaceId);
    if (teamId !== expected) {
      throw Object.assign(new Error('team_not_found'), {
        status: 404,
        code: 'PENPOT_TEAM_NOT_FOUND'
      });
    }
    return Object.freeze({
      ...context,
      ids: Object.freeze({
        profileId: deriveUuid('codelab:penpot:profile', context.user.provider, context.user.id),
        teamId: expected
      })
    });
  }

  return Object.freeze({
    resolveWorkspace,
    resolveProject,
    resolveFile,
    resolveTeam
  });
}

module.exports = {
  UUID_RE,
  createPenpotIdentityAdapter,
  deriveUuid,
  penpotIdsForUser
};
