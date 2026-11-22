export const VECTOR_MODEL_VERSION = 4;

const NS = 'http://www.w3.org/2000/svg';
const clone = value => JSON.parse(JSON.stringify(value));
const uid = prefix => prefix + '-' + crypto.randomUUID();

function finite(v, fallback = 0) { return Number.isFinite(Number(v)) ? Number(v) : fallback; }
function num(v, fallback = 0) { return Number.isFinite(Number(v)) ? Number(v) : fallback; }
function escapeXml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function objectBounds(o) {
  if (o.type === 'line') {
    return { x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2), width: Math.abs(o.x2 - o.x1), height: Math.abs(o.y2 - o.y1) };
  }
  if (o.type === 'path') {
    const points = o.points || [];
    if (!points.length) return { x: 0, y: 0, width: 0, height: 0 };
    const xs = points.map(p => finite(p.x)), ys = points.map(p => finite(p.y));
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }
  if (o.type === 'group') {
    const children = o.children || [];
    if (!children.length) return { x: 0, y: 0, width: 0, height: 0 };
    const boxes = children.map(objectBounds);
    const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
    const r = Math.max(...boxes.map(b => b.x + b.width)), b = Math.max(...boxes.map(b => b.y + b.height));
    return { x, y, width: r - x, height: b - y };
  }
  return { x: finite(o.x), y: finite(o.y), width: Math.max(0, finite(o.width)), height: Math.max(0, finite(o.height)) };
}

export function auditVectorModel(model, { tolerance = 2, viewport = true } = {}) {
  const issues = [], objects = model?.objects || [], names = new Set();
  const walk = list => {
    for (const o of list) {
      if (!o.id) issues.push({ code: 'missing_id', severity: 'error', message: 'Vector object has no id.' });
      if (o.name) {
        if (names.has(o.name)) issues.push({ code: 'duplicate_name', severity: 'warning', objectId: o.id, message: 'Duplicate vector object name.' });
        names.add(o.name);
      }
      const q = objectBounds(o);
      if (![q.x, q.y, q.width, q.height].every(Number.isFinite)) issues.push({ code: 'invalid_geometry', severity: 'error', objectId: o.id, message: 'Geometry contains non-finite values.' });
      if (viewport && (q.x < -tolerance || q.y < -tolerance || q.x + q.width > model.width + tolerance || q.y + q.height > model.height + tolerance)) {
        issues.push({ code: 'out_of_bounds', severity: 'warning', objectId: o.id, message: 'Object extends outside document bounds.' });
      }
      if (o.type === 'path' && (!o.points || o.points.length < 2)) issues.push({ code: 'empty_path', severity: 'error', objectId: o.id, message: 'Path needs at least two points.' });
      if (o.type === 'text' && !String(o.text || '').trim()) issues.push({ code: 'empty_text', severity: 'warning', objectId: o.id, message: 'Text object is empty.' });
      if (o.type === 'group') walk(o.children || []);
    }
  };
  walk(objects);
  for (let i = 0; i < objects.length; i++) for (let j = i + 1; j < objects.length; j++) {
    const a = objectBounds(objects[i]), b = objectBounds(objects[j]);
    if (a.width && a.height && b.width && b.height && a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y) {
      issues.push({ code: 'bbox_overlap', severity: 'info', objects: [objects[i].id, objects[j].id], message: 'Bounding boxes overlap; verify intentional layering.' });
    }
  }
  const errors = issues.filter(i => i.severity === 'error').length, warnings = issues.filter(i => i.severity === 'warning').length;
  return { ok: errors === 0, score: Math.max(0, 100 - errors * 20 - warnings * 5), objectCount: objects.length, issues };
}

export function createVectorModel(width, height, existing = null) {
  const m = existing && typeof existing === 'object' ? clone(existing) : {};
  return {
    version: VECTOR_MODEL_VERSION,
    width: Number(m.width) || width,
    height: Number(m.height) || height,
    grid: Number(m.grid) || 8,
    snap: m.snap !== false,
    objects: Array.isArray(m.objects) ? m.objects : [],
    frames: Array.isArray(m.frames) ? m.frames : [],
    metadata: m.metadata && typeof m.metadata === 'object' ? m.metadata : { intent: '', tags: [] }
  };
}

