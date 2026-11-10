import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('Penpot runtime is pinned and cannot create a parallel account system', async () => {
  const compose = await read('infra/penpot/docker-compose.yml');
  const env = await read('infra/penpot/.env.example');
  assert.ok(compose.includes('penpotapp/frontend:${PENPOT_VERSION:-2.19.0}'));
  assert.ok(compose.includes('penpotapp/backend:${PENPOT_VERSION:-2.19.0}'));
  assert.ok(env.includes('PENPOT_VERSION=2.19.0'));
  assert.ok(compose.includes('disable-registration disable-login-with-password'));
  assert.ok(!compose.includes('enable-registration'));
  assert.ok(!compose.includes('enable-login-with-password'));\n  assert.ok(compose.includes('disable-telemetry'));
});

test('Penpot reuses CodeLab database and persistent data without parallel durable stores', async () => {
  const compose = await read('infra/penpot/docker-compose.yml');
  const env = await read('infra/penpot/.env.example');
  assert.ok(env.includes('PENPOT_DATABASE_URI=postgresql://'));
  assert.ok(!env.includes('jdbc:postgresql'));
  assert.ok(!env.includes('currentSchema='));
  assert.ok(compose.includes('PENPOT_DATABASE_URI: ${PENPOT_DATABASE_URI'));
  assert.ok(compose.includes('${CODELAB_DATA_DIR:?Mount CodeLab'));
  assert.ok(compose.includes('PENPOT_OBJECTS_STORAGE_FS_DIRECTORY: /opt/data/assets/penpot'));
  assert.ok(!compose.includes('JDBC URL'));
  assert.equal((compose.match(/CODELAB_DATA_DIR/g) || []).length, 1);
  assert.ok(!compose.includes('penpot-postgres'));
  assert.ok(!compose.includes('penpot_assets:'));
  assert.ok(compose.includes('penpot-valkey'));
});

test('database bootstrap creates an isolated schema under a dedicated role', async () => {
  const sql = await read('infra/penpot/bootstrap-existing-postgres.sql');
  assert.ok(sql.includes('CREATE ROLE'));
  assert.ok(sql.includes('CREATE SCHEMA IF NOT EXISTS'));
  assert.ok(sql.includes('ALTER ROLE'));
  assert.ok(sql.includes('SET search_path'));
  assert.ok(sql.includes('GRANT USAGE, CREATE ON SCHEMA'));
  assert.ok(!sql.includes('CREATE DATABASE'));
});

test('documentation preserves the CodeLab ownership and PixelForge invariants', async () => {
  const doc = await read('docs/penpot-native-integration.md');
  assert.ok(doc.includes('CodeLab es el único dueño'));
  assert.ok(doc.includes('No eliminar ni sustituir PixelForge'));
  assert.ok(doc.includes('no se habilita el acceso de usuarios finales'));
  assert.ok(doc.includes('discos persistentes de Render no se comparten automáticamente'));
});
