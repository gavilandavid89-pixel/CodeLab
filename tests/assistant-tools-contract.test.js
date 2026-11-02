const fs = require('node:fs');
const assert = require('node:assert/strict');

const bridge = fs.readFileSync('.github/scripts/codelab-bridge.mjs', 'utf8');
const app = fs.readFileSync('public/app.js', 'utf8');
const requiredActions = [
  'project_list', 'project_rename', 'project_save',
  'branch_status', 'branch_create', 'branch_resume', 'branch_save', 'branch_merge', 'branch_undo_merge', 'workspace_inspect', 'project_inspect', 'project_code_read', 'design_read', 'project_code_write', 'component_search', 'component_inspect', 'component_insert', 'design_element_add', 'design_element_update', 'design_element_delete', 'design_element_duplicate', 'design_layer_move', 'design_elements_align', 'design_elements_distribute', 'design_prototype_target_set', 'design_layout_configure', 'design_canvas_configure', 'project_create', 'project_duplicate', 'project_delete', 'design_template_apply', 'design_history'
];

for (const action of requiredActions) {
  assert.match(bridge, new RegExp("'" + action + "'"), action + ' must be registered');
  assert.match(bridge, new RegExp("command.action === '" + action + "'"), action + ' must have an implementation');
}

assert.match(bridge, /projectActions\.includes\(command\.action\)[\s\S]{0,180}command\.use_admin_session !== true/,
  'project/branch tools must require an authenticated admin session');
assert.match(bridge, /project_rename[\s\S]{0,300}args\.name\.trim\(\)\.length > 200/,
  'rename must validate project name length');
assert.match(bridge, /branch_resume[\s\S]{0,1800}editorMatchesSavedBranch|editorMatchesSavedBranch[\s\S]{0,300}true/,
  'branch resume must report editor-to-branch verification');
