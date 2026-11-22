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

export function createRoundedRect(x, y, width, height, radius, style = {}) {
  const w=Math.max(0,finite(width)), h=Math.max(0,finite(height));
  const r=Math.min(Math.abs(finite(radius)),w/2,h/2);
  const k=0.5522847498307936;
  const x0=finite(x), y0=finite(y), x1=x0+w, y1=y0+h;
  const c=r*k;
  const points=[
    {x:x0+r,y:y0,kind:'line'},
    {x:x1-r,y:y0,kind:'line'},
    {x:x1-r+c,y:y0,kind:'cubic',c1:{x:x1-r+c,y:y0},c2:{x:x1,y:y0+r-c}},
    {x:x1,y:y0+r,kind:'cubic',c1:{x:x1,y:y0+r-c},c2:{x:x1,y:y0+r}},
    {x:x1,y:y1-r,kind:'line'},
    {x:x1,y:y1-r+c,kind:'cubic',c1:{x:x1,y:y1-r+c},c2:{x:x1-r+c,y:y1}},
    {x:x1-r,y:y1,kind:'cubic',c1:{x:x1-r+c,y:y1},c2:{x:x1-r,y:y1}},
    {x:x0+r,y:y1,kind:'line'},
    {x:x0+r-c,y:y1,kind:'cubic',c1:{x:x0+r-c,y:y1},c2:{x:x0,y:y1-r+c}},
    {x:x0,y:y1-r,kind:'cubic',c1:{x:x0,y:y1-r+c},c2:{x:x0,y:y1-r}},
    {x:x0,y:y0+r,kind:'line'},
    {x:x0,y:y0+r-c,kind:'cubic',c1:{x:x0,y:y0+r-c},c2:{x:x0+r-c,y:y0}}
  ];
  return {type:'path',points,closed:true,transform:{},...clone(style)};
}

export function createArc(cx, cy, radius, startDegrees, endDegrees, style = {}) {
  const r=Math.abs(finite(radius)), start=finite(startDegrees)*Math.PI/180, end=finite(endDegrees)*Math.PI/180;
  let delta=end-start;
  if(Math.abs(delta)<EPSILON)delta=Math.PI*2;
  const segments=Math.max(1,Math.ceil(Math.abs(delta)/(Math.PI/2)));
  const step=delta/segments, points=[];
  for(let i=0;i<segments;i++){
    const a=start+i*step,b=a+step,k=(4/3)*Math.tan((b-a)/4);
    const p0={x:cx+r*Math.cos(a),y:cy+r*Math.sin(a)};
    const p3={x:cx+r*Math.cos(b),y:cy+r*Math.sin(b)};
    const p1={x:p0.x-k*r*Math.sin(a),y:p0.y+k*r*Math.cos(a)};
    const p2={x:p3.x+k*r*Math.sin(b),y:p3.y-k*r*Math.cos(b)};
    if(i===0)points.push({...p0,kind:'line'});
    points.push({...p3,kind:'cubic',c1:p1,c2:p2});
  }
  return {type:'path',points,closed:false,transform:{},...clone(style)};
}

export function createCircleThroughThreePoints(a,b,c,style={}) {
  const p=normalizePoint(a),q=normalizePoint(b),r=normalizePoint(c);
  const d=2*(p.x*(q.y-r.y)+q.x*(r.y-p.y)+r.x*(p.y-q.y));
  if(Math.abs(d)<EPSILON)throw new Error('collinear_points_no_unique_circle');
  const aa=p.x*p.x+p.y*p.y,bb=q.x*q.x+q.y*q.y,cc=r.x*r.x+r.y*r.y;
  const ux=(aa*(q.y-r.y)+bb*(r.y-p.y)+cc*(p.y-q.y))/d;
  const uy=(aa*(r.x-q.x)+bb*(p.x-r.x)+cc*(q.x-p.x))/d;
  return createEllipse(ux,uy,distance({x:ux,y:uy},p),distance({x:ux,y:uy},p),style);
}

export function createPolarArray(object, center, count, startDegrees=0, sweepDegrees=360) {
  const n=Math.max(1,Math.floor(finite(count,1))), c=normalizePoint(center), total=finite(sweepDegrees,360);
  return Array.from({length:n},(_,i)=>rotateObject(object,c,finite(startDegrees)+ (n===1?0:i*total/n)));
}

