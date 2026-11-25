const textEncoder = new TextEncoder();

function ebmlId(id) {
  const bytes = [];
  for (let shift = (Math.ceil((Math.log2(id + 1)) / 8) - 1) * 8; shift >= 0; shift -= 8) bytes.push((id >>> shift) & 255);
  return new Uint8Array(bytes.length ? bytes : [0]);
}
function vint(value) {
  if (!Number.isInteger(value) || value < 0) throw new RangeError('Invalid EBML value.');
  for (let length = 1; length <= 8; length++) {
    const max = Math.pow(2, 7 * length) - 1;
    if (value <= max) {
      const out = new Uint8Array(length);
      let v = value;
      for (let i = length - 1; i >= 0; i--) { out[i] = v & 255; v = Math.floor(v / 256); }
      out[0] |= 1 << (8 - length);
      return out;
    }
  }
  throw new RangeError('EBML value is too large.');
}
function uint(value, length) {
  const out = new Uint8Array(length);
  let v = BigInt(Math.max(0, Math.floor(value)));
  for (let i = length - 1; i >= 0; i--) { out[i] = Number(v & 255n); v >>= 8n; }
  return out;
}
function float64(value) {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value, false);
  return new Uint8Array(buffer);
}
function element(id, data) {
  const payload = data instanceof Uint8Array ? data : new Uint8Array(data);
  return concat([ebmlId(id), vint(payload.length), payload]);
}
function concat(parts) {
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
function str(value) { return textEncoder.encode(String(value)); }

function codecConfig(codec, width, height) {
  if (codec === 'vp9') return { codecId: 'V_VP9', mime: 'video/webm;codecs=vp9' };
  if (codec === 'vp8') return { codecId: 'V_VP8', mime: 'video/webm;codecs=vp8' };
  throw new Error('WebM export only supports VP8/VP9.');
}

export function webmMimeForCodec(codec) {
  return codecConfig(codec, 1, 1).mime;
}

export function encodeWebMFromChunks(chunks, { width, height, codec = 'vp9', durationMs = 0 }) {
  if (!chunks?.length) throw new Error('El codificador no produjo fotogramas.');
  const { codecId } = codecConfig(codec, width, height);
  const timecodeScale = 1000000; // one EBML tick = 1 ms
  const ebmlHeader = element(0x1a45dfa3, concat([
    element(0x4286, uint(1, 1)),
    element(0x42f7, uint(1, 1)),
    element(0x42f2, uint(4, 1)),
    element(0x42f3, uint(4, 1)),
    element(0x4282, str('webm')),
    element(0x4287, uint(4, 1)),
    element(0x4285, uint(2, 1))
  ]));
  const info = element(0x1549a966, concat([
    element(0x2ad7b1, uint(timecodeScale, 4)),
    element(0x4d80, str('CodeLab PixelForge Video Composer')),
    element(0x5741, str('CodeLab')),
    element(0x4489, float64(durationMs))
  ]));
  const trackEntry = element(0xae, concat([
    element(0xd7, uint(1, 1)),
    element(0x73c5, uint(1, 1)),
    element(0x83, uint(1, 1)),
    element(0x86, str(codecId)),
    element(0xe0, concat([
      element(0xb0, uint(width, 2)),
      element(0xba, uint(height, 2))
    ]))
  ]));
  const tracks = element(0x1654ae6b, trackEntry);

  const clusters = [];
  let clusterParts = [];
  let clusterStart = null;
   const flushCluster = () => {
    if (!clusterParts.length) return;
    clusters.push(element(0x1f43b675, concat([
      element(0xe7, uint(clusterStart, 4)),
      ...clusterParts
    ])));
    clusterParts = [];
    clusterStart = null;
  };
  for (const chunk of chunks) {
    const timestampMs = Math.max(0, Math.round(chunk.timestamp / 1000));
    if (clusterStart === null || timestampMs - clusterStart > 5000 || timestampMs - clusterStart > 32760) {
      flushCluster();
      clusterStart = timestampMs;
    }
    const relative = timestampMs - clusterStart;
    const flags = chunk.type === 'key' ? 0x80 : 0x00;
    const block = concat([
      new Uint8Array([0x81]),
      new Uint8Array([(relative >> 8) & 255, relative & 255]),
      new Uint8Array([flags]),
      new Uint8Array(chunk.byteLength)
    ]);
    // EncodedVideoChunk exposes its bytes through copyTo(); it does not expose
    // a raw chunk.data buffer. Leaving the destination zero-filled produces a
    // structurally valid WebM whose VP8/VP9 payload is invalid.
    const chunkBytes = new Uint8Array(chunk.byteLength);
    chunk.copyTo(chunkBytes);
    block.set(chunkBytes, 4);
    clusterParts.push(element(0xa3, block));
  }
  flushCluster();

  const segmentPayload = concat([info, tracks, ...clusters]);
  const segment = concat([
    ebmlId(0x18538067),
    new Uint8Array([0x01,0xff,0xff,0xff,0xff,0xff,0xff,0xff]),
    segmentPayload
  ]);
  return new Blob([ebmlHeader, segment], { type: codecConfig(codec, width, height).mime });
}

export async function encodeWebMFrames(frames, options = {}) {
  const { onProgress, isCancelled } = options;
  if (typeof Worker !== 'undefined' && typeof URL !== 'undefined' && typeof Blob !== 'undefined') {
    const worker = new Worker(new URL('./video-webm-encoder-worker.mjs', import.meta.url), { type: 'module' });
    const transferableFrames = frames.map(frame => ({
    durationMs: frame.durationMs, blob: frame.blob,
    width: frame.width, height: frame.height,
    layers: Array.isArray(frame.layers) ? frame.layers.map(layer => ({ ...layer })) : undefined,
    scalingMode: ['smooth', 'pixelated'].includes(frame.scalingMode) ? frame.scalingMode : options.scalingMode
  }));
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = fn => { if (settled) return; settled = true; worker.terminate(); fn(); };
      worker.onmessage = event => {
        const data = event.data || {};
        if (data.type === 'progress') { onProgress?.(data.value, data.label); return; }
        if (data.type === 'done') finish(() => resolve(new Blob([data.buffer], { type:data.mime })));
        if (data.type === 'error') finish(() => reject(Object.assign(new Error(data.message), { name:data.name })));
      };
      worker.onerror = event => finish(() => reject(new Error(event.message || 'Falló el worker de exportación.')));
      const cancelTimer = setInterval(() => {
        if (isCancelled?.()) { clearInterval(cancelTimer); finish(() => reject(new DOMException('Exportación cancelada.', 'AbortError'))); }
      }, 100);
      const originalFinish = finish;
      const wrappedFinish = fn => { clearInterval(cancelTimer); originalFinish(fn); };
      // Replace handlers' close path with cancellation-aware cleanup.
      worker.onmessage = event => {
        const data = event.data || {};
        if (data.type === 'progress') { onProgress?.(data.value, data.label); return; }
        if (data.type === 'done') wrappedFinish(() => resolve(new Blob([data.buffer], { type:data.mime })));
        if (data.type === 'error') wrappedFinish(() => reject(Object.assign(new Error(data.message), { name:data.name })));
      };
      worker.onerror = event => wrappedFinish(() => reject(new Error(event.message || 'Falló el worker de exportación.')));
      worker.postMessage({
        frames: transferableFrames, width:options.width, height:options.height, codec:options.codec,
        fps:options.fps, durationMs:options.durationMs, backgroundColor:options.backgroundColor,
        scalingMode:options.scalingMode, fitMode:options.fitMode
      });
    });
  }
  throw new Error('Este navegador no admite Workers para exportación determinista.');
}
