/**
 * Penpot 2.19.0 Transit JSON codec for CodeLab's native RPC adapter.
 *
 * This module intentionally handles only the wire format. It does not dispatch
 * commands, authenticate users, or authorize project/file identifiers.
 */
'use strict';

const transit = require('transit-js');

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function asTransitText(input, maxBytes) {
  let value;
  if (typeof input === 'string') {
    value = input;
  } else if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    if (input.byteLength > maxBytes) {
      throw Object.assign(new Error('penpot_transit_body_too_large'), {
        code: 'PENPOT_TRANSIT_BODY_TOO_LARGE'
      });
    }
    value = Buffer.from(input).toString('utf8');
  } else {
    throw Object.assign(new TypeError('penpot_transit_input_must_be_text_or_bytes'), {
      code: 'PENPOT_TRANSIT_INVALID_INPUT'
    });
  }

  if (byteLength(value) > maxBytes) {
    throw Object.assign(new Error('penpot_transit_body_too_large'), {
      code: 'PENPOT_TRANSIT_BODY_TOO_LARGE'
    });
  }
  return value;
}

function decodeOrderedMap(rep) {
  if (!Array.isArray(rep)) {
    throw new TypeError('invalid_ordered_map_representation');
  }
  const entries = [];
  for (const entry of rep) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new TypeError('invalid_ordered_map_entry');
    }
    entries.push(entry[0], entry[1]);
  }
  return transit.map(entries);
}

function decodeTransit(input, options = {}) {
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : DEFAULT_MAX_BYTES;
  const source = asTransitText(input, maxBytes);

  const reader = transit.reader('json', {
    handlers: {
      // Matches app.common.transit's ClojureScript handler (js/parseInt).
      n: value => {
        const parsed = Number.parseInt(String(value), 10);
        if (!Number.isFinite(parsed)) throw new TypeError('invalid_penpot_integer');
        return parsed;
      },
      // Keep UUIDs typed so a later Transit response can preserve the UUID tag.
      u: value => transit.uuid(String(value)),
      'ordered-map': decodeOrderedMap,
      'ordered-set': value => {
        if (!Array.isArray(value)) throw new TypeError('invalid_ordered_set_representation');
        return transit.set(value);
      },
      m: value => {
        const milliseconds = Number.parseInt(String(value), 10);
        if (!Number.isFinite(milliseconds)) throw new TypeError('invalid_penpot_instant');
        return new Date(milliseconds);
      },
      uri: value => transit.uri(String(value)),
      // Preserve the opaque upstream pointer tag until a project-aware layer
      // explicitly decides how to resolve it.
      'penpot/pointer': value => transit.tagged('penpot/pointer', value)
    }
  });

  return reader.read(source);
}

function encodeTransit(value, options = {}) {
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : DEFAULT_MAX_BYTES;
  const writer = transit.writer('json');
  const encoded = writer.write(value);
  if (byteLength(encoded) > maxBytes) {
    throw Object.assign(new Error('penpot_transit_body_too_large'), {
      code: 'PENPOT_TRANSIT_BODY_TOO_LARGE'
    });
  }
  return encoded;
}

function isTransitContentType(contentType) {
  return /^application\/transit\+json(?:\s*;|\s*$)/i.test(String(contentType || '').trim());
}

module.exports = {
  DEFAULT_MAX_BYTES,
  decodeTransit,
  encodeTransit,
  isTransitContentType
};
