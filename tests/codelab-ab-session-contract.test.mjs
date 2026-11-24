import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('A/B session JavaScript files parse cleanly', () => {
  for (const file of [
    'server.js',
    'pixelforge-video-composer-export.mjs',
    'scripts/codelab-ab-session-host.mjs',
    'scripts/codelab-ab-session-request.mjs'
  ]) {
    const checked = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
    assert.equal(checked.status, 0, file + ': ' + (checked.stderr || checked.stdout));
  }
});

test('A receives only the trusted ADMIN bridge and pins the persisted project snapshot', () => {
  const server = read('server.js');
  const a = read('scripts/codelab-ab-session-host.mjs');
  assert.match(server, /api\/agent\/bridge\/admin-handoff/);
  assert.match(server, /api\/agent\/bridge\/pixelforge\/projects/);
  assert.match(server, /safeTokenEqual\(supplied, AGENT_BRIDGE_CONTROL_SECRET\)/);
  assert.match(server, /public\.codelab_pixelforge_projects/);
  assert.match(a, /CODELAB_AGENT_BRIDGE_CONTROL_SECRET/);
  assert.match(a, /api\/agent\/bridge\/admin-handoff/);
  assert.match(a, /api\/agent\/bridge\/pixelforge\/projects/);
  assert.match(a, /api\/auth\/native-handoff/);
  assert.match(a, /api\/auth\/status/);
  assert.match(a, /user\?\.name !== 'ADMIN'/);
  assert.match(a, /ws_local_admin/);
  assert.match(a, /projectId, serverRevision: pinned\.serverRevision/);
  assert.match(a, /exportPixelForgeAnimationVideo/);
  assert.match(a, /persist_evidence: false/);
  assert.match(a, /browser,\s*context/);
  assert.match(a, /CodeLab A Ready/);
  assert.match(a, /since=\$\{encodeURIComponent\(sessionStartedAt\)\}/);
  assert.doesNotMatch(a, /DATABASE_URL|NEON_API_KEY|NEON_STORAGE_HOST|R2_SECRET_ACCESS_KEY/);
});

test('B is a request-only receiver and verifies the WebM with Chromium without credentials or FFmpeg', () => {
  const b = read('scripts/codelab-ab-session-request.mjs');
  assert.match(b, /CodeLab B Request/);
  assert.match(b, /CODELAB_REQUESTED_PROJECT_ID/);
  assert.match(b, /ready\.projectId !== requestedProjectId/);
  assert.match(b, /comments\(readySince\)/);
  assert.match(b, /comments\(requestStartedAt\)/);
  assert.match(b, /CodeLab A Video Chunk/);
  assert.match(b, /CodeLab A Export Result/);
  assert.match(b, /playwrightChromium\.launch/);
  assert.match(b, /HTMLVideoElement decode/);
  assert.match(b, /video\.readyState/);
  assert.match(b, /video\.videoWidth/);
  assert.match(b, /videoSha256/);
  assert.match(b, /CODELAB_AB_OUTPUT_DIR/);
  assert.doesNotMatch(b, /CODELAB_AGENT_BRIDGE_CONTROL_SECRET|DATABASE_URL|NEON_API_KEY|NEON_STORAGE_HOST|exportPixelForgeAnimationVideo|HeadlessEditorRuntime|ffmpeg|createDemo/);
});

test('the real A/B workflows isolate credentials and keep A independent from B', () => {
  const aWorkflow = read('.github/workflows/codelab-independent-session-a.yml');
  const bWorkflow = read('.github/workflows/codelab-independent-session-b.yml');
  const abWorkflow = read('.github/workflows/codelab-ab-animation.yml');
  assert.match(aWorkflow, /secrets\.CODELAB_AGENT_BRIDGE_CONTROL_SECRET/);
  assert.match(aWorkflow, /scripts\/codelab-ab-session-host\.mjs/);
  assert.match(aWorkflow, /codelab-qedi\.onrender\.com/);
  assert.doesNotMatch(bWorkflow, /CODELAB_AGENT_BRIDGE_CONTROL_SECRET|DATABASE_URL|NEON_API_KEY|NEON_STORAGE_HOST/);
  assert.match(bWorkflow, /scripts\/codelab-ab-session-request\.mjs/);
  assert.match(bWorkflow, /project_id:/);
  assert.match(bWorkflow, /CODELAB_REQUESTED_PROJECT_ID/);
  assert.match(bWorkflow, /actions\/upload-artifact@v4/);
  assert.match(abWorkflow, /codelab-independent-session-a\.yml/);
  assert.match(abWorkflow, /Verify A remains alive after B has finished/);
  assert.match(abWorkflow, /CODELAB_A_READY_SINCE/);
  assert.match(abWorkflow, /in_progress/);
  assert.doesNotMatch(abWorkflow, /createDemo=|walk-crouch-24|codelab-session-host\.mjs/);
});

test('Video Composer exporter can reuse A persistent browser/context without closing them', () => {
  const exporter = read('pixelforge-video-composer-export.mjs');
  assert.match(exporter, /let browser = deps\.browser \|\| null/);
  assert.match(exporter, /let context = deps\.context \|\| null/);
  assert.match(exporter, /const ownsBrowser = !deps\.browser/);
  assert.match(exporter, /const ownsContext = !deps\.context/);
  assert.match(exporter, /browser = browser \|\| await playwrightChromium\.launch/);
  assert.match(exporter, /context = context \|\| await browser\.newContext/);
  assert.match(exporter, /if \(ownsContext && context\)/);
  assert.match(exporter, /if \(ownsBrowser && browser\)/);
});

test('confirmed PixelForge project deletion also removes imported package resources', () => {
  const server = read('server.js');
  const editor = read('public/pixelforge/src/editor.js');
  const start = server.indexOf('async function deletePixelForgeProjectFromDatabase');
  const end = server.indexOf('\nasync function savePixelForgeProjectToDatabase', start);
  assert.ok(start >= 0 && end > start, 'PixelForge database delete helper exists');
  const deletion = server.slice(start, end);
  assert.match(editor, /window\.confirm\('Delete/);
  assert.match(editor, /await deleteProject\(project\.id\)/);
  assert.match(deletion, /DELETE FROM codelab_pixelforge_projects/);
  assert.match(deletion, /DELETE FROM public\.codelab_project_files/);
  assert.match(deletion, /DELETE FROM public\.codelab_project_registry/);
  assert.match(deletion, /DELETE FROM public\.codelab_project_imports/);
  assert.match(deletion, /await client\.query\('BEGIN'\)/);
  assert.match(deletion, /await client\.query\('COMMIT'\)/);
});
