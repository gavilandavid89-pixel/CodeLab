const fs = require('node:fs');
const assert = require('node:assert/strict');

const bridge = fs.readFileSync('.github/scripts/codelab-bridge.mjs', 'utf8');
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
assert.match(bridge, /branch_create[\s\S]{0,2200}localSnapshotVerified/,
  'branch creation must verify its durable snapshot');
assert.match(bridge, /branch_merge[\s\S]{0,2500}backupCreated/,
  'branch merge must verify the merged state and backup');
assert.match(bridge, /branch_undo_merge[\s\S]{0,2500}mergeHistoryRemaining/,
  'undo merge must verify restored code and history');
assert.match(bridge, /\['branch_merge', 'branch_undo_merge'\][\s\S]{0,180}approval !== 'approved'/,
  'main-project merge and undo must require explicit approval');
for (const action of ['workspace_inspect', 'project_inspect', 'project_code_read', 'design_read', 'project_code_write', 'component_search', 'component_insert', 'design_element_add', 'design_element_update', 'design_element_delete']) {
  assert.match(bridge, new RegExp("command.action === '" + action + "'"), action + ' must have an implementation');
}
assert.match(bridge, /length > 50000/, 'code write must enforce a size limit');
assert.match(bridge, /Source design changed during conversion/, 'design conversion must preserve its source');
assert.match(bridge, /truncated: content\.length > limit/, 'HTML export must report truncation');
assert.match(bridge, /AI generation changes project code and may consume API quota/, 'AI generation must require explicit approval');
assert.match(bridge, /await processAiInstruction\(\)/, 'AI generation must reuse the app copilot path');
assert.match(bridge, /source\.design\.flowConnections\.push/, 'flow connections must update the actual design model');
assert.match(bridge, /apiKeyExposed: false/, 'AI settings inspection must not expose secrets');
assert.match(bridge, /auditHtml\(project\.code\?\.html/, 'accessibility audit must use actual project HTML');
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
