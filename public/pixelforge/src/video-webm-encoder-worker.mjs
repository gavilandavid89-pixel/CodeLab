import { encodeWebMFromChunks } from './video-webm-encoder.mjs';
import { drawFrameToCanvas } from './video-capture-layout.mjs';

self.onmessage = async (event) => {
  const { frames, width, height, codec = 'vp9', fps = 12, durationMs = 0, backgroundColor = null, scalingMode = 'smooth' } = event.data || {};
  try {
    if (!Array.isArray(frames) || !frames.length) throw new Error('El codificador no recibió fotogramas.');
    if (!self.OffscreenCanvas || !self.VideoEncoder || !self.VideoFrame) {
      throw new Error('Este navegador no dispone de WebCodecs/OffscreenCanvas para exportación en segundo plano.');
    }
    const chunks = [];
    const errors = [];
    let configuredCodec = codec === 'vp8' ? 'vp8' : 'vp09.00.10.08';
    const encoder = new VideoEncoder({
      output: chunk => chunks.push(chunk),
      error: error => errors.push(error)
    });
    const config = {
      codec: configuredCodec, width, height,
      bitrate: Math.min(25_000_000, Math.max(1_000_000, width * height * Math.max(1, fps) * 0.12)),
      framerate: Math.max(1, fps), latencyMode: 'quality'
    };
    const support = await VideoEncoder.isConfigSupported(config);
    if (!support.supported && codec !== 'vp8') {
      configuredCodec = 'vp8'; config.codec = configuredCodec;
      const fallback = await VideoEncoder.isConfigSupported(config);
      if (!fallback.supported) throw new Error('WebCodecs no admite VP9/VP8 en esta plataforma.');
    } else if (!support.supported) {
      throw new Error('WebCodecs no admite VP8 en esta plataforma.');
    }
    encoder.configure(config);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { alpha: true });
    let timestampUs = 0;
    for (let index = 0; index < frames.length; index++) {
      if (event.data.cancelled) throw new DOMException('Exportación cancelada.', 'AbortError');
      const frame = frames[index];
      const bitmap = await createImageBitmap(frame.blob);
      try {
        const durationUs = Math.max(1000, Math.round(frame.durationMs * 1000));
        drawFrameToCanvas(context, bitmap, width, height, { backgroundColor, scalingMode });
        const vf = new VideoFrame(canvas, { timestamp: timestampUs, duration: durationUs });
        encoder.encode(vf, { keyFrame: index === 0 || index % Math.max(1, Math.round(fps * 2)) === 0 });
        vf.close();
        timestampUs += durationUs;
      } finally { bitmap.close?.(); }
      self.postMessage({ type:'progress', value:(index+1)/frames.length, label:'Codificando fotograma '+(index+1)+' de '+frames.length });
    }
    await encoder.flush();
    encoder.close();
    if (errors.length) throw errors[0];
    const blob = encodeWebMFromChunks(chunks, {
      width, height, codec: configuredCodec === 'vp8' ? 'vp8' : 'vp9',
      durationMs: durationMs || timestampUs / 1000
    });
    const buffer = await blob.arrayBuffer();
    self.postMessage({ type:'done', mime:blob.type, buffer }, [buffer]);
  } catch (error) {
    self.postMessage({ type:'error', name:error?.name || 'Error', message:error?.message || String(error) });
  }
};
