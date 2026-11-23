const decoder = new TextDecoder('utf-8', { fatal: true });
const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_ENTRIES = 512;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_CENTRAL_BYTES = 8 * 1024 * 1024;

function u16(view, offset) { return view.getUint16(offset, true); }
function u32(view, offset) { return view.getUint32(offset, true); }

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

async function crc32Blob(blob) {
  let crc = 0xffffffff;
  const consume = bytes => {
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  };
  if (typeof blob.stream === 'function') {
    const reader = blob.stream().getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        consume(value);
      }
    } finally { reader.releaseLock(); }
  } else consume(new Uint8Array(await blob.arrayBuffer()));
  return (crc ^ 0xffffffff) >>> 0;
}

function crc32Bytes(bytes, start, end) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index++) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function validatePng(blob, expectedWidth, expectedHeight) {
  if (blob.size < 57) throw new TypeError('Frame image is not a complete PNG file.');
  const signature = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  if (signature.length !== 8 || signature[0] !== 137 || signature[1] !== 80 ||
      signature[2] !== 78 || signature[3] !== 71 || signature[4] !== 13 ||
      signature[5] !== 10 || signature[6] !== 26 || signature[7] !== 10) {
    throw new TypeError('Frame image is not a complete PNG file.');
  }
  let offset = 8, sawHeader = false, sawData = false, sawEnd = false;
  while (offset < blob.size) {
    if (offset + 12 > blob.size) throw new TypeError('PNG chunk header is truncated.');
    const header = new Uint8Array(await blob.slice(offset, offset + 8).arrayBuffer());
    const length = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(0, false);
    const dataStart = offset + 8, crcOffset = dataStart + length, chunkEnd = crcOffset + 4;
    if (chunkEnd > blob.size) throw new TypeError('PNG chunk payload is truncated.');
    const typeBytes = header.slice(4, 8);
    const type = String.fromCharCode(...typeBytes);
    const crcBytes = new Uint8Array(await blob.slice(crcOffset, chunkEnd).arrayBuffer());
    const expectedCrc = new DataView(crcBytes.buffer, crcBytes.byteOffset, crcBytes.byteLength).getUint32(0, false);
    const actualCrc = await crc32Blob(new Blob([typeBytes, blob.slice(dataStart, crcOffset)]));
    if (actualCrc !== expectedCrc) throw new TypeError('PNG ' + type + ' chunk failed its CRC integrity check.');
    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) throw new TypeError('PNG must begin with a valid IHDR chunk.');
      const dimensions = new DataView(await blob.slice(dataStart, dataStart + 8).arrayBuffer());
      const width = dimensions.getUint32(0, false), height = dimensions.getUint32(4, false);
      if (width !== expectedWidth || height !== expectedHeight) {
        throw new TypeError('PNG frame dimensions do not match the video manifest.');
      }
      sawHeader = true;
    } else if (type === 'IHDR') throw new TypeError('PNG contains more than one IHDR chunk.');
    if (type === 'IDAT') sawData = true;
    if (type === 'IEND') {
      if (length !== 0 || !sawData) throw new TypeError('PNG IEND is invalid or image data is missing.');
      sawEnd = true;
      if (chunkEnd !== blob.size) throw new TypeError('PNG contains data after its IEND chunk.');
      break;
    }
    offset = chunkEnd;
  }
  if (!sawHeader || !sawData || !sawEnd) throw new TypeError('PNG is missing required image chunks.');
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    try {
      if (bitmap.width !== expectedWidth || bitmap.height !== expectedHeight) {
        throw new TypeError('Decoded PNG dimensions do not match the video manifest.');
      }
    } finally { bitmap.close?.(); }
  }
}


function safeName(name) {
  return typeof name === 'string' && name.length > 0 && !name.startsWith('/') &&
    !name.includes('\\') && !name.split('/').some(part => part === '..' || part === '.');
}

