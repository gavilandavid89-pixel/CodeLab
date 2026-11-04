'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bridge = fs.readFileSync(path.join(__dirname, '..', '.github', 'scripts', 'codelab-bridge.mjs'), 'utf8');
const catalog = fs.readFileSync(path.join(__dirname, '..', 'docs', 'assistant-tool-catalog.md'), 'utf8');
const bridgeWorkflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'codelab-command-bridge.yml'), 'utf8');

test('PixelForge Headless commands are allowlisted and require the authenticated admin session', () => {
  assert.match(bridge, /'pixelforge_headless_inspect', 'pixelforge_headless_batch'/);
  assert.match(bridge, /'pixelforge_headless_inspect', 'pixelforge_headless_batch',/);
  assert.match(bridge, /Project and branch tools require use_admin_session: true/);
  assert.match(bridge, /PixelForge Headless edits require approval: "approved"/);
});

test('PixelForge Headless batch is bounded and calls the isolated proposal runtime', () => {
  assert.match(bridge, /args\.actions\.length > 500/);
  assert.match(bridge, /JSON\.stringify\(args\.actions\)\.length > 40000/);
  assert.match(bridge, /preparePixelForgeProposal/);
  assert.match(bridge, /acceptPixelForgeProposal\(\{ sessionId: prepared\.sessionId, approved: true \}\)/);
  assert.match(bridge, /\/api\/pixelforge\/projects\//);
});

test('PixelForge Headless tool catalog documents drawing and animation but does not overclaim playback/export', () => {
  assert.match(catalog, /Section 24 — PixelForge Headless raster and animation automation/);
  assert.match(catalog, /animation\.frame\.add_from_layer/);
  assert.match(catalog, /Playback UI, onion-skin controls, GIF export/);
});

test('PixelForge read-only batch actions do not require project-write approval', () => {
  assert.match(bridge, /readOnlyPixelForgeActions = new Set/);
  assert.match(bridge, /'document\.get_summary', 'canvas\.get_pixel', 'canvas\.preview_transform_region'/);
  assert.match(bridge, /hasProjectMutation && command\.approval !== 'approved'/);
  assert.match(catalog, /status: "inspected"/);
});

test('selection.clear is classified as a mutation and requires bridge approval', () => {
  const start = bridge.indexOf('const readOnlyPixelForgeActions = new Set([');
  const end = bridge.indexOf(']);', start);
  assert.ok(start >= 0 && end > start, 'bridge read-only action set must exist');
  const readOnlyBlock = bridge.slice(start, end);
  assert.ok(readOnlyBlock.includes("'animation.get_summary'"));
  assert.ok(readOnlyBlock.includes("'canvas.copy_region'"));
  assert.equal(readOnlyBlock.includes("'selection.clear'"), false, 'selection clearing must not be read-only');
  assert.ok(bridge.includes("hasProjectMutation && command.approval !== 'approved'"));
});

test('PixelForge animation export writes a downloadable artifact instead of a mailbox Base64 payload', () => {
  assert.match(bridge, /pixelforge_headless_export_animation/);
  assert.match(bridge, /exportAnimationSpriteSheet/);
  assert.match(bridge, /page\.waitForEvent\('download'/);
  assert.match(bridge, /pixelforge-animation-spritesheet\.png/);
  assert.match(bridge, /pixelforge-animation-manifest\.json/);
  assert.match(bridgeWorkflow, /pixelforge-animation-spritesheet\.png/);
  assert.match(bridgeWorkflow, /pixelforge-animation-manifest\.json/);
  assert.match(catalog, /pixelforge_headless_export_animation/);
  assert.match(catalog, /Actions run URL/);
});

test('PixelForge project management lists, creates, and deletes only through explicit admin commands', () => {
  for (const action of ['pixelforge_headless_list_projects', 'pixelforge_headless_create_project', 'pixelforge_headless_delete_project']) {
    assert.ok(bridge.includes("'" + action + "'"), action + ' must be allowlisted');
    assert.ok(bridge.includes("'" + action + "'"), action + ' must be registered');
  }
  const projectStart = bridge.indexOf('const projectActions = [');
  const projectEnd = bridge.indexOf('];', projectStart);
  const projectActionBlock = bridge.slice(projectStart, projectEnd);
  assert.ok(projectActionBlock.includes("'pixelforge_headless_list_projects'"));
  assert.ok(projectActionBlock.includes("'pixelforge_headless_create_project'"));
  assert.ok(projectActionBlock.includes("'pixelforge_headless_delete_project'"));
  assert.ok(bridge.includes('PixelForge project creation/deletion requires approval'));
  assert.ok(bridge.includes('readbackVerified: true'));
  assert.ok(bridge.includes('64 * 1024 * 1024'));
});

test('PixelForge raster exports are explicit, bounded, and require approval', () => {
  const projectStart = bridge.indexOf('const projectActions = [');
  const projectEnd = bridge.indexOf('];', projectStart);
  assert.ok(projectStart >= 0 && projectEnd > projectStart, 'project action allowlist must exist');
  const projectActionBlock = bridge.slice(projectStart, projectEnd);
  for (const action of ['pixelforge_headless_export_png', 'pixelforge_headless_export_project', 'pixelforge_headless_export_layers']) {
    assert.ok(bridge.includes("'" + action + "'"), action + ' must be allowlisted');
    assert.ok(projectActionBlock.includes("'" + action + "'"), action + ' must require an admin project session');
  }
  assert.ok(bridge.includes("PixelForge raster/project export requires approval: \"approved\"."));
  assert.ok(bridge.includes('createSpriteSheetLayout'));
  assert.ok(bridge.includes('24 * 1024 * 1024'));
  assert.ok(bridge.includes('pixelforge-composite.png'));
  assert.ok(bridge.includes('pixelforge-project.pforge'));
  assert.ok(bridge.includes('pixelforge-layer-spritesheet.json'));
});

test('PixelForge animation export artifacts have a dedicated 14-day retention policy', () => {
  assert.match(bridge, /artifactName: 'pixelforge-animation-'/);
  assert.match(bridgeWorkflow, /name: pixelforge-animation-\$\{\{ github\.run_id \}\}/);
  assert.match(bridgeWorkflow, /retention-days: 14/);
});
