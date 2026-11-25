import { parsePixelForgeVideoPackage, readStoredZip, buildConstantFrameRateSequence } from './src/video-composer-core.mjs';
import { importPixelForgeCodeLabPackage } from './src/codelab-package.js';
import { getCaptureDimensions, getSourceQualityAssessment, drawContentComposition } from './src/video-capture-layout.mjs';
import { encodeWebMFrames } from './src/video-webm-encoder.mjs';
import { getVideoScalingMode } from './src/drawing-mode-config.mjs';

const $ = selector => document.querySelector(selector);
const ui = {
  file: $('#vc-file'), dropzone: $('#vc-dropzone'), stage: $('#vc-preview-stage'),
  canvas: $('#vc-preview'), empty: $('#vc-empty'), timeline: $('#vc-timeline-track'),
  play: $('#vc-play'), scrubber: $('#vc-scrubber'), export: $('#vc-export'),
  exportTop: $('#vc-export-top'), progress: $('#vc-progress'),
};
let packageData = null;
let currentIndex = 0;
let currentBitmap = null;
let playing = false;
let playbackRaf = 0;
let playbackStartedAt = 0;
let playbackElapsedMs = 0;
let playbackRenderPending = false;
let activeImport = 0;
let exportBusy = false;
let cancelRequested = false;
let studioRecorder = null;
let studioStream = null;
let studioChunks = [];
const exportOnly = new URLSearchParams(window.location.search).get('export') === '1';

