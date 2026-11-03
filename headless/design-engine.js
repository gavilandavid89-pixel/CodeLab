'use strict';

const crypto = require('node:crypto');
const { parseEditorImageDataUrl, isValidEditorImageDataUrl } = require('./image-validation');

const MAX_ELEMENTS = 500;
const MAX_CANVAS_SIZE = 10000;
const MAX_CANVAS_WIDTH = 4000;
const TYPES = new Set(['heading', 'text', 'button', 'rectangle', 'ellipse', 'image']);
const ELEMENT_FIELDS = new Set([
  'label', 'text', 'x', 'y', 'xUnit', 'yUnit', 'width', 'height', 'color', 'background',
  'fontSize', 'weight', 'radius', 'href', 'src', 'alt', 'objectFit', 'identifier',
  'widthUnit', 'heightUnit', 'opacity', 'rotation', 'visible', 'locked', 'textAlign', 'flowRole'
]);

const DEFAULTS = Object.freeze({
  heading: { label: 'Título', text: 'Título de tu diseño', x: 80, y: 70, width: 560, height: 76, color: '#111827', background: 'transparent', fontSize: 42, weight: 700, radius: 0 },
  text: { label: 'Texto', text: 'Escribe aquí tu texto', x: 84, y: 165, width: 420, height: 64, color: '#475569', background: 'transparent', fontSize: 18, weight: 400, radius: 0 },
  button: { label: 'Botón', text: 'Comenzar', x: 84, y: 250, width: 160, height: 48, color: '#ffffff', background: '#7c3aed', fontSize: 15, weight: 600, radius: 10, href: '' },
  rectangle: { label: 'Rectángulo', text: '', x: 100, y: 340, width: 240, height: 150, color: '#ffffff', background: '#dbeafe', fontSize: 16, weight: 400, radius: 16 },
  ellipse: { label: 'Elipse', text: '', x: 140, y: 340, width: 160, height: 160, color: '#ffffff', background: '#c4b5fd', fontSize: 16, weight: 400, radius: 9999 },
  image: { label: 'Imagen', text: '', x: 120, y: 420, width: 240, height: 160, color: '#111827', background: '#e2e8f0', fontSize: 16, weight: 400, radius: 8, src: '', alt: 'Imagen del diseño', objectFit: 'cover' }
});

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function finiteNumber(value, name, min = -MAX_CANVAS_SIZE, max = MAX_CANVAS_SIZE) {
  const number = Number(value);
  assert(Number.isFinite(number) && number >= min && number <= max, name + ' must be a finite number between ' + min + ' and ' + max + '.');
  return number;
}

function integerNumber(value, name, min, max) {
  const number = finiteNumber(value, name, min, max);
  assert(Number.isInteger(number), name + ' must be an integer.');
  return number;
}

function normalizeDesignProject(input) {
  assert(input && typeof input === 'object' && !Array.isArray(input), 'A project object is required.');
  assert(input.type === 'design', 'The project must be a design project.');
  const project = clone(input);
  project.design = project.design && typeof project.design === 'object' && !Array.isArray(project.design)
    ? project.design : {};
  project.design.elements = Array.isArray(project.design.elements) ? project.design.elements : [];
  assert(project.design.elements.length <= MAX_ELEMENTS, 'The design exceeds the ' + MAX_ELEMENTS + ' layer limit.');
  const ids = new Set();
  for (const element of project.design.elements) {
    assert(element && typeof element === 'object' && typeof element.id === 'string' && element.id.trim() && element.id.length <= 100, 'Every layer must have a stable id of at most 100 characters.');
    assert(!ids.has(element.id), 'Duplicate layer id: ' + element.id);
    ids.add(element.id);
  }
  project.design.frame = project.design.frame || 'desktop';
  project.design.background = project.design.background || '#ffffff';
  const defaultCanvas = legacyCanvas(project.design.frame);
  const storedCanvas = project.design.canvas && typeof project.design.canvas === 'object' && !Array.isArray(project.design.canvas) ? project.design.canvas : {};
  const width = integerNumber(project.design.canvasWidth ?? storedCanvas.width ?? defaultCanvas.width, 'canvas.width', 100, MAX_CANVAS_WIDTH);
  const height = integerNumber(project.design.canvasHeight ?? storedCanvas.height ?? defaultCanvas.height, 'canvas.height', 100, MAX_CANVAS_SIZE);
  project.design.canvasWidth = width;
  project.design.canvasHeight = height;
  project.design.canvas = { width, height, unit: 'px' };
  project.design.revision = Number.isInteger(project.design.revision) && project.design.revision >= 0 ? project.design.revision : 0;
  return project;
}

