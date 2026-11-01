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
  assert.match(routeBody, /if \(!result\.replayed\) writeState\(id, result\.state\)/);
  assert.match(routeBody, /HEADLESS_REVISION_CONFLICT/);
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
});