function snap(v, model) { return model.snap ? Math.round(v / model.grid) * model.grid : v; }

function pathD(o) {
  const p = o.points || [];
  if (!p.length) return '';
  let d = 'M ' + p[0].x + ' ' + p[0].y;
  for (let i = 1; i < p.length; i++) {
    const point = p[i];
    if (point.kind === 'cubic' && point.c1 && point.c2) d += ` C ${point.c1.x} ${point.c1.y} ${point.c2.x} ${point.c2.y} ${point.x} ${point.y}`;
    else d += ` L ${point.x} ${point.y}`;
  }
  return d + (o.closed ? ' Z' : '');
}

function style(o) {
  return {
    fill: o.gradient ? `url(#g-${o.id})` : (o.fill ?? 'none'),
    stroke: o.stroke ?? '#E8EAF2',
    'stroke-width': o.strokeWidth ?? 1,
    'stroke-linecap': o.lineCap ?? 'butt',
    'stroke-linejoin': o.lineJoin ?? 'miter',
    opacity: o.opacity ?? 1,
    transform: transformString(o.transform)
  };
}

function transformString(t = {}) {
  const x = num(t.x), y = num(t.y), r = num(t.rotation), sx = num(t.scaleX, 1), sy = num(t.scaleY, 1), kx = num(t.skewX), ky = num(t.skewY);
  const parts = [];
  if (x || y) parts.push(`translate(${x} ${y})`);
  if (r) parts.push(`rotate(${r})`);
  if (kx) parts.push(`skewX(${kx})`);
  if (ky) parts.push(`skewY(${ky})`);
  if (sx !== 1 || sy !== 1) parts.push(`scale(${sx} ${sy})`);
  return parts.join(' ');
}

function defsFor(model) {
  const gradients = (model.objects || []).flatMap(flattenObjects).filter(o => o.gradient).map(o => {
    const g = o.gradient, stops = (g.stops || []).map(s => `<stop offset="${escapeXml(s.offset)}" stop-color="${escapeXml(s.color)}" stop-opacity="${num(s.opacity, 1)}"/>`).join('');
    const type = g.type === 'radial' ? 'radialGradient' : 'linearGradient';
    return type === 'radialGradient'
      ? `<radialGradient id="g-${o.id}" cx="50%" cy="50%" r="50%">${stops}</radialGradient>`
      : `<linearGradient id="g-${o.id}" x1="${num(g.x1, 0)}%" y1="${num(g.y1, 0)}%" x2="${num(g.x2, 100)}%" y2="${num(g.y2, 0)}%">${stops}</linearGradient>`;
  }).join('');
  const clips = (model.objects || []).flatMap(flattenObjects).filter(o => o.clipPath).map(o => `<clipPath id="clip-${o.id}"><path d="${escapeXml(o.clipPath)}"/></clipPath>`).join('');
  return gradients || clips ? `<defs>${gradients}${clips}</defs>` : '';
}

function flattenObjects(objects) {
  const out = [];
  for (const o of objects || []) {
    out.push(o);
    if (o.type === 'group') out.push(...flattenObjects(o.children || []));
  }
  return out;
}

function objectToSvg(o) {
  const a = Object.entries(style(o)).filter(([, v]) => v !== '').map(([k, v]) => `${k}="${escapeXml(v)}"`).join(' ');
  if (o.type === 'rect') return `<rect x="${o.x}" y="${o.y}" width="${o.width}" height="${o.height}" rx="${o.rx || 0}" ${a}/>`;
  if (o.type === 'ellipse') return `<ellipse cx="${o.x + o.width / 2}" cy="${o.y + o.height / 2}" rx="${o.width / 2}" ry="${o.height / 2}" ${a}/>`;
  if (o.type === 'line') return `<line x1="${o.x1}" y1="${o.y1}" x2="${o.x2}" y2="${o.y2}" ${a}/>`;
  if (o.type === 'path') return `<path d="${escapeXml(pathD(o))}" ${a}/>`;
  if (o.type === 'text') return `<text x="${o.x}" y="${o.y}" font-size="${o.fontSize || 16}" font-family="${escapeXml(o.fontFamily || 'sans-serif')}" ${a}>${escapeXml(o.text)}</text>`;
  if (o.type === 'group') return `<g ${a}>${(o.children || []).filter(c => !c.hidden).map(objectToSvg).join('')}</g>`;
  return '';
}