function legacyCanvas(frame) {
  // CodeLab's existing capture pipeline uses a 900px fallback height for all presets.
  const sizes = { desktop: [1440, 900], tablet: [768, 900], mobile: [390, 900] };
  const size = sizes[frame] || sizes.desktop;
  return { width: size[0], height: size[1], unit: 'px' };
}

function findElement(project, id) {
  const element = project.design.elements.find(item => item.id === id);
  assert(element, 'Layer not found: ' + id);
  return element;
}

function isElementVisible(element) {
  // Legacy editor projects use hidden:true; new headless projects use visible:false.
  return element.hidden !== true && element.visible !== false;
}

function assertUnlocked(element, operation) {
  assert(element.locked !== true, 'Cannot ' + operation + ' locked layer: ' + element.id);
}

function resolveElementSize(element, dimension, canvasDimension) {
  const raw = Number(element[dimension]);
  const unitKey = dimension + 'Unit';
  const unit = element[unitKey] || 'px';
  if (unit === '%') return Math.max(0, canvasDimension * (Number.isFinite(raw) ? raw : 0) / 100);
  if (unit === 'auto') {
    if (element.type === 'image') return Math.max(20, Math.min(4000, Number.isFinite(raw) && raw > 0 ? raw : (dimension === 'width' ? 120 : 48)));
    const fontSize = Math.max(1, Math.min(512, Number(element.fontSize) || 16));
    if (dimension === 'width' && ['heading', 'text', 'button'].includes(element.type)) {
      return Math.max(40, Math.ceil(String(element.text || '').length * fontSize * 0.56 + 24));
    }
    if (dimension === 'height' && ['heading', 'text', 'button'].includes(element.type)) {
      return Math.max(24, Math.ceil(fontSize * 1.5 + (element.type === 'button' ? 16 : 8)));
    }
    return dimension === 'width' ? 120 : 48;
  }
  return Math.max(0, Number.isFinite(raw) ? raw : 0);
}

function toStoredPosition(px, unit, canvasDimension) {
  return unit === '%' ? (canvasDimension > 0 ? px / canvasDimension * 100 : 0) : px;
}

