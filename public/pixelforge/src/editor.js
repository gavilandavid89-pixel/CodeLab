import { RasterDocument, screenToDocument, validateDimensions, rasterLinePoints, createSelectionMask, createColorSelectionMask, modifySelectionMask, combineSelectionMasks, translateSelectionMask } from './core.js';
import { loadMostRecentProject, saveProject, listSavedProjects, loadProjectById } from './persistence.js';
import { preflightImageFile } from './image-import.js';
import { createSpriteSheetLayout } from './asset-export.js';
import { AIWorkspace } from './workspaces.js';
import { AICommandSession } from './ai-tools.js';
import { AIEditCoordinator, OpenAICompatibleProvider } from './ai-provider.js';

const $ = selector => document.querySelector(selector);
const canvas = $('#canvas'), ctx = canvas.getContext('2d', { alpha: true });
const workArea = $('#work-area');
const previewCanvas = document.createElement('canvas'), previewCtx = previewCanvas.getContext('2d', { alpha: true });
const transformPreviewCanvas = document.createElement('canvas'), transformPreviewCtx = transformPreviewCanvas.getContext('2d', { alpha: true });
let doc = new RasterDocument(128, 128), aiWorkspace = new AIWorkspace(doc), tool = 'draw', spaceDown = false;
let aiCommandSession = new AICommandSession(aiWorkspace), aiProvider = null, aiCoordinator = null, activeAIRequestController = null;
let aiPanelVisible = false;
let color = $('#color').value, backgroundColor = '#242632', recentColors = [], brushSize = Number($('#brush-size').value);
let fillTolerance = 0, fillContiguous = true, sampleMerged = true, returnTool = 'draw';
let zoom = 3, panX = 0, panY = 0, activeStroke = null, pointerId = null, gridEnabled = false;
let drawHeld = false, drawHoldPointerId = null;
let selection = null, selectionStart = null, selectionPointerId = null, pixelClipboard = null;
let transformPreview = null, cropPreview = null;
let shapeGesture = null, gradientGesture = null, symmetryMode = 0;
let cursorMode = false, cursorGesturePointerId = null, cursorGestureLast = null, cursorGestureOrigin = null, cursorGestureStartedOnControl = false, cursorGestureControlTarget = null, cursorGestureSuppressClick = false, cursorDrawPointerId = null;
let virtualCursorPointerId = null, virtualCursorScreen = null, virtualCursorPoint = null, virtualCursorVisible = false, virtualCursorCanDraw = false;
let panning = false, panStart = null, autosaveTimer = null, autosaveInFlight = Promise.resolve(), flushInProgress = false, flushPromise = null, renderQueued = false, previewReady = false;