export function createGridArray(object, origin, columns, rows, dx, dy) {
  const cols=Math.max(1,Math.floor(finite(columns,1))), rs=Math.max(1,Math.floor(finite(rows,1)));
  const o=normalizePoint(origin);
  const result=[];
  for(let y=0;y<rs;y++)for(let x=0;x<cols;x++)result.push(translateObject(object,o.x+x*finite(dx),o.y+y*finite(dy)));
  return result;
}

export function polylineLength(points, closed=false) {
  const p=(points||[]).map(normalizePoint);
  let total=0;
  for(let i=1;i<p.length;i++)total+=distance(p[i-1],p[i]);
  if(closed&&p.length>1)total+=distance(p.at(-1),p[0]);
  return total;
}

export function nearestPointOnPolyline(point, points, closed=false) {
  const p=(points||[]).map(normalizePoint);
  if(p.length<2)return null;
  let best=null, segments=p.length-1+(closed?1:0);
  for(let i=0;i<segments;i++){
    const hit=projectPointToSegment(point,p[i],p[(i+1)%p.length]);
    if(!best||hit.distance<best.distance)best={...hit,segment:i};
  }
  return best;
}

export function alignObjectEdges(objects, edge='left', target=null) {
  const items=(objects||[]).map(object=>({object:clone(object),bounds:boundsOf(object)}));
  if(!items.length)return [];
  const ref=target==null?(edge==='right'?Math.max(...items.map(i=>i.bounds.x+i.bounds.width)):edge==='bottom'?Math.max(...items.map(i=>i.bounds.y+i.bounds.height)):edge==='center-x'?((Math.min(...items.map(i=>i.bounds.x))+Math.max(...items.map(i=>i.bounds.x+i.bounds.width))/2)):edge==='center-y'?((Math.min(...items.map(i=>i.bounds.y))+Math.max(...items.map(i=>i.bounds.y+i.bounds.height))/2)):edge==='top'?Math.min(...items.map(i=>i.bounds.y)):Math.min(...items.map(i=>i.bounds.x)):target;
  return items.map(item=>{
    const b=item.bounds;
    if(edge==='left')return translateObject(item.object,ref-b.x,0);
    if(edge==='right')return translateObject(item.object,ref-(b.x+b.width),0);
    if(edge==='top')return translateObject(item.object,0,ref-b.y);
    if(edge==='bottom')return translateObject(item.object,0,ref-(b.y+b.height));
    if(edge==='center-x')return translateObject(item.object,ref-(b.x+b.width/2),0);
    if(edge==='center-y')return translateObject(item.object,0,ref-(b.y+b.height/2));
    return item.object;
  });
}

export function makePrecisionGuide({ type = 'line', ...data } = {}) {
  return { id:'guide-' + crypto.randomUUID(), type, visible:true, locked:true, ...clone(data) };
}

export function buildAgentToolCatalog() {
  return [
    { name:'geometry.point', description:'Crear o normalizar un punto con coordenadas exactas.', precision:'subpixel' },
    { name:'geometry.line', description:'Crear una línea con extremos exactos.', precision:'subpixel' },
    { name:'geometry.roundedRect', description:'Crear rectángulo redondeado exacto.', precision:'subpixel' },
    { name:'geometry.arc', description:'Crear arco circular exacto mediante Bézier cúbico.', precision:'subpixel' },
    { name:'geometry.circle3', description:'Crear círculo definido por tres puntos.', precision:'subpixel' },
    { name:'geometry.polarArray', description:'Repetir geometría alrededor de un pivote.', precision:'subpixel' },
    { name:'geometry.gridArray', description:'Repetir geometría en una matriz exacta.', precision:'subpixel' },
    { name:'geometry.polylineLength', description:'Medir longitud de polilínea abierta o cerrada.', precision:'subpixel' },
    { name:'geometry.nearest', description:'Encontrar el punto más cercano sobre una polilínea.', precision:'subpixel' },
    { name:'geometry.edgeAlign', description:'Alinear objetos por bordes o centros exactos.', precision:'subpixel' },

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