function applyOperation(project, operation) {
  assert(operation && typeof operation === 'object' && typeof operation.type === 'string', 'A valid operation is required.');
  switch (operation.type) {
    case 'canvas.set': {
      const allowed = new Set(['type', 'width', 'height', 'frame', 'background', 'grid', 'snapToGrid', 'gridSize']);
      assert(Object.keys(operation).every(key => allowed.has(key)), 'canvas.set contains an unsupported property.');
      const hasSize = operation.width !== undefined || operation.height !== undefined;
      const hasFrame = operation.frame !== undefined;
      assert(hasSize || hasFrame || operation.background !== undefined || operation.grid !== undefined ||
        operation.snapToGrid !== undefined || operation.gridSize !== undefined, 'canvas.set requires at least one canvas property.');
      if (hasFrame) {
        assert(['desktop', 'tablet', 'mobile'].includes(operation.frame), 'frame must be desktop, tablet, or mobile.');
        project.design.frame = operation.frame;
        if (!hasSize) {
          const preset = legacyCanvas(operation.frame);
          project.design.canvasWidth = preset.width;
          project.design.canvasHeight = preset.height;
        }
      }
      if (operation.width !== undefined) project.design.canvasWidth = integerNumber(operation.width, 'canvas.width', 100, MAX_CANVAS_WIDTH);
      if (operation.height !== undefined) project.design.canvasHeight = integerNumber(operation.height, 'canvas.height', 100, MAX_CANVAS_SIZE);
      if (operation.background !== undefined) {
        assert(typeof operation.background === 'string' && isSafeColor(operation.background), 'background must be a safe CSS color.');
        project.design.background = operation.background;
      }
      if (operation.grid !== undefined) {
        assert(typeof operation.grid === 'boolean', 'grid must be boolean.');
        project.design.grid = operation.grid;
      }
      if (operation.snapToGrid !== undefined) {
        assert(typeof operation.snapToGrid === 'boolean', 'snapToGrid must be boolean.');
        project.design.snapToGrid = operation.snapToGrid;
      }
      if (operation.gridSize !== undefined) {
        assert([4, 8, 16, 32].includes(operation.gridSize), 'gridSize must be 4, 8, 16, or 32.');
        project.design.gridSize = operation.gridSize;
      }
      project.design.canvas = {
        width: project.design.canvasWidth,
        height: project.design.canvasHeight,
        unit: 'px'
      };
      return { type: operation.type, canvas: clone(project.design.canvas), frame: project.design.frame };
    }
    case 'layout.set': {
      const allowed = new Set(['type', 'mode', 'direction', 'gap', 'padding']);
      assert(Object.keys(operation).every(key => allowed.has(key)), 'layout.set contains an unsupported property.');
      if (operation.mode !== undefined) {
        assert(['free', 'auto'].includes(operation.mode), 'layout mode must be free or auto.');
        project.design.layoutMode = operation.mode;
      }
      if (operation.direction !== undefined) {
        assert(['row', 'column'].includes(operation.direction), 'layout direction must be row or column.');
        project.design.layoutDirection = operation.direction;
      }
      if (operation.gap !== undefined) project.design.layoutGap = integerNumber(operation.gap, 'layout gap', 0, 200);
      if (operation.padding !== undefined) project.design.layoutPadding = integerNumber(operation.padding, 'layout padding', 0, 200);
      assert(['mode', 'direction', 'gap', 'padding'].some(key => operation[key] !== undefined), 'layout.set requires at least one layout property.');
      return { type: operation.type, mode: project.design.layoutMode || 'free', direction: project.design.layoutDirection || 'row', gap: project.design.layoutGap ?? 16, padding: project.design.layoutPadding ?? 24 };
    }
    case 'image.attach': {
      const allowed = new Set(['type', 'id', 'dataUrl', 'filename']);
      assert(Object.keys(operation).every(key => allowed.has(key)), 'image.attach contains an unsupported property.');
      const element = findElement(project, operation.id);
      assertUnlocked(element, 'attach an image to');
      assert(element.type === 'image', 'image.attach requires an image layer.');
      const parsed = parseEditorImageDataUrl(operation.dataUrl);
      element.src = operation.dataUrl;
      const filename = typeof operation.filename === 'string' ? operation.filename.trim().slice(0, 255) : '';
      const baseName = filename.split('/').pop().split('\\').pop();
      const extensionIndex = baseName.lastIndexOf('.');
      const fallbackAlt = (extensionIndex > 0 ? baseName.slice(0, extensionIndex) : baseName).trim().slice(0, 300);
      if (!element.alt || element.alt === 'Imagen del diseño') {
        element.alt = fallbackAlt || 'Imagen del diseño';
      }
      return { type: operation.type, id: element.id, mimeType: parsed.mimeType, byteLength: parsed.byteLength, alt: element.alt };
    }
    case 'element.add': {
      assert(TYPES.has(operation.elementType), 'Unsupported layer type.');
      assert(project.design.elements.length < MAX_ELEMENTS, 'The design reached the ' + MAX_ELEMENTS + ' layer limit.');
      const id = operation.id || 'el_' + crypto.randomUUID();
      assert(typeof id === 'string' && id.length <= 100, 'Invalid layer id.');
      assert(!project.design.elements.some(item => item.id === id), 'Layer id already exists: ' + id);
      const element = { id, type: operation.elementType, ...clone(DEFAULTS[operation.elementType]), ...(operation.properties || {}) };
      validateProperties(operation.properties || {}, element);
      project.design.elements.push(element);
      return { type: operation.type, element: clone(element) };
    }
    case 'element.update': {
      assert(operation.properties && typeof operation.properties === 'object' && !Array.isArray(operation.properties), 'Layer properties are required.');
      const element = findElement(project, operation.id);
      const unlockOnly = element.locked === true && Object.keys(operation.properties).length === 1 && operation.properties.locked === false;
      if (!unlockOnly) assertUnlocked(element, 'update');
      validateProperties(operation.properties, element);
      if (operation.properties.visible === true) element.hidden = false;
      Object.assign(element, clone(operation.properties));
      return { type: operation.type, id: element.id, element: clone(element) };
    }
    case 'element.duplicate': {
      assert(project.design.elements.length < MAX_ELEMENTS, 'The design reached the ' + MAX_ELEMENTS + ' layer limit.');
      const source = findElement(project, operation.id);
      assertUnlocked(source, 'duplicate');
      const id = operation.newId || 'el_' + crypto.randomUUID();
      assert(typeof id === 'string' && id.length <= 100 && !project.design.elements.some(item => item.id === id), 'Invalid or duplicate new layer id.');
      const canvasWidth = Number(project.design.canvasWidth) || legacyCanvas(project.design.frame).width;
      const canvasHeight = Number(project.design.canvasHeight) || legacyCanvas(project.design.frame).height;
      const copy = {
        ...clone(source), id,
        x: toStoredPosition((Number(source.x) || 0) * (source.xUnit === '%' ? canvasWidth / 100 : 1) + 24, source.xUnit, canvasWidth),
        y: toStoredPosition((Number(source.y) || 0) * (source.yUnit === '%' ? canvasHeight / 100 : 1) + 24, source.yUnit, canvasHeight),
        label: (source.label || 'Capa') + ' copia'
      };
      project.design.elements.push(copy);
      return { type: operation.type, sourceId: source.id, element: clone(copy) };
    }
    case 'element.reorder': {
      const index = project.design.elements.findIndex(item => item.id === operation.id);
      assert(index >= 0, 'Layer not found: ' + operation.id);
      assertUnlocked(project.design.elements[index], 'reorder');
      assert(Number.isInteger(operation.targetIndex) && operation.targetIndex >= 0 && operation.targetIndex < project.design.elements.length, 'targetIndex is outside the layer range.');
      const [element] = project.design.elements.splice(index, 1);
      project.design.elements.splice(operation.targetIndex, 0, element);
      return { type: operation.type, id: element.id, index: operation.targetIndex };
    }
    case 'elements.delete': {
      assert(Array.isArray(operation.ids) && operation.ids.length > 0 && operation.ids.length <= 100, 'elements.delete requires 1 to 100 layer IDs.');
      assert(new Set(operation.ids).size === operation.ids.length, 'elements.delete IDs must be unique.');
      for (const id of operation.ids) assertUnlocked(findElement(project, id), 'delete');
      const deleted = new Set(operation.ids);
      project.design.elements = project.design.elements.filter(item => !deleted.has(item.id));
      if (Array.isArray(project.design.flowConnections)) {
        project.design.flowConnections = project.design.flowConnections.filter(connection => !deleted.has(connection.sourceElementId));
      }
      return { type: operation.type, deletedIds: Array.from(deleted) };
    }
    case 'elements.align': {
      assert(Array.isArray(operation.ids) && operation.ids.length > 0 && operation.ids.length <= 50, 'elements.align requires 1 to 50 layer IDs.');
      assert(new Set(operation.ids).size === operation.ids.length, 'elements.align IDs must be unique.');
      assert(['left', 'center-x', 'right', 'top', 'center-y', 'bottom'].includes(operation.mode), 'Unsupported alignment mode.');
      const elements = operation.ids.map(id => findElement(project, id));
      for (const element of elements) assertUnlocked(element, 'align');
      const canvasWidth = Number(project.design.canvasWidth) || legacyCanvas(project.design.frame).width;
      const canvasHeight = Number(project.design.canvasHeight) || legacyCanvas(project.design.frame).height;
      const rects = elements.map(el => ({
        el,
        x: (Number(el.x) || 0) * (el.xUnit === '%' ? canvasWidth / 100 : 1),
        y: (Number(el.y) || 0) * (el.yUnit === '%' ? canvasHeight / 100 : 1),
        width: resolveElementSize(el, 'width', canvasWidth),
        height: resolveElementSize(el, 'height', canvasHeight)
      }));
      const left = Math.min(...rects.map(r => r.x)), top = Math.min(...rects.map(r => r.y));
      const right = Math.max(...rects.map(r => r.x + r.width)), bottom = Math.max(...rects.map(r => r.y + r.height));
      for (const r of rects) {
        if (['left', 'center-x', 'right'].includes(operation.mode)) {
          let nextX = r.x;
          if (operation.mode === 'left') nextX = left;
          if (operation.mode === 'center-x') nextX = left + (right - left - r.width) / 2;
          if (operation.mode === 'right') nextX = right - r.width;
          r.el.xUnit = r.el.xUnit || 'px';
          r.el.x = toStoredPosition(nextX, r.el.xUnit, canvasWidth);
        }
        if (['top', 'center-y', 'bottom'].includes(operation.mode)) {
          let nextY = r.y;
          if (operation.mode === 'top') nextY = top;
          if (operation.mode === 'center-y') nextY = top + (bottom - top - r.height) / 2;
          if (operation.mode === 'bottom') nextY = bottom - r.height;
          r.el.yUnit = r.el.yUnit || 'px';
          r.el.y = toStoredPosition(nextY, r.el.yUnit, canvasHeight);
        }
      }
      return { type: operation.type, mode: operation.mode, ids: operation.ids.slice() };
    }
    case 'elements.distribute': {
      assert(Array.isArray(operation.ids) && operation.ids.length >= 3 && operation.ids.length <= 100, 'elements.distribute requires 3 to 100 layer IDs.');
      assert(new Set(operation.ids).size === operation.ids.length, 'elements.distribute IDs must be unique.');
      assert(['horizontal', 'vertical'].includes(operation.axis), 'axis must be horizontal or vertical.');
      const canvasWidth = Number(project.design.canvasWidth) || legacyCanvas(project.design.frame).width;
      const canvasHeight = Number(project.design.canvasHeight) || legacyCanvas(project.design.frame).height;
      const isHorizontal = operation.axis === 'horizontal';
      const items = operation.ids.map(id => findElement(project, id)).map(el => {
        assertUnlocked(el, 'distribute');
        const unit = isHorizontal ? el.xUnit : el.yUnit;
        const canvasDimension = isHorizontal ? canvasWidth : canvasHeight;
        const dimension = isHorizontal ? 'width' : 'height';
        const position = Number(isHorizontal ? el.x : el.y) || 0;
        return {
          el, unit, canvasDimension,
          position: position * (unit === '%' ? canvasDimension / 100 : 1),
          size: resolveElementSize(el, dimension, canvasDimension)
        };
      }).sort((a, b) => a.position - b.position);
      const start = items[0].position;
      const end = items[items.length - 1].position + items[items.length - 1].size;
      const totalSize = items.reduce((sum, item) => sum + item.size, 0);
      const gap = (end - start - totalSize) / (items.length - 1);
      let cursor = start;
      for (const item of items) {
        const stored = toStoredPosition(cursor, item.unit, item.canvasDimension);
        if (operation.axis === 'horizontal') item.el.x = stored; else item.el.y = stored;
        cursor += item.size + gap;
      }
      return { type: operation.type, axis: operation.axis, ids: operation.ids.slice(), gap };
    }
    case 'element.delete': {
      const index = project.design.elements.findIndex(item => item.id === operation.id);
      assert(index >= 0, 'Layer not found: ' + operation.id);
      assertUnlocked(project.design.elements[index], 'delete');
      const [removed] = project.design.elements.splice(index, 1);
      if (Array.isArray(project.design.flowConnections)) {
        project.design.flowConnections = project.design.flowConnections.filter(connection => connection.sourceElementId !== removed.id);
      }
      return { type: operation.type, id: removed.id };
    }
    default:
      throw new Error('Unsupported headless operation: ' + operation.type);
  }
}

