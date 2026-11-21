import { buildReferenceFromProject, normalizeDrawingModel, getReferenceEntry, normalizeSemanticPart, setCurrentState, recordEnvironmentHistory } from './drawing-intelligence.js';

export function createReferenceCenterUI({
  getDocument,
  getAnimation,
  save,
  setAnimation = null,
  render,
  renderLayers,
  status,
  onDocumentChanged = () => {},
} = {}) {
  const doc = () => getDocument();
  const animation = () => getAnimation();

  const host = document.createElement('section');
  host.className = 'inspector-section reference-center-section';
  host.innerHTML = `
    <div class="section-heading"><span class="section-icon">◎</span><h2>Reference Center</h2><span class="tiny-tag">ASSETS</span></div>
    <p class="small-note">Immutable visual assets. Copying creates an editable instance; the original reference never changes.</p>
    <div class="reference-center-actions">
      <button id="reference-package-current" class="file-button" type="button">＋ Package current</button>
      <button id="reference-save-state" class="file-button" type="button">◉ Save current state</button>
      <button id="reference-record-environment" class="file-button" type="button">🌎 Record environment</button>
      <button id="reference-refresh" class="file-button" type="button">↻ Refresh</button>
    </div>
    <div class="reference-center-context">
      <label>Previous layers <input id="reference-prev-opacity" type="range" min="0" max="100" value="25"></label>
      <span id="reference-prev-opacity-value">25%</span>
      <label>Next layers <input id="reference-next-opacity" type="range" min="0" max="100" value="15"></label>
      <span id="reference-next-opacity-value">15%</span>
    </div>
    <div id="reference-state-summary" class="reference-center-context"></div>
    <div class="reference-environment-history">
      <div class="reference-center-actions">
        <button id="reference-environment-preview" class="file-button" type="button">▶ Preview environment</button>
        <button id="reference-environment-stop" class="file-button" type="button" disabled>■ Stop</button>
      </div>
      <canvas id="reference-environment-canvas" class="reference-environment-canvas" aria-label="Environment-only history preview"></canvas>
      <div id="reference-environment-list" class="reference-parts"></div>
    </div>
    <div id="reference-center-list" class="reference-center-list"></div>
  `;
  const layerSection = document.querySelector('.layer-section');
  layerSection?.after(host);

  const list = host.querySelector('#reference-center-list');
  const stateSummary = host.querySelector('#reference-state-summary');
  const environmentCanvas = host.querySelector('#reference-environment-canvas');
  const environmentList = host.querySelector('#reference-environment-list');
  const environmentPreviewButton = host.querySelector('#reference-environment-preview');
  const environmentStopButton = host.querySelector('#reference-environment-stop');
  let environmentPreviewTimer = null;
  let environmentPreviewEntries = [];
  let environmentPreviewIndex = 0;
  const prevRange = host.querySelector('#reference-prev-opacity');
  const nextRange = host.querySelector('#reference-next-opacity');
  const prevValue = host.querySelector('#reference-prev-opacity-value');
  const nextValue = host.querySelector('#reference-next-opacity-value');

  function contextOpacity() {
    const d = doc();
    const active = d.layers.findIndex(layer => layer.id === d.activeLayerId);
    if (active < 0) return;
    const previous = Number(prevRange.value) / 100;
    const next = Number(nextRange.value) / 100;
    d.layers.forEach((layer, index) => {
      const distance = index - active;
      if (distance === 0) layer.opacity = 1;
      else if (distance < 0) layer.opacity = previous;
      else layer.opacity = next;
    });
    d.dirty = true;
    d.saveVersion++;
    prevValue.textContent = Math.round(previous * 100) + '%';
    nextValue.textContent = Math.round(next * 100) + '%';
    render();
    renderLayers();
    onDocumentChanged();
  }

  prevRange.addEventListener('input', contextOpacity);
  nextRange.addEventListener('input', contextOpacity);

  function packageCurrent() {
    const d = doc();
    const currentAnimation = animation();
    const snapshot = d.toJSON();
    if (currentAnimation) snapshot.animation = JSON.parse(JSON.stringify(currentAnimation.toJSON()));
    const model = normalizeDrawingModel(d.getDrawingModel(), { width: d.width, height: d.height });
    const name = window.prompt('Reference name', d.name || 'Drawing reference');
    if (!name?.trim()) return;
    const entry = buildReferenceFromProject({ projectId: d.id, project: snapshot, name: name.trim() });
    entry.type = 'asset';
    entry.category = /dust|powder|smoke|fire|spark|particle/i.test(name) ? 'effect'
      : /character|soldier|robot|person|hero/i.test(name) ? 'character'
      : /scene|background|forest|building|environment/i.test(name) ? 'scene' : 'object';
    entry.parts = entry.parts.map((part, index) => normalizeSemanticPart({
      ...part,
      role: index === 0 ? 'background' : 'component',
      name: part.name || `Part ${index + 1}`,
      anchors: { center: null },
    }));
    model.referenceCenter.entries.push(entry);
    model.referenceCenter.activeEntryId = entry.id;
    d.setDrawingModel(model);

    const clean = d.layers[0];
    d.setLayerPixels(clean.id, new Uint8Array(d.width * d.height * 4));
    d.renameLayer(clean.id, 'Layer 1');
    for (const layer of [...d.layers].slice(1)) d.deleteLayer(layer.id);
    d.setLayerVisibility(clean.id, true);
    d.setLayerLocked(clean.id, false);
    d.setLayerOpacity(clean.id, 1);
    d.setActiveLayer(clean.id);

    if (currentAnimation) {
      // The current timeline belongs to the packaged snapshot. A reference
      // center transfer deliberately leaves the editor without animation.
      // A later copy-frame operation creates a fresh editable timeline.
      setAnimation?.(null);
    }

    d.dirty = true;
    status(`Packaged “${entry.name}” into Reference Center · editor cleaned`, 'success');
    render();
    renderLayers();
    onDocumentChanged();
    refresh();
    void save();
  }

  function copyPart(entry, part) {
    const d = doc();
    const layer = d.addLayer(`${entry.name} · ${part.name}`);
    const pixels = part.pixels ? Uint8Array.from(atob(part.pixels), c => c.charCodeAt(0)) : null;
    if (pixels && pixels.length === layer.pixels.length) d.setLayerPixels(layer.id, pixels);
    else if (part.layerId) {
      const source = entry.layerSnapshot?.find(item => item.id === part.layerId);
      if (source?.pixels) d.setLayerPixels(layer.id, Uint8Array.from(atob(source.pixels), c => c.charCodeAt(0)));
    }
    d.setActiveLayer(layer.id);
    d.dirty = true;
    status(`Copied “${part.name}” as editable layer`, 'success');
    render(); renderLayers(); onDocumentChanged(); void save();
  }

  function copyFrame(entry, frameIndex) {
    const frame = entry.frames?.find(item => Number(item.index) === Number(frameIndex));
    if (!frame) return;
    const d = doc();
    for (const layer of [...d.layers]) if (layer.id !== d.layers[0].id) d.deleteLayer(layer.id);
    const base = d.layers[0];
    d.setLayerPixels(base.id, new Uint8Array(d.width * d.height * 4));
    d.renameLayer(base.id, `${entry.name} · ${frameIndex + 1}`);
    for (const item of frame.layers || []) {
      const layer = d.layers[0].id === item.layerId ? d.layers[0] : d.addLayer(`${entry.name} · ${item.layerId}`);
      if (item.pixels) {
        const pixels = Uint8Array.from(atob(item.pixels), c => c.charCodeAt(0));
        if (pixels.length === layer.pixels.length) d.setLayerPixels(layer.id, pixels);
      }
    }
    d.dirty = true;
    status(`Copied frame ${Number(frameIndex) + 1} from “${entry.name}” as editable artwork`, 'success');
    render(); renderLayers(); onDocumentChanged(); void save();
  }

  function saveCurrentState() {
    const d = doc();
    const model = normalizeDrawingModel(d.getDrawingModel(), { width: d.width, height: d.height });
    const activeLayer = d.activeLayer;
    const name = window.prompt('Current state name', activeLayer?.name || d.name || 'Current state');
    if (!name?.trim()) return;
    const next = setCurrentState(model, {
      entityId: activeLayer?.id || d.id,
      name: name.trim(),
      scope: 'element',
      sourceRevision: d.saveVersion,
      frameIndex: animation()?.activeFrameIndex ?? null,
      layerIds: activeLayer ? [activeLayer.id] : [],
      appearance: { visible: activeLayer?.visible !== false, opacity: activeLayer?.opacity ?? 1 },
      transform: { x: 0, y: 0, orientation: 'current' },
      notes: 'Saved from the current PixelForge editor state.',
    });
    d.setDrawingModel(next);
    d.dirty = true;
    status('Current State saved without altering the Master Reference', 'success');
    onDocumentChanged(); refresh(); void save();
  }

  function recordEnvironment() {
    const d = doc();
    const model = normalizeDrawingModel(d.getDrawingModel(), { width: d.width, height: d.height });
    const environmentLayerIds = Object.entries(model.layerRoles).filter(([, meta]) => meta?.role === 'environment').map(([id]) => id);
    if (!environmentLayerIds.length) {
      status('Mark at least one layer as Environment before recording the environment history.', 'warning');
      return;
    }
    const frameIndex = animation()?.activeFrameIndex ?? null;
    const next = recordEnvironmentHistory(model, {
      sourceRevision: d.saveVersion,
      frameIndex,
      animationId: animation()?.id || null,
      environmentLayerIds,
      label: 'Environment · frame ' + (frameIndex === null ? 1 : frameIndex + 1),
    });
    d.setDrawingModel(next);
    d.dirty = true;
    status('Environment state recorded; it was not added to Reference Center', 'success');
    onDocumentChanged(); refresh(); void save();
  }
  function stopEnvironmentPreview() {
    if (environmentPreviewTimer) window.clearInterval(environmentPreviewTimer);
    environmentPreviewTimer = null;
    environmentPreviewButton.disabled = false;
    environmentStopButton.disabled = true;
  }

  function renderEnvironmentEntry(entry) {
    const d = doc();
    const currentAnimation = animation();
    if (!currentAnimation || !entry || !Array.isArray(entry.environmentLayerIds) || entry.frameIndex === null) {
      status('This environment history entry has no animation frame available to replay.', 'warning');
      return false;
    }
    const layers = d.layers.map(layer => ({
      id: layer.id,
      visible: entry.environmentLayerIds.includes(layer.id),
      opacity: 1,
    }));
    const pixels = currentAnimation.compositeFrame(entry.frameIndex, layers);
    const width = currentAnimation.width || d.width;
    const height = currentAnimation.height || d.height;
    environmentCanvas.width = width;
    environmentCanvas.height = height;
    const previewContext = environmentCanvas.getContext('2d');
    if (!previewContext) return false;
    previewContext.clearRect(0, 0, width, height);
    previewContext.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
    environmentCanvas.style.imageRendering = 'pixelated';
    return true;
  }

  function previewEnvironmentHistory() {
    stopEnvironmentPreview();
    const model = normalizeDrawingModel(doc().getDrawingModel(), { width: doc().width, height: doc().height });
    environmentPreviewEntries = model.environmentHistory.entries
      .filter(entry => entry.replayable !== false && entry.frameIndex !== null)
      .sort((a, b) => (a.frameIndex ?? 0) - (b.frameIndex ?? 0));
    if (!environmentPreviewEntries.length) {
      status('No replayable environment history is available for the current animation.', 'warning');
      return;
    }
    environmentPreviewIndex = 0;
    renderEnvironmentEntry(environmentPreviewEntries[0]);
    environmentPreviewButton.disabled = true;
    environmentStopButton.disabled = false;
    environmentPreviewTimer = window.setInterval(() => {
      environmentPreviewIndex++;
      if (environmentPreviewIndex >= environmentPreviewEntries.length) {
        stopEnvironmentPreview();
        return;
      }
      renderEnvironmentEntry(environmentPreviewEntries[environmentPreviewIndex]);
    }, Math.max(80, Math.round(1000 / Math.max(1, animation()?.fps || 12))));
  }

  function refresh() {
    const model = normalizeDrawingModel(doc().getDrawingModel(), { width: doc().width, height: doc().height });
    list.replaceChildren();
    stateSummary.replaceChildren();
    environmentList.replaceChildren();
    stopEnvironmentPreview();
    const stateInfo = document.createElement('p');
    stateInfo.className = 'small-note';
    stateInfo.textContent = 'Current State: ' + model.currentState.entries.length + ' · Environment History: ' + model.environmentHistory.entries.length;
    stateSummary.append(stateInfo);
    if (model.currentState.entries.length) {
      const current = model.currentState.entries.at(-1);
      const currentNote = document.createElement('p');
      currentNote.className = 'small-note';
      currentNote.textContent = 'Último estado: ' + current.name + (current.frameIndex === null ? '' : ' · frame ' + (current.frameIndex + 1));
      stateSummary.append(currentNote);
    }
    if (model.environmentHistory.entries.length) {
      const env = model.environmentHistory.entries.at(-1);
      const envNote = document.createElement('p');
      envNote.className = 'small-note';
      envNote.textContent = 'Último entorno: ' + env.label + ' · ' + env.environmentLayerIds.length + ' environment layers';
      stateSummary.append(envNote);
    }
    for (const entry of [...model.environmentHistory.entries].reverse().slice(0, 24)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'file-button';
      button.textContent = '🌎 ' + entry.label;
      button.addEventListener('click', () => renderEnvironmentEntry(entry));
      environmentList.append(button);
    }
    if (!model.referenceCenter.entries.length) {
      const empty = document.createElement('p');
      empty.className = 'small-note';
      empty.textContent = 'No references yet. Package a character, object, effect, scene or any layered artwork.';
      list.append(empty);
      return;
    }
    for (const entry of [...model.referenceCenter.entries].reverse()) {
      const card = document.createElement('article');
      card.className = 'reference-card';
      const header = document.createElement('div');
      header.className = 'reference-card-header';
      header.innerHTML = `<strong></strong><span class="tiny-tag"></span>`;
      header.querySelector('strong').textContent = entry.name;
      header.querySelector('.tiny-tag').textContent = entry.category || entry.type || 'asset';
      card.append(header);
      const meta = document.createElement('p');
      meta.className = 'small-note';
      meta.textContent = `${entry.parts?.length || 0} parts · ${entry.frames?.length || 0} frames · ${entry.geometry?.canvas?.width || doc().width}×${entry.geometry?.canvas?.height || doc().height}`;
      card.append(meta);
      const parts = document.createElement('div');
      parts.className = 'reference-parts';
      for (const part of entry.parts || []) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'file-button';
        button.textContent = '↳ ' + part.name;
        button.addEventListener('click', () => copyPart(entry, part));
        parts.append(button);
      }
      card.append(parts);
      if ((entry.frames || []).length) {
        const frames = document.createElement('div');
        frames.className = 'reference-parts';
        entry.frames.slice(0, 8).forEach(frame => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'file-button';
          button.textContent = `Frame ${Number(frame.index) + 1}`;
          button.addEventListener('click', () => copyFrame(entry, frame.index));
          frames.append(button);
        });
        card.append(frames);
      }
      list.append(card);
    }
  }

  environmentPreviewButton.addEventListener('click', previewEnvironmentHistory);
  environmentStopButton.addEventListener('click', stopEnvironmentPreview);
  host.querySelector('#reference-package-current').addEventListener('click', packageCurrent);
  host.querySelector('#reference-save-state').addEventListener('click', saveCurrentState);
  host.querySelector('#reference-record-environment').addEventListener('click', recordEnvironment);
  host.querySelector('#reference-refresh').addEventListener('click', refresh);
  refresh();
  return { refresh, contextOpacity };
}