function loadUserPalette() {
  try {
    const parsed = JSON.parse(localStorage.getItem('pixelforge.palette.v1') || '[]');
    return Array.isArray(parsed) ? [...new Set(parsed.filter(value => typeof value === 'string' && /^#[0-9A-F]{6}$/i.test(value)).map(value => value.toUpperCase()))].slice(0, 64) : [];
  } catch { return []; }
}
let userPalette = loadUserPalette();
function saveUserPalette() {
  try { localStorage.setItem('pixelforge.palette.v1', JSON.stringify(userPalette)); }
  catch { status('Palette could not be saved in this browser storage', 'warning'); }
}
function renderUserPalette() {
  const host = $('#user-palette'); if (!host) return;
  host.replaceChildren();
  userPalette.forEach((value, index) => {
    const item = document.createElement('div'); item.className = 'palette-item';
    const swatch = document.createElement('button'); swatch.type = 'button'; swatch.className = 'palette-swatch';
    swatch.style.setProperty('--swatch', value); swatch.title = value; swatch.setAttribute('aria-label', `Use palette color ${value}`);
    swatch.addEventListener('click', () => applyForegroundColor(value));
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'palette-remove'; remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove palette color ${value}`); remove.addEventListener('click', () => {
      userPalette = userPalette.filter((_, i) => i !== index); saveUserPalette(); renderUserPalette();
    });
    item.append(swatch, remove); host.append(item);
  });
}
function parsePaletteText(text) {
  const colors = [];
  for (const line of text.split(/\r?\n/)) {
    const hex = line.match(/#([0-9a-f]{6})\b/i);
    if (hex) { colors.push(`#${hex[1].toUpperCase()}`); continue; }
    const rgb = line.trim().match(/^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})(?:\s|$)/);
    if (rgb) {
      const values = rgb.slice(1, 4).map(Number);
      if (values.every(value => value >= 0 && value <= 255)) colors.push('#' + values.map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase());
    }
  }
  return [...new Set(colors)].slice(0, 64);
}
$('#palette-add').addEventListener('click', () => {
  if (userPalette.includes(color.toUpperCase())) { status('That color is already in the palette', 'neutral'); return; }
  if (userPalette.length >= 64) { status('Palette limit reached (64 colors)', 'warning'); return; }
  userPalette.push(color.toUpperCase()); saveUserPalette(); renderUserPalette(); status('Color added to local palette', 'success');
});
$('#palette-import').addEventListener('click', () => $('#palette-file').click());
$('#palette-file').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file) return;
  try {
    const imported = parsePaletteText(await file.text());
    if (!imported.length) throw new Error('No valid RGB or six-digit hex colors found.');
    userPalette = [...new Set([...userPalette, ...imported])].slice(0, 64);
    saveUserPalette(); renderUserPalette(); status(`Imported ${imported.length} palette colors`, 'success');
  } catch (error) { status(`Palette import failed: ${error.message}`, 'error'); }
  finally { event.target.value = ''; }
});
$('#palette-export').addEventListener('click', () => {
  const lines = ['GIMP Palette', 'Name: PixelForge Local Palette', 'Columns: 8', '#'];
  for (const value of userPalette) {
    const rgb = value.slice(1).match(/../g).map(part => parseInt(part, 16));
    lines.push(`${rgb[0]} ${rgb[1]} ${rgb[2]} ${value}`);
  }
  downloadBlob(new Blob([lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' }), 'pixelforge-palette.gpl');
  status('Palette exported as GPL', 'success');
});
renderUserPalette();

function rememberColor(value) {
  const normalized = String(value).toUpperCase();
  recentColors = [normalized, ...recentColors.filter(item => item !== normalized)].slice(0, 8);
  const host = $('#recent-colors');
  if (host) {
    host.replaceChildren();
    for (const recent of recentColors) {
      const button = document.createElement('button');
      button.type = 'button'; button.style.setProperty('--swatch', recent); button.dataset.recentColor = recent;
      button.setAttribute('aria-label', `Use recent color ${recent}`); button.title = recent;
      button.addEventListener('click', () => applyForegroundColor(recent));
      host.append(button);
    }
  }
}
function applyForegroundColor(value) {
  color = value.toUpperCase(); $('#color').value = color; $('#color-value').textContent = color;
  rememberColor(color);
  if (tool === 'erase') setTool('draw');
}
function syncBackgroundColor() {
  const swatch = $('#background-swatch');
  if (swatch) { swatch.style.background = backgroundColor; swatch.title = backgroundColor; }
}
function status(message, kind = 'neutral') {
  $('#status').textContent = message;
  $('#status').dataset.kind = kind;
}
function updateAIWorkspaceUI() {
  const state = $('#ai-workspace-state');
  const dot = document.querySelector('.ai-state-dot');
  const summary = aiWorkspace.proposalSummary;
  const sourceStale = Boolean(summary?.stale);
  if (summary) {
    $('#ai-proposal-summary').textContent = sourceStale
      ? 'The original canvas changed after this proposal was created. Sync or discard it before applying.'
      : summary.sandboxStale
        ? 'The sandbox changed after this proposal was captured. Discard it and prepare a new proposal.'
        : summary.summary;
    $('#ai-accept-proposal').disabled = sourceStale || summary.sandboxStale;
    $('#ai-discard-proposal').disabled = false;
    $('#ai-discard-proposal').textContent = '× Discard proposal';
    state.textContent = sourceStale ? 'Proposal is out of date' : summary.sandboxStale ? 'Proposal snapshot changed' : 'Proposal ready for review';
    dot.dataset.kind = sourceStale || summary.sandboxStale ? 'warning' : 'success';
  } else if (aiWorkspace.hasSandboxChanges) {
    $('#ai-proposal-summary').textContent = 'The isolated AI canvas contains edits that have not been captured as a proposal. Keep working or discard this draft before syncing.';
    $('#ai-accept-proposal').disabled = true;
    $('#ai-discard-proposal').disabled = false;
    $('#ai-discard-proposal').textContent = '× Discard AI draft';
    state.textContent = 'AI draft needs review';
    dot.dataset.kind = 'warning';
  } else {
    $('#ai-proposal-summary').textContent = 'No proposal to review yet.';
    $('#ai-accept-proposal').disabled = true;
    $('#ai-discard-proposal').disabled = true;
    $('#ai-discard-proposal').textContent = '× Discard proposal';
    state.textContent = 'Mirroring your canvas';
    dot.dataset.kind = 'success';
  }
  $('#ai-preview-size').textContent = aiWorkspace.sandbox.width + ' × ' + aiWorkspace.sandbox.height + ' px';
}
function renderAIWorkspacePreview() {
  const preview = $('#ai-preview-canvas');
  if (!preview) return;
  const sandbox = aiWorkspace.sandbox;
  if (preview.width !== sandbox.width || preview.height !== sandbox.height) {
    preview.width = sandbox.width; preview.height = sandbox.height;
  }
  const mode = $('#ai-preview-mode').value;
  let pixels, sandboxComposited = false;
  if (mode === 'original') {
    pixels = doc.composite();
    $('#ai-diff-count').textContent = 'Choose Changes only to compare';
  } else if (mode === 'changes') {
    const diff = aiWorkspace.getVisualDiff();
    pixels = diff.pixels;
    sandboxComposited = true;
    $('#ai-diff-count').textContent = diff.changedPixels.toLocaleString() + ' changed pixels';
  } else {
    pixels = sandbox.composite();
    sandboxComposited = true;
    $('#ai-diff-count').textContent = 'Choose Changes only to compare';
  }
  const previewContext = preview.getContext('2d', { alpha: true });
  previewContext.clearRect(0, 0, preview.width, preview.height);
  previewContext.putImageData(new ImageData(new Uint8ClampedArray(pixels), sandbox.width, sandbox.height), 0, 0);
  if (sandboxComposited) sandbox.clearCompositeDirtyTiles();
  updateAIWorkspaceUI();
}
function resetAIWorkspaceForDocument() {
  activeAIRequestController?.abort();
  aiWorkspace = new AIWorkspace(doc);
  aiCommandSession = new AICommandSession(aiWorkspace);
  aiCoordinator = aiProvider ? new AIEditCoordinator({ workspace: aiWorkspace, session: aiCommandSession, provider: aiProvider }) : null;
  updateAIWorkspaceUI();
  if (aiPanelVisible) renderAIWorkspacePreview();
}
function syncAIWorkspaceFromUser() {
  const result = aiWorkspace.syncFromUser();
  if (result.status === 'synced') {
    $('#ai-workspace-state').textContent = 'Mirroring your canvas';
    if (aiPanelVisible) renderAIWorkspacePreview();
    else updateAIWorkspaceUI();
  } else {
    updateAIWorkspaceUI();
  }
}
function updateTitle() {
  $('#document-name').textContent = doc.name;
  $('#document-size').textContent = `${doc.width} × ${doc.height}`;
  $('#layer-count').textContent = `${doc.layers.length} layer${doc.layers.length === 1 ? '' : 's'}`;
  $('#undo').disabled = doc.history.length === 0;
  $('#redo').disabled = doc.future.length === 0;
  $('#save').dataset.dirty = String(doc.dirty);
}
function resizeCanvas() {
  const rect = workArea.getBoundingClientRect(), dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
  render();
}
function fitCanvas() {
  const rect = workArea.getBoundingClientRect();
  const fitScale = Math.min((rect.width - 80) / doc.width, (rect.height - 80) / doc.height);
  zoom = Number.isFinite(fitScale) ? Math.max(.01, Math.min(24, Math.floor(fitScale * 100) / 100)) : 1;
  panX = (rect.width - doc.width * zoom) / 2;
  panY = (rect.height - doc.height * zoom) / 2;
  render();
}
function zoomAt(point, targetZoom) {
  const before = { x: (point.x - panX) / zoom, y: (point.y - panY) / zoom };
  zoom = Math.max(.01, Math.min(24, targetZoom));
  panX = point.x - before.x * zoom; panY = point.y - before.y * zoom;
  render();
}
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (!canvas.width || !canvas.height) return;
    const dpr = canvas.width / Math.max(1, canvas.clientWidth);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#171922'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (previewCanvas.width !== doc.width || previewCanvas.height !== doc.height) {
      previewCanvas.width = doc.width; previewCanvas.height = doc.height; previewReady = false;
    }
    const dirtyTiles = doc.getCompositeDirtyTiles();
    const composite = doc.composite();
    if (!previewReady) {
      previewCtx.putImageData(new ImageData(new Uint8ClampedArray(composite), doc.width, doc.height), 0, 0);
      previewReady = true;
      doc.clearCompositeDirtyTiles();
    } else if (dirtyTiles.length) {
      for (const tile of dirtyTiles) {
        const tilePixels = new Uint8ClampedArray(tile.width * tile.height * 4);
        for (let row = 0; row < tile.height; row++) {
          const sourceStart = ((tile.tileY * 64 + row) * doc.width + tile.tileX * 64) * 4;
          tilePixels.set(composite.subarray(sourceStart, sourceStart + tile.width * 4), row * tile.width * 4);
        }
        previewCtx.putImageData(new ImageData(tilePixels, tile.width, tile.height), tile.tileX * 64, tile.tileY * 64);
      }
      doc.clearCompositeDirtyTiles();
    }
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#20232d';
    ctx.fillRect(panX - 1, panY - 1, doc.width * zoom + 2, doc.height * zoom + 2);
    ctx.drawImage(previewCanvas, panX, panY, doc.width * zoom, doc.height * zoom);
    if (transformPreview && transformPreview.docWidth === doc.width && transformPreview.docHeight === doc.height) {
      ctx.save(); ctx.globalAlpha = .78; ctx.imageSmoothingEnabled = false;
      ctx.drawImage(transformPreviewCanvas, panX, panY, doc.width * zoom, doc.height * zoom); ctx.restore();
      if (transformPreview.bounds) {
        ctx.save(); ctx.strokeStyle = '#69dfbb'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]);
        ctx.strokeRect(panX + transformPreview.bounds.x * zoom, panY + transformPreview.bounds.y * zoom,
          transformPreview.bounds.width * zoom, transformPreview.bounds.height * zoom); ctx.restore();
      }
    }
    ctx.strokeStyle = '#555b6c'; ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(panX) + .5, Math.round(panY) + .5, Math.round(doc.width * zoom), Math.round(doc.height * zoom));
    // View-only pixel grid: clipped to the visible canvas region and never part of document pixels/exports.
    if (gridEnabled && zoom >= 4) {
      const left = Math.max(1, Math.ceil(-panX / zoom));
      const right = Math.min(doc.width - 1, Math.floor((canvas.clientWidth - panX) / zoom));
      const top = Math.max(1, Math.ceil(-panY / zoom));
      const bottom = Math.min(doc.height - 1, Math.floor((canvas.clientHeight - panY) / zoom));
      ctx.save();
      ctx.beginPath();
      ctx.rect(panX, panY, doc.width * zoom, doc.height * zoom);
      ctx.clip();
      ctx.strokeStyle = 'rgba(20, 22, 31, 0.42)';
      ctx.lineWidth = 1 / dpr;
      ctx.beginPath();
      for (let x = left; x <= right; x++) {
        const screenX = Math.round(panX + x * zoom) + .5 / dpr;
        ctx.moveTo(screenX, Math.max(0, panY));
        ctx.lineTo(screenX, Math.min(canvas.clientHeight, panY + doc.height * zoom));
      }
      for (let y = top; y <= bottom; y++) {
        const screenY = Math.round(panY + y * zoom) + .5 / dpr;
        ctx.moveTo(Math.max(0, panX), screenY);
        ctx.lineTo(Math.min(canvas.clientWidth, panX + doc.width * zoom), screenY);
      }
      ctx.stroke();
      ctx.restore();
    }
    if (cropPreview && cropPreview.docWidth === doc.width && cropPreview.docHeight === doc.height) {
      const left = panX + cropPreview.x * zoom, top = panY + cropPreview.y * zoom;
      const right = left + cropPreview.width * zoom, bottom = top + cropPreview.height * zoom;
      ctx.save(); ctx.fillStyle = 'rgba(8, 9, 14, .62)';
      ctx.fillRect(panX, panY, doc.width * zoom, Math.max(0, top - panY));
      ctx.fillRect(panX, bottom, doc.width * zoom, Math.max(0, panY + doc.height * zoom - bottom));
      ctx.fillRect(panX, top, Math.max(0, left - panX), cropPreview.height * zoom);
      ctx.fillRect(right, top, Math.max(0, panX + doc.width * zoom - right), cropPreview.height * zoom);
      ctx.strokeStyle = '#69dfbb'; ctx.lineWidth = 2; ctx.setLineDash([6, 3]);
      ctx.strokeRect(left, top, cropPreview.width * zoom, cropPreview.height * zoom); ctx.restore();
    }
    drawSymmetryGuides();
    if (gradientGesture) {
      const x1 = panX + (gradientGesture.x1 + .5) * zoom, y1 = panY + (gradientGesture.y1 + .5) * zoom;
      const x2 = panX + (gradientGesture.x2 + .5) * zoom, y2 = panY + (gradientGesture.y2 + .5) * zoom;
      ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.setLineDash([]); ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x1, y1, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = backgroundColor; ctx.beginPath(); ctx.arc(x2, y2, 4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = color; ctx.stroke(); ctx.restore();
    }
    if (shapeGesture) {
      const points = shapePoints(shapeGesture);
      if (points.length) {
        const paths = symmetryMode ? Array.from({ length: symmetryMode === 2 ? 2 : symmetryMode === 4 ? 4 : 8 }, (_, index) => {
          const mapped = points.map(point => symmetryPoints(point)[index]).filter(Boolean);
          return mapped;
        }) : [points];
        ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, brushSize * zoom);
        ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.globalAlpha = .92;
        for (const path of paths) {
          if (!path.length) continue;
          ctx.beginPath();
          path.forEach((point, index) => {
            const sx = panX + (point.x + .5) * zoom, sy = panY + (point.y + .5) * zoom;
            if (index === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
          });
          ctx.stroke();
        }
        ctx.restore();
      }
    }
    if (selection) {
      const sx = panX + selection.x * zoom, sy = panY + selection.y * zoom;
      const sw = selection.width * zoom, sh = selection.height * zoom;
      const traceSelection = () => {
        ctx.beginPath();
        if (selection.customMask && zoom >= 2) {
          const left = Math.max(selection.x, Math.floor(-panX / zoom)), top = Math.max(selection.y, Math.floor(-panY / zoom));
          const right = Math.min(selection.x + selection.width, Math.ceil((canvas.clientWidth - panX) / zoom));
          const bottom = Math.min(selection.y + selection.height, Math.ceil((canvas.clientHeight - panY) / zoom));
          const mask = selection.customMask;
          const selected = (x, y) => x >= 0 && y >= 0 && x < doc.width && y < doc.height && Boolean(mask[y * doc.width + x]);
          for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
            if (!selected(x, y)) continue;
            const x0 = panX + x * zoom, y0 = panY + y * zoom, x1 = x0 + zoom, y1 = y0 + zoom;
            if (!selected(x, y - 1)) { ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); }
            if (!selected(x + 1, y)) { ctx.moveTo(x1, y0); ctx.lineTo(x1, y1); }
            if (!selected(x, y + 1)) { ctx.moveTo(x1, y1); ctx.lineTo(x0, y1); }
            if (!selected(x - 1, y)) { ctx.moveTo(x0, y1); ctx.lineTo(x0, y0); }
          }
        } else if (selection.shape === 'ellipse') ctx.ellipse(sx + sw / 2, sy + sh / 2, Math.max(.5, sw / 2), Math.max(.5, sh / 2), 0, 0, Math.PI * 2);
        else if (selection.shape === 'polygon' && selection.points?.length) {
          selection.points.forEach((point, index) => {
            const px = panX + (point.x + .5) * zoom, py = panY + (point.y + .5) * zoom;
            if (index === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          });
          if (selection.points.length >= 3) ctx.closePath();
        } else ctx.rect(Math.round(sx) + .5, Math.round(sy) + .5, Math.max(0, sw - 1), Math.max(0, sh - 1));
      };
      ctx.save(); ctx.strokeStyle = '#f4f0ff'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); traceSelection(); ctx.stroke();
      ctx.strokeStyle = '#282532'; ctx.lineDashOffset = 5; traceSelection(); ctx.stroke(); ctx.restore();
    }
    if (virtualCursorVisible && virtualCursorScreen && (cursorMode || virtualCursorPointerId !== null)) {
      const radius = Math.max(2, Math.min(48, brushSize * zoom / 2));
      ctx.save(); ctx.strokeStyle = cursorMode ? '#69dfbb' : drawHeld ? '#69dfbb' : '#e8eaf2'; ctx.lineWidth = 1.25;
      if (['draw', 'erase'].includes(tool)) { ctx.beginPath(); ctx.arc(virtualCursorScreen.x, virtualCursorScreen.y, radius, 0, Math.PI * 2); ctx.stroke(); }
      // Small arrow/pencil marker for the independent on-screen cursor.
      ctx.beginPath(); ctx.moveTo(virtualCursorScreen.x + 1, virtualCursorScreen.y + 1);
      ctx.lineTo(virtualCursorScreen.x + 1, virtualCursorScreen.y + 17); ctx.lineTo(virtualCursorScreen.x + 5, virtualCursorScreen.y + 13);
      ctx.lineTo(virtualCursorScreen.x + 8, virtualCursorScreen.y + 20); ctx.lineTo(virtualCursorScreen.x + 11, virtualCursorScreen.y + 18);
      ctx.lineTo(virtualCursorScreen.x + 8, virtualCursorScreen.y + 11); ctx.lineTo(virtualCursorScreen.x + 13, virtualCursorScreen.y + 11);
      ctx.closePath(); ctx.fillStyle = '#171922'; ctx.fill(); ctx.stroke(); ctx.restore();
    }
    $('#zoom-label').textContent = `${Math.round(zoom * 100)}%`;
  });
}
function eventPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}
function documentPointFromScreen(point) { return screenToDocument(point, { zoom, panX, panY }, doc); }
function syncSelectionMask() {
  const controls = $('#selection-settings');
  if (controls) controls.hidden = !selection;
  if (selection?.customMask) { doc.setSelectionMask(selection.customMask); return; }
  if (selection?.shape === 'polygon' && selection.points.length < 3) { doc.setSelectionMask(null); return; }
  doc.setSelectionMask(createSelectionMask(doc.width, doc.height, selection));
}
function clearSelectionState() {
  selection = null; selectionStart = null; selectionPointerId = null;
  syncSelectionMask();
}
function symmetryPoints(point, mode = symmetryMode) {
  const w = doc.width, h = doc.height;
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const dx = point.x - cx, dy = point.y - cy;
  let offsets = [[dx, dy]];
  if (mode === 2) offsets = [[dx, dy], [-dx, dy]];
  else if (mode === 4) offsets = [[dx, dy], [-dx, dy], [dx, -dy], [-dx, -dy]];
  else if (mode === 8) offsets = [
    [dx, dy], [-dy, dx], [-dx, -dy], [dy, -dx],
    [-dx, dy], [-dy, -dx], [dx, -dy], [dy, dx]
  ];
  return offsets.map(([ox, oy]) => {
    const x = Math.round(cx + ox), y = Math.round(cy + oy);
    return x < 0 || y < 0 || x >= w || y >= h ? null : { x, y };
  });
}
function strokeToWithSymmetry(stroke, x, y) {
  const mode = stroke.symmetryMode ?? symmetryMode;
  if (!mode) { doc.strokeTo(stroke, x, y); return; }
  const points = symmetryPoints({ x, y }, mode), previous = stroke.symmetryLastPoints ?? [], next = [];
  for (let i = 0; i < points.length; i++) {
    if (!points[i]) { next[i] = null; continue; }
    stroke.last = previous[i] ?? null;
    doc.strokeTo(stroke, points[i].x, points[i].y);
    next[i] = stroke.last;
  }
  stroke.symmetryLastPoints = next;
  stroke.last = next[0] ?? null;
}
function drawSymmetryGuides() {
  if (!symmetryMode) return;
  const cx = panX + doc.width * zoom / 2, cy = panY + doc.height * zoom / 2;
  ctx.save(); ctx.beginPath(); ctx.rect(panX, panY, doc.width * zoom, doc.height * zoom); ctx.clip();
  ctx.strokeStyle = 'rgba(105, 223, 187, 0.58)'; ctx.lineWidth = 1; ctx.setLineDash([6, 5]); ctx.beginPath();
  if (symmetryMode >= 2) { ctx.moveTo(cx, panY); ctx.lineTo(cx, panY + doc.height * zoom); }
  if (symmetryMode >= 4) { ctx.moveTo(panX, cy); ctx.lineTo(panX + doc.width * zoom, cy); }
  if (symmetryMode === 8) {
    const radius = Math.min(doc.width, doc.height) * zoom / 2;
    ctx.moveTo(cx - radius, cy - radius); ctx.lineTo(cx + radius, cy + radius);
    ctx.moveTo(cx + radius, cy - radius); ctx.lineTo(cx - radius, cy + radius);
  }
  ctx.stroke(); ctx.restore();
}
function docPoint(event) { return documentPointFromScreen(eventPoint(event)); }
function shapePoints(gesture) {
  const { x1, y1, x2, y2 } = gesture;
  if (gesture.tool === 'shape-line') return rasterLinePoints(x1, y1, x2, y2);
  const left = Math.min(x1, x2), right = Math.max(x1, x2);
  const top = Math.min(y1, y2), bottom = Math.max(y1, y2);
  if (gesture.tool === 'shape-rect') {
    if (left === right || top === bottom) return rasterLinePoints(left, top, right, bottom);
    const path = [];
    const edges = [
      rasterLinePoints(left, top, right, top),
      rasterLinePoints(right, top, right, bottom).slice(1),
      rasterLinePoints(right, bottom, left, bottom).slice(1),
      rasterLinePoints(left, bottom, left, top).slice(1)
    ];
    for (const edge of edges) path.push(...edge);
    return path;
  }
  const cx = (left + right) / 2, cy = (top + bottom) / 2;
  const rx = (right - left) / 2, ry = (bottom - top) / 2;
  if (rx === 0) return rasterLinePoints(left, top, left, bottom);
  if (ry === 0) return rasterLinePoints(left, top, right, top);
  const steps = Math.max(24, Math.ceil(Math.PI * 2 * Math.max(rx, ry) * 2));
  const path = []; let previous = null;
  for (let i = 0; i <= steps; i++) {
    const angle = i / steps * Math.PI * 2;
    const point = { x: Math.round(cx + Math.cos(angle) * rx), y: Math.round(cy + Math.sin(angle) * ry) };
    if (!previous) path.push(point);
    else {
      const segment = rasterLinePoints(previous.x, previous.y, point.x, point.y);
      path.push(...segment.slice(1));
    }
    previous = point;
  }
  return path.filter((point, index, points) => index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y);
}
function commitShapeGesture(gesture) {
  if (!gesture) return;
  try {
    const points = shapePoints(gesture);
    if (!points.length) return;
    const stroke = doc.beginStroke({ color, size: brushSize, mode: 'draw', opacity: Number($('#brush-opacity').value) / 100, shape: $('#brush-shape').value, hardness: Number($('#brush-hardness').value) / 100 });
    stroke.symmetryMode = symmetryMode;
    for (const point of points) strokeToWithSymmetry(stroke, point.x, point.y);
    doc.endStroke(stroke, { commit: true });
    changed();
    status((gesture.tool === 'shape-line' ? 'Line' : gesture.tool === 'shape-rect' ? 'Rectangle' : 'Ellipse') + ' drawn', 'success');
  } catch (error) { status(error.message, 'error'); }
}
function moveVirtualCursorBy(dx, dy) {
  if (!virtualCursorScreen) virtualCursorScreen = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 };
  virtualCursorScreen = { x: Math.max(0, Math.min(canvas.clientWidth, virtualCursorScreen.x + dx)), y: Math.max(0, Math.min(canvas.clientHeight, virtualCursorScreen.y + dy)) };
  const point = documentPointFromScreen(virtualCursorScreen);
  // Keep the virtual tool on a drawable pixel even when the viewport is panned or the document is smaller than the work area.
  virtualCursorPoint = { x: Math.max(0, Math.min(doc.width - 1, point.x)), y: Math.max(0, Math.min(doc.height - 1, point.y)), inside: true };
  virtualCursorVisible = true; render();
}
function scheduleAutosave() {
  clearTimeout(autosaveTimer); autosaveTimer = null;
  status('Unsaved changes', 'warning');
  if (flushInProgress) return;
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    const savingDoc = doc, version = savingDoc.saveVersion, snapshot = savingDoc.toJSON();
    const operation = autosaveInFlight.catch(() => {}).then(async () => {
      await saveProject(snapshot);
      savingDoc.dirty = savingDoc.saveVersion !== version;
      if (doc === savingDoc) {
        status(savingDoc.dirty ? 'Unsaved changes' : 'Saved on this device', savingDoc.dirty ? 'warning' : 'success');
        updateTitle();
      }
    });
    autosaveInFlight = operation.catch(error => {
      if (doc === savingDoc) status(`Autosave unavailable: ${error.message}`, 'error');
    });
  }, 800);
}
function settleActiveInput() {
  if (activeStroke) finishActiveStroke(true);
  drawHeld = false; drawHoldPointerId = null; updateDrawHoldUI();
}
async function flushAutosave({ force = false } = {}) {
  if (flushPromise) return flushPromise;
  flushPromise = (async () => {
    settleActiveInput();
    const pending = autosaveTimer !== null;
    if (pending) { clearTimeout(autosaveTimer); autosaveTimer = null; }
    const savingDoc = doc;
    flushInProgress = true;
    try {
      await autosaveInFlight;
      if (!savingDoc.dirty && !pending && !force) return;
      while (doc === savingDoc) {
        const version = savingDoc.saveVersion, snapshot = savingDoc.toJSON();
        await saveProject(snapshot);
        if (savingDoc.saveVersion === version) { savingDoc.dirty = false; break; }
        savingDoc.dirty = true;
      }
      if (doc === savingDoc) updateTitle();
    } finally {
      flushInProgress = false;
      if (doc === savingDoc && savingDoc.dirty) scheduleAutosave();
    }
  })();
  try { await flushPromise; }
  finally { flushPromise = null; }
}
function changed() { clearTransformPreview(); clearCropPreview(); syncAIWorkspaceFromUser(); render(); updateTitle(); scheduleAutosave(); }
function startStrokeAt(point, id) {
  if (!point?.inside || activeStroke) return;
  try {
    activeStroke = doc.beginStroke({ color, size: brushSize, mode: tool, opacity: Number($('#brush-opacity').value) / 100, shape: $('#brush-shape').value, hardness: Number($('#brush-hardness').value) / 100 });
    activeStroke.symmetryMode = symmetryMode;
    pointerId = id;
    strokeToWithSymmetry(activeStroke, point.x, point.y);
    render();
  } catch (error) { status(error.message, 'error'); }
}
function performSample(point) {
  if (!point?.inside) return;
  try {
    const sampled = doc.sampleColorAt(point.x, point.y, { merged: sampleMerged });
    if (!sampled) status('No visible color at this pixel', 'neutral');
    else {
      color = sampled;
      applyForegroundColor(sampled);
      status(`Sampled ${sampled}`, 'success');
    }
    setTool(returnTool);
  } catch (error) { status(error.message, 'error'); }
}
function selectionBounds(mask) {
  if (!(mask instanceof Uint8Array) || mask.length !== doc.width * doc.height) return null;
  const first = mask.indexOf(1);
  if (first < 0) return null;
  const last = mask.lastIndexOf(1);
  const top = Math.floor(first / doc.width), bottom = Math.floor(last / doc.width);
  let left = doc.width, right = -1;
  // Typed-array row searches run in native code and avoid millions of JS-level
  // branches when selections are recalculated on large canvases.
  for (let y = top; y <= bottom; y++) {
    const row = mask.subarray(y * doc.width, (y + 1) * doc.width);
    const rowLeft = row.indexOf(1);
    if (rowLeft < 0) continue;
    left = Math.min(left, rowLeft);
    right = Math.max(right, row.lastIndexOf(1));
  }
  return right < left ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}