function formatTime(ms) {
  const value = Math.max(0, Number(ms) || 0);
  const minutes = Math.floor(value / 60000);
  const seconds = Math.floor((value % 60000) / 1000);
  const millis = Math.floor(value % 1000);
  return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0') + '.' + String(millis).padStart(3, '0');
}
function safeName(value) {
  return String(value || 'pixelforge-video').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 72) || 'pixelforge-video';
}
function setStatus(message, kind = 'info') {
  $('#vc-export-note').textContent = message;
  $('#vc-export-note').dataset.kind = kind;
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function totalDuration() {
  return packageData?.frames.reduce((sum, frame) => sum + frame.durationMs, 0) ?? 0;
}
function refreshExportSummary() {
  if (!packageData) return;
  const repeats = $('#vc-loop-export').checked ? 2 : 1;
  $('#vc-export-duration').textContent = (totalDuration() * repeats / 1000).toFixed(2) + ' s';
}
function outputDimensions() {
  if (!packageData) return { width: 0, height: 0 };
  return getCaptureDimensions($('#vc-resolution').value, $('#vc-aspect').value,
    packageData.manifest.width, packageData.manifest.height);
}
function refreshOutputDimensions() {
  if (!packageData) return;
  const { width, height } = outputDimensions();
  $('#vc-export-dimensions').textContent = width + ' × ' + height;
  const sourceWidth = packageData.manifest.width;
  const sourceHeight = packageData.manifest.height;
  const quality = getSourceQualityAssessment(sourceWidth, sourceHeight, width, height);
  const sourceLabel = sourceWidth + ' × ' + sourceHeight;
  const contentLabel = quality.contentWidth + ' × ' + quality.contentHeight;
  const qualityNote = $('#vc-source-quality');
  qualityNote.dataset.kind = quality.upscaled ? 'warning' : quality.downscaled ? 'info' : 'success';
  qualityNote.textContent = quality.upscaled
    ? 'Origen ' + sourceLabel + ' → contenido ampliado a ' + contentLabel + '. El archivo tendrá ' + width + ' × ' + height + ', pero conservará el detalle del original; no se inventa resolución.'
    : quality.downscaled
      ? 'Origen ' + sourceLabel + ' → contenido reducido a ' + contentLabel + '. La salida conserva la proporción y reduce el detalle al tamaño elegido.'
      : 'Origen ' + sourceLabel + ' · salida ' + width + ' × ' + height + '. El contenido mantiene su tamaño de píxel original.';
  refreshMotionCadence();
}
function refreshMotionCadence() {
  if (!packageData) return;
  const sourceFps = Number(packageData.manifest.fps) || 0;
  const outputFps = Number($('#vc-output-fps').value) || sourceFps;
  const note = $('#vc-motion-quality');
  if (!sourceFps || !outputFps) {
    note.textContent = 'La fluidez real depende de los fotogramas y sus duraciones originales.';
  } else if (outputFps > sourceFps + 0.01) {
    note.textContent = 'Origen ' + sourceFps + ' FPS · salida ' + outputFps + ' FPS. Se repetirán poses cuando falten fotogramas: subir los FPS no inventa movimiento intermedio.';
  } else if (outputFps < sourceFps - 0.01) {
    note.textContent = 'La salida ' + outputFps + ' FPS reduce la cadencia del origen (' + sourceFps + ' FPS); algunos instantes pueden omitirse.';
  } else {
    note.textContent = 'La salida coincide con los ' + sourceFps + ' FPS del origen. Para más fluidez real, la animación necesita más poses o fotogramas intermedios.';
  }
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function makeTimelineThumbnails() {
  if (!packageData) return [];
  const count = Math.min(12, packageData.frames.length);
  const indices = Array.from({ length: count }, (_, index) =>
    count === 1 ? 0 : Math.round(index * (packageData.frames.length - 1) / (count - 1)));
  const result = [];
  for (const index of indices) {
    result.push({ index, bitmap: await createImageBitmap(packageData.frames[index].blob) });
  }
  return result;
}
function closeTimelineThumbnails(items) {
  for (const item of items) item.bitmap.close?.();
}
async function captureContentPng() {
  if (!packageData || exportBusy) return;
  const dimensions = outputDimensions();
  const canvas = document.createElement('canvas');
  canvas.width = dimensions.width; canvas.height = dimensions.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No se pudo crear la captura.');
  const bitmap = await createImageBitmap(packageData.frames[currentIndex].blob);
  const thumbnails = await makeTimelineThumbnails();
  try {
    drawContentComposition(context, bitmap, currentIndex, dimensions, thumbnails, {
      sourceWidth: packageData.manifest.width, sourceHeight: packageData.manifest.height,
      frameCount: packageData.frames.length, title: $('#vc-project-name').textContent,
      background: $('#vc-solid-bg').checked ? '#101116' : '#20232d',
      scalingMode: $('#vc-scaling-mode').value
    });
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('El navegador no pudo generar el PNG.');
    downloadBlob(blob, safeName($('#vc-project-name').textContent) + '-contenido.png');
    setStatus('Captura de contenido PNG generada en ' + dimensions.width + ' × ' + dimensions.height + '.', 'success');
  } finally {
    bitmap.close?.(); closeTimelineThumbnails(thumbnails);
  }
}
async function captureStudioPng() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    setStatus('Este navegador no permite capturar una pestaña. Usa Chrome/Edge actualizado.', 'error'); return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: false });
    const video = document.createElement('video');
    video.muted = true; video.srcObject = stream;
    await new Promise((resolve, reject) => {
      if (video.readyState >= 1) return resolve();
      video.addEventListener('loadedmetadata', resolve, { once: true });
      video.addEventListener('error', () => reject(new Error('No se pudo leer la pestaña capturada.')), { once: true });
    });
    await video.play();
    if (video.requestVideoFrameCallback) {
      await new Promise(resolve => video.requestVideoFrameCallback(() => resolve()));
    } else {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    const canvas = document.createElement('canvas');
    canvas.width = settings.width || video.videoWidth || 1280;
    canvas.height = settings.height || video.videoHeight || 720;
    const context = canvas.getContext('2d');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('No se pudo generar la captura del estudio.');
    downloadBlob(blob, 'pixelforge-estudio.png');
    setStatus('Captura completa del estudio guardada. Asegúrate de haber elegido la pestaña del editor en el selector del navegador.', 'success');
  } catch (error) {
    if (error.name !== 'NotAllowedError') setStatus('No se pudo capturar el estudio: ' + error.message, 'error');
  } finally {
    stream?.getTracks().forEach(track => track.stop());
  }
}
async function startStudioRecording() {
  if (!navigator.mediaDevices?.getDisplayMedia || !window.MediaRecorder) {
    setStatus('La grabación de pestaña requiere un navegador compatible con captura de pantalla y MediaRecorder.', 'error'); return;
  }
  if (studioRecorder) return;
  try {
    studioStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: Number($('#vc-output-fps').value) || 30 }, audio: false });
    const mimeType = recorderMime();
    if (!mimeType) throw new Error('No hay un formato de vídeo compatible.');
    studioChunks = [];
    studioRecorder = new MediaRecorder(studioStream, { mimeType });
    studioRecorder.addEventListener('dataavailable', event => { if (event.data?.size) studioChunks.push(event.data); });
    studioRecorder.addEventListener('stop', () => {
      const blob = new Blob(studioChunks, { type: mimeType });
      if (blob.size) downloadBlob(blob, 'pixelforge-estudio.' + (mimeType.includes('mp4') ? 'mp4' : 'webm'));
      studioStream?.getTracks().forEach(track => track.stop());
      studioRecorder = null; studioStream = null; studioChunks = [];
      $('#vc-stop-studio').hidden = true;
      $('#vc-record-studio').hidden = false;
      setStatus(blob.size ? 'Grabación completa del estudio guardada.' : 'La grabación no produjo datos.', blob.size ? 'success' : 'error');
    }, { once: true });
    studioStream.getVideoTracks()[0].addEventListener('ended', () => {
      if (studioRecorder?.state === 'recording') studioRecorder.stop();
    }, { once: true });
    studioRecorder.start(500);
    $('#vc-record-studio').hidden = true;
    $('#vc-stop-studio').hidden = false;
    setStatus('Grabando la pestaña elegida. Cambia al editor de PixelForge; vuelve aquí y pulsa Detener cuando termines.', 'success');
  } catch (error) {
    studioStream?.getTracks().forEach(track => track.stop());
    studioRecorder = null; studioStream = null;
    setStatus('No se pudo iniciar la grabación del estudio: ' + error.message, 'error');
  }
}

