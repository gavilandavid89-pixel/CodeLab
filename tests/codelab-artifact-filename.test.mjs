import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCodelabPackageEntries } from '../codelab-project-artifact-import.mjs';

test('accepts any archive filename when the root project.codelab marker exists', () => {
  assert.equal(assertCodelabPackageEntries([
    'project.codelab',
    'manifest.json',
    'project.json',
    'assets/',
    'assets/portrait.png',
    'scenes/main.scene',
    'custom-data/metadata.json',
    'README.txt',
  ]), true);
});

test('rejects ZIP archives without the root project.codelab marker', () => {
  assert.throws(() => assertCodelabPackageEntries([
    'manifest.json', 'project.json', 'assets/portrait.png',
  ]), /root project\.codelab marker is missing/);
});

test('does not accept a nested marker as the project marker', () => {
  assert.throws(() => assertCodelabPackageEntries([
    'nested/project.codelab', 'manifest.json', 'project.json',
  ]), /root project\.codelab marker is missing/);
});

test('rejects unsafe or duplicate archive paths', () => {
  assert.throws(() => assertCodelabPackageEntries([
    'project.codelab', 'manifest.json', 'project.json', '../outside.txt',
  ]), /Unsafe path/);
  assert.throws(() => assertCodelabPackageEntries([
    'project.codelab', 'manifest.json', 'project.json', 'assets/a.png', 'assets/a.png',
  ]), /Duplicate entry/);
});
