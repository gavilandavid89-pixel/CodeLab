import { AIWorkspace } from './workspaces.js';
import { validatePixelForgeProject, validateVectorModel, formatValidationFailure } from './pixelforge-validation.js';
import { DrawingWorkflow } from './drawing-workflow.js';
import { buildAgentToolCatalog, createLine, createRect, createEllipse, createRegularPolygon, createStar, createBezier, pathFromCommands, translateObject, scaleObject, rotateObject, boundsOf, distributeObjects, constructSymmetryPoints, makePrecisionGuide, projectPointToSegment, lineIntersection, measureObject, createRoundedRect, createArc, createCircleThroughThreePoints, createPolarArray, createGridArray, polylineLength, nearestPointOnPolyline, alignObjectEdges } from './agent-precision-tools.js';
import { buildAdvancedPrecisionToolCatalog, coordinateFrame, localToWorld, worldToLocal, polarPoint, angleBisector, perpendicularThrough, parallelThrough, divideSegment, circumcenter, triangleCenters, circleLineIntersections, tangentLinesToCircle, bezierPoint, bezierTangentAt, bezierCurvatureAt, splitBezier, curveContinuity, sampleBezier, fitPolyline, reversePath, pathLength, polygonBoolean, smartSnap, snapToAxis, measureBetween, objectMetrics, diagnoseGeometry, geometryDiff, intentPlan } from './advanced-precision-tools.js';
import { buildConnectivityToolCatalog, connectObjects, joinPaths, closeGap, extendToIntersection, trimToIntersection, filletLines, chamferLines, offsetLine, snapSmart, anchorPoint, alignToAnchor, dimension, constructionGraph, solveConstraints, constraintAudit, continuity } from './agent-connectivity-tools.js';
import { parseSVGToVectorModel } from './vector-studio.js';
import { normalizeIllustrationScene, validateIllustrationScene, compileIllustrationScene } from './illustration-scene.js';
import { createSelectionMask, createColorSelectionMask, modifySelectionMask, combineSelectionMasks, translateSelectionMask } from './core.js';
import { createDrawingModel, normalizeDrawingModel, inspectLayerPixels, inspectRasterObject, createAlphaComponentSelection, extractLineGuide, registerReferenceEntry, getReferenceEntry, buildReferenceFromProject, applyReferenceToDrawingModel, deserializePixels, serializePixels, setDrawingLayerRole, getCurrentState, setCurrentState, recordEnvironmentHistory, getEnvironmentHistoryEntry, copyReferencePixelsToActiveFrameLayer, compositeReferenceFramePixels, DRAWING_SHEET_PRESETS, SEMANTIC_PALETTE } from './drawing-intelligence.js';

const COLOR = /^#[0-9a-f]{6}$/i;
const DENIED_ACTIONS = new Set([
  'project.delete', 'document.delete', 'project.export', 'document.export',
  'canvas.export', 'project.upload', 'project.publish',
]);

function integer(value, label) {
  if (!Number.isInteger(value)) throw new TypeError(label + ' must be an integer.');
  return value;
}

function color(value, label = 'color') {
  if (typeof value !== 'string' || !COLOR.test(value)) throw new TypeError(label + ' must use #RRGGBB format.');
  return value.toUpperCase();
}

function coordinate(doc, x, y) {
  integer(x, 'x'); integer(y, 'y');
  if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) throw new RangeError('Coordinates are outside the canvas.');
}

function rectangle(doc, x, y, width, height) {
  integer(x, 'x'); integer(y, 'y'); integer(width, 'width'); integer(height, 'height');
  if (width < 1 || height < 1 || x < 0 || y < 0 || x + width > doc.width || y + height > doc.height) {
    throw new RangeError('Rectangle must fit completely inside the canvas.');
  }
}

function plainResult(value) {
  return JSON.parse(JSON.stringify(value));
}

function encodeBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

function symmetryPoints(doc, point, mode) {
  if (mode === 0) return [point];
  const cx = (doc.width - 1) / 2, cy = (doc.height - 1) / 2;
  const dx = point.x - cx, dy = point.y - cy;
  let offsets;
  if (mode === 2) offsets = [[dx, dy], [-dx, dy]];
  else if (mode === 4) offsets = [[dx, dy], [-dx, dy], [dx, -dy], [-dx, -dy]];
  else offsets = [[dx, dy], [-dy, dx], [-dx, -dy], [dy, -dx], [-dx, dy], [-dy, -dx], [dx, -dy], [dy, dx]];
  return offsets.map(([ox, oy]) => {
    const x = Math.round(cx + ox), y = Math.round(cy + oy);
    return x < 0 || y < 0 || x >= doc.width || y >= doc.height ? null : { x, y };
  });
}

function strokeToWithSymmetry(doc, stroke, x, y, mode) {
  if (mode === 0) { doc.strokeTo(stroke, x, y); return; }
  const points = symmetryPoints(doc, { x, y }, mode);
  const previous = stroke.symmetryLastPoints ?? [];
  const next = [];
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    if (!point) { next[index] = null; continue; }
    stroke.last = previous[index] ?? null;
    doc.strokeTo(stroke, point.x, point.y);
    next[index] = stroke.last;
  }
  stroke.symmetryLastPoints = next;
  stroke.last = next[0] ?? null;
}

/**
 * Provider-independent, allowlisted tool executor. It can only reach the AI
 * sandbox and only exposes structured actions; no arbitrary code or I/O.
 */
export class AICommandSession {
  #workspace;
  #clipboard = null;
  #drawingWorkflow = null;

  constructor(workspace) {
    if (!(workspace instanceof AIWorkspace)) throw new TypeError('Expected an AIWorkspace.');
    this.#workspace = workspace;
  }

