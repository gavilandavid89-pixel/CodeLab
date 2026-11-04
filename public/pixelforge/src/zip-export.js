const UTF8 = new TextEncoder();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return UTF8.encode(value);
  throw new TypeError('ZIP entry data must be text, an ArrayBuffer, or a byte array.');
}

function write16(view, offset, value) { view.setUint16(offset, value, true); }
function write32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }

/**
 * Build a standards-compliant ZIP archive using the STORE method.
 * PNG/JPEG/audio payloads are already compressed; avoiding a second
 * compression pass keeps CPU and memory predictable on mobile devices.
 */
export function createZip(entries) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 65535) {
    throw new RangeError('ZIP archives must contain between 1 and 65,535 entries.');
  }
  const names = new Set();
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  let totalBytes = 0;

  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string' || !entry.name || entry.name.startsWith('/') ||
        entry.name.includes('\\') || entry.name.split('/').some(part => part === '..' || part === '.')) {
      throw new TypeError('ZIP entry names must be safe relative paths.');
    }
    if (names.has(entry.name)) throw new TypeError('ZIP entry names must be unique.');
    names.add(entry.name);
    const nameBytes = UTF8.encode(entry.name);
    if (nameBytes.length > 65535) throw new RangeError('ZIP entry name is too long.');
    const data = asBytes(entry.data);
    if (data.byteLength > 0xffffffff) throw new RangeError('ZIP64 entries are not supported.');
    totalBytes += data.byteLength;
    if (totalBytes > 0xffffffff) throw new RangeError('ZIP64 archives are not supported.');

    const checksum = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const localView = new DataView(local.buffer);
    write32(localView, 0, 0x04034b50);
    write16(localView, 4, 20);
    write16(localView, 6, 0x0800);
    write16(localView, 8, 0);
    write16(localView, 10, 0);
    write16(localView, 12, 0);
    write32(localView, 14, checksum);
    write32(localView, 18, data.length);
    write32(localView, 22, data.length);
    write16(localView, 26, nameBytes.length);
    write16(localView, 28, 0);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    localParts.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    write32(centralView, 0, 0x02014b50);
    write16(centralView, 4, 20);
    write16(centralView, 6, 20);
    write16(centralView, 8, 0x0800);
    write16(centralView, 10, 0);
    write16(centralView, 12, 0);
    write16(centralView, 14, 0);
    write32(centralView, 16, checksum);
    write32(centralView, 20, data.length);
    write32(centralView, 24, data.length);
    write16(centralView, 28, nameBytes.length);
    write16(centralView, 30, 0);
    write16(centralView, 32, 0);
    write16(centralView, 34, 0);
    write16(centralView, 36, 0);
    write32(centralView, 38, 0);
    write32(centralView, 42, localOffset);
    central.set(nameBytes, 46);
    centralParts.push(central);
    localOffset += local.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  write32(endView, 0, 0x06054b50);
  write16(endView, 4, 0);
  write16(endView, 6, 0);
  write16(endView, 8, entries.length);
  write16(endView, 10, entries.length);
  write32(endView, 12, centralSize);
  write32(endView, 16, localOffset);
  write16(endView, 20, 0);

  const archive = new Uint8Array(localOffset + centralSize + end.length);
  let cursor = 0;
  for (const part of localParts) { archive.set(part, cursor); cursor += part.length; }
  for (const part of centralParts) { archive.set(part, cursor); cursor += part.length; }
  archive.set(end, cursor);
  return archive;
}

/**
 * Streaming-friendly ZIP builder. Blob payloads are checksummed one at a time
 * and retained as Blob parts, avoiding a second full-size copy of an animation
 * package in memory on mobile devices.
 */
export async function createZipBlob(entries) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 65535) {
    throw new RangeError('ZIP archives must contain between 1 and 65,535 entries.');
  }
  const names = new Set();
  const parts = [];
  const centralParts = [];
  let localOffset = 0;
  let totalBytes = 0;
  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string' || !entry.name || entry.name.startsWith('/') ||
        entry.name.includes('\\') || entry.name.split('/').some(part => part === '..' || part === '.')) {
      throw new TypeError('ZIP entry names must be safe relative paths.');
    }
    if (names.has(entry.name)) throw new TypeError('ZIP entry names must be unique.');
    names.add(entry.name);
    const nameBytes = UTF8.encode(entry.name);
    if (nameBytes.length > 65535) throw new RangeError('ZIP entry name is too long.');
    const blob = entry.data instanceof Blob ? entry.data : new Blob([asBytes(entry.data)]);
    if (blob.size > 0xffffffff) throw new RangeError('ZIP64 entries are not supported.');
    totalBytes += blob.size;
    if (totalBytes > 0xffffffff) throw new RangeError('ZIP64 archives are not supported.');
    const checksum = crc32(new Uint8Array(await blob.arrayBuffer()));
    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    write32(localView, 0, 0x04034b50);
    write16(localView, 4, 20);
    write16(localView, 6, 0x0800);
    write16(localView, 8, 0);
    write16(localView, 10, 0);
    write16(localView, 12, 0);
    write32(localView, 14, checksum);
    write32(localView, 18, blob.size);
    write32(localView, 22, blob.size);
    write16(localView, 26, nameBytes.length);
    write16(localView, 28, 0);
    local.set(nameBytes, 30);
    parts.push(local, blob);

    const central = new Uint8Array(46 + nameBytes.length);
    const view = new DataView(central.buffer);
    write32(view, 0, 0x02014b50);
    write16(view, 4, 20);
    write16(view, 6, 20);
    write16(view, 8, 0x0800);
    write16(view, 10, 0);
    write16(view, 12, 0);
    write16(view, 14, 0);
    write32(view, 16, checksum);
    write32(view, 20, blob.size);
    write32(view, 24, blob.size);
    write16(view, 28, nameBytes.length);
    write16(view, 30, 0);
    write16(view, 32, 0);
    write16(view, 34, 0);
    write16(view, 36, 0);
    write32(view, 38, 0);
    write32(view, 42, localOffset);
    central.set(nameBytes, 46);
    centralParts.push(central);
    localOffset += local.length + blob.size;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  write32(view, 0, 0x06054b50);
  write16(view, 4, 0);
  write16(view, 6, 0);
  write16(view, 8, entries.length);
  write16(view, 10, entries.length);
  write32(view, 12, centralSize);
  write32(view, 16, localOffset);
  write16(view, 20, 0);
  parts.push(...centralParts, end);
  return new Blob(parts, { type: 'application/zip' });
}
