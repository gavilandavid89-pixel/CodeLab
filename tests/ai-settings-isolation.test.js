const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('public/app.js', 'utf8');
const designTools = fs.readFileSync('public/design-tools.js', 'utf8');

assert.match(source, /function aiSettingsStorageKey\(\)[\s\S]*?return userKey \? STORAGE_KEY_AI \+ ':' \+ userKey : STORAGE_KEY_AI;/,
  'AI settings storage must be namespaced by the real account identity');
assert.match(source, /function aiForceLocalStorageKey\(\)[\s\S]*?return userKey \? 'codelab_ai_force_local_v1:' \+ userKey : 'codelab_ai_force_local_v1';/,
  'force-local preference must be namespaced by account too');
assert.match(source, /function loadAiSettings\(\)[\s\S]*?if \(userKey\) \{\s*lsRemove\(STORAGE_KEY_AI\);\s*lsRemove\('codelab_ai_force_local_v1'\);/,
  'legacy browser-wide credentials must not be reused after a real account is identified');
assert.match(source, /\.then\(\(\) => \{\s*\/\/ Resolve account identity before loading provider credentials from local storage\.\s*loadAiSettings\(\);/,
  'account identity must be resolved before AI credentials are loaded');
assert.match(source, /lsSet\(aiSettingsStorageKey\(\), JSON\.stringify\(aiSettings\)\)/,
  'AI settings saves must use the account-specific storage key');
assert.match(source, /loadAiSettings\(\);\s*updateAuthUI\(\);[\s\S]*?showToast\('Sesión cerrada\.'/,
  'logging out must reload the anonymous settings instead of retaining the previous account key in memory');

assert.match(source, /async function logoutAuth\(\)[\s\S]*?workspaceToken = '';[\s\S]*?lsRemove\(STORAGE_KEY_WORKSPACE_TOKEN\);[\s\S]*?loadAiSettings\(\);/,
  'logout must drop the prior workspace bearer token and reload account-isolated AI settings');
assert.match(source, /if \(currentUser && currentUser\.real\) \{\s*const saved = await persistWorkspace\(\);\s*if \(!saved\) \{\s*storePendingLocalImport\(projects\);/,
  'logout must preserve unsynced account projects if the server save fails');

assert.match(source, /if \(!\(Array\.isArray\(pendingLocalImportProjects\) && pendingLocalImportProjects\.length\)\) \{\s*storePendingLocalImport\(localProjects\);/,
  'an existing account snapshot must not be overwritten by the anonymous workspace snapshot');

assert.match(designTools, /function workspaceSettingsStorageKey\(credentials\)[\s\S]*?STORAGE_KEY \+ ':' \+ active\.id/,
  'design-system local storage must be namespaced by OAuth workspace');
assert.match(designTools, /if \(isAccountWorkspace\) \{[\s\S]*?localStorage\.removeItem\(STORAGE_KEY\)/,
  'legacy global design-system settings must not be migrated into an OAuth account');
assert.match(designTools, /window\.addEventListener\('codelab-workspace-ready', syncSettingsFromWorkspace\);/,
  'design-system sync must react when logout switches to a fresh anonymous workspace');
assert.match(source, /window\.dispatchEvent\(new Event\('codelab-workspace-ready'\)\);[\s\S]*?renderProjectsList\(\);/,
  'workspace changes must trigger design-system reload');

assert.match(designTools, /function isCurrentWorkspace\(credentials\)[\s\S]*?active\.id === credentials\.id && active\.token === credentials\.token/,
  'design-system sync must confirm the active workspace before applying remote responses');
assert.match(designTools, /Ignore stale responses if logout\/account switching changed the active workspace\.[\s\S]*?if \(!isCurrentWorkspace\(credentials\)\) return;/,
  'late design-system responses must not overwrite settings after account switching');

console.log('AI and design-system account isolation checks passed.');
