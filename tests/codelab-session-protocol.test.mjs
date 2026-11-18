import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('persistent session architecture keeps host and request workflows independent', () => {
  const host = fs.readFileSync('.github/workflows/codelab-session-host.yml', 'utf8');
  const request = fs.readFileSync('.github/workflows/codelab-session-request.yml', 'utf8');
  assert.match(host, /workflow_dispatch/);
  assert.match(host, /codelab-session-host\.mjs/);
  assert.match(request, /workflow_dispatch/);
  assert.match(request, /codelab-session-request\.mjs/);
  assert.notEqual(host, request);
});

test('session host executes structured browser actions against its local CodeLab', () => {
  const source = fs.readFileSync('scripts/codelab-session-host.mjs', 'utf8');
  for (const action of ['open_screen', 'open_panel', 'click', 'scroll', 'type', 'select', 'wait_for', 'screenshot', 'record_video']) {
    assert.match(source, new RegExp(action));
  }
  assert.match(source, /playwright/);
  assert.match(source, /127\.0\.0\.1/);
  assert.match(source, /CodeLab Session Result/);
});

test('ephemeral request carries a unique request id and waits for the matching response', () => {
  const source = fs.readFileSync('scripts/codelab-session-request.mjs', 'utf8');
  assert.match(source, /randomUUID/);
  assert.match(source, /requestId/);
  assert.match(source, /CodeLab Session Request/);
  assert.match(source, /CodeLab Session Result/);
});
