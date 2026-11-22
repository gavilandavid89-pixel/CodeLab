import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCodelabArtifactFilename } from '../codelab-project-artifact-import.mjs';

test('accepts only filenames ending in .codelab', () => {
  assert.equal(assertCodelabArtifactFilename('project.codelab'), true);
  assert.equal(assertCodelabArtifactFilename('portrait-animation.CODELAB'), true);
});

test('rejects generic ZIP files and unsafe artifact filenames', () => {
  for (const filename of ['project.zip', 'project.zip.codelab.exe', 'project.codelab.zip', '../project.codelab', '', null]) {
    assert.throws(() => assertCodelabArtifactFilename(filename), /Only \.codelab project packages/);
  }
});
