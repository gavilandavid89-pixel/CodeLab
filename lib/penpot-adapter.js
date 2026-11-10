'use strict';

const crypto = require('crypto');
const path = require('path');
const { unzipSync, strFromU8 } = require('fflate');

const MAX_ARCHIVE_BYTES = 18 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 80 * 1024 * 1024;
const MAX_SHAPES_PER_PAGE = 5000;
const ROOT_ID = '00000000-0000-0000-0000-000000000000';

function readJson(files, name, required = false) {
  const bytes = files[name];
  if (!bytes) {
    if (required) throw new Error('penpot_archive_missing_' + name.replace(/[^a-z0-9]+/gi, '_'));
    return null;
  }
  try { return JSON.parse(strFromU8(bytes)); }
  catch (_) { throw new Error('penpot_archive_invalid_json:' + name); }
}

function field(object, name, fallback) {
  if (!object || typeof object !== 'object') return fallback;
  if (Object.prototype.hasOwnProperty.call(object, name)) return object[name];
  const transitKey = '~:' + name.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
  if (Object.prototype.hasOwnProperty.call(object, transitKey)) return object[transitKey];
  return fallback;
}

function cleanText(value, max = 3000) {
  return typeof value === 'string' ? value.replace(/\u0000/g, '').slice(0, max) : '';
}

function numeric(value, fallback, min = 0, max = 10000) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function extractText(content, depth = 0) {
  if (depth > 12 || content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(item => extractText(item, depth + 1)).join('');
  if (typeof content !== 'object') return '';
  const direct = field(content, 'text', null);
  if (typeof direct === 'string') return direct;
  const children = field(content, 'children', null);
  if (Array.isArray(children)) return children.map(item => extractText(item, depth + 1)).join('');
  return '';
}

function normalizeColor(value, fallback) {
  const color = typeof value === 'string' ? value.trim() : '';
  return /^#[0-9a-f]{3,8}$/i.test(color) ? color : fallback;
}

function shapeFill(shape) {
  const fills = field(shape, 'fills', []);
  if (!Array.isArray(fills) || !fills.length) return 'transparent';
  const first = fills.find(fill => fill && typeof fill === 'object' && field(fill, 'color', field(fill, 'fill-color', null)));
  if (!first) return 'transparent';
  return normalizeColor(field(first, 'color', field(first, 'fill-color', null)), 'transparent');
}

function mapShape(shape, frame, order, assetUrls) {
  const rawType = String(field(shape, 'type', 'rect')).replace(/^~:/, '').toLowerCase();
  const type = rawType === 'text' ? (numeric(field(shape, 'fontSize', 16), 16, 8, 240) >= 26 ? 'heading' : 'text')
    : rawType === 'rect' ? 'rectangle'
    : rawType === 'circle' || rawType === 'ellipse' ? 'ellipse'
    : rawType === 'image' ? 'image'
    : rawType === 'path' || rawType === 'svg-raw' || rawType === 'bool' ? 'rectangle'
    : null;
  if (!type) return null;
  const id = cleanText(field(shape, 'id', ''), 100);
  if (!id) return null;
  const x = numeric(field(shape, 'x', 0), 0) - numeric(field(frame, 'x', 0), 0);
  const y = numeric(field(shape, 'y', 0), 0) - numeric(field(frame, 'y', 0), 0);
  const width = numeric(field(shape, 'width', field(field(shape, 'selrect', {}), 'width', 120)), 120, 1, 10000);
  const height = numeric(field(shape, 'height', field(field(shape, 'selrect', {}), 'height', 48)), 48, 1, 10000);
  const content = extractText(field(shape, 'content', ''));
  const fills = field(shape, 'fills', []);
  const textFill = Array.isArray(fills) && fills[0] ? field(fills[0], 'color', null) : null;
  const fontSize = numeric(field(shape, 'fontSize', 16), 16, 8, 240);
  const interactions = field(shape, 'interactions', []);
  return {
    id: 'penpot_' + id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 88),
    type,
    label: cleanText(field(shape, 'name', 'Capa ' + (order + 1)), 120) || 'Capa ' + (order + 1),
    text: type === 'text' || type === 'heading' ? cleanText(content || field(shape, 'name', ''), 3000) : '',
    x, y, width, height,
    color: normalizeColor(textFill, '#111827'),
    background: shapeFill(shape),
    fontSize,
    weight: numeric(field(shape, 'fontWeight', 400), 400, 100, 900),
    radius: numeric(field(shape, 'r1', 0), 0, 0, 500),
    textAlign: ['left', 'center', 'right'].includes(field(shape, 'textAlign', 'left')) ? field(shape, 'textAlign', 'left') : 'left',
    ...(type === 'image' ? { src: assetUrls && assetUrls.get(cleanText(field(field(shape, 'metadata', {}), 'id', field(shape, 'mediaId', '')), 100)) || '', alt: cleanText(field(shape, 'name', 'Imagen'), 300), objectFit: 'cover' } : {}),
    penpotSource: { shapeId: id, shapeType: rawType, interactions: Array.isArray(interactions) ? interactions.slice(0, 20) : [] }
  };
}

