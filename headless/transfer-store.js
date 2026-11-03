'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_CODE_CHARS = 500000;
const MAX_CHUNK_CHARS = 8000;
const MAX_CHUNKS = 70;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BASE64_CHUNKS = 400;
const TTL_MS = 10 * 60 * 1000;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function validId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(value);
}
function imageMime(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}
function createTransferStore(rootDir, now = () => Date.now()) {
  const root = path.resolve(rootDir, 'headless-transfers');
  const ensure = () => {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(root, 0o700); } catch (_) {}
  };
  const file = (kind, id) => {
    if (!validId(id)) throw new Error('invalid_transfer_id');
    return path.join(root, kind + '-' + id + '.json');
  };
  function read(kind, id) {
    ensure();
    const target = file(kind, id);
    if (!fs.existsSync(target)) return null;
    let value;
    try { value = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (_) { fs.unlinkSync(target); return null; }
    if (!value || !Number.isFinite(value.expiresAt) || value.expiresAt <= now()) {
      try { fs.unlinkSync(target); } catch (_) {}
      return null;
    }
    return value;
  }
  function write(kind, id, value) {
    ensure();
    const target = file(kind, id);
    const tmp = target + '.tmp-' + crypto.randomBytes(6).toString('hex');
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, target);
  }
  function beginCode({ workspaceId, projectId, field, source = 'main', baseRevision, totalChunks, sha256: expectedHash }) {
    if (!workspaceId || !projectId || !['html', 'css', 'js'].includes(field) || !['main', 'branch'].includes(source) ||
        !Number.isInteger(baseRevision) || baseRevision < 0 || !Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_CHUNKS ||
        !/^[a-f0-9]{64}$/i.test(expectedHash || '')) throw new Error('invalid_code_transfer');
    const id = crypto.randomUUID().replace(/-/g, '');
    write('code', id, { id, workspaceId, projectId, field, source, baseRevision, totalChunks, expectedHash: expectedHash.toLowerCase(), chunks: {}, expiresAt: now() + TTL_MS });
    return { transferId: id, expiresInMs: TTL_MS, maxChunkChars: MAX_CHUNK_CHARS };
  }
  function putCodeChunk({ transferId, workspaceId, index, chunk, sha256: chunkHash }) {
    const record = read('code', transferId);
    if (!record || record.workspaceId !== workspaceId) throw new Error('transfer_not_found');
    if (!Number.isInteger(index) || index < 0 || index >= record.totalChunks || typeof chunk !== 'string' ||
        chunk.length > MAX_CHUNK_CHARS || sha256(chunk) !== chunkHash) throw new Error('invalid_code_chunk');
    const previous = record.chunks[index];
    if (previous && previous !== chunk) throw new Error('code_chunk_conflict');
    record.chunks[index] = chunk;
    write('code', transferId, record);
    return { transferId, receivedChunks: Object.keys(record.chunks).length, totalChunks: record.totalChunks };
  }
  function assembleCode({ transferId, workspaceId }) {
    const record = read('code', transferId);
    if (!record || record.workspaceId !== workspaceId) throw new Error('transfer_not_found');
    const keys = Object.keys(record.chunks);
    if (keys.length !== record.totalChunks) throw new Error('code_chunks_incomplete');
    const value = Array.from({ length: record.totalChunks }, (_, i) => {
      if (typeof record.chunks[i] !== 'string') throw new Error('code_chunks_incomplete');
      return record.chunks[i];
    }).join('');
    if (value.length > MAX_CODE_CHARS || sha256(value) !== record.expectedHash) throw new Error('code_transfer_hash_mismatch');
    return { ...record, value };
  }
  function consumeCode(transferId) {
    try { fs.unlinkSync(file('code', transferId)); } catch (_) {}
  }
  function beginImage({ workspaceId, projectId, totalChunks, sha256: expectedHash, declaredMime }) {
    if (!workspaceId || !projectId || !Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_IMAGE_BASE64_CHUNKS ||
        !/^[a-f0-9]{64}$/i.test(expectedHash || '') || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(declaredMime)) {
      throw new Error('invalid_image_transfer');
    }
    const id = crypto.randomUUID().replace(/-/g, '');
    write('image-chunks', id, { id, workspaceId, projectId, totalChunks, expectedHash: expectedHash.toLowerCase(), declaredMime, chunks: {}, expiresAt: now() + TTL_MS });
    return { transferId: id, expiresInMs: TTL_MS, maxChunkChars: MAX_CHUNK_CHARS, maxChunks: MAX_IMAGE_BASE64_CHUNKS };
  }
  function putImageChunk({ transferId, workspaceId, index, chunk, sha256: chunkHash }) {
    const record = read('image-chunks', transferId);
    if (!record || record.workspaceId !== workspaceId) throw new Error('transfer_not_found');
    if (!Number.isInteger(index) || index < 0 || index >= record.totalChunks || typeof chunk !== 'string' ||
        chunk.length > MAX_CHUNK_CHARS || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk) || sha256(chunk) !== chunkHash) {
      throw new Error('invalid_image_chunk');
    }
    const previous = record.chunks[index];
    if (previous !== undefined && previous !== chunk) throw new Error('image_chunk_conflict');
    record.chunks[index] = chunk;
    write('image-chunks', transferId, record);
    return { transferId, receivedChunks: Object.keys(record.chunks).length, totalChunks: record.totalChunks };
  }
  function commitImage({ transferId, workspaceId }) {
    const record = read('image-chunks', transferId);
    if (!record || record.workspaceId !== workspaceId) throw new Error('transfer_not_found');
    if (Object.keys(record.chunks).length !== record.totalChunks) throw new Error('image_chunks_incomplete');
    const base64 = Array.from({ length: record.totalChunks }, (_, i) => {
      if (typeof record.chunks[i] !== 'string') throw new Error('image_chunks_incomplete');
      return record.chunks[i];
    }).join('');
    if (!base64 || base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || base64.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
      throw new Error('invalid_image_base64');
    }
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== base64 || sha256(bytes) !== record.expectedHash) {
      throw new Error('image_transfer_hash_mismatch');
    }
    const upload = putImage({ workspaceId, projectId: record.projectId, bytes, declaredMime: record.declaredMime });
    try { fs.unlinkSync(file('image-chunks', transferId)); } catch (_) {}
    return { ...upload, projectId: record.projectId };
  }
  function putImage({ workspaceId, projectId, bytes, declaredMime }) {
    if (!workspaceId || !projectId || !Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_IMAGE_BYTES) throw new Error('invalid_image_size');
    const mime = imageMime(bytes);
    if (!mime || (declaredMime && declaredMime !== mime)) throw new Error('invalid_image_signature');
    const id = crypto.randomUUID().replace(/-/g, '');
    const payload = { id, workspaceId, projectId, mime, bytes: bytes.toString('base64'), sha256: sha256(bytes), expiresAt: now() + TTL_MS };
    write('image', id, payload);
    return { uploadToken: id, mime, bytes: bytes.length, sha256: payload.sha256, expiresInMs: TTL_MS };
  }
  function resolveImage({ uploadToken, workspaceId, projectId, operationId }) {
    const record = read('image', uploadToken);
    if (!record || record.workspaceId !== workspaceId || record.projectId !== projectId) throw new Error('image_upload_not_found');
    // A saved operation may be retried after a lost HTTP response. Permit only that exact
    // operation to resolve its consumed token again; all other reuses remain forbidden.
    if (record.consumedByOperationId &&
        (!operationId || record.consumedByOperationId !== operationId)) throw new Error('image_upload_already_consumed');
    const bytes = Buffer.from(record.bytes, 'base64');
    if (sha256(bytes) !== record.sha256 || imageMime(bytes) !== record.mime) throw new Error('image_upload_corrupt');
    return { mime: record.mime, dataUrl: 'data:' + record.mime + ';base64,' + bytes.toString('base64'), sha256: record.sha256 };
  }
  function consumeImage({ uploadToken, workspaceId, projectId, operationId }) {
    const result = resolveImage({ uploadToken, workspaceId, projectId, operationId });
    if (typeof operationId === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(operationId)) {
      const record = read('image', uploadToken);
      record.consumedByOperationId = operationId;
      write('image', uploadToken, record);
    } else {
      try { fs.unlinkSync(file('image', uploadToken)); } catch (_) {}
    }
    return result;
  }
  return { beginCode, putCodeChunk, assembleCode, consumeCode, beginImage, putImageChunk, commitImage, putImage, resolveImage, consumeImage };
}
module.exports = { createTransferStore, sha256, imageMime, MAX_CODE_CHARS, MAX_CHUNK_CHARS, MAX_CHUNKS, MAX_IMAGE_BYTES, MAX_IMAGE_BASE64_CHUNKS, TTL_MS };