function frameStart(index) {
  return packageData.frames.slice(0, index).reduce((sum, frame) => sum + frame.durationMs, 0);
}
function setEnabled(enabled) {
  for (const node of [ui.play, $('#vc-first'), $('#vc-prev'), $('#vc-next'), $('#vc-last'), ui.scrubber, $('#vc-loop')]) {
    node.disabled = !enabled;
  }
  ui.export.disabled = !enabled || exportBusy;
  ui.exportTop.disabled = !enabled || exportBusy;
  $('#vc-loop-export').disabled = !enabled;
  $('#vc-capture-content').disabled = !enabled || exportBusy;
  $('#vc-output-fps').disabled = !enabled;
  $('#vc-format').disabled = !enabled;
  $('#vc-solid-bg').disabled = !enabled;
}
function resetComposer() {
  stopPlayback();
  ui.progress.hidden = true;
  $('#vc-cancel-export').hidden = true;
  ui.export.textContent = '⇩ Exportar vídeo';
  packageData = null;
  currentIndex = 0;
  playbackElapsedMs = 0;
  currentBitmap?.close?.();
  currentBitmap = null;
  ui.canvas.hidden = true;
  ui.empty.hidden = false;
  ui.timeline.innerHTML = '<div class="vc-timeline-empty">Los fotogramas se mostrarán aquí después de importar el paquete.</div>';
  $('#vc-project-name').textContent = 'Sin paquete cargado';
  $('#vc-project-meta').textContent = 'Importa una secuencia ZIP para comenzar';
  $('#vc-source-card').hidden = true;
  $('#vc-source-count').textContent = '0';
  $('#vc-stat-frames').textContent = '—';
  $('#vc-stat-fps').textContent = '—';
  $('#vc-stat-size').textContent = '—';
  $('#vc-stat-duration').textContent = '—';
  $('#vc-preview-resolution').textContent = '—';
  $('#vc-preview-frame').textContent = 'FRAME — / —';
  $('#vc-preview-time').textContent = '00:00.000';
  $('#vc-current-time').textContent = '00:00.000';
  $('#vc-total-time').textContent = '00:00.000';
  $('#vc-playback-fps').textContent = '— FPS';
  $('#vc-timeline-count').textContent = '0 elementos';
  $('#vc-export-duration').textContent = '—';
  $('#vc-export-dimensions').textContent = '—';
  setEnabled(false);
}
async function renderFrame(index) {
  if (!packageData) return;
  index = Math.max(0, Math.min(packageData.frames.length - 1, index));
  currentIndex = index;
  if (!playing) playbackElapsedMs = frameStart(index);
  const frame = packageData.frames[index];
  currentBitmap?.close?.();
  currentBitmap = await createImageBitmap(frame.blob);
  const width = packageData.manifest.width;
  const height = packageData.manifest.height;
  if (currentBitmap.width !== width || currentBitmap.height !== height) {
    throw new Error('El fotograma ' + (index + 1) + ' no coincide con las dimensiones del manifiesto.');
  }
  ui.canvas.width = width;
  ui.canvas.height = height;
  const context = ui.canvas.getContext('2d', { alpha: true });
  const scalingMode = $('#vc-scaling-mode').value;
  ui.canvas.dataset.scalingMode = scalingMode;
  const frameScalingMode = ['smooth', 'pixelated'].includes(frame.authoringMode === 'pixel-art' ? 'pixelated' : frame.authoringMode === 'illustration' ? 'smooth' : scalingMode)
    ? (frame.authoringMode === 'pixel-art' ? 'pixelated' : frame.authoringMode === 'illustration' ? 'smooth' : scalingMode) : 'smooth';
  context.imageSmoothingEnabled = frameScalingMode !== 'pixelated';
  if (context.imageSmoothingEnabled) context.imageSmoothingQuality = 'high';
  context.clearRect(0, 0, width, height);
  context.drawImage(currentBitmap, 0, 0);
  ui.canvas.hidden = false;
  ui.empty.hidden = true;
  ui.scrubber.max = String(packageData.frames.length - 1);
  ui.scrubber.value = String(index);
  $('#vc-preview-frame').textContent = 'FRAME ' + String(index + 1).padStart(2, '0') + ' / ' + String(packageData.frames.length).padStart(2, '0');
  const time = frameStart(index);
  $('#vc-preview-time').textContent = formatTime(time);
  $('#vc-current-time').textContent = formatTime(time);
  $('#vc-playback-fps').textContent = packageData.manifest.fps + ' FPS';
  for (const button of ui.timeline.querySelectorAll('.vc-frame-card')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.index) === index));
  }
  $('#vc-prev').disabled = index === 0 || playing;
  $('#vc-first').disabled = index === 0 || playing;
  $('#vc-next').disabled = index === packageData.frames.length - 1 || playing;
  $('#vc-last').disabled = index === packageData.frames.length - 1 || playing;
}
async function buildTimeline() {
  ui.timeline.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < packageData.frames.length; index++) {
    const frame = packageData.frames[index];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'vc-frame-card';
    button.dataset.index = String(index);
    button.setAttribute('aria-pressed', String(index === 0));
    button.setAttribute('aria-label', 'Fotograma ' + (index + 1) + ', ' + frame.durationMs + ' milisegundos');
    const thumb = document.createElement('canvas');
    thumb.width = 48; thumb.height = 48;
    const bitmap = await createImageBitmap(frame.blob);
    const context = thumb.getContext('2d');
    context.imageSmoothingEnabled = false;
    const scale = Math.min(48 / bitmap.width, 48 / bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    context.drawImage(bitmap, Math.floor((48 - width) / 2), Math.floor((48 - height) / 2), width, height);
    bitmap.close?.();
    const label = document.createElement('small');
    label.textContent = String(index + 1).padStart(2, '0');
    const duration = document.createElement('em');
    duration.textContent = Math.round(frame.durationMs) + 'ms';
    button.append(thumb, label, duration);
    button.addEventListener('click', async () => {
      stopPlayback();
      try { await renderFrame(index); }
      catch (error) { setStatus(error.message, 'error'); }
    });
    fragment.append(button);
    if (index % 16 === 15) await delay(0);
  }
  ui.timeline.append(fragment);
}
async function composeNativeFrame(project, frame) {
  const width = project.width, height = project.height;
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) throw new Error('No se pudo crear el lienzo para componer el fotograma.');
  const metadataByLayer = new Map((frame.layerMetadata || []).map(item => [String(item.layerId || item.id), item]));
  const celsByLayer = new Map((frame.cels || []).map(item => [String(item.layerId), item]));
  for (const layer of project.layers) {
    const cel = celsByLayer.get(String(layer.id));
    if (!cel) throw new Error('El fotograma no contiene el cel de la capa ' + layer.name + '.');
    const meta = metadataByLayer.get(String(layer.id)) || cel.metadata || {};
    if (layer.visible === false || meta.visible === false) continue;
    const raw = atob(cel.pixels);
    const pixels = new Uint8ClampedArray(raw.length);
    for (let i = 0; i < raw.length; i++) pixels[i] = raw.charCodeAt(i);
    if (pixels.length !== width * height * 4) throw new Error('El tamaño RGBA de la capa ' + layer.name + ' no coincide con el lienzo.');
    const source = document.createElement('canvas');
    source.width = width; source.height = height;
    source.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
    const x = Number(meta.x ?? meta.position?.x ?? 0);
    const y = Number(meta.y ?? meta.position?.y ?? 0);
    const sx = Number(meta.scaleX ?? 1), sy = Number(meta.scaleY ?? 1);
    const rotation = Number(meta.rotation ?? 0);
    context.save();
    const authoringMode = meta.authoringMode === 'pixel-art' ? 'pixel-art' : meta.authoringMode === 'illustration' ? 'illustration' : null;
    context.imageSmoothingEnabled = authoringMode !== 'pixel-art';
    if (context.imageSmoothingEnabled) context.imageSmoothingQuality = 'high';
    context.globalAlpha = Math.max(0, Math.min(1, Number(meta.opacity ?? layer.opacity ?? 1)));
    const blend = String(meta.blendMode || layer.blendMode || 'normal');
    if (['source-over','multiply','screen','overlay','darken','lighten','difference','exclusion','lighter'].includes(blend)) context.globalCompositeOperation = blend;
    context.translate(width / 2 + x, height / 2 + y);
    context.rotate(rotation * Math.PI / 180);
    context.scale(Number.isFinite(sx) ? sx : 1, Number.isFinite(sy) ? sy : 1);
    context.drawImage(source, -width / 2, -height / 2);
    context.restore();
  }
  const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('No se pudo codificar el fotograma compuesto como PNG.')), 'image/png'));
  return blob;
}
async function parseComposerPackage(file) {
  const entries = await readStoredZip(file);
  if (entries.has('project.codelab-pixelforge') || entries.has('project.codelab')) {
    const installed = await importPixelForgeCodeLabPackage(entries);
    const project = installed.project;
    const animation = project.animation;
    if (!animation?.frames?.length) throw new Error('El proyecto nativo no contiene una línea de tiempo exportable.');
    const frames = [];
    for (const frame of animation.frames) {
      frames.push({ ...frame, blob: await composeNativeFrame(project, frame) });
    }
    const totalDurationMs = frames.reduce((sum, frame) => sum + Number(frame.durationMs), 0);
    return {
      manifest: {
        format: 'pixelforge-native-composer', version: 1,
        width: project.width, height: project.height, fps: animation.fps,
        loop: animation.loop !== false, frameCount: frames.length, totalDurationMs,
        projectName: project.name,
        sourceDrawingMode: project.drawingConfiguration?.activeMode === 'pixel-art' ? 'pixel-art' : 'illustration',
        scalingMode: getVideoScalingMode(project.drawingConfiguration?.activeMode),
      },
      frames, project: new Blob([JSON.stringify(project)], { type: 'application/json' }),
      entryCount: entries.size,
    };
  }
  return parsePixelForgeVideoPackage(file);
}
async function importPackage(file) {
  if (!file) return;
  const requestId = ++activeImport;
  stopPlayback();
  setStatus('Leyendo el paquete y validando sus fotogramas…');
  try {
    if (file.size > 256 * 1024 * 1024) throw new RangeError('El paquete supera el límite de importación de 256 MiB.');
    const parsed = await parseComposerPackage(file);
    if (requestId !== activeImport) return;
    packageData = parsed;
    if (['smooth', 'pixelated'].includes(parsed.manifest.scalingMode)) $('#vc-scaling-mode').value = parsed.manifest.scalingMode;
    $('#vc-project-name').textContent = file.name.replace(/\.zip$/i, '') || 'Animación PixelForge';
    $('#vc-project-meta').textContent = parsed.manifest.width + ' × ' + parsed.manifest.height + ' · ' + parsed.manifest.frameCount + ' fotogramas';
    $('#vc-source-card').hidden = false;
    $('#vc-source-filename').textContent = file.name;
    $('#vc-source-size').textContent = (file.size / 1024 / 1024).toFixed(2) + ' MiB';
    $('#vc-source-count').textContent = String(parsed.entryCount);
    $('#vc-stat-frames').textContent = String(parsed.manifest.frameCount);
    $('#vc-stat-fps').textContent = parsed.manifest.fps + ' FPS';
    $('#vc-stat-size').textContent = parsed.manifest.width + ' × ' + parsed.manifest.height;
    $('#vc-stat-duration').textContent = (parsed.manifest.totalDurationMs / 1000).toFixed(2) + ' s';
    $('#vc-preview-resolution').textContent = parsed.manifest.width + ' × ' + parsed.manifest.height;
    $('#vc-total-time').textContent = formatTime(parsed.manifest.totalDurationMs);
    refreshExportSummary();
    refreshOutputDimensions();
    $('#vc-timeline-count').textContent = parsed.frames.length + ' fotogramas';
    $('#vc-audio-status').textContent = parsed.manifest.audio?.length ? 'Pista de audio incluida en el paquete' : 'Este paquete no contiene audio';
    $('#vc-loop').checked = parsed.manifest.loop !== false;
    $('#vc-loop-export').checked = false;
    $('#vc-output-fps').value = String(parsed.manifest.fps);
    refreshMotionCadence();
    setEnabled(true);
    refreshFormatSupport();
    // Server-side Video Composer exports do not need the interactive timeline.
    // Avoid creating 120 thumbnail canvases/ImageBitmaps before encoding; this
    // keeps Chromium's peak RSS low enough for constrained Render instances.
    if (!exportOnly) {
      await buildTimeline();
      if (requestId !== activeImport) return;
      await renderFrame(0);
    }
    setStatus(exportOnly
      ? 'Paquete validado para exportación. Preparando el codificador…'
      : 'Paquete validado. Reproduce la secuencia o configura la exportación de vídeo.', 'success');
  } catch (error) {
    if (requestId === activeImport) {
      resetComposer();
      setStatus('No se pudo importar el ZIP: ' + error.message, 'error');
    }
  } finally {
    ui.file.value = '';
  }
}
function stopPlayback() {
  if (playing) playbackElapsedMs = Math.max(0, performance.now() - playbackStartedAt);
  playing = false;
  if (playbackRaf) cancelAnimationFrame(playbackRaf);
  playbackRaf = 0;
  ui.play.textContent = '▶';
  ui.play.setAttribute('aria-label', 'Reproducir');
  if (packageData) {
    $('#vc-prev').disabled = currentIndex === 0;
    $('#vc-first').disabled = currentIndex === 0;
    $('#vc-next').disabled = currentIndex === packageData.frames.length - 1;
    $('#vc-last').disabled = currentIndex === packageData.frames.length - 1;
  }
}
function playbackTick(now) {
  if (!playing || !packageData) return;
  const total = totalDuration();
  const elapsed = Math.max(0, now - playbackStartedAt);
  const looping = $('#vc-loop').checked;
  if (!looping && elapsed >= total) {
    playbackElapsedMs = total;
    const lastIndex = packageData.frames.length - 1;
    if (currentIndex !== lastIndex && !playbackRenderPending) {
      playbackRenderPending = true;
      renderFrame(lastIndex).catch(error => setStatus(error.message, 'error')).finally(() => {
        playbackRenderPending = false;
        stopPlayback();
      });
    } else if (playbackRenderPending) {
      playbackRaf = requestAnimationFrame(playbackTick);
    } else stopPlayback();
    return;
  }
  const timelineTime = looping && total > 0 ? elapsed % total : Math.min(elapsed, total);
  let low = 0, high = packageData.frames.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (frameStart(middle + 1) <= timelineTime) low = middle + 1;
    else high = middle;
  }
  const targetIndex = Math.min(packageData.frames.length - 1, low);
  if (targetIndex !== currentIndex && !playbackRenderPending) {
    playbackRenderPending = true;
    renderFrame(targetIndex).catch(error => {
      stopPlayback();
      setStatus(error.message, 'error');
    }).finally(() => { playbackRenderPending = false; });
  }
  playbackRaf = requestAnimationFrame(playbackTick);
}
function startPlayback() {
  if (!packageData || playing) return;
  if (playbackElapsedMs >= totalDuration()) playbackElapsedMs = 0;
  playbackStartedAt = performance.now() - playbackElapsedMs;
  playing = true;
  ui.play.textContent = 'Ⅱ';
  ui.play.setAttribute('aria-label', 'Pausar');
  playbackRaf = requestAnimationFrame(playbackTick);
}
function webCodecsSupport() {
  if (!('VideoEncoder' in globalThis) || !('VideoFrame' in globalThis)) return '';
  const choice = $('#vc-format').value;
  if (choice === 'mp4') return '';
  return choice === 'webm-vp8' ? 'VP8 · WebCodecs' : 'VP9 · WebCodecs';
}
function refreshFormatSupport() {
  const supported = webCodecsSupport();
  $('#vc-format-support').textContent = supported
    ? 'Codificación determinista disponible: ' + supported + ' · sin espera en tiempo real.'
    : 'Esta plataforma no ofrece el codificador WebCodecs para la opción seleccionada. Usa WebM VP9/VP8.';
  ui.export.disabled = !packageData || !supported || exportBusy;
  ui.exportTop.disabled = !packageData || !supported || exportBusy;
}
function setProgress(value, label) {
  ui.progress.hidden = false;
  $('#vc-progress-value').textContent = Math.round(value * 100) + '%';
  $('#vc-progress-label').textContent = label;
  $('#vc-progress-bar').style.width = Math.round(value * 100) + '%';
}
async function exportVideo() {
  if (!packageData || exportBusy) return;
  if (!('VideoEncoder' in globalThis) || !('VideoFrame' in globalThis)) {
    setStatus('Este navegador no dispone de WebCodecs para exportación determinista. Usa Chrome/Edge actualizado.', 'error');
    return;
  }
  exportBusy = true;
  cancelRequested = false;
  $('#vc-cancel-export').hidden = false;
  $('#vc-cancel-export').disabled = false;
  stopPlayback();
  ui.export.textContent = 'Preparando vídeo…';
  const codecChoice = $('#vc-format').value;
  const codec = codecChoice === 'webm-vp8' ? 'vp8' : 'vp9';
  const repeatCount = $('#vc-loop-export').checked ? 2 : 1;
  const solidBackground = $('#vc-solid-bg').checked;
  const outputFps = Number($('#vc-output-fps').value) || packageData.manifest.fps;
  const { width, height } = outputDimensions();
  if (width > 8192 || height > 8192 || width * height > 16_777_216) {
    exportBusy = false; refreshFormatSupport();
    setStatus('La escala seleccionada supera el límite seguro de 16 megapíxeles. Reduce la escala de salida.', 'error');
    return;
  }
  let thumbnails = [];
  try {
    // Thumbnails are UI-only; never decode them during video export.
    const sourceFrames = repeatCount === 1
      ? packageData.frames
      : [...packageData.frames, ...packageData.frames];
    const total = sourceFrames.reduce((sum, frame) => sum + frame.durationMs, 0);
    const started = performance.now();
    setProgress(0, 'Construyendo la línea temporal…');

    // durationMs is timeline data, not wall-clock sleep. Every timestamp is
    // calculated before/while encoding, so a 10-second animation does not
    // force a 10-second export.
    const framesForEncode = buildConstantFrameRateSequence(sourceFrames, outputFps);
    if (framesForEncode.length !== sourceFrames.length || framesForEncode.some((frame, index) => frame.sourceIndex !== index)) {
      setStatus('Timeline remuestreada a ' + outputFps + ' FPS constantes · ' + framesForEncode.length + ' fotogramas de salida.', 'neutral');
    }

    const video = await encodeWebMFrames(framesForEncode, {
      width,
      height,
      codec,
      fps: outputFps,
      durationMs: total,
      backgroundColor: solidBackground ? '#101116' : null,
      scalingMode: $('#vc-scaling-mode').value,
      isCancelled: () => cancelRequested,
      onProgress: (value, label) => setProgress(value, label)
    });

    if (cancelRequested) throw new DOMException('Exportación cancelada.', 'AbortError');
    const extension = 'webm';
    const url = URL.createObjectURL(video);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = safeName($('#vc-project-name').textContent) + '.' + extension;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    setStatus('Vídeo exportado: ' + (video.size / 1024 / 1024).toFixed(2) + ' MiB · ' + seconds + ' s de procesamiento · duración final ' + (total / 1000).toFixed(2) + ' s.', 'success');
    $('#vc-progress-label').textContent = 'Vídeo listo';
    $('#vc-progress-value').textContent = '100%';
    $('#vc-progress-bar').style.width = '100%';
  } catch (error) {
    if (error.name === 'AbortError') setStatus('Exportación cancelada. Puedes ajustar la salida e intentarlo de nuevo.', 'info');
    else setStatus('La exportación falló: ' + error.message, 'error');
  } finally {
    closeTimelineThumbnails(thumbnails);
    exportBusy = false;
    $('#vc-cancel-export').hidden = true;
    $('#vc-cancel-export').disabled = false;
    ui.export.textContent = '⇩ Exportar vídeo';
    refreshFormatSupport();
  }
}

