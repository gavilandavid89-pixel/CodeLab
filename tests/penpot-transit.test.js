const test = require('node:test');
const assert = require('node:assert/strict');
const transit = require('transit-js');
const {
  DEFAULT_MAX_BYTES,
  decodeTransit,
  encodeTransit,
  isTransitContentType
} = require('../penpot-transit');

test('Transit round-trip preserves keyword maps, UUIDs, dates and sets', () => {
  const uuid = '123e4567-e89b-12d3-a456-426614174000';
  const source = transit.map([
    transit.keyword('name'), 'Penpot',
    transit.keyword('id'), transit.uuid(uuid),
    transit.keyword('created-at'), new Date(1700000000000),
    transit.keyword('features'), transit.set(['pages', 'components'])
  ]);

  const decoded = decodeTransit(encodeTransit(source));
  assert.equal(transit.isMap(decoded), true);
  assert.equal(decoded.get(transit.keyword('name')), 'Penpot');
  assert.equal(transit.isUUID(decoded.get(transit.keyword('id'))), true);
  assert.equal(decoded.get(transit.keyword('id')).toString(), uuid);
  assert.equal(decoded.get(transit.keyword('created-at')).getTime(), 1700000000000);
  assert.equal(transit.isSet(decoded.get(transit.keyword('features'))), true);
});

test('Penpot ordered-map and ordered-set tags retain their sequence', () => {
  const orderedMap = decodeTransit(JSON.stringify([
    '~#ordered-map',
    [['~:first', 1], ['~:second', 2]]
  ]));
  assert.equal(transit.isMap(orderedMap), true);
  assert.deepEqual(
    Array.from(orderedMap.entries()).map(([key, value]) => [key.toString(), value]),
    [[':first', 1], [':second', 2]]
  );

  const orderedSet = decodeTransit(JSON.stringify(['~#ordered-set', ['one', 'two']]));
  assert.equal(transit.isSet(orderedSet), true);
  assert.deepEqual(Array.from(orderedSet.values()), ['one', 'two']);
});

test('Penpot scalar extension tags decode to typed values', () => {
  assert.equal(decodeTransit(JSON.stringify(['~#n', '1234'])), 1234);

  const uuid = decodeTransit(JSON.stringify([
    '~#u',
    '123e4567-e89b-12d3-a456-426614174000'
  ]));
  assert.equal(transit.isUUID(uuid), true);

  const instant = decodeTransit(JSON.stringify(['~#m', '1700000000000']));
  assert.equal(instant instanceof Date, true);
  assert.equal(instant.getTime(), 1700000000000);

  const uri = decodeTransit(JSON.stringify(['~#uri', 'https://design.example.test/file']));
  assert.equal(transit.isURI(uri), true);

  const pointer = decodeTransit(JSON.stringify([
    '~#penpot/pointer',
    ['object-1', { source: 'test' }]
  ]));
  assert.equal(transit.isTaggedValue(pointer), true);
  assert.equal(pointer.tag, 'penpot/pointer');
});

test('malformed custom collection tags are rejected', () => {
  assert.throws(
    () => decodeTransit(JSON.stringify(['~#ordered-map', [['missing-value']]])),
    /invalid_ordered_map_entry/
  );
  assert.throws(
    () => decodeTransit(JSON.stringify(['~#ordered-set', 'not-an-array'])),
    /invalid_ordered_set_representation/
  );
});

test('codec rejects oversized and invalid inputs before decoding', () => {
  assert.throws(
    () => decodeTransit(' '.repeat(DEFAULT_MAX_BYTES + 1)),
    error => error.code === 'PENPOT_TRANSIT_BODY_TOO_LARGE'
  );
  assert.throws(
    () => decodeTransit({ not: 'bytes' }),
    error => error.code === 'PENPOT_TRANSIT_INVALID_INPUT'
  );
  assert.throws(
    () => decodeTransit(Buffer.alloc(DEFAULT_MAX_BYTES + 1)),
    error => error.code === 'PENPOT_TRANSIT_BODY_TOO_LARGE'
  );
});

test('codec enforces the encoded response limit', () => {
  assert.throws(
    () => encodeTransit({ payload: 'x'.repeat(100) }, { maxBytes: 20 }),
    error => error.code === 'PENPOT_TRANSIT_BODY_TOO_LARGE'
  );
});

test('Transit content type matching is strict and parameter-aware', () => {
  assert.equal(isTransitContentType('application/transit+json'), true);
  assert.equal(isTransitContentType('application/transit+json; charset=utf-8'), true);
  assert.equal(isTransitContentType('application/json'), false);
  assert.equal(isTransitContentType('text/event-stream'), false);
});
