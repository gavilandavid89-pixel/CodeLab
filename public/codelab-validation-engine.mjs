/**
 * CodeLab Native Validation Engine
 * Deterministic, in-process validation. No wall-clock timeout is imposed.
 *
 * A validator may be synchronous or asynchronous. The engine only stops when
 * the validator returns, throws, or the caller explicitly aborts it.
 */
const VALIDATION_ENGINE_VERSION = 1;

function issue(code, message, extra = {}) {
  return { code, message, severity: extra.severity || 'error', ...extra };
}

function normalizeResult(result, validatorId) {
  const issues = Array.isArray(result?.issues) ? result.issues : [];
  return {
    ok: result?.ok !== false && issues.every(i => i.severity !== 'error' && i.severity !== 'fatal'),
    validator: validatorId,
    version: VALIDATION_ENGINE_VERSION,
    score: Number.isFinite(result?.score) ? result.score : (issues.length ? 0 : 100),
    issues,
    details: result?.details || {},
    startedAt: result?.startedAt || null,
    finishedAt: result?.finishedAt || null
  };
}

export class CodeLabValidationEngine {
  constructor() {
    this.validators = new Map();
  }

  register(id, validator, metadata = {}) {
    if (!id || typeof id !== 'string') throw new TypeError('validator_id_required');
    if (typeof validator !== 'function') throw new TypeError('validator_function_required');
    this.validators.set(id, { id, validator, metadata });
    return this;
  }

  has(id) {
    return this.validators.has(id);
  }

  list() {
    return [...this.validators.values()].map(({ id, metadata }) => ({ id, ...metadata }));
  }

  async validate(target, input, options = {}) {
    const startedAt = new Date().toISOString();
    const selected = this.validators.get(target);
    if (!selected) {
      return {
        ok: false,
        validator: target,
        version: VALIDATION_ENGINE_VERSION,
        score: 0,
        issues: [issue('validator_not_found', `No existe el validador nativo "${target}".`, { severity: 'fatal' })],
        details: {},
        startedAt,
        finishedAt: new Date().toISOString()
      };
    }

    if (options.signal?.aborted) {
      return {
        ok: false,
        validator: target,
        version: VALIDATION_ENGINE_VERSION,
        score: 0,
        issues: [issue('validation_aborted', 'La validación fue cancelada por el solicitante.', { severity: 'fatal' })],
        details: {},
        startedAt,
        finishedAt: new Date().toISOString()
      };
    }

    try {
      const result = await selected.validator(input, {
        target,
        signal: options.signal,
        options,
        engine: this
      });
      const normalized = normalizeResult(result, target);
      normalized.startedAt = startedAt;
      normalized.finishedAt = new Date().toISOString();
      return normalized;
    } catch (error) {
      return {
        ok: false,
        validator: target,
        version: VALIDATION_ENGINE_VERSION,
        score: 0,
        issues: [issue('validator_exception', error?.message || String(error), {
          severity: 'fatal',
          errorName: error?.name || 'Error'
        })],
        details: {},
        startedAt,
        finishedAt: new Date().toISOString()
      };
    }
  }

  async validateMany(requests, options = {}) {
    const results = [];
    for (const request of Array.isArray(requests) ? requests : []) {
      if (options.signal?.aborted) break;
      results.push(await this.validate(request.target, request.input, {
        ...options,
        ...(request.options || {})
      }));
    }
    return {
      ok: results.length > 0 && results.every(result => result.ok),
      engineVersion: VALIDATION_ENGINE_VERSION,
      results
    };
  }
}

export function createDefaultCodeLabValidationEngine() {
  const engine = new CodeLabValidationEngine();

  engine.register('codelab.schema', input => {
    const issues = [];
    if (!input || typeof input !== 'object') {
      issues.push(issue('invalid_input', 'El objetivo de validación debe ser un objeto JSON.'));
    }
    return { ok: issues.length === 0, score: issues.length ? 0 : 100, issues };
  }, { description: 'Valida la forma básica de un payload de CodeLab.' });

  return engine;
}

export function validationIssue(code, message, extra = {}) {
  return issue(code, message, extra);
}
