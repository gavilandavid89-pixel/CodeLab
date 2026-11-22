/**
 * PixelForge Agent Precision Toolkit
 * Agent-only geometry helpers. These tools are deterministic and do not use an AI model.
 * They exist so an agent can construct exact geometry instead of approximating pointer gestures.
 */

const EPSILON = 1e-9;

const clone = value => JSON.parse(JSON.stringify(value));
const finite = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

export function normalizePoint(p, fallback = { x: 0, y: 0 }) {
  return { x: finite(p?.x, fallback.x), y: finite(p?.y, fallback.y) };
}

export function snapPoint(point, grid = 1, mode = 'round') {
  const p = normalizePoint(point);
  const g = Math.max(EPSILON, Math.abs(finite(grid, 1)));
  const fn = mode === 'floor' ? Math.floor : mode === 'ceil' ? Math.ceil : Math.round;
  return { x: fn(p.x / g) * g, y: fn(p.y / g) * g };
}

export function distance(a, b) {
  const p = normalizePoint(a), q = normalizePoint(b);
  return Math.hypot(q.x - p.x, q.y - p.y);
}

export function angleBetween(a, b) {
  const p = normalizePoint(a), q = normalizePoint(b);
  return Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI;
}

export function pointAt(a, b, t) {
  const p = normalizePoint(a), q = normalizePoint(b), u = clamp(Number(t), 0, 1);
  return { x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u };
}

export function rotatePoint(point, center, degrees) {
  const p = normalizePoint(point), c = normalizePoint(center);
  const r = finite(degrees) * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r);
  const dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

export function createLine(a, b, style = {}) {
  const p = normalizePoint(a), q = normalizePoint(b);
  return { type: 'line', x1: p.x, y1: p.y, x2: q.x, y2: q.y, transform: {}, ...clone(style) };
}

export function createRect(x, y, width, height, style = {}) {
  return { type: 'rect', x: finite(x), y: finite(y), width: Math.max(0, finite(width)), height: Math.max(0, finite(height)), transform: {}, ...clone(style) };
}

export function createEllipse(cx, cy, rx, ry, style = {}) {
  return { type: 'ellipse', x: finite(cx) - Math.abs(finite(rx)), y: finite(cy) - Math.abs(finite(ry)), width: Math.abs(finite(rx)) * 2, height: Math.abs(finite(ry)) * 2, transform: {}, ...clone(style) };
}

