'use strict';

const crypto = require('node:crypto');
const { normalizeDesignProject, renderSvg } = require('./design-engine');
const { isValidEditorImageDataUrl, MAX_EDITOR_IMAGE_DATA_URL_LENGTH } = require('./image-validation');

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['heading', 'text', 'button', 'rectangle', 'ellipse', 'image']);

function isElementVisible(element) {
  return !!element && element.visible !== false && element.hidden !== true;
}

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
  if (typeof value !== 'string') return '';
  if (/^data:/i.test(value)) return value.length <= MAX_EDITOR_IMAGE_DATA_URL_LENGTH && isValidEditorImageDataUrl(value) ? value : '';
  if (value.length > 8192) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
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
  const sourceElements = project && project.design && Array.isArray(project.design.elements) ? project.design.elements : [];
  for (const element of sourceElements) {
    if (element && element.type === 'image' && element.src && !safeImageSource(element.src)) {
      const error = new Error('Design export contains an unsafe or oversized image source.');
      error.code = 'HEADLESS_INVALID_DESIGN_EXPORT';
      throw error;
    }
  }
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
  const copy = JSON.parse(JSON.stringify(project));
  if (copy && copy.design && Array.isArray(copy.design.elements)) {
    copy.design.elements = copy.design.elements.map(element =>
      element && element.hidden === true ? { ...element, visible: false } : element
    );
  }
  return renderSvg(copy);
}

