const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('public/app.js', 'utf8');

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

assert.match(source, /Do not overwrite a pending snapshot already preserved for this account\.[\s\S]*?if \(!\(Array\.isArray\(pendingLocalImportProjects\) && pendingLocalImportProjects\.length\)\) \{\s*storePendingLocalImport\(localProjects\);/,
  'a saved offline account snapshot must not be replaced by the anonymous workspace snapshot');

console.log('AI settings and logout isolation checks passed.');
