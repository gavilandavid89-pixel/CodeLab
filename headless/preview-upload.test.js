import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validatePreviewUpload } from './preview-upload.js';

test('accepts small text fixtures and returns decoded bytes', () => {
  const data = Buffer.from('fixture', 'utf8');
  const upload = validatePreviewUpload({ file_name: 'fixture.txt', mime_type: 'text/plain', data_base64: data.toString('base64') });
  assert.equal(upload.fileName, 'fixture.txt');
  assert.equal(upload.mimeType, 'text/plain');
  assert.deepEqual(upload.buffer, data);
});

test('accepts allowed binary signatures', () => {
  const fixtures = [
    ['image.png', 'image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
    ['image.jpg', 'image/jpeg', Buffer.from([255, 216, 255, 0])],
    ['image.webp', 'image/webp', Buffer.from('RIFF0000WEBP')],
    ['document.pdf', 'application/pdf', Buffer.from('%PDF-1.7')]
  ];
  for (const [file_name, mime_type, bytes] of fixtures) {
    assert.equal(validatePreviewUpload({ file_name, mime_type, data_base64: bytes.toString('base64') }).mimeType, mime_type);
  }
});

test('rejects unsafe filenames, unsupported MIME types, and malformed Base64', () => {
  const valid = { file_name: 'fixture.txt', mime_type: 'text/plain', data_base64: Buffer.from('ok').toString('base64') };
  assert.throws(() => validatePreviewUpload({ ...valid, file_name: '../secret.txt' }), /safe filename/);
  assert.throws(() => validatePreviewUpload({ ...valid, mime_type: 'application/octet-stream' }), /allowed MIME type/);
  assert.throws(() => validatePreviewUpload({ ...valid, data_base64: '%%%=' }), /valid Base64/);
});

test('rejects non-canonical Base64 padding bits', () => {
  const valid = { file_name: 'fixture.txt', mime_type: 'text/plain', data_base64: 'Zg==' };
  assert.equal(validatePreviewUpload(valid).buffer.toString('utf8'), 'f');
  assert.throws(() => validatePreviewUpload({ ...valid, data_base64: 'Zh==' }), /canonical Base64/);
  assert.throws(() => validatePreviewUpload({ ...valid, data_base64: 'Zm9=' }), /canonical Base64/);
});

test('rejects mismatched signatures and empty or oversized files', () => {
  assert.throws(() => validatePreviewUpload({ file_name: 'bad.png', mime_type: 'image/png', data_base64: Buffer.from('not png').toString('base64') }), /does not match/);
  assert.throws(() => validatePreviewUpload({ file_name: 'empty.txt', mime_type: 'text/plain', data_base64: 'AAAA'.slice(0, 0) }), /valid Base64/);
  const large = Buffer.alloc(24001, 65).toString('base64');
  assert.throws(() => validatePreviewUpload({ ...{ file_name: 'large.txt', mime_type: 'text/plain' }, data_base64: large }), /at most 32000|between 1 and 24000/);
});
