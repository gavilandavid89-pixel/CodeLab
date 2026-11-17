import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NATIVE_ACTIONS, validateCommandInput } from '../assistant-headless-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workerPath = path.join(root, 'agent-bridge-worker.mjs');
const source = fs.readFileSync(workerPath, 'utf8');

test('native bridge worker parses as valid JavaScript', () => {
  const result = spawnSync(process.execPath, ['--check', workerPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('native command mailbox registers direct CodeLab code operations', () => {
  assert.match(source, /case 'codelab_project_get_code'/);
  assert.match(source, /case 'codelab_project_update_code'/);
  assert.match(source, /persistenceVerified: true/);
  assert.match(source, /case 'codelab_project_capture_png'/);
  assert.match(source, /case 'codelab_project_record_video'/);
  assert.match(source, /recordCodeLabProjectVideo/);
  assert.match(source, /captureCodeLabProjectPng/);
  assert.match(source, /Only html, css and js fields can be updated/);
  assert.match(source, /500000/);
  assert.match(source, /async function mutateAdminWorkspace\(transform, options = \{\}\)/);
  assert.match(source, /expectedRevision === undefined && attempt < 2/);
  assert.match(source, /latestCode = \{ \.\.\.\(updated\[index\]\.code \|\| \{\}\) \}/);
  assert.match(source, /\}, \{ expectedRevision: payload\.base_revision \}\);/);
  assert.match(source, /codelab_project_get_code','codelab_project_update_code/);
  assert.match(source, /'codelab_project_capture_png','codelab_project_record_video'/);
  assert.match(source, /pg_get_constraintdef\(oid\) LIKE '%codelab_project_capture_png%'/);
  assert.match(source, /pg_get_constraintdef\(oid\) LIKE '%codelab_project_record_video%'/);
});

test('animation video export uses real Chromium recording and validates artifacts', () => {
  assert.match(source, /case 'pixelforge_export_animation_video'/);
  assert.match(source, /recordVideo: \{ dir: tempDir, size: \{ width, height \}, fps \}/);
  assert.match(source, /playwright-chromium-real-browser/);
  assert.match(source, /video\/webm/);
  assert.match(source, /NEON_STORAGE_HOST/);
  assert.match(source, /serializedFrameBytes > 16 \* 1024 \* 1024/);
  assert.match(source, /totalDurationMs > 60000/);
  assert.match(source, /pixelforge_export_animation_video/);
});


test('assistant headless client validates the supported command contract', () => {
  assert.ok(NATIVE_ACTIONS.includes('codelab_project_update_code'));
  assert.ok(NATIVE_ACTIONS.includes('pixelforge_export_animation_video'));
  assert.ok(NATIVE_ACTIONS.includes('codelab_project_capture_png'));
  assert.ok(NATIVE_ACTIONS.includes('codelab_project_record_video'));
  const clientSource = fs.readFileSync(path.join(root, 'assistant-headless-client.mjs'), 'utf8');
  assert.match(clientSource, /\/api\/health/);
  assert.match(clientSource, /CODELAB_BASE_URL/);
  assert.match(clientSource, /await wakeWorker\(\)/);
  assert.deepEqual(validateCommandInput('status', { operation: 'ping' }), {
    action: 'status', payload: { operation: 'ping' }, ttlMs: 120000
  });
  assert.throws(() => validateCommandInput('shell_exec', {}), /Unsupported CodeLab native action/);
  assert.throws(() => validateCommandInput('status', []), /payload must be a JSON object/);
  assert.throws(() => validateCommandInput('status', {}, 999), /TTL must be between/);
  assert.throws(() => validateCommandInput('status', {}, 900001), /TTL must be between/);
  assert.throws(() => validateCommandInput('status', { data: 'x'.repeat(2 * 1024 * 1024) }), /exceeds 2 MiB/);
});
