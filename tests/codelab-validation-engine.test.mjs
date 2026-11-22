import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CodeLabValidationEngine,
  createDefaultCodeLabValidationEngine
} from '../public/codelab-validation-engine.mjs';

test('native engine validates in-process without a configured timeout', async () => {
  const engine = createDefaultCodeLabValidationEngine();
  engine.register('test.async', async () => {
    await new Promise(resolve => setImmediate(resolve));
    return { ok: true, score: 100, issues: [] };
  });

  const result = await engine.validate('test.async', {});
  assert.equal(result.ok, true);
  assert.equal(result.validator, 'test.async');
  assert.equal(result.issues.length, 0);
});

test('native engine reports validator failures with structured diagnostics', async () => {
  const engine = new CodeLabValidationEngine();
  engine.register('test.failure', () => ({
    ok: false,
    score: 35,
    issues: [{
      code: 'broken_contract',
      message: 'El contrato no coincide.',
      severity: 'error',
      path: 'payload.action',
      expected: 'validate',
      actual: 'run'
    }]
  }));

  const result = await engine.validate('test.failure', {});
  assert.equal(result.ok, false);
  assert.equal(result.score, 35);
  assert.equal(result.issues[0].path, 'payload.action');
  assert.equal(result.issues[0].expected, 'validate');
});

test('native engine supports explicit cancellation instead of a hidden deadline', async () => {
  const engine = new CodeLabValidationEngine();
  engine.register('test.cancel', async (_input, ctx) => {
    await new Promise(resolve => setImmediate(resolve));
    if (ctx.signal?.aborted) {
      return { ok: false, score: 0, issues: [{
        code: 'validation_aborted',
        message: 'cancelled',
        severity: 'fatal'
      }] };
    }
    return { ok: true, score: 100, issues: [] };
  });

  const controller = new AbortController();
  controller.abort();
  const result = await engine.validate('test.cancel', {}, { signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, 'validation_aborted');
});
