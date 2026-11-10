import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('Penpot import is exposed in the existing mobile design toolbar and remains same-origin', async () => {
  const html = await read('public/index.html');
  const app = await read('public/app.js');
  assert.ok(html.includes('id="importPenpotArchiveButton"'));
  assert.ok(html.includes('id="penpotArchiveFile"'));
  assert.ok(html.includes('accept=".penpot,application/zip"'));
  assert.ok(app.includes('async function importPenpotArchive(file)'));
  assert.ok(app.includes("'/api/workspace/' + encodeURIComponent(workspaceId) + '/penpot/import'"));
  assert.ok(app.includes("'x-workspace-token': workspaceToken"));
  assert.ok(app.includes('await refreshWorkspaceFromServer()'));
  assert.ok(app.includes('openProject(project.id)'));\n  assert.ok(app.includes("window.dispatchEvent(new Event('codelab-workspace-ready'))"));
});
