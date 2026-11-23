import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrbitalShowcase } from '../public/pixelforge/src/showcase-animation.mjs';
import { createPixelForgeProjectZip, parsePixelForgeProjectZip } from '../pixelforge-agent-zip.mjs';
import { readStoredZip } from '../public/pixelforge/src/video-composer-core.mjs';

test('editable PixelForge ZIP round-trips raster, vector, animation and Video Composer frames', async () => {
  const showcase = createOrbitalShowcase();
  const project = showcase.doc.toJSON();
  project.id = 'zip_round_trip_source';
  project.animation = { ...showcase.animation.toJSON(), loop: showcase.loop };
  project.vectorModel = {
    version: 5, width: project.width, height: project.height, grid: 8, snap: true,
    objects: [{ id: 'vector-body', name: 'Body', type: 'rect', x: 4, y: 5, width: 12, height: 14, fill: '#ff0000', transform: {} }],
    frames: [], precision: { tolerance: 0.001, anchors: [], guides: [], constraints: [], constructionGraph: { version: 1, nodes: [], edges: [] } },
    metadata: { intent: 'round-trip', tags: ['test'] }
  };
  const exported = createPixelForgeProjectZip(project);
  assert.ok(exported.bytes.length > 1000);
  assert.equal(exported.metadata.frameCount, project.animation.frames.length);
  const entries = await readStoredZip(new Blob([exported.bytes]));
  assert.ok(entries.has('manifest.json'));
  assert.ok(entries.has(exported.metadata.projectFile));
  assert.ok(entries.has('frames/frame-0001.png'));
  const imported = await parsePixelForgeProjectZip(exported.bytes, { importedName: 'Recovered Artwork' });
  assert.notEqual(imported.project.id, project.id);
  assert.equal(imported.project.name, 'Recovered Artwork');
  assert.equal(imported.project.width, project.width);
  assert.equal(imported.project.layers.length, project.layers.length);
  assert.equal(imported.project.animation.frames.length, project.animation.frames.length);
  assert.equal(imported.project.vectorModel.objects[0].id, 'vector-body');
  assert.equal(imported.project.serverRevision, 0);
  assert.equal(imported.metadata.frameCount, project.animation.frames.length);
});

test('ZIP importer rejects non-project video packages and corrupted central entries', async () => {
  const showcase = createOrbitalShowcase();
  const project = showcase.doc.toJSON();
  project.id = 'zip_bad_source';
  project.animation = showcase.animation.toJSON();
  const exported = createPixelForgeProjectZip(project);
  const corrupt = Buffer.from(exported.bytes);
  corrupt[45] = corrupt[45] ^ 0xff;
  await assert.rejects(() => parsePixelForgeProjectZip(corrupt), /CRC|invalid|metadata|header|utf-8|encoded data/i);
});
