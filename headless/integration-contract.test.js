'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const bridge = fs.readFileSync(path.join(root, '.github/scripts/codelab-bridge.mjs'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'headless/workspace-runtime.js'), 'utf8');

test('server exposes the authenticated headless workspace route', () => {
  assert.match(server, /require\(['"]\.\/headless\/workspace-runtime['"]\)/);
  const route = server.indexOf("const headlessMatch = pathname.match");
  assert.notEqual(route, -1);
  const routeBody = server.slice(route, route + 2400);
  assert.ok(routeBody.indexOf('isAuthorized(req, id)') < routeBody.indexOf('applyHeadlessBatch(current, body)'));
  assert.match(routeBody, /const validationError = validateProjects\(result\.state\.projects\)/);
  assert.ok(routeBody.indexOf('if (!result.replayed) {') < routeBody.indexOf('writeState(id, result.state)'));
  assert.match(routeBody, /HEADLESS_REVISION_CONFLICT/);
  assert.match(routeBody, /design_revision_conflict/);
  assert.match(routeBody, /HEADLESS_IDEMPOTENCY_CONFLICT/);
});

test('workspace persistence retains private idempotency receipts', () => {
  assert.match(server, /headlessOperations: Array\.isArray\(parsed\.headlessOperations\)/);
  assert.match(server, /headlessOperations: Array\.isArray\(state\.headlessOperations\)/);
  assert.match(server, /headlessOperations: current\.headlessOperations \|\| \[\]/);
  assert.equal((server.match(/headlessOperations: _privateHeadlessReceipts/g) || []).length, 2);
});

test('bridge requires admin session and sends a headless batch to the web server', () => {
  assert.match(bridge, /new Set\(\['headless_batch'/);
  assert.match(bridge, /'project_export_html', 'headless_batch'\]/);
  assert.match(bridge, /headless_batch requires a non-negative base_revision/);
  assert.match(bridge, /headless_batch requires a safe operation_id/);
  assert.match(bridge, /\/api\/workspace\/'\s*\+\s*encodeURIComponent\(workspaceId\)\s*\+\s*'\/headless/);
  assert.match(bridge, /refreshWorkspaceFromServer\(\)/);
  assert.match(bridge, /openProject\(visibleProjectId\)/);
  assert.match(bridge, /project\.delete.*command\.approval !== 'approved'/s);
  assert.match(bridge, /projects\.some\(item => item && item\.id === visibleProjectId\)/);
});

test('server and bridge expose authenticated read-only headless queries without editor clicks', () => {
  assert.match(server, /queryHeadlessWorkspace/);
  const route = server.indexOf('const headlessQueryMatch = pathname.match');
  assert.notEqual(route, -1);
  const routeEnd = server.indexOf("if (req.method === 'PUT' && getMatch)", route);
  const routeBody = server.slice(route, routeEnd);
  assert.ok(routeBody.indexOf('isAuthorized(req, id)') < routeBody.indexOf('queryHeadlessWorkspace(current, body)'));
  assert.match(routeBody, /expectedRevision/);
  assert.doesNotMatch(routeBody, /writeState\(id/);
  assert.match(bridge, /'headless_batch', 'headless_query'/);
  assert.match(bridge, /command.action === 'headless_query'/);
  assert.match(bridge, /\/headless\/query/);
  assert.match(bridge, /readOnly: true/);
});

test('server and bridge expose authenticated headless design-system read/write/import/export', () => {
  assert.match(server, /readDesignSystemRecord/);
  const route = server.indexOf('const headlessDesignSystemMatch = pathname.match');
  assert.notEqual(route, -1);
  const routeEnd = server.indexOf('const designSystemMatch = pathname.match', route);
  const routeBody = server.slice(route, routeEnd);
  assert.ok(routeBody.indexOf('isAuthorized(req, id)') < routeBody.indexOf('writeDesignSystem(id, settings, body.baseRevision)'));
  assert.match(routeBody, /parseDesignSystemImport\(body\.json\)/);
  assert.match(routeBody, /DESIGN_SYSTEM_REVISION_CONFLICT/);
  assert.match(bridge, /'headless_design_system'/);
  assert.match(bridge, /command.action === 'headless_design_system'/);
  assert.match(bridge, /\/headless\/design-system/);
  assert.match(bridge, /readbackVerified/);
});

test('headless design-system bridge requires approval and exposes the revisioned API', () => {
  assert.match(bridge, /'headless_design_system'/);
  assert.match(bridge, /Changing workspace design-system settings requires approval/);
  assert.match(bridge, /headless_design_system writes require a non-negative base_revision/);
  assert.match(bridge, /\/headless\/design-system/);
  assert.match(bridge, /readbackVerified/);
  assert.match(server, /function readDesignSystemRecord/);
  assert.match(server, /revision: current\.revision \+ 1/);
  assert.match(server, /parseDesignSystemImport\(body\.json\)/);
});

test('headless branch merge and design history are exposed with approval and conflict semantics', () => {
  assert.match(runtime, /case 'branch.create'/);
  assert.match(runtime, /case 'branch.merge'/);
  assert.match(runtime, /case 'branch.undo_merge'/);
  assert.match(runtime, /case 'design.history.undo'/);
  assert.match(runtime, /case 'design.history.redo'/);
  assert.match(server, /HEADLESS_BRANCH_CONFLICT/);
  assert.match(server, /branch_merge_conflict/);
  assert.match(bridge, /Headless branch merge\/undo requires approval/);
  assert.match(bridge, /'branch.inspect', 'design.history.inspect'/);
});

test('headless design templates use responsive shared data and protect layer replacement', () => {
  assert.match(runtime, /require\(['"]\.\/design-templates['"]\)/);
  assert.match(runtime, /case 'design\.template\.apply'/);
  assert.match(runtime, /case 'design\.template\.list'/);
  assert.match(bridge, /Replacing existing design layers with a template requires approval/);
  assert.match(server, /template_replace_requires_approval/);
  assert.match(server, /template_not_found/);
});

test('headless design import export and conversion use the shared design renderer', () => {
  assert.match(runtime, /require\(['"]\.\/design-export['"]\)/);
  assert.match(runtime, /case 'design\.import\.json'/);
  assert.match(runtime, /case 'design\.convert\.toWeb'/);
  assert.match(runtime, /case 'design\.export\.json'/);
  assert.match(runtime, /case 'design\.export\.svg'/);
  assert.match(runtime, /case 'design\.export\.html'/);
  assert.match(bridge, /'design\.export\.json', 'design\.export\.svg', 'design\.export\.html'/);
  assert.match(server, /invalid_design_import/);
  assert.match(server, /design_export_too_large/);
});

test('headless AI generation uses saved workspace APIs, explicit approval, and quota telemetry without editor clicks', () => {
  const start = bridge.indexOf("} else if (command.action === 'headless_ai_generate') {");
  const end = bridge.indexOf("} else if (command.action === 'ai_generate') {", start + 10);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const action = bridge.slice(start, end);
  assert.match(action, /headless\.operation\.status/);
  assert.match(action, /\/api\/ai\/complete/);
  assert.match(action, /headlessAiRequestKey/);
  assert.match(action, /keyFingerprint/);
  assert.match(action, /maxTokens: maxTokens === undefined \? null : maxTokens/);
  assert.match(action, /rateLimit/);
  assert.doesNotMatch(action, /openProject\(|processAiInstruction\(|toggleCopyBranch\(/);
  assert.match(bridge, /Headless AI generation consumes provider quota and changes project code/);
  assert.match(server, /retryAfterSeconds: 60/);
  assert.match(server, /usage,/);
  assert.match(server, /rateLimit/);
  assert.match(runtime, /case 'headless\.operation\.status'/);
});

test('legacy bridge import export and conversion actions now delegate to headless APIs', () => {
  for (const action of ['design_import_json', 'design_system_import_json', 'design_system_export_json', 'project_export_html', 'project_convert_design_to_web']) {
    const start = bridge.indexOf("} else if (command.action === '" + action + "') {");
    assert.notEqual(start, -1, action + ' action must remain available');
    const end = bridge.indexOf("} else if (command.action ===", start + 30);
    const block = bridge.slice(start, end < 0 ? undefined : end);
    assert.match(block, /\/api\/workspace\//, action + ' must use authenticated workspace APIs');
    assert.doesNotMatch(block, /locator\(|setInputFiles\(|waitForEvent\('download'|openProject\(|convertDesignToWeb\(/,
      action + ' must not depend on editor UI interactions');
  }
});

test('preview diagnostics and interactions run in an isolated sandbox using saved workspace code', () => {
  assert.match(bridge, /async function createHeadlessPreview\(/);
  assert.match(bridge, /action: 'project\.code\.read'/);
  assert.match(bridge, /sandbox="allow-scripts allow-forms"/);
  assert.match(bridge, /connect-src \\'none\\'/);
  assert.match(bridge, /browser\.newContext\(\{ serviceWorkers: 'block' \}\)/);
  const diagnosticStart = bridge.indexOf("} else if (command.action === 'preview_diagnostics') {");
  const diagnosticEnd = bridge.indexOf("} else if (command.action === 'preview_interact') {", diagnosticStart);
  const interactionStart = diagnosticEnd;
  const interactionEnd = bridge.indexOf("} else if (command.action ===", interactionStart + 40);
  const diagnostics = bridge.slice(diagnosticStart, diagnosticEnd);
  const interactions = bridge.slice(interactionStart, interactionEnd);
  assert.match(diagnostics, /createHeadlessPreview\(/);
  assert.match(interactions, /createHeadlessPreview\(/);
  assert.doesNotMatch(diagnostics + interactions, /#previewIframe|previewFrame/);
  assert.match(interactions, /only in-page hash links may be clicked/);
});