function validateProperties(properties, currentElement = {}) {
  const candidate = { ...currentElement, ...properties };
  const numericKeys = ['x', 'y', 'width', 'height', 'fontSize', 'weight', 'radius', 'opacity', 'rotation'];
  const validateNumeric = key => {
    const value = candidate[key];
    if (key === 'opacity' && value === null) return;
    assert(typeof value === 'number' && Number.isFinite(value), key + ' must be a finite JSON number.');
    let min = -MAX_CANVAS_SIZE, max = MAX_CANVAS_SIZE;
    if (key === 'x' || key === 'y') {
      if (candidate[key + 'Unit'] === '%') { min = -200; max = 200; }
    } else if (key === 'width' || key === 'height') {
      const unit = candidate[key + 'Unit'] || 'px';
      if (unit === '%') { min = 1; max = 100; }
      else if (unit === 'auto') { min = 0; max = 4000; }
      else { min = 20; max = 4000; }
    } else if (key === 'fontSize') { min = 8; max = 256; }
    else if (key === 'weight') { min = 100; max = 900; }
    else if (key === 'radius') { min = 0; max = 4000; }
    else if (key === 'opacity') { min = 0; max = 1; }
    else if (key === 'rotation') { min = -3600; max = 3600; }
    assert(value >= min && value <= max, key + ' must be between ' + min + ' and ' + max + ' for its unit.');
  };
  for (const [key, value] of Object.entries(properties)) {
    assert(ELEMENT_FIELDS.has(key), 'Layer property is not editable: ' + key);
    if (numericKeys.includes(key)) {
      if (key === 'opacity' && value === null) continue;
      candidate[key] = value;
      validateNumeric(key);
    } else if (['xUnit', 'yUnit'].includes(key)) {
      assert(['px', '%'].includes(value), key + ' must be px or %.');
      const coordinate = key[0];
      if (candidate[coordinate] !== undefined) validateNumeric(coordinate);
    } else if (['widthUnit', 'heightUnit'].includes(key)) {
      assert(['px', '%', 'auto'].includes(value), key + ' must be px, %, or auto.');
      const dimension = key.startsWith('width') ? 'width' : 'height';
      if (candidate[dimension] !== undefined) validateNumeric(dimension);
    } else if (['label', 'text', 'color', 'background', 'href', 'src', 'alt', 'objectFit', 'textAlign', 'flowRole', 'identifier'].includes(key)) {
      assert(typeof value === 'string' && value.length <= (key === 'src' ? 2800000 : 10000), key + ' must be a bounded string.');
      if (key === 'color' || key === 'background') assert(isSafeColor(value), key + ' must be a safe CSS color.');
      if (key === 'href') assert(isSafeHref(value), 'href must use a safe URL scheme.');
      if (key === 'src') assert(isSafeImageSource(value), 'src must be a safe image URL or image data URL.');
      if (key === 'objectFit') assert(['contain', 'cover', 'fill'].includes(value), 'objectFit must be contain, cover, or fill.');
      if (key === 'textAlign') assert(['left', 'center', 'right'].includes(value), 'textAlign must be left, center, or right.');
      if (key === 'flowRole') assert(['', 'menu', 'navigate'].includes(value), 'flowRole is not supported by the headless engine.');
      if (key === 'identifier') assert(value.length <= 100, 'identifier must be at most 100 characters.');
    } else if (['visible', 'locked'].includes(key)) {
      assert(typeof value === 'boolean', key + ' must be boolean.');
    }
  }
}

