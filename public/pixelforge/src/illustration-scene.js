/**
 * Semantic illustration scene model.
 *
 * The assistant describes WHAT is being drawn (composition, subject anatomy,
 * clothing, props and lighting). The headless editor receives this structured
 * scene and compiles it into allowlisted raster actions.
 *
 * This is deliberately provider-independent: no model call, no image
 * generation, and no pixel-level "guessing" are hidden inside this module.
 */

export const SCENE_NODE_TYPES = Object.freeze([
  'background',
  'body',
  'head',
  'limb',
  'clothing',
  'prop',
  'light',
  'shadow',
  'detail',
]);

export const BODY_PARTS = Object.freeze([
  'head',
  'neck',
  'torso',
  'left_shoulder',
  'right_shoulder',
  'left_elbow',
  'right_elbow',
  'left_hand',
  'right_hand',
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
  'left_foot',
  'right_foot',
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function finite(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new TypeError(label + ' must be finite.');
  return n;
}

function point(value, label) {
  if (!value || typeof value !== 'object') throw new TypeError(label + ' must be a point.');
  return { x: finite(value.x, label + '.x'), y: finite(value.y, label + '.y') };
}

function normalizeNode(node, index) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    throw new TypeError('scene.nodes[' + index + '] must be an object.');
  }
  if (!SCENE_NODE_TYPES.includes(node.type)) {
    throw new RangeError('Unsupported scene node type: ' + node.type);
  }
  if (typeof node.id !== 'string' || !node.id) throw new TypeError('scene.nodes[' + index + '].id is required.');

  const normalized = {
    id: node.id,
    type: node.type,
    name: String(node.name || node.id).slice(0, 120),
    layer: String(node.layer || node.type).slice(0, 120),
    visible: node.visible !== false,
    z: Number.isFinite(Number(node.z)) ? Number(node.z) : index,
    geometry: {},
    style: clone(node.style || {}),
    metadata: clone(node.metadata || {}),
  };

  if (node.geometry) {
    for (const [key, value] of Object.entries(node.geometry)) {
      if (key === 'points' && Array.isArray(value)) {
        normalized.geometry.points = value.map((p, i) => point(p, 'scene.nodes[' + index + '].geometry.points[' + i + ']'));
      } else if (['center', 'start', 'end', 'pivot'].includes(key)) {
        normalized.geometry[key] = point(value, 'scene.nodes[' + index + '].geometry.' + key);
      } else if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
        normalized.geometry[key] = value;
      } else {
        normalized.geometry[key] = clone(value);
      }
    }
  }

  return normalized;
}

export function normalizeIllustrationScene(scene) {
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) {
    throw new TypeError('scene must be an object.');
  }
  const canvas = scene.canvas || {};
  const width = Math.round(finite(canvas.width, 'scene.canvas.width'));
  const height = Math.round(finite(canvas.height, 'scene.canvas.height'));
  if (width < 1 || height < 1 || width > 4096 || height > 4096) {
    throw new RangeError('Scene canvas must be between 1 and 4096 pixels.');
  }

  const nodes = Array.isArray(scene.nodes) ? scene.nodes.map(normalizeNode) : [];
  const ids = new Set();
  for (const node of nodes) {
    if (ids.has(node.id)) throw new Error('Duplicate scene node id: ' + node.id);
    ids.add(node.id);
  }

  return {
    version: 1,
    canvas: { width, height },
    intent: String(scene.intent || '').slice(0, 2000),
    composition: clone(scene.composition || {}),
    nodes: nodes.sort((a, b) => a.z - b.z),
    lighting: clone(scene.lighting || {}),
    palette: clone(scene.palette || {}),
    constraints: clone(scene.constraints || {}),
    pose: clone(scene.pose || {}),
  };
}

