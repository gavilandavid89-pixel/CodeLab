'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const bridge = fs.readFileSync(path.join(root, '.github/scripts/codelab-bridge.mjs'), 'utf8');

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