export function createRegularPolygon(cx, cy, radius, sides, rotation = -90, style = {}) {
  const count = Math.max(3, Math.floor(finite(sides, 3)));
  const r = Math.abs(finite(radius));
  const points = Array.from({ length: count }, (_, i) => {
    const a = (rotation + i * 360 / count) * Math.PI / 180;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
  return { type: 'path', points, closed: true, transform: {}, ...clone(style) };
}

export function createStar(cx, cy, outerRadius, innerRadius, points, rotation = -90, style = {}) {
  const count = Math.max(2, Math.floor(finite(points, 5)));
  const outer = Math.abs(finite(outerRadius)), inner = Math.abs(finite(innerRadius));
  const vertices = [];
  for (let i = 0; i < count * 2; i++) {
    const r = i % 2 ? inner : outer;
    const a = (rotation + i * 180 / count) * Math.PI / 180;
    vertices.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return { type: 'path', points: vertices, closed: true, transform: {}, ...clone(style) };
}

export function createBezier(points, { closed = false, style = {} } = {}) {
  const p = (points || []).map(normalizePoint);
  if (p.length < 2) throw new Error('bezier_requires_two_points');
  return {
    type: 'path',
    points: p.map((q, i) => ({
      ...q,
      kind: i === 0 ? 'line' : 'cubic',
      c1: i > 0 ? { x: q.x, y: q.y } : undefined,
      c2: i > 0 ? { x: q.x, y: q.y } : undefined
    })),
    closed: Boolean(closed),
    transform: {},
    ...clone(style)
  };
}

export function pathFromCommands(commands, style = {}) {
  const points = [];
  let current = null;
  for (const command of commands || []) {
    const type = String(command?.type || '').toUpperCase();
    if (type === 'M' || type === 'L') {
      current = normalizePoint(command);
      points.push({ ...current, kind: 'line' });
    } else if (type === 'C') {
      const end = normalizePoint(command);
      current = end;
      points.push({ ...end, kind: 'cubic', c1: normalizePoint(command.c1), c2: normalizePoint(command.c2) });
    } else {
      throw new Error('unsupported_path_command:' + type);
    }
  }
  if (points.length < 2) throw new Error('path_requires_two_points');
  return { type: 'path', points, closed: Boolean(style.closed), transform: {}, ...clone(style) };
}

export function translateObject(object, dx, dy) {
  const o = clone(object), x = finite(dx), y = finite(dy);
  const movePoint = p => ({ ...p, x: finite(p.x) + x, y: finite(p.y) + y });
  if (o.type === 'line') { o.x1 += x; o.x2 += x; o.y1 += y; o.y2 += y; }
  else if (o.type === 'path') o.points = (o.points || []).map(p => ({ ...movePoint(p), c1: p.c1 && movePoint(p.c1), c2: p.c2 && movePoint(p.c2) }));
  else if (o.type === 'group') o.children = (o.children || []).map(c => translateObject(c, x, y));
  else { o.x = finite(o.x) + x; o.y = finite(o.y) + y; }
  return o;
}

export function scaleObject(object, center, sx, sy = sx) {
  const o = clone(object), c = normalizePoint(center), xScale = finite(sx, 1), yScale = finite(sy, xScale);
  const scalePoint = p => ({ ...p, x: c.x + (finite(p.x) - c.x) * xScale, y: c.y + (finite(p.y) - c.y) * yScale });
  if (o.type === 'line') {
    const a = scalePoint({x:o.x1,y:o.y1}), b = scalePoint({x:o.x2,y:o.y2});
    o.x1=a.x;o.y1=a.y;o.x2=b.x;o.y2=b.y;
  } else if (o.type === 'path') o.points = (o.points || []).map(p => ({ ...scalePoint(p), c1:p.c1&&scalePoint(p.c1), c2:p.c2&&scalePoint(p.c2) }));
  else if (o.type === 'group') o.children=(o.children||[]).map(child=>scaleObject(child,c,xScale,yScale));
  else { const p=scalePoint({x:o.x,y:o.y}); o.x=p.x;o.y=p.y;o.width=Math.abs(finite(o.width)*xScale);o.height=Math.abs(finite(o.height)*yScale); }
  return o;
}

export function rotateObject(object, center, degrees) {
  const o = clone(object);
  const rot = p => rotatePoint(p, center, degrees);
  if (o.type === 'line') { const a=rot({x:o.x1,y:o.y1}), b=rot({x:o.x2,y:o.y2}); o.x1=a.x;o.y1=a.y;o.x2=b.x;o.y2=b.y; }
  else if (o.type === 'path') o.points=(o.points||[]).map(p=>({...rot(p), c1:p.c1&&rot(p.c1), c2:p.c2&&rot(p.c2), kind:p.kind}));
  else if (o.type === 'group') o.children=(o.children||[]).map(child=>rotateObject(child,center,degrees));
  else {
    const centerPoint=rot({x:finite(o.x)+finite(o.width)/2,y:finite(o.y)+finite(o.height)/2});
    o.x=centerPoint.x-finite(o.width)/2;o.y=centerPoint.y-finite(o.height)/2;
    o.transform={...(o.transform||{}),rotation:finite(o.transform?.rotation)+finite(degrees)};
  }
  return o;
}

export function boundsOf(object) {
  if (object.type === 'line') return { x:Math.min(object.x1,object.x2), y:Math.min(object.y1,object.y2), width:Math.abs(object.x2-object.x1), height:Math.abs(object.y2-object.y1) };
  if (object.type === 'path') {
    const ps=object.points||[];
    if(!ps.length)return{x:0,y:0,width:0,height:0};
    const xs=ps.flatMap(p=>[p.x,p.c1?.x,p.c2?.x].filter(Number.isFinite)), ys=ps.flatMap(p=>[p.y,p.c1?.y,p.c2?.y].filter(Number.isFinite));
    return{x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)};
  }
  if(object.type==='group'){
    const bs=(object.children||[]).map(boundsOf); if(!bs.length)return{x:0,y:0,width:0,height:0};
    const x=Math.min(...bs.map(b=>b.x)),y=Math.min(...bs.map(b=>b.y)),r=Math.max(...bs.map(b=>b.x+b.width)),b=Math.max(...bs.map(b=>b.y+b.height));
    return{x,y,width:r-x,height:b-y};
  }
  return{x:finite(object.x),y:finite(object.y),width:Math.max(0,finite(object.width)),height:Math.max(0,finite(object.height))};
}

export function distributeObjects(objects, axis = 'x', gap = null) {
  const items=(objects||[]).map((object,index)=>({object:clone(object),index,b:boundsOf(object)})).sort((a,b)=>axis==='x'?a.b.x-b.b.x:a.b.y-b.b.y);
  if(items.length<3)return items.map(x=>x.object);
  if(gap != null){
    const g=finite(gap);
    let cursor=axis==='x'?items[0].b.x:items[0].b.y;
    for(const item of items){
      if(axis==='x'){item.object=translateObject(item.object,cursor-item.b.x,0);cursor+=item.b.width+g;}
      else {item.object=translateObject(item.object,0,cursor-item.b.y);cursor+=item.b.height+g;}
    }
    return items.map(x=>x.object);
  }
  const first=items[0].b,last=items.at(-1).b;
  const totalSize=items.reduce((sum,item)=>sum+(axis==='x'?item.b.width:item.b.height),0);
  const span=(axis==='x'?last.x+last.width:first.y+last.height)-(axis==='x'?first.x:first.y);
  const spacing=(span-totalSize)/(items.length-1);
  let cursor=axis==='x'?first.x:first.y;
  return items.map(item=>{
    const b=item.b;
    const next=axis==='x'?translateObject(item.object,cursor-b.x,0):translateObject(item.object,0,cursor-b.y);
    cursor+=(axis==='x'?b.width:b.height)+spacing;
    return next;
  });
}

export function constructSymmetryPoints(point, center, mode = 'mirror-x', radialCount = 8) {
  const p=normalizePoint(point), c=normalizePoint(center), dx=p.x-c.x,dy=p.y-c.y;
  const variants=[p];
  if(mode==='mirror-x'||mode==='quadrant')variants.push({x:c.x-dx,y:c.y+dy});
  if(mode==='mirror-y'||mode==='quadrant')variants.push({x:c.x+dx,y:c.y-dy});
  if(mode==='quadrant')variants.push({x:c.x-dx,y:c.y-dy});
  if(mode==='radial') {
    variants.length=0;
    const count=Math.max(2,Math.floor(finite(radialCount,8)));
    for(let i=0;i<count;i++){const a=i*2*Math.PI/count;variants.push({x:c.x+dx*Math.cos(a)-dy*Math.sin(a),y:c.y+dx*Math.sin(a)+dy*Math.cos(a)});}
  }
  return variants;
}

export function projectPointToSegment(point, a, b) {
  const p=normalizePoint(point), s=normalizePoint(a), e=normalizePoint(b);
  const dx=e.x-s.x, dy=e.y-s.y, len2=dx*dx+dy*dy;
  if(len2<EPSILON)return {point:s,t:0,distance:distance(p,s)};
  const t=clamp(((p.x-s.x)*dx+(p.y-s.y)*dy)/len2,0,1);
  const q={x:s.x+t*dx,y:s.y+t*dy};
  return {point:q,t,distance:distance(p,q)};
}

export function lineIntersection(a1, a2, b1, b2) {
  const p=normalizePoint(a1), p2=normalizePoint(a2), q=normalizePoint(b1), q2=normalizePoint(b2);
  const r={x:p2.x-p.x,y:p2.y-p.y}, s={x:q2.x-q.x,y:q2.y-q.y};
  const cross=(u,v)=>u.x*v.y-u.y*v.x;
  const denominator=cross(r,s);
  if(Math.abs(denominator)<EPSILON)return {intersects:false,parallel:true};
  const qp={x:q.x-p.x,y:q.y-p.y}, t=cross(qp,s)/denominator, u=cross(qp,r)/denominator;
  return {intersects:t>=0&&t<=1&&u>=0&&u<=1, parallel:false, point:{x:p.x+t*r.x,y:p.y+t*r.y},t,u};
}

export function measureObject(object) {
  const b=boundsOf(object);
  if(object.type==='line')return {type:'line',length:distance({x:object.x1,y:object.y1},{x:object.x2,y:object.y2}),angle:angleBetween({x:object.x1,y:object.y1},{x:object.x2,y:object.y2}),bounds:b};
  if(object.type==='ellipse')return {type:'ellipse',area:Math.PI*(b.width/2)*(b.height/2),bounds:b};
  if(object.type==='rect')return {type:'rect',area:b.width*b.height,perimeter:2*(b.width+b.height),bounds:b};
  return {type:object.type,bounds:b};
}

export function makePrecisionGuide({ type = 'line', ...data } = {}) {
  return { id:'guide-' + crypto.randomUUID(), type, visible:true, locked:true, ...clone(data) };
}

export function buildAgentToolCatalog() {
  return [
    { name:'geometry.point', description:'Crear o normalizar un punto con coordenadas exactas.', precision:'subpixel' },
    { name:'geometry.line', description:'Crear una línea con extremos exactos.', precision:'subpixel' },
    { name:'geometry.rect', description:'Crear rectángulo con posición y tamaño exactos.', precision:'subpixel' },
    { name:'geometry.ellipse', description:'Crear elipse por centro y radios.', precision:'subpixel' },
    { name:'geometry.polygon', description:'Crear polígono regular con número de lados, radio y rotación.', precision:'subpixel' },
    { name:'geometry.star', description:'Crear estrella paramétrica con radios y puntas exactos.', precision:'subpixel' },
    { name:'geometry.bezier', description:'Crear trazado Bézier con puntos y manejadores exactos.', precision:'subpixel' },
    { name:'geometry.path', description:'Construir paths mediante comandos M/L/C sin gestos.', precision:'subpixel' },
    { name:'geometry.translate', description:'Mover geometría mediante delta exacto.', precision:'subpixel' },
    { name:'geometry.scale', description:'Escalar alrededor de un pivote exacto.', precision:'subpixel' },
    { name:'geometry.rotate', description:'Rotar alrededor de un pivote exacto.', precision:'subpixel' },
    { name:'geometry.distribute', description:'Distribuir objetos por eje o separación exacta.', precision:'subpixel' },
    { name:'geometry.symmetry', description:'Generar variantes simétricas o radiales.', precision:'subpixel' },
    { name:'geometry.bounds', description:'Obtener límites geométricos exactos.', precision:'subpixel' },
    { name:'geometry.project', description:'Proyectar un punto sobre un segmento y obtener distancia exacta.', precision:'subpixel' },
    { name:'geometry.intersection', description:'Calcular intersección exacta entre dos segmentos.', precision:'subpixel' },
    { name:'geometry.measure', description:'Medir longitud, ángulo, área, perímetro y bounds.', precision:'subpixel' },
    { name:'guide.create', description:'Crear guías bloqueables para construcción asistida.', precision:'subpixel' }
  ];
}
