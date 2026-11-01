'use strict';

const crypto = require('node:crypto');
const { normalizeDesignProject, renderSvg } = require('./design-engine');

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['heading', 'text', 'button', 'rectangle', 'ellipse', 'image']);

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function clamp(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function safeColor(value, fallback) {
  const text = String(value || '').trim();
  return /^#[0-9a-f]{3,8}$/i.test(text) || text === 'transparent' ? text : fallback;
}

function safeImageSource(value) {
  if (typeof value !== 'string' || value.length > MAX_IMAGE_BYTES) return '';
  if (/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(value)) return value;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch (_) {
    return '';
  }
}

function safeLink(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim().slice(0, 2000);
  if (/^#layer-[a-z0-9_-]{1,120}$/i.test(text)) return text;
  try {
    const url = new URL(text);
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol) ? url.href : '';
  } catch (_) {
    return '';
  }
}

function normalizeCode(code) {
  const source = code && typeof code === 'object' && !Array.isArray(code) ? code : {};
  const result = {};
  for (const key of ['html', 'css', 'js']) {
    const value = typeof source[key] === 'string' ? source[key] : '';
    if (value.length > 500000) {
      const error = new Error('Imported project ' + key + ' exceeds the 500000 character limit.');
      error.code = 'HEADLESS_INVALID_DESIGN_IMPORT';
      throw error;
    }
    result[key] = value;
  }
  return result;
}

function exportDesignJson(project) {
  const payload = {
    format: 'codelab-design-project',
    version: 1,
    exportedAt: new Date().toISOString(),
    project: JSON.parse(JSON.stringify(project))
  };
  const json = JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(json, 'utf8') > MAX_IMPORT_BYTES) {
    const error = new Error('Design export exceeds the 5 MB CodeLab backup limit.');
    error.code = 'HEADLESS_DESIGN_EXPORT_TOO_LARGE';
    throw error;
  }
  return { payload, json, byteLength: Buffer.byteLength(json, 'utf8') };
}

function exportDesignSvg(project) {
  return renderSvg(project);
}

