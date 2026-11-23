import test from 'node:test';
import assert from 'node:assert/strict';
import { publishImportedCodeLabProjectToWorkspace, stableJsonStringify } from '../codelab-project-artifact-import.mjs';

function mockWorkspacePool(initialState, initialRevision = 3) {
  const calls = [];
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT state, revision')) {
        return { rowCount: 1, rows: [{ state: structuredClone(initialState), revision: initialRevision }] };
      }
      if (sql.startsWith('UPDATE public.codelab_workspace_states')) {
        const saved = JSON.parse(values[2]);
        return { rowCount: 1, rows: [{ revision: saved.revision }] };
      }
      throw new Error('Unexpected SQL in workspace publish test: ' + sql);
    },
  };
}

function webProject(id = 'imported-web') {
  return {
    id, name: 'Imported Web project', type: 'web',
    code: { html: '<main>Imported</main>', css: '', js: '' },
    design: { elements: [], frame: 'desktop', background: '#ffffff' },
    hasWebSpace: true, hasDesignSpace: true,
  };
}

test('publishes an imported Web project into the workspace state the UI loads', async () => {
  const existing = webProject('existing');
  const pool = mockWorkspacePool({ version: 5, revision: 3, projects: [existing], owner: null });
  const result = await publishImportedCodeLabProjectToWorkspace(pool, 'ws_test', webProject(), 'web');
  assert.equal(result.published, true);
  assert.equal(result.workspaceRevision, 4);
  assert.equal(result.projectCount, 2);
  assert.equal(result.replacedExisting, false);
  const saved = JSON.parse(pool.calls[1].values[2]);
  assert.equal(saved.projects[0].id, 'imported-web');
  assert.equal(saved.projects[0].code.html, '<main>Imported</main>');
});

test('updates a project with the same ID instead of creating duplicate dashboard entries', async () => {
  const previous = webProject('same-id');
  const pool = mockWorkspacePool({ version: 5, revision: 3, projects: [previous], owner: null });
  const next = { ...webProject('same-id'), name: 'Updated import' };
  const result = await publishImportedCodeLabProjectToWorkspace(pool, 'ws_test', next, 'web');
  assert.equal(result.replacedExisting, true);
  assert.equal(result.projectCount, 1);
  const saved = JSON.parse(pool.calls[1].values[2]);
  assert.equal(saved.projects.length, 1);
  assert.equal(saved.projects[0].name, 'Updated import');
});

test('validates imported Design layers before publishing them', async () => {
  const pool = mockWorkspacePool({ version: 5, revision: 3, projects: [], owner: null });
  const design = {
    ...webProject('imported-design'), type: 'design',
    design: { elements: [{ id: 'hero', type: 'heading' }] },
  };
  const result = await publishImportedCodeLabProjectToWorkspace(pool, 'ws_test', design, 'design');
  assert.equal(result.published, true);
  const saved = JSON.parse(pool.calls[1].values[2]);
  assert.equal(saved.projects[0].design.elements[0].id, 'hero');
});

test('does not publish PixelForge documents into the Web/Design workspace', async () => {
  const pool = mockWorkspacePool({ version: 5, revision: 3, projects: [], owner: null });
  const result = await publishImportedCodeLabProjectToWorkspace(pool, 'ws_test', {}, 'pixelforge');
  assert.deepEqual(result, { published: false, reason: 'editor_uses_dedicated_workspace' });
  assert.equal(pool.calls.length, 0);
});

test('canonical project JSON is stable when PostgreSQL JSONB reorders object keys', () => {
  const before = { id: 'stable', code: { html: '<h1>x</h1>', js: '', css: '' }, design: { frame: 'desktop', elements: [] } };
  const after = { design: { elements: [], frame: 'desktop' }, code: { css: '', js: '', html: '<h1>x</h1>' }, id: 'stable' };
  assert.equal(stableJsonStringify(before), stableJsonStringify(after));
});
