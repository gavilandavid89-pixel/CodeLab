import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [server, worker] = await Promise.all([
  readFile(new URL('../server.js', import.meta.url), 'utf8'),
  readFile(new URL('../agent-bridge-worker.mjs', import.meta.url), 'utf8'),
]);

test('server wakes the bridge from committed queued commands', () => {
  assert.match(server, /CREATE OR REPLACE FUNCTION public\.codelab_agent_bridge_wake/);
  assert.match(server, /pg_notify\(\s*'codelab_agent_bridge_wake'/);
  assert.match(server, /CREATE TRIGGER codelab_agent_bridge_wake_trigger/);
  assert.match(server, /LISTEN codelab_agent_bridge_wake/);
  assert.match(server, /startAgentBridge\(\)/);
});

test('server action constraint includes every supported PixelForge worker action', () => {
  for (const action of [
    'pixelforge_preview_evidence_video',
    'pixelforge_import_zip',
    'pixelforge_export_zip',
    'pixelforge_video_composer'
  ]) {
    assert.ok(server.includes(`'${action}'`), `server listener constraint must allow ${action}`);
    assert.ok(worker.includes(`'${action}'`), `worker must support ${action}`);
  }
});

test('server retries Neon listener setup when the initial connection fails', () => {
  assert.match(server, /function scheduleAgentBridgeWakeReconnect\(reason\)/);
  assert.match(server, /scheduleAgentBridgeWakeReconnect\(error\)/);
  assert.match(server, /Math\.min\(60000, 1000 \* Math\.pow\(2, attempt - 1\)\)/);
});

test('startup reconciliation sees every non-expired queued command', () => {
  const start = server.indexOf("SELECT command_id, workspace_id FROM public.codelab_agent_commands WHERE status='queued'");
  assert.notEqual(start, -1, 'startup reconciliation query should select queued commands');
  const query = server.slice(start, server.indexOf('LIMIT 1', start) + 7);
  assert.match(query, /expires_at > now\(\)/);
  assert.doesNotMatch(query, /payload.*wake/i, 'reconciliation must not require payload.wake=true');
});

test('worker sleeps on LISTEN/NOTIFY instead of polling the queue', () => {
  assert.match(worker, /LISTEN codelab_agent_bridge_wake/);
  assert.match(worker, /waitForCommandWake\(observedWakeVersion\)/);
  assert.match(worker, /command listener armed; idle polling disabled/);
  assert.doesNotMatch(worker, /POLL_MS\s*=\s*150/);
});

test('server and worker share TLS policy and direct-endpoint conversion', () => {
  assert.match(server, /const DATABASE_SSL = process\.env\.CODELAB_DATABASE_SSL === 'disable' \? false : \{ rejectUnauthorized: false \}/);
  assert.match(worker, /ssl: process\.env\.CODELAB_DATABASE_SSL === 'disable' \? false : \{ rejectUnauthorized: false \}/);
  assert.match(server, /url\.hostname\.replace\('-pooler\.', '\.'\)/);
  assert.match(worker, /url\.hostname\.replace\('-pooler\.', '\.'\)/);
});
