'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_CODE_CHUNK_CHARS, splitCodeChunks } = require('./code-chunks');

test('calculates one chunk for content within the limit', () => {
  const source = 'const x = "hello";';
  assert.deepEqual(splitCodeChunks(source), [source]);
});

test('splits large content into bounded chunks and reconstructs exactly', () => {
  const source = 'a'.repeat(MAX_CODE_CHUNK_CHARS * 2 + 17);
  const chunks = splitCodeChunks(source);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every(chunk => chunk.length <= MAX_CODE_CHUNK_CHARS));
  assert.equal(chunks.join(''), source);
});

test('does not split an emoji surrogate pair at a chunk boundary', () => {
  const source = 'a'.repeat(MAX_CODE_CHUNK_CHARS - 1) + '😀' + 'z'.repeat(50);
  const chunks = splitCodeChunks(source);
  assert.equal(chunks.join(''), source);
  assert.equal(chunks[0].endsWith('\ud83d'), false);
  assert.equal(chunks[1].startsWith('\ude00'), false);
  assert.ok(chunks.every(chunk => chunk.length <= MAX_CODE_CHUNK_CHARS));
});

test('preserves empty strings and rejects invalid arguments', () => {
  assert.deepEqual(splitCodeChunks(''), ['']);
  assert.throws(() => splitCodeChunks(null), /must be a string/);
  assert.throws(() => splitCodeChunks('x', 1), /at least 2/);
});