function escapeXml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  })[char]);
}

function isSafeColor(value) {
  return /^(#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|transparent|[a-z]{1,24}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/i.test(String(value || ''));
}

function isSafeHref(value) {
  const href = String(value || '').trim();
  return !href || /^(https?:\/\/|mailto:|tel:|\/|#layer-[a-z0-9_-]+$)/i.test(href);
}

function isSafeImageSource(value) {
  const src = String(value || '').trim();
  if (!src) return true;
  if (/^data:/i.test(src)) return isValidEditorImageDataUrl(src);
  return /^(https?:\/\/|\/|\.\.?\/)/i.test(src) && !/[\x00-\x20]/.test(src);
}

function getDesignLayout(design) {
  const elements = (Array.isArray(design.elements) ? design.elements : []).filter(isElementVisible);
  const frameWidth = Number(design.canvasWidth) || legacyCanvas(design.frame).width;
  const mode = design.layoutMode === 'auto' ? 'auto' : 'free';
  const positions = new Map();
  if (mode === 'free') {
    let contentBottom = 0;
    for (const element of elements) {
      const rawX = Number.isFinite(Number(element.x)) ? Number(element.x) : 0;
      const rawY = Number.isFinite(Number(element.y)) ? Number(element.y) : 0;
      const x = element.xUnit === '%' ? (rawX / 100) * frameWidth : rawX;
      const canvasHeight = Number(design.canvasHeight) || legacyCanvas(design.frame).height;
      const y = element.yUnit === '%' ? (rawY / 100) * canvasHeight : rawY;
      const height = Math.max(20, Math.min(4000, resolveElementSize(element, 'height', Number(design.canvasHeight) || legacyCanvas(design.frame).height)));
      positions.set(element.id, { x, y });
      contentBottom = Math.max(contentBottom, y + height);
    }
    return { positions, height: Math.min(6000, Math.max(Number(design.canvasHeight) || 900, contentBottom + 24)) };
  }
  const direction = design.layoutDirection === 'column' ? 'column' : 'row';
  const gap = Math.max(0, Math.min(200, Number(design.layoutGap) || 0));
  const padding = Math.max(0, Math.min(200, Number(design.layoutPadding) || 24));
  let x = padding, y = padding, rowHeight = 0;
  for (const element of elements) {
    const width = Math.max(20, Math.min(4000, resolveElementSize(element, 'width', frameWidth)));
    const height = Math.max(20, Math.min(4000, resolveElementSize(element, 'height', Number(design.canvasHeight) || legacyCanvas(design.frame).height)));
    if (direction === 'row') {
      if (x > padding && x + width > frameWidth - padding) {
        x = padding; y += rowHeight + gap; rowHeight = 0;
      }
      positions.set(element.id, { x, y });
      x += width + gap;
      rowHeight = Math.max(rowHeight, height);
    } else {
      positions.set(element.id, { x: padding, y });
      y += height + gap;
    }
  }
  const contentBottom = direction === 'row' ? y + rowHeight : y - gap;
  return { positions, height: Math.min(6000, Math.max(Number(design.canvasHeight) || 900, contentBottom + padding)) };
}

function renderSvg(input) {
  const project = normalizeDesignProject(input);
  const { width } = project.design.canvas;
  const layout = getDesignLayout(project.design);
  const height = layout.height;
  const background = isSafeColor(project.design.background) ? project.design.background : '#ffffff';
  const parts = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">',
    '<rect width="100%" height="100%" fill="' + escapeXml(background) + '"/>'
  ];
  for (const el of project.design.elements) {
    if (!isElementVisible(el)) continue;
    const position = layout.positions.get(el.id) || { x: Number(el.x) || 0, y: Number(el.y) || 0 };
    const x = finiteNumber(position.x ?? 0, 'x'), y = finiteNumber(position.y ?? 0, 'y');
    const w = finiteNumber(resolveElementSize(el, 'width', width), 'width', 0);
    const h = finiteNumber(resolveElementSize(el, 'height', Number(project.design.canvasHeight) || legacyCanvas(project.design.frame).height), 'height', 0);
    const fill = isSafeColor(el.background) ? el.background : 'transparent';
    const color = isSafeColor(el.color) ? el.color : '#111827';
    const radius = finiteNumber(el.radius ?? 0, 'radius', 0);
    const opacity = finiteNumber(el.opacity ?? 1, 'opacity', 0, 1);
    const rotation = finiteNumber(el.rotation ?? 0, 'rotation', -3600, 3600);
    const transform = rotation ? ' transform="rotate(' + rotation + ' ' + (x + w / 2) + ' ' + (y + h / 2) + ')"' : '';
    const common = ' opacity="' + opacity + '"' + transform;
    if (el.type === 'ellipse') {
      parts.push('<ellipse cx="' + (x + w / 2) + '" cy="' + (y + h / 2) + '" rx="' + (w / 2) + '" ry="' + (h / 2) + '" fill="' + escapeXml(fill) + '"' + common + '/>');
    } else if (el.type === 'rectangle' || el.type === 'button' || el.type === 'heading' || el.type === 'text') {
      if (fill !== 'transparent') parts.push('<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + radius + '" fill="' + escapeXml(fill) + '"' + common + '/>');
    } else if (el.type === 'image') {
      if (fill !== 'transparent') parts.push('<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + radius + '" fill="' + escapeXml(fill) + '"' + common + '/>');
      if (el.src && isSafeImageSource(el.src)) {
        const fit = el.objectFit === 'contain' ? 'xMidYMid meet' : el.objectFit === 'fill' ? 'none' : 'xMidYMid slice';
        parts.push('<image href="' + escapeXml(el.src) + '" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" preserveAspectRatio="' + fit + '"' + common + '/>');
      }
    }
    if (['heading', 'text', 'button'].includes(el.type) && el.text) {
      const fontSize = finiteNumber(el.fontSize ?? 16, 'fontSize', 1, 512);
      const align = ['left', 'center', 'right'].includes(el.textAlign) ? el.textAlign : 'left';
      const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';
      const textX = align === 'center' ? x + w / 2 : align === 'right' ? x + w : x;
      parts.push('<text x="' + textX + '" y="' + (y + fontSize) + '" text-anchor="' + anchor + '" fill="' + escapeXml(color) + '" font-size="' + fontSize + '" font-weight="' + finiteNumber(el.weight ?? 400, 'weight', 100, 900) + '"' + common + '>' + escapeXml(el.text) + '</text>');
    }
  }
  parts.push('</svg>');
  return parts.join('');
}

function createDesignEngine() {
  return Object.freeze({
    inspect(input) {
      const project = normalizeDesignProject(input);
      return {
        projectId: project.id || null,
        revision: project.design.revision,
        canvas: clone(project.design.canvas),
        elementCount: project.design.elements.length,
        elements: clone(project.design.elements)
      };
    },
    renderSvg,
    transact(input, operations, options = {}) {
      assert(Array.isArray(operations) && operations.length > 0 && operations.length <= 500, 'A batch of 1–500 operations is required.');
      const project = normalizeDesignProject(input);
      const expectedRevision = options.expectedRevision;
      if (expectedRevision !== undefined && expectedRevision !== project.design.revision) {
        const error = new Error('Revision conflict: expected ' + expectedRevision + ', current ' + project.design.revision + '.');
        error.code = 'REVISION_CONFLICT';
        error.revision = project.design.revision;
        throw error;
      }
      const results = operations.map(operation => applyOperation(project, operation));
      project.design.revision += 1;
      project.updatedAt = new Date().toISOString();
      return { project, revision: project.design.revision, results, svg: renderSvg(project) };
    }
  });
}

module.exports = { createDesignEngine, normalizeDesignProject, renderSvg, MAX_ELEMENTS, MAX_CANVAS_SIZE };
