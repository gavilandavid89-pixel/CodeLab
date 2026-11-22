import test from 'node:test';
import assert from 'node:assert/strict';
import {
  connectObjects, joinPaths, closeGap, extendToIntersection, trimToIntersection,
  filletLines, chamferLines, offsetLine, snapSmart, anchorPoint, alignToAnchor,
  constructionGraph, solveConstraints, constraintAudit, continuity
} from '../public/pixelforge/src/agent-connectivity-tools.js';

const line=(id,x1,y1,x2,y2)=>({id,type:'line',x1,y1,x2,y2,transform:{}});

test('connect/weld joins compatible endpoints deterministically',()=>{
  const a=line('a',0,0,10,0), b=line('b',10,0,20,0);
  const r=connectObjects(a,b,{tolerance:0.001,weld:true});
  assert.equal(r.connected,true); assert.deepEqual(r.connection.point,{x:10,y:0});
});

test('join paths produces one path',()=>{
  const r=joinPaths([line('a',0,0,10,0),line('b',10,0,20,0)],{tolerance:.001});
  assert.ok(r.object); assert.equal(r.object.type,'path'); assert.equal(r.object.points.length,4);
});

test('gap, extend, trim and offset are deterministic',()=>{
  const a=line('a',0,0,10,0), b=line('b',15,-5,15,5);
  assert.deepEqual(closeGap(a,1,{x:12,y:0}).x2,12);
  const bez={type:'path',points:[{x:0,y:0,c2:{x:4,y:0}},{x:10,y:0,c1:{x:6,y:0}}]};
  const moved=closeGap(bez,0,{x:2,y:0});
  assert.deepEqual(moved.points[0].c2,{x:6,y:0});
  assert.deepEqual(extendToIntersection(a,b).intersection,{x:15,y:0});
  assert.deepEqual(trimToIntersection(a,b,'start').intersection,{x:15,y:0});
  assert.deepEqual(offsetLine(a,2),{type:'line',x1:0,y1:2,x2:10,y2:2,transform:{}});
});

test('fillet and chamfer create construction geometry',()=>{
  const a=line('a',0,0,10,0), b=line('b',10,0,10,10);
  const f=filletLines(a,b,2); assert.ok(f.arc); assert.equal(f.tangentPoints.length,2);
  const c=chamferLines(a,b,2); assert.equal(c.segment.type,'line');
});

test('smart snap and anchors expose semantic construction points',()=>{
  const r=line('a',0,0,10,0);
  const snap=snapSmart({x:4.9,y:.1},[r],.5);
  assert.equal(snap.best.kind,'midpoint');
  assert.equal(snapSmart({x:10.1,y:.1},[r],.5).best.kind,'endpoint'); assert.deepEqual(anchorPoint({x:0,y:0,width:10,height:20},'center'),{x:5,y:10});
  assert.deepEqual(alignToAnchor({type:'rect',x:0,y:0,width:10,height:10},'center',{x:20,y:20}).x,15);
});

test('construction graph and constraint audit are serializable',()=>{
  const a=line('a',0,0,10,0), b=line('b',10,2,20,2);
  const graph=constructionGraph([a,b],[{type:'horizontal',a:'a',b:'b'}]);
  assert.equal(graph.nodes.length,2); assert.equal(graph.edges.length,1);
  const solved=solveConstraints([a,b],[{type:'horizontal',a:'a',b:'b'}],{maxIterations:8});
  assert.equal(solved.diagnostics.at(-1).status,'satisfied');
  assert.equal(Math.abs(solved.objects[1].y1-solved.objects[0].y1)<1e-3,true);
  const audit=constraintAudit(solved.objects,[{type:'horizontal',a:'a',b:'b'}],.001);
  assert.equal(typeof audit.ok,'boolean');
});

test('continuity reports G0 and G1 only for aligned tangent handles',()=>{
  const a={type:'path',points:[{x:0,y:0},{x:10,y:0,c2:{x:8,y:0}}]};
  const b={type:'path',points:[{x:10,y:0,c1:{x:12,y:0}},{x:20,y:0}]};
  assert.equal(continuity(a,b,.001).g1,true);
  const bad={type:'path',points:[{x:10,y:0,c1:{x:10,y:2}},{x:20,y:0}]};
  assert.equal(continuity(a,bad,.001).g1,false);
});

test('continuity reports G0 for matching endpoints',()=>{
  const a={type:'path',points:[{x:0,y:0},{x:10,y:0}]};
  const b={type:'path',points:[{x:10,y:0},{x:20,y:0}]};
  assert.equal(continuity(a,b,.001).g0,true);
});

test('constraint audit is observational and never solves or mutates geometry',()=>{
  const a=line('a',0,0,10,0), b=line('b',10,4,20,4);
  const before=JSON.stringify([a,b]);
  const audit=constraintAudit([a,b],[{type:'horizontal',a:'a',b:'b'}],.001);
  assert.equal(audit.ok,false);
  assert.equal(audit.counts.unsatisfied,1);
  assert.equal(JSON.stringify([a,b]),before);
  const unsupported=constraintAudit([a,b],[{type:'parallel',a:'a',b:'b'}]);
  assert.equal(unsupported.ok,false);
  assert.equal(unsupported.counts.unsupported,1);
});

test('constraint audit distinguishes missing references without attempting a solve',()=>{
  const a=line('a',0,0,10,0);
  const audit=constraintAudit([a],[{type:'coincident',a:'a',b:'missing'}]);
  assert.equal(audit.ok,false);
  assert.equal(audit.counts.missing_reference,1);
  assert.equal(audit.diagnostics[0].status,'missing_reference');
});

test('fillet rejects radii that exceed either available segment',()=>{
  const a=line('a',0,0,10,0), b=line('b',10,0,10,1);
  assert.throws(()=>filletLines(a,b,2),/fillet_radius_exceeds_available_segments/);
});

test('intersection and offset reject degenerate or non-finite geometry',()=>{
  assert.throws(()=>extendToIntersection(line('a',0,0,0,0),line('b',1,-1,1,1)),/intersection_requires_non_degenerate_lines/);
  assert.throws(()=>offsetLine(line('zero',1,1,1,1),2),/offset_requires_non_degenerate_line/);
  assert.throws(()=>offsetLine(line('a',0,0,10,0),Number.NaN),/offset_distance_must_be_finite/);
});