ui.dropzone.addEventListener('click', () => ui.file.click());
$('#vc-empty-import').addEventListener('click', () => ui.file.click());
ui.file.addEventListener('change', event => importPackage(event.target.files?.[0]));
ui.dropzone.addEventListener('dragover', event => { event.preventDefault(); ui.dropzone.classList.add('is-over'); });
ui.dropzone.addEventListener('dragleave', () => ui.dropzone.classList.remove('is-over'));
ui.dropzone.addEventListener('drop', event => {
  event.preventDefault(); ui.dropzone.classList.remove('is-over');
  importPackage(event.dataTransfer.files?.[0]);
});
ui.stage.addEventListener('dragover', event => event.preventDefault());
ui.stage.addEventListener('drop', event => { event.preventDefault(); importPackage(event.dataTransfer.files?.[0]); });
$('#vc-remove-source').addEventListener('click', resetComposer);
ui.play.addEventListener('click', () => playing ? stopPlayback() : startPlayback());
$('#vc-first').addEventListener('click', () => { stopPlayback(); renderFrame(0); });
$('#vc-last').addEventListener('click', () => { stopPlayback(); renderFrame(packageData.frames.length - 1); });
$('#vc-prev').addEventListener('click', () => { stopPlayback(); renderFrame(currentIndex - 1); });
$('#vc-next').addEventListener('click', () => { stopPlayback(); renderFrame(currentIndex + 1); });
ui.scrubber.addEventListener('input', event => { stopPlayback(); renderFrame(Number(event.target.value)); });
$('#vc-fit').addEventListener('click', () => { if (packageData) renderFrame(currentIndex); });
$('#vc-checker').addEventListener('click', event => {
  const enabled = event.currentTarget.getAttribute('aria-pressed') === 'true';
  event.currentTarget.setAttribute('aria-pressed', String(!enabled));
  ui.stage.classList.toggle('solid-bg', enabled);
});
$('#vc-resolution').addEventListener('change', refreshOutputDimensions);
$('#vc-aspect').addEventListener('change', refreshOutputDimensions);
$('#vc-output-fps').addEventListener('change', refreshMotionCadence);
$('#vc-scaling-mode').addEventListener('change', () => {
  ui.canvas.dataset.scalingMode = $('#vc-scaling-mode').value;
  renderFrame(currentIndex).catch(error => setStatus(error.message, 'error'));
});
$('#vc-capture-content').addEventListener('click', () => captureContentPng().catch(error => setStatus(error.message, 'error')));
$('#vc-capture-studio').addEventListener('click', captureStudioPng);
$('#vc-record-studio').addEventListener('click', startStudioRecording);
$('#vc-stop-studio').addEventListener('click', () => { if (studioRecorder?.state === 'recording') studioRecorder.stop(); });
$('#vc-format').addEventListener('change', refreshFormatSupport);
$('#vc-loop-export').addEventListener('change', refreshExportSummary);
$('#vc-export').addEventListener('click', exportVideo);
$('#vc-export-top').addEventListener('click', exportVideo);
$('#vc-cancel-export').addEventListener('click', () => {
  if (!exportBusy) return;
  cancelRequested = true;
  $('#vc-cancel-export').disabled = true;
  $('#vc-progress-label').textContent = 'Cancelando exportación…';
});
resetComposer();
refreshFormatSupport();
