import { parsePixelForgeVideoPackage } from './src/video-composer-core.mjs';

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
let playbackTimer = 0;
let activeImport = 0;
let exportBusy = false;
let cancelRequested = false;

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
  $('#vc-scale').disabled = !enabled;
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
  context.imageSmoothingEnabled = false;
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
async function importPackage(file) {
  if (!file) return;
  const requestId = ++activeImport;
  stopPlayback();
  setStatus('Leyendo el paquete y validando sus fotogramas…');
  try {
    if (file.size > 256 * 1024 * 1024) throw new RangeError('El paquete supera el límite de importación de 256 MiB.');
    const parsed = await parsePixelForgeVideoPackage(file);
    if (requestId !== activeImport) return;
    packageData = parsed;
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
    $('#vc-export-dimensions').textContent = parsed.manifest.width * Number($('#vc-scale').value) + ' × ' + parsed.manifest.height * Number($('#vc-scale').value);
    $('#vc-timeline-count').textContent = parsed.frames.length + ' fotogramas';
    $('#vc-audio-status').textContent = parsed.manifest.audio?.length ? 'Pista de audio incluida en el paquete' : 'Este paquete no contiene audio';
    $('#vc-loop').checked = parsed.manifest.loop !== false;
    $('#vc-loop-export').checked = false;
    $('#vc-output-fps').value = String(parsed.manifest.fps);
    setEnabled(true);
    refreshFormatSupport();
    await buildTimeline();
    if (requestId !== activeImport) return;
    await renderFrame(0);
    setStatus('Paquete validado. Reproduce la secuencia o configura la exportación de vídeo.', 'success');
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
  playing = false;
  clearTimeout(playbackTimer);
  ui.play.textContent = '▶';
  ui.play.setAttribute('aria-label', 'Reproducir');
  if (packageData) {
    $('#vc-prev').disabled = currentIndex === 0;
    $('#vc-first').disabled = currentIndex === 0;
    $('#vc-next').disabled = currentIndex === packageData.frames.length - 1;
    $('#vc-last').disabled = currentIndex === packageData.frames.length - 1;
  }
}
function schedulePlayback() {
  if (!playing || !packageData) return;
  const next = currentIndex + 1;
  if (next >= packageData.frames.length) {
    if ($('#vc-loop').checked) {
      renderFrame(0).then(() => schedulePlayback()).catch(error => { stopPlayback(); setStatus(error.message, 'error'); });
    } else stopPlayback();
    return;
  }
  playbackTimer = setTimeout(() => {
    renderFrame(next).then(() => schedulePlayback()).catch(error => { stopPlayback(); setStatus(error.message, 'error'); });
  }, packageData.frames[currentIndex].durationMs);
}
function startPlayback() {
  if (!packageData || playing) return;
  if (currentIndex === packageData.frames.length - 1) renderFrame(0).then(() => {
    playing = true; ui.play.textContent = 'Ⅱ'; ui.play.setAttribute('aria-label', 'Pausar'); schedulePlayback();
  });
  else { playing = true; ui.play.textContent = 'Ⅱ'; ui.play.setAttribute('aria-label', 'Pausar'); schedulePlayback(); }
}
function recorderMime() {
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return '';
  const choice = $('#vc-format').value;
  const candidates = choice === 'mp4' ? ['video/mp4'] :
    choice === 'webm-vp9' ? ['video/webm;codecs=vp9'] :
    choice === 'webm-vp8' ? ['video/webm;codecs=vp8'] :
    ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  return candidates.find(type => window.MediaRecorder?.isTypeSupported?.(type)) || '';
}
function refreshFormatSupport() {
  const supported = recorderMime();
  $('#vc-format-support').textContent = supported ? 'Disponible en este navegador: ' + supported : 'Este navegador no ofrece un codificador compatible para la opción seleccionada.';
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
  const mimeType = recorderMime();
  if (!mimeType) { setStatus('El navegador no admite el formato de vídeo seleccionado. Prueba WebM VP8/VP9.', 'error'); return; }
  if (!HTMLCanvasElement.prototype.captureStream || !window.MediaRecorder) {
    setStatus('Este navegador no permite grabar un canvas. Prueba la versión de escritorio o Chrome actualizado.', 'error');
    return;
  }
  exportBusy = true;
  cancelRequested = false;
  $('#vc-cancel-export').hidden = false;
  $('#vc-cancel-export').disabled = false;
  stopPlayback();
  refreshFormatSupport();
  ui.export.textContent = 'Preparando vídeo…';
  const scale = Number($('#vc-scale').value) || 1;
  const outputFps = Number($('#vc-output-fps').value) || packageData.manifest.fps;
  const repeatCount = $('#vc-loop-export').checked ? 2 : 1;
  const solidBackground = $('#vc-solid-bg').checked;
  const width = packageData.manifest.width * scale;
  const height = packageData.manifest.height * scale;
  if (width > 8192 || height > 8192 || width * height > 16_777_216) {
    exportBusy = false; refreshFormatSupport();
    setStatus('La escala seleccionada supera el límite seguro de 16 megapíxeles. Reduce la escala de salida.', 'error');
    return;
  }
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = width;
  exportCanvas.height = height;
  const context = exportCanvas.getContext('2d', { alpha: !solidBackground });
  if (!context) {
    exportBusy = false; refreshFormatSupport();
    setStatus('No se pudo crear el área de exportación.', 'error');
    return;
  }
  context.imageSmoothingEnabled = false;
  const stream = exportCanvas.captureStream(outputFps);
  const chunks = [];
  let recorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: Math.min(25_000_000, Math.max(1_000_000, width * height * outputFps * 0.12)) });
  } catch (error) {
    stream.getTracks().forEach(track => track.stop());
    exportBusy = false; refreshFormatSupport();
    setStatus('No se pudo iniciar el codificador: ' + error.message, 'error');
    return;
  }
  recorder.addEventListener('dataavailable', event => { if (event.data?.size) chunks.push(event.data); });
  const stopped = new Promise((resolve, reject) => {
    recorder.addEventListener('stop', resolve, { once: true });
    recorder.addEventListener('error', event => reject(event.error || new Error('El codificador de vídeo falló.')), { once: true });
  });
  const total = totalDuration() * repeatCount;
  let elapsed = 0;
  const startTime = performance.now();
  try {
    recorder.start();
    for (let repeat = 0; repeat < repeatCount; repeat++) {
      for (let index = 0; index < packageData.frames.length; index++) {
        if (cancelRequested) throw new DOMException('Exportación cancelada.', 'AbortError');
        const frame = packageData.frames[index];
        const bitmap = await createImageBitmap(frame.blob);
        context.clearRect(0, 0, width, height);
        if (solidBackground) { context.fillStyle = '#101116'; context.fillRect(0, 0, width, height); }
        context.drawImage(bitmap, 0, 0, width, height);
        bitmap.close?.();
        await delay(frame.durationMs);
        if (cancelRequested) throw new DOMException('Exportación cancelada.', 'AbortError');
        elapsed += frame.durationMs;
        setProgress(elapsed / total, 'Renderizando vuelta ' + (repeat + 1) + ' de ' + repeatCount);
      }
    }
    recorder.stop();
    await stopped;
    const extension = mimeType.includes('mp4') ? 'mp4' : 'webm';
    const video = new Blob(chunks, { type: mimeType });
    if (!video.size) throw new Error('El codificador no produjo datos de vídeo.');
    const url = URL.createObjectURL(video);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = safeName($('#vc-project-name').textContent) + '.' + extension;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    const seconds = ((performance.now() - startTime) / 1000).toFixed(1);
    setStatus('Vídeo exportado: ' + (video.size / 1024 / 1024).toFixed(2) + ' MiB · ' + seconds + ' s de procesamiento.', 'success');
    $('#vc-progress-label').textContent = 'Vídeo listo';
    $('#vc-progress-value').textContent = '100%';
    $('#vc-progress-bar').style.width = '100%';
  } catch (error) {
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped.catch(() => {});
    if (error.name === 'AbortError') setStatus('Exportación cancelada. Puedes ajustar la salida e intentarlo de nuevo.', 'info');
    else setStatus('La exportación falló: ' + error.message, 'error');
  } finally {
    stream.getTracks().forEach(track => track.stop());
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
$('#vc-scale').addEventListener('change', () => {
  if (!packageData) return;
  $('#vc-export-dimensions').textContent = packageData.manifest.width * Number($('#vc-scale').value) + ' × ' + packageData.manifest.height * Number($('#vc-scale').value);
});
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
