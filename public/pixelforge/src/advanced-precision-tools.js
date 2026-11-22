/**
 * PixelForge AI Precision Expansion
 * Deterministic construction, snapping, curve inspection, intent planning and diagnostics.
 * No model calls, timers, network, or editor-specific side effects.
 */
const EPS = 1e-9;
const n = (v, d = 0) => Number.isFinite(Number(v)) ? Number(v) : d;
const pt = p => ({ x:n(p?.x), y:n(p?.y) });
const clone = v => JSON.parse(JSON.stringify(v));
const sub = (a,b) => ({x:a.x-b.x,y:a.y-b.y});
const add = (a,b) => ({x:a.x+b.x,y:a.y+b.y});
const mul = (a,s) => ({x:a.x*s,y:a.y*s});
const dot = (a,b) => a.x*b.x+a.y*b.y;
const cross = (a,b) => a.x*b.y-a.y*b.x;
const len = v => Math.hypot(v.x,v.y);
const norm = v => { const l=len(v); return l<EPS?{x:0,y:0}:{x:v.x/l,y:v.y/l}; };
const dist = (a,b) => Math.hypot(n(b?.x)-n(a?.x),n(b?.y)-n(a?.y));
const lerp = (a,b,t) => ({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});

function endpoints(o) {
  if (o?.type === 'line') return [{x:n(o.x1),y:n(o.y1)},{x:n(o.x2),y:n(o.y2)}];
  if (o?.type === 'path' && Array.isArray(o.points) && o.points.length) return [pt(o.points[0]),pt(o.points.at(-1))];
  return [];
}
function bbox(o) {
  if (o?.type === 'line') return {x:Math.min(o.x1,o.x2),y:Math.min(o.y1,o.y2),width:Math.abs(o.x2-o.x1),height:Math.abs(o.y2-o.y1)};
  if (o?.type === 'path') {
    const p=(o.points||[]).flatMap(q=>[q.x,q.y,q.c1?.x,q.c1?.y,q.c2?.x,q.c2?.y]).filter(Number.isFinite);
    if(!p.length)return{x:0,y:0,width:0,height:0};
    const xs=p.filter((_,i)=>i%2===0),ys=p.filter((_,i)=>i%2===1);
    const x=Math.min(...xs),y=Math.min(...ys),r=Math.max(...xs),b=Math.max(...ys);
    return{x,y,width:r-x,height:b-y};
  }
  return {x:n(o?.x),y:n(o?.y),width:Math.max(0,n(o?.width)),height:Math.max(0,n(o?.height))};
}
function pointFromObject(o, anchor='center') {
  const e=endpoints(o), b=bbox(o);
  if(e.length===2) {
    if(anchor==='start')return e[0]; if(anchor==='end')return e[1]; if(anchor==='midpoint')return lerp(e[0],e[1],.5);
  }
  const map={
    topLeft:{x:b.x,y:b.y},top:{x:b.x+b.width/2,y:b.y},topRight:{x:b.x+b.width,y:b.y},
    left:{x:b.x,y:b.y+b.height/2},center:{x:b.x+b.width/2,y:b.y+b.height/2},right:{x:b.x+b.width,y:b.y+b.height/2},
    bottomLeft:{x:b.x,y:b.y+b.height},bottom:{x:b.x+b.width/2,y:b.y+b.height},bottomRight:{x:b.x+b.width,y:b.y+b.height}
  };
  return map[anchor]||map.center;
}

export function anchorPoint(object, anchor='center') { return pointFromObject(object,anchor); }

