import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridge = fs.readFileSync(path.join(root, '.github/scripts/codelab-bridge.mjs'), 'utf8');
const tools = fs.readFileSync(path.join(root, 'public/pixelforge/src/ai-tools.js'), 'utf8');

test('PixelForge Headless inspection is admin-scoped, allowlisted and read-only', () => {
  assert.match(bridge, /'pixelforge_headless_list_projects'/);
  assert.match(bridge, /api\/pixelforge\/projects/);
  assert.match(bridge, /'pixelforge_headless_inspect'/);
  const projectActionsStart = bridge.indexOf('const projectActions = [');
  const projectActionsEnd = bridge.indexOf('];', projectActionsStart);
  assert.ok(projectActionsStart >= 0 && projectActionsEnd > projectActionsStart);
  assert.match(bridge.slice(projectActionsStart, projectActionsEnd), /'pixelforge_headless_inspect'/);
  assert.match(bridge.slice(projectActionsStart, projectActionsEnd), /'pixelforge_headless_list_projects'/);
  const legacyProjectIdGuardStart = bridge.indexOf("if (['project_rename'");
  const legacyProjectIdGuardEnd = bridge.indexOf("if (['branch_merge'", legacyProjectIdGuardStart);
  assert.doesNotMatch(bridge.slice(legacyProjectIdGuardStart, legacyProjectIdGuardEnd), /pixelforge_headless_/,
    'PixelForge IDs must use their own validator rather than the CodeLab proj_ ID rule');
  assert.match(bridge, /api\/pixelforge\/projects\//);
  assert.match(bridge, /HeadlessEditorRuntime\.fromJSON\(payload\.project\)/);
  assert.match(bridge, /name: 'canvas\.get_reference'/);
});

test('PixelForge drawing and animation batches require explicit approval and persist through the authenticated proposal bridge', () => {
  assert.match(bridge, /'pixelforge_headless_batch'/);
  assert.match(bridge, /command\.approval !== 'approved'/);
  assert.match(bridge, /actions\.length > 500/);
  assert.match(bridge, /preparePixelForgeProposal\(\{ projectId, actions, summary \}\)/);
  assert.match(bridge, /acceptPixelForgeProposal\(\{ sessionId: prepared\.sessionId, approved: true \}\)/);
  assert.match(bridge, /serverRevision: accepted\.serverRevision/);
});

test('AI coordinate references expose pixel origin, axes, canvas landmarks, grid and layer identity', () => {
  assert.match(tools, /case 'canvas\.get_reference'/);
  assert.match(tools, /origin: 'top-left'/);
  assert.match(tools, /xAxis: 'right'/);
  assert.match(tools, /yAxis: 'down'/);
  assert.match(tools, /quarterPoints/);
  assert.match(tools, /includesCanvasEdges: true/);
  assert.match(tools, /activeLayer/);
  assert.match(tools, /'canvas\.get_reference'/);
});
