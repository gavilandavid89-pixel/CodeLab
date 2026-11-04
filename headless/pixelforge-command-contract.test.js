'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bridge = fs.readFileSync(path.join(__dirname, '..', '.github', 'scripts', 'codelab-bridge.mjs'), 'utf8');
const catalog = fs.readFileSync(path.join(__dirname, '..', 'docs', 'assistant-tool-catalog.md'), 'utf8');

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
  assert.match(catalog, /playback UI, onion-skin controls, sprite-sheet\/GIF export/);
});
