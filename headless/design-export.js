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

function safeExportColor(value, fallback) {
  const color = String(value || fallback || '#ffffff').trim();
  return /^(#[0-9a-f]{3,8}|transparent|[a-z]{1,24}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/i.test(color)
    ? color : (fallback || '#ffffff');
}

function safeExportImageSource(value) {
  const source = String(value || '').trim();
  if (!source || source.length > MAX_IMAGE_BYTES * 1.5) return '';
  if (/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(source)) return source;
  try {
    const url = new URL(source);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch (_) {}
  return '';
}

function safeExportLink(value) {
  const source = String(value || '').trim();
  if (!source || source.length > 2048) return '';
  if (/^#layer-[a-z0-9_-]{1,120}$/i.test(source)) return source;
  try {
    const url = new URL(source);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch (_) {}
  return '';
}

function designCanvasWidth(design) {
  const fallback = ({ desktop: 1440, tablet: 768, mobile: 390 })[design && design.frame] || 1440;
  const width = Number(design && design.canvasWidth);
  return Number.isInteger(width) && width >= 100 && width <= 4000 ? width : fallback;
}

function designCanvasHeight(design) {
  const height = Number(design && design.canvasHeight);
  return Number.isInteger(height) && height >= 100 && height <= 10000 ? height : 0;
}

function designLayoutPositions(design) {
  const elements = Array.isArray(design && design.elements) ? design.elements.filter(el => !!el && typeof el === 'object') : [];
  const frameWidth = designCanvasWidth(design);
  const mode = design && design.layoutMode === 'auto' ? 'auto' : 'free';
  const positions = new Map();
  if (mode === 'free') {
    let contentBottom = 0;
    for (const el of elements) {
      const x = Number.isFinite(Number(el.x)) ? Number(el.x) : 0;
      const y = Number.isFinite(Number(el.y)) ? Number(el.y) : 0;
      const height = Math.max(20, Math.min(4000, Number(el.height) || 48));
      positions.set(el.id, { x, y });
      contentBottom = Math.max(contentBottom, y + height);
    }
    return { positions, height: Math.min(6000, Math.max(designCanvasHeight(design) || 900, contentBottom + 24)), mode, frameWidth };
  }
  const direction = design.layoutDirection === 'column' ? 'column' : 'row';
  const gap = Math.max(0, Math.min(200, Number(design.layoutGap) || 0));
  const padding = Math.max(0, Math.min(200, Number(design.layoutPadding) || 0));
  let x = padding, y = padding, rowHeight = 0;
  for (const el of elements) {
    const width = Math.max(20, Math.min(4000, Number(el.width) || 120));
    const height = Math.max(20, Math.min(4000, Number(el.height) || 48));
    if (direction === 'row') {
      if (x > padding && x + width > frameWidth - padding) {
        x = padding; y += rowHeight + gap; rowHeight = 0;
      }
      positions.set(el.id, { x, y });
      x += width + gap; rowHeight = Math.max(rowHeight, height);
    } else {
      positions.set(el.id, { x: padding, y });
      y += height + gap;
    }
  }
  const contentBottom = direction === 'row' ? y + rowHeight : y - gap;
  return { positions, height: Math.min(6000, Math.max(designCanvasHeight(design) || 900, contentBottom + padding)), mode, frameWidth, direction, gap, padding };
}

function designLayerDomId(id) {
  return 'layer-' + String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);
}

function renderSemanticDesignPage(project, projectsById, isRoot) {
  const design = project.design;
  const layout = designLayoutPositions(design);
  const autoLayout = design.layoutMode === 'auto';
  const width = layout.frameWidth;
  const height = Math.max(layout.height, designCanvasHeight(design) || 900);
  const direction = design.layoutDirection === 'column' ? 'column' : 'row';
  const gap = Math.max(0, Math.min(200, Number(design.layoutGap) || 0));
  const padding = Math.max(0, Math.min(200, Number(design.layoutPadding) || 0));
  const background = safeExportColor(design.background, '#ffffff');

  const elements = (Array.isArray(design.elements) ? design.elements : []).map(element => {
    const position = layout.positions.get(element.id) || { x: Number(element.x) || 0, y: Number(element.y) || 0 };
    const x = Math.max(0, Math.min(10000, Number(position.x) || 0));
    const y = Math.max(0, Math.min(10000, Number(position.y) || 0));
    const w = Math.max(20, Math.min(4000, Number(element.width) || 120));
    const h = Math.max(20, Math.min(4000, Number(element.height) || 48));
    const color = safeExportColor(element.color, '#111827');
    const elementBackground = safeExportColor(element.background, 'transparent');
    const fontSize = Math.max(8, Math.min(240, Number(element.fontSize) || 16));
    const weight = Math.max(100, Math.min(900, Number(element.weight) || 400));
    const radius = Math.max(0, Math.min(500, Number(element.radius) || 0));
    const align = ['left', 'center', 'right'].includes(element.textAlign) ? element.textAlign : 'left';
    const imageSource = element.type === 'image' ? safeExportImageSource(element.src) : '';
    const link = element.type === 'button' ? safeExportLink(element.href) : '';
    const flow = (Array.isArray(design.flowConnections) ? design.flowConnections : []).find(item => item && item.sourceElementId === element.id);
    const target = flow && projectsById.has(flow.targetProjectId) ? flow.targetProjectId : '';
    const flowNavigation = target && element.flowRole !== 'menu';
    const id = designLayerDomId(element.id);
    const positioning = autoLayout
      ? 'position:relative;left:auto;top:auto;flex:0 0 auto;max-width:100%;'
      : 'position:absolute;left:' + x + 'px;top:' + y + 'px;';
    const style = positioning + 'width:' + w + 'px;height:' + h + 'px;color:' + color +
      ';background:' + elementBackground + ';font-size:' + fontSize + 'px;font-weight:' + weight +
      ';text-align:' + align + ';border-radius:' + (element.type === 'ellipse' ? '50%' : radius + 'px') +
      ';display:flex;align-items:center;box-sizing:border-box;padding:' + (element.type === 'image' ? '0' : '4px') +
      ';overflow:hidden;' + (element.type === 'button' ? 'justify-content:center;text-decoration:none;' : '') +
      (element.type === 'image' ? 'object-fit:' + (['contain', 'cover', 'fill'].includes(element.objectFit) ? element.objectFit : 'cover') + ';' : '');
    const styleAttr = ' style="' + escapeHtml(style + (flowNavigation ? 'cursor:pointer' : '')) + '"';
    const flowAttrs = flowNavigation ? ' role="link" tabindex="0" data-flow-to="' + escapeHtml(target) + '"' : '';
    if (element.type === 'image') {
      if (imageSource) {
        return '<img id="' + escapeHtml(id) + '" src="' + escapeHtml(imageSource) + '" alt="' +
          escapeHtml(String(element.alt || element.label || 'Imagen').slice(0, 300)) + '"' + flowAttrs + styleAttr + '>';
      }
      return '<div id="' + escapeHtml(id) + '"' + flowAttrs + styleAttr + '>' +
        escapeHtml(element.text || 'Añade una imagen') + '</div>';
    }
    const text = element.type === 'rectangle' || element.type === 'ellipse' ? '' : escapeHtml(element.text || '');
    if (flowNavigation) {
      const tag = element.type === 'button' ? 'button' : element.type === 'heading' ? 'h1' :
        element.type === 'text' ? 'p' : 'div';
      return '<' + tag + (tag === 'button' ? ' type="button"' : '') + ' id="' + escapeHtml(id) +
        '"' + flowAttrs + styleAttr + '>' + text + '</' + tag + '>';
    }
    if (element.type === 'button' && element.flowRole === 'menu') {
      return '<button type="button" id="' + escapeHtml(id) + '" data-flow-menu="true" aria-expanded="false"' +
        styleAttr + '>' + escapeHtml(element.text || 'Menú') + '</button>';
    }
    if (element.type === 'button' && link) {
      const targetAttrs = link.startsWith('#layer-') ? '' : ' target="_blank" rel="noopener noreferrer"';
      return '<a id="' + escapeHtml(id) + '" href="' + escapeHtml(link) + '"' + targetAttrs + styleAttr +
        '>' + escapeHtml(element.text || 'Abrir enlace') + '</a>';
    }
    const tag = element.type === 'heading' ? 'h1' : element.type === 'button' ? 'button' :
      element.type === 'rectangle' || element.type === 'ellipse' ? 'div' : 'p';
    return '<' + tag + (tag === 'button' ? ' type="button"' : '') + ' id="' + escapeHtml(id) +
      '"' + styleAttr + '>' + text + '</' + tag + '>';
  }).join('\n');

  const frameStyle = autoLayout
    ? 'position:relative;width:100%;max-width:' + width + 'px;min-height:' + height +
      'px;height:auto;display:flex;flex-direction:' + direction + ';flex-wrap:' +
      (direction === 'row' ? 'wrap' : 'nowrap') + ';gap:' + gap + 'px;padding:' + padding +
      'px;align-items:flex-start;background:' + background + ';margin:0 auto;'
    : 'position:relative;width:' + width + 'px;height:' + height + 'px;background:' + background +
      ';transform-origin:top left;margin:0 auto;';
  const frameClass = 'design-frame' + (autoLayout ? ' auto-layout' : '');
  return '<section class="flow-screen" data-page-id="' + escapeHtml(project.id) + '"' +
    (isRoot ? '' : ' hidden') + '><div class="flow-viewport"><main id="' +
    (isRoot ? 'designFrame' : designLayerDomId(project.id) + '-frame') + '" class="' + frameClass +
    '" style="' + escapeHtml(frameStyle) + '">' + elements + '</main></div></section>';
}

function exportDesignHtml(project, workspaceProjects = [project]) {
  if (!project || !project.design) throw new Error('HTML export requires a design project.');
  const available = Array.isArray(workspaceProjects) ? workspaceProjects : [project];
  const projectsById = new Map(available.filter(item => item && item.type === 'design' && item.design).map(item => [item.id, item]));
  const reachable = [];
  const seen = new Set();
  function visit(item) {
    if (!item || seen.has(item.id)) return;
    seen.add(item.id);
    reachable.push(item);
    for (const connection of (item.design.flowConnections || [])) {
      if (connection && typeof connection.targetProjectId === 'string') visit(projectsById.get(connection.targetProjectId));
    }
  }
  visit(project);
  const flowMode = reachable.length > 1;
  const pages = reachable.map((item, index) => renderSemanticDesignPage(item, projectsById, index === 0)).join('');
  const width = designCanvasWidth(project.design);
  const title = escapeHtml(project.name || 'CodeLab design');
  const script = flowMode
    ? '(function(){var screens=[].slice.call(document.querySelectorAll(".flow-screen"));function fit(){var active=screens.find(function(s){return !s.hidden});if(!active)return;var f=active.querySelector(".design-frame"),v=active.querySelector(".flow-viewport");if(!f||!v)return;if(f.classList.contains("auto-layout")){f.style.transform="none";f.style.marginLeft="auto";v.style.height="auto";return;}var w=parseFloat(f.style.width)||1440,h=parseFloat(f.style.height)||900,s=Math.min(1,Math.max(.1,window.innerWidth/w));f.style.transform="scale("+s+")";f.style.marginLeft=Math.max(0,(window.innerWidth-w*s)/2)+"px";v.style.height=(h*s)+"px"}function show(id){var found=screens.find(function(s){return s.getAttribute("data-page-id")===id});if(!found)return;screens.forEach(function(s){s.hidden=s!==found});fit();window.scrollTo(0,0)}document.addEventListener("click",function(e){var nav=e.target.closest("[data-flow-to]");if(nav){e.preventDefault();show(nav.getAttribute("data-flow-to"));return}var menu=e.target.closest("[data-flow-menu]");if(menu)menu.setAttribute("aria-expanded",menu.getAttribute("aria-expanded")!=="true"?"true":"false")});document.addEventListener("keydown",function(e){var nav=e.target.closest&&e.target.closest("[data-flow-to]");if(nav&&(e.key==="Enter"||e.key===" ")){e.preventDefault();show(nav.getAttribute("data-flow-to"))}});window.addEventListener("resize",fit,{passive:true});window.addEventListener("hashchange",function(){var id=decodeURIComponent(location.hash.slice(1));if(id)show(id)});fit()})();'
    : '(function(){var f=document.getElementById("designFrame");var v=f&&f.parentNode;if(!f||!v)return;var w=' + width + ';var h=parseFloat(f.style.height)||900;function fit(){if(f.classList.contains("auto-layout")){f.style.transform="none";f.style.marginLeft="auto";v.style.height="auto";return}var scale=Math.min(1,Math.max(.1,window.innerWidth/w));f.style.transform="scale("+scale+")";f.style.marginLeft=Math.max(0,(window.innerWidth-w*scale)/2)+"px";v.style.height=(h*scale)+"px"}window.addEventListener("resize",fit,{passive:true});fit()})();';
  return '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + title + '</title><style>*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:Inter,Arial,sans-serif;overflow-x:hidden}.flow-screen{width:100%;min-height:100vh}.flow-viewport{position:relative;width:100%;overflow:hidden}.design-frame{transform-origin:top left}.design-frame.auto-layout{width:100%;max-width:100%}@media(max-width:768px){.design-frame.auto-layout{flex-direction:column!important;flex-wrap:nowrap!important;align-items:stretch!important}.design-frame.auto-layout>*{max-width:100%}}</style></head><body>' +
    pages + '<script>' + script.replace(/<\/script/gi, '<\\/script') + '</script></body></html>';
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

function convertDesignToWeb(project, workspaceProjects = [project]) {
  return { html: exportDesignHtml(project, workspaceProjects), css: '', js: '' };
}

module.exports = {
  MAX_IMPORT_BYTES,
  exportDesignJson,
  exportDesignSvg,
  exportDesignHtml,
  importDesignJson,
  convertDesignToWeb
};
