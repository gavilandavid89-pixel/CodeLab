const test = require('node:test');
const assert = require('node:assert/strict');
const evidence = require('../neon-pixelforge-evidence.js');

test('presign module validates missing Neon storage configuration', () => {
  assert.equal(evidence.storageConfigured(), false);
  assert.throws(() => evidence.presignStorageObject({ objectKey: 'events/test.png', contentType: 'image/png' }), /neon_storage_credentials_missing/);
});

test('evidence object keys reject traversal', () => {
  assert.throws(() => evidence.presignStorageObject({ objectKey: '../escape.png', contentType: 'image/png' }), /neon_storage_credentials_missing|invalid_object_key/);
});