function safeExportColor(value, fallback) {
  const color = String(value || fallback || '#ffffff').trim();
  return /^(#[0-9a-f]{3,8}|transparent|[a-z]{1,24}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/i.test(color)
    ? color : (fallback || '#ffffff');
}

function safeExportImageSource(value) {
  const raw = String(value || '');
  if (!raw) return '';
  if (/^data:/i.test(raw)) return raw.length <= MAX_EDITOR_IMAGE_DATA_URL_LENGTH && isValidEditorImageDataUrl(raw) ? raw : '';
  const source = raw.trim();
  if (source.length > 8192) return '';
  if (/^(?:\/(?!\/)|\.\.?\/)[^\\\s<>]*$/.test(source)) return source;
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
  if (source.startsWith('/') && !source.startsWith('//') && !source.includes('\\') && !/[\s<>]/.test(source)) return source;
  if (/^mailto:[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+(?:\?[^\s<>]*)?$/i.test(source)) return source;
  if (/^tel:\+?[0-9(). -]{3,32}$/i.test(source)) return source;
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
  const elements = Array.isArray(design && design.elements)
    ? design.elements.filter(el => el && typeof el === 'object' && isElementVisible(el))
    : [];
  const frameWidth = designCanvasWidth(design);
  const mode = design && design.layoutMode === 'auto' ? 'auto' : 'free';
  const positions = new Map();
  if (mode === 'free') {
    let contentBottom = 0;
    for (const el of elements) {
      const rawX = Number.isFinite(Number(el.x)) ? Number(el.x) : 0;
      const rawY = Number.isFinite(Number(el.y)) ? Number(el.y) : 0;
      const x = el.xUnit === '%' ? (rawX / 100) * frameWidth : rawX;
      const canvasHeight = designCanvasHeight(design) || 900;
      const y = el.yUnit === '%' ? (rawY / 100) * canvasHeight : rawY;
      const height = designElementDimension(el, 'height', canvasHeight);
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
    const width = designElementDimension(el, 'width', Math.max(20, frameWidth - padding * 2));
    const height = designElementDimension(el, 'height', Math.max(20, (Number(design.canvasHeight) || 900) - padding * 2));
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

function designElementDimension(el, axis, containerSize) {
  const fallback = axis === 'width' ? 120 : 48;
  const unit = ['px', '%', 'auto'].includes(el && el[axis + 'Unit']) ? el[axis + 'Unit'] : 'px';
  const raw = Number(el && el[axis]);
  const value = Number.isFinite(raw) && raw > 0 ? raw : fallback;
  if (unit === '%') return Math.max(20, Math.min(4000, containerSize * Math.min(100, value) / 100));
  if (unit === 'auto' && el) {
    if (el.type === 'rectangle' || el.type === 'ellipse') return 20;
    if (el.type === 'image') return Math.max(20, Math.min(4000, value));
    const fontSize = Math.max(8, Math.min(256, Number(el.fontSize) || 16));
    const content = String(el.text || el.label || '');
    if (axis === 'width') return Math.max(40, Math.min(containerSize, Math.ceil(content.length * fontSize * 0.56 + 16)));
    const width = designElementDimension(el, 'width', containerSize);
    const charsPerLine = Math.max(1, Math.floor(width / (fontSize * 0.56)));
    return Math.max(24, Math.min(4000, Math.ceil(Math.max(1, Math.ceil(content.length / charsPerLine)) * fontSize * 1.35 + 12)));
  }
  return Math.max(20, Math.min(4000, value));
}

function designElementDimensionCss(el, axis) {
  const unit = ['px', '%', 'auto'].includes(el && el[axis + 'Unit']) ? el[axis + 'Unit'] : 'px';
  const fallback = axis === 'width' ? 120 : 48;
  const raw = Number(el && el[axis]);
  const value = Number.isFinite(raw) && raw > 0 ? raw : fallback;
  if (unit === 'auto') return el && el.type === 'image' ? Math.max(20, Math.min(4000, value)) + 'px' : 'auto';
  return unit === '%' ? Math.min(100, value) + '%' : Math.max(20, Math.min(4000, value)) + 'px';
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

  const elements = (Array.isArray(design.elements) ? design.elements : []).filter(element =>
    element && typeof element === 'object' && isElementVisible(element)
  ).map(element => {
    const position = layout.positions.get(element.id) || { x: Number(element.x) || 0, y: Number(element.y) || 0 };
    const x = Math.max(0, Math.min(10000, Number(position.x) || 0));
    const y = Math.max(0, Math.min(10000, Number(position.y) || 0));
    const w = designElementDimension(element, 'width', autoLayout ? Math.max(20, width - padding * 2) : width);
    const h = designElementDimension(element, 'height', autoLayout ? Math.max(20, (designCanvasHeight(design) || 900) - padding * 2) : (designCanvasHeight(design) || 900));
    const color = safeExportColor(element.color, '#111827');
    const elementBackground = safeExportColor(element.background, 'transparent');
    const fontSize = Math.max(8, Math.min(256, Number(element.fontSize) || 16));
    const weight = Math.max(100, Math.min(900, Number(element.weight) || 400));
    const radius = Math.max(0, Math.min(4000, Number(element.radius) || 0));
    const rotation = Number.isFinite(Number(element.rotation)) ? Math.max(-3600, Math.min(3600, Number(element.rotation))) : 0;
    const opacity = element.opacity == null ? 1 : (Number.isFinite(Number(element.opacity)) ? Math.max(0, Math.min(1, Number(element.opacity))) : 1);
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
    const widthCss = autoLayout ? designElementDimensionCss(element, 'width') : (w + 'px');
    const heightCss = autoLayout && element.heightUnit !== '%' ? designElementDimensionCss(element, 'height') : (h + 'px');
    const style = positioning + 'width:' + widthCss + ';height:' + heightCss + ';color:' + color +
      ';background:' + elementBackground + ';min-width:20px;min-height:20px;font-size:' + fontSize + 'px;font-weight:' + weight +
      ';text-align:' + align + ';border-radius:' + (element.type === 'ellipse' ? '50%' : radius + 'px') +
      ';display:flex;align-items:center;box-sizing:border-box;padding:' + (element.type === 'image' ? '0' : '4px') +
      ';overflow:hidden;opacity:' + opacity + ';' + (rotation ? 'transform:rotate(' + rotation + 'deg);transform-origin:center center;' : '') +
      (element.type === 'button' ? 'justify-content:center;text-decoration:none;' : '') +
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
      const targetAttrs = /^https?:\/\//i.test(link) ? ' target="_blank" rel="noopener noreferrer"' : '';
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
    for (const connection of (Array.isArray(item.design.flowConnections) ? item.design.flowConnections : [])) {
      if (!connection || typeof connection.targetProjectId !== 'string') continue;
      const sourceElement = (Array.isArray(item.design.elements) ? item.design.elements : [])
        .find(element => element && element.id === connection.sourceElementId);
      if (!isElementVisible(sourceElement)) continue;
      visit(projectsById.get(connection.targetProjectId));
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

function assertImportPayloadSize(input) {
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > MAX_IMPORT_BYTES) {
      const error = new Error('The design backup exceeds the 5 MB import limit.');
      error.code = 'HEADLESS_INVALID_DESIGN_IMPORT';
      throw error;
    }
    return;
  }
  if (!input || typeof input !== 'object') return;
  const seen = new WeakSet();
  const stack = [{ value: input, depth: 0 }];
  let estimatedBytes = 2;
  let visited = 0;
  const addString = value => {
    if (value.length > MAX_IMPORT_BYTES) throw new Error('oversized string');
    estimatedBytes += Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (estimatedBytes > MAX_IMPORT_BYTES) throw new Error('oversized payload');
  };
  try {
    while (stack.length) {
      const { value, depth } = stack.pop();
      if (value === null || typeof value === 'boolean' || typeof value === 'number') {
        estimatedBytes += 16;
      } else if (typeof value === 'string') {
        addString(value);
      } else if (typeof value === 'object') {
        if (depth > 100 || seen.has(value)) throw new Error('unsupported object shape');
        seen.add(value);
        if (++visited > 25000) throw new Error('too many values');
        const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value);
        for (const [key, item] of entries) {
          addString(key);
          stack.push({ value: item, depth: depth + 1 });
          estimatedBytes += 2;
          if (estimatedBytes > MAX_IMPORT_BYTES) throw new Error('oversized payload');
        }
      } else {
        throw new Error('unsupported value');
      }
      if (estimatedBytes > MAX_IMPORT_BYTES) throw new Error('oversized payload');
    }
  } catch (_) {
    const error = new Error('The design backup exceeds the 5 MB import limit or contains an unsupported object shape.');
    error.code = 'HEADLESS_INVALID_DESIGN_IMPORT';
    throw error;
  }
}

function importDesignJson(input, options = {}) {
  assertImportPayloadSize(input);
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
      ...(['px', '%'].includes(raw.xUnit) ? { xUnit: raw.xUnit } : {}),
      ...(['px', '%'].includes(raw.yUnit) ? { yUnit: raw.yUnit } : {}),
      width: clamp(raw.width, 120, raw.widthUnit === '%' ? 1 : raw.widthUnit === 'auto' ? 0 : 20, raw.widthUnit === '%' ? 100 : 4000),
      height: clamp(raw.height, 48, raw.heightUnit === '%' ? 1 : raw.heightUnit === 'auto' ? 0 : 20, raw.heightUnit === '%' ? 100 : 4000),
      ...( ['px', '%', 'auto'].includes(raw.widthUnit) ? { widthUnit: raw.widthUnit } : {}),
      ...( ['px', '%', 'auto'].includes(raw.heightUnit) ? { heightUnit: raw.heightUnit } : {}),
      ...(typeof raw.identifier === 'string' && raw.identifier.trim() ? { identifier: raw.identifier.trim().slice(0, 120) } : {}),
      ...(typeof raw.hidden === 'boolean' ? { hidden: raw.hidden } : {}),
      ...(typeof raw.visible === 'boolean' ? { visible: raw.visible } : {}),
      ...(typeof raw.locked === 'boolean' ? { locked: raw.locked } : {}),
      ...(Number.isFinite(Number(raw.opacity)) && raw.opacity !== null ? { opacity: clamp(raw.opacity, 1, 0, 1) } : {}),
      ...(Number.isFinite(Number(raw.rotation)) && raw.rotation !== null ? { rotation: clamp(raw.rotation, 0, -3600, 3600) } : {}),
      ...( ['navigate', 'menu'].includes(raw.flowRole) ? { flowRole: raw.flowRole } : {}),
      color: safeColor(raw.color, '#111827'),
      background: safeColor(raw.background, 'transparent'),
      fontSize: clamp(raw.fontSize, 16, 8, 200),
      weight: clamp(raw.weight, 400, 100, 900),
      radius: clamp(raw.radius, 0, 0, 500),
      textAlign: ['left', 'center', 'right'].includes(raw.textAlign) ? raw.textAlign : 'left',
      ...(raw.type === 'button' ? { href: safeLink(hrefRaw) } : {}),
      ...(typeof raw.href === 'string' && raw.type !== 'button' ? { href: safeLink(hrefRaw) } : {}),
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
      ...(Number.isInteger(Number(sourceDesign.canvasHeight)) && Number(sourceDesign.canvasHeight) >= 100 && Number(sourceDesign.canvasHeight) <= 10000 ? { canvasHeight: Number(sourceDesign.canvasHeight) } : {}),
      ...(Array.isArray(sourceDesign.flowConnections) ? {
        flowConnections: sourceDesign.flowConnections.filter(connection => connection && typeof connection === 'object' &&
          typeof connection.sourceElementId === 'string' && oldToNewId.has(connection.sourceElementId) &&
          typeof connection.targetProjectId === 'string' && connection.targetProjectId.length <= 200)
          .map(connection => ({ ...connection, sourceElementId: oldToNewId.get(connection.sourceElementId) }))
      } : {})
    }
  };
  return normalizeDesignProject(project);
}

function buildAiDesignCaptureContext(project, scale = 2) {
  const normalized = normalizeDesignProject(project);
  const design = normalized.design;
  const factor = Number(scale);
  if (![1, 2, 3, 4].includes(factor)) {
    const error = new Error('Capture scale must be 1, 2, 3, or 4.');
    error.code = 'HEADLESS_INVALID_CAPTURE_SCALE';
    throw error;
  }
  const layout = designLayoutPositions(design);
  const pixelWidth = layout.frameWidth * factor;
  const pixelHeight = layout.height * factor;
  if (pixelWidth * pixelHeight > 32000000) {
    const error = new Error('The requested design capture exceeds the 32-million-pixel safety limit.');
    error.code = 'HEADLESS_CAPTURE_TOO_LARGE';
    throw error;
  }
  const elements = (Array.isArray(design.elements) ? design.elements : [])
    .filter(el => el && typeof el === 'object' && isElementVisible(el))
    .map((el, index) => {
      const position = layout.positions.get(el.id) || { x: Number(el.x) || 0, y: Number(el.y) || 0 };
      const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
      const item = {
        order: index + 1,
        id: el.id || null,
        type: el.type || 'text',
        label: String(el.label || el.type || 'Elemento').slice(0, 300),
        text: String(el.text || '').slice(0, 10000),
        bounds: {
          x: Math.max(-6000, Math.min(6000, finite(position.x, 0))),
          y: Math.max(-6000, Math.min(6000, finite(position.y, 0))),
          width: designElementDimension(el, 'width', layout.mode === 'auto' ? Math.max(20, layout.frameWidth - 2 * (layout.padding || 0)) : layout.frameWidth),
          height: designElementDimension(el, 'height', layout.mode === 'auto' ? Math.max(20, (designCanvasHeight(design) || 900) - 2 * (layout.padding || 0)) : (designCanvasHeight(design) || 900))
        },
        style: {
          color: String(el.color || '#111827').slice(0, 100),
          background: String(el.background || 'transparent').slice(0, 100),
          fontSize: Math.max(8, Math.min(256, finite(el.fontSize, 16) || 16)),
          fontWeight: Math.max(100, Math.min(900, finite(el.weight, 400))),
          radius: Math.max(0, Math.min(4000, finite(el.radius, 0))),
          rotation: Math.max(-3600, Math.min(3600, finite(el.rotation, 0))),
          opacity: Math.max(0, Math.min(1, finite(el.opacity, 1))),
          textAlign: ['left', 'center', 'right'].includes(el.textAlign) ? el.textAlign : 'left'
        }
      };
      if (el.type === 'image') item.image = { alt: String(el.alt || '').slice(0, 500) };
      return item;
    });
  const name = String(normalized.name || 'Diseño sin título').slice(0, 200);
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'codelab-design';
  return {
    format: 'codelab-ai-design-capture',
    version: 1,
    designRevision: Number.isInteger(design.revision) ? design.revision : 0,
    project: name,
    frame: design.frame || 'desktop',
    image: slug + '-captura-ia.png',
    canvas: {
      width: layout.frameWidth,
      height: layout.height,
      pixelWidth,
      pixelHeight,
      scale: factor,
      background: design.background || '#ffffff'
    },
    elementCount: elements.length,
    layout: {
      mode: design.layoutMode === 'auto' ? 'auto' : 'free',
      direction: ['row', 'column'].includes(design.layoutDirection) ? design.layoutDirection : 'column',
      gap: Math.max(0, Math.min(200, Number(design.layoutGap) || 0)),
      padding: Math.max(0, Math.min(300, Number(design.layoutPadding) || 0))
    },
    elements,
    aiInstructions: 'Analiza la imagen PNG para evaluar la apariencia visual y usa este JSON para conocer las posiciones, dimensiones, textos y estilos exactos. No inventes contenido. Distingue los problemas observables de las sugerencias. Propón cambios concretos y accesibles y considera también la adaptación móvil. Proyecto: ' + name + '. Marco: ' + (design.frame || 'desktop') + ' (' + layout.frameWidth + ' × ' + layout.height + ' px).'
  };
}

function convertDesignToWeb(project, workspaceProjects = [project]) {
  return { html: exportDesignHtml(project, workspaceProjects), css: '', js: '' };
}

module.exports = {
  MAX_IMPORT_BYTES,
  exportDesignJson,
  exportDesignSvg,
  exportDesignHtml,
  buildAiDesignCaptureContext,
  importDesignJson,
  convertDesignToWeb
};