export async function readStoredZip(blob, { maxEntries = MAX_ENTRIES, maxTotalBytes = MAX_TOTAL_BYTES } = {}) {
  if (!(blob instanceof Blob) || blob.size < 22) throw new TypeError('Select a valid PixelForge ZIP package.');
  const tailStart = Math.max(0, blob.size - 65557);
  const tail = new Uint8Array(await blob.slice(tailStart).arrayBuffer());
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let offset = tail.length - 22; offset >= 0; offset--) {
    if (u32(tailView, offset) === EOCD) { eocd = offset; break; }
  }
  if (eocd < 0) throw new TypeError('The ZIP central directory is missing or invalid.');
  if (u16(tailView, eocd + 4) !== 0 || u16(tailView, eocd + 6) !== 0) {
    throw new TypeError('Multi-disk ZIP packages are not supported.');
  }
  const countOnDisk = u16(tailView, eocd + 8);
  const count = u16(tailView, eocd + 10);
  if (countOnDisk !== count) throw new TypeError('Split ZIP central directories are not supported.');
  const centralSize = u32(tailView, eocd + 12);
  const centralOffset = u32(tailView, eocd + 16);
  if (count < 1 || count > maxEntries) throw new RangeError('The ZIP package contains too many entries.');
  if (centralSize > MAX_CENTRAL_BYTES || centralOffset + centralSize > blob.size) {
    throw new RangeError('The ZIP central directory exceeds the safe inspection limit.');
  }
  const centralBytes = new Uint8Array(await blob.slice(centralOffset, centralOffset + centralSize).arrayBuffer());
  const view = new DataView(centralBytes.buffer, centralBytes.byteOffset, centralBytes.byteLength);
  const entries = new Map();
  let cursor = 0, total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > centralBytes.length || u32(view, cursor) !== CENTRAL) {
      throw new TypeError('The ZIP central directory contains an invalid entry.');
    }
    const flags = u16(view, cursor + 8);
    const method = u16(view, cursor + 10);
    const crc = u32(view, cursor + 16);
    const compressedSize = u32(view, cursor + 20);
    const uncompressedSize = u32(view, cursor + 24);
    const nameLength = u16(view, cursor + 28);
    const extraLength = u16(view, cursor + 30);
    const commentLength = u16(view, cursor + 32);
    const localOffset = u32(view, cursor + 42);
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > centralBytes.length) throw new TypeError('The ZIP central directory entry is truncated.');
    if (flags & 1) throw new TypeError('Encrypted ZIP packages are not supported.');
    if (flags & 8) throw new TypeError('ZIP data-descriptor entries are not supported.');
    if (method !== 0 || compressedSize !== uncompressedSize) {
      throw new TypeError('This package uses compression that PixelForge Video Composer cannot stream yet. Re-export it from PixelForge.');
    }
    const name = decoder.decode(centralBytes.slice(cursor + 46, cursor + 46 + nameLength));
    if (!safeName(name)) throw new TypeError('The ZIP package contains an unsafe file path.');
    if (entries.has(name)) throw new TypeError('The ZIP package contains duplicate file names.');
    total += uncompressedSize;
    if (total > maxTotalBytes) throw new RangeError('The ZIP package exceeds the 256 MiB import safety limit.');
    const localHeader = new Uint8Array(await blob.slice(localOffset, localOffset + 30).arrayBuffer());
    if (localHeader.length !== 30 || u32(new DataView(localHeader.buffer), 0) !== LOCAL) {
      throw new TypeError('A ZIP file header is invalid.');
    }
    const localView = new DataView(localHeader.buffer);
    if (u16(localView, 6) !== flags || u16(localView, 8) !== method ||
        u32(localView, 14) !== crc || u32(localView, 18) !== compressedSize ||
        u32(localView, 22) !== uncompressedSize) {
      throw new TypeError('ZIP local and central entry metadata do not match.');
    }
    const localNameLength = u16(localView, 26);
    const localExtraLength = u16(localView, 28);
    const localName = decoder.decode(await blob.slice(localOffset + 30, localOffset + 30 + localNameLength).arrayBuffer());
    if (localName !== name) throw new TypeError('ZIP local and central entry names do not match.');
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > centralOffset || dataEnd > blob.size) throw new RangeError('A ZIP file entry extends beyond the data area.');
    const entryBlob = blob.slice(dataStart, dataEnd);
    if (await crc32Blob(entryBlob) !== crc) throw new TypeError('ZIP entry ' + name + ' failed its CRC integrity check.');
    entries.set(name, { name, blob: entryBlob, size: uncompressedSize, crc32: crc });
    cursor = recordEnd;
  }
  if (cursor !== centralBytes.length) throw new TypeError('The ZIP central directory has unexpected trailing data.');
  return entries;
}

