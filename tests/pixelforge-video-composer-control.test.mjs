import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { RasterDocument } from '../public/pixelforge/src/core.js';
import { controlPixelForgeVideoComposer, validateVideoComposerOperations } from '../pixelforge-video-composer-control.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(root, 'public');

test('Video Composer remote controls import, inspect, seek, configure and capture a real preview', {
  timeout: 120000
}, async () => {
  const document = new RasterDocument(32, 32, 'Remote Composer Proof');
  const pixels = new Uint8Array(32 * 32 * 4);
  for (let y = 8; y < 24; y++) for (let x = 8; x < 24; x++) {
    const offset = (y * 32 + x) * 4;
    pixels[offset] = 220; pixels[offset + 1] = 80; pixels[offset + 2] = 40; pixels[offset + 3] = 255;
  }
  document.setLayerPixels(document.activeLayerId, pixels);
  const project = document.toJSON();
  project.id = 'remote_composer_proof';
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const relative = decodeURIComponent(url.pathname).split('/').filter(Boolean).join('/');
    const filePath = path.resolve(publicRoot, relative);
    if (filePath !== publicRoot && !filePath.startsWith(publicRoot + path.sep)) {
      res.writeHead(403); res.end(); return;
    }
    try {
      const bytes = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const types = {
        '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
        '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml', '.png': 'image/png'
      };
      res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream' });
      res.end(bytes);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const previousUrl = process.env.RENDER_EXTERNAL_URL;
  process.env.RENDER_EXTERNAL_URL = 'http://127.0.0.1:' + server.address().port;
  try {
    const result = await controlPixelForgeVideoComposer({
      project_id: project.id,
      operations: [
        { type: 'inspect' },
        { type: 'seek', index: 0 },
        { type: 'configure', format: 'webm-vp9', output_fps: 24, resolution: '720', aspect: '1:1', loop_export: true },
        { type: 'capture_preview' },
        { type: 'capture_studio' },
        { type: 'record_studio', duration_ms: 1000 }
      ]
    }, {
      loadProject: async () => ({ project, serverRevision: 7, contentSha256: 'test-sha' }),
      targetPixelForgeWorkspace: () => 'ws_test',
      workspaceTokenFor: () => 'test-token',
      storeArtifact: async artifact => ({ artifactId: 'a'.repeat(32), kind: artifact.kind, filename: artifact.filename, sizeBytes: artifact.bytes.length, signature: artifact.bytes.subarray(0, 4).toString('hex') })
    });
    assert.equal(result.projectId, project.id);
    assert.equal(result.serverRevision, 7);
    assert.equal(result.package.format, 'codelab');
    assert.equal(result.package.version, 2);
    assert.equal(result.imported.frames, 1);
    assert.equal(result.operations.length, 6);
    assert.equal(result.operations[0].state.frameCount, 1);
    assert.equal(result.operations[2].settings.outputFps, 24);
    const preview = Buffer.from(result.operations[3].dataBase64, 'base64');
    assert.deepEqual([...preview.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(result.diagnostics.pageErrors.length, 0);
    assert.equal(result.artifacts.length, 2);
    assert.equal(result.artifacts.find(item => item.kind === 'pixelforge_composer_png').signature, '89504e47');
    assert.equal(result.artifacts.find(item => item.kind === 'pixelforge_composer_video').signature, '1a45dfa3');
  } finally {
    if (previousUrl === undefined) delete process.env.RENDER_EXTERNAL_URL;
    else process.env.RENDER_EXTERNAL_URL = previousUrl;
    await new Promise(resolve => server.close(resolve));
  }
});

test('Video Composer remote operation validation rejects unsafe or unsupported controls', () => {
  assert.throws(() => validateVideoComposerOperations([]), /between 1 and 20/);
  assert.throws(() => validateVideoComposerOperations([{ type: 'record_studio', duration_ms: 60000 }]), /1,000 and 30,000/);
  assert.throws(() => validateVideoComposerOperations([{ type: 'play', duration_ms: 60000 }]), /100 and 10,000/);
  assert.throws(() => validateVideoComposerOperations([{ type: 'configure', output_fps: 120 }]), /12, 24, 30 or 60/);
});
