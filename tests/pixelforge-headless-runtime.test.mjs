import test from 'node:test';
import assert from 'node:assert/strict';
import { HeadlessEditorRuntime } from '../public/pixelforge/src/headless.js';

function projectFixture() {
  const runtime = new HeadlessEditorRuntime({ width: 16, height: 16, name: 'Headless fixture' });
  return runtime.toJSON();
}

test('headless runtime opens a persisted PixelForge project without changing its identity', () => {
  const fixture = projectFixture();
  fixture.serverRevision = 7;
  const runtime = HeadlessEditorRuntime.fromJSON(fixture);
  const state = runtime.inspect();
  assert.equal(state.project.id, fixture.id);
  assert.equal(state.project.serverRevision, 7);
  assert.equal(state.project.width, 16);
  assert.equal(state.project.layerCount, 1);
  assert.equal(state.sandbox.hasChanges, false);
});

test('headless batch edits an isolated sandbox and commits only after proposal acceptance', () => {
  const fixture = projectFixture();
  const runtime = HeadlessEditorRuntime.fromJSON(fixture);
  const before = runtime.toJSON();
  const batch = runtime.executeBatch([
    { name: 'canvas.draw_line', x0: 1, y0: 2, x1: 10, y1: 2, color: '#FF3300', size: 1 },
    { name: 'canvas.fill', x: 1, y: 2, color: '#00AA44', tolerance: 0, contiguous: true },
  ]);
  assert.equal(batch.ok, true);
  assert.equal(runtime.hasPendingChanges, true);
  assert.deepEqual(runtime.document.toJSON(), before, 'source document must remain untouched before review');
  assert.throws(() => runtime.toJSON(), /Unreviewed sandbox changes/);
  const proposal = runtime.createProposal('Draw a line and fill the connected area');
  assert.ok(proposal.id);
  assert.equal(runtime.acceptProposal().status, 'applied');
  assert.equal(runtime.hasPendingChanges, false);
  const saved = runtime.toJSON();
  assert.equal(saved.id, fixture.id);
  assert.ok(saved.revision > fixture.revision);
  assert.ok(saved.layers[0].pixels !== fixture.layers[0].pixels);
});

test('headless batch stops at first invalid action and never creates a proposal implicitly', () => {
  const runtime = HeadlessEditorRuntime.fromJSON(projectFixture());
  const result = runtime.executeBatch([
    { name: 'canvas.draw_line', x0: 0, y0: 0, x1: 3, y1: 0, color: '#112233' },
    { name: 'canvas.get_pixel', x: 99, y: 99 },
    { name: 'history.undo' },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.failedIndex, 1);
  assert.equal(result.results.length, 2);
  assert.equal(runtime.hasPendingChanges, true);
  assert.equal(runtime.hasPendingProposal, false);
});

test('headless proposal rejects a stale source revision', () => {
  const runtime = HeadlessEditorRuntime.fromJSON(projectFixture());
  assert.equal(runtime.execute({ name: 'canvas.draw_line', x0: 1, y0: 1, x1: 5, y1: 1, color: '#123456' }).ok, true);
  runtime.createProposal('Stale proposal');
  runtime.document.setLayerOpacity(runtime.document.activeLayerId, 0.5);
  const result = runtime.acceptProposal();
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'stale-base');
});
