import { validateDimensions } from './core.js';

const MAX_HEADER_BYTES = 1024 * 1024;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const MIME_FORMAT = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp', 'image/gif': 'gif' };

function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}
function u16be(bytes, offset) { return (bytes[offset] << 8) | bytes[offset + 1]; }
function u16le(bytes, offset) { return bytes[offset] | (bytes[offset + 1] << 8); }
function u24le(bytes, offset) { return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16); }
function u32le(bytes, offset) { return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0; }
function u32be(bytes, offset) { return ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0; }

function parsePng(bytes) {
  if (bytes.length < 24 || !PNG_SIGNATURE.every((value, index) => bytes[index] === value) || u32be(bytes, 8) !== 13 || ascii(bytes, 12, 4) !== 'IHDR') {
    throw new TypeError('The PNG header is incomplete or invalid.');
  }
  return { width: u32be(bytes, 16), height: u32be(bytes, 20), format: 'png' };
}
function parseGif(bytes) {
  const signature = ascii(bytes, 0, 6);
  if (bytes.length < 10 || (signature !== 'GIF87a' && signature !== 'GIF89a')) throw new TypeError('The GIF header is incomplete or invalid.');
  return { width: u16le(bytes, 6), height: u16le(bytes, 8), format: 'gif' };
}
function parseWebp(bytes) {
  if (bytes.length < 21 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') throw new TypeError('The WebP header is incomplete or invalid.');
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const kind = ascii(bytes, offset, 4), size = u32le(bytes, offset + 4), data = offset + 8;
    if (size > bytes.length - data) throw new TypeError('The WebP dimension header is incomplete.');
    if (kind === 'VP8X' && size >= 10) {
      return { width: 1 + u24le(bytes, data + 4), height: 1 + u24le(bytes, data + 7), format: 'webp' };
    }
    if (kind === 'VP8L' && size >= 5 && bytes[data] === 0x2f) {
      const b1 = bytes[data + 1], b2 = bytes[data + 2], b3 = bytes[data + 3], b4 = bytes[data + 4];
      return { width: 1 + ((b2 & 0x3f) << 8) + b1, height: 1 + ((b4 & 0x0f) << 10) + (b3 << 2) + ((b2 & 0xc0) >> 6), format: 'webp' };
    }
    if (kind === 'VP8 ' && size >= 10 && bytes[data + 3] === 0x9d && bytes[data + 4] === 0x01 && bytes[data + 5] === 0x2a) {
      return { width: u16le(bytes, data + 6) & 0x3fff, height: u16le(bytes, data + 8) & 0x3fff, format: 'webp' };
    }
    offset = data + size + (size & 1);
  }
  throw new TypeError('Could not verify dimensions from this WebP header.');
}
function parseJpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new TypeError('The JPEG header is incomplete or invalid.');
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) { offset++; continue; }
    while (bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > bytes.length) break;
    const segmentLength = u16be(bytes, offset);
    if (segmentLength < 2) throw new TypeError('The JPEG contains an invalid segment length.');
    if (JPEG_SOF.has(marker)) {
      if (segmentLength < 7 || offset + segmentLength > bytes.length) throw new TypeError('The JPEG dimensions are incomplete.');
      return { height: u16be(bytes, offset + 3), width: u16be(bytes, offset + 5), format: 'jpeg' };
    }
    if (offset + segmentLength > bytes.length) break;
    offset += segmentLength;
  }
  throw new TypeError('Could not verify JPEG dimensions within the 1 MiB header scan limit.');
}

/** Validate dimensions from a bounded file header before asking the browser to decode image pixels. */
export async function preflightImageFile(file, filename = file?.name ?? '') {
  if (!file || typeof file.slice !== 'function' || !Number.isFinite(file.size)) throw new TypeError('Invalid image file.');
  const extension = String(filename).toLowerCase().split('.').pop();
  const format = ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension) ? extension : MIME_FORMAT[file.type];
  if (!format) throw new TypeError('Supported image imports are PNG, JPEG, WebP and GIF.');
  const bytes = new Uint8Array(await file.slice(0, Math.min(file.size, MAX_HEADER_BYTES)).arrayBuffer());
  let info;
  if (format === 'png') info = parsePng(bytes);
  else if (format === 'gif') info = parseGif(bytes);
  else if (format === 'webp') info = parseWebp(bytes);
  else info = parseJpeg(bytes);
  validateDimensions(info.width, info.height);
  return info;
}
