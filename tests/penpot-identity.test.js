const test = require('node:test');
const assert = require('node:assert/strict');
const {
  UUID_RE,
  createPenpotIdentityAdapter,
  deriveUuid,
  penpotIdsForUser
} = require('../penpot-identity');

const user = { id: 'admin', provider: 'local', username: 'ADMIN', role: 'admin' };
const project = { id: 'project_1', name: 'Tienda', type: 'design', design: {} };

function makeAdapter(sessionUser = user) {
  const workspaceId = 'ws_local_admin';
  const state = {
    owner: { provider: 'local', id: 'admin' },
    revision: 3,
    projects: [project, { id: 'project_2', name: 'Otra pantalla' }]
  };
  return createPenpotIdentityAdapter({
    getSessionUser: async () => sessionUser,
    userWorkspaceId: value => 'ws_' + value.provider + '_' + value.id,
    readState: async id => {
      assert.equal(id, workspaceId);
      return structuredClone(state);
    },
    enforceSessionWorkspaceOwner: async (id, current, owner) => {
      assert.equal(id, workspaceId);
      if (current.owner.provider !== owner.provider || current.owner.id !== String(owner.id)) {
        throw new Error('workspace_owner_mismatch');
      }
      return current;
    }
  });
}

test('Penpot identity UUIDs are stable, valid and scoped by entity', () => {
  const first = penpotIdsForUser(user, 'ws_local_admin', project);
  const second = penpotIdsForUser(user, 'ws_local_admin', project);
  assert.deepEqual(first, second);
  for (const id of Object.values(first)) assert.equal(UUID_RE.test(id), true);
  assert.notEqual(first.fileId, first.projectId);
  assert.notEqual(first.fileId, penpotIdsForUser(user, 'ws_local_admin', { id: 'project_2' }).fileId);
  assert.notEqual(first.teamId, penpotIdsForUser(user, 'ws_other_user', project).teamId);
  assert.equal(deriveUuid('namespace', 'same'), deriveUuid('namespace', 'same'));
  assert.equal(deriveUuid('www.widgets.com'), '21f7f8de-8051-5b89-8680-0195ef798b6a');
});

test('authenticated session resolves only projects in its CodeLab workspace', async () => {
  const adapter = makeAdapter();
  const context = await adapter.resolveProject({}, 'project_1');
  assert.equal(context.workspaceId, 'ws_local_admin');
  assert.equal(context.project.id, 'project_1');
  assert.equal(context.ids.fileId, penpotIdsForUser(user, context.workspaceId, project).fileId);
  await assert.rejects(
    adapter.resolveProject({}, 'project_does_not_exist'),
    error => error.code === 'PENPOT_PROJECT_NOT_FOUND'
  );
});

test('file and team IDs are resolved against the authenticated workspace', async () => {
  const adapter = makeAdapter();
  const ids = penpotIdsForUser(user, 'ws_local_admin', project);
  const fileContext = await adapter.resolveFile({}, ids.fileId);
  assert.equal(fileContext.project.id, project.id);
  const teamContext = await adapter.resolveTeam({}, ids.teamId);
  assert.equal(teamContext.workspaceId, 'ws_local_admin');
  assert.equal(teamContext.ids.teamId, ids.teamId);

  await assert.rejects(
    adapter.resolveFile({}, penpotIdsForUser(user, 'ws_someone_else', project).fileId),
    error => error.code === 'PENPOT_FILE_NOT_FOUND'
  );
  await assert.rejects(
    adapter.resolveTeam({}, deriveUuid('codelab:penpot:team', 'ws_someone_else')),
    error => error.code === 'PENPOT_TEAM_NOT_FOUND'
  );
});

test('anonymous and invalid project selectors are rejected', async () => {
  const anonymous = makeAdapter(null);
  await assert.rejects(
    anonymous.resolveWorkspace({}),
    error => error.code === 'PENPOT_AUTHENTICATION_REQUIRED'
  );
  const adapter = makeAdapter();
  await assert.rejects(
    adapter.resolveProject({}, '../project_1'),
    error => error.code === 'PENPOT_INVALID_PROJECT_ID'
  );
  await assert.rejects(
    adapter.resolveFile({}, 'not-a-uuid'),
    error => error.code === 'PENPOT_INVALID_FILE_ID'
  );
});

test('workspace ownership failures never fall back to another account', async () => {
  const adapter = createPenpotIdentityAdapter({
    getSessionUser: async () => ({ id: 'intruder', provider: 'local' }),
    userWorkspaceId: value => 'ws_' + value.provider + '_' + value.id,
    readState: async () => ({
      owner: { provider: 'local', id: 'admin' },
      projects: [project]
    }),
    enforceSessionWorkspaceOwner: async () => {
      throw new Error('workspace_owner_mismatch');
    }
  });
  await assert.rejects(
    adapter.resolveWorkspace({}),
    error => error.code === 'PENPOT_WORKSPACE_FORBIDDEN'
  );
});
