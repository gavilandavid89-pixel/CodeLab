import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coordinateFrame, localToWorld, worldToLocal, polarPoint, angleBisector,
  perpendicularThrough, parallelThrough, divideSegment, circumcenter,
  triangleCenters, circleLineIntersections, tangentLinesToCircle,
  bezierPoint, bezierTangentAt, bezierCurvatureAt, splitBezier,
  curveContinuity, sampleBezier, fitPolyline, reversePath, pathLength,
  polygonBoolean, smartSnap, snapToAxis, measureBetween, objectMetrics,
  diagnoseGeometry, geometryDiff, intentPlan, buildAdvancedPrecisionToolCatalog
} from '../public/pixelforge/src/advanced-precision-tools.js';

test('local coordinate frames are reversible and deterministic', () => {
  const frame = coordinateFrame({x:10,y:20},90);
  const world = localToWorld({x:5,y:0},frame);
  assert.ok(Math.abs(world.x-10)<1e-9);
  assert.ok(Math.abs(world.y-25)<1e-9);
  const local = worldToLocal(world,frame);
  assert.ok(Math.abs(local.x-5)<1e-9);
  assert.ok(Math.abs(local.y)<1e-9);
  const polar=polarPoint({x:0,y:0},10,90); assert.ok(Math.abs(polar.x)<1e-12); assert.ok(Math.abs(polar.y-10)<1e-12);
});

test('construction helpers cover exact CAD-style relationships', () => {
  const bis = angleBisector({x:10,y:0},{x:0,y:0},{x:0,y:10});
  assert.ok(Math.abs(bis.angleDegrees-45)<1e-9);
  const perp = perpendicularThrough({x:5,y:5},{x:0,y:0},{x:10,y:0});
  assert.deepEqual(perp.direction,{x:0,y:1});
  const par = parallelThrough({x:5,y:5},{x:0,y:0},{x:10,y:0});
  assert.deepEqual(par.direction,{x:1,y:0});
  assert.equal(divideSegment({x:0,y:0},{x:10,y:0},4).length,5);
  assert.deepEqual(circumcenter({x:0,y:1},{x:1,y:0},{x:0,y:-1}),{x:0,y:0});
  const centers=triangleCenters({x:0,y:0},{x:4,y:0},{x:0,y:3});
  assert.deepEqual(centers.centroid,{x:4/3,y:1});
  assert.ok(Math.abs(centers.area-6)<1e-9);
});

test('circle intersections and tangent construction are deterministic', () => {
  const hits=circleLineIntersections({cx:0,cy:0,radius:5},{x:-10,y:0},{x:10,y:0});
  assert.equal(hits.length,2);
  assert.deepEqual(hits[0],{x:-5,y:0});
  const tangents=tangentLinesToCircle({x:10,y:0},{cx:0,cy:0,radius:5});
  assert.equal(tangents.length,2);
});

test('bezier inspection, splitting and continuity work without rendering', () => {
  const s={p0:{x:0,y:0},p1:{x:10,y:0},p2:{x:10,y:10},p3:{x:20,y:10}};
  assert.deepEqual(bezierPoint(s.p0,s.p1,s.p2,s.p3,0),s.p0);
  assert.deepEqual(bezierPoint(s.p0,s.p1,s.p2,s.p3,1),s.p3);
  const tangent=bezierTangentAt(s,0);
  assert.ok(tangent.x>0);
  assert.ok(Number.isFinite(bezierCurvatureAt(s,.5)));
  const split=splitBezier(s,.5);
  assert.deepEqual(split[0].p3,split[1].p0);
  const continuity=curveContinuity({...s,t:1},{...s,t:0},.001);
  assert.equal(continuity.g0,false);
  assert.equal(sampleBezier(s,9).length,9);
});

test('path utilities and semantic snap provide agent feedback', () => {
  const path={type:'path',points:[{x:0,y:0,kind:'line'},{x:10,y:0,kind:'line'},{x:10,y:10,kind:'line'}],closed:false};
  assert.ok(Math.abs(pathLength(path)-20)<1e-9);
  const reversed=reversePath(path);
  assert.deepEqual(reversed.points[0],{x:10,y:10,kind:'line'});
  const simplified=fitPolyline([{x:0,y:0},{x:1,y:.01},{x:2,y:0},{x:10,y:0}],{tolerance:.1});
  assert.ok(simplified.points.length<=4);
  const metricTolerance=fitPolyline([{x:0,y:0},{x:5,y:.2},{x:10,y:0}],{tolerance:.3});
  assert.equal(metricTolerance.points.length,2);
  const snap=smartSnap({x:9.2,y:.4},[{id:'line-1',type:'line',x1:0,y1:0,x2:10,y2:0}],{tolerance:2});
  assert.equal(snap.best.kind,'endpoint');
  const axis=snapToAxis({x:4,y:2},{x:0,y:0},0);
  assert.equal(axis.axis,'x');
});

test('metrics, diagnosis and geometry diff are explicit', () => {
  const line={type:'line',x1:0,y1:0,x2:3,y2:4};
  const metrics=objectMetrics(line);
  assert.equal(metrics.length,5);
  assert.equal(measureBetween({x:0,y:0},{x:3,y:4}).distance,5);
  assert.equal(diagnoseGeometry(line).ok,true);
  assert.equal(diagnoseGeometry({type:'line',x1:0,y1:0,x2:0,y2:0}).ok,false);
  assert.equal(geometryDiff({type:'rect',x:0,y:0,width:10,height:10},{type:'rect',x:1,y:0,width:10,height:10}).changed,true);
});

test('boolean preview and semantic intent planning are stable', () => {
  const squareA=[{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}];
  const squareB=[{x:5,y:5},{x:15,y:5},{x:15,y:15},{x:5,y:15}];
  const inter=polygonBoolean(squareA,squareB,'intersect');
  assert.equal(inter.points.length,4);
  const unsupported=polygonBoolean(squareA,squareB,'union');
  assert.equal(unsupported.mode,'unsupported');
  assert.equal(unsupported.exactFor,null);
  const plan=intentPlan({kind:'circle',position:{x:10,y:20},radius:5,snap:true},{objects:[]});
  assert.equal(plan.steps.at(-1).tool,'geometry.ellipse');
  assert.equal(plan.requires.geometryAudit,true);
});

test('advanced catalog is explicit', () => {
  const names=buildAdvancedPrecisionToolCatalog().map(x=>x.name);
  for(const name of ['geometry.smartSnap','geometry.intentPlan','geometry.bezierSplit','geometry.diagnose','geometry.coordinateFrame']) {
    assert.ok(names.includes(name));
  }
});