export async function parsePixelForgeVideoPackage(blob) {
  const entries = await readStoredZip(blob);
  const manifestEntry = entries.get('manifest.json');
  if (!manifestEntry || manifestEntry.size > 2 * 1024 * 1024) throw new TypeError('This ZIP does not contain a valid PixelForge video manifest.');
  let manifest;
  try { manifest = JSON.parse(await manifestEntry.blob.text()); }
  catch { throw new TypeError('The video package manifest is not valid JSON.'); }
  if (!manifest || manifest.format !== 'pixelforge-video-package' || manifest.version !== 1 ||
      !Number.isInteger(manifest.width) || manifest.width < 1 || manifest.width > 4096 ||
      !Number.isInteger(manifest.height) || manifest.height < 1 || manifest.height > 4096 ||
      !Number.isInteger(manifest.fps) || manifest.fps < 1 || manifest.fps > 60 ||
      !Array.isArray(manifest.frames) || manifest.frames.length < 1 || manifest.frames.length > 240) {
    throw new TypeError('The PixelForge video manifest has invalid dimensions, FPS or frame count.');
  }
  const seen = new Set();
  const frames = [];
  for (const [index, frame] of manifest.frames.entries()) {
    if (!frame || typeof frame.file !== 'string' || !safeName(frame.file) ||
        !Number.isFinite(frame.durationMs) || frame.durationMs < 1 || frame.durationMs > 10000 ||
        (frame.index !== undefined && frame.index !== index) || seen.has(frame.file)) {
      throw new TypeError('Frame ' + (index + 1) + ' has invalid metadata.');
    }
    const entry = entries.get(frame.file);
    if (!entry || entry.size < 57) throw new TypeError('Frame image ' + (index + 1) + ' is missing or too small.');
    await validatePng(entry.blob, manifest.width, manifest.height);
    seen.add(frame.file);
    frames.push({ ...frame, blob: entry.blob });
  }
  const totalDurationMs = frames.reduce((sum, frame) => sum + frame.durationMs, 0);
  return {
    manifest: { ...manifest, frameCount: frames.length, totalDurationMs },
    frames,
    project: manifest.projectFile && entries.has(manifest.projectFile) ? entries.get(manifest.projectFile).blob : null,
    entryCount: entries.size,
  };
}

/**
 * Convert a variable-duration source timeline into a constant-frame-rate sequence.
 * Each output frame references the source image covering its presentation timestamp.
 */
export function buildConstantFrameRateSequence(frames, fps, { maxFrames = 24000 } = {}) {
  if (!Array.isArray(frames) || frames.length < 1) throw new TypeError('A non-empty source frame sequence is required.');
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw new RangeError('Output FPS must be an integer from 1 to 60.');
  if (!Number.isInteger(maxFrames) || maxFrames < 1) throw new RangeError('Maximum output frame count must be positive.');
  const durations = frames.map(frame => Number(frame?.durationMs));
  if (durations.some(duration => !Number.isFinite(duration) || duration < 1)) {
    throw new TypeError('Every source frame must have a positive finite duration.');
  }
  const totalDurationMs = durations.reduce((sum, duration) => sum + duration, 0);
  const frameIntervalMs = 1000 / fps;
  const outputCount = Math.ceil(totalDurationMs / frameIntervalMs - 1e-10);
  if (!Number.isSafeInteger(outputCount) || outputCount > maxFrames) {
    throw new RangeError('The selected FPS would produce ' + outputCount + ' frames, exceeding the safe export limit of ' + maxFrames + '. Reduce the duration or output FPS.');
  }
  const cumulativeEnds = [];
  let elapsed = 0;
  for (const duration of durations) { elapsed += duration; cumulativeEnds.push(elapsed); }
  const output = [];
  let sourceIndex = 0;
  for (let index = 0; index < outputCount; index++) {
    const timestampMs = index * frameIntervalMs;
    while (sourceIndex < cumulativeEnds.length - 1 && timestampMs >= cumulativeEnds[sourceIndex] - 1e-8) sourceIndex++;
    output.push({
      ...frames[sourceIndex],
      index,
      sourceIndex,
      timestampMs,
      durationMs: Math.min(frameIntervalMs, totalDurationMs - timestampMs),
    });
  }
  return output;
}
