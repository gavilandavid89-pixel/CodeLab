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

test('ephemeral selection clearing is classified as read-only for bridge approval', () => {
  assert.match(bridge, /'canvas.copy_region', 'selection.clear'/);
  assert.match(catalog, /selection clear/);
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

test('PixelForge animation export artifacts have a dedicated 14-day retention policy', () => {
  assert.match(bridge, /artifactName: 'pixelforge-animation-'/);
  assert.match(bridgeWorkflow, /name: pixelforge-animation-\$\{\{ github\.run_id \}\}/);
  assert.match(bridgeWorkflow, /retention-days: 14/);
});
