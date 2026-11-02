'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const bridge = fs.readFileSync(path.join(root, '.github/scripts/codelab-bridge.mjs'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'headless/workspace-runtime.js'), 'utf8');
const { applyHeadlessBatch } = require('./workspace-runtime');

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

test('isolated preview interaction supports common form and assertion steps', () => {
  assert.match(bridge, /'click', 'fill', 'select', 'upload', 'read', 'check', 'uncheck', 'press', 'hover', 'focus', 'assert_text', 'assert_visible', 'assert_enabled'/);
  assert.match(bridge, /locator\.check\(/);
  assert.match(bridge, /locator\.uncheck\(/);
  assert.match(bridge, /step\.action === 'upload'/);
  assert.match(bridge, /validatePreviewUpload\(step\)/);
  assert.match(bridge, /upload\.buffer/);
  assert.match(bridge, /locator\.setInputFiles\(/);
  assert.match(bridge, /only allow non-submitting navigation keys/);
  assert.match(bridge, /expected text was not found/);
  assert.match(bridge, /element is not visible/);
  assert.match(bridge, /element is not enabled/);
});

test('PNG capture pairs the image and context using a matching saved design revision', () => {
  assert.match(bridge, /context\.designRevision !== designResponse\.result\.revision/);
  assert.match(bridge, /pairedRevisionVerified: true/);
  assert.match(bridge, /networkRequestsBlocked: true/);
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

test('deleting a prototype target bumps dependent design revision and timestamp', () => {
  const source = {
    id: 'proj_source',
    name: 'Source screen',
    type: 'design',
    updatedAt: '2026-01-01T00:00:00.000Z',
    design: {
      revision: 4,
      canvasWidth: 720,
      canvasHeight: 900,
      elements: [{ id: 'nav', type: 'button', text: 'Open target' }],
      flowConnections: [{ sourceElementId: 'nav', targetProjectId: 'proj_target' }]
    }
  };
  source.designUndoStack = [JSON.stringify(source.design)];
  source.designRedoStack = [JSON.stringify(source.design)];
  const target = {
    id: 'proj_target',
    name: 'Target screen',
    type: 'design',
    design: { revision: 2, canvasWidth: 720, canvasHeight: 900, elements: [] }
  };
  const result = applyHeadlessBatch({ revision: 0, projects: [source, target] }, {
    operationId: 'delete-prototype-target-01',
    baseRevision: 0,
    operations: [{ type: 'project.delete', projectId: 'proj_target', approved: true }]
  });

  assert.deepEqual(result.state.projects.map(project => project.id), ['proj_source']);
  assert.deepEqual(result.state.projects[0].design.flowConnections, []);
  assert.equal(result.state.projects[0].design.revision, 5);
  assert.notEqual(result.state.projects[0].updatedAt, source.updatedAt);
  assert.deepEqual(JSON.parse(result.state.projects[0].designUndoStack[0]).flowConnections, []);
  assert.deepEqual(JSON.parse(result.state.projects[0].designRedoStack[0]).flowConnections, []);

  const undone = applyHeadlessBatch(result.state, {
    operationId: 'delete-target-undo-01',
    baseRevision: result.state.revision,
    operations: [{ type: 'design.history.undo', projectId: 'proj_source' }]
  });
  assert.deepEqual(undone.state.projects[0].design.flowConnections, [],
    'undo must not resurrect a connection to a deleted target');
});

test('duplicating a design project does not copy its transient undo and redo history', () => {
  const source = {
    id: 'proj_original',
    name: 'Original design',
    type: 'design',
    design: {
      revision: 3,
      canvasWidth: 720,
      canvasHeight: 900,
      elements: [{ id: 'el_current', type: 'text', text: 'Current' }],
      flowConnections: [
        { sourceElementId: 'el_current', targetProjectId: 'proj_original' },
        { sourceElementId: 'el_current', targetProjectId: 'proj_target' }
      ]
    },
    designUndoStack: [JSON.stringify({ revision: 2, canvasWidth: 720, canvasHeight: 900, elements: [{ id: 'el_old', type: 'text', text: 'Old' }] })],
    designRedoStack: [JSON.stringify({ revision: 4, canvasWidth: 720, canvasHeight: 900, elements: [{ id: 'el_future', type: 'text', text: 'Future' }] })]
  };
  const result = applyHeadlessBatch({ revision: 0, projects: [source] }, {
    operationId: 'duplicate-design-fresh-history',
    baseRevision: 0,
    operations: [{
      type: 'project.duplicate',
      projectId: 'proj_original',
      newProjectId: 'proj_copy'
    }]
  });
  const original = result.state.projects.find(project => project.id === 'proj_original');
  const duplicate = result.state.projects.find(project => project.id === 'proj_copy');

  assert.ok(original.designUndoStack.length);
  assert.ok(original.designRedoStack.length);
  assert.equal(duplicate.design.elements[0].text, 'Current');
  assert.deepEqual(original.design.flowConnections.map(connection => connection.targetProjectId), ['proj_original', 'proj_target']);
  assert.deepEqual(duplicate.design.flowConnections.map(connection => connection.targetProjectId), ['proj_copy', 'proj_target']);
  assert.equal(Object.hasOwn(duplicate, 'designUndoStack'), false);
  assert.equal(Object.hasOwn(duplicate, 'designRedoStack'), false);
});


test('design flow connections advance design revisions and participate in undo/redo', () => {
  const initialDesign = {
    revision: 4,
    canvasWidth: 720,
    canvasHeight: 900,
    elements: [
      { id: 'nav', type: 'button', flowRole: 'navigate', text: 'Open' },
      { id: 'other', type: 'button', flowRole: 'navigate', text: 'Other' }
    ],
    flowConnections: [
      { sourceElementId: 'nav', targetProjectId: 'proj_target_a' },
      { sourceElementId: 'other', targetProjectId: 'proj_target_a' }
    ]
  };
  const initial = {
    revision: 0,
    projects: [
      { id: 'proj_source', type: 'design', design: initialDesign },
      { id: 'proj_target_a', type: 'design', design: { revision: 0, elements: [] } },
      { id: 'proj_target_b', type: 'design', design: { revision: 0, elements: [] } }
    ]
  };
  const connected = applyHeadlessBatch(initial, {
    operationId: 'flow-connect-revision-001',
    baseRevision: 0,
    operations: [{
      type: 'design.flow.connect',
      sourceProjectId: 'proj_source',
      sourceElementId: 'nav',
      targetProjectId: 'proj_target_b'
    }]
  });
  const sourceAfterConnect = connected.state.projects.find(project => project.id === 'proj_source');
  assert.equal(sourceAfterConnect.design.revision, 5);
  assert.deepEqual(sourceAfterConnect.design.flowConnections, [
    { sourceElementId: 'other', targetProjectId: 'proj_target_a' },
    { sourceElementId: 'nav', targetProjectId: 'proj_target_b' }
  ]);
  assert.equal(sourceAfterConnect.designUndoStack.length, 1);
  assert.deepEqual(JSON.parse(sourceAfterConnect.designUndoStack[0]).flowConnections, initialDesign.flowConnections);
  assert.equal(connected.results[0].changed, true);
  assert.equal(connected.results[0].designRevision, 5);

  const noOp = applyHeadlessBatch(connected.state, {
    operationId: 'flow-connect-noop-001',
    baseRevision: connected.state.revision,
    operations: [{
      type: 'design.flow.connect',
      sourceProjectId: 'proj_source',
      sourceElementId: 'nav',
      targetProjectId: 'proj_target_b'
    }]
  });
  assert.equal(noOp.state.projects.find(project => project.id === 'proj_source').design.revision, 5);
  assert.equal(noOp.results[0].changed, false);
  assert.equal(noOp.state.projects.find(project => project.id === 'proj_source').designUndoStack.length, 1);

  const undone = applyHeadlessBatch(connected.state, {
    operationId: 'flow-connect-undo-001',
    baseRevision: connected.state.revision,
    operations: [{ type: 'design.history.undo', projectId: 'proj_source' }]
  });
  const restored = undone.state.projects.find(project => project.id === 'proj_source');
  assert.equal(restored.design.revision, 6);
  assert.deepEqual(restored.design.flowConnections, initialDesign.flowConnections);

  const redone = applyHeadlessBatch(undone.state, {
    operationId: 'flow-connect-redo-001',
    baseRevision: undone.state.revision,
    operations: [{ type: 'design.history.redo', projectId: 'proj_source' }]
  });
  const restoredRedo = redone.state.projects.find(project => project.id === 'proj_source');
  assert.equal(restoredRedo.design.revision, 7);
  assert.deepEqual(restoredRedo.design.flowConnections, sourceAfterConnect.design.flowConnections);
});

test('design flow disconnect clears only the selected layer role and records history', () => {
  const initial = {
    revision: 0,
    projects: [
      {
        id: 'proj_source',
        type: 'design',
        design: {
          revision: 2,
          elements: [
            { id: 'nav', type: 'button', flowRole: 'navigate' },
            { id: 'other', type: 'button', flowRole: 'navigate' }
          ],
          flowConnections: [
            { sourceElementId: 'nav', targetProjectId: 'proj_target_a' },
            { sourceElementId: 'other', targetProjectId: 'proj_target_b' }
          ]
        }
      },
      { id: 'proj_target_a', type: 'design', design: { revision: 0, elements: [] } },
      { id: 'proj_target_b', type: 'design', design: { revision: 0, elements: [] } }
    ]
  };
  const disconnected = applyHeadlessBatch(initial, {
    operationId: 'flow-disconnect-revision-001',
    baseRevision: 0,
    operations: [{
      type: 'design.flow.disconnect',
      sourceProjectId: 'proj_source',
      sourceElementId: 'nav',
      targetProjectId: 'proj_target_a'
    }]
  });
  const source = disconnected.state.projects.find(project => project.id === 'proj_source');
  assert.equal(source.design.revision, 3);
  assert.deepEqual(source.design.flowConnections, [{ sourceElementId: 'other', targetProjectId: 'proj_target_b' }]);
  assert.equal(source.design.elements.find(element => element.id === 'nav').flowRole, '');
  assert.equal(source.design.elements.find(element => element.id === 'other').flowRole, 'navigate');
  assert.equal(source.designUndoStack.length, 1);
  assert.equal(disconnected.results[0].changed, true);

  const noOp = applyHeadlessBatch(disconnected.state, {
    operationId: 'flow-disconnect-noop-001',
    baseRevision: disconnected.state.revision,
    operations: [{
      type: 'design.flow.disconnect',
      sourceProjectId: 'proj_source',
      sourceElementId: 'nav',
      targetProjectId: 'proj_target_a'
    }]
  });
  assert.equal(noOp.state.projects.find(project => project.id === 'proj_source').design.revision, 3);
  assert.equal(noOp.results[0].changed, false);
  assert.equal(noOp.state.projects.find(project => project.id === 'proj_source').designUndoStack.length, 1);
});