function exportDesignHtml(project) {
  const svg = renderSvg(project);
  const width = Number(project.design.canvasWidth) || 1440;
  const title = escapeHtml(project.name || 'CodeLab design');
  return '<!doctype html>\n' +
    '<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + title + '</title><style>html,body{margin:0;min-height:100%;background:#f8fafc;font-family:Arial,sans-serif}' +
    '.design-viewport{width:100%;overflow:auto;display:flex;justify-content:center;align-items:flex-start;padding:0}' +
    '.design-viewport svg{display:block;width:min(100%,' + width + 'px);height:auto;max-width:100%}</style></head>' +
    '<body><main class="design-viewport">' + svg + '</main></body></html>';
}

function importDesignJson(input, options = {}) {
  let payload;
  try {
    payload = typeof input === 'string' ? JSON.parse(input) : input;
  } catch (_) {
    const error = new Error('The design backup is not valid JSON.');
    error.code = 'HEADLESS_INVALID_DESIGN_IMPORT';
    throw error;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      payload.format !== 'codelab-design-project' || payload.version !== 1 ||
      !payload.project || typeof payload.project !== 'object' || Array.isArray(payload.project)) {
    const error = new Error('The file is not a compatible CodeLab design backup.');
    error.code = 'HEADLESS_INVALID_DESIGN_IMPORT';
    throw error;
  }
  if (typeof input === 'string' && Buffer.byteLength(input, 'utf8') > MAX_IMPORT_BYTES) {
    const error = new Error('The design backup exceeds the 5 MB import limit.');
    error.code = 'HEADLESS_INVALID_DESIGN_IMPORT';
    throw error;
  }
  const source = payload.project;
  const sourceDesign = source.design;
  if (source.type !== 'design' || !sourceDesign || typeof sourceDesign !== 'object' ||
      Array.isArray(sourceDesign) || !Array.isArray(sourceDesign.elements) || sourceDesign.elements.length > 500) {
    const error = new Error('The backup does not contain a valid CodeLab design.');
    error.code = 'HEADLESS_INVALID_DESIGN_IMPORT';
    throw error;
  }

  const idFactory = typeof options.idFactory === 'function' ? options.idFactory : () => 'el_' + crypto.randomUUID();
  const oldToNewId = new Map();
  const elements = [];
  for (const raw of sourceDesign.elements) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !ALLOWED_TYPES.has(raw.type)) {
      const error = new Error('The backup contains an invalid or unsupported layer.');
      error.code = 'HEADLESS_INVALID_DESIGN_IMPORT';
      throw error;
    }
    const id = idFactory();
    const oldId = typeof raw.id === 'string' ? raw.id : '';
    if (oldId && !oldToNewId.has(oldId)) oldToNewId.set(oldId, id);
    let src = '';
    if (raw.type === 'image' && raw.src) {
      src = safeImageSource(raw.src);
      if (!src) {
        const error = new Error('The backup contains an unsafe or oversized image source.');
        error.code = 'HEADLESS_INVALID_DESIGN_IMPORT';
        throw error;
      }
    }
    const hrefRaw = typeof raw.href === 'string' ? raw.href.trim() : '';
    elements.push({
      id,
      type: raw.type,
      label: String(raw.label || raw.type).slice(0, 300),
      text: String(raw.text || '').slice(0, 10000),
      x: clamp(raw.x, 0, -6000, 6000),
      y: clamp(raw.y, 0, -6000, 6000),
      width: clamp(raw.width, 120, 20, 4000),
      height: clamp(raw.height, 48, 20, 4000),
      color: safeColor(raw.color, '#111827'),
      background: safeColor(raw.background, 'transparent'),
      fontSize: clamp(raw.fontSize, 16, 8, 200),
      weight: clamp(raw.weight, 400, 100, 900),
      radius: clamp(raw.radius, 0, 0, 500),
      textAlign: ['left', 'center', 'right'].includes(raw.textAlign) ? raw.textAlign : 'left',
      ...(raw.type === 'button' ? { href: safeLink(hrefRaw) } : {}),
      ...(raw.type === 'image' ? {
        src, alt: String(raw.alt || raw.label || 'Imagen del diseño').slice(0, 300),
        objectFit: ['contain', 'cover', 'fill'].includes(raw.objectFit) ? raw.objectFit : 'cover'
      } : {})
    });
  }

  sourceDesign.elements.forEach((raw, index) => {
    const match = /^#layer-([a-z0-9_-]{1,120})$/i.exec(String(raw && raw.href || '').trim());
    if (match && elements[index] && elements[index].type === 'button') {
      const targetId = oldToNewId.get(match[1]);
      if (targetId) elements[index].href = '#layer-' + targetId.replace(/[^a-z0-9_-]/gi, '').slice(0, 120);
    }
  });

  const now = new Date().toISOString();
  const sourceName = String(source.name || 'Diseño').trim() || 'Diseño';
  const project = {
    id: 'proj_' + crypto.randomUUID(),
    name: sourceName.slice(0, 200 - ' (Importado)'.length) + ' (Importado)',
    type: 'design',
    hasWebSpace: true,
    hasDesignSpace: true,
    createdAt: now,
    updatedAt: now,
    code: normalizeCode(source.code),
    design: {
      elements,
      frame: ['desktop', 'tablet', 'mobile'].includes(sourceDesign.frame) ? sourceDesign.frame : 'desktop',
      background: safeColor(sourceDesign.background, '#ffffff'),
      grid: sourceDesign.grid !== false,
      gridSize: [4, 8, 16, 32].includes(Number(sourceDesign.gridSize)) ? Number(sourceDesign.gridSize) : 8,
      snapToGrid: !!sourceDesign.snapToGrid,
      layoutMode: ['free', 'auto'].includes(sourceDesign.layoutMode) ? sourceDesign.layoutMode : 'free',
      layoutDirection: ['row', 'column'].includes(sourceDesign.layoutDirection) ? sourceDesign.layoutDirection : 'row',
      layoutGap: clamp(sourceDesign.layoutGap, 16, 0, 200),
      layoutPadding: clamp(sourceDesign.layoutPadding, 24, 0, 200),
      ...(Number.isInteger(Number(sourceDesign.canvasWidth)) && Number(sourceDesign.canvasWidth) >= 100 && Number(sourceDesign.canvasWidth) <= 4000 ? { canvasWidth: Number(sourceDesign.canvasWidth) } : {}),
      ...(Number.isInteger(Number(sourceDesign.canvasHeight)) && Number(sourceDesign.canvasHeight) >= 100 && Number(sourceDesign.canvasHeight) <= 10000 ? { canvasHeight: Number(sourceDesign.canvasHeight) } : {})
    }
  };
  return normalizeDesignProject(project);
}

function convertDesignToWeb(project) {
  return { html: exportDesignHtml(project), css: '', js: '' };
}

module.exports = {
  MAX_IMPORT_BYTES,
  exportDesignJson,
  exportDesignSvg,
  exportDesignHtml,
  importDesignJson,
  convertDesignToWeb
};