export function coordinateFrame(origin={x:0,y:0}, angleDegrees=0) {
  const a=n(angleDegrees)*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
  return {origin:pt(origin),xAxis:{x:c,y:s},yAxis:{x:-s,y:c},angleDegrees:n(angleDegrees)};
}
export function localToWorld(point, frame) {
  const f=coordinateFrame(frame?.origin,frame?.angleDegrees),p=pt(point);
  return {x:f.origin.x+p.x*f.xAxis.x+p.y*f.yAxis.x,y:f.origin.y+p.x*f.xAxis.y+p.y*f.yAxis.y};
}
export function worldToLocal(point, frame) {
  const f=coordinateFrame(frame?.origin,frame?.angleDegrees),v=sub(pt(point),f.origin);
  return {x:dot(v,f.xAxis),y:dot(v,f.yAxis)};
}
export function polarPoint(origin, radius, angleDegrees) {
  const a=n(angleDegrees)*Math.PI/180; return {x:n(origin?.x)+n(radius)*Math.cos(a),y:n(origin?.y)+n(radius)*Math.sin(a)};
}
export function angleBisector(a,b,c) {
  const ba=norm(sub(pt(a),pt(b))),bc=norm(sub(pt(c),pt(b))),v=norm(add(ba,bc));
  if(len(v)<EPS) throw new Error('angle_bisector_is_undefined');
  return {origin:pt(b),direction:v,angleDegrees:Math.atan2(v.y,v.x)*180/Math.PI};
}
export function perpendicularThrough(point,a,b) {
  const v=norm(sub(pt(b),pt(a))); if(len(v)<EPS) throw new Error('perpendicular_requires_nonzero_line');
  return {origin:pt(point),direction:{x:-v.y,y:v.x}};
}
export function parallelThrough(point,a,b) {
  const v=norm(sub(pt(b),pt(a))); if(len(v)<EPS) throw new Error('parallel_requires_nonzero_line');
  return {origin:pt(point),direction:v};
}
export function divideSegment(a,b,count,ratioMode='equal') {
  const c=Math.max(1,Math.floor(n(count,1)));
  if(ratioMode!=='equal') throw new Error('unsupported_division_mode');
  return Array.from({length:c+1},(_,i)=>lerp(pt(a),pt(b),i/c));
}
export function circumcenter(a,b,c) {
  const p=pt(a),q=pt(b),r=pt(c),d=2*(p.x*(q.y-r.y)+q.x*(r.y-p.y)+r.x*(p.y-q.y));
  if(Math.abs(d)<EPS) throw new Error('collinear_points_no_circumcenter');
  const aa=p.x*p.x+p.y*p.y,bb=q.x*q.x+q.y*q.y,cc=r.x*r.x+r.y*r.y;
  return {x:(aa*(q.y-r.y)+bb*(r.y-p.y)+cc*(p.y-q.y))/d,y:(aa*(r.x-q.x)+bb*(p.x-r.x)+cc*(q.x-p.x))/d};
}
export function triangleCenters(a,b,c) {
  const p=pt(a),q=pt(b),r=pt(c), area2=cross(sub(q,p),sub(r,p));
  const centroid={x:(p.x+q.x+r.x)/3,y:(p.y+q.y+r.y)/3};
  const cc=circumcenter(p,q,r);
  const orth={x:p.x+q.x+r.x-2*cc.x,y:p.y+q.y+r.y-2*cc.y};
  return {centroid,circumcenter:cc,orthocenter:orth,area:Math.abs(area2)/2};
}
export function circleLineIntersections(circle,a,b) {
  const c={x:n(circle?.cx),y:n(circle?.cy)},r=Math.abs(n(circle?.radius)),p=pt(a),d=sub(pt(b),p),f=sub(p,c);
  const A=dot(d,d),B=2*dot(f,d),C=dot(f,f)-r*r,disc=B*B-4*A*C;
  if(A<EPS)return[];
  if(disc<-EPS)return[];
  const root=Math.sqrt(Math.max(0,disc)),ts=[(-B-root)/(2*A),(-B+root)/(2*A)];
  return [...new Set(ts.filter(t=>t>=0&&t<=1).map(t=>lerp(p,pt(b),t)))];
}
export function tangentLinesToCircle(point,circle) {
  const p=pt(point),c={x:n(circle?.cx),y:n(circle?.cy)},r=Math.abs(n(circle?.radius)),v=sub(p,c),d=len(v);
  if(d<r-EPS) return [];
  if(Math.abs(d-r)<=EPS){const t={x:-(p.y-c.y),y:p.x-c.x};return [{from:p,to:add(p,t)}];}
  const base=Math.atan2(v.y,v.x),off=Math.acos(r/d);
  return [base+off,base-off].map(a=>({from:p,to:{x:c.x+r*Math.cos(a),y:c.y+r*Math.sin(a)}}));
}
export function bezierPoint(p0,p1,p2,p3,t) {
  const u=1-t; return {x:u*u*u*p0.x+3*u*u*t*p1.x+3*u*t*t*p2.x+t*t*t*p3.x,y:u*u*u*p0.y+3*u*u*t*p1.y+3*u*t*t*p2.y+t*t*t*p3.y};
}
export function bezierDerivative(p0,p1,p2,p3,t) {
  const u=1-t; return {x:3*u*u*(p1.x-p0.x)+6*u*t*(p2.x-p1.x)+3*t*t*(p3.x-p2.x),y:3*u*u*(p1.y-p0.y)+6*u*t*(p2.y-p1.y)+3*t*t*(p3.y-p2.y)};
}
export function bezierTangentAt(segment,t) { return norm(bezierDerivative(pt(segment.p0),pt(segment.p1),pt(segment.p2),pt(segment.p3),Math.max(0,Math.min(1,n(t))))); }
export function bezierCurvatureAt(segment,t) {
  const q=Math.max(0,Math.min(1,n(t))),u=1-q,p0=pt(segment.p0),p1=pt(segment.p1),p2=pt(segment.p2),p3=pt(segment.p3);
  const d=bezierDerivative(p0,p1,p2,p3,q),dd={x:6*(u*(p2.x-2*p1.x+p0.x)+q*(p3.x-2*p2.x+p1.x)),y:6*(u*(p2.y-2*p1.y+p0.y)+q*(p3.y-2*p2.y+p1.y))};
  const denom=Math.pow(Math.max(EPS,len(d)),3);
  return cross(d,dd)/denom;
}
export function splitBezier(segment,t=.5) {
  const q=Math.max(0,Math.min(1,n(t))),p0=pt(segment.p0),p1=pt(segment.p1),p2=pt(segment.p2),p3=pt(segment.p3);
  const a=lerp(p0,p1,q),b=lerp(p1,p2,q),c=lerp(p2,p3,q),d=lerp(a,b,q),e=lerp(b,c,q),f=lerp(d,e,q);
  return [{p0,p1:a,p2:d,p3:f},{p0:f,p1:e,p2:c,p3}];
}
export function matchTangentAt(a,b,tolerance=.001) {
  const va=bezierTangentAt(a,a.t??1),vb=bezierTangentAt(b,b.t??0);
  return {ok:Math.abs(cross(va,vb))<=tolerance||Math.abs(dot(va,vb)+1)<=tolerance,a:va,b:vb,angularErrorDegrees:Math.acos(Math.max(-1,Math.min(1,Math.abs(dot(va,vb)))))*180/Math.PI};
}
export function curveContinuity(a,b,tolerance=.001) {
  const pa=bezierPoint(pt(a.p0),pt(a.p1),pt(a.p2),pt(a.p3),a.t??1),pb=bezierPoint(pt(b.p0),pt(b.p1),pt(b.p2),pt(b.p3),b.t??0);
  const g0=dist(pa,pb)<=tolerance,g1=g0&&matchTangentAt(a,b,tolerance).ok;
  return {g0,g1,g2:false,positionError:dist(pa,pb),tangent:matchTangentAt(a,b,tolerance),note:g1?'G0/G1 satisfied; G2 requires curvature matching.':'Position or tangent mismatch.'};
}
export function sampleBezier(segment,samples=32) {
  const count=Math.max(2,Math.floor(n(samples,32))),p0=pt(segment.p0),p1=pt(segment.p1),p2=pt(segment.p2),p3=pt(segment.p3);
  return Array.from({length:count},(_,i)=>bezierPoint(p0,p1,p2,p3,i/(count-1)));
}
export function fitPolyline(points,{closed=false,tolerance=.5}={}) {
  const p=(points||[]).map(pt); if(p.length<2)throw new Error('fit_requires_two_points');
  const simplified=[p[0]];
  for(let i=1;i<p.length-1;i++){const a=simplified.at(-1),b=p[i],c=p[i+1],crossError=Math.abs(cross(sub(b,a),sub(c,a)))/(dist(a,c)||1);if(crossError>n(tolerance,.5))simplified.push(b);}
  simplified.push(p.at(-1));
  return {type:'path',points:simplified.map((q,i)=>({...q,kind:'line'})),closed:Boolean(closed),transform:{},tolerance:n(tolerance,.5),sourcePointCount:p.length};
}
export function reversePath(path) {
  const r=clone(path); r.points=(r.points||[]).slice().reverse().map(p=>({...p,c1:p.c2&&clone(p.c2),c2:p.c1&&clone(p.c1)})); return r;
}
export function pathLength(path) {
  const p=path?.points||[]; let total=0;
  for(let i=1;i<p.length;i++){if(p[i].kind==='cubic'&&p[i].c1&&p[i].c2){const s={p0:p[i-1],p1:p[i-1].c2||p[i-1],p2:p[i].c1,p3:p[i]};const samples=20;let prev=bezierPoint(s.p0,s.p1,s.p2,s.p3,0);for(let j=1;j<=samples;j++){const q=bezierPoint(s.p0,s.p1,s.p2,s.p3,j/samples);total+=dist(prev,q);prev=q;}}else total+=dist(p[i-1],p[i]);}
  if(path?.closed&&p.length>1)total+=dist(p.at(-1),p[0]); return total;
}
function polygon(points){return points.map(pt);}
function inside(p,a,b){return cross(sub(b,a),sub(p,a))>=-EPS;}
function segmentIntersection(a,b,c,d){const r=sub(b,a),s=sub(d,c),den=cross(r,s);if(Math.abs(den)<EPS)return null;const t=cross(sub(c,a),s)/den,u=cross(sub(c,a),r)/den;return {point:add(a,mul(r,t)),t,u};}
function clipPolygon(subject,clip) {
  let out=polygon(subject); for(let i=0;i<clip.length;i++){const a=clip[i],b=clip[(i+1)%clip.length],input=out;out=[];if(!input.length)break;let s=input.at(-1);
    for(const e of input){if(inside(e,a,b)){if(!inside(s,a,b)){const h=segmentIntersection(s,e,a,b);if(h)out.push(h.point);}out.push(e);}else if(inside(s,a,b)){const h=segmentIntersection(s,e,a,b);if(h)out.push(h.point);}s=e;}
  } return out;
}
export function polygonBoolean(subject,clip,operation='intersect') {
  const a=(subject||[]).map(pt),b=(clip||[]).map(pt); if(a.length<3||b.length<3)throw new Error('boolean_requires_two_polygons');
  if(operation==='intersect')return {operation,points:clipPolygon(a,b),exactFor:'convex_clip_polygon'};
  if(operation==='subtract')return {operation,points:clipPolygon(a,b),mode:'clip_boundary_preview',exactFor:'convex_clip_polygon_boundary'};
  if(operation==='union')return {operation,points:a.concat(b),mode:'compound_preview',exactFor:'compound_preview'};
  if(operation==='exclude')return {operation,points:a.concat(b),mode:'compound_preview',exactFor:'compound_preview'};
  throw new Error('unsupported_boolean_operation');
}
export function smartSnap(point,objects=[],options={}) {
  const p=pt(point),tol=Math.max(EPS,n(options.tolerance,8)),c=[];
  const addCandidate=(kind,q,o,extra={})=>{const d=dist(p,q);if(d<=tol)c.push({kind,point:q,distance:d,objectId:o?.id??null,...extra});};
  for(const o of objects||[]){
    const e=endpoints(o);e.forEach((q,i)=>addCandidate('endpoint',q,o,{index:i}));
    if(e.length===2)addCandidate('midpoint',lerp(e[0],e[1],.5),o);
    if(o.type==='rect'||o.type==='ellipse'){const b=bbox(o);addCandidate('center',pointFromObject(o,'center'),o);[['top',pointFromObject(o,'top')],['bottom',pointFromObject(o,'bottom')],['left',pointFromObject(o,'left')],['right',pointFromObject(o,'right')]].forEach(([anchor,q])=>addCandidate('anchor',q,o,{anchor}));}
    if(o.type==='line'){const h=projectToSegment(p,e[0],e[1]);addCandidate('perpendicular',h.point,o,{t:h.t});}
    if(o.type==='path'&&o.points?.length){for(let i=0;i<o.points.length-1;i++){const h=projectToSegment(p,o.points[i],o.points[i+1]);addCandidate('path',h.point,o,{segment:i,t:h.t});}}
  }
  if(options.grid){const g=Math.max(EPS,n(options.grid,1));const q={x:Math.round(p.x/g)*g,y:Math.round(p.y/g)*g};addCandidate('grid',q,null);}
  c.sort((a,b)=>a.distance-b.distance || String(a.kind).localeCompare(String(b.kind)));
  return {point:p,best:c[0]||null,candidates:c,reason:c[0]?.kind??'none'};
}
export function snapToAxis(point,origin={x:0,y:0},angleDegrees=0) {
  const f=coordinateFrame(origin,angleDegrees),p=pt(point),v=sub(p,f.origin),x=dot(v,f.xAxis),y=dot(v,f.yAxis);
  const xSnap=add(f.origin,mul(f.xAxis,x)),ySnap=add(f.origin,mul(f.yAxis,y));
  return dist(p,xSnap)<=dist(p,ySnap)?{point:xSnap,axis:'x',distance:dist(p,xSnap)}:{point:ySnap,axis:'y',distance:dist(p,ySnap)};
}
export function measureBetween(a,b) { return {from:pt(a),to:pt(b),distance:dist(a,b),dx:n(b?.x)-n(a?.x),dy:n(b?.y)-n(a?.y),angleDegrees:Math.atan2(n(b?.y)-n(a?.y),n(b?.x)-n(a?.x))*180/Math.PI}; }
export function objectMetrics(object) {
  const b=bbox(object),p=object?.type==='path'?pathLength(object):object?.type==='line'?dist({x:object.x1,y:object.y1},{x:object.x2,y:object.y2}):null;
  return {bounds:b,center:{x:b.x+b.width/2,y:b.y+b.height/2},area:object?.type==='ellipse'?Math.PI*b.width*b.height/4:object?.type==='rect'?b.width*b.height:null,perimeter:object?.type==='rect'?2*(b.width+b.height):p,length:p};
}
export function diagnoseGeometry(object,{tolerance=.001}={}) {
  const issues=[],b=bbox(object),e=endpoints(object);
  if(!object?.type)issues.push({code:'missing_type',severity:'error'});
  if(object?.type==='line'&&dist(e[0],e[1])<=tolerance)issues.push({code:'zero_length',severity:'error'});
  if(object?.type==='path'&&(!object.points||object.points.length<2))issues.push({code:'empty_path',severity:'error'});
  if(object?.type==='path'&&object.points.some(p=>[p.x,p.y,p.c1?.x,p.c1?.y,p.c2?.x,p.c2?.y].some(v=>v!==undefined&&!Number.isFinite(v))))issues.push({code:'non_finite_point',severity:'error'});
  if(b.width<=tolerance&&b.height<=tolerance)issues.push({code:'zero_area_or_extent',severity:'warning'});
  return {ok:!issues.some(i=>i.severity==='error'),issues,metrics:objectMetrics(object),suggestions:issues.map(i=>({code:i.code,action:i.code==='zero_length'?'geometry.diagnose':'geometry.measure'}))};
}
export function geometryDiff(before,after,tolerance=.001) {
  const a=bbox(before),b=bbox(after); return {changed:Math.abs(a.x-b.x)>tolerance||Math.abs(a.y-b.y)>tolerance||Math.abs(a.width-b.width)>tolerance||Math.abs(a.height-b.height)>tolerance,before:{bounds:a},after:{bounds:b},delta:{x:b.x-a.x,y:b.y-a.y,width:b.width-a.width,height:b.height-a.height}};
}
export function constructFromIntent(intent={}) {
  const kind=String(intent.kind||intent.type||'').toLowerCase(),p=intent.position||intent.center||{x:0,y:0};
  if(kind==='circle')return {tool:'geometry.ellipse',args:{cx:n(p.x),cy:n(p.y),rx:Math.abs(n(intent.radius)),ry:Math.abs(n(intent.radius))}};
  if(kind==='rectangle'||kind==='rect')return {tool:intent.radius?'geometry.roundedRect':'geometry.rect',args:{x:n(intent.x??p.x),y:n(intent.y??p.y),width:Math.abs(n(intent.width)),height:Math.abs(n(intent.height)),radius:Math.abs(n(intent.radius))}};
  if(kind==='line')return {tool:'geometry.line',args:{a:pt(intent.a||p),b:pt(intent.b||{x:n(p.x)+n(intent.length),y:p.y})}};
  if(kind==='polygon')return {tool:'geometry.polygon',args:{cx:n(p.x),cy:n(p.y),radius:Math.abs(n(intent.radius)),sides:Math.max(3,Math.floor(n(intent.sides,3))),rotation:n(intent.rotation,-90)}};
  if(kind==='arc')return {tool:'geometry.arc',args:{cx:n(p.x),cy:n(p.y),radius:Math.abs(n(intent.radius)),startDegrees:n(intent.startDegrees),endDegrees:n(intent.endDegrees)}};
  throw new Error('unsupported_intent_kind:'+kind);
}
export function intentPlan(intent,context={}) {
  const steps=[]; const primary=constructFromIntent(intent); steps.push({id:'step-1',tool:primary.tool,args:primary.args});
  if(intent.snap||intent.reference){steps.unshift({id:'reference',tool:'geometry.smartSnap',args:{point:intent.position||intent.center,objects:context.objects||[],options:{tolerance:intent.tolerance??8,grid:intent.grid}}});}
  if(intent.constraints?.length)steps.push({id:'constraints',tool:'geometry.solveConstraints',args:{objects:'previous',constraints:intent.constraints,tolerance:intent.tolerance??.001}});
  return {version:1,intent:clone(intent),steps,requires:{visualCheckpoint:intent.visualCheckpoint!==false,geometryAudit:true}};
}
export function buildAdvancedPrecisionToolCatalog() {
  return [
    ['geometry.coordinateFrame','Create a local coordinate frame with exact axes.'],
    ['geometry.toLocal','Convert world coordinates into a local frame.'],
    ['geometry.toWorld','Convert local coordinates into world coordinates.'],
    ['geometry.polarPoint','Construct a point from origin, distance and angle.'],
    ['geometry.angleBisector','Construct an angle-bisector direction.'],
    ['geometry.perpendicularThrough','Construct a perpendicular through a point.'],
    ['geometry.parallelThrough','Construct a parallel through a point.'],
    ['geometry.divideSegment','Divide a segment into equal parametric parts.'],
    ['geometry.circumcenter','Compute an exact circumcenter.'],
    ['geometry.triangleCenters','Compute centroid, circumcenter and orthocenter.'],
    ['geometry.circleLineIntersections','Intersect a line segment with a circle.'],
    ['geometry.tangentLinesToCircle','Construct tangent candidates from a point to a circle.'],
    ['geometry.bezierPoint','Evaluate a cubic Bézier at t.'],
    ['geometry.bezierTangent','Evaluate a cubic Bézier tangent.'],
    ['geometry.bezierCurvature','Evaluate cubic curvature.'],
    ['geometry.bezierSplit','Split a cubic Bézier at t.'],
    ['geometry.bezierContinuity','Audit G0/G1 continuity between cubic segments.'],
    ['geometry.bezierSample','Sample a cubic deterministically.'],
    ['geometry.fitPolyline','Simplify a polyline into deterministic path geometry.'],
    ['geometry.reversePath','Reverse a path while swapping handles.'],
    ['geometry.pathLength','Measure path length with deterministic cubic sampling.'],
    ['geometry.boolean','Preview convex polygon boolean operations.'],
    ['geometry.smartSnap','Rank semantic snap candidates.'],
    ['geometry.snapAxis','Snap a point to a local X/Y axis.'],
    ['geometry.measureBetween','Measure between two points.'],
    ['geometry.objectMetrics','Inspect bounds, center, area and length.'],
    ['geometry.diagnose','Diagnose invalid or degenerate geometry.'],
    ['geometry.diff','Compare before/after geometry.'],
    ['geometry.intentPlan','Compile semantic drawing intent into deterministic tool steps.']
  ].map(([name,description])=>({name,description,precision:'subpixel',deterministic:true}));
}
