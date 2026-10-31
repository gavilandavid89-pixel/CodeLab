const fs = require('node:fs');
const assert = require('node:assert/strict');

const bridge = fs.readFileSync('.github/scripts/codelab-bridge.mjs', 'utf8');
const requiredActions = [
  'project_list', 'project_rename', 'project_save',
  'branch_status', 'branch_resume', 'branch_save', 'workspace_inspect', 'project_inspect', 'project_code_read', 'design_read', 'project_code_write', 'component_search', 'component_insert', 'design_element_add', 'design_element_update', 'design_element_delete', 'project_create', 'project_duplicate', 'project_delete', 'design_template_apply', 'design_history'
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
for (const action of ['workspace_inspect', 'project_inspect', 'project_code_read', 'design_read', 'project_code_write', 'component_search', 'component_insert', 'design_element_add', 'design_element_update', 'design_element_delete']) {
  assert.match(bridge, new RegExp("command.action === '" + action + "'"), action + ' must have an implementation');
}
assert.match(bridge, /length > 50000/, 'code write must enforce a size limit');
assert.match(bridge, /Source design changed during conversion/, 'design conversion must preserve its source');
assert.match(bridge, /project_export_html[\\s\\S]{0,1000}truncated/, 'HTML export must report truncation');
assert.match(bridge, /AI generation changes project code and may consume API quota/, 'AI generation must require explicit approval');
assert.match(bridge, /await processAiInstruction\(\)/, 'AI generation must reuse the app copilot path');
assert.match(bridge, /source\.design\.flowConnections\.push/, 'flow connections must update the actual design model');
assert.match(bridge, /apiKeyExposed: false/, 'AI settings inspection must not expose secrets');
assert.match(bridge, /auditHtml\(project\.code\?\.html/, 'accessibility audit must use actual project HTML');
assert.match(bridge, /Permanent project deletion requires approval/, 'project deletion must require explicit approval');
assert.match(bridge, /Replacing existing design layers requires approval/, 'template replacement must require explicit approval');
assert.match(bridge, /codelab-component:/, 'component insertion must be idempotent');
assert.match(bridge, /recordDesignHistory\(\)/, 'design edits must record undo history');
assert.match(bridge, /sourceUnchanged/, 'project duplication must check that the source was preserved');
assert.match(bridge, /exact local project state/, 'project save must verify exact persisted code or design, not only the project name');
assert.match(bridge, /persistedCodeMatchesRequested/, 'code write must verify the saved result');
assert.match(bridge, /localSnapshotVerified/,
  'tools must distinguish local durable state from server sync');
assert.match(bridge, /if \(commandSource === 'comment' && !\[[\s\S]*?\.includes\(command\.action\)\) \{[\s\S]{0,250}Comment mailbox is read-only/,
  'comment mailbox must remain read-only');
console.log('Assistant project lifecycle tool contract checks passed.');
