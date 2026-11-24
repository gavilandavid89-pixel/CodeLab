import test from 'node:test';
import assert from 'node:assert/strict';
import { expectedFrameNames, validateFrameNames, validateProbe } from '../scripts/codelab-encode-soldier-walk-mp4.mjs';

test('Soldier Walk encoder expects exactly 20 ordered frame PNGs', () => {
  const names = expectedFrameNames();
  assert.equal(names.length, 20);
  assert.equal(names[0], 'frame-000.png');
  assert.equal(names[19], 'frame-019.png');
  assert.deepEqual(validateFrameNames(names), names);
  assert.throws(() => validateFrameNames(names.slice(0, 19)), /Expected exactly 20/);
  assert.throws(() => validateFrameNames([...names, 'frame-020.png']), /Expected exactly 20/);
});

test('MP4 verification rejects wrong codec, frame count, FPS and duration', () => {
  const valid = { streams: [{ codec_type: 'video', codec_name: 'h264', nb_frames: '20', avg_frame_rate: '12/1' }], format: { duration: '1.666667' } };
  assert.equal(validateProbe(valid).frames, 20);
  assert.throws(() => validateProbe({ ...valid, streams: [{ ...valid.streams[0], codec_name: 'mpeg4' }] }), /H.264/);
  assert.throws(() => validateProbe({ ...valid, streams: [{ ...valid.streams[0], nb_frames: '19' }] }), /frame count mismatch/);
  assert.throws(() => validateProbe({ ...valid, streams: [{ ...valid.streams[0], avg_frame_rate: '24/1' }] }), /FPS mismatch/);
  assert.throws(() => validateProbe({ ...valid, format: { duration: '3.0' } }), /duration mismatch/);
});
