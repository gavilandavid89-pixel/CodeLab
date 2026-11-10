import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('Penpot runtime is pinned and cannot create a parallel account system', async () => {
  const compose = await read('infra/penpot/docker-compose.yml');
  const env = await read('infra/penpot/.env.example');
  assert.match(compose, /penpotapp\\/frontend:\\$\\{PENPOT_VERSION:-2\\.19\\.0\\}/);
  assert.match(compose, /penpotapp\\/backend:\\$\\{PENPOT_VERSION:-2\\.19\\.0\\}/);
  assert.match(env, /^PENPOT_VERSION=2\\.19\\.0$/m);
  assert.match(compose, /disable-registration disable-login-with-password/);
  assert.doesNotMatch(compose, /enable-registration|enable-login-with-password/);
});

test('Penpot reuses CodeLab database and persistent data without provisioning parallel durable stores', async () => {
  const compose = await read('infra/penpot/docker-compose.yml');
  const env = await read('infra/penpot/.env.example');
  assert.match(env, /^PENPOT_DATABASE_URI=postgresql:\\/\\//m);
  assert.doesNotMatch(env, /jdbc:postgresql|currentSchema=/);
  assert.match(compose, /PENPOT_DATABASE_URI: \\$\\{PENPOT_DATABASE_URI/);
  assert.match(compose, /\\$\\{CODELAB_DATA_DIR:[^}]+\\}\\/opt\\/data\\/assets/);
  assert.match(compose, /PENPOT_OBJECTS_STORAGE_FS_DIRECTORY: \\/opt\\/data\\/assets\\/penpot/);
  assert.doesNotMatch(compose, /JDBC URL|currentSchema=|existing CodeLab database username/);
  assert.equal((compose.match(/CODELAB_DATA_DIR/g) || []).length, 1, 'only the Penpot backend needs the shared asset mount');
  assert.doesNotMatch(compose, /penpot-postgres|penpot_postgres|penpot_assets:|volumes:\\s*\\n\\s*penpot_/);
  assert.match(compose, /penpot-valkey/);
});

test('database bootstrap creates an isolated schema under a dedicated role', async () => {
  const sql = await read('infra/penpot/bootstrap-existing-postgres.sql');
  assert.match(sql, /CREATE ROLE/);
  assert.match(sql, /CREATE SCHEMA IF NOT EXISTS/);
  assert.match(sql, /ALTER ROLE .* SET search_path/);
  assert.match(sql, /GRANT USAGE, CREATE ON SCHEMA/);
  assert.doesNotMatch(sql, /CREATE DATABASE/i);
  assert.match(sql, /current_database\\(\\)/);
});

test('documentation preserves the CodeLab ownership and PixelForge invariants', async () => {
  const doc = await read('docs/penpot-native-integration.md');
  assert.match(doc, /CodeLab es el único dueño/);
  assert.match(doc, /No eliminar ni sustituir PixelForge/);
  assert.match(doc, /no se habilita el acceso de usuarios finales/);
  assert.match(doc, /discos persistentes de Render no se comparten automáticamente/);
});
