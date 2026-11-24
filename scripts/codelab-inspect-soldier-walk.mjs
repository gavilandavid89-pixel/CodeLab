import fs from 'node:fs/promises';

const projectId = process.env.CODELAB_PROJECT_ID || 'soldier-walk-60f-20261124';
const baseUrl = String(process.env.CODELAB_PUBLIC_URL || 'https://codelab-qedi.onrender.com').replace(/\/+$/, '');
const token = String(process.env.CODELAB_AGENT_BRIDGE_CONTROL_SECRET || '');
const outDir = process.env.RUNNER_TEMP || '/tmp';
if (!token) throw new Error('CODELAB_AGENT_BRIDGE_CONTROL_SECRET is required');

const response = await fetch(baseUrl + '/api/agent/bridge/pixelforge/projects/' + encodeURIComponent(projectId), {
  headers: { 'x-codelab-agent-bridge-token': token, accept: 'application/json' },
  signal: AbortSignal.timeout(120000)
});
const body = await response.json().catch(() => ({}));
if (!response.ok) throw new Error('ADMIN snapshot failed: HTTP ' + response.status + ' ' + String(body.error || 'unknown'));
if (body.workspaceId !== 'ws_local_admin') throw new Error('Refusing non-ADMIN workspace');
const project = body.project;
const animation = project?.animation;
if (!animation?.frames?.length) throw new Error('Persisted project has no animation frames');

const manifest = {
  projectId, workspaceId: body.workspaceId, serverRevision: body.serverRevision,
  contentSha256: body.contentSha256, width: project.width, height: project.height,
  fps: animation.fps, frameCount: animation.frames.length,
  layerIds: animation.layerIds,
  layers: project.layers.map(({id,name,visible,opacity}) => ({id,name,visible,opacity})),
  frameCelSummary: animation.frames.map((frame,index) => ({
    index, id: frame.id, durationMs: frame.durationMs,
    cels: frame.cels.map(cel => ({
      layerId: cel.layerId, encoding: cel.encoding || 'base64-rgba',
      bytes: Buffer.from(cel.pixels || '', 'base64').length,
      alphaPixels: (() => { const b=Buffer.from(cel.pixels||'','base64'); let n=0; for(let i=3;i<b.length;i+=4) if(b[i]) n++; return n; })()
    }))
  }))
};
await fs.writeFile(outDir + '/soldier-walk-project.json', JSON.stringify(project));
await fs.writeFile(outDir + '/soldier-walk-inspection.json', JSON.stringify(manifest,null,2));
console.log('[INSPECT] ' + JSON.stringify(manifest));