for (const [action, operation] of [
  ['branch_create', 'branch.create'],
  ['branch_merge', 'branch.merge'],
  ['branch_undo_merge', 'branch.undo_merge']
]) {
  const start = bridge.indexOf("} else if (command.action === '" + action + "') {");
  const end = bridge.indexOf("} else if (command.action ===", start + 40);
  const handler = bridge.slice(start, end < 0 ? undefined : end);
  assert.match(handler, /\/api\/workspace\//, action + ' must use the authenticated workspace API');
  assert.ok(handler.includes("type: '" + operation + "'"), action + ' must use the shared headless operation');
  assert.doesNotMatch(handler, /projects\.find\(|openProject\(|toggleCopyBranch\(|mergeToMainProject\(|undoLastMerge\(/,
    action + ' must not depend on editor UI state');
}
assert.match(bridge, /branch_merge[\s\S]{0,3000}backupCreated/,
  'branch merge must verify the saved backup after server readback');
assert.match(bridge, /branch_undo_merge[\s\S]{0,3000}mergeHistoryRemaining/,
  'undo merge must verify restored branch/history from server readback');
assert.match(bridge, /\['branch_merge', 'branch_undo_merge'\][\s\S]{0,180}approval !== 'approved'/,
  'main-project merge and undo must require explicit approval');
for (const action of ['workspace_inspect', 'project_inspect', 'project_code_read', 'design_read', 'project_code_write', 'component_search', 'component_insert', 'design_element_add', 'design_element_update', 'design_element_delete']) {
  assert.match(bridge, new RegExp("command.action === '" + action + "'"), action + ' must have an implementation');
}
assert.match(bridge, /length > 50000/, 'code write must enforce a size limit');
assert.match(bridge, /designPreserved: data\.results\?\.\[0\]\?\.designPreserved === true/, 'design conversion must verify source preservation from the headless API');
assert.match(bridge, /operations: \[\{ type: 'design\.convert\.toWeb', projectId \}\]/, 'design conversion must use the shared headless runtime');
assert.match(bridge, /truncated: content\.length > limit/, 'HTML export must report truncation');
assert.match(bridge, /AI generation changes project code and may consume API quota/, 'AI generation must require explicit approval');
assert.match(bridge, /await processAiInstruction\(\)/, 'AI generation must reuse the app copilot path');
assert.match(bridge, /source\.design\.flowConnections\.push/, 'flow connections must update the actual design model');
assert.match(bridge, /apiKeyExposed: false/, 'AI settings inspection must not expose secrets');
const auditHandler = bridge.slice(bridge.indexOf("command.action === 'accessibility_audit'"), bridge.indexOf("command.action === 'design_tokens_generate'", bridge.indexOf("command.action === 'accessibility_audit'")));
assert.match(auditHandler, /\/headless\/query/, 'accessibility audit must use the authenticated saved-workspace query');
assert.match(auditHandler, /action: 'accessibility\.audit'/, 'accessibility audit must invoke the shared server-side audit');
assert.doesNotMatch(auditHandler, /projects\.find\(/, 'accessibility audit must not inspect stale editor memory');

for (const [action, queryAction] of [
  ['branch_status', 'branch.inspect'],
  ['project_inspect', 'project.inspect'],
  ['design_read', 'design.read']
]) {
  const start = bridge.indexOf("command.action === '" + action + "'");
  const end = bridge.indexOf("command.action === '", start + 20);
  const handler = bridge.slice(start, end > start ? end : bridge.length);
  assert.match(handler, /\/headless\/query/, action + ' must read saved state through the authenticated query API');
  assert.ok(handler.includes("action: '" + queryAction + "'") || handler.includes("query('" + queryAction + "'"), action + ' must use the matching headless query');
  assert.doesNotMatch(handler, /projects\.find\(/, action + ' must not depend on the editor in-memory project model');
}
assert.match(bridge, /Permanent project deletion requires approval/, 'project deletion must require explicit approval');
assert.match(bridge, /Replacing existing design layers requires approval/, 'template replacement must require explicit approval');
assert.match(bridge, /codelab-component:/, 'component insertion must be idempotent');
assert.match(bridge, /recordDesignHistory\(\)/, 'design edits must record undo history');
assert.match(bridge, /design_element_duplicate[\s\S]{0,1800}localSnapshotVerified/,
  'duplicating a design element must verify the persisted duplicate');
assert.match(bridge, /design_layer_move[\s\S]{0,2000}localSnapshotVerified/,
  'moving a design layer must verify persisted layer order');
assert.match(bridge, /design_elements_align[\s\S]{0,2300}localSnapshotVerified/,
  'aligning design elements must verify persisted positions');
assert.match(bridge, /design_layout_configure[\s\S]{0,2600}localSnapshotVerified/,
  'layout configuration must verify persisted settings');
assert.match(bridge, /design_canvas_configure[\s\S]{0,2800}localSnapshotVerified/,
  'canvas configuration must verify persisted settings');
assert.match(bridge, /design_canvas_configure requires at least one canvas property/,
  'canvas configuration must reject empty requests');

assert.match(bridge, /sourceUnchanged/, 'project duplication must check that the source was preserved');
assert.match(bridge, /exact local project state/, 'project save must verify exact persisted code or design, not only the project name');
assert.match(bridge, /persistedCodeMatchesRequested/, 'code write must verify the saved result');
assert.match(bridge, /localSnapshotVerified/,
  'tools must distinguish local durable state from server sync');
assert.match(bridge, /if \(commandSource === 'comment' && !\[[\s\S]*?\.includes\(command\.action\)\) \{[\s\S]{0,250}Comment mailbox is read-only/,
  'comment mailbox must remain read-only');
assert.match(bridge, /allowedCanvasKeys = \[[^\]]*'canvas_width'[^\]]*'canvas_height'/, 'canvas tool must expose custom dimensions');
assert.match(bridge, /canvas_width[\s\S]{0,180}4000/, 'custom canvas width must be bounded');
assert.match(bridge, /canvas_height[\s\S]{0,180}10000/, 'custom canvas height must be bounded');
assert.match(bridge, /allowedCanvasKeys = \[[^\]]*'canvas_width'[^\]]*'canvas_height'/, 'canvas bridge must expose custom dimensions');
assert.match(bridge, /canvas_width[\s\S]{0,180}4000/, 'custom canvas width must be bounded');
assert.match(bridge, /canvas_height[\s\S]{0,180}10000/, 'custom canvas height must be bounded');
assert.match(app, /function getDesignCanvasWidth\(design\)/, 'app must resolve custom canvas width');
assert.match(app, /function setDesignCanvasDimensions\(widthValue, heightValue\)/, 'Inspector must expose a persisted custom canvas dimension setter');
assert.match(app, /id="designCanvasWidth"/, 'Inspector must expose canvas width control');
assert.match(app, /id="designCanvasHeight"/, 'Inspector must expose canvas height control');
assert.match(app, /function resetDesignCanvasDimensions\(\)/, 'Inspector must support resetting canvas dimensions');
assert.match(bridge, /const supportedQueries = \[[^\]]*'design\.capture\.context'/,
  'headless AI design capture context must be exposed as a supported query');
assert.match(bridge, /'design\.history\.inspect', 'design\.template\.list', 'design\.capture\.context', 'design\.export\.json'/,
  'design capture context must be registered in the query allowlist in the expected order');
assert.match(bridge, /design\.capture\.context[\s\S]{0,500}queryArgs\.projectId !== 'string'/,
  'design capture context must require an explicit project ID');

console.log('Assistant project lifecycle tool contract checks passed.');

assert.match(bridge, /component_inspect[\s\S]{0,1600}truncated: html\.length > limit/, 'component inspection must expose bounded standalone HTML with truncation metadata');
assert.match(bridge, /component_inspect max_chars must be an integer from 1000 to 7000/, 'component inspection must validate output limits');

assert.match(bridge, /design_elements_distribute requires 3 to 100 unique valid element_ids/);
assert.match(bridge, /distributeDesignElements\(axis\)/, 'distribution must call the existing design editor operation');
assert.match(bridge, /design_prototype_target_set target must be a safe string/);
assert.match(bridge, /setDesignPrototypeTarget\(target\)/, 'prototype target must use the existing editor operation');


assert.match(bridge, /'objectFit', 'textAlign'/,
  'design element updates must expose text alignment supported by the editor');
assert.match(bridge, /key === 'textAlign' && !\['left', 'center', 'right'\]\.includes\(value\)/,
  'text alignment must be validated against the editor options');
assert.match(bridge, /key === 'objectFit' && !\['contain', 'cover', 'fill'\]\.includes\(value\)/,
  'image fit must be validated against the editor options');


assert.ok(bridge.includes("const isLayerTarget = /^#layer-[a-z0-9_-]{1,120}$/i.test(target);"),
  'prototype targets must support the same #layer-id fragments as the app');
assert.match(bridge, /isWebTarget = \(url\.protocol === 'https:' \|\| url\.protocol === 'http:'\) && !url\.username && !url\.password/,
  'prototype targets must allow only credential-free HTTP(S) URLs');
assert.match(bridge, /target && !isLayerTarget && !isWebTarget/,
  'unsupported targets must be rejected before mutating the design');


const scopedDesignActions = [
  'design_element_duplicate', 'design_layer_move', 'design_elements_align',
  'design_elements_distribute', 'design_prototype_target_set',
  'design_layout_configure', 'design_canvas_configure'
];
const projectActionsBlock = bridge.match(/const projectActions = \[([^\]]+)\]/)?.[1] || '';
const projectIdActionsBlock = bridge.match(/if \(\[([^\]]+)\]\.includes\(command\.action\) &&[\s\S]{0,220}args\.project_id !== 'string'/)?.[1] || '';
for (const action of scopedDesignActions) {
  assert.ok(projectActionsBlock.includes("'" + action + "'"),
    action + ' must require an authenticated admin session like other project mutations');
  assert.ok(projectIdActionsBlock.includes("'" + action + "'"),
    action + ' must require an explicit project_id to avoid acting on an ambiguous project');
}


assert.match(bridge, /button,a,input,textarea,select,summary,\[role="button"\],\[onclick\],\[data-action\]/,
  'control inventory must include links and app-specific clickable elements, not only native buttons');
assert.match(bridge, /getBoundingClientRect\(\)[\s\S]{0,240}style\.visibility !== 'hidden'/,
  'control inventory must filter invisible elements so results reflect actionable UI');
assert.match(bridge, /ariaLabel:[\s\S]{0,240}dataAction:[\s\S]{0,160}href:/,
  'control inventory must return accessible labels and action/link metadata for reliable follow-up actions');


const codeReadHandler = bridge.slice(
  bridge.indexOf("} else if (command.action === 'project_code_read') {"),
  bridge.indexOf("} else if (command.action === 'design_read') {", bridge.indexOf("} else if (command.action === 'project_code_read') {"))
);
assert.match(codeReadHandler, /\/headless\/query/,
  'project_code_read must use the authenticated headless API rather than editor memory');
assert.match(codeReadHandler, /action: 'project\.code\.read'/,
  'project_code_read must use the shared headless code query');
assert.match(codeReadHandler, /offset, maxChars/,
  'project_code_read must expose offset-based paging to agents');
assert.match(codeReadHandler, /nextOffset: field\.nextOffset/,
  'project_code_read must return paging metadata for subsequent reads');
assert.doesNotMatch(codeReadHandler, /projects\.find\(/,
  'project_code_read must not depend on the editor in-memory project model');

const conversionHandler = bridge.slice(
  bridge.indexOf("} else if (command.action === 'project_convert_design_to_web') {"),
  bridge.indexOf("} else if (command.action === 'headless_ai_generate') {", bridge.indexOf("} else if (command.action === 'project_convert_design_to_web') {"))
);
assert.match(conversionHandler, /\/api\/workspace\//,
  'design-to-web conversion must call the authenticated workspace API');
assert.match(conversionHandler, /operations: \[\{ type: 'design\.convert\.toWeb', projectId \}\]/,
  'design-to-web conversion must use the shared headless runtime on the same project');
assert.match(conversionHandler, /designPreserved: data\.results\?\.\[0\]\?\.designPreserved === true/,
  'conversion must verify that the original design source remains available');
assert.doesNotMatch(conversionHandler, /openProject\(|convertDesignToWeb\(|projects\.find\(item => item && item\.id === projectId\)/,
  'conversion must not depend on the editor or its in-memory project model');

const projectCreateHandler = bridge.slice(
  bridge.indexOf("else if (command.action === 'project_create')"),
  bridge.indexOf("else if (command.action === 'project_duplicate')", bridge.indexOf("else if (command.action === 'project_create')"))
);
assert.ok(projectCreateHandler.includes("type: 'project.create'"), 'project creation must use the authenticated headless operation rather than local UI state');
assert.match(projectCreateHandler, /await refreshWorkspaceFromServer\(\)/,
  'project creation must read the authoritative workspace back from the server');
assert.match(projectCreateHandler, /serverReadbackVerified/,
  'project creation must verify the new project ID, name, and type in the server readback');


const importHandler = bridge.slice(bridge.indexOf("} else if (command.action === 'design_import_json') {"), bridge.indexOf("} else if (command.action === 'project_export_html') {", bridge.indexOf("} else if (command.action === 'design_import_json') {")));
assert.match(bridge, /'design_export', 'design_import_json'/, 'design JSON import must be explicitly allowlisted');
assert.match(bridge, /design_import_json requires a JSON string between 2 and 50000 characters/, 'design JSON import must enforce a bounded payload');
assert.match(importHandler, /\/api\/workspace\//, 'design JSON import must use the authenticated headless workspace API');
assert.match(importHandler, /type: 'design\.import\.json'/, 'design JSON import must use the shared runtime operation');
assert.match(importHandler, /await refreshWorkspaceFromServer\(\)/, 'design JSON import must refresh the saved workspace after import');

const systemExportHandler = bridge.slice(bridge.indexOf("} else if (command.action === 'design_system_export_json') {"), bridge.indexOf("} else if (command.action === 'design_export') {", bridge.indexOf("} else if (command.action === 'design_system_export_json') {")));
assert.match(bridge, /'design_system_import_json', 'design_system_export_json'/, 'design system JSON export must be explicitly allowlisted');
assert.match(systemExportHandler, /\/headless\/design-system/, 'design system JSON export must use the authenticated headless API');
assert.match(systemExportHandler, /body: JSON\.stringify\(\{ action: 'export' \}\)/, 'design system export must request server-side token serialization');
assert.match(systemExportHandler, /data\.json\?\.format/, 'design system export must return the canonical exported schema');

const systemImportHandler = bridge.slice(bridge.indexOf("} else if (command.action === 'design_system_import_json') {"), bridge.indexOf("} else if (command.action === 'design_system_export_json') {", bridge.indexOf("} else if (command.action === 'design_system_import_json') {")));
assert.match(bridge, /'design_import_json', 'design_system_import_json'/, 'design system JSON import must be explicitly allowlisted');
assert.match(bridge, /design_system_import_json requires a JSON string between 2 and 50000 characters/, 'design system JSON import must enforce a bounded payload');
assert.match(systemImportHandler, /\/headless\/design-system/, 'design system JSON import must use the authenticated headless API');
assert.match(systemImportHandler, /action: 'import', json, baseRevision: state\.revision/, 'design system import must use optimistic revision control');
assert.doesNotMatch(importHandler + systemImportHandler + systemExportHandler, /locator\(|setInputFiles\(|waitForEvent\('download'/,
  'design import/export must not depend on editor UI or browser download events');

const flowReadHandler = bridge.slice(bridge.indexOf("command.action === 'design_flow_read'"), bridge.indexOf("command.action === 'design_flow_connect'", bridge.indexOf("command.action === 'design_flow_read'")));
assert.match(flowReadHandler, /\/headless\/query/, 'design flow read must use saved workspace queries');
assert.ok(flowReadHandler.includes("query('design.read'"), 'design flow read must use the saved design query');
assert.doesNotMatch(flowReadHandler, /projects\.find\(/, 'design flow read must not inspect editor memory');
const designExportHandler = bridge.slice(bridge.indexOf("} else if (command.action === 'design_export') {"), bridge.indexOf("} else if (command.action === 'design_import_json') {", bridge.indexOf("} else if (command.action === 'design_export') {")));
assert.match(designExportHandler, /\/headless\/query/, 'design export must use the authenticated saved-workspace query');
assert.match(designExportHandler, /design\.export\.svg/, 'SVG export must use the shared deterministic renderer');
assert.match(designExportHandler, /design\.export\.json/, 'JSON export must use the shared canonical serializer');
assert.doesNotMatch(designExportHandler, /projects\.find\(|CodeLabCapture/, 'design export must not depend on editor memory or UI capture code');

const capturePngHandler = bridge.slice(bridge.indexOf("} else if (command.action === 'design_capture_png') {"), bridge.indexOf("} else if (command.action === 'design_import_json') {", bridge.indexOf("} else if (command.action === 'design_capture_png') {")));
assert.match(bridge, /'headless_batch', 'headless_query', 'headless_design_system', 'design_capture_png', 'status'/, 'PNG capture must be allowlisted');
assert.match(capturePngHandler, /design\.capture\.context/, 'PNG capture must request the structured AI capture context');
assert.match(capturePngHandler, /design\.export\.html/, 'PNG capture must render saved semantic HTML in a separate browser context');
assert.match(capturePngHandler, /expectedRevision/, 'PNG and context must be read from the same workspace revision');
assert.match(capturePngHandler, /design-capture\.png/);
assert.match(capturePngHandler, /design-capture\.json/);
assert.match(capturePngHandler, /deviceScaleFactor: captureScale/);
assert.match(capturePngHandler, /route\.abort\(\)/, 'PNG capture must block external network requests');
assert.match(capturePngHandler, /await captureContext\.close\(\)/, 'PNG capture must close its isolated browser context');

const projectListHandler = bridge.slice(bridge.indexOf("} else if (command.action === 'project_list') {"), bridge.indexOf("} else if (command.action === 'project_rename') {", bridge.indexOf("} else if (command.action === 'project_list') {")));
assert.match(bridge, /'component\.inspect', 'design\.tokens\.generate', 'project\.list', 'project\.inspect'/, 'saved project list must be an available headless query');
assert.match(projectListHandler, /\/headless\/query/, 'project list must query saved workspace state');
assert.match(projectListHandler, /action: 'project\.list'/, 'project list must use the canonical saved-state query');
assert.doesNotMatch(projectListHandler, /projects\.map\(/, 'project list must not enumerate editor memory');

const templateHandler = bridge.slice(bridge.indexOf("} else if (command.action === 'design_template_apply') {"), bridge.indexOf("} else if (command.action === 'design_history') {", bridge.indexOf("} else if (command.action === 'design_template_apply') {")));
assert.match(templateHandler, /\/headless\/query/, 'template application must inspect the saved design');
assert.match(templateHandler, /type: 'design\.template\.apply'/, 'template application must use the shared headless runtime');
assert.match(templateHandler, /approved: command\.approval === 'approved'/, 'template replacement approval must be passed to the runtime');
assert.doesNotMatch(templateHandler, /projects\.find\(|applyDesignTemplate\(|openProject\(/, 'template application must not depend on editor UI state');
const historyHandler = bridge.slice(bridge.indexOf("} else if (command.action === 'design_history') {"), bridge.indexOf("} else if (command.action === 'headless_batch') {", bridge.indexOf("} else if (command.action === 'design_history') {")));
assert.match(historyHandler, /design\.history\.inspect/, 'history must check the saved undo/redo state');
assert.match(historyHandler, /design\.history\.undo|design\.history\.redo/, 'history must use shared headless undo/redo operations');
assert.match(historyHandler, /baseRevision: before\.revision/, 'history mutations must use optimistic workspace revisions');
assert.doesNotMatch(historyHandler, /projects\.find\(|designUndo\(|designRedo\(|openProject\(/, 'history must not use editor UI state');

for (const [action, queryName, operationType] of [
  ['project_create', 'project.list', 'project.create'],
  ['project_rename', 'project.inspect', 'project.rename'],
  ['project_duplicate', 'project.inspect', 'project.duplicate'],
  ['project_delete', 'project.inspect', 'project.delete']
]) {
  const start = bridge.indexOf("} else if (command.action === '" + action + "') {");
  const end = bridge.indexOf("} else if (command.action ===", start + 40);
  const handler = bridge.slice(start, end < 0 ? undefined : end);
  assert.match(handler, /\/api\/workspace\//, action + ' must use the authenticated workspace API');
  assert.ok(handler.includes("action: '" + queryName + "'") || handler.includes("query('" + queryName + "'"), action + ' must inspect authoritative saved state');
  assert.ok(handler.includes("type: '" + operationType + "'"), action + ' must use the shared headless runtime operation');
  assert.doesNotMatch(handler, /projects\.find\(|createNewProjectConfirm\(|duplicateProjectFromDashboard\(|deleteProject\(/,
    action + ' must not mutate through editor UI state');
}
assert.match(bridge, /Permanent project deletion requires approval/, 'project deletion must retain explicit approval');

const codeWriteHandler = bridge.slice(bridge.indexOf("} else if (command.action === 'project_code_write') {"), bridge.indexOf("} else if (command.action === 'project_list') {", bridge.indexOf("} else if (command.action === 'project_code_write') {")));
assert.match(codeWriteHandler, /\/headless\/query/, 'code write must inspect saved project state before mutation');
assert.match(codeWriteHandler, /type: 'web\.code\.write'/, 'code write must use the shared headless runtime');
assert.match(codeWriteHandler, /project\.code\.read/, 'code write must verify exact content from server readback');
assert.match(codeWriteHandler, /baseRevision: before\.revision/, 'code write must use optimistic workspace revision control');
assert.doesNotMatch(codeWriteHandler, /projects\.find\(|getEditorValue\(|setEditorValue\(|saveCurrentCodeToActiveProject\(/,
  'code write must not depend on editor state');

const componentInsertHandler = bridge.slice(bridge.indexOf("} else if (command.action === 'component_insert') {"), bridge.indexOf("} else if (command.action === 'design_element_add') {", bridge.indexOf("} else if (command.action === 'component_insert') {")));
assert.match(componentInsertHandler, /type: 'component\.insert'/, 'component insertion must use the shared headless runtime');
assert.match(componentInsertHandler, /project\.code\.read/, 'component insertion must read and verify saved HTML');
assert.match(componentInsertHandler, /nextOffset/, 'component insertion must page through large HTML files');
assert.doesNotMatch(componentInsertHandler, /projects\.find\(|CodeLabComponentLibrary|setEditorValue\(|saveCurrentCodeToActiveProject\(/,
  'component insertion must not depend on editor state or UI component APIs');
