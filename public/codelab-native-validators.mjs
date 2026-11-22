import {
  validatePixelForgeProject,
  validateVectorModel,
  formatValidationFailure
} from './pixelforge/src/pixelforge-validation.js';
import { createDefaultCodeLabValidationEngine } from './codelab-validation-engine.mjs';

export function createNativeCodeLabValidationEngine() {
  const engine = createDefaultCodeLabValidationEngine();

  engine.register('pixelforge', input => {
    const result = validatePixelForgeProject(input?.project ?? input, input?.options || {});
    return {
      ok: result.ok,
      score: result.score,
      issues: result.issues,
      details: {
        validatorVersion: result.validatorVersion,
        categories: result.categories,
        failure: result.ok ? null : formatValidationFailure(result)
      }
    };
  }, {
    description: 'Valida proyectos PixelForge raster + vector + animación sin depender de GitHub Actions.'
  });

  engine.register('pixelforge.vector', input => {
    const result = validateVectorModel(input?.model ?? input, input?.options || {});
    return {
      ok: result.ok,
      score: result.score,
      issues: result.issues,
      details: {
        objectCount: result.objectCount,
        failure: result.ok ? null : formatValidationFailure(result)
      }
    };
  }, {
    description: 'Valida el modelo vectorial de PixelForge en memoria.'
  });

  return engine;
}
