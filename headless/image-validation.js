'use strict';

const MAX_EDITOR_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_EDITOR_IMAGE_DATA_URL_LENGTH = 2800000;

function imageBytesMatchMime(bytes, mimeType) {
  if (mimeType === 'image/png') {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === 'image/gif') {
    const signature = bytes.length >= 6 ? bytes.subarray(0, 6).toString('ascii') : '';
    return signature === 'GIF87a' || signature === 'GIF89a';
  }
  if (mimeType === 'image/webp') {
    return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return false;
}

function parseEditorImageDataUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_EDITOR_IMAGE_DATA_URL_LENGTH) {
    throw new Error('Image data URL exceeds the editor limit.');
  }
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match) throw new Error('Image upload must be a PNG, JPEG, WebP, or GIF data URL.');
  const payload = match[2];
  if (payload.length % 4 !== 0) throw new Error('Image upload contains invalid Base64 data.');
  const bytes = Buffer.from(payload, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== payload) throw new Error('Image upload contains invalid Base64 data.');
  if (bytes.length > MAX_EDITOR_IMAGE_BYTES) throw new Error('Image exceeds the editor 2 MB upload limit.');
  const mimeType = match[1].toLowerCase();
  if (!imageBytesMatchMime(bytes, mimeType)) throw new Error('Image bytes do not match the declared MIME type.');
  return { mimeType, byteLength: bytes.length };
}

function isValidEditorImageDataUrl(value) {
  try {
    parseEditorImageDataUrl(value);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { parseEditorImageDataUrl, isValidEditorImageDataUrl, MAX_EDITOR_IMAGE_BYTES };