function destinationFromInteraction(interaction) {
  if (!interaction || typeof interaction !== 'object') return '';
  const candidates = ['destination', 'destinationId', 'destination-id', 'destinationFrameId', 'destination-frame-id', 'target', 'targetId', 'target-id', 'frameId', 'frame-id'];
  for (const key of candidates) {
    const value = field(interaction, key, null);
    if (typeof value === 'string' && value) return value.replace(/^~u/, '');
    if (value && typeof value === 'object') {
      const nested = field(value, 'id', field(value, 'frameId', null));
      if (typeof nested === 'string' && nested) return nested.replace(/^~u/, '');
    }
  }
  return '';
}

function preflightZip(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const min = Math.max(0, bytes.length - 65557);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= min; i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('penpot_archive_invalid_zip');
  const entries = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (!entries || entries > 10000 || centralOffset + centralSize > eocd) throw new Error('penpot_archive_directory_invalid');
  let cursor = centralOffset;
  let total = 0;
  for (let i = 0; i < entries; i++) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('penpot_archive_directory_invalid');
    const uncompressed = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    if (uncompressed === 0xffffffff) throw new Error('penpot_archive_zip64_not_supported');
    total += uncompressed;
    if (total > MAX_UNCOMPRESSED_BYTES) throw new Error('penpot_archive_uncompressed_too_large');
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor > centralOffset + centralSize) throw new Error('penpot_archive_directory_invalid');
}

function safeArchiveEntries(input) {
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) throw new Error('penpot_archive_buffer_required');
  if (input.byteLength < 22 || input.byteLength > MAX_ARCHIVE_BYTES) throw new Error('penpot_archive_size_invalid');
  preflightZip(input);
  let entries;
  try { entries = unzipSync(new Uint8Array(input)); }
  catch (_) { throw new Error('penpot_archive_invalid_zip'); }
  const normalized = Object.create(null);
  let total = 0;
  for (const [rawName, bytes] of Object.entries(entries)) {
    const name = path.posix.normalize(String(rawName).replace(/\\/g, '/'));
    if (name.startsWith('../') || name.startsWith('/') || name.includes('/../')) throw new Error('penpot_archive_path_invalid');
    if (name.endsWith('/')) continue;
    total += bytes.byteLength;
    if (total > MAX_UNCOMPRESSED_BYTES) throw new Error('penpot_archive_uncompressed_too_large');
    normalized[name] = bytes;
  }
  return normalized;
}

