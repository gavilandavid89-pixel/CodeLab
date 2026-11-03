'use strict';

const TEXT_TYPES = new Set(['heading', 'text', 'button']);
const LARGE_TEXT_PX = 24;
const LARGE_BOLD_TEXT_PX = 18.66;

function parseHexColor(value) {
  if (typeof value !== 'string') return null;
  const input = value.trim();
  const short = /^#([0-9a-f]{3})$/i.exec(input);
  const full = /^#([0-9a-f]{6})$/i.exec(input);
  if (short) {
    return short[1].split('').map(char => parseInt(char + char, 16));
  }
  if (full) {
    return [0, 2, 4].map(index => parseInt(full[1].slice(index, index + 2), 16));
  }
  return null;
}

function linearize(channel) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(rgb) {
  return 0.2126 * linearize(rgb[0]) +
    0.7152 * linearize(rgb[1]) +
    0.0722 * linearize(rgb[2]);
}

function contrastRatio(foreground, background) {
  const fg = parseHexColor(foreground);
  const bg = parseHexColor(background);
  if (!fg || !bg) return null;
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function auditDesignAccessibility(project) {
  if (!project || project.type !== 'design' || !project.design || !Array.isArray(project.design.elements)) {
    const error = new Error('design.accessibility.audit requires a valid design project.');
    error.code = 'HEADLESS_INVALID_QUERY';
    throw error;
  }

  const elements = project.design.elements;
  const findings = [];
  const add = (severity, ruleId, element, message, extra = {}) => {
    findings.push({
      severity,
      ruleId,
      elementId: element && typeof element.id === 'string' ? element.id : null,
      elementType: element && typeof element.type === 'string' ? element.type : null,
      message,
      ...extra
    });
  };

  for (const element of elements) {
    if (!element || typeof element !== 'object' || Array.isArray(element)) continue;
    const text = typeof element.text === 'string' ? element.text.trim() : '';
    const label = typeof element.label === 'string' ? element.label.trim() : '';

    if (element.type === 'image' && !(typeof element.alt === 'string' && element.alt.trim())) {
      add('error', 'image-alt', element, 'La imagen no tiene texto alternativo; añade alt descriptivo o confirma que es decorativa.');
    }

    if (element.type === 'button' && !text && !label) {
      add('error', 'button-name', element, 'El botón no tiene nombre accesible; añade texto visible o una etiqueta descriptiva.');
    }

    if (element.type === 'heading' && !text && !label) {
      add('warning', 'heading-name', element, 'El encabezado no tiene texto ni etiqueta descriptiva.');
    }

    if (TEXT_TYPES.has(element.type)) {
      const fontSize = Number(element.fontSize);
      const weight = Number(element.weight) || 400;
      const opacity = element.opacity == null ? 1 : Number(element.opacity);
      if (Number.isFinite(opacity) && opacity !== 1) {
        add('warning', 'text-opacity-contrast', element,
          'La opacidad de la capa puede alterar el contraste real; esta auditoría no compone el texto y el fondo sobre el canvas.',
          { opacity: Math.max(0, Math.min(1, opacity)), declaredOpacity: opacity, contrastBasis: 'opacity-not-composited' });
      }
      if (Number.isFinite(fontSize) && fontSize > 0 && fontSize < 12) {
        add('warning', 'small-text', element, 'El texto tiene un tamaño inferior a 12 px; comprueba su legibilidad en el dispositivo objetivo.', { fontSize });
      }

      const foreground = element.color;
      const background = typeof element.background === 'string' && element.background !== 'transparent'
        ? element.background
        : null;
      if (background) {
        const ratio = contrastRatio(foreground, background);
        if (ratio !== null) {
          const large = Number.isFinite(fontSize) &&
            (fontSize >= LARGE_TEXT_PX || (fontSize >= LARGE_BOLD_TEXT_PX && weight >= 700));
          const minimum = large ? 3 : 4.5;
          if (ratio < minimum) {
            add('warning', 'text-contrast', element,
              'El contraste entre el texto y su fondo declarado no alcanza el mínimo WCAG AA estimado.',
              { contrastRatio: Number(ratio.toFixed(2)), minimumContrast: minimum, contrastBasis: 'declared-layer-background' });
          }
        }
      }
    }
  }

  const counts = findings.reduce((summary, finding) => {
    summary[finding.severity] += 1;
    return summary;
  }, { error: 0, warning: 0, info: 0 });

  return {
    projectId: project.id || null,
    designRevision: Number.isInteger(project.design.revision) ? project.design.revision : 0,
    elementCount: elements.length,
    findingCount: findings.length,
    counts,
    findings,
    notes: [
      'Auditoría estática: no sustituye una revisión visual ni una prueba con tecnologías de asistencia.',
      'El contraste solo se calcula cuando el color de texto y el fondo declarado de la capa son hexadecimales de 3 o 6 dígitos.',
      'Los fondos transparentes, opacidad parcial, imágenes, superposiciones y estados interactivos requieren comprobación visual adicional.'
    ]
  };
}

module.exports = { auditDesignAccessibility, contrastRatio };
