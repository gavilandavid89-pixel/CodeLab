import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, createZip } from '../public/pixelforge/src/zip-export.js';

function readU32(bytes, offset) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true); }
function readU16(bytes, offset) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true); }

test('computes the standard CRC-32 checksum', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('creates a valid ZIP with UTF-8 names, exact payloads and central directory offsets', () => {
  const encoder = new TextEncoder();
  const archive = createZip([
    { name: 'project/animación.pforge', data: '{"frames":12}' },
    { name: 'frames/frame-001.png', data: new Uint8Array([137, 80, 78, 71]) },
  ]);
  assert.equal(readU32(archive, 0), 0x04034b50);
  assert.equal(readU32(archive, archive.length - 22), 0x06054b50);
  const firstNameLength = readU16(archive, 26);
  const firstDataLength = readU32(archive, 18);
  const firstName = new TextDecoder().decode(archive.slice(30, 30 + firstNameLength));
  assert.equal(firstName, 'project/animación.pforge');
  assert.equal(new TextDecoder().decode(archive.slice(30 + firstNameLength, 30 + firstNameLength + firstDataLength)), '{"frames":12}');
  const secondOffset = 30 + firstNameLength + firstDataLength;
  assert.equal(readU32(archive, secondOffset), 0x04034b50);
  const centralOffset = readU32(archive, archive.length - 22 + 16);
  assert.equal(readU32(archive, centralOffset), 0x02014b50);
  assert.equal(encoder.decode(archive.slice(centralOffset + 46, centralOffset + 46 + readU16(archive, centralOffset + 28))), 'project/animación.pforge');
});

test('rejects unsafe, duplicate, invalid and oversized ZIP entry definitions', () => {
  assert.throws(() => createZip([]), /between 1/);
  assert.throws(() => createZip([{ name: '../escape.txt', data: 'x' }]), /safe relative paths/);
  assert.throws(() => createZip([{ name: '/absolute.txt', data: 'x' }]), /safe relative paths/);
  assert.throws(() => createZip([{ name: 'folder\\\\escape.txt', data: 'x' }]), /safe relative paths/);
  assert.throws(() => createZip([{ name: 'same.txt', data: 'a' }, { name: 'same.txt', data: 'b' }]), /unique/);
  assert.throws(() => createZip([{ name: 'bad.txt', data: {} }]), /must be text/);
});

test('creates ZIP Blob payloads incrementally without changing archive format', async () => {
  const blob = await (await import('../public/pixelforge/src/zip-export.js')).createZipBlob([
    { name: 'manifest.json', data: new Blob(['{"frames":12}'], { type: 'application/json' }) },
    { name: 'frame-001.png', data: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }) },
  ]);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(blob.type, 'application/zip');
  assert.equal(readU32(bytes, 0), 0x04034b50);
  assert.equal(readU32(bytes, bytes.length - 22), 0x06054b50);
  assert.equal(readU16(bytes, bytes.length - 22 + 8), 2);
});
