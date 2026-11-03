'use strict';

const MAX_CODE_CHUNK_CHARS = 200000;

/**
 * Split generated code into the minimum number of bounded chunks.
 * Boundaries never separate the two UTF-16 code units of a surrogate pair.
 */
function splitCodeChunks(value, maxChunkChars = MAX_CODE_CHUNK_CHARS) {
  if (typeof value !== 'string') throw new TypeError('Code value must be a string.');
  if (!Number.isInteger(maxChunkChars) || maxChunkChars < 2) {
    throw new RangeError('maxChunkChars must be an integer of at least 2.');
  }
  if (value.length === 0) return [''];

  const chunks = [];
  let offset = 0;
  while (offset < value.length) {
    let end = Math.min(offset + maxChunkChars, value.length);
    if (end < value.length) {
      const previous = value.charCodeAt(end - 1);
      const next = value.charCodeAt(end);
      if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        end--;
      }
    }
    chunks.push(value.slice(offset, end));
    offset = end;
  }
  return chunks;
}

module.exports = { MAX_CODE_CHUNK_CHARS, splitCodeChunks };
