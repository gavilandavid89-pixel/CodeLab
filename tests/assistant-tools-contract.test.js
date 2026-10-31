const fs = require('node:fs');
const assert = require('node:assert/strict');

const bridge = fs.readFileSync('.github/scripts/codelab-bridge.mjs', 'utf8');
const requiredActions = [
  'project_list', 'project_rename', 'project_save',
  'branch_status', 'branch_resume', 'branch_save', 'workspace_inspect', 'project_inspect', 'project_code_read', 'design_read'
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
assert.match(bridge, /workspace_inspect[\\s\\S]{0,500}project_inspect[\\s\\S]{0,1200}project_code_read[\\s\\S]{0,1600}design_read/, 'read-only inspection tools must be implemented');
assert.match(bridge, /localSnapshotVerified/,
  'tools must distinguish local durable state from server sync');
assert.match(bridge, /if \(commandSource === 'comment' && !\[[\s\S]*?\.includes\(command\.action\)\) \{[\s\S]{0,250}Comment mailbox is read-only/,
  'comment mailbox must remain read-only');
console.log('Assistant project lifecycle tool contract checks passed.');
