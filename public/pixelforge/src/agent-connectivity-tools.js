/**
 * PixelForge Agent Geometry Connectivity + Constraint Toolkit
 * Deterministic, agent-native geometry operations. No model inference, network, or timers.
 */
const EPS=1e-8;
const clone=v=>JSON.parse(JSON.stringify(v));
const num=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
const pt=p=>({x:num(p?.x),y:num(p?.y)});
const dist=(a,b)=>Math.hypot(num(b?.x)-num(a?.x),num(b?.y)-num(a?.y));
const lerp=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
const add=(a,b)=>({x:a.x+b.x,y:a.y+b.y});
const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y});
const mul=(a,s)=>({x:a.x*s,y:a.y*s});
const cross=(a,b)=>a.x*b.y-a.y*b.x;
const dot=(a,b)=>a.x*b.x+a.y*b.y;
const normalize=v=>{const l=Math.hypot(v.x,v.y);return l<EPS?{x:0,y:0}:{x:v.x/l,y:v.y/l};};
const line=(a,b)=>({type:'line',x1:a.x,y1:a.y,x2:b.x,y2:b.y,transform:{}});

export function objectEndpoints(o){
  if(o?.type==='line') return [{x:num(o.x1),y:num(o.y1)},{x:num(o.x2),y:num(o.y2)}];
  if(o?.type==='path'&&Array.isArray(o.points)&&o.points.length) return [pt(o.points[0]),pt(o.points.at(-1))];
  return [];
}
export function endpointsNear(a,b,tolerance=0.01){
  const ea=objectEndpoints(a),eb=objectEndpoints(b);
  const hits=[];
  ea.forEach((p,i)=>eb.forEach((q,j)=>{if(dist(p,q)<=Math.max(EPS,num(tolerance)))hits.push({aEnd:i,bEnd:j,distance:dist(p,q)});}));
  return hits;
}
export function snapSmart(point, objects=[], tolerance=8){
  const p=pt(point), candidates=[];
  const push=(kind,q,objectId,extra={})=>{const d=dist(p,q);if(d<=tolerance)candidates.push({kind,point:q,distance:d,objectId,...extra});};
  for(const o of objects||[]){
    const es=objectEndpoints(o); es.forEach((q,index)=>push('endpoint',q,o.id,{index}));
    if(o.type==='line'){
      const a=es[0],b=es[1]; push('midpoint',lerp(a,b,.5),o.id);
      const proj=projectToSegment(p,a,b); push('perpendicular',proj.point,o.id,{t:proj.t});
    } else if(o.type==='ellipse'){
      const cx=num(o.x)+num(o.width)/2,cy=num(o.y)+num(o.height)/2;
      push('center',{x:cx,y:cy},o.id);
      push('anchor',{x:num(o.x),y:cy},o.id,{anchor:'left'});
      push('anchor',{x:num(o.x)+num(o.width),y:cy},o.id,{anchor:'right'});
      push('anchor',{x:cx,y:num(o.y)},o.id,{anchor:'top'});
      push('anchor',{x:cx,y:num(o.y)+num(o.height)},o.id,{anchor:'bottom'});
    } else if(o.type==='rect'){
      const x=num(o.x),y=num(o.y),w=num(o.width),h=num(o.height);
      [[x,y,'top-left'],[x+w,y,'top-right'],[x,y+h,'bottom-left'],[x+w,y+h,'bottom-right'],[x+w/2,y,'top'],[x+w/2,y+h,'bottom'],[x,y+h/2,'left'],[x+w,y+h/2,'right'],[x+w/2,y+h/2,'center']].forEach(([x1,y1,anchor])=>push('anchor',{x:x1,y:y1},o.id,{anchor}));
    }
  }
  candidates.sort((a,b)=>a.distance-b.distance);
  return {point:p,best:candidates[0]||null,candidates};
}
export function anchorPoint(object,anchor='center'){
  const o=object||{}, x=num(o.x),y=num(o.y),w=num(o.width),h=num(o.height);
  const map={topLeft:{x,y},top:{x:x+w/2,y},topRight:{x:x+w,y},left:{x,y:y+h/2},center:{x:x+w/2,y:y+h/2},right:{x:x+w,y:y+h/2},bottomLeft:{x,y:y+h},bottom:{x:x+w/2,y:y+h},bottomRight:{x:x+w,y:y+h}};
  if(map[anchor])return map[anchor];
  if(o.type==='line'){const [a,b]=objectEndpoints(o);if(anchor==='start')return a;if(anchor==='end')return b;return lerp(a,b,.5);}
  if(o.type==='ellipse'){if(anchor==='center')return {x:x+w/2,y:y+h/2};}
  if(o.type==='path'&&o.points?.length){const p=o.points, i=anchor==='start'?0:anchor==='end'?p.length-1:Math.floor((p.length-1)/2);return pt(p[i]);}
  return {x:x+w/2,y:y+h/2};
}
export function alignToAnchor(object,fromAnchor,target){
  const o=clone(object), a=anchorPoint(o,fromAnchor), t=pt(target);
  return translateGeometry(o,t.x-a.x,t.y-a.y);
}
export function translateGeometry(o,dx,dy){
  const r=clone(o), move=p=>p&&{...p,x:num(p.x)+dx,y:num(p.y)+dy};
  if(r.type==='line'){r.x1+=dx;r.x2+=dx;r.y1+=dy;r.y2+=dy;}
  else if(r.type==='path')r.points=(r.points||[]).map(p=>({...move(p),c1:move(p.c1),c2:move(p.c2)}));
  else if(r.type==='group')r.children=(r.children||[]).map(c=>translateGeometry(c,dx,dy));
  else{r.x=num(r.x)+dx;r.y=num(r.y)+dy;}
  return r;
}
export function projectToSegment(point,a,b){
  const p=pt(point),s=pt(a),e=pt(b),v=sub(e,s),l2=dot(v,v);
  if(l2<EPS)return{point:s,t:0,distance:dist(p,s)};
  const t=Math.max(0,Math.min(1,dot(sub(p,s),v)/l2)),q=add(s,mul(v,t));
  return{point:q,t,distance:dist(p,q)};
}
function replaceEndpoint(o,index,target){
  const r=clone(o);
  if(r.type==='line'){if(index===0){r.x1=target.x;r.y1=target.y;}else{r.x2=target.x;r.y2=target.y;}}
  else if(r.type==='path'){
    const p=r.points?.[index===0?0:r.points.length-1];
    if(p){
      const dx=target.x-num(p.x),dy=target.y-num(p.y);
      p.x=target.x;p.y=target.y;
      if(p.c1){p.c1.x+=dx;p.c1.y+=dy;}
      if(p.c2){p.c2.x+=dx;p.c2.y+=dy;}
    }
  }
  return r;
}
export function connectObjects(a,b,{tolerance=.01,weld=false}={}){
  const hits=endpointsNear(a,b,tolerance);
  if(!hits.length)return{connected:false,reason:'no_endpoints_within_tolerance',objects:[clone(a),clone(b)]};
  const h=hits[0],ea=objectEndpoints(a)[h.aEnd],eb=objectEndpoints(b)[h.bEnd],target=lerp(ea,eb,.5);
  const A=replaceEndpoint(a,h.aEnd,target),B=replaceEndpoint(b,h.bEnd,target);
  return{connected:true,weld:Boolean(weld),connection:{aEnd:h.aEnd,bEnd:h.bEnd,point:target,distance:h.distance},objects:[A,B]};
}
export function joinPaths(objects,{tolerance=.01,close=false}={}){
  let list=(objects||[]).map(clone).filter(o=>objectEndpoints(o).length);
  const joins=[];
  if(list.length<1)return{object:null,joins};
  while(list.length>1){
    let found=null;
    outer:for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length;j++){const h=endpointsNear(list[i],list[j],tolerance);if(h.length){found={i,j,h:h[0]};break outer;}}
    if(!found)break;
    const {i,j,h}=found,A=list[i],B=list[j],ea=objectEndpoints(A),eb=objectEndpoints(B);
    const aPts=A.type==='path'?(A.points||[]).map(clone):ea.map((p,k)=>({...p,kind:k?'line':'line'}));
    const bPts=B.type==='path'?(B.points||[]).map(clone):eb.map((p,k)=>({...p,kind:k?'line':'line'}));
    const ar=h.aEnd===0?aPts.slice().reverse():aPts.slice();
    const br=h.bEnd===1?bPts.slice().reverse():bPts.slice();
    const merged={type:'path',points:ar.concat(br),closed:Boolean(close),transform:{},fill:A.fill??'none',stroke:A.stroke??B.stroke??'#E8EAF2',strokeWidth:A.strokeWidth??B.strokeWidth??1};
    list.splice(j,1);list.splice(i,1,merged);joins.push({a:i,b:j,connection:h});
  }
  return{object:list.length===1?list[0]:null,remaining:list.length>1?list:[],joins};
}
export function closeGap(object,endpointIndex=1,target=null){
  const o=clone(object), e=objectEndpoints(o);if(e.length!==2)throw new Error('close_gap_requires_open_geometry');
  const t=target?pt(target):e[endpointIndex===0?1:0];
  return replaceEndpoint(o,endpointIndex,t);
}
export function extendToIntersection(object,other){
  const a=objectEndpoints(object),b=objectEndpoints(other);if(a.length!==2||b.length!==2)throw new Error('extend_requires_line_like_objects');
  const v=sub(a[1],a[0]),w=sub(b[1],b[0]),den=cross(v,w);if(Math.abs(den)<EPS)throw new Error('parallel_lines_no_intersection');
  const t=cross(sub(b[0],a[0]),w)/den,q=add(a[0],mul(v,t)),r=clone(object);
  if(t<0){if(r.type==='line'){r.x1=q.x;r.y1=q.y;}else r.points[0]={...r.points[0],x:q.x,y:q.y};}
  else {if(r.type==='line'){r.x2=q.x;r.y2=q.y;}else{const p=r.points.at(-1);p.x=q.x;p.y=q.y;}}
  return{object:r,intersection:q,extensionParameter:t};
}
export function trimToIntersection(object,other,keep='start'){
  const ex=extendToIntersection(object,other),r=clone(ex.object);
  const a=objectEndpoints(r); if(r.type==='line'){if(keep==='start'){r.x2=a[1].x;r.y2=a[1].y;}else{r.x1=a[0].x;r.y1=a[0].y;}}
  else if(r.type==='path'){if(keep==='start')r.points=[...r.points.slice(0,-1),{...r.points.at(-1),x:ex.intersection.x,y:ex.intersection.y}];else r.points=[{...r.points[0],x:ex.intersection.x,y:ex.intersection.y},...r.points.slice(1)];}
  return{object:r,intersection:ex.intersection};
}
export function filletLines(a,b,radius){
  const ea=objectEndpoints(a),eb=objectEndpoints(b);if(ea.length!==2||eb.length!==2)throw new Error('fillet_requires_two_line_like_objects');
  const shared=ea.map((p,i)=>eb.map((q,j)=>({p,q,i,j,d:dist(p,q)}))).flat().sort((x,y)=>x.d-y.d)[0];
  if(shared.d>1e-6)throw new Error('fillet_requires_shared_vertex');
  const vertex=shared.p, pa=ea[1-shared.i], pb=eb[1-shared.j], va=normalize(sub(pa,vertex)), vb=normalize(sub(pb,vertex)), r=Math.abs(num(radius));
  const angle=Math.acos(Math.max(-1,Math.min(1,dot(va,vb)))), tangent=r/Math.tan(angle/2);
  const p1=add(vertex,mul(va,tangent)),p2=add(vertex,mul(vb,tangent)),bis=normalize(add(va,vb)),center=add(vertex,mul(bis,r/Math.sin(angle/2)));
  const startAngle=Math.atan2(p1.y-center.y,p1.x-center.x)*180/Math.PI,endAngle=Math.atan2(p2.y-center.y,p2.x-center.x)*180/Math.PI;
  return{trimmedA:replaceEndpoint(a,1-shared.i,p1),trimmedB:replaceEndpoint(b,1-shared.j,p2),arc:{type:'arc',cx:center.x,cy:center.y,radius:r,startDegrees:startAngle,endDegrees:endAngle},tangentPoints:[p1,p2],center};
}
export function chamferLines(a,b,distanceValue){
  const ea=objectEndpoints(a),eb=objectEndpoints(b);if(ea.length!==2||eb.length!==2)throw new Error('chamfer_requires_two_line_like_objects');
  const shared=ea.map((p,i)=>eb.map((q,j)=>({p,q,i,j,d:dist(p,q)}))).flat().sort((x,y)=>x.d-y.d)[0];
  if(shared.d>1e-6)throw new Error('chamfer_requires_shared_vertex');
  const vertex=shared.p,pa=ea[1-shared.i],pb=eb[1-shared.j],d=Math.abs(num(distanceValue));
  const p1=add(vertex,mul(normalize(sub(pa,vertex)),d)),p2=add(vertex,mul(normalize(sub(pb,vertex)),d));
  return{trimmedA:replaceEndpoint(a,1-shared.i,p1),trimmedB:replaceEndpoint(b,1-shared.j,p2),segment:line(p1,p2),points:[p1,p2]};
}
export function offsetLine(object,distanceValue){
  const e=objectEndpoints(object);if(e.length!==2)throw new Error('offset_requires_line_like_object');
  const a=e[0],b=e[1],v=normalize(sub(b,a)),n={x:-v.y,y:v.x},d=num(distanceValue);
  return line(add(a,mul(n,d)),add(b,mul(n,d)));
}
export function dimension(a,b,label=null){
  const p=pt(a),q=pt(b),dx=q.x-p.x,dy=q.y-p.y;
  return{type:'dimension',from:p,to:q,length:Math.hypot(dx,dy),dx,dy,angleDegrees:Math.atan2(dy,dx)*180/Math.PI,label:label??Math.hypot(dx,dy).toFixed(3)};
}
export function constructionGraph(objects=[],relations=[]){
  return{version:1,nodes:(objects||[]).map(o=>({id:o.id,type:o.type})),edges:(relations||[]).map((r,i)=>({id:r.id||'rel-'+i,...clone(r)}))};
}
function movePointConstraint(o,id,delta){
  const r=clone(o);if(r.type==='line'){if(id===0){r.x1+=delta.x;r.y1+=delta.y;}else{r.x2+=delta.x;r.y2+=delta.y;}}
  else if(r.type==='path'){const p=r.points?.[id];if(p){p.x+=delta.x;p.y+=delta.y;}}
  return r;
}
export function solveConstraints(objects,constraints=[],{tolerance=.001,maxIterations=24}={}){
  let current=(objects||[]).map(clone),diagnostics=[];
  const iterations=Math.max(1,Math.floor(maxIterations));
  const get=(id,index=0)=>{const o=current.find(x=>x.id===id);if(!o)return null;const e=objectEndpoints(o);return e[index]||anchorPoint(o,'center');};
  const movePair=(constraint,delta)=>{
    if(constraint.move==='a') current=current.map(o=>o.id===constraint.a?movePointConstraint(o,constraint.aIndex??0,mul(delta,-1)):o);
    else if(constraint.move==='b') current=current.map(o=>o.id===constraint.b?movePointConstraint(o,constraint.bIndex??0,delta):o);
    else {
      current=current.map(o=>o.id===constraint.a?movePointConstraint(o,constraint.aIndex??0,mul(delta,-.5)):o);
      current=current.map(o=>o.id===constraint.b?movePointConstraint(o,constraint.bIndex??0,mul(delta,.5)):o);
    }
  };
  for(let iter=0;iter<iterations;iter++){
    let changed=0;
    for(const c of constraints||[]){
      const a=get(c.a,c.aIndex??0),b=get(c.b,c.bIndex??0);
      if(!a||!b){diagnostics.push({constraint:c,status:'missing_reference'});continue;}
      let correction=null;
      if(c.type==='coincident') correction=sub(a,b);
      else if(c.type==='horizontal') correction={x:0,y:a.y-b.y};
      else if(c.type==='vertical') correction={x:a.x-b.x,y:0};
      else if(c.type==='distance'){
        const target=Math.abs(num(c.value)),v=sub(b,a),l=Math.hypot(v.x,v.y);
        if(l<EPS){diagnostics.push({constraint:c,status:'degenerate_distance'});continue;}
        correction=mul(v,(target-l)/l);
      } else if(c.type==='angle'){
        const target=num(c.degrees)*Math.PI/180,v=sub(b,a),l=Math.hypot(v.x,v.y);
        if(l<EPS){diagnostics.push({constraint:c,status:'degenerate_angle'});continue;}
        const ca=Math.cos(target),sa=Math.sin(target),rot={x:v.x*ca-v.y*sa,y:v.x*sa+v.y*ca};
        correction=sub(add(a,rot),b);
      } else {
        continue;
      }
      movePair(c,correction); changed+=Math.hypot(correction.x,correction.y);
    }
    if(changed<=tolerance)break;
  }
  for(const c of constraints||[]){
    const a=get(c.a,c.aIndex??0),b=get(c.b,c.bIndex??0);let error=null,status='unsupported';
    if(a&&b){
      if(c.type==='coincident'||c.type==='horizontal'||c.type==='vertical')error=c.type==='coincident'?dist(a,b):c.type==='horizontal'?Math.abs(a.y-b.y):Math.abs(a.x-b.x);
      else if(c.type==='distance')error=Math.abs(dist(a,b)-Math.abs(num(c.value)));
      else if(c.type==='angle'){const actual=Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI;let delta=((actual-num(c.degrees)+180)%360+360)%360-180;error=Math.abs(delta);}
      if(error!==null)status=error<=tolerance?'satisfied':'unsatisfied';
    }
    diagnostics.push({constraint:c,status,error,tolerance});
  }
  return{objects:current,diagnostics,iterations};
}
export function constraintAudit(objects,constraints=[],tolerance=.001){
  const solved=solveConstraints(objects,constraints,{tolerance,maxIterations:1});
  const counts={satisfied:0,unsatisfied:0,missing_reference:0,unsupported:0};
  solved.diagnostics.forEach(d=>counts[d.status]=(counts[d.status]||0)+1);
  return{ok:counts.unsatisfied===0&&counts.missing_reference===0,counts,diagnostics:solved.diagnostics};
}
export function continuity(pathA,pathB,tolerance=.001){
  const a=objectEndpoints(pathA),b=objectEndpoints(pathB);if(a.length<2||b.length<2)return{g0:false,g1:false,g2:false};
  const g0=dist(a[1],b[0])<=tolerance,g1=g0&&pathA.type==='path'&&pathB.type==='path'&&pathA.points.at(-1)?.c2&&pathB.points[0]?.c1;
  return{g0,g1:Boolean(g1),g2:false,notes:g1?'Tangent-handle continuity detected; curvature continuity requires explicit curve analysis.':'Position continuity only.'};
}
export function buildConnectivityToolCatalog(){
 return[
 {name:'geometry.connect',description:'Connect nearest compatible endpoints with tolerance.'},
 {name:'geometry.weld',description:'Connect and weld two endpoints into one coordinate.'},
 {name:'geometry.join',description:'Join compatible open paths into one editable path.'},
 {name:'geometry.merge',description:'Merge compatible objects into one path or group.'},
 {name:'geometry.closeGap',description:'Close an open endpoint gap exactly.'},
 {name:'geometry.extendToIntersection',description:'Extend line-like geometry to another geometry intersection.'},
 {name:'geometry.trimToIntersection',description:'Trim line-like geometry at an intersection.'},
 {name:'geometry.fillet',description:'Create tangent fillet construction between two lines.'},
 {name:'geometry.chamfer',description:'Create exact chamfer construction between two lines.'},
 {name:'geometry.offset',description:'Create a parallel offset of line-like geometry.'},
 {name:'geometry.snapSmart',description:'Return semantic snap candidates: endpoint, center, midpoint, projection and anchors.'},
 {name:'geometry.anchor',description:'Resolve semantic anchor points on geometry.'},
 {name:'geometry.alignToAnchor',description:'Move an object so a semantic anchor lands on a target.'},
 {name:'geometry.dimension',description:'Create a deterministic measurement/dimension object.'},
 {name:'geometry.constructionGraph',description:'Build serializable object/relationship graph.'},
 {name:'geometry.solveConstraints',description:'Solve deterministic geometric constraints with bounded iterations, not wall-clock timeout.'},
 {name:'geometry.constraintAudit',description:'Audit constraints and report unsatisfied/missing/unsupported relationships.'},
 {name:'geometry.continuity',description:'Audit G0/G1-like path continuity between two paths.'}
 ];
}
