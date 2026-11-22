import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRegularPolygon,
  createStar,
  createBezier,
  pathFromCommands,
  translateObject,
  scaleObject,
  rotatePoint,
  distributeObjects,
  boundsOf,
  constructSymmetryPoints,
  projectPointToSegment,
  lineIntersection,
  measureObject,
  createRoundedRect,
  createArc,
  createCircleThroughThreePoints,
  createPolarArray,
  createGridArray,
  polylineLength,
  nearestPointOnPolyline,
  alignObjectEdges,
  buildAgentToolCatalog
} from '../public/pixelforge/src/agent-precision-tools.js';

test('precision primitives generate deterministic geometry', () => {
  const polygon = createRegularPolygon(100, 100, 50, 4, 0);
  assert.equal(polygon.type, 'path');
  assert.equal(polygon.points.length, 4);
  assert.ok(Math.abs(polygon.points[0].x - 150) < 1e-9);

  const star = createStar(0, 0, 10, 5, 5);
  assert.equal(star.points.length, 10);

  const bezier = createBezier([{x:0,y:0},{x:10,y:10}], {closed:false});
  assert.equal(bezier.points.length, 2);
  assert.equal(bezier.points[1].kind, 'cubic');
});

test('exact path commands and transforms are stable', () => {
  const path = pathFromCommands([
    {type:'M',x:10,y:20},
    {type:'C',x:40,y:50,c1:{x:20,y:20},c2:{x:30,y:40}},
    {type:'L',x:60,y:70}
  ]);
  assert.equal(path.points[1].c1.x, 20);
  const moved = translateObject(path, 5, -10);
  assert.equal(moved.points[0].x, 15);
  assert.equal(moved.points[0].y, 10);
  const scaled = scaleObject(moved, {x:0,y:0}, 2);
  assert.equal(scaled.points[0].x, 30);
  assert.equal(scaled.points[0].y, 20);
  const rotated = rotatePoint({x:10,y:0},{x:0,y:0},90);
  assert.ok(Math.abs(rotated.x) < 1e-9);
  assert.ok(Math.abs(rotated.y-10) < 1e-9);
});

test('bounds, distribution and symmetry are exact', () => {
  const objects = [
    {type:'rect',x:0,y:0,width:10,height:10},
    {type:'rect',x:30,y:0,width:10,height:10},
    {type:'rect',x:80,y:0,width:10,height:10}
  ];
  const distributed = distributeObjects(objects,'x',10);
  assert.deepEqual(distributed.map(o=>o.x), [0,20,40]);
  assert.deepEqual(boundsOf(distributed[1]), {x:20,y:0,width:10,height:10});
  const mirrored = constructSymmetryPoints({x:120,y:50},{x:100,y:50},'mirror-x');
  assert.deepEqual(mirrored[1], {x:80,y:50});
  const radial = constructSymmetryPoints({x:110,y:100},{x:100,y:100},'radial',4);
  assert.equal(radial.length,4);
});

test('measurement, projection and intersection provide exact construction feedback', () => {
  const projection = projectPointToSegment({x:5,y:4},{x:0,y:0},{x:10,y:0});
  assert.deepEqual(projection.point,{x:5,y:0});
  assert.equal(projection.t,0.5);
  const intersection = lineIntersection({x:0,y:0},{x:10,y:10},{x:0,y:10},{x:10,y:0});
  assert.equal(intersection.intersects,true);
  assert.ok(Math.abs(intersection.point.x-5)<1e-9);
  const measurement = measureObject({type:'line',x1:0,y1:0,x2:3,y2:4});
  assert.equal(measurement.length,5);
  assert.equal(measurement.angle,Math.atan2(4,3)*180/Math.PI);
});

test('parametric construction tools cover common illustration cases', () => {
  const rr=createRoundedRect(10,20,100,60,12);
  assert.equal(rr.type,'path');
  assert.equal(rr.closed,true);
  assert.equal(rr.points.length,12);

  const arc=createArc(0,0,50,0,180);
  assert.equal(arc.type,'path');
  assert.ok(arc.points.length>=3);

  const circle=createCircleThroughThreePoints({x:0,y:1},{x:1,y:0},{x:0,y:-1});
  assert.ok(Math.abs(circle.x-(-0)) < 1e-9);
  assert.ok(Math.abs(circle.width-2) < 1e-9);

  const object={type:'rect',x:0,y:0,width:10,height:10};
  assert.equal(createPolarArray(object,{x:0,y:0},4).length,4);
  assert.equal(createGridArray(object,{x:0,y:0},3,2,20,30).length,6);

  assert.equal(polylineLength([{x:0,y:0},{x:3,y:4}]),5);
  const nearest=nearestPointOnPolyline({x:5,y:3},[{x:0,y:0},{x:10,y:0}]);
  assert.deepEqual(nearest.point,{x:5,y:0});

  const aligned=alignObjectEdges([
    {type:'rect',x:10,y:0,width:10,height:10},
    {type:'rect',x:50,y:20,width:20,height:20}
  ],'left');
  assert.deepEqual(aligned.map(o=>o.x),[10,10]);
});

test('agent tool catalog is explicit and deterministic', () => {
  const names = buildAgentToolCatalog().map(tool=>tool.name);
  for (const name of ['geometry.path','geometry.bezier','geometry.distribute','geometry.symmetry','guide.create']) {
    assert.ok(names.includes(name));
  }
});