export function validateIllustrationScene(scene) {
  const normalized = normalizeIllustrationScene(scene);
  const errors = [];

  const bodyNodes = normalized.nodes.filter(n => n.type === 'body' || n.type === 'head' || n.type === 'limb');
  if (bodyNodes.length === 0) errors.push('Scene has no anatomical/body structure.');

  const hasHead = normalized.nodes.some(n => n.type === 'head' || n.metadata?.bodyPart === 'head');
  const hasTorso = normalized.nodes.some(n => n.metadata?.bodyPart === 'torso');
  if (!hasHead) errors.push('Scene has no head anchor.');
  if (!hasTorso) errors.push('Scene has no torso anchor.');

  const pose = normalized.pose;
  if (pose && typeof pose === 'object' && pose.anchors) {
    for (const [part, value] of Object.entries(pose.anchors)) {
      if (!BODY_PARTS.includes(part)) errors.push('Unknown pose anchor: ' + part);
      else {
        try { point(value, 'pose.anchors.' + part); } catch (error) { errors.push(error.message); }
      }
    }
  }

  const motion = normalized.constraints?.motion;
  if (motion && typeof motion === 'object') {
    if (motion.primaryAxis && !['x', 'y', 'both'].includes(motion.primaryAxis)) {
      errors.push('constraints.motion.primaryAxis must be x, y, or both.');
    }
    if (motion.preserve && !Array.isArray(motion.preserve)) {
      errors.push('constraints.motion.preserve must be an array.');
    }
  }

  return { ok: errors.length === 0, errors, scene: normalized };
}

export function compileIllustrationScene(scene) {
  const { ok, errors, scene: normalized } = validateIllustrationScene(scene);
  if (!ok) throw new Error('Cannot compile invalid illustration scene: ' + errors.join(' '));

  const actions = [];
  for (const node of normalized.nodes) {
    if (node.visible === false) continue;
    const g = node.geometry;
    const style = node.style || {};
    const color = style.color || normalized.palette?.[node.type] || '#FFFFFF';
    const width = Math.max(1, Math.round(Number(style.width ?? 1)));

    if (g.start && g.end) {
      actions.push({
        name: 'canvas.draw_line',
        x0: Math.round(g.start.x), y0: Math.round(g.start.y),
        x1: Math.round(g.end.x), y1: Math.round(g.end.y),
        color, size: width,
      });
      continue;
    }

    if (Array.isArray(g.points) && g.points.length >= 2) {
      actions.push({
        name: 'canvas.draw_stroke',
        points: g.points.map(point => ({ x: Math.round(point.x), y: Math.round(point.y) })),
        color, size: width, opacity: Number(style.opacity ?? 1),
        hardness: Number(style.hardness ?? 1),
      });
      continue;
    }

    if (g.center && Number.isFinite(Number(g.rx)) && Number.isFinite(Number(g.ry))) {
      actions.push({
        name: 'canvas.draw_shape',
        shape: 'ellipse',
        x: Math.round(g.center.x - Number(g.rx)),
        y: Math.round(g.center.y - Number(g.ry)),
        width: Math.max(1, Math.round(Number(g.rx) * 2 + 1)),
        height: Math.max(1, Math.round(Number(g.ry) * 2 + 1)),
        color,
        fill: style.fill !== false,
      });
      continue;
    }

    if (g.x !== undefined && g.y !== undefined && g.width !== undefined && g.height !== undefined) {
      actions.push({
        name: 'canvas.draw_shape',
        shape: style.shape || 'rectangle',
        x: Math.round(Number(g.x)), y: Math.round(Number(g.y)),
        width: Math.max(1, Math.round(Number(g.width))),
        height: Math.max(1, Math.round(Number(g.height))),
        color,
        fill: style.fill !== false,
      });
    }
  }

  return {
    scene: normalized,
    actions,
    actionCount: actions.length,
    compilation: {
      mode: 'semantic-to-raster',
      sourceOfTruth: 'illustration-scene',
      preservesNodeOrder: true,
      noImageGeneration: true,
    },
  };
}

export function createIllustrationScene({ width, height, intent = '' } = {}) {
  return normalizeIllustrationScene({ canvas: { width, height }, intent, nodes: [] });
}
