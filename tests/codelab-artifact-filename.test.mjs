import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCodelabPackageEntries, canonicalCodeLabArtifactFilename } from '../codelab-project-artifact-import.mjs';

test('accepts editor-specific root marker files and legacy project.codelab markers', () => {
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
  assert.equal(assertCodelabPackageEntries(['project.codelab-pixelforge', 'manifest.json', 'project.json']), true);
  assert.equal(assertCodelabPackageEntries(['project.codelab-web', 'manifest.json', 'project.json']), true);
  assert.equal(assertCodelabPackageEntries(['project.codelab-design', 'manifest.json', 'project.json']), true);
});

test('rejects ZIP archives without an editor marker', () => {
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

test('normalizes outer artifact filenames to the editor-specific suffix', () => {
  assert.equal(canonicalCodeLabArtifactFilename('project.codelab', 'pixelforge'), 'project.codelab-pixelforge');
  assert.equal(canonicalCodeLabArtifactFilename('project.codelab', 'web'), 'project.codelab-web');
  assert.equal(canonicalCodeLabArtifactFilename('project.codelab-design', 'design'), 'project.codelab-design');
  assert.throws(() => canonicalCodeLabArtifactFilename('project.codelab-web', 'pixelforge'), /does not match/);
  assert.throws(() => canonicalCodeLabArtifactFilename('project.zip', 'web'), /must end/);
});

test('rejects multiple editor marker files in a single package', () => {
  assert.throws(() => assertCodelabPackageEntries([
    'project.codelab', 'project.codelab-pixelforge', 'manifest.json', 'project.json',
  ]), /multiple editor marker files/);
});
