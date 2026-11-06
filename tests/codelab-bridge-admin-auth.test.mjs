import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const bridge = await readFile(new URL('../.github/scripts/codelab-bridge.mjs', import.meta.url), 'utf8');

test('every bridge command requires the authenticated ADMIN session', () => {
  assert.match(bridge, /command\.use_admin_session !== true/);
  assert.match(bridge, /CODELAB_ADMIN_USERNAME must be exactly ADMIN/);
});

test('login response must identify the exact local ADMIN account', () => {
  assert.match(bridge, /loginData\.user\?\.name !== 'ADMIN'/);
  assert.match(bridge, /loginData\.user\?\.provider !== 'local'/);
  assert.match(bridge, /typeof loginData\.user\?\.id !== 'string'/);
});

test('server session must match ADMIN identity and the login workspace', () => {
  assert.match(bridge, /getJson\(page, '\/api\/auth\/status'\)/);
  assert.match(bridge, /activeUser\?\.name !== 'ADMIN'/);
  assert.match(bridge, /activeUser\?\.provider !== 'local'/);
  assert.match(bridge, /activeUser\?\.id !== loginData\.user\.id/);
  assert.match(bridge, /activeWorkspaceId !== loginData\.workspaceId/);
});

test('successful bridge reports include verified account context without credentials', () => {
  assert.match(bridge, /account_context: verifiedAdminSession/);
  assert.match(bridge, /identityVerified: true/);
  assert.match(bridge, /workspaceVerified: true/);
});