  execute(action) {
    if (!action || typeof action !== 'object' || Array.isArray(action) ||
        typeof action.name !== 'string' || !action.name.trim()) {
      return { ok: false, error: { code: 'invalid_action', message: 'Action must be an object with a name.' } };
    }
    if (DENIED_ACTIONS.has(action.name)) {
      return { ok: false, error: { code: 'permission_denied', message: 'AI tools cannot delete, export, upload, or publish a project.' } };
    }
    const readOnlyActions = new Set(['document.get_summary', 'canvas.get_reference', 'canvas.get_pixel', 'canvas.get_region', 'canvas.preview_transform_region', 'drawing.model.get', 'drawing.sheet.get', 'drawing.object.inspect', 'drawing.layer.inspect', 'drawing.palette.get', 'drawing.reference.list', 'drawing.reference.get']);
    if (this.#workspace.hasProposal && !readOnlyActions.has(action.name)) {
      return { ok: false, action: action.name, error: { code: 'proposal_pending', message: 'Accept or discard the pending proposal before making more sandbox edits.' } };
    }
    try {
      const doc = this.#workspace.sandbox;
      let result;
      switch (action.name) {
        case 'geometry.point': {
          result = { point: { x: Number(action.x), y: Number(action.y) } };
          break;
        }
        case 'geometry.line': {
          result = createLine(action.a || { x: action.x1, y: action.y1 }, action.b || { x: action.x2, y: action.y2 }, action.style || {});
          break;
        }
        case 'geometry.rect': {
          result = createRect(action.x, action.y, action.width, action.height, action.style || {});
          break;
        }
        case 'geometry.ellipse': {
          result = createEllipse(action.cx, action.cy, action.rx, action.ry, action.style || {});
          break;
        }
        case 'geometry.polygon': {
          result = createRegularPolygon(action.cx, action.cy, action.radius, action.sides, action.rotation, action.style || {});
          break;
        }
        case 'geometry.star': {
          result = createStar(action.cx, action.cy, action.outerRadius, action.innerRadius, action.points, action.rotation, action.style || {});
          break;
        }
        case 'geometry.bezier': {
          result = createBezier(action.points, { closed: action.closed, style: action.style || {} });
          break;
        }
        case 'geometry.path': {
          result = pathFromCommands(action.commands, action.style || {});
          break;
        }
        case 'geometry.translate': {
          result = translateObject(action.object, action.dx, action.dy);
          break;
        }
        case 'geometry.scale': {
          result = scaleObject(action.object, action.center, action.sx, action.sy);
          break;
        }
        case 'geometry.rotate': {
          result = rotateObject(action.object, action.center, action.degrees);
          break;
        }
        case 'geometry.bounds': {
          result = boundsOf(action.object);
          break;
        }
        case 'geometry.project': {
          result = projectPointToSegment(action.point, action.a, action.b);
          break;
        }
        case 'geometry.intersection': {
          result = lineIntersection(action.a1, action.a2, action.b1, action.b2);
          break;
        }
        case 'geometry.measure': {
          result = measureObject(action.object);
          break;
        }
        case 'geometry.roundedRect': {
          result = createRoundedRect(action.x, action.y, action.width, action.height, action.radius, action.style || {});
          break;
        }
        case 'geometry.arc': {
          result = createArc(action.cx, action.cy, action.radius, action.startDegrees, action.endDegrees, action.style || {});
          break;
        }
        case 'geometry.circle3': {
          result = createCircleThroughThreePoints(action.a, action.b, action.c, action.style || {});
          break;
        }
        case 'geometry.polarArray': {
          result = { objects: createPolarArray(action.object, action.center, action.count, action.startDegrees, action.sweepDegrees) };
          break;
        }
        case 'geometry.gridArray': {
          result = { objects: createGridArray(action.object, action.origin, action.columns, action.rows, action.dx, action.dy) };
          break;
        }
        case 'geometry.polylineLength': {
          result = { length: polylineLength(action.points, action.closed) };
          break;
        }
        case 'geometry.nearest': {
          result = nearestPointOnPolyline(action.point, action.points, action.closed);
          break;
        }
        case 'geometry.edgeAlign': {
          result = { objects: alignObjectEdges(action.objects, action.edge, action.target) };
          break;
        }
        case 'geometry.distribute': {
          result = { objects: distributeObjects(action.objects, action.axis || 'x', action.gap) };
          break;
        }
        case 'geometry.symmetry': {
          result = { points: constructSymmetryPoints(action.point, action.center, action.mode || 'mirror-x', action.radialCount) };
          break;
        }
        case 'guide.create': {
          result = makePrecisionGuide(action);
          break;
        }
        case 'geometry.coordinateFrame': result = coordinateFrame(action.origin, action.angleDegrees); break;
        case 'geometry.toLocal': result = worldToLocal(action.point, action.frame); break;
        case 'geometry.toWorld': result = localToWorld(action.point, action.frame); break;
        case 'geometry.polarPoint': result = polarPoint(action.origin, action.radius, action.angleDegrees); break;
        case 'geometry.angleBisector': result = angleBisector(action.a, action.vertex ?? action.b, action.c); break;
        case 'geometry.perpendicularThrough': result = perpendicularThrough(action.point, action.a, action.b); break;
        case 'geometry.parallelThrough': result = parallelThrough(action.point, action.a, action.b); break;
        case 'geometry.divideSegment': result = { points: divideSegment(action.a, action.b, action.count, action.mode) }; break;
        case 'geometry.circumcenter': result = circumcenter(action.a, action.b, action.c); break;
        case 'geometry.triangleCenters': result = triangleCenters(action.a, action.b, action.c); break;
        case 'geometry.circleLineIntersections': result = { points: circleLineIntersections(action.circle, action.a, action.b) }; break;
        case 'geometry.tangentLinesToCircle': result = { lines: tangentLinesToCircle(action.point, action.circle) }; break;
        case 'geometry.bezierPoint': result = bezierPoint(action.p0, action.p1, action.p2, action.p3, action.t); break;
        case 'geometry.bezierTangent': result = bezierTangentAt(action.segment, action.t); break;
        case 'geometry.bezierCurvature': result = { curvature: bezierCurvatureAt(action.segment, action.t) }; break;
        case 'geometry.bezierSplit': result = { segments: splitBezier(action.segment, action.t) }; break;
        case 'geometry.bezierContinuity': result = curveContinuity(action.a, action.b, action.tolerance ?? 0.001); break;
        case 'geometry.bezierSample': result = { points: sampleBezier(action.segment, action.samples ?? 32) }; break;
        case 'geometry.fitPolyline': result = fitPolyline(action.points, { closed: action.closed, tolerance: action.tolerance ?? 0.5 }); break;
        case 'geometry.reversePath': result = reversePath(action.path); break;
        case 'geometry.pathLength': result = { length: pathLength(action.path) }; break;
        case 'geometry.boolean': result = polygonBoolean(action.subject, action.clip, action.operation ?? 'intersect'); break;
        case 'geometry.smartSnap': result = smartSnap(action.point, action.objects || [], action.options || { tolerance: action.tolerance ?? 8, grid: action.grid }); break;
        case 'geometry.snapAxis': result = snapToAxis(action.point, action.origin, action.angleDegrees); break;
        case 'geometry.measureBetween': result = measureBetween(action.a, action.b); break;
        case 'geometry.objectMetrics': result = objectMetrics(action.object); break;
        case 'geometry.diagnose': result = diagnoseGeometry(action.object, { tolerance: action.tolerance ?? 0.001 }); break;
        case 'geometry.diff': result = geometryDiff(action.before, action.after, action.tolerance ?? 0.001); break;
        case 'geometry.intentPlan': result = intentPlan(action.intent, { objects: action.objects || [] }); break;
        case 'geometry.add': {
          const model = doc.getVectorModel() || { version: 4, width: doc.width, height: doc.height, grid: 8, snap: true, objects: [], frames: [] };
          const object = action.object;
          if (!object || typeof object !== 'object') throw new TypeError('geometry.add requires an object.');
          const next = plainResult(object); next.id = next.id || crypto.randomUUID();
          model.objects.push(next); doc.setVectorModel(model); result = { object: next, objectCount: model.objects.length };
          break;
        }
        case 'geometry.update': {
          const model = doc.getVectorModel(); if (!model) throw new Error('No vector model exists.');
          const index = model.objects.findIndex(item => item.id === action.id); if (index < 0) throw new Error('Vector object not found.');
          model.objects[index] = { ...model.objects[index], ...plainResult(action.patch || {}), id: model.objects[index].id };
          doc.setVectorModel(model); result = { object: plainResult(model.objects[index]) };
          break;
        }
        case 'drawing.workflow.start': {
          const workflowId = typeof action.workflowId === 'string' && action.workflowId ? action.workflowId : crypto.randomUUID();
          this.#drawingWorkflow = new DrawingWorkflow({
            workflowId,
            projectId: action.projectId ?? null,
            stage: action.stage ?? 'sketch',
            qualityGate: {
              enabled: true,
              minScore: action.minQualityScore ?? 0.8,
            },
          });
          result = this.#drawingWorkflow.getState();
          break;
        }
        case 'drawing.scene.normalize': {
          result = normalizeIllustrationScene(action.scene);
          break;
        }
        case 'drawing.scene.validate': {
          const validation = validateIllustrationScene(action.scene);
          result = { ok: validation.ok, errors: validation.errors, scene: validation.scene };
          break;
        }
        case 'drawing.scene.compile': {
          result = compileIllustrationScene(action.scene);
          break;
        }
        case 'drawing.workflow.set_scene': {
          if (!this.#drawingWorkflow) throw new Error('No drawing workflow is active.');
          const validation = validateIllustrationScene(action.scene);
          if (!validation.ok) throw new Error('Invalid illustration scene: ' + validation.errors.join(' '));
          result = this.#drawingWorkflow.setScene(validation.scene);
          break;
        }
        case 'drawing.workflow.get_scene':
          if (!this.#drawingWorkflow) throw new Error('No drawing workflow is active.');
          result = this.#drawingWorkflow.getScene();
          break;
        case 'drawing.workflow.get_state':
          if (!this.#drawingWorkflow) throw new Error('No drawing workflow is active.');
          result = this.#drawingWorkflow.getState();
          break;
        case 'drawing.workflow.record_action':
          if (!this.#drawingWorkflow) throw new Error('No drawing workflow is active.');
          result = this.#drawingWorkflow.recordAction(action.action);
          break;
        case 'drawing.workflow.visual_feedback':
          if (!this.#drawingWorkflow) throw new Error('No drawing workflow is active.');
          result = this.#drawingWorkflow.attachVisualFeedback({
            snapshotId: action.snapshotId,
            summary: action.summary,
            metrics: action.metrics,
            quality: action.quality,
          });
          break;
        case 'drawing.workflow.pause':
          if (!this.#drawingWorkflow) throw new Error('No drawing workflow is active.');
          result = this.#drawingWorkflow.pause(action.reason);
          break;
        case 'drawing.workflow.resume':
          if (!this.#drawingWorkflow) throw new Error('No drawing workflow is paused.');
          result = this.#drawingWorkflow.resume();
          break;
        case 'drawing.workflow.correct':
          if (!this.#drawingWorkflow) throw new Error('No drawing workflow is active.');
          result = this.#drawingWorkflow.correct({
            stage: action.stage,
            reason: action.reason,
            actions: action.actions,
          });
          break;
        case 'drawing.workflow.advance':
          if (!this.#drawingWorkflow) throw new Error('No drawing workflow is active.');
          result = this.#drawingWorkflow.advanceStage({
            feedbackRequired: action.feedbackRequired !== false,
            qualityRequired: true,
          });
          break;
        case 'drawing.model.get':
          result = doc.getDrawingModel() || createDrawingModel({ sheet: { width: doc.width, height: doc.height } });
          break;
        case 'drawing.sheet.get': {
          const model = normalizeDrawingModel(doc.getDrawingModel(), { width: doc.width, height: doc.height });
          result = { sheet: model.sheet, presets: DRAWING_SHEET_PRESETS, palette: model.palette };
          break;
        }
        case 'drawing.sheet.configure': {
          const current = normalizeDrawingModel(doc.getDrawingModel(), { width: doc.width, height: doc.height });
          const next = normalizeDrawingModel({ ...current, sheet: { ...current.sheet, ...(action.sheet || {}) } }, { width: doc.width, height: doc.height });
          if (next.sheet.width !== doc.width || next.sheet.height !== doc.height) throw new Error('Drawing sheet metadata cannot change raster canvas dimensions; resize the document first.');
          doc.setDrawingModel(next);
          result = { sheet: next.sheet };
          break;
        }
        case 'drawing.palette.get':
          result = { palette: SEMANTIC_PALETTE, active: normalizeDrawingModel(doc.getDrawingModel(), { width: doc.width, height: doc.height }).palette };
          break;
        case 'drawing.object.select_at': {
          const layer = action.layerId ? doc.layers.find(item => item.id === action.layerId) : doc.activeLayer;
          if (!layer) throw new Error('Target layer was not found.');
          const pixels = action.merged ? doc.composite() : layer.pixels;
          const selection = createAlphaComponentSelection({ pixels, width: doc.width, height: doc.height, x: integer(action.x, 'x'), y: integer(action.y, 'y') });
          doc.setSelectionMask(selection.mask);
          result = { selectedPixels: selection.selectedPixels, bounds: selection.bounds, layerId: layer.id, merged: action.merged === true };
          break;
        }
        case 'drawing.object.inspect': {
          const layer = action.layerId ? doc.layers.find(item => item.id === action.layerId) : doc.activeLayer;
          if (!layer) throw new Error('Target layer was not found.');
          const pixels = action.merged ? doc.composite() : layer.pixels;
          result = inspectRasterObject({ pixels, width: doc.width, height: doc.height, objectId: action.objectId || null, x: action.x == null ? null : integer(action.x, 'x'), y: action.y == null ? null : integer(action.y, 'y'), gridStep: action.gridStep ?? 8 });
          break;
        }
        case 'drawing.layer.inspect': {
          const layer = action.layerId ? doc.layers.find(item => item.id === action.layerId) : doc.activeLayer;
          if (!layer) throw new Error('Target layer was not found.');
          result = inspectLayerPixels(layer, doc.width, doc.height, { gridStep: action.gridStep ?? 8, objectId: action.objectId || null });
          break;
        }
        case 'drawing.reference.extract_line_guide': {
          const source = deserializePixels(action.pixels);
          const width = integer(action.width, 'width'), height = integer(action.height, 'height');
          if (width !== doc.width || height !== doc.height) throw new Error('Line-guide dimensions must match the current canvas.');
          const guide = extractLineGuide({ pixels: source, width, height, threshold: action.threshold ?? 28, detail: action.detail ?? 1, invert: action.invert === true });
          const previousActiveLayerId = doc.activeLayerId;
          const layer = doc.addLayer(String(action.layerName || 'Reference Guide').slice(0, 180));
          layer.opacity = Math.max(0, Math.min(1, Number(action.opacity ?? 0.35)));
          layer.visible = action.visible !== false;
          doc.setLayerPixels(layer.id, guide.pixels);
          layer.locked = action.locked !== false;
          doc.setActiveLayer(previousActiveLayerId);
          result = { layerId: layer.id, name: layer.name, opacity: layer.opacity, locked: layer.locked, width, height, threshold: guide.threshold, detail: guide.detail };
          break;
        }
        case 'drawing.reference.package_current':
          throw new Error('drawing.reference.package_current is available only in the headless project runtime.');
        case 'drawing.layer.role.set': {
          const model = normalizeDrawingModel(doc.getDrawingModel(), { width: doc.width, height: doc.height });
          const layer = doc.layers.find(item => item.id === action.layerId || (action.layerName && item.name === String(action.layerName)));
          if (!layer) throw new Error('Layer was not found.');
          const next = setDrawingLayerRole(model, action);
          doc.setDrawingModel(next);
          result = { layerId: layer.id, layerName: layer.name, role: next.layerRoles[layer.id] };
          break;
        }
        case 'drawing.current_state.set': {
          const model = normalizeDrawingModel(doc.getDrawingModel(), { width: doc.width, height: doc.height });
          const next = setCurrentState(model, {
            ...action.state,
            sourceRevision: action.state?.sourceRevision ?? doc.saveVersion,
            layerIds: action.state?.layerIds ?? [doc.activeLayerId],
          });
          doc.setDrawingModel(next);
          result = { state: getCurrentState(next, action.state?.entityId || action.state?.id) };
          break;
        }
        case 'drawing.current_state.get': {
          const model = normalizeDrawingModel(doc.getDrawingModel(), { width: doc.width, height: doc.height });
          result = { state: getCurrentState(model, action.entityId || null), currentState: model.currentState };
          break;
        }
        case 'drawing.environment_history.record': {
          const model = normalizeDrawingModel(doc.getDrawingModel(), { width: doc.width, height: doc.height });
          const next = recordEnvironmentHistory(model, {
            ...action,
            sourceRevision: action.sourceRevision ?? doc.saveVersion,
            environmentLayerIds: action.environmentLayerIds ?? Object.entries(model.layerRoles).filter(([, meta]) => meta?.role === 'environment').map(([id]) => id),
          });
          doc.setDrawingModel(next);
          result = { entry: getEnvironmentHistoryEntry(next, action.id || null), history: next.environmentHistory };
          break;
        }
        case 'drawing.environment_history.get': {
          const model = normalizeDrawingModel(doc.getDrawingModel(), { width: doc.width, height: doc.height });
          result = { entry: getEnvironmentHistoryEntry(model, action.id || null), history: model.environmentHistory };
          break;
        }
        case 'drawing.environment_history.list': {
          const model = normalizeDrawingModel(doc.getDrawingModel(), { width: doc.width, height: doc.height });
          result = { entries: model.environmentHistory.entries, activeEntryId: model.environmentHistory.activeEntryId };
          break;
        }
        case 'drawing.reference.create': {
          const project = doc.toJSON();
          const current = normalizeDrawingModel(doc.getDrawingModel(), { width: doc.width, height: doc.height });
          const entry = action.entry || buildReferenceFromProject({ projectId: project.id, project, name: action.referenceName || 'Drawing reference' });
          const next = registerReferenceEntry(current, entry);
          doc.setDrawingModel(next);
          result = { reference: getReferenceEntry(next, entry.id || next.referenceCenter.activeEntryId), referenceCenter: next.referenceCenter };
          break;
        }
        case 'drawing.reference.list': {
          const model = normalizeDrawingModel(doc.getDrawingModel(), { width: doc.width, height: doc.height });
          result = { entries: model.referenceCenter.entries, activeEntryId: model.referenceCenter.activeEntryId };
          break;
        }
        case 'drawing.reference.get': {
          const model = normalizeDrawingModel(doc.getDrawingModel(), { width: doc.width, height: doc.height });
          const entry = getReferenceEntry(model, action.referenceId);
          if (!entry) throw new Error('Reference entry was not found.');
          result = { reference: entry };
          break;
        }
        case 'drawing.reference.copy_part': {
          const model = normalizeDrawingModel(doc.getDrawingModel(), { width: doc.width, height: doc.height });
          const entry = getReferenceEntry(model, action.referenceId);
          if (!entry) throw new Error('Reference entry was not found.');
          const part = entry.parts.find(item => item.id === action.partId || item.name === action.partName);
          if (!part) throw new Error('Reference part was not found.');
          if (typeof part.pixels !== 'string') throw new Error('Reference part has no packaged raster data.');
          const copied = copyReferencePixelsToActiveFrameLayer({
            drawingDocument: doc,
            pixels: deserializePixels(part.pixels),
          });
          result = {
            copied: true, referenceId: entry.id, partId: part.id,
            sourceLayerId: part.layerId, targetLayerId: copied.layerId,
            targetLayerName: doc.activeLayer?.name || null,
            frameIndex: copied.frameIndex, source: 'reference-center',
          };
          break;
        }
        case 'drawing.reference.copy_frame': {
          const model = normalizeDrawingModel(doc.getDrawingModel(), { width: doc.width, height: doc.height });
          const entry = getReferenceEntry(model, action.referenceId);
          if (!entry) throw new Error('Reference entry was not found.');
          const frameIndex = integer(action.frameIndex, 'frameIndex');
          const pixels = compositeReferenceFramePixels(entry, frameIndex, doc.width, doc.height);
          const copied = copyReferencePixelsToActiveFrameLayer({ drawingDocument: doc, pixels });
          result = {
            copied: true, referenceId: entry.id, frameIndex,
            targetLayerId: copied.layerId, targetLayerName: doc.activeLayer?.name || null,
            frameLayerCount: frameIndex >= 0 ? entry.frames.find(item => item.index === frameIndex)?.layers?.length || 0 : 0,
            source: 'reference-center',
          };
          break;
        }
        case 'drawing.layer.context.set': {
          const model = normalizeDrawingModel(doc.getDrawingModel(), { width: doc.width, height: doc.height });
          const previousOpacity = Math.max(0, Math.min(1, Number(action.previousOpacity ?? 0.25)));
          const nextOpacity = Math.max(0, Math.min(1, Number(action.nextOpacity ?? 0.15)));
          const previousCount = Math.max(0, Math.min(32, integer(action.previousCount ?? 1, 'previousCount')));
          const nextCount = Math.max(0, Math.min(32, integer(action.nextCount ?? 1, 'nextCount')));
          model.referenceCenter.viewContext = { previousOpacity, nextOpacity, previousCount, nextCount };
          doc.setDrawingModel(model);
          result = { viewContext: model.referenceCenter.viewContext, activeLayerId: doc.activeLayerId, rule: 'active layer remains at full visual emphasis; surrounding layers use contextual opacity' };
          break;
        }
        case 'drawing.reference.apply': {
          const model = normalizeDrawingModel(doc.getDrawingModel(), { width: doc.width, height: doc.height });
          const entry = getReferenceEntry(model, action.referenceId);
          if (!entry) throw new Error('Reference entry was not found.');
          const next = applyReferenceToDrawingModel(model, entry);
          doc.setDrawingModel(next);
          result = { applied: true, referenceId: entry.id, sheet: next.sheet, objects: next.objects };
          break;
        }
        case 'drawing.reference.remove': {
          const model = normalizeDrawingModel(doc.getDrawingModel(), { width: doc.width, height: doc.height });
          const entries = model.referenceCenter.entries.filter(entry => entry.id !== action.referenceId);
          if (entries.length === model.referenceCenter.entries.length) throw new Error('Reference entry was not found.');
          model.referenceCenter.entries = entries;
          model.referenceCenter.activeEntryId = entries.at(-1)?.id || null;
          doc.setDrawingModel(model);
          result = { removed: true, referenceId: action.referenceId, activeEntryId: model.referenceCenter.activeEntryId };
          break;
        }
        case 'document.get_summary':
          result = {
            name: doc.name, width: doc.width, height: doc.height,
            revision: doc.revision, activeLayerId: doc.activeLayerId,
            layerCount: doc.layers.length,
            layers: doc.layers.map((layer, index) => ({
              index, id: layer.id, name: layer.name, visible: layer.visible,
              locked: layer.locked, opacity: layer.opacity,
            })),
          };
          break;
        case 'document.rename':
          result = { renamed: doc.renameDocument(action.newName), name: doc.name };
          break;
        case 'canvas.get_reference': {
          const gridStep = action.gridStep ?? 8;
          integer(gridStep, 'gridStep');
          if (gridStep < 1 || gridStep > 256) throw new RangeError('gridStep must be between 1 and 256 pixels.');
          const maxX = doc.width - 1, maxY = doc.height - 1;
          const point = (x, y) => ({ x: Math.round(x), y: Math.round(y) });
          const at = (xRatio, yRatio) => point(maxX * xRatio, maxY * yRatio);
          const xLines = [], yLines = [];
          for (let x = 0; x <= maxX && xLines.length < 512; x += gridStep) xLines.push(x);
          for (let y = 0; y <= maxY && yLines.length < 512; y += gridStep) yLines.push(y);
          if (xLines[xLines.length - 1] !== maxX) xLines.push(maxX);
          if (yLines[yLines.length - 1] !== maxY) yLines.push(maxY);
          const active = doc.activeLayer;
          result = {
            coordinateSystem: { unit: 'pixel', origin: 'top-left', xAxis: 'right', yAxis: 'down', integerCoordinates: 'pixel indices; (0,0) is the top-left pixel', bounds: { minX: 0, minY: 0, maxX, maxY, width: doc.width, height: doc.height } },
            landmarks: {
              topLeft: point(0, 0), topCenter: at(0.5, 0), topRight: point(maxX, 0),
              middleLeft: at(0, 0.5), center: at(0.5, 0.5), middleRight: at(1, 0.5),
              bottomLeft: point(0, maxY), bottomCenter: at(0.5, 1), bottomRight: point(maxX, maxY),
              quarterPoints: { topLeft: at(0.25, 0.25), topRight: at(0.75, 0.25), bottomLeft: at(0.25, 0.75), bottomRight: at(0.75, 0.75) },
            },
            grid: { step: gridStep, xLines, yLines, includesCanvasEdges: true },
            activeLayer: { id: active.id, name: active.name, index: doc.layers.findIndex(layer => layer.id === active.id), visible: active.visible, locked: active.locked, opacity: active.opacity },
            layers: doc.layers.map((layer, index) => ({ id: layer.id, name: layer.name, index, visible: layer.visible, locked: layer.locked, opacity: layer.opacity })),
          };
          break;
        }
        case 'canvas.get_pixel': {
          coordinate(doc, action.x, action.y);
          const merged = action.merged ?? true;
          if (typeof merged !== 'boolean') throw new TypeError('merged must be a boolean.');
          result = { x: action.x, y: action.y, color: doc.sampleColorAt(action.x, action.y, { merged }) };
          break;
        }
        case 'canvas.get_region': {
          const { x, y, width, height } = action;
          rectangle(doc, x, y, width, height);
          if (width > 32 || height > 32 || width * height > 1024) {
            throw new RangeError('Region reads are limited to 32 × 32 pixels (1,024 pixels total) so agent responses remain complete.');
          }
          const merged = action.merged ?? true;
          if (typeof merged !== 'boolean') throw new TypeError('merged must be a boolean.');
          if (merged && action.layerId !== undefined) throw new TypeError('layerId cannot be used when merged is true.');
          const layer = merged ? null : action.layerId === undefined
            ? doc.activeLayer
            : doc.layers.find(item => item.id === action.layerId);
          if (!merged && !layer) throw new Error('Requested raster layer was not found.');
          const source = merged ? doc.composite() : layer.pixels;
          const pixels = new Uint8ClampedArray(width * height * 4);
          for (let row = 0; row < height; row++) {
            const start = ((y + row) * doc.width + x) * 4;
            pixels.set(source.subarray(start, start + width * 4), row * width * 4);
          }
          result = {
            origin: { x, y }, width, height, merged,
            layerId: layer?.id ?? null,
            encoding: 'rgba8-base64',
            pixels: encodeBase64(pixels),
          };
          break;
        }
        case 'canvas.draw_line': {
          const { x0, y0, x1, y1 } = action;
          coordinate(doc, x0, y0); coordinate(doc, x1, y1);
          const paintColor = color(action.color);
          const size = action.size ?? 1;
          integer(size, 'size');
          if (size < 1 || size > 128) throw new RangeError('Brush size must be between 1 and 128 pixels.');
          const symmetryMode = action.symmetryMode ?? 0;
          if (![0, 2, 4, 8].includes(symmetryMode)) throw new RangeError('symmetryMode must be 0, 2, 4, or 8.');
          const stroke = doc.beginStroke({ color: paintColor, size });
          try {
            strokeToWithSymmetry(doc, stroke, x0, y0, symmetryMode);
            strokeToWithSymmetry(doc, stroke, x1, y1, symmetryMode);
            result = { changed: doc.endStroke(stroke), symmetryMode, bounds: { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0) + 1, height: Math.abs(y1 - y0) + 1 } };
          } catch (error) {
            doc.endStroke(stroke, { commit: false });
            throw error;
          }
          break;
        }
        case 'canvas.draw_stroke': {
          if (!Array.isArray(action.points) || action.points.length < 1 || action.points.length > 4096) throw new TypeError('points must contain 1–4096 coordinates.');
          for (const point of action.points) coordinate(doc, point?.x, point?.y);
          const size = action.size ?? 1, opacity = action.opacity ?? 1, hardness = action.hardness ?? 1;
          integer(size, 'size');
          if (size < 1 || size > 128 || !Number.isFinite(opacity) || opacity < 0 || opacity > 1 ||
              !Number.isFinite(hardness) || hardness < 0 || hardness > 1) throw new RangeError('Brush size, opacity or hardness is outside the supported range.');
          const mode = action.mode ?? 'draw', shape = action.shape ?? 'square';
          const symmetryMode = action.symmetryMode ?? 0;
          if (!['draw', 'erase'].includes(mode) || !['square', 'circle'].includes(shape)) throw new TypeError('Unsupported brush mode or shape.');
          if (![0, 2, 4, 8].includes(symmetryMode)) throw new RangeError('symmetryMode must be 0, 2, 4, or 8.');
          const stroke = doc.beginStroke({ color: color(action.color), size, opacity, hardness, shape, mode });
          try {
            for (const point of action.points) strokeToWithSymmetry(doc, stroke, point.x, point.y, symmetryMode);
            result = { changed: doc.endStroke(stroke), pointCount: action.points.length, symmetryMode };
          } catch (error) {
            doc.endStroke(stroke, { commit: false });
            throw error;
          }
          break;
        }
        case 'layer.add': {
          const layer = doc.addLayer(action.layerName ?? undefined);
          result = { layerId: layer.id, name: layer.name, index: doc.layers.length - 1 };
          break;
        }
        case 'layer.select':
          if (typeof action.layerId !== 'string') throw new TypeError('layerId is required.');
          doc.setActiveLayer(action.layerId);
          result = { activeLayerId: doc.activeLayerId };
          break;
        case 'layer.move': {
          if (typeof action.layerId !== 'string') throw new TypeError('layerId is required.');
          result = { moved: doc.moveLayer(action.layerId, integer(action.targetIndex, 'targetIndex')) };
          break;
        }
        case 'layer.rename': {
          if (typeof action.layerId !== 'string') throw new TypeError('layerId is required.');
          result = { renamed: doc.renameLayer(action.layerId, action.newName), layerId: action.layerId };
          break;
        }
        case 'layer.set_opacity': {
          if (typeof action.layerId !== 'string') throw new TypeError('layerId is required.');
          if (!Number.isFinite(action.opacity)) throw new TypeError('opacity must be a finite number.');
          result = { changed: doc.setLayerOpacity(action.layerId, action.opacity) };
          break;
        }
        case 'layer.set_visibility': {
          if (typeof action.layerId !== 'string' || typeof action.visible !== 'boolean') throw new TypeError('layerId and boolean visible are required.');
          doc.setLayerVisibility(action.layerId, action.visible);
          result = { layerId: action.layerId, visible: action.visible };
          break;
        }
        case 'layer.set_locked': {
          if (typeof action.layerId !== 'string' || typeof action.locked !== 'boolean') throw new TypeError('layerId and boolean locked are required.');
          doc.setLayerLocked(action.layerId, action.locked);
          result = { layerId: action.layerId, locked: action.locked };
          break;
        }
        case 'layer.duplicate': {
          if (typeof action.layerId !== 'string') throw new TypeError('layerId is required.');
          const layer = doc.duplicateLayer(action.layerId, action.layerName);
          result = { layerId: layer.id, name: layer.name, index: doc.layers.findIndex(item => item.id === layer.id) };
          break;
        }
        case 'layer.delete': {
          if (typeof action.layerId !== 'string') throw new TypeError('layerId is required.');
          const removed = doc.deleteLayer(action.layerId);
          result = { deletedLayerId: removed.id, activeLayerId: doc.activeLayerId };
          break;
        }
        case 'canvas.fill': {
          coordinate(doc, action.x, action.y);
          const tolerance = action.tolerance ?? 0;
          integer(tolerance, 'tolerance');
          if (tolerance < 0 || tolerance > 255) throw new RangeError('Tolerance must be between 0 and 255.');
          const contiguous = action.contiguous ?? true;
          if (typeof contiguous !== 'boolean') throw new TypeError('contiguous must be a boolean.');
          const pattern = action.pattern ?? 'solid';
          if (!['solid', 'checker'].includes(pattern)) throw new TypeError('pattern must be solid or checker.');
          const secondaryColor = color(action.secondaryColor ?? '#FFFFFF', 'secondaryColor');
          const scale = action.scale ?? 1;
          integer(scale, 'scale');
          if (scale < 1 || scale > 16) throw new RangeError('Dither scale must be between 1 and 16.');
          result = { changedPixels: doc.fillAt(action.x, action.y, {
            color: color(action.color), tolerance, contiguous, pattern, secondaryColor, scale,
          }), pattern, scale };
          break;
        }
        case 'canvas.erase_pixel': {
          coordinate(doc, action.x, action.y);
          const size = action.size ?? 1;
          integer(size, 'size');
          if (size < 1 || size > 128) throw new RangeError('Erase size must be between 1 and 128 pixels.');
          const stroke = doc.beginStroke({ size, opacity: action.opacity ?? 1, hardness: action.hardness ?? 1, shape: action.shape ?? 'square', mode: 'erase' });
          try {
            doc.strokeTo(stroke, action.x, action.y);
            result = { changed: doc.endStroke(stroke), mode: 'pixel', x: action.x, y: action.y, size };
          } catch (error) {
            doc.endStroke(stroke, { commit: false });
            throw error;
          }
          break;
        }
        case 'canvas.erase_line': {
          coordinate(doc, action.x0, action.y0); coordinate(doc, action.x1, action.y1);
          const size = action.size ?? 1;
          integer(size, 'size');
          if (size < 1 || size > 128) throw new RangeError('Erase size must be between 1 and 128 pixels.');
          const stroke = doc.beginStroke({ size, opacity: action.opacity ?? 1, hardness: action.hardness ?? 1, shape: action.shape ?? 'square', mode: 'erase' });
          try {
            doc.strokeTo(stroke, action.x0, action.y0);
            doc.strokeTo(stroke, action.x1, action.y1);
            result = { changed: doc.endStroke(stroke), mode: 'line', bounds: { x: Math.min(action.x0, action.x1), y: Math.min(action.y0, action.y1), width: Math.abs(action.x1 - action.x0) + 1, height: Math.abs(action.y1 - action.y0) + 1 } };
          } catch (error) {
            doc.endStroke(stroke, { commit: false });
            throw error;
          }
          break;
        }
        case 'canvas.erase_direction': {
          coordinate(doc, action.x, action.y);
          const length = integer(action.length, 'length');
          const angle = Number(action.angleDeg ?? 0) * Math.PI / 180;
          const endX = Math.round(action.x + Math.cos(angle) * Math.max(0, length - 1));
          const endY = Math.round(action.y + Math.sin(angle) * Math.max(0, length - 1));
          coordinate(doc, endX, endY);
          const size = action.size ?? 1;
          integer(size, 'size');
          if (size < 1 || size > 128) throw new RangeError('Erase size must be between 1 and 128 pixels.');
          const stroke = doc.beginStroke({ size, opacity: action.opacity ?? 1, hardness: action.hardness ?? 1, shape: action.shape ?? 'square', mode: 'erase' });
          try {
            doc.strokeTo(stroke, action.x, action.y);
            doc.strokeTo(stroke, endX, endY);
            result = { changed: doc.endStroke(stroke), mode: 'direction', start: { x: action.x, y: action.y }, end: { x: endX, y: endY }, angleDeg: Number(action.angleDeg ?? 0), length };
          } catch (error) {
            doc.endStroke(stroke, { commit: false });
            throw error;
          }
          break;
        }
        case 'canvas.erase_region':
          rectangle(doc, action.x, action.y, action.width, action.height);
          result = { changedPixels: doc.clearRect(action.x, action.y, action.width, action.height), mode: 'region' };
          break;
                  rectangle(doc, action.x, action.y, action.width, action.height);
          result = { changedPixels: doc.clearRect(action.x, action.y, action.width, action.height) };
          break;
        case 'canvas.copy_region': {
          rectangle(doc, action.x, action.y, action.width, action.height);
          this.#clipboard = doc.copyRect(action.x, action.y, action.width, action.height);
          result = { copied: true, x: this.#clipboard.x, y: this.#clipboard.y,
            width: this.#clipboard.width, height: this.#clipboard.height,
            selectedPixels: this.#clipboard.mask.reduce((sum, value) => sum + value, 0) };
          break;
        }
        case 'canvas.paste_region': {
          if (!this.#clipboard) throw new Error('There is no copied PixelForge region in this Headless session.');
          const x = integer(action.x ?? this.#clipboard.x, 'x');
          const y = integer(action.y ?? this.#clipboard.y, 'y');
          if (x < -doc.width || y < -doc.height || x > doc.width || y > doc.height) {
            throw new RangeError('Paste position is too far outside the canvas.');
          }
          result = { changedPixels: doc.pasteRect(this.#clipboard, { x, y }), x, y,
            width: this.#clipboard.width, height: this.#clipboard.height };
          break;
        }
        case 'canvas.crop':
          rectangle(doc, action.x, action.y, action.width, action.height);
          result = { changed: doc.cropCanvas(action.x, action.y, action.width, action.height), width: action.width, height: action.height };
          break;
        case 'canvas.draw_shape': {
          const shape = action.shape;
          rectangle(doc, action.x, action.y, action.width, action.height);
          if (!['rectangle', 'ellipse'].includes(shape)) throw new TypeError('shape must be rectangle or ellipse.');
          const size = action.size ?? 1;
          integer(size, 'size');
          if (size < 1 || size > 128) throw new RangeError('Shape stroke size must be between 1 and 128 pixels.');
          let points;
          if (shape === 'rectangle') {
            points = [
              { x: action.x, y: action.y },
              { x: action.x + action.width - 1, y: action.y },
              { x: action.x + action.width - 1, y: action.y + action.height - 1 },
              { x: action.x, y: action.y + action.height - 1 },
              { x: action.x, y: action.y },
            ];
          } else {
            const cx = action.x + (action.width - 1) / 2, cy = action.y + (action.height - 1) / 2;
            const rx = Math.max(0.5, (action.width - 1) / 2), ry = Math.max(0.5, (action.height - 1) / 2);
            const count = Math.min(4096, Math.max(24, Math.ceil(2 * Math.PI * Math.max(rx, ry) * 1.5)));
            points = Array.from({ length: count + 1 }, (_, index) => {
              const angle = index / count * Math.PI * 2;
              return { x: Math.max(action.x, Math.min(action.x + action.width - 1, Math.round(cx + rx * Math.cos(angle)))),
                y: Math.max(action.y, Math.min(action.y + action.height - 1, Math.round(cy + ry * Math.sin(angle)))) };
            });
          }
          const stroke = doc.beginStroke({ color: color(action.color), size });
          try {
            for (const point of points) doc.strokeTo(stroke, point.x, point.y);
            result = { changed: doc.endStroke(stroke), shape, pointCount: points.length };
          } catch (error) {
            doc.endStroke(stroke, { commit: false });
            throw error;
          }
          break;
        }
        case 'canvas.fill_gradient': {
          coordinate(doc, action.x0, action.y0); coordinate(doc, action.x1, action.y1);
          const opacity = action.opacity ?? 1;
          if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new RangeError('Gradient opacity must be between 0 and 1.');
          result = { changedPixels: doc.fillGradient(action.x0, action.y0, action.x1, action.y1, {
            startColor: color(action.startColor, 'startColor'), endColor: color(action.endColor, 'endColor'), opacity
          }) };
          break;
        }
        case 'canvas.flip_region': {
          rectangle(doc, action.x, action.y, action.width, action.height);
          if (!['horizontal', 'vertical'].includes(action.axis)) throw new TypeError('axis must be horizontal or vertical.');
          result = { changedPixels: doc.flipRect(action.x, action.y, action.width, action.height, action.axis) };
          break;
        }
        case 'canvas.create_outline':
          result = { changedPixels: doc.createOutline(color(action.color), { diagonals: action.diagonals !== false }) };
          break;
        case 'canvas.replace_color': {
          const tolerance = action.tolerance ?? 0;
          integer(tolerance, 'tolerance');
          if (tolerance < 0 || tolerance > 255) throw new RangeError('Tolerance must be between 0 and 255.');
          result = { changedPixels: doc.replaceColor(color(action.from, 'from'), color(action.to, 'to'), tolerance) };
          break;
        }
        case 'canvas.preview_transform_region': {
          rectangle(doc, action.x, action.y, action.width, action.height);
          const dx = action.dx ?? 0, dy = action.dy ?? 0, rotate = action.rotate ?? 0;
          const scaleX = action.scaleX ?? 1, scaleY = action.scaleY ?? 1;
          const skewX = action.skewX ?? 0, skewY = action.skewY ?? 0;
          const interpolation = action.interpolation ?? 'nearest';
          integer(dx, 'dx'); integer(dy, 'dy'); integer(rotate, 'rotate');
          if (![0, 90, 180, 270].includes(rotate)) throw new RangeError('rotate must be 0, 90, 180, or 270 degrees.');
          if (![scaleX, scaleY, skewX, skewY].every(Number.isFinite)) throw new TypeError('scaleX, scaleY, skewX and skewY must be finite numbers.');
          if (!['nearest', 'bilinear'].includes(interpolation)) throw new TypeError('interpolation must be nearest or bilinear.');
          const preview = doc.previewTransformRect(action.x, action.y, action.width, action.height, {
            dx, dy, rotate, scaleX, scaleY, skewX, skewY, interpolation,
          });
          result = { selectedPixels: preview.selectedPixels, bounds: preview.bounds,
            rect: preview.rect, options: preview.options };
          break;
        }
        case 'canvas.transform_region': {
          rectangle(doc, action.x, action.y, action.width, action.height);
          const dx = action.dx ?? 0, dy = action.dy ?? 0, rotate = action.rotate ?? 0;
          const scaleX = action.scaleX ?? 1, scaleY = action.scaleY ?? 1;
          const skewX = action.skewX ?? 0, skewY = action.skewY ?? 0;
          const interpolation = action.interpolation ?? 'nearest';
          integer(dx, 'dx'); integer(dy, 'dy'); integer(rotate, 'rotate');
          if (![0, 90, 180, 270].includes(rotate)) throw new RangeError('rotate must be 0, 90, 180, or 270 degrees.');
          if (![scaleX, scaleY, skewX, skewY].every(Number.isFinite)) throw new TypeError('scaleX, scaleY, skewX and skewY must be finite numbers.');
          if (!['nearest', 'bilinear'].includes(interpolation)) throw new TypeError('interpolation must be nearest or bilinear.');
          const transformed = doc.transformRect(action.x, action.y, action.width, action.height, {
            dx, dy, rotate, scaleX, scaleY, skewX, skewY, interpolation,
          });
          result = { changedPixels: transformed.changedPixels, selectedPixels: transformed.selectedPixels, bounds: transformed.bounds };
          break;
        }
        case 'selection.clear': {
          const cleared = Boolean(doc.selectionMask);
          doc.setSelectionMask(null);
          result = { cleared };
          break;
        }
        case 'selection.create_rect': {
          rectangle(doc, action.x, action.y, action.width, action.height);
          const mask = new Uint8Array(doc.width * doc.height);
          for (let y = action.y; y < action.y + action.height; y++) {
            mask.fill(1, y * doc.width + action.x, y * doc.width + action.x + action.width);
          }
          doc.setSelectionMask(mask);
          result = { x: action.x, y: action.y, width: action.width, height: action.height, selectedPixels: action.width * action.height };
          break;
        }
        case 'selection.create_ellipse':
        case 'selection.create_lasso': {
          rectangle(doc, action.x, action.y, action.width, action.height);
          const selection = action.name === 'selection.create_ellipse'
            ? { x: action.x, y: action.y, width: action.width, height: action.height, shape: 'ellipse' }
            : { x: action.x, y: action.y, width: action.width, height: action.height, shape: 'polygon', points: action.points };
          const mask = createSelectionMask(doc.width, doc.height, selection);
          doc.setSelectionMask(mask);
          result = { x: action.x, y: action.y, width: action.width, height: action.height, selectedPixels: mask.reduce((sum, value) => sum + value, 0) };
          break;
        }
        case 'selection.create_magic': {
          coordinate(doc, action.x, action.y);
          const tolerance = action.tolerance ?? 0;
          integer(tolerance, 'tolerance');
          if (tolerance < 0 || tolerance > 255) throw new RangeError('Color-selection tolerance must be between 0 and 255.');
          const contiguous = action.contiguous ?? true;
          if (typeof contiguous !== 'boolean') throw new TypeError('contiguous must be a boolean.');
          const operation = action.operation ?? 'replace';
          if (!['replace', 'add', 'subtract', 'intersect'].includes(operation)) throw new TypeError('Selection operation must be replace, add, subtract, or intersect.');
          const nextMask = createColorSelectionMask(doc.width, doc.height, doc.activeLayer.pixels, action.x, action.y, { tolerance, contiguous });
          const mask = combineSelectionMasks(doc.width, doc.height, doc.selectionMask, nextMask, operation);
          doc.setSelectionMask(mask);
          result = { operation, tolerance, contiguous, selectedPixels: mask.reduce((sum, value) => sum + value, 0) };
          break;
        }
        case 'selection.modify': {
          const operation = action.operation;
          const current = doc.selectionMask;
          if (!current) throw new Error('There is no active selection to modify.');
          const mask = modifySelectionMask(doc.width, doc.height, current, operation, action.radius ?? 1);
          doc.setSelectionMask(mask);
          result = { operation, selectedPixels: mask.reduce((sum, value) => sum + value, 0) };
          break;
        }
        case 'selection.combine': {
          const operation = action.operation ?? 'replace';
          const nextMask = action.selection === null ? null : createSelectionMask(doc.width, doc.height, action.selection);
          const mask = combineSelectionMasks(doc.width, doc.height, doc.selectionMask, nextMask, operation);
          doc.setSelectionMask(mask);
          result = { operation, selectedPixels: mask ? mask.reduce((sum, value) => sum + value, 0) : 0 };
          break;
        }
        case 'selection.translate': {
          if (!doc.selectionMask) throw new Error('There is no active selection to translate.');
          const dx = integer(action.dx, 'dx'), dy = integer(action.dy, 'dy');
          const mask = translateSelectionMask(doc.width, doc.height, doc.selectionMask, dx, dy);
          doc.setSelectionMask(mask);
          result = { dx, dy, selectedPixels: mask.reduce((sum, value) => sum + value, 0) };
          break;
        }
        case 'history.undo':
          result = { changed: doc.undo() };
          break;
        case 'history.redo':
          result = { changed: doc.redo() };
          break;
        case 'pixelforge.validate': {
          const project = action.project || doc.toJSON();
          result = validatePixelForgeProject(project, { tolerance: action.tolerance ?? 2 });
          if (action.failOnError !== false && !result.ok) result.message = formatValidationFailure(result);
          break;
        }
        case 'vector.validate': {
          const model = action.model || doc.getVectorModel();
          result = validateVectorModel(model, { width: doc.width, height: doc.height, tolerance: action.tolerance ?? 2 });
          if (action.failOnError !== false && !result.ok) result.message = formatValidationFailure(result);
          break;
        }
        case 'vector.audit': {
          const model = doc.getVectorModel() || { version: 5, width: doc.width, height: doc.height, objects: [], precision: { tolerance: 0.001, constraints: [] } };
          const issues = [];
          const precisionAudit = model.precision?.constraints?.length
            ? constraintAudit(model.objects || [], model.precision.constraints, action.tolerance ?? model.precision?.tolerance ?? 0.001)
            : { ok: true, counts: {}, diagnostics: [] };
          for (const item of precisionAudit.diagnostics || []) {
            if (item.status === 'unsatisfied') issues.push({ code: 'constraint_unsatisfied', severity: 'error', message: 'Precision constraint is unsatisfied.', constraint: item.constraint });
            if (item.status === 'missing_reference') issues.push({ code: 'constraint_missing_reference', severity: 'error', message: 'Precision constraint references missing geometry.', constraint: item.constraint });
          }
          const objects = model.objects || [];
          const bounds = o => o.type === 'line'
            ? { x: Math.min(o.x1,o.x2), y: Math.min(o.y1,o.y2), width: Math.abs(o.x2-o.x1), height: Math.abs(o.y2-o.y1) }
            : { x:o.x||0, y:o.y||0, width:o.width||0, height:o.height||0 };
          for (const o of objects) {
            const b = bounds(o);
            if (!o.id) issues.push({code:'missing_id',severity:'error',message:'Object has no id.'});
            if (![b.x,b.y,b.width,b.height].every(Number.isFinite)) issues.push({code:'invalid_geometry',severity:'error',objectId:o.id,message:'Non-finite geometry.'});
            if (b.x < -2 || b.y < -2 || b.x+b.width > model.width+2 || b.y+b.height > model.height+2)
              issues.push({code:'out_of_bounds',severity:'warning',objectId:o.id,message:'Object exceeds document bounds.'});
            if (o.type === 'path' && (!o.points || o.points.length < 2))
              issues.push({code:'empty_path',severity:'error',objectId:o.id,message:'Path needs at least two points.'});
          }
          result = {ok:!issues.some(i=>i.severity==='error'),score:Math.max(0,100-issues.filter(i=>i.severity==='error').length*20-issues.filter(i=>i.severity==='warning').length*5),objectCount:objects.length,issues};
          break;
        }
        case 'geometry.connect': {
          result = connectObjects(action.a, action.b, { tolerance: action.tolerance ?? 0.01, weld: false });
          break;
        }
        case 'geometry.weld': {
          result = connectObjects(action.a, action.b, { tolerance: action.tolerance ?? 0.01, weld: true });
          break;
        }
        case 'geometry.join': {
          result = joinPaths(action.objects || [], { tolerance: action.tolerance ?? 0.01, close: action.close === true });
          break;
        }
        case 'geometry.merge': {
          const objects = (action.objects || []).map(plainResult);
          if (!objects.length) throw new TypeError('geometry.merge requires objects.');
          if (objects.every(o => ['line','path'].includes(o.type))) result = joinPaths(objects, { tolerance: action.tolerance ?? 0.01, close: action.close === true });
          else result = { object: { id: crypto.randomUUID(), type: 'group', name: action.name || 'Merged group', children: objects, transform: {} } };
          break;
        }
        case 'geometry.closeGap': {
          result = closeGap(action.object, action.endpointIndex ?? 1, action.target);
          break;
        }
        case 'geometry.extendToIntersection': {
          result = extendToIntersection(action.object, action.other);
          break;
        }
        case 'geometry.trimToIntersection': {
          result = trimToIntersection(action.object, action.other, action.keep || 'start');
          break;
        }
        case 'geometry.fillet': {
          result = filletLines(action.a, action.b, action.radius);
          break;
        }
        case 'geometry.chamfer': {
          result = chamferLines(action.a, action.b, action.distance);
          break;
        }
        case 'geometry.offset': {
          result = offsetLine(action.object, action.distance);
          break;
        }
        case 'geometry.snapSmart': {
          result = snapSmart(action.point, action.objects || [], action.tolerance ?? 8);
          break;
        }
        case 'geometry.anchor': {
          result = { point: anchorPoint(action.object, action.anchor || 'center'), anchor: action.anchor || 'center' };
          break;
        }
        case 'geometry.alignToAnchor': {
          result = alignToAnchor(action.object, action.anchor || 'center', action.target);
          break;
        }
        case 'geometry.dimension': {
          result = dimension(action.a, action.b, action.label);
          break;
        }
        case 'geometry.constructionGraph': {
          result = constructionGraph(action.objects || [], action.relations || []);
          break;
        }
        case 'geometry.solveConstraints': {
          result = solveConstraints(action.objects || [], action.constraints || [], { tolerance: action.tolerance ?? 0.001, maxIterations: action.maxIterations ?? 24 });
          break;
        }
        case 'geometry.constraintAudit': {
          result = constraintAudit(action.objects || [], action.constraints || [], action.tolerance ?? 0.001);
          break;
        }
        case 'geometry.continuity': {
          result = continuity(action.a, action.b, action.tolerance ?? 0.001);
          break;
        }
        case 'agent.tools.list': {
          result = { tools: [...buildAgentToolCatalog(), ...buildConnectivityToolCatalog(), ...buildAdvancedPrecisionToolCatalog(), ...[
            'vector.model.get','vector.model.import_svg','vector.object.create','vector.object.update','vector.object.delete','vector.object.duplicate','vector.object.transform','vector.object.reorder','vector.object.mirror','vector.group.create','vector.group.ungroup','vector.align','vector.gradient.set','vector.keyframes.set','vector.snap.set','vector.history.undo','vector.history.redo','vector.model.validate'
          ].map(name => ({ name, description: 'PixelForge vector editing operation available through isolated proposals.' }))] };
          break;
        }
        case 'geometry.precision.get': {
          const model = doc.getVectorModel() || { version: 5, width: doc.width, height: doc.height, objects: [], precision: { tolerance: 0.001, anchors: [], guides: [], constraints: [], constructionGraph: { version: 1, nodes: [], edges: [] } } };
          result = plainResult(model.precision || {});
          break;
        }
        case 'geometry.precision.set': {
          const model = doc.getVectorModel() || { version: 5, width: doc.width, height: doc.height, grid: 8, snap: true, objects: [], frames: [] };
          model.precision = {
            tolerance: Number.isFinite(Number(action.tolerance)) ? Number(action.tolerance) : 0.001,
            anchors: Array.isArray(action.anchors) ? plainResult(action.anchors) : (model.precision?.anchors || []),
            guides: Array.isArray(action.guides) ? plainResult(action.guides) : (model.precision?.guides || []),
            constraints: Array.isArray(action.constraints) ? plainResult(action.constraints) : (model.precision?.constraints || []),
            constructionGraph: action.constructionGraph && typeof action.constructionGraph === 'object'
              ? plainResult(action.constructionGraph)
              : (model.precision?.constructionGraph || { version: 1, nodes: [], edges: [] }),
          };
          doc.setVectorModel(model);
          result = { precision: plainResult(model.precision) };
          break;
        }
        case 'geometry.precision.solve': {
          const model = doc.getVectorModel();
          if (!model) throw new Error('No vector model exists.');
          const solved = solveConstraints(model.objects || [], model.precision?.constraints || [], {
            tolerance: action.tolerance ?? model.precision?.tolerance ?? 0.001,
            maxIterations: action.maxIterations ?? 24,
          });
          model.objects = solved.objects;
          model.precision = { ...(model.precision || {}), constraints: plainResult(model.precision?.constraints || []) };
          doc.setVectorModel(model);
          result = { objects: plainResult(model.objects), diagnostics: plainResult(solved.diagnostics), iterations: solved.iterations };
          break;
        }
        case 'vector.model.get': {
          result = plainResult(doc.getVectorModel() || { version: 1, width: doc.width, height: doc.height, grid: 8, snap: true, objects: [], frames: [] });
          break;
        }
        case 'vector.object.create': {
          const model = doc.getVectorModel() || { version: 1, width: doc.width, height: doc.height, grid: 8, snap: true, objects: [], frames: [] };
          if (!action.object || typeof action.object !== 'object' || Array.isArray(action.object)) throw new TypeError('Vector object must be an object.');
          const object = plainResult(action.object);
          object.id = typeof object.id === 'string' && object.id ? object.id : crypto.randomUUID();
          const allowed = ['rect','ellipse','line','path','text'];
          if (!allowed.includes(object.type)) throw new TypeError('Unsupported vector object type.');
          model.objects.push(object); doc.setVectorModel(model);
          result = { object: plainResult(object), objectCount: model.objects.length };
          break;
        }
        case 'vector.object.update': {
          const model = doc.getVectorModel();
          if (!model) throw new Error('No vector model exists.');
          const index = model.objects.findIndex(item => item.id === action.id);
          if (index < 0) throw new Error('Vector object not found.');
          if (!action.patch || typeof action.patch !== 'object' || Array.isArray(action.patch)) throw new TypeError('Vector patch must be an object.');
          model.objects[index] = { ...model.objects[index], ...plainResult(action.patch), id: model.objects[index].id };
          doc.setVectorModel(model); result = { object: plainResult(model.objects[index]) };
          break;
        }
        case 'vector.object.transform': {
          const model=doc.getVectorModel(); if(!model) throw new Error('No vector model exists.');
          const index=model.objects.findIndex(value=>value.id===action.id); if(index<0) throw new Error('Vector object not found.');
          const item=model.objects[index];
          const center=action.center && Number.isFinite(action.center.x) && Number.isFinite(action.center.y) ? action.center : {x:0,y:0};
          if(action.operation==='translate') model.objects[index]=translateObject(item, Number(action.dx)||0, Number(action.dy)||0);
          else if(action.operation==='scale') model.objects[index]=scaleObject(item, center, Number(action.sx), action.sy===undefined?Number(action.sx):Number(action.sy));
          else if(action.operation==='rotate') model.objects[index]=rotateObject(item, center, Number(action.degrees));
          else throw new TypeError('operation must be translate, scale, or rotate.');
          doc.setVectorModel(model); result={object:plainResult(model.objects[index])}; break;
        }
        case 'vector.object.reorder': {
          const model=doc.getVectorModel(); if(!model) throw new Error('No vector model exists.');
          const index=model.objects.findIndex(value=>value.id===action.id); if(index<0) throw new Error('Vector object not found.');
          const [item]=model.objects.splice(index,1);
          const target=action.position==='back'?0:action.position==='forward'?Math.min(model.objects.length,index+1):action.position==='front'?model.objects.length:action.position==='backward'?Math.max(0,index-1):-1;
          if(target<0) throw new TypeError('position must be front, back, forward, or backward.');
          model.objects.splice(target,0,item); doc.setVectorModel(model); result={order:model.objects.map(value=>value.id)}; break;
        }
        case 'vector.object.delete': {
          const model = doc.getVectorModel();
          if (!model) throw new Error('No vector model exists.');
          const before = model.objects.length;
          model.objects = model.objects.filter(item => item.id !== action.id);
          if (model.objects.length === before) throw new Error('Vector object not found.');
          doc.setVectorModel(model); result = { deleted: action.id, objectCount: model.objects.length };
          break;
        }
        case 'vector.align': {
          const model = doc.getVectorModel();
          if (!model) throw new Error('No vector model exists.');
          const ids = Array.isArray(action.ids) ? action.ids : [];
          const objects = model.objects.filter(item => ids.includes(item.id));
          if (objects.length < 2) throw new Error('At least two vector objects are required.');
          const b = o => o.type === 'line'
            ? { x: Math.min(o.x1,o.x2), y: Math.min(o.y1,o.y2), width: Math.abs(o.x2-o.x1), height: Math.abs(o.y2-o.y1) }
            : { x:o.x||0, y:o.y||0, width:o.width||0, height:o.height||0 };
          const boxes = objects.map(b);
          const left=Math.min(...boxes.map(v=>v.x)), top=Math.min(...boxes.map(v=>v.y));
          const right=Math.max(...boxes.map(v=>v.x+v.width)), bottom=Math.max(...boxes.map(v=>v.y+v.height));
          for (const o of objects) {
            const q=b(o);
            if (action.axis==='left') o.x=left;
            else if (action.axis==='center') o.x=left+(right-left-q.width)/2;
            else if (action.axis==='right') o.x=right-q.width;
            else if (action.axis==='top') o.y=top;
            else if (action.axis==='middle') o.y=top+(bottom-top-q.height)/2;
            else if (action.axis==='bottom') o.y=bottom-q.height;
            else throw new TypeError('axis must be left, center, right, top, middle, or bottom.');
          }
          doc.setVectorModel(model); result = { aligned: ids, axis: action.axis };
          break;
        }

        case 'vector.model.import_svg': {
          if (typeof action.svg !== 'string' || !action.svg.trim()) throw new TypeError('svg source is required.');
          const model = parseSVGToVectorModel(action.svg, doc.width, doc.height);
          doc.setVectorModel(model);
          result = { imported: model.objects.length, model: plainResult(model) };
          break;
        }
        case 'vector.object.duplicate': {
          const model = doc.getVectorModel(); if (!model) throw new Error('No vector model exists.');
          const ids = Array.isArray(action.ids) ? action.ids : [action.id].filter(Boolean);
          const source = model.objects.filter(item => ids.includes(item.id));
          if (!source.length) throw new Error('No matching vector objects found.');
          const dx = Number.isFinite(action.dx) ? action.dx : 8, dy = Number.isFinite(action.dy) ? action.dy : 8;
          const cloneTree = item => {
            const copy = plainResult(item); copy.id = crypto.randomUUID();
            if (Array.isArray(copy.children)) copy.children = copy.children.map(cloneTree);
            if (copy.type === 'line') { copy.x1 += dx; copy.x2 += dx; copy.y1 += dy; copy.y2 += dy; }
            else if (copy.type === 'path') copy.points = (copy.points || []).map(p => ({ ...p, x:p.x+dx, y:p.y+dy, ...(p.c1?{c1:{...p.c1,x:p.c1.x+dx,y:p.c1.y+dy}}:{}), ...(p.c2?{c2:{...p.c2,x:p.c2.x+dx,y:p.c2.y+dy}}:{}) }));
            else { copy.x = (copy.x || 0)+dx; copy.y = (copy.y || 0)+dy; }
            return copy;
          };
          const copies = source.map(cloneTree); model.objects.push(...copies); doc.setVectorModel(model);
          result = { objects: plainResult(copies), objectCount: model.objects.length }; break;
        }
        case 'vector.group.create': {
          const model = doc.getVectorModel(); if (!model) throw new Error('No vector model exists.');
          const ids = Array.isArray(action.ids) ? action.ids : [];
          const children = model.objects.filter(item => ids.includes(item.id));
          if (children.length < 2) throw new Error('At least two objects are required to create a group.');
          const group = { id: typeof action.group_id === 'string' && action.group_id ? action.group_id : crypto.randomUUID(), name: action.group_name || 'Group', type: 'group', children: plainResult(children), transform: {} };
          model.objects = model.objects.filter(item => !ids.includes(item.id)); model.objects.push(group); doc.setVectorModel(model);
          result = { group: plainResult(group), objectCount: model.objects.length }; break;
        }
        case 'vector.group.ungroup': {
          const model = doc.getVectorModel(); if (!model) throw new Error('No vector model exists.');
          const ids = Array.isArray(action.ids) ? action.ids : [action.id].filter(Boolean);
          const groups = model.objects.filter(item => ids.includes(item.id) && item.type === 'group');
          if (!groups.length) throw new Error('No matching groups found.');
          const ungrouped = groups.flatMap(group => plainResult(group.children || []));
          model.objects = model.objects.filter(item => !groups.some(group => group.id === item.id)).concat(ungrouped);
          doc.setVectorModel(model); result = { objects: plainResult(ungrouped), objectCount: model.objects.length }; break;
        }
        case 'vector.object.mirror': {
          const model = doc.getVectorModel(); if (!model) throw new Error('No vector model exists.');
          const ids = Array.isArray(action.ids) ? action.ids : [action.id].filter(Boolean);
          const items = model.objects.filter(item => ids.includes(item.id));
          if (!items.length) throw new Error('No matching vector objects found.');
          const bounds = items.map(item => item.type === 'line' ? {x:Math.min(item.x1,item.x2),width:Math.abs(item.x2-item.x1)} : {x:item.x||0,width:item.width||0});
          const axis = action.axis === 'y' ? 'y' : 'x';
          const values = items.map(item => item.type === 'line' ? {p:Math.min(item.x1,item.x2),size:Math.abs(item.x2-item.x1)} : {p:item.x||0,size:item.width||0});
          const center = Number.isFinite(action.center) ? action.center : (Math.min(...values.map(v=>v.p))+Math.max(...values.map(v=>v.p+v.size)))/2;
          const mirror = item => {
            if (item.type === 'line' && axis==='y') { const y1=2*center-item.y1; item.y1=2*center-item.y2; item.y2=y1; }
            else if (item.type === 'group') { item.children = (item.children||[]).map(child => { const c=plainResult(child); mirror(c); return c; }); }
            else if (item.type === 'line' && axis==='x') { const x1=2*center-item.x1; item.x1=2*center-item.x2; item.x2=x1; }
            else if (item.type === 'path') for (const p of item.points||[]) { const key=axis==='x'?'x':'y'; p[key]=2*center-p[key]; if(p.c1)p.c1[key]=2*center-p.c1[key]; if(p.c2)p.c2[key]=2*center-p.c2[key]; }
            else { const key=axis==='x'?'x':'y', size=axis==='x'?'width':'height'; item[key]=2*center-(item[key]||0)-(item[size]||0); }
          };
          items.forEach(mirror); doc.setVectorModel(model); result = { mirrored: ids, axis, center }; break;
        }
        case 'vector.gradient.set': {
          const model=doc.getVectorModel(); if(!model) throw new Error('No vector model exists.');
          const item=model.objects.find(value=>value.id===action.id); if(!item) throw new Error('Vector object not found.');
          const gradient=action.gradient;
          if(!gradient || !['linear','radial'].includes(gradient.type) || !Array.isArray(gradient.stops) || gradient.stops.length<2) throw new TypeError('A linear or radial gradient with at least two stops is required.');
          item.gradient=plainResult(gradient); doc.setVectorModel(model); result={object:plainResult(item)}; break;
        }
        case 'vector.keyframes.set': {
          const model=doc.getVectorModel(); if(!model) throw new Error('No vector model exists.');
          const item=model.objects.find(value=>value.id===action.id); if(!item) throw new Error('Vector object not found.');
          if(!Array.isArray(action.keyframes)) throw new TypeError('keyframes must be an array.');
          item.keyframes=plainResult(action.keyframes); doc.setVectorModel(model); result={object:plainResult(item)}; break;
        }
        case 'vector.snap.set': {
          const model=doc.getVectorModel() || {version:5,width:doc.width,height:doc.height,grid:8,snap:true,objects:[],frames:[]};
          if(action.enabled !== undefined) model.snap=Boolean(action.enabled);
          if(action.grid !== undefined) { const grid=Number(action.grid); if(!Number.isFinite(grid)||grid<=0) throw new TypeError('grid must be a positive number.'); model.grid=grid; }
          doc.setVectorModel(model); result={snap:model.snap,grid:model.grid}; break;
        }
        case 'vector.history.undo': result={changed:doc.undo(), vectorModel:plainResult(doc.getVectorModel())}; break;
        case 'vector.history.redo': result={changed:doc.redo(), vectorModel:plainResult(doc.getVectorModel())}; break;
        case 'vector.model.validate': {
          const model=doc.getVectorModel(); if(!model) throw new Error('No vector model exists.');
          result=validateVectorModel(model); break;
        }
        default:
          return { ok: false, error: { code: 'unknown_action', message: 'Unsupported AI action: ' + action.name } };
      }
      return { ok: true, action: action.name, result: plainResult(result) };
    } catch (error) {
      return {
        ok: false,
        action: action.name,
        error: {
          code: error instanceof RangeError ? 'out_of_bounds_or_limit' : error instanceof TypeError ? 'invalid_arguments' : 'operation_failed',
          message: error instanceof Error ? error.message : 'The operation failed.',
        },
      };
    }
  }

  isForWorkspace(workspace) { return this.#workspace === workspace; }

  createProposal(summary) {
    return this.#workspace.createProposal(summary);
  }
}


