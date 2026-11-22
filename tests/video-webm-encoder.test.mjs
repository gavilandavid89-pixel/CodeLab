import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWebMFromChunks } from '../public/pixelforge/src/video-webm-encoder.mjs';

test('WebM muxer copies EncodedVideoChunk bytes instead of reading a nonexistent data property', async () => {
  const payload = new Uint8Array([0x83, 0x42, 0x11, 0xaa, 0x55]);
  const chunk = {
    type: 'key',
    timestamp: 0,
    byteLength: payload.byteLength,
    copyTo(target) { target.set(payload); }
  };
  const blob = encodeWebMFromChunks([chunk], {
    width: 32,
    height: 32,
    codec: 'vp9',
    durationMs: 83
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(blob.type, 'video/webm;codecs=vp9');
  assert.deepEqual(Array.from(bytes.slice(-payload.length)), Array.from(payload));
});

test('WebM muxer keeps cluster timecodes wide enough for long timelines', async () => {
  const payload = new Uint8Array([0x83, 0x42, 0x11]);
  const chunks = [0, 70000].map(timestamp => ({
    type: 'key',
    timestamp: timestamp * 1000,
    byteLength: payload.byteLength,
    copyTo(target) { target.set(payload); }
  }));
  const blob = encodeWebMFromChunks(chunks, {
    width: 32,
    height: 32,
    codec: 'vp9',
    durationMs: 70083
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.ok(bytes.length > 100);
  assert.equal(blob.type, 'video/webm;codecs=vp9');
});