function parsePenpotArchive(input) {
  const files = safeArchiveEntries(input);
  const manifest = readJson(files, 'manifest.json', true);
  if (!manifest || manifest.type !== 'penpot/export-files' || manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error('penpot_manifest_unsupported');
  }
  if (manifest.files.length !== 1) throw new Error('penpot_archive_multiple_files_not_supported');
  const entry = manifest.files[0];
  const fileId = cleanText(entry.id, 80);
  if (!fileId || !/^[a-zA-Z0-9_-]+$/.test(fileId)) throw new Error('penpot_file_id_invalid');
  const prefix = 'files/' + fileId + '/';
  const metadata = readJson(files, 'files/' + fileId + '.json', true);
  const pagePaths = Object.keys(files).filter(name => name.startsWith(prefix + 'pages/') && name.endsWith('.json') && !name.slice((prefix + 'pages/').length).includes('/'));
  if (!pagePaths.length) throw new Error('penpot_file_has_no_pages');
  const tokens = readJson(files, prefix + 'tokens.json', false);
  if (tokens && Buffer.byteLength(JSON.stringify(tokens), 'utf8') > 1024 * 1024) throw new Error('penpot_tokens_payload_too_large');
  const mediaPaths = Object.keys(files).filter(name => name.startsWith(prefix + 'media/') && name.endsWith('.json'));
  const assets = [];
  let assetBytes = 0;
  for (const mediaPath of mediaPaths) {
    const media = readJson(files, mediaPath, true);
    const mediaId = cleanText(field(media, 'id', path.posix.basename(mediaPath, '.json')), 100).replace(/^~u/, '');
    const storageId = cleanText(field(media, 'mediaId', mediaId), 100).replace(/^~u/, '');
    if (!/^[a-zA-Z0-9_-]+$/.test(mediaId) || !/^[a-zA-Z0-9_-]+$/.test(storageId)) continue;
    const objectMeta = readJson(files, 'objects/' + storageId + '.json', false) || {};
    const binaryPath = Object.keys(files).find(name => name.startsWith('objects/' + storageId + '.') && !name.endsWith('.json'));
    if (!binaryPath) continue;
    const extension = path.posix.extname(binaryPath).slice(1).toLowerCase();
    if (!['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)) continue;
    const bytes = files[binaryPath];
    assetBytes += bytes.byteLength;
    if (assetBytes > 32 * 1024 * 1024) throw new Error('penpot_assets_size_exceeded');
    const contentType = cleanText(field(objectMeta, 'contentType', ''), 100) ||
      ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' })[extension];
    if (!/^image\/(png|jpeg|webp|gif)$/.test(contentType)) continue;
    assets.push({ id: mediaId, storageId, extension, contentType, bytes });
  }
  const pages = pagePaths.map(pagePath => {
    const page = readJson(files, pagePath, true);
    const pageId = cleanText(field(page, 'id', path.posix.basename(pagePath, '.json')), 100);
    const shapePrefix = prefix + 'pages/' + pageId + '/';
    const shapePaths = Object.keys(files).filter(name => name.startsWith(shapePrefix) && name.endsWith('.json') && !name.slice(shapePrefix.length).includes('/'));
    if (shapePaths.length > MAX_SHAPES_PER_PAGE) throw new Error('penpot_page_shape_limit_exceeded');
    const shapes = shapePaths.map(shapePath => readJson(files, shapePath, true));
    return { page, pageId, shapes };
  });
  return { fileId, fileName: cleanText(field(metadata, 'name', entry.name || 'Diseño Penpot'), 200), revision: numeric(field(metadata, 'revn', 0), 0, 0, 100000000), pages, tokens, assets, features: Array.isArray(entry.features) ? entry.features.slice(0, 100) : [] };
}

function mapPenpotArchive(input, options = {}) {
  const parsed = parsePenpotArchive(input);
  const screens = [];
  const shapeToScreen = new Map();
  const assetUrls = new Map(parsed.assets.map(asset => [asset.id,
    options.workspaceId ? '/api/workspace/' + encodeURIComponent(options.workspaceId) + '/penpot/assets/' + encodeURIComponent(parsed.fileId) + '/' + encodeURIComponent(asset.id) : ''
  ]));
  for (const pageEntry of parsed.pages) {
    const { page, pageId, shapes } = pageEntry;
    const byId = new Map(shapes.map(shape => [cleanText(field(shape, 'id', ''), 100), shape]).filter(pair => pair[0]));
    const frames = shapes.filter(shape => String(field(shape, 'type', '')).replace(/^~:/, '') === 'frame' &&
      (!field(shape, 'parentId', field(shape, 'parent-id', null)) || field(shape, 'parentId', field(shape, 'parent-id', null)) === ROOT_ID));
    const screenFrames = frames.length ? frames : [null];
    for (const frame of screenFrames) {
      const frameId = frame ? cleanText(field(frame, 'id', ''), 100) : pageId;
      const frameName = frame ? cleanText(field(frame, 'name', ''), 160) : cleanText(field(page, 'name', ''), 160);
      const frameIds = [];
      const visit = (shapeId, seen) => {
        if (seen.has(shapeId)) return;
        seen.add(shapeId);
        const shape = byId.get(shapeId);
        if (!shape) return;
        const children = field(shape, 'shapes', []);
        if (Array.isArray(children)) {
          children.forEach(childId => visit(String(childId).replace(/^~u/, ''), seen));
        }
        if (shape !== frame && !['frame', 'group'].includes(String(field(shape, 'type', '')).replace(/^~:/, ''))) frameIds.push(shape);
      };
      if (frame) {
        const children = field(frame, 'shapes', []);
        if (Array.isArray(children)) children.forEach(id => visit(String(id).replace(/^~u/, ''), new Set([frameId])));
      } else {
        shapes.filter(shape => field(shape, 'parentId', field(shape, 'parent-id', ROOT_ID)) === ROOT_ID)
          .forEach(shape => visit(cleanText(field(shape, 'id', ''), 100), new Set()));
      }
      const elements = frameIds.map((shape, index) => mapShape(shape, frame, index, assetUrls)).filter(Boolean);
      if (elements.length > 500) throw new Error('penpot_frame_element_limit_exceeded');
      const projectId = options.projectIds && options.projectIds[pageId + ':' + frameId]
        ? options.projectIds[pageId + ':' + frameId]
        : 'penpot_' + crypto.createHash('sha256').update(parsed.fileId + ':' + pageId + ':' + frameId).digest('hex').slice(0, 28);
      const width = numeric(field(frame || page, 'width', 1440), 1440, 1, 10000);
      const height = numeric(field(frame || page, 'height', 900), 900, 1, 10000);
      const bg = shapeFill(frame || page);
      const screen = {
        id: projectId,
        name: (parsed.fileName + ' · ' + (frameName || 'Pantalla')).slice(0, 200),
        type: 'design',
        hasDesignSpace: true,
        hasWebSpace: false,
        code: { html: '', css: '', js: '' },
        design: {
          width, height, canvasWidth: width, canvasHeight: height, frame: width <= 430 ? 'mobile' : width <= 900 ? 'tablet' : 'desktop', background: bg === 'transparent' ? normalizeColor(field(page, 'background', null), '#ffffff') : bg,
          elements, flowConnections: [],
          penpotSource: { fileId: parsed.fileId, pageId, frameId, fileRevision: parsed.revision, features: parsed.features },
          ...(parsed.tokens ? { penpotTokens: parsed.tokens } : {})
        },
        updatedAt: new Date().toISOString()
      };
      screens.push(screen);
      if (screens.length > 50) throw new Error('penpot_screen_limit_exceeded');
      for (const shape of frameIds) shapeToScreen.set(cleanText(field(shape, 'id', ''), 100), { screen, elementId: 'penpot_' + cleanText(field(shape, 'id', ''), 88) });
      if (frame) shapeToScreen.set(frameId, { screen, elementId: null });
    }
  }
  // Prototype links are only emitted when an explicit destination resolves to an imported frame.
  for (const pageEntry of parsed.pages) {
    for (const shape of pageEntry.shapes) {
      const source = shapeToScreen.get(cleanText(field(shape, 'id', ''), 100));
      if (!source || !source.elementId) continue;
      const interactions = field(shape, 'interactions', []);
      if (!Array.isArray(interactions)) continue;
      for (const interaction of interactions.slice(0, 30)) {
        const destination = destinationFromInteraction(interaction);
        const target = shapeToScreen.get(destination);
        if (!target || target.screen.id === source.screen.id) continue;
        source.screen.design.flowConnections.push({
          id: 'penpot_flow_' + crypto.createHash('sha256').update(source.screen.id + ':' + source.elementId + ':' + target.screen.id).digest('hex').slice(0, 20),
          sourceElementId: source.elementId,
          targetProjectId: target.screen.id,
          trigger: cleanText(field(interaction, 'eventType', field(interaction, 'trigger', 'click')), 40) || 'click',
          source: 'penpot'
        });
      }
    }
  }
  return { fileId: parsed.fileId, fileName: parsed.fileName, revision: parsed.revision, screens, tokens: parsed.tokens || null, assets: parsed.assets };
}

module.exports = { parsePenpotArchive, mapPenpotArchive, MAX_ARCHIVE_BYTES, MAX_UNCOMPRESSED_BYTES };