export function vectorModelToSVG(model) {
  return `<svg xmlns="${NS}" width="${model.width}" height="${model.height}" viewBox="0 0 ${model.width} ${model.height}">${defsFor(model)}${(model.objects || []).filter(o => !o.hidden).map(objectToSvg).join('')}</svg>`;
}

function setAttr(el, attrs) { for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v); }

export class VectorStudio {
  constructor({ host, getDocument, getModel, setModel, onChanged, status } = {}) {
    this.host = host; this.getDocument = getDocument; this.setModel = setModel; this.onChanged = onChanged; this.status = status || (() => {});
    this.model = createVectorModel(getDocument().width, getDocument().height, getModel?.());
    this.tool = 'select'; this.selected = new Set(); this.drag = null; this.pen = []; this.enabled = false; this.build(); this.render();
  }

  build() {
    this.host.style.position = 'relative';
    this.svg = document.createElementNS(NS, 'svg'); this.svg.id = 'pixelforge-vector-svg';
    Object.assign(this.svg.style, { position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'none', zIndex: 8, touchAction: 'none' });
    this.host.append(this.svg);

    this.bar = document.createElement('div'); this.bar.className = 'vector-toolbar';
    Object.assign(this.bar.style, { position: 'absolute', top: '12px', left: '12px', zIndex: 12, display: 'none', gap: '5px', padding: '7px', border: '1px solid #3a3e4d', borderRadius: '10px', background: 'rgba(15,17,24,.95)', flexWrap: 'wrap' });
    const tools = [
      ['select', '↖'], ['rect', '▭'], ['ellipse', '◯'], ['line', '／'], ['pen', '✒'], ['node', '◇'], ['text', 'T'],
      ['group', 'G'], ['ungroup', '↙'], ['duplicate', '⧉'], ['mirror', '⇋'], ['grad', '∿'], ['align-left', '⇤'], ['align-center', '↔'], ['align-right', '⇥'], ['align-top', '⇡'], ['align-middle', '↕'], ['align-bottom', '⇣'], ['grid', '#'],
      ['import', '⇧'], ['export', '⇩'], ['undo', '↶'], ['redo', '↷'], ['delete', '⌫']
    ];
    for (const [t, glyph] of tools) {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = glyph; button.title = t; button.dataset.vectorTool = t;
      button.style.cssText = 'min-width:34px;height:32px;border:1px solid #414656;border-radius:7px;background:#20232d;color:#e8eaf2';
      button.onclick = () => this.toolAction(t); this.bar.append(button);
    }
    this.host.append(this.bar);

    this.svg.addEventListener('pointerdown', e => this.down(e));
    this.svg.addEventListener('pointermove', e => this.move(e));
    this.svg.addEventListener('pointerup', e => this.up(e));
    this.svg.addEventListener('dblclick', e => { if (this.tool === 'pen') { e.preventDefault(); this.finishPen(); } });
    window.addEventListener('keydown', e => {
      if (!this.enabled) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && !e.target.matches('input,textarea')) this.deleteSelected();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); this.duplicateSelected(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); this.undoVector(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redoVector(); }
    });
  }

  toolAction(tool) {
    if (tool === 'import') return this.importSVG();
    if (tool === 'export') return this.exportSVG();
    if (tool === 'undo') return this.undoVector();
    if (tool === 'redo') return this.redoVector();
    if (tool === 'delete') return this.deleteSelected();
    if (tool === 'group') return this.groupSelected();
    if (tool === 'ungroup') return this.ungroupSelected();
    if (tool === 'duplicate') return this.duplicateSelected();
    if (tool === 'mirror') return this.mirrorSelected();
    if (tool === 'grad') return this.addGradient('linear');
    if (tool.startsWith('align-')) return this.align(tool.slice(6));
    if (tool === 'grid') { this.model.snap = !this.model.snap; this.status(this.model.snap ? 'Vector snapping on' : 'Vector snapping off', 'neutral'); return; }
    this.tool = tool; this.pen = []; this.status('Vector tool: ' + tool, 'neutral'); this.render();
  }

  point(e) {
    const r = this.svg.getBoundingClientRect(), d = this.getDocument();
    return {
      x: Math.max(0, Math.min(d.width, snap((e.clientX - r.left) * d.width / r.width, this.model))),
      y: Math.max(0, Math.min(d.height, snap((e.clientY - r.top) * d.height / r.height, this.model)))
    };
  }

  hit(p) {
    for (let i = this.model.objects.length - 1; i >= 0; i--) {
      const o = this.model.objects[i], b = objectBounds(o);
      if (p.x >= b.x - 8 && p.x <= b.x + b.width + 8 && p.y >= b.y - 8 && p.y <= b.y + b.height + 8) return o;
    }
    return null;
  }

  down(e) {
    const p = this.point(e); this.svg.setPointerCapture?.(e.pointerId);
    if (this.tool === 'pen') { this.pen.push(p); this.render(); return; }
    if (this.tool === 'text') {
      const text = window.prompt('Texto vectorial', 'Texto');
      if (text) { this.model.objects.push({ id: uid('text'), name: 'Text', type: 'text', x: p.x, y: p.y, text, fontSize: 16, fill: '#E8EAF2', stroke: 'none', transform: {} }); this.changed(); }
      return;
    }
    if (this.tool === 'node') {
      const o = this.hit(p);
      if (o?.type === 'path') { this.selected = new Set([o.id]); this.drag = { node: this.nearestNode(o, p) }; this.render(); }
      return;
    }
    if (this.tool === 'select') {
      const o = this.hit(p); this.selected = o ? new Set([o.id]) : new Set(); this.drag = o ? { start: p } : null; this.render(); return;
    }
    this.drag = { start: p, current: p };
  }

  move(e) {
    if (!this.drag) return;
    const p = this.point(e);
    if (this.tool === 'node' && this.drag.node) {
      const o = this.model.objects.find(item => item.id === [...this.selected][0]);
      if (o?.type === 'path' && o.points[this.drag.node]) { o.points[this.drag.node].x = p.x; o.points[this.drag.node].y = p.y; this.render(); }
      return;
    }
    this.drag.current = p; this.render();
  }

  up() {
    if (!this.drag) return;
    if (this.tool === 'node') { this.drag = null; this.changed(); return; }
    const end = this.drag.current || this.point({ clientX: 0, clientY: 0 }), s = this.drag.start, dx = end.x - s.x, dy = end.y - s.y;
    this.drag = null;
    if (this.tool === 'select') {
      const o = this.model.objects.find(item => item.id === [...this.selected][0]);
      if (o) this.translateObject(o, dx, dy);
      return;
    }
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    if (this.tool === 'rect' || this.tool === 'ellipse') this.model.objects.push({ id: uid(this.tool), name: this.tool, type: this.tool, x: Math.min(s.x, end.x), y: Math.min(s.y, end.y), width: Math.abs(dx), height: Math.abs(dy), fill: '#9B8AFB', stroke: '#E8EAF2', strokeWidth: 1, rx: this.tool === 'rect' ? 6 : 0, transform: {} });
    else if (this.tool === 'line') this.model.objects.push({ id: uid('line'), name: 'Line', type: 'line', x1: s.x, y1: s.y, x2: end.x, y2: end.y, fill: 'none', stroke: '#E8EAF2', strokeWidth: 2, transform: {} });
    if (this.tool === 'rect' || this.tool === 'ellipse' || this.tool === 'line') this.changed();
  }

  translateObject(o, dx, dy) {
    if (o.type === 'line') { o.x1 += dx; o.x2 += dx; o.y1 += dy; o.y2 += dy; }
    else if (o.type === 'path') o.points = (o.points || []).map(p => ({ ...p, x: p.x + dx, y: p.y + dy, c1: p.c1 && { ...p.c1, x: p.c1.x + dx, y: p.c1.y + dy }, c2: p.c2 && { ...p.c2, x: p.c2.x + dx, y: p.c2.y + dy } }));
    else if (o.type === 'group') (o.children || []).forEach(c => this.translateObject(c, dx, dy));
    else { o.x = (o.x || 0) + dx; o.y = (o.y || 0) + dy; }
    this.changed();
  }

  nearestNode(o, p) {
    let best = 0, distance = Infinity;
    (o.points || []).forEach((q, i) => { const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2; if (d < distance) { distance = d; best = i; } });
    return best;
  }

  finishPen() {
    if (this.pen.length < 2) return;
    this.model.objects.push({ id: uid('path'), name: 'Path', type: 'path', points: clone(this.pen), closed: false, fill: 'none', stroke: '#E8EAF2', strokeWidth: 2, lineJoin: 'round', transform: {} });
    this.pen = []; this.changed();
  }

  deleteSelected() {
    if (!this.selected.size) return;
    this.model.objects = this.model.objects.filter(o => !this.selected.has(o.id));
    this.selected.clear(); this.changed();
  }

  duplicateSelected() {
    const copies = [];
    for (const o of this.model.objects) if (this.selected.has(o.id)) {
      const c = clone(o); c.id = uid(o.type); c.name = (o.name || o.type) + ' copy'; this.translateObjectRaw(c, 8, 8); copies.push(c);
    }
    if (!copies.length) return;
    this.model.objects.push(...copies); this.selected = new Set(copies.map(o => o.id)); this.changed();
  }

  translateObjectRaw(o, dx, dy) {
    if (o.type === 'line') { o.x1 += dx; o.x2 += dx; o.y1 += dy; o.y2 += dy; }
    else if (o.type === 'path') o.points = (o.points || []).map(p => ({ ...p, x: p.x + dx, y: p.y + dy }));
    else if (o.type === 'group') (o.children || []).forEach(c => this.translateObjectRaw(c, dx, dy));
    else { o.x = (o.x || 0) + dx; o.y = (o.y || 0) + dy; }
  }

  groupSelected() {
    const ids = this.selected, items = this.model.objects.filter(o => ids.has(o.id));
    if (items.length < 2) return;
    this.model.objects = this.model.objects.filter(o => !ids.has(o.id));
    const group = { id: uid('group'), name: 'Group', type: 'group', children: clone(items), transform: {} };
    this.model.objects.push(group); this.selected = new Set([group.id]); this.changed();
  }

  ungroupSelected() {
    const groups = this.model.objects.filter(o => this.selected.has(o.id) && o.type === 'group');
    if (!groups.length) return;
    const ids = new Set(groups.map(g => g.id)), children = groups.flatMap(g => clone(g.children || []));
    this.model.objects = this.model.objects.filter(o => !ids.has(o.id)).concat(children);
    this.selected = new Set(children.map(c => c.id)); this.changed();
  }

  mirrorSelected() {
    const items = this.model.objects.filter(o => this.selected.has(o.id));
    if (!items.length) return;
    const boxes = items.map(objectBounds), left = Math.min(...boxes.map(b => b.x)), right = Math.max(...boxes.map(b => b.x + b.width)), center = (left + right) / 2;
    for (const o of items) this.mirrorRaw(o, center);
    this.changed();
  }

  mirrorRaw(o, center) {
    if (o.type === 'line') { const x1 = center * 2 - o.x1; o.x1 = center * 2 - o.x2; o.x2 = x1; }
    else if (o.type === 'path') for (const p of o.points || []) { p.x = center * 2 - p.x; if (p.c1) p.c1.x = center * 2 - p.c1.x; if (p.c2) p.c2.x = center * 2 - p.c2.x; }
    else if (o.type === 'group') (o.children || []).forEach(c => this.mirrorRaw(c, center));
    else { o.x = center * 2 - (o.x || 0) - (o.width || 0); }
  }

  align(axis) {
    const os = this.model.objects.filter(o => this.selected.has(o.id)); if (os.length < 2) return;
    const bs = os.map(objectBounds), minX = Math.min(...bs.map(b => b.x)), maxX = Math.max(...bs.map(b => b.x + b.width)), minY = Math.min(...bs.map(b => b.y)), maxY = Math.max(...bs.map(b => b.y + b.height));
    for (const o of os) {
      const b = objectBounds(o);
      if (axis === 'left') this.translateObjectRaw(o, minX - b.x, 0);
      if (axis === 'center') this.translateObjectRaw(o, minX + (maxX - minX - b.width) / 2 - b.x, 0);
      if (axis === 'right') this.translateObjectRaw(o, maxX - b.x - b.width, 0);
      if (axis === 'top') this.translateObjectRaw(o, 0, minY - b.y);
      if (axis === 'middle') this.translateObjectRaw(o, 0, minY + (maxY - minY - b.height) / 2 - b.y);
      if (axis === 'bottom') this.translateObjectRaw(o, 0, maxY - b.y - b.height);
    }
    this.changed();
  }

  addGradient(type = 'linear') {
    const object = this.model.objects.find(o => this.selected.has(o.id)); if (!object) return;
    object.gradient = { type, stops: [{ offset: 0, color: '#FFFFFF', opacity: 1 }, { offset: 100, color: '#9B8AFB', opacity: 1 }] };
    this.changed();
  }

  setTransform(patch = {}) {
    const object = this.model.objects.find(o => this.selected.has(o.id)); if (!object) return;
    object.transform = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, skewX: 0, skewY: 0, ...(object.transform || {}), ...patch };
    this.changed();
  }

  addKeyframe(time, patch) {
    const object = this.model.objects.find(o => this.selected.has(o.id)); if (!object) return;
    if (!Array.isArray(object.keyframes)) object.keyframes = [];
    object.keyframes = object.keyframes.filter(k => k.time !== time);
    object.keyframes.push({ time: Number(time), easing: 'ease-in-out', ...clone(patch) });
    object.keyframes.sort((a, b) => a.time - b.time);
    this.changed();
  }

  setAnimationFrame(frame) {
    const time = Number(frame);
    for (const o of this.model.objects) {
      const k = (o.keyframes || []).filter(x => x.time <= time).at(-1);
      if (!k) continue;
      if (k.x !== undefined) o.x = k.x; if (k.y !== undefined) o.y = k.y;
      if (k.opacity !== undefined) o.opacity = k.opacity;
      if (k.rotation !== undefined) o.transform = { ...(o.transform || {}), rotation: k.rotation };
      if (k.scaleX !== undefined) o.transform = { ...(o.transform || {}), scaleX: k.scaleX };
      if (k.scaleY !== undefined) o.transform = { ...(o.transform || {}), scaleY: k.scaleY };
    }
    this.render();
  }

  undoVector() { this.status('Vector history is shared with the document history. Use the main Undo control.', 'neutral'); }
  redoVector() { this.status('Vector history is shared with the document history. Use the main Redo control.', 'neutral'); }

  changed() { this.setModel?.(clone(this.model)); this.onChanged?.(); this.render(); }
  enable() { this.enabled = true; this.svg.style.display = 'block'; this.bar.style.display = 'flex'; this.status('Vector mode enabled · professional SVG tools', 'success'); this.render(); }
  disable() { this.enabled = false; this.svg.style.display = 'none'; this.bar.style.display = 'none'; }
  toggle() { this.enabled ? this.disable() : this.enable(); return this.enabled; }

  render() {
    this.svg.replaceChildren(); this.svg.setAttribute('viewBox', `0 0 ${this.model.width} ${this.model.height}`);
    const renderOne = o => {
      if (o.hidden) return;
      let el;
      if (o.type === 'group') {
        el = document.createElementNS(NS, 'g');
        for (const [k, v] of Object.entries(style(o))) if (v) el.setAttribute(k, v);
        for (const child of o.children || []) { const holder = document.createElementNS(NS, 'g'); holder.innerHTML = objectToSvg(child); const node = holder.firstElementChild; if (node) el.append(node); }
      } else {
        el = document.createElementNS(NS, o.type === 'text' ? 'text' : o.type);
        if (o.type === 'rect') setAttr(el, { x: o.x, y: o.y, width: o.width, height: o.height, rx: o.rx || 0 });
        else if (o.type === 'ellipse') setAttr(el, { cx: o.x + o.width / 2, cy: o.y + o.height / 2, rx: o.width / 2, ry: o.height / 2 });
        else if (o.type === 'line') setAttr(el, { x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2 });
        else if (o.type === 'path') el.setAttribute('d', pathD(o));
        else if (o.type === 'text') { setAttr(el, { x: o.x, y: o.y, 'font-size': o.fontSize || 16, 'font-family': o.fontFamily || 'sans-serif' }); el.textContent = o.text || ''; }
        for (const [k, v] of Object.entries(style(o))) if (v !== '') el.setAttribute(k, v);
      }
      if (this.selected.has(o.id)) { el.setAttribute('stroke', '#59D8B4'); el.setAttribute('stroke-width', Math.max(2, Number(o.strokeWidth || 1) + 1)); }
      this.svg.append(el);
    };
    for (const o of this.model.objects) renderOne(o);
    if (this.tool === 'pen' && this.pen.length) { const e = document.createElementNS(NS, 'path'); e.setAttribute('d', pathD({ points: this.pen })); e.setAttribute('fill', 'none'); e.setAttribute('stroke', '#59D8B4'); e.setAttribute('stroke-dasharray', '4 4'); this.svg.append(e); }
  }

  importSVG() {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.svg,image/svg+xml';
    input.onchange = async () => {
      const file = input.files?.[0]; if (!file) return;
      try {
        const xml = new DOMParser().parseFromString(await file.text(), 'image/svg+xml');
        if (xml.querySelector('parsererror')) throw new Error('Invalid SVG');
        const model = createVectorModel(this.getDocument().width, this.getDocument().height);
        for (const n of xml.querySelectorAll('rect,ellipse,line,text,path,g')) {
          if (n.tagName === 'g') continue;
          const common = { id: uid('v'), name: n.tagName, fill: n.getAttribute('fill') || 'none', stroke: n.getAttribute('stroke') || '#E8EAF2', strokeWidth: Number(n.getAttribute('stroke-width') || 1), transform: {} };
          if (n.tagName === 'rect') model.objects.push({ ...common, type: 'rect', x: Number(n.getAttribute('x') || 0), y: Number(n.getAttribute('y') || 0), width: Number(n.getAttribute('width') || 0), height: Number(n.getAttribute('height') || 0), rx: Number(n.getAttribute('rx') || 0) });
          else if (n.tagName === 'ellipse') model.objects.push({ ...common, type: 'ellipse', x: Number(n.getAttribute('cx') || 0) - Number(n.getAttribute('rx') || 0), y: Number(n.getAttribute('cy') || 0) - Number(n.getAttribute('ry') || 0), width: Number(n.getAttribute('rx') || 0) * 2, height: Number(n.getAttribute('ry') || 0) * 2 });
          else if (n.tagName === 'line') model.objects.push({ ...common, type: 'line', x1: Number(n.getAttribute('x1') || 0), y1: Number(n.getAttribute('y1') || 0), x2: Number(n.getAttribute('x2') || 0), y2: Number(n.getAttribute('y2') || 0) });
          else if (n.tagName === 'text') model.objects.push({ ...common, type: 'text', x: Number(n.getAttribute('x') || 0), y: Number(n.getAttribute('y') || 0), text: n.textContent || '', fontSize: Number(n.getAttribute('font-size') || 16) });
          else if (n.tagName === 'path') {
            const d = n.getAttribute('d') || '', nums = d.match(/-?\\d*\\.?\\d+/g)?.map(Number) || [], points = [];
            for (let k = 0; k + 1 < nums.length; k += 2) points.push({ x: nums[k], y: nums[k + 1] });
            model.objects.push({ ...common, type: 'path', points, closed: /z/i.test(d), lineJoin: 'round' });
          }
        }
        this.model = model; this.selected.clear(); this.changed(); this.status('SVG imported as editable vector objects', 'success');
      } catch (error) { this.status('SVG import failed: ' + error.message, 'error'); }
    };
    input.click();
  }

  exportSVG() {
    const blob = new Blob([vectorModelToSVG(this.model)], { type: 'image/svg+xml' }), url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = (this.getDocument().name || 'pixelforge') + '.svg'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); this.status('SVG exported', 'success');
  }

  getModel() { return clone(this.model); }
}