function applySelectionCombination(nextMask, baseMask = doc.selectionMask, sourceLabel = 'Selection') {
  const operation = $('#selection-mode')?.value ?? 'replace';
  const combined = combineSelectionMasks(doc.width, doc.height, baseMask, nextMask, operation);
  const bounds = combined ? selectionBounds(combined) : null;
  selection = bounds ? { ...bounds, shape: 'mask', customMask: combined } : null;
  selectionStart = null; selectionPointerId = null; syncSelectionMask();
  const labels = { replace: 'replaced', add: 'added', subtract: 'subtracted', intersect: 'intersected' };
  const count = combined.reduce((sum, value) => sum + value, 0);
  if (!selection) status('Selection is empty', 'success');
  else if (sourceLabel === 'Color selection' && operation === 'replace') status('Color selection: ' + count.toLocaleString() + ' pixels', 'success');
  else if (operation === 'replace') status('Selected ' + selection.width + ' × ' + selection.height + ' pixels', 'success');
  else status('Selection ' + labels[operation] + ' · ' + count.toLocaleString() + ' pixels', 'success');
  render();
}
function performColorSelection(point) {
  if (!point?.inside || flushInProgress) return;
  try {
    const mask = createColorSelectionMask(doc.width, doc.height, doc.activeLayer.pixels, point.x, point.y, {
      tolerance: Number($('#magic-tolerance').value), contiguous: $('#magic-mode').value === 'contiguous'
    });
    if (!mask.some(Boolean)) { status('No matching colors selected', 'neutral'); return; }
    applySelectionCombination(mask, doc.selectionMask, 'Color selection');
  } catch (error) { status(error.message, 'error'); }
}
function performFill(point) {
  if (!point?.inside || flushInProgress) return;
  try {
    const count = doc.fillAt(point.x, point.y, { color, tolerance: fillTolerance, contiguous: fillContiguous, pattern: $('#fill-pattern').value, secondaryColor: backgroundColor, scale: Number($('#fill-scale').value) });
    if (count) { changed(); status(`Filled ${count.toLocaleString()} pixels`, 'success'); }
    else status('Fill made no changes', 'neutral');
  } catch (error) { status(error.message, 'error'); }
}
function beginStroke(event) {
  if (event.button !== undefined && event.button !== 0) return;
  const point = docPoint(event);
  if (!point.inside) return;
  try { canvas.setPointerCapture?.(event.pointerId); } catch {}
  startStrokeAt(point, event.pointerId);
}
function moveStroke(event) {
  if (selectionStart && event.pointerId === selectionPointerId) {
    const point = docPoint(event);
    const x = Math.max(0, Math.min(doc.width - 1, point.x)), y = Math.max(0, Math.min(doc.height - 1, point.y));
    if (selectionStart.shape === 'polygon') {
      const points = selectionStart.points, last = points[points.length - 1];
      if ((Math.abs(x - last.x) + Math.abs(y - last.y) >= 1) && points.length < 4096) points.push({ x, y });
      const xs = points.map(item => item.x), ys = points.map(item => item.y);
      const left = Math.min(...xs), top = Math.min(...ys), right = Math.max(...xs), bottom = Math.max(...ys);
      selection = { x: left, y: top, width: right - left + 1, height: bottom - top + 1, shape: 'polygon', points: [...points] };
    } else {
      const left = Math.min(selectionStart.x, x), top = Math.min(selectionStart.y, y);
      selection = { x: left, y: top, width: Math.abs(x - selectionStart.x) + 1, height: Math.abs(y - selectionStart.y) + 1, shape: selectionStart.shape };
    }
    syncSelectionMask(); render(); return;
  }
  if (panning && panStart) {
    const p = eventPoint(event);
    panX = panStart.panX + p.x - panStart.x; panY = panStart.panY + p.y - panStart.y;
    render(); return;
  }
  if (event.pointerType === 'touch' && event.pointerId === virtualCursorPointerId) {
    virtualCursorScreen = eventPoint(event); virtualCursorPoint = docPoint(event); virtualCursorVisible = true;
    if (['draw', 'erase'].includes(tool)) {
      if (!activeStroke && virtualCursorCanDraw) startStrokeAt(virtualCursorPoint, event.pointerId);
      else if (activeStroke && pointerId === event.pointerId && virtualCursorPoint.inside) strokeToWithSymmetry(activeStroke, virtualCursorPoint.x, virtualCursorPoint.y);
    }
    render(); return;
  }
  if (!activeStroke || event.pointerId !== pointerId) return;
  const point = docPoint(event);
  if (point.inside) strokeToWithSymmetry(activeStroke, point.x, point.y);
  render();
}
function finishActiveStroke(commit = true) {
  if (!activeStroke) return;
  doc.endStroke(activeStroke, { commit }); activeStroke = null; pointerId = null;
  if (commit) changed(); else render();
}
function endStroke(event, commit = true) {
  if (!activeStroke || (event?.pointerId !== undefined && event.pointerId !== pointerId)) return;
  finishActiveStroke(commit);
}
canvas.addEventListener('pointerdown', event => {
  if (flushInProgress) { event.preventDefault(); return; }
  if (cursorMode) { event.preventDefault(); return; }
  if (tool === 'gradient') {
    if (event.button !== undefined && event.button !== 0) return;
    if (doc.activeLayer?.locked) { status('The active layer is locked.', 'error'); event.preventDefault(); return; }
    const point = docPoint(event); if (!point.inside) return;
    gradientGesture = { x1: point.x, y1: point.y, x2: point.x, y2: point.y, pointerId: event.pointerId };
    try { canvas.setPointerCapture?.(event.pointerId); } catch {}
    render(); event.preventDefault(); return;
  }
  if (['shape-line', 'shape-rect', 'shape-ellipse'].includes(tool)) {
    if (event.button !== undefined && event.button !== 0) return;
    if (doc.activeLayer?.locked) { status('The active layer is locked.', 'error'); event.preventDefault(); return; }
    const point = docPoint(event);
    if (!point.inside) return;
    shapeGesture = { tool, x1: point.x, y1: point.y, x2: point.x, y2: point.y, pointerId: event.pointerId };
    try { canvas.setPointerCapture?.(event.pointerId); } catch {}
    render(); event.preventDefault(); return;
  }
  if (['select', 'select-ellipse', 'select-lasso'].includes(tool)) {
    const point = docPoint(event); if (!point.inside) return;
    const shape = tool === 'select-ellipse' ? 'ellipse' : tool === 'select-lasso' ? 'polygon' : 'rect';
    selectionStart = shape === 'polygon' ? { x: point.x, y: point.y, shape, points: [{ x: point.x, y: point.y }], baseMask: doc.selectionMask ? new Uint8Array(doc.selectionMask) : null } : { x: point.x, y: point.y, shape, baseMask: doc.selectionMask ? new Uint8Array(doc.selectionMask) : null };
    selectionPointerId = event.pointerId;
    selection = shape === 'polygon' ? { x: point.x, y: point.y, width: 1, height: 1, shape, points: [...selectionStart.points] } : { x: point.x, y: point.y, width: 1, height: 1, shape };
    syncSelectionMask();
    try { canvas.setPointerCapture?.(event.pointerId); } catch {}
    render(); event.preventDefault(); return;
  }
  if (tool === 'select-color') { if (event.button === undefined || event.button === 0) performColorSelection(docPoint(event)); event.preventDefault(); return; }
  if (tool === 'eyedropper') { if (event.button === undefined || event.button === 0) performSample(docPoint(event)); event.preventDefault(); return; }
  if (tool === 'fill') { if (event.button === undefined || event.button === 0) performFill(docPoint(event)); event.preventDefault(); return; }
  if (tool === 'pan' || event.button === 1 || spaceDown) {
    panning = true;
    const p = eventPoint(event); panStart = { x: p.x, y: p.y, panX, panY };
    try { canvas.setPointerCapture?.(event.pointerId); } catch {}
    canvas.classList.add('is-panning'); event.preventDefault(); return;
  }
  if (event.pointerType === 'touch') {
    // Keep one canvas touch as the drawing pointer; extra fingers must not steal its stroke.
    if (virtualCursorPointerId !== null && virtualCursorPointerId !== event.pointerId) { event.preventDefault(); return; }
    virtualCursorPointerId = event.pointerId; virtualCursorScreen = eventPoint(event);
    virtualCursorPoint = docPoint(event); virtualCursorVisible = true;
    virtualCursorCanDraw = !activeStroke && !drawHeld && ['draw', 'erase'].includes(tool);
    try { canvas.setPointerCapture?.(event.pointerId); } catch {}
    if (['draw', 'erase'].includes(tool)) startStrokeAt(virtualCursorPoint, event.pointerId);
    render(); event.preventDefault(); return;
  }
  beginStroke(event);
});
canvas.addEventListener('pointermove', event => {
  if (gradientGesture && event.pointerId === gradientGesture.pointerId) {
    const point = docPoint(event);
    gradientGesture.x2 = Math.max(0, Math.min(doc.width - 1, point.x));
    gradientGesture.y2 = Math.max(0, Math.min(doc.height - 1, point.y));
    render(); return;
  }
  if (shapeGesture && event.pointerId === shapeGesture.pointerId) {
    const point = docPoint(event);
    shapeGesture.x2 = Math.max(0, Math.min(doc.width - 1, point.x));
    shapeGesture.y2 = Math.max(0, Math.min(doc.height - 1, point.y));
    render(); return;
  }
  moveStroke(event);
});
window.addEventListener('pointerdown', event => {
  if (!cursorMode || event.pointerType !== 'touch' || cursorGesturePointerId !== null) return;
  if (event.target instanceof Element && event.target.closest('#brush-scrub')) return;
  cursorGestureSuppressClick = false;
  cursorGestureControlTarget = null;
  cursorGesturePointerId = event.pointerId;
  cursorGestureLast = cursorGestureOrigin = { x: event.clientX, y: event.clientY };
  cursorGestureControlTarget = event.target instanceof Element ? event.target.closest('button, a, input, select, textarea, [role="button"]') : null;
  cursorGestureStartedOnControl = Boolean(cursorGestureControlTarget);
}, true);
window.addEventListener('pointermove', event => {
  if (!cursorMode || event.pointerType !== 'touch' || event.pointerId !== cursorGesturePointerId || !cursorGestureLast) return;
  const dx = event.clientX - cursorGestureLast.x, dy = event.clientY - cursorGestureLast.y;
  cursorGestureLast = { x: event.clientX, y: event.clientY };
  if (cursorGestureStartedOnControl && cursorGestureOrigin && Math.hypot(event.clientX - cursorGestureOrigin.x, event.clientY - cursorGestureOrigin.y) > 7) cursorGestureSuppressClick = true;
  if (dx || dy) {
    event.preventDefault();
    moveVirtualCursorBy(dx, dy);
  }
}, true);
window.addEventListener('click', event => {
  if (!cursorGestureSuppressClick) return;
  const originalControl = cursorGestureControlTarget;
  const sameControl = originalControl && (event.target === originalControl || originalControl.contains(event.target));
  cursorGestureSuppressClick = false;
  cursorGestureControlTarget = null;
  if (!cursorMode || !sameControl) return;
  event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
}, true);
function finishCursorGesture(event) {
  if (event.pointerId === cursorGesturePointerId) {
    cursorGesturePointerId = null; cursorGestureLast = null; cursorGestureOrigin = null; cursorGestureStartedOnControl = false;
  }
}
window.addEventListener('pointerup', finishCursorGesture, true);
window.addEventListener('pointercancel', finishCursorGesture, true);
canvas.addEventListener('pointerup', event => {
  if (gradientGesture && event.pointerId === gradientGesture.pointerId) {
    const gesture = gradientGesture; gradientGesture = null;
    try {
      const count = doc.fillGradient(gesture.x1, gesture.y1, gesture.x2, gesture.y2, {
        startColor: color, endColor: backgroundColor, opacity: Number($('#brush-opacity').value) / 100
      });
      if (count) { changed(); status(`Gradient applied to ${count.toLocaleString()} pixels`, 'success'); }
      else status('Gradient made no changes', 'neutral');
    } catch (error) { status(error.message, 'error'); }
    render(); return;
  }
  if (shapeGesture && event.pointerId === shapeGesture.pointerId) {
    const gesture = shapeGesture; shapeGesture = null;
    commitShapeGesture(gesture); render(); return;
  }
  if (selectionStart && event.pointerId === selectionPointerId) {
    if (selectionStart.shape === 'polygon' && selectionStart.points.length < 3) {
      selectionStart = null; selectionPointerId = null; selection = null; syncSelectionMask();
      status('Lasso needs at least three points', 'warning'); render(); return;
    }
    const baseMask = selectionStart.baseMask;
    const nextMask = new Uint8Array(doc.selectionMask);
    applySelectionCombination(nextMask, baseMask); return;
  }
  if (panning) { panning = false; panStart = null; canvas.classList.remove('is-panning'); return; }
  if (event.pointerType === 'touch' && event.pointerId === virtualCursorPointerId) {
    if (activeStroke && pointerId === event.pointerId) finishActiveStroke(true);
    virtualCursorPointerId = null; virtualCursorPoint = null; virtualCursorVisible = false; virtualCursorCanDraw = false; render(); return;
  }
  endStroke(event, true);
});
canvas.addEventListener('pointercancel', event => {
  if (gradientGesture && event.pointerId === gradientGesture.pointerId) { gradientGesture = null; render(); return; }
  if (shapeGesture && event.pointerId === shapeGesture.pointerId) { shapeGesture = null; render(); return; }
  if (selectionStart && event.pointerId === selectionPointerId) { selectionStart = null; selectionPointerId = null; selection = null; syncSelectionMask(); render(); return; }
  if (panning) { panning = false; panStart = null; canvas.classList.remove('is-panning'); }
  if (event.pointerType === 'touch' && event.pointerId === virtualCursorPointerId) {
    if (activeStroke && pointerId === event.pointerId) finishActiveStroke(false);
    virtualCursorPointerId = null; virtualCursorPoint = null; virtualCursorVisible = false; virtualCursorCanDraw = false; render(); return;
  }
  endStroke(event, false);
});
canvas.addEventListener('lostpointercapture', event => {
  if (gradientGesture && event.pointerId === gradientGesture.pointerId) { gradientGesture = null; render(); return; }
  if (shapeGesture && event.pointerId === shapeGesture.pointerId) { shapeGesture = null; render(); return; }
  if (selectionStart && event.pointerId === selectionPointerId) { selectionStart = null; selectionPointerId = null; selection = null; syncSelectionMask(); render(); return; }
  if (event.pointerType === 'touch' && event.pointerId === virtualCursorPointerId) {
    if (activeStroke && pointerId === event.pointerId) finishActiveStroke(false);
    virtualCursorPointerId = null; virtualCursorPoint = null; virtualCursorVisible = false; render(); return;
  }
  endStroke(event, false);
});
const drawHoldButton = $('#draw-hold');
function updateDrawHoldUI() {
  if (!drawHoldButton) return;
  drawHoldButton.classList.toggle('held', drawHeld);
  drawHoldButton.setAttribute('aria-pressed', String(drawHeld));
  drawHoldButton.disabled = cursorMode || !['draw', 'erase'].includes(tool) || Boolean(doc.activeLayer?.locked);
  drawHoldButton.style.display = cursorMode ? 'none' : '';
  drawHoldButton.querySelector('small').textContent = cursorMode ? 'Cursor active' : tool === 'erase' ? 'Hold to erase' : tool === 'pan' ? 'Pan selected' : tool === 'select' ? 'Select area' : tool === 'fill' ? 'Fill selected' : tool === 'eyedropper' ? 'Sample color' : 'Hold to draw';
}
drawHoldButton?.addEventListener('pointerdown', event => {
  if (!['draw', 'erase'].includes(tool) || flushInProgress || drawHeld) { event.preventDefault(); return; }
  event.preventDefault(); drawHeld = true; drawHoldPointerId = event.pointerId; updateDrawHoldUI();
  try { drawHoldButton.setPointerCapture(event.pointerId); } catch {}
  if (virtualCursorPointerId !== null && virtualCursorPoint?.inside && !activeStroke) startStrokeAt(virtualCursorPoint, virtualCursorPointerId);
  render();
});
drawHoldButton?.addEventListener('keydown', event => {
  if (!['Space', 'Enter'].includes(event.code)) return;
  event.preventDefault();
  if (event.repeat || drawHeld || !['draw', 'erase'].includes(tool) || flushInProgress) return;
  drawHeld = true; drawHoldPointerId = 'keyboard'; updateDrawHoldUI();
  if (virtualCursorPointerId !== null && virtualCursorPoint?.inside && !activeStroke) startStrokeAt(virtualCursorPoint, virtualCursorPointerId);
  render();
});
drawHoldButton?.addEventListener('keyup', event => {
  if (!['Space', 'Enter'].includes(event.code) || drawHoldPointerId !== 'keyboard') return;
  event.preventDefault();
  drawHeld = false; drawHoldPointerId = null; finishActiveStroke(true); updateDrawHoldUI(); render();
});
drawHoldButton?.addEventListener('blur', () => {
  if (!drawHeld) return;
  drawHeld = false; drawHoldPointerId = null; finishActiveStroke(false); updateDrawHoldUI(); render();
});
window.addEventListener('pointerup', event => {
  if (drawHoldPointerId !== event.pointerId) return;
  drawHeld = false; drawHoldPointerId = null; finishActiveStroke(true); updateDrawHoldUI(); render();
});
window.addEventListener('pointercancel', event => {
  if (drawHoldPointerId !== event.pointerId) return;
  drawHeld = false; drawHoldPointerId = null; finishActiveStroke(false); updateDrawHoldUI(); render();
});
drawHoldButton?.addEventListener('lostpointercapture', event => {
  if (drawHoldPointerId !== event.pointerId) return;
  drawHeld = false; drawHoldPointerId = null; finishActiveStroke(false); updateDrawHoldUI(); render();
});
canvas.addEventListener('wheel', event => {
  event.preventDefault();
  const p = eventPoint(event);
  zoomAt(p, zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
}, { passive: false });

const cursorModeButton = $('#cursor-mode');
function setCursorMode(enabled) {
  cursorMode = Boolean(enabled);
  cursorModeButton.classList.toggle('active', cursorMode);
  cursorModeButton.setAttribute('aria-pressed', String(cursorMode));
  canvas.dataset.cursorMode = String(cursorMode);
  cursorGesturePointerId = null; cursorGestureLast = null; cursorGestureOrigin = null;
  cursorGestureStartedOnControl = false; cursorGestureControlTarget = null; cursorGestureSuppressClick = false;
  if (!cursorMode) { virtualCursorPointerId = null; virtualCursorCanDraw = false; }
  updateDrawHoldUI();
  if (cursorMode) {
    virtualCursorScreen = { x: Math.max(0, Math.min(canvas.clientWidth, doc.width * zoom / 2 + panX)), y: Math.max(0, Math.min(canvas.clientHeight, doc.height * zoom / 2 + panY)) };
    const point = documentPointFromScreen(virtualCursorScreen);
    virtualCursorPoint = { x: Math.max(0, Math.min(doc.width - 1, point.x)), y: Math.max(0, Math.min(doc.height - 1, point.y)), inside: true };
    virtualCursorVisible = true;
    status('Cursor mode: swipe anywhere to move; touch the size bar to draw', 'success');
  } else {
    virtualCursorVisible = false; virtualCursorScreen = null; virtualCursorPoint = null;
    status('Direct drawing mode', 'neutral');
  }
  render();
}
cursorModeButton.addEventListener('click', () => setCursorMode(!cursorMode));
$('#brush-tool').addEventListener('click', () => setTool('draw'));
$('#eraser-tool').addEventListener('click', () => setTool('erase'));
$('#pan-tool').addEventListener('click', () => setTool('pan'));
$('#fill-tool').addEventListener('click', () => setTool('fill'));
$('#eyedropper-tool').addEventListener('click', () => setTool('eyedropper'));
$('#select-tool').addEventListener('click', () => setTool('select'));
$('#ellipse-select-tool').addEventListener('click', () => setTool('select-ellipse'));
$('#lasso-select-tool').addEventListener('click', () => setTool('select-lasso'));
$('#magic-select-tool').addEventListener('click', () => setTool('select-color'));
$('#magic-tolerance').addEventListener('input', event => { $('#magic-tolerance-value').textContent = event.target.value; });
$('#selection-radius').addEventListener('input', event => { $('#selection-radius-value').textContent = `${event.target.value} px`; });
function modifyCurrentSelection(operation) {
  if (!selection || !doc.selectionMask) { status('Create a selection first', 'neutral'); return; }
  try {
    const mask = modifySelectionMask(doc.width, doc.height, doc.selectionMask, operation, Number($('#selection-radius').value));
    const bounds = selectionBounds(mask);
    selection = bounds ? { ...bounds, shape: 'mask', customMask: mask } : null;
    selectionStart = null; selectionPointerId = null; syncSelectionMask();
    status(selection ? ({ invert: 'Selection inverted', expand: 'Selection expanded', contract: 'Selection contracted' })[operation] : 'Selection is empty', 'success'); render();
  } catch (error) { status(error.message, 'error'); }
}
$('#selection-invert').addEventListener('click', () => modifyCurrentSelection('invert'));
$('#selection-expand').addEventListener('click', () => modifyCurrentSelection('expand'));
$('#selection-contract').addEventListener('click', () => modifyCurrentSelection('contract'));
function moveSelectionOutline(dx, dy) {
  if (!selection || !doc.selectionMask) { status('Create a selection first', 'neutral'); return; }
  const mask = translateSelectionMask(doc.width, doc.height, doc.selectionMask, dx, dy);
  const bounds = selectionBounds(mask);
  selection = bounds ? { ...bounds, shape: 'mask', customMask: mask } : null;
  syncSelectionMask();
  status(selection ? 'Selection outline moved without moving artwork' : 'Selection moved outside the canvas', 'success');
  render();
}
$('#selection-outline-move').addEventListener('click', event => {
  const button = event.target.closest('[data-selection-move]');
  if (!button) return;
  const offsets = button.dataset.selectionMove.split(',').map(Number);
  moveSelectionOutline(offsets[0], offsets[1]);
});

function clearTransformPreview() {
  transformPreview = null;
  $('#transform-apply').disabled = true;
  $('#transform-cancel').disabled = true;
  transformPreviewCanvas.width = 0; transformPreviewCanvas.height = 0;
}
function clearCropPreview() {
  cropPreview = null;
  $('#crop-apply').disabled = true;
  $('#crop-cancel').disabled = true;
}
function sameMask(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function readTransformOptions() {
  const scaleX = Number($('#transform-scale-x').value) / 100;
  const scaleY = Number($('#transform-scale-y').value) / 100;
  const skewX = Number($('#transform-skew-x').value) / 100;
  const skewY = Number($('#transform-skew-y').value) / 100;
  if (![scaleX, scaleY, skewX, skewY].every(Number.isFinite) || scaleX < .1 || scaleX > 8 || scaleY < .1 || scaleY > 8 || Math.abs(skewX) > 4 || Math.abs(skewY) > 4) {
    throw new RangeError('Scale must be 10–800%; skew must be -400–400%.');
  }
  return { scaleX, scaleY, skewX, skewY, rotate: Number($('#transform-rotation').value), interpolation: $('#transform-interpolation').value };
}
function requireSelection() {
  if (!selection || !doc.selectionMask) throw new Error('Create a selection first.');
  if (!selection.width || !selection.height) throw new Error('Selection bounds are empty.');
}
$('#transform-preview').addEventListener('click', () => {
  try {
    requireSelection();
    const options = readTransformOptions();
    const args = { x: selection.x, y: selection.y, width: selection.width, height: selection.height, options };
    const result = doc.previewTransformRect(args.x, args.y, args.width, args.height, options);
    if (!result.selectedPixels || !result.bounds) throw new Error('The transform contains no selected pixels inside the canvas.');
    transformPreviewCanvas.width = doc.width; transformPreviewCanvas.height = doc.height;
    transformPreviewCtx.clearRect(0, 0, doc.width, doc.height);
    transformPreviewCtx.putImageData(new ImageData(new Uint8ClampedArray(result.pixels), doc.width, doc.height), 0, 0);
    transformPreview = { ...args, result, docWidth: doc.width, docHeight: doc.height, revision: doc.revision, layerId: doc.activeLayerId, mask: new Uint8Array(doc.selectionMask) };
    clearCropPreview();
    $('#transform-apply').disabled = false; $('#transform-cancel').disabled = false;
    status(`Transform preview · ${result.selectedPixels.toLocaleString()} pixels · source remains unchanged`, 'success');
    render();
  } catch (error) { status(error.message, 'error'); }
});
$('#transform-apply').addEventListener('click', () => {
  if (!transformPreview) return;
  const pending = transformPreview;
  if (pending.docWidth !== doc.width || pending.docHeight !== doc.height || pending.revision !== doc.revision ||
      pending.layerId !== doc.activeLayerId || !sameMask(pending.mask, doc.selectionMask)) {
    clearTransformPreview(); render(); status('Preview became stale; create a new preview before applying', 'warning'); return;
  }
  try {
    const result = doc.transformRect(pending.x, pending.y, pending.width, pending.height, pending.options);
    selection = result.bounds ? { ...result.bounds, shape: 'mask', customMask: result.selectionMask } : null;
    clearTransformPreview(); clearCropPreview(); syncSelectionMask(); changed();
    status(`Transform applied · ${result.changedPixels.toLocaleString()} pixels changed · one undo step`, 'success');
  } catch (error) { status(error.message, 'error'); }
});
$('#transform-cancel').addEventListener('click', () => { clearTransformPreview(); render(); status('Transform preview cancelled; artwork unchanged', 'neutral'); });
for (const id of ['transform-scale-x','transform-scale-y','transform-skew-x','transform-skew-y','transform-rotation','transform-interpolation']) {
  $(`#${id}`).addEventListener('input', () => {
    if (transformPreview) { clearTransformPreview(); render(); status('Transform settings changed; preview again to review them', 'neutral'); }
  });
}
$('#crop-preview').addEventListener('click', () => {
  try {
    requireSelection();
    if (selection.x < 0 || selection.y < 0 || selection.x + selection.width > doc.width || selection.y + selection.height > doc.height) {
      throw new RangeError('Crop selection must be fully inside the canvas.');
    }
    clearTransformPreview();
    cropPreview = { x: selection.x, y: selection.y, width: selection.width, height: selection.height,
      docWidth: doc.width, docHeight: doc.height, revision: doc.revision, layerId: doc.activeLayerId, mask: new Uint8Array(doc.selectionMask) };
    $('#crop-apply').disabled = false; $('#crop-cancel').disabled = false;
    status(`Crop preview · canvas will become ${cropPreview.width} × ${cropPreview.height} px · no pixels changed yet`, 'success');
    render();
  } catch (error) { status(error.message, 'error'); }
});
$('#crop-apply').addEventListener('click', () => {
  if (!cropPreview) return;
  const pending = cropPreview;
  if (pending.docWidth !== doc.width || pending.docHeight !== doc.height || pending.revision !== doc.revision ||
      pending.layerId !== doc.activeLayerId || !sameMask(pending.mask, doc.selectionMask)) {
    clearCropPreview(); render(); status('Crop preview became stale; preview again before applying', 'warning'); return;
  }
  try {
    const didCrop = doc.cropCanvas(pending.x, pending.y, pending.width, pending.height);
    clearTransformPreview(); clearCropPreview(); selection = null; selectionStart = null; selectionPointerId = null;
    syncSelectionMask(); fitCanvas(); resetAIWorkspaceForDocument(); render(); updateTitle(); scheduleAutosave();
    status(didCrop ? `Canvas cropped to ${doc.width} × ${doc.height} px · undo restores every layer` : 'Crop matches the current canvas; no change made', didCrop ? 'success' : 'neutral');
  } catch (error) { status(error.message, 'error'); }
});
$('#crop-cancel').addEventListener('click', () => { clearCropPreview(); render(); status('Crop preview cancelled; canvas unchanged', 'neutral'); });
canvas.addEventListener('pointerdown', event => {
  if (!transformPreview && !cropPreview) return;
  event.preventDefault(); event.stopImmediatePropagation();
  status('Finish or cancel the active preview before editing the canvas', 'warning');
}, true);

const selectionTransformActions = document.createElement('div');
selectionTransformActions.className = 'transform-actions selection-transform-actions';
selectionTransformActions.setAttribute('aria-label', 'Move or rotate selected pixels');
selectionTransformActions.innerHTML = '<button type="button" data-transform="left" title="Move selected pixels one pixel left">←</button><button type="button" data-transform="right" title="Move selected pixels one pixel right">→</button><button type="button" data-transform="up" title="Move selected pixels one pixel up">↑</button><button type="button" data-transform="down" title="Move selected pixels one pixel down">↓</button><button type="button" data-transform="rotate-left" title="Rotate selected pixels 90 degrees counter-clockwise">↶ 90°</button><button type="button" data-transform="rotate-half" title="Rotate selected pixels 180 degrees">↻ 180°</button><button type="button" data-transform="rotate-right" title="Rotate selected pixels 90 degrees clockwise">↷ 90°</button>';
$('#selection-settings').append(selectionTransformActions);
selectionTransformActions.addEventListener('click', event => {
  const button = event.target.closest('button[data-transform]');
  if (!button || !selection) return;
  const action = button.dataset.transform;
  const options = action === 'left' ? { dx: -1 } : action === 'right' ? { dx: 1 } :
    action === 'up' ? { dy: -1 } : action === 'down' ? { dy: 1 } :
    action === 'rotate-left' ? { rotate: 270 } : action === 'rotate-half' ? { rotate: 180 } : { rotate: 90 };
  try {
    const result = doc.transformRect(selection.x, selection.y, selection.width, selection.height, options);
    if (!result.selectedPixels) { status('No selected pixels to transform', 'neutral'); return; }
    selection = result.bounds ? { ...result.bounds, shape: 'rect', customMask: result.selectionMask } : null;
    syncSelectionMask();
    changed();
    status(!result.bounds ? 'Selection moved beyond the canvas; off-canvas pixels were clipped' :
      result.changedPixels ? `Transformed selection · ${result.changedPixels.toLocaleString()} pixels changed` : 'Selection moved without changing visible pixels', 'success');
  } catch (error) { status(error.message, 'error'); }
});
$('#line-tool').addEventListener('click', () => setTool('shape-line'));
$('#rectangle-tool').addEventListener('click', () => setTool('shape-rect'));
$('#ellipse-tool').addEventListener('click', () => setTool('shape-ellipse'));
$('#gradient-tool').addEventListener('click', () => setTool('gradient'));
$('#symmetry-mode').addEventListener('change', event => {
  symmetryMode = Number(event.target.value) || 0;
  $('#symmetry-mode').setAttribute('aria-label', symmetryMode ? `Symmetry: ${symmetryMode} parts` : 'Symmetry: off');
  status(symmetryMode ? `Symmetry enabled: ${symmetryMode} parts` : 'Symmetry disabled', 'success');
  render();
});
$('#sample-source').addEventListener('change', event => { sampleMerged = event.target.value === 'merged'; });
$('#fill-tolerance').addEventListener('input', event => { fillTolerance = Number(event.target.value); $('#fill-tolerance-value').textContent = `${fillTolerance}`; });
$('#fill-mode').addEventListener('change', event => { fillContiguous = event.target.value === 'contiguous'; });
const mobileInspector = window.matchMedia('(max-width: 760px)');
function setInspectorPanel(panel) {
  const inspector = document.querySelector('.inspector');
  inspector.dataset.panel = panel;
  inspector.classList.toggle('show-layers', panel === 'layers' && mobileInspector.matches);
  if (mobileInspector.matches) inspector.scrollTop = 0;
  const panels = { properties: '#properties-tab', layers: '#layers-tab', ai: '#ai-tab' };
  for (const [name, selector] of Object.entries(panels)) {
    $(selector).classList.toggle('active', name === panel);
    $(selector).setAttribute('aria-selected', String(name === panel));
  }
  aiPanelVisible = panel === 'ai';
  if (aiPanelVisible) renderAIWorkspacePreview();
}
function scrollInspectorTo(selector) {
  const inspector = document.querySelector('.inspector');
  const target = $(selector);
  if (!inspector || !target) return;
  const inspectorTop = inspector.getBoundingClientRect().top;
  const targetTop = target.getBoundingClientRect().top;
  inspector.scrollTo({ top: inspector.scrollTop + targetTop - inspectorTop - 48, behavior: 'auto' });
}
$('#properties-tab').addEventListener('click', () => {
  setInspectorPanel('properties');
  if (!mobileInspector.matches) scrollInspectorTo('.inspector-section');
});
$('#layers-tab').addEventListener('click', () => {
  setInspectorPanel('layers');
  if (!mobileInspector.matches) scrollInspectorTo('#layers');
});
$('#ai-tab').addEventListener('click', () => {
  setInspectorPanel('ai');
  if (!mobileInspector.matches) scrollInspectorTo('#ai-workspace-panel');
  aiPanelVisible = true; renderAIWorkspacePreview();
});
$('#ai-sync').addEventListener('click', () => {
  const result = aiWorkspace.syncFromUser();
  if (result.status === 'synced') status('AI canvas synchronized from the original', 'success');
  else status(result.status === 'sandbox-pending' ? 'AI draft pending. Discard it before synchronizing.' : 'A proposal is pending. Discard it before synchronizing.', 'warning');
  renderAIWorkspacePreview();
});
$('#ai-configure-provider').addEventListener('click', () => {
  try {
    activeAIRequestController?.abort();
    aiProvider = new OpenAICompatibleProvider({
      endpoint: $('#ai-provider-endpoint').value.trim(),
      model: $('#ai-provider-model').value.trim(),
      apiKey: $('#ai-provider-key').value,
    });
    $('#ai-provider-key').value = '';
    aiCoordinator = new AIEditCoordinator({ workspace: aiWorkspace, session: aiCommandSession, provider: aiProvider });
    $('#ai-connection-state').textContent = 'Provider configured for ' + aiProvider.model + '. No network request is sent until you generate a proposal.';
    $('#ai-generate-proposal').disabled = Boolean(activeAIRequestController);
    status('Provider configured in memory. No network request has been sent.', 'success');
  } catch (error) {
    status(error instanceof Error ? error.message : 'Provider configuration is invalid.', 'error');
  }
});
$('#ai-cancel-request').addEventListener('click', () => {
  if (activeAIRequestController) {
    activeAIRequestController.abort();
    status('Cancelling AI request…', 'warning');
  }
});
$('#ai-generate-proposal').addEventListener('click', async () => {
  if (!aiCoordinator) { status('Configure an AI provider first.', 'warning'); return; }
  if (activeAIRequestController) return;
  const prompt = $('#ai-prompt').value.trim();
  if (!prompt) { status('Describe the change you want first.', 'warning'); return; }
  const controller = new AbortController();
  activeAIRequestController = controller;
  $('#ai-generate-proposal').disabled = true;
  $('#ai-cancel-request').disabled = false;
  $('#ai-connection-state').textContent = 'Request in progress. The original canvas remains protected.';
  status('Asking the configured model for a structured edit plan…', 'neutral');
  try {
    const includeArtwork = $('#ai-send-artwork').checked;
    let imageDataUrl;
    if (includeArtwork) {
      const imageCanvas = document.createElement('canvas');
      imageCanvas.width = doc.width; imageCanvas.height = doc.height;
      const imageContext = imageCanvas.getContext('2d', { alpha: true });
      imageContext.putImageData(new ImageData(new Uint8ClampedArray(doc.composite()), doc.width, doc.height), 0, 0);
      imageDataUrl = imageCanvas.toDataURL('image/png');
    }
    const result = await aiCoordinator.requestEdit(prompt, {
      includeArtwork,
      ...(imageDataUrl ? { imageDataUrl } : {}),
      signal: controller.signal,
    });
    if (result.status === 'proposal') {
      $('#ai-preview-mode').value = 'changes';
      status('AI proposal ready for review. The original drawing has not been changed.', 'success');
    } else if (result.status === 'cancelled') {
      status('AI request cancelled. The original drawing is unchanged.', 'neutral');
    } else if (result.status === 'rejected' && result.reason === 'stale-source') {
      status('The original canvas changed while the model was thinking. Review the current canvas and try again.', 'warning');
    } else if (result.status === 'rejected' && result.reason === 'empty-plan') {
      status(result.summary || 'The model did not return an applicable edit.', 'warning');
    } else {
      status(result.message || result.error?.message || result.reason || 'The AI request could not be completed.', 'error');
    }
    renderAIWorkspacePreview();
    updateAIWorkspaceUI();
  } catch (error) {
    status(error instanceof Error ? error.message : 'The AI request failed.', 'error');
  } finally {
    if (activeAIRequestController === controller) activeAIRequestController = null;
    $('#ai-cancel-request').disabled = true;
    $('#ai-generate-proposal').disabled = !aiCoordinator;
    if (aiCoordinator) $('#ai-connection-state').textContent = 'Provider configured for ' + aiProvider.model + '. API key is memory-only; requests send artwork only when the checkbox is enabled.';
    updateAIWorkspaceUI();
  }
});
$('#ai-preview-mode').addEventListener('change', renderAIWorkspacePreview);
$('#ai-refresh-preview').addEventListener('click', () => { renderAIWorkspacePreview(); status('AI canvas preview refreshed', 'success'); });
$('#ai-discard-proposal').addEventListener('click', () => {
  const discarded = aiWorkspace.hasProposal ? aiWorkspace.discardProposal() : aiWorkspace.discardSandboxChanges();
  if (!discarded) { status('There is no proposal or AI draft to discard', 'neutral'); return; }
  renderAIWorkspacePreview(); status('AI suggestion discarded; original artwork is unchanged', 'success');
});
$('#ai-accept-proposal').addEventListener('click', () => {
  const result = aiWorkspace.acceptProposal();
  if (result.status !== 'applied') {
    updateAIWorkspaceUI();
    status(result.reason === 'stale-base' ? 'Proposal rejected: original canvas changed' : result.reason === 'proposal-changed' ? 'Proposal rejected: sandbox changed after review snapshot' : result.message || 'Proposal could not be applied', 'warning');
    return;
  }
  changed(); renderLayers(); renderAIWorkspacePreview();
  status('Proposal accepted · ' + result.changedPixels.toLocaleString() + ' pixels changed in ' + result.changedLayers + ' layer(s)', 'success');
});
mobileInspector.addEventListener('change', () => setInspectorPanel('properties'));
setInspectorPanel('properties');
function setTool(next) {
  if (cursorMode && !['draw', 'erase'].includes(next)) setCursorMode(false);
  if (activeStroke) finishActiveStroke(false);
  shapeGesture = null; gradientGesture = null;
  if (next === 'eyedropper' && tool !== 'eyedropper') returnTool = ['draw', 'erase'].includes(tool) ? tool : 'draw';
  drawHeld = false; drawHoldPointerId = null;
  tool = next;
  $('#brush-tool').classList.toggle('active', tool === 'draw');
  $('#eraser-tool').classList.toggle('active', tool === 'erase');
  $('#pan-tool').classList.toggle('active', tool === 'pan');
  $('#fill-tool').classList.toggle('active', tool === 'fill');
  $('#eyedropper-tool').classList.toggle('active', tool === 'eyedropper');
  $('#select-tool').classList.toggle('active', tool === 'select');
  $('#ellipse-select-tool').classList.toggle('active', tool === 'select-ellipse');
  $('#lasso-select-tool').classList.toggle('active', tool === 'select-lasso');
  $('#magic-select-tool').classList.toggle('active', tool === 'select-color');
  $('#line-tool').classList.toggle('active', tool === 'shape-line');
  $('#rectangle-tool').classList.toggle('active', tool === 'shape-rect');
  $('#ellipse-tool').classList.toggle('active', tool === 'shape-ellipse');
  $('#gradient-tool').classList.toggle('active', tool === 'gradient');
  $('#tool-label').textContent = ({ draw: 'Pencil', erase: 'Eraser', fill: 'Bucket fill', eyedropper: 'Eyedropper', select: 'Rectangular selection', 'select-ellipse': 'Elliptical selection', 'select-lasso': 'Lasso selection', 'select-color': 'Magic wand selection', pan: 'Pan', 'shape-line': 'Line', 'shape-rect': 'Rectangle', 'shape-ellipse': 'Ellipse', gradient: 'Linear gradient' })[tool] ?? 'Pencil';
  $('#fill-settings').hidden = tool !== 'fill';
  $('#sample-settings').hidden = tool !== 'eyedropper';
  $('#magic-settings').hidden = tool !== 'select-color';
  if (!['select', 'select-ellipse', 'select-lasso'].includes(tool)) { selectionStart = null; selectionPointerId = null; }
  canvas.dataset.tool = tool;
  updateDrawHoldUI();
  render();
}
$('#color').addEventListener('input', event => applyForegroundColor(event.target.value));
$('#swap-colors').addEventListener('click', () => {
  const foreground = color; color = backgroundColor; backgroundColor = foreground;
  $('#color').value = color; $('#color-value').textContent = color.toUpperCase();
  syncBackgroundColor(); rememberColor(color);
  if (tool === 'erase') setTool('draw');
});
syncBackgroundColor();
rememberColor(color);
document.addEventListener('keydown', event => {
  if (event.key.toLowerCase() === 'x' && !event.ctrlKey && !event.metaKey && !event.altKey && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) {
    event.preventDefault(); $('#swap-colors').click();
  }
});
$('#create-outline').addEventListener('click', () => {
  try {
    const count = doc.createOutline(color);
    if (count) { changed(); status(`Added ${count.toLocaleString()} outline pixels`, 'success'); }
    else status('No transparent edge pixels to outline', 'neutral');
  } catch (error) { status(error.message, 'error'); }
});
function flipPixels(axis) {
  try {
    const rect = selection ?? { x: 0, y: 0, width: doc.width, height: doc.height };
    const count = doc.flipRect(rect.x, rect.y, rect.width, rect.height, axis);
    if (count) { changed(); status(`Flipped ${count.toLocaleString()} pixels ${axis === 'horizontal' ? 'horizontally' : 'vertically'}`, 'success'); }
    else status('Flip made no changes', 'neutral');
  } catch (error) { status(error.message, 'error'); }
}
$('#flip-horizontal').addEventListener('click', () => flipPixels('horizontal'));
$('#flip-vertical').addEventListener('click', () => flipPixels('vertical'));
$('#replace-color').addEventListener('click', () => {
  try {
    const count = doc.replaceColor($('#replace-source').value, color, 0);
    if (count) { changed(); status(`Replaced ${count.toLocaleString()} pixels with foreground color`, 'success'); }
    else status('No matching opaque pixels on the active layer', 'neutral');
  } catch (error) { status(error.message, 'error'); }
});
$('#fill-scale').addEventListener('input', event => { $('#fill-scale-value').textContent = `${event.target.value} px`; });
$('#brush-opacity').addEventListener('input', event => { $('#brush-opacity-value').textContent = `${event.target.value}%`; });
$('#brush-hardness').addEventListener('input', event => { $('#brush-hardness-value').textContent = `${event.target.value}%`; });
$('#brush-size').addEventListener('input', event => {
  brushSize = Number(event.target.value); $('#brush-size-value').textContent = `${brushSize} px`;
});
const brushScrub = $('#brush-scrub');
let scrubStartX = 0, scrubStartSize = brushSize, scrubPointerId = null;
function syncBrushSize(value) {
  brushSize = Math.max(1, Math.min(32, Math.round(value)));
  $('#brush-size').value = String(brushSize);
  $('#brush-size-value').textContent = `${brushSize} px`;
  brushScrub.setAttribute('aria-valuenow', String(brushSize));
  brushScrub.setAttribute('aria-valuetext', `${brushSize} pixel${brushSize === 1 ? '' : 's'}. Drag left for thicker, right for thinner.`);
}
function resetBrushScrub() {
  brushScrub.classList.remove('is-dragging');
  brushScrub.style.setProperty('--scrub-offset', '0%');
  scrubPointerId = null;
}
brushScrub.addEventListener('pointerdown', event => {
  if (event.pointerType !== 'touch' && event.button !== undefined && event.button !== 0) return;
  if (cursorMode && ['draw', 'erase'].includes(tool) && virtualCursorPoint?.inside && !flushInProgress && !activeStroke) {
    cursorDrawPointerId = event.pointerId;
    startStrokeAt(virtualCursorPoint, event.pointerId);
  }
  const rect = brushScrub.getBoundingClientRect();
  scrubStartX = rect.left + rect.width / 2;
  scrubStartSize = brushSize;
  scrubPointerId = event.pointerId;
  brushScrub.classList.add('is-dragging');
  brushScrub.style.setProperty('--scrub-offset', '0%');
  try { brushScrub.setPointerCapture(event.pointerId); } catch {}
  event.preventDefault();
});
brushScrub.addEventListener('pointermove', event => {
  if (scrubPointerId !== event.pointerId) return;
  const rect = brushScrub.getBoundingClientRect();
  const travel = Math.max(1, rect.width * 0.34);
  const displacement = Math.max(-1, Math.min(1, (event.clientX - scrubStartX) / travel));
  const eased = Math.pow(Math.abs(displacement), 1.8);
  const nextSize = displacement < 0
    ? scrubStartSize + (32 - scrubStartSize) * eased
    : scrubStartSize - (scrubStartSize - 1) * eased;
  syncBrushSize(nextSize);
  brushScrub.style.setProperty('--scrub-offset', `${displacement * 34}%`);
});
function finishBrushScrub(event) {
  if (scrubPointerId === null || (event?.pointerId !== undefined && event.pointerId !== scrubPointerId)) return;
  if (cursorDrawPointerId !== null && (event?.pointerId === undefined || event.pointerId === cursorDrawPointerId)) {
    if (activeStroke && pointerId === cursorDrawPointerId) finishActiveStroke(true);
    cursorDrawPointerId = null;
  }
  resetBrushScrub();
}
brushScrub.addEventListener('pointerup', finishBrushScrub);
brushScrub.addEventListener('pointercancel', finishBrushScrub);
brushScrub.addEventListener('lostpointercapture', finishBrushScrub);
brushScrub.addEventListener('keydown', event => {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { syncBrushSize(brushSize + 1); event.preventDefault(); }
  else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { syncBrushSize(brushSize - 1); event.preventDefault(); }
  else if (event.key === 'Home') { syncBrushSize(1); event.preventDefault(); }
  else if (event.key === 'End') { syncBrushSize(32); event.preventDefault(); }
});

function undoDocument() {
  const beforeWidth = doc.width, beforeHeight = doc.height;
  if (!doc.undo()) return false;
  changed(); renderLayers();
  if (doc.width !== beforeWidth || doc.height !== beforeHeight) fitCanvas();
  return true;
}
function redoDocument() {
  const beforeWidth = doc.width, beforeHeight = doc.height;
  if (!doc.redo()) return false;
  changed(); renderLayers();
  if (doc.width !== beforeWidth || doc.height !== beforeHeight) fitCanvas();
  return true;
}
$('#undo').addEventListener('click', undoDocument);
$('#redo').addEventListener('click', redoDocument);
$('#fit').addEventListener('click', fitCanvas);
$('#grid-toggle').addEventListener('click', () => {
  gridEnabled = !gridEnabled;
  const button = $('#grid-toggle');
  button.textContent = `Pixel grid: ${gridEnabled ? 'On' : 'Off'}`;
  button.setAttribute('aria-pressed', String(gridEnabled));
  if (gridEnabled && zoom < 4) status('Pixel grid enabled; zoom to 400% or more to see individual cells', 'neutral');
  else status(gridEnabled ? 'Pixel grid overlay enabled' : 'Pixel grid overlay hidden', 'success');
  render();
});
const viewportCenter = () => ({ x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 });
$('#zoom-in').addEventListener('click', () => zoomAt(viewportCenter(), zoom * 1.25));
$('#zoom-out').addEventListener('click', () => zoomAt(viewportCenter(), zoom / 1.25));
$('#add-layer').addEventListener('click', () => {
  try { doc.addLayer(); changed(); renderLayers(); status('Layer added', 'success'); }
  catch (error) { status(error.message, 'error'); }
});
$('#projects-button').addEventListener('click', async () => {
  try {
    await flushAutosave();
    await renderProjects();
    $('#projects-dialog').showModal();
  } catch (error) { status(`Could not open saved projects: ${error.message}`, 'error'); }
});
$('#close-projects').addEventListener('click', () => $('#projects-dialog').close());
async function renderProjects() {
  const list = $('#projects-list'); list.replaceChildren();
  const projects = await listSavedProjects();
  if (!projects.length) {
    const empty = document.createElement('p'); empty.className = 'project-empty';
    empty.textContent = 'No saved projects yet. Draw something and save it to see it here.';
    list.append(empty); return;
  }
  for (const project of projects) {
    const row = document.createElement('div'); row.className = 'saved-project';
    const open = document.createElement('button'); open.className = 'saved-project-open'; open.dataset.projectId = project.id;
    open.textContent = project.name || 'Untitled artwork';
    const details = document.createElement('small'); details.textContent = `${project.width} × ${project.height}`;
    open.append(details);
    if (project.id === doc.id) { open.disabled = true; open.classList.add('current'); }
    open.addEventListener('click', async () => {
      try {
        await flushAutosave();
        const saved = await loadProjectById(project.id);
        if (!saved) throw new Error('That saved project no longer exists.');
        doc = RasterDocument.fromJSON(saved); clearSelectionState(); resetAIWorkspaceForDocument();
        $('#projects-dialog').close(); fitCanvas(); updateTitle(); renderLayers();
        status('Opened saved project', 'success');
      } catch (error) { status(`Could not open project: ${error.message}`, 'error'); }
    });
    row.append(open); list.append(row);
  }
}

const assetTemplates = {
  custom: { width: 128, height: 128, name: 'Untitled artwork', layers: ['Layer 1'] },
  character: { width: 64, height: 64, name: 'Character sprite', layers: ['Sketch', 'Lineart', 'Color', 'Shading'] },
  icon: { width: 32, height: 32, name: 'Game icon', layers: ['Base', 'Details', 'Highlights'] },
  tile: { width: 32, height: 32, name: 'Environment tile', layers: ['Base', 'Details', 'Edges'] },
  ui: { width: 128, height: 64, name: 'UI element', layers: ['Base', 'Border', 'Details'] },
  background: { width: 256, height: 144, name: 'Background scene', layers: ['Far', 'Middle', 'Foreground'] },
  effect: { width: 64, height: 64, name: 'VFX sprite', layers: ['Core', 'Glow', 'Particles'] }
};
$('#new-template').addEventListener('change', event => {
  const template = assetTemplates[event.target.value] ?? assetTemplates.custom;
  $('#new-width').value = String(template.width); $('#new-height').value = String(template.height);
  if (!$('#new-name').value.trim() || $('#new-name').value === 'Untitled artwork' || Object.values(assetTemplates).some(item => item.name === $('#new-name').value)) {
    $('#new-name').value = template.name;
  }
});
$('#new-document').addEventListener('click', () => $('#new-dialog').showModal());
$('#cancel-new').addEventListener('click', () => $('#new-dialog').close());
$('#create-new').addEventListener('click', async () => {
  const width = Number($('#new-width').value), height = Number($('#new-height').value);
  try {
    validateDimensions(width, height); await flushAutosave();
    const template = assetTemplates[$('#new-template').value] ?? assetTemplates.custom;
    doc = new RasterDocument(width, height, $('#new-name').value.trim() || template.name); clearSelectionState();
    const firstLayer = doc.activeLayerId;
    if (template.layers[0] && template.layers[0] !== doc.activeLayer.name) doc.renameLayer(firstLayer, template.layers[0]);
    for (const layerName of template.layers.slice(1)) doc.addLayer(layerName);
    doc.setActiveLayer(firstLayer);
    // Template scaffolding is the initial document state, not user undo history.
    doc.history.length = 0; doc.future.length = 0; doc.historyBytes = 0; doc.revision = 0; doc.saveVersion = 0; doc.dirty = false;
    resetAIWorkspaceForDocument();
    $('#new-dialog').close(); fitCanvas(); updateTitle(); renderLayers(); scheduleAutosave();
    status(template.layers.length > 1 ? `Created ${template.name} template with ${template.layers.length} layers` : 'New document created', 'success');
  } catch (error) { $('#new-error').textContent = error.message; status(`Could not switch documents: ${error.message}`, 'error'); }
});
$('#save').addEventListener('click', async () => {
  try { await flushAutosave({ force: true }); status('Saved on this device', 'success'); }
  catch (error) { status(`Save failed: ${error.message}`, 'error'); }
});
$('#export-project').addEventListener('click', () => {
  try {
    settleActiveInput();
    const snapshot = doc.toJSON(), filename = `${safeName(doc.name)}.pforge`;
    downloadBlob(new Blob([JSON.stringify(snapshot)], { type: 'application/json' }), filename);
    status('Project exported', 'success');
  } catch (error) { status(`Project export failed: ${error.message}`, 'error'); }
});
$('#export-sprite-sheet').addEventListener('click', async () => {
  try {
    settleActiveInput();
    const layout = createSpriteSheetLayout(doc.layers.length, doc.width, doc.height, { columns: Math.ceil(Math.sqrt(doc.layers.length)), padding: 1 });
    const sheet = document.createElement('canvas'); sheet.width = layout.width; sheet.height = layout.height;
    const context = sheet.getContext('2d', { alpha: true });
    if (!context) throw new Error('Could not create the sprite sheet export surface.');
    context.clearRect(0, 0, sheet.width, sheet.height);
    const frames = layout.frames.map((frame, index) => {
      const layer = doc.layers[index];
      context.putImageData(new ImageData(new Uint8ClampedArray(layer.pixels), doc.width, doc.height), frame.x, frame.y);
      return { ...frame, name: layer.name, visible: layer.visible, opacity: layer.opacity, locked: layer.locked };
    });
    const manifest = { format: 'pixelforge-sprite-sheet', version: 1, document: doc.name, sheet: { width: layout.width, height: layout.height, columns: layout.columns, rows: layout.rows, padding: layout.padding }, frameSize: { width: doc.width, height: doc.height }, pivot: 'center', frames };
    const png = await new Promise((resolve, reject) => sheet.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG encoder returned no data.')), 'image/png'));
    downloadBlob(png, `${safeName(doc.name)}-spritesheet.png`);
    downloadBlob(new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }), `${safeName(doc.name)}-spritesheet.json`);
    status(`Sprite sheet exported: ${frames.length} frames, ${layout.width} × ${layout.height}`, 'success');
  } catch (error) { status(`Sprite sheet export failed: ${error.message}`, 'error'); }
});
$('#export-png').addEventListener('click', () => {
  try {
    settleActiveInput();
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = doc.width; exportCanvas.height = doc.height;
    const exportName = `${safeName(doc.name)}.png`;
    const exportContext = exportCanvas.getContext('2d');
    if (!exportContext) throw new Error('Could not create the PNG export surface.');
    exportContext.putImageData(new ImageData(new Uint8ClampedArray(doc.composite()), doc.width, doc.height), 0, 0);
    exportCanvas.toBlob(blob => {
      if (blob) { downloadBlob(blob, exportName); status('PNG exported', 'success'); }
      else status('PNG export failed', 'error');
    }, 'image/png');
  } catch (error) { status(`PNG export failed: ${error.message}`, 'error'); }
});
$('#import-file').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file) return;
  try {
    if (file.size > 100 * 1024 * 1024) throw new RangeError('This file is larger than the 100 MiB import safety limit.');
    let importedDoc;
    if (file.name.toLowerCase().endsWith('.pforge') || file.type === 'application/json') {
      importedDoc = RasterDocument.fromJSON(JSON.parse(await file.text()), { newIdentity: true });
    } else {
      const expectedImage = await preflightImageFile(file);
      const bitmap = await createImageBitmap(file);
      try {
        if (!((bitmap.width === expectedImage.width && bitmap.height === expectedImage.height) || (bitmap.width === expectedImage.height && bitmap.height === expectedImage.width))) throw new RangeError('Decoded image dimensions do not match the verified file header.');
        validateDimensions(bitmap.width, bitmap.height);
        const name = file.name.includes('.') ? file.name.slice(0, file.name.lastIndexOf('.')) : file.name;
        importedDoc = new RasterDocument(bitmap.width, bitmap.height, name || 'Imported artwork');
        const temp = document.createElement('canvas'); temp.width = bitmap.width; temp.height = bitmap.height;
        const tctx = temp.getContext('2d', { willReadFrequently: true });
        tctx.drawImage(bitmap, 0, 0);
        importedDoc.activeLayer.pixels.set(tctx.getImageData(0, 0, bitmap.width, bitmap.height).data);
      } finally { bitmap.close?.(); }
    }
    await flushAutosave(); await saveProject(importedDoc.toJSON()); doc = importedDoc; clearSelectionState();
    fitCanvas(); updateTitle(); renderLayers(); status('Import complete and saved locally', 'success');
  } catch (error) { status(`Import failed: ${error.message}`, 'error'); }
  finally { event.target.value = ''; }
});
function renderLayers() {
  const list = $('#layers'); list.replaceChildren();
  [...doc.layers].reverse().forEach(layer => {
    const row = document.createElement('div');
    row.className = `layer-row${layer.id === doc.activeLayerId ? ' selected' : ''}`;
    const layerIndex = doc.layers.findIndex(item => item.id === layer.id);
    const select = document.createElement('button');
    select.className = 'layer-select'; select.textContent = layer.name; select.title = 'Select layer';
    select.addEventListener('click', () => { doc.setActiveLayer(layer.id); renderLayers(); updateTitle(); scheduleAutosave(); });
    const visibility = document.createElement('button');
    visibility.className = 'layer-visibility'; visibility.textContent = layer.visible ? '◉' : '○';
    visibility.setAttribute('aria-label', layer.visible ? 'Hide layer' : 'Show layer');
    visibility.setAttribute('aria-pressed', String(layer.visible));
    visibility.addEventListener('click', () => { doc.setLayerVisibility(layer.id, !layer.visible); changed(); renderLayers(); });
    const lock = document.createElement('button');
    lock.className = 'layer-visibility layer-lock'; lock.textContent = layer.locked ? '🔒' : '♧';
    lock.setAttribute('aria-label', layer.locked ? 'Unlock layer' : 'Lock layer');
    lock.setAttribute('aria-pressed', String(layer.locked));
    lock.title = layer.locked ? 'Unlock layer for editing' : 'Lock layer against edits';
    lock.addEventListener('click', () => {
      doc.setLayerLocked(layer.id, !layer.locked);
      changed(); renderLayers();
      status(layer.locked ? 'Layer locked' : 'Layer unlocked', 'success');
    });
    const order = document.createElement('div'); order.className = 'layer-order-controls';
    const raise = document.createElement('button');
    raise.className = 'layer-order'; raise.textContent = '↑'; raise.title = 'Raise layer';
    raise.setAttribute('aria-label', 'Raise layer'); raise.disabled = layerIndex === doc.layers.length - 1;
    raise.addEventListener('click', () => {
      if (doc.moveLayer(layer.id, layerIndex + 1)) { changed(); renderLayers(); status('Layer moved up', 'success'); }
    });
    const lower = document.createElement('button');
    lower.className = 'layer-order'; lower.textContent = '↓'; lower.title = 'Lower layer';
    lower.setAttribute('aria-label', 'Lower layer'); lower.disabled = layerIndex === 0;
    lower.addEventListener('click', () => {
      if (doc.moveLayer(layer.id, layerIndex - 1)) { changed(); renderLayers(); status('Layer moved down', 'success'); }
    });
    order.append(raise, lower);
    row.append(visibility, select, lock, order); list.append(row);
  });
  const opacityInput = $('#layer-opacity');
  if (opacityInput) {
    opacityInput.value = String(Math.round((doc.activeLayer?.opacity ?? 1) * 100));
    $('#layer-opacity-value').textContent = `${opacityInput.value}%`;
    opacityInput.disabled = !doc.activeLayer;
    $('#rename-layer').disabled = !doc.activeLayer;
    $('#duplicate-layer').disabled = !doc.activeLayer || doc.layers.length >= 64;
    $('#delete-layer').disabled = !doc.activeLayer || doc.layers.length <= 1;
  }
  updateDrawHoldUI();
}
$('#layer-opacity')?.addEventListener('input', event => {
  $('#layer-opacity-value').textContent = `${event.target.value}%`;
});
$('#layer-opacity')?.addEventListener('change', event => {
  try {
    if (doc.setLayerOpacity(doc.activeLayer.id, Number(event.target.value) / 100)) {
      changed(); renderLayers(); status('Layer opacity updated', 'success');
    }
  } catch (error) { status(error.message, 'error'); renderLayers(); }
});
$('#rename-layer')?.addEventListener('click', () => {
  const layer = doc.activeLayer;
  if (!layer) return;
  const name = window.prompt('Layer name', layer.name);
  if (name === null) return;
  try {
    if (doc.renameLayer(layer.id, name)) { changed(); renderLayers(); status('Layer renamed', 'success'); }
  } catch (error) { status(error.message, 'error'); }
});
$('#duplicate-layer')?.addEventListener('click', () => {
  try { doc.duplicateLayer(doc.activeLayer.id); changed(); renderLayers(); status('Layer duplicated', 'success'); }
  catch (error) { status(error.message, 'error'); }
});
$('#delete-layer')?.addEventListener('click', () => {
  const layer = doc.activeLayer;
  if (!layer || doc.layers.length <= 1 || !window.confirm(`Delete layer "${layer.name}"? This can be undone.`)) return;
  try { doc.deleteLayer(layer.id); changed(); renderLayers(); status('Layer deleted', 'success'); }
  catch (error) { status(error.message, 'error'); }
});
function safeName(value) { return (value || 'pixelforge-artwork').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'pixelforge-artwork'; }
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
window.addEventListener('keydown', event => {
  const active = document.activeElement;
  const tag = active?.tagName;
  const textEntry = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || active?.isContentEditable;
  const nativeControl = active?.matches?.('button, select, summary, a[href], [role="button"]');
  const modifiedShortcut = event.ctrlKey || event.metaKey;
  if (event.code === 'Space' && !textEntry && !nativeControl) {
    event.preventDefault(); spaceDown = true;
    if (activeStroke) finishActiveStroke(false);
    drawHeld = false; drawHoldPointerId = null;
    virtualCursorPointerId = null; virtualCursorPoint = null; virtualCursorVisible = false;
    updateDrawHoldUI(); render();
  }
  if (textEntry) return;
  if (nativeControl && !modifiedShortcut && event.key !== 'Escape' && !((event.key === 'Delete' || event.key === 'Backspace') && selection)) return;
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'i' && selection) {
    event.preventDefault(); modifyCurrentSelection('invert'); return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
    event.preventDefault();
    selection = { x: 0, y: 0, width: doc.width, height: doc.height };
    selectionStart = null; selectionPointerId = null; syncSelectionMask();
    status('Selected entire canvas', 'success'); render(); return;
  }
  if ((event.ctrlKey || event.metaKey) && ['c', 'x', 'v'].includes(event.key.toLowerCase())) {
    event.preventDefault();
    try {
      const command = event.key.toLowerCase();
      if (command === 'c' || command === 'x') {
        if (!selection) { status('Select a pixel region before copying or cutting', 'neutral'); return; }
        pixelClipboard = doc.copyRect(selection.x, selection.y, selection.width, selection.height);
        if (command === 'x') {
          const cleared = doc.clearRect(selection.x, selection.y, selection.width, selection.height);
          if (cleared) changed();
          status(cleared ? 'Selection cut to internal clipboard' : 'Selection copied; no opaque pixels to cut', 'success');
        } else status(`Copied ${pixelClipboard.width} × ${pixelClipboard.height} pixels`, 'success');
      } else {
        if (!pixelClipboard) { status('Pixel clipboard is empty', 'neutral'); return; }
        const x = selection?.x ?? pixelClipboard.x, y = selection?.y ?? pixelClipboard.y;
        const pasted = doc.pasteRect(pixelClipboard, { x, y });
        if (pasted) { changed(); status(`Pasted ${pasted.toLocaleString()} pixels`, 'success'); }
        else status('Paste made no changes (check layer lock and selection)', 'neutral');
      }
    } catch (error) { status(error.message, 'error'); }
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault(); $('#save').click(); return;
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault(); if (event.shiftKey) redoDocument(); else undoDocument();
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
    event.preventDefault(); redoDocument();
  } else if (event.key.toLowerCase() === 'b') setTool('draw');
  else if (event.key.toLowerCase() === 'e') setTool('erase');
  else if (event.key.toLowerCase() === 'g') setTool('fill');
  else if (event.key.toLowerCase() === 'i') setTool('eyedropper');
  else if (event.key.toLowerCase() === 'm') setTool(event.shiftKey ? 'select-ellipse' : 'select');
  else if (event.key.toLowerCase() === 'l') setTool('shape-line');
  else if (event.key.toLowerCase() === 'u') setTool('shape-rect');
  else if (event.key.toLowerCase() === 'o') setTool('shape-ellipse');
  else if (event.key.toLowerCase() === 'd') setTool('gradient');
  else if ((event.key === 'Delete' || event.key === 'Backspace') && selection) {
    event.preventDefault();
    try {
      const cleared = doc.clearRect(selection.x, selection.y, selection.width, selection.height);
      selection = null; selectionStart = null; selectionPointerId = null; syncSelectionMask();
      if (cleared) { changed(); status(`Cleared ${cleared.toLocaleString()} pixels from selection`, 'success'); }
      else { render(); status('Selection was already transparent', 'neutral'); }
    } catch (error) { status(error.message, 'error'); }
  }
  else if (event.key === 'Escape') {
    if (transformPreview) { clearTransformPreview(); status('Transform preview cancelled; artwork unchanged', 'neutral'); }
    if (cropPreview) { clearCropPreview(); status('Crop preview cancelled; canvas unchanged', 'neutral'); }
    if (shapeGesture) { shapeGesture = null; status('Shape preview cancelled', 'neutral'); }
    if (gradientGesture) { gradientGesture = null; status('Gradient preview cancelled', 'neutral'); }
    if (selection) { selection = null; selectionStart = null; selectionPointerId = null; syncSelectionMask(); status('Selection cleared', 'neutral'); }
    if (activeStroke) finishActiveStroke(false);
    drawHeld = false; drawHoldPointerId = null;
    virtualCursorPointerId = null; virtualCursorPoint = null; virtualCursorVisible = false;
    if (panning) { panning = false; panStart = null; canvas.classList.remove('is-panning'); }
    updateDrawHoldUI(); render();
  }
});
window.addEventListener('resize', resizeCanvas);
window.addEventListener('keyup', event => { if (event.code === 'Space') spaceDown = false; });
window.addEventListener('blur', () => {
  spaceDown = false; drawHeld = false; drawHoldPointerId = null;
  if (activeStroke) finishActiveStroke(false);
  virtualCursorPointerId = null; virtualCursorPoint = null; virtualCursorVisible = false; virtualCursorCanDraw = false; updateDrawHoldUI();
  if (panning) { panning = false; panStart = null; canvas.classList.remove('is-panning'); }
  render();
});
async function boot() {
  resizeCanvas();
  try {
    const saved = await loadMostRecentProject();
    if (saved) { doc = RasterDocument.fromJSON(saved); clearSelectionState(); resetAIWorkspaceForDocument(); status('Recovered latest local project', 'success'); }
    else status('Ready · saved locally on this device', 'success');
  } catch (error) { status(`Local recovery unavailable: ${error.message}`, 'warning'); }
  fitCanvas(); updateTitle(); renderLayers();
}
boot();
