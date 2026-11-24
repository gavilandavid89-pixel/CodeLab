import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { chromium as playwrightChromium } from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';

const projectId = process.env.CODELAB_PROJECT_ID || 'soldier-walk-60f-20261124';
const baseUrl = String(process.env.CODELAB_PUBLIC_URL || 'https://codelab-qedi.onrender.com').replace(/\/+$/, '');
const bridgeToken = String(process.env.CODELAB_AGENT_BRIDGE_CONTROL_SECRET || '');
const expectedWorkspace = 'ws_local_admin';

if (!bridgeToken) throw new Error('CODELAB_AGENT_BRIDGE_CONTROL_SECRET is required.');

async function bridgeGet(pathname) {
  const response = await fetch(baseUrl + pathname, {
    headers: { 'x-codelab-agent-bridge-token': bridgeToken, accept: 'application/json' },
    signal: AbortSignal.timeout(120000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('ADMIN bridge GET HTTP ' + response.status + ': ' + String(body.error || 'request_failed'));
  return body;
}

async function bridgePost(pathname, payload = {}) {
  const response = await fetch(baseUrl + pathname, { method:'POST', headers:{'x-codelab-agent-bridge-token':bridgeToken,'content-type':'application/json',accept:'application/json'}, body:JSON.stringify(payload), signal:AbortSignal.timeout(30000) });
  const body = await response.json().catch(()=>({}));
  if (!response.ok) throw new Error('ADMIN bridge POST HTTP ' + response.status + ': ' + String(body.error || 'request_failed'));
  return body;
}

function alphaBounds(base64, width, height) {
  const bytes = Buffer.from(base64, 'base64');
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0;
  for (let p = 0; p < width * height; p++) {
    if (bytes[p * 4 + 3] === 0) continue;
    const x = p % width, y = Math.floor(p / width);
    count++; minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return maxX < 0 ? null : {
    minX, minY, maxX, maxY,
    width: maxX - minX + 1, height: maxY - minY + 1,
    area: (maxX - minX + 1) * (maxY - minY + 1),
    alphaPixels: count, centerX: (minX + maxX) / 2, centerY: (minY + maxY) / 2
  };
}

function shiftRgba(base64, width, height, dx, dy) {
  if (!dx && !dy) return base64;
  const src = Buffer.from(base64, 'base64');
  const dst = Buffer.alloc(src.length);
  for (let y = 0; y < height; y++) {
    const ny = y + dy; if (ny < 0 || ny >= height) continue;
    for (let x = 0; x < width; x++) {
      const nx = x + dx; if (nx < 0 || nx >= width) continue;
      src.copy(dst, (ny * width + nx) * 4, (y * width + x) * 4, (y * width + x + 1) * 4);
    }
  }
  return dst.toString('base64');
}

function classify(layer, geometry, all, width, height) {
  const name = String(layer.name || '').toLowerCase();
  if (/(head|helmet|cabeza|casco)/.test(name)) return 'head';
  if (/(torso|body|chest|cuerpo|pecho)/.test(name)) return 'torso';
  if (/(arm|hand|brazo|mano|shoulder|hombro)/.test(name)) return 'arms';
  if (/(leg|foot|feet|pierna|pie|boot|bota)/.test(name)) return 'legs';
  if (geometry.centerY < height * 0.38) return 'head';
  if (geometry.centerY > height * 0.62) return 'legs';
  const middle = all.filter(x => x.geometry && x.geometry.centerY >= height * 0.38 && x.geometry.centerY <= height * 0.62);
  if (middle.length > 1) return middle.slice().sort((a,b) => b.geometry.area - a.geometry.area)[0] === geometry ? 'torso' : 'arms';
  return 'torso';
}

function motion(role, phase, singleLayer) {
  const two = phase * 2;
  if (singleLayer) return { dx: Math.round(1.0 * Math.sin(phase)), dy: Math.round(1.5 * Math.cos(two)) };
  if (role === 'head') return { dx: Math.round(0.5 * Math.sin(phase)), dy: Math.round(1.0 * Math.cos(two)) };
  if (role === 'torso') return { dx: Math.round(1.0 * Math.sin(phase)), dy: Math.round(1.5 * Math.cos(two)) };
  if (role === 'arms') return { dx: Math.round(-1.0 * Math.sin(phase)), dy: Math.round(0.8 * Math.sin(two + Math.PI)) };
  if (role === 'legs') return { dx: Math.round(1.5 * Math.sin(phase + Math.PI / 2)), dy: Math.round(0.8 * Math.cos(two)) };
  return { dx: 0, dy: 0 };
}

async function uploadProject(page, project, expectedRevision) {
  const serialized = JSON.stringify(project);
  const totalBytes = Buffer.byteLength(serialized, 'utf8');
  const chunkSize = 6 * 1024 * 1024;
  const totalChunks = Math.ceil(totalBytes / chunkSize);
  const uploadId = randomUUID().replace(/-/g, '').slice(0, 32);

  const begin = await page.evaluate(async body => {
    const r = await fetch('/api/pixelforge/projects/uploads', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) });
    return { status:r.status, body:await r.json().catch(()=>({})) };
  }, { uploadId, projectId, expectedServerRevision:expectedRevision, totalBytes, totalChunks });
  if (![200,201].includes(begin.status)) throw new Error('Upload begin failed: HTTP '+begin.status+' '+JSON.stringify(begin.body));

  for (let index=0; index<totalChunks; index++) {
    const bytes = Buffer.from(serialized, 'utf8').subarray(index*chunkSize, Math.min(totalBytes,(index+1)*chunkSize));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const result = await page.evaluate(async ({uploadId,index,chunk,sha256}) => {
      const r = await fetch('/api/pixelforge/projects/uploads/'+uploadId+'/'+index,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({chunk,sha256})});
      return {status:r.status,body:await r.json().catch(()=>({}))};
    }, {uploadId,index,chunk:bytes.toString('base64'),sha256});
    if (result.status !== 200) throw new Error('Upload chunk '+index+' failed: HTTP '+result.status+' '+JSON.stringify(result.body));
  }

  const commit = await page.evaluate(async uploadId => {
    const r = await fetch('/api/pixelforge/projects/uploads/'+uploadId+'/commit',{method:'POST'});
    return {status:r.status,body:await r.json().catch(()=>({}))};
  }, uploadId);
  if (![200,201].includes(commit.status)) throw new Error('Upload commit failed: HTTP '+commit.status+' '+JSON.stringify(commit.body));
  return commit.body;
}

const snapshot = await bridgeGet('/api/agent/bridge/pixelforge/projects/' + encodeURIComponent(projectId));
if (snapshot.workspaceId !== expectedWorkspace) throw new Error('Unexpected workspace.');
const project = JSON.parse(JSON.stringify(snapshot.project));
const revision = Number(snapshot.serverRevision);
const animation = project.animation;
if (!animation || !Array.isArray(animation.frames) || animation.frames.length !== 20 || animation.fps !== 12) {
  throw new Error('Pinned Soldier Walk timeline must remain exactly 20 frames at 12 FPS.');
}
const animatedLayerIds = Array.isArray(animation.layerIds) ? animation.layerIds : [];
const animatedLayers = animatedLayerIds.map(id => project.layers.find(layer => layer.id === id)).filter(Boolean).filter(layer => /soldier|character|person/i.test(String(layer.name || '')));
if (!animatedLayers.length) throw new Error('No animated source layers found.');

const geometry = [];
for (const layer of animatedLayers) {
  const samples = [];
  for (const frame of animation.frames) {
    const cel = frame.cels.find(item => item.layerId === layer.id);
    if (!cel || typeof cel.pixels !== 'string') throw new Error('Missing cel for animated layer '+layer.id);
    const b = alphaBounds(cel.pixels, project.width, project.height);
    if (b) samples.push(b);
  }
  geometry.push({
    layer, geometry: samples.length ? {
      centerX: samples.reduce((s,b)=>s+b.centerX,0)/samples.length,
      centerY: samples.reduce((s,b)=>s+b.centerY,0)/samples.length,
      area: samples.reduce((s,b)=>s+b.area,0)/samples.length
    } : null
  });
}
console.log('[POLISH-DIRECT] Source:', JSON.stringify({
  projectId, workspaceId:snapshot.workspaceId, revision, sha256:snapshot.contentSha256,
  frameCount:animation.frames.length, fps:animation.fps,
  animatedLayers:animatedLayers.map(x=>({id:x.id,name:x.name}))
}));
console.log('[POLISH-DIRECT] Geometry:', JSON.stringify(geometry.map(x=>({id:x.layer.id,name:x.layer.name,geometry:x.geometry}))));

const roles = geometry.map(x => ({...x, role: x.geometry ? classify(x.layer,x.geometry,geometry,project.width,project.height) : 'none'}));
const singleLayer = roles.length === 1;
let changedPixels = 0;
for (let index=0; index<animation.frames.length; index++) {
  const phase = index / animation.frames.length * Math.PI * 2;
  const frame = animation.frames[index];
  for (const item of roles) {
    if (!item.geometry) continue;
    const cel = frame.cels.find(c => c.layerId === item.layer.id);
    const m = motion(item.role, phase, singleLayer);
    if (!m.dx && !m.dy) continue;
    const before = Buffer.from(cel.pixels,'base64');
    const after = Buffer.from(shiftRgba(cel.pixels,project.width,project.height,m.dx,m.dy),'base64');
    for (let p=0; p<before.length; p+=4) {
      if (before[p]!==after[p] || before[p+1]!==after[p+1] || before[p+2]!==after[p+2] || before[p+3]!==after[p+3]) changedPixels++;
    }
    cel.pixels = after.toString('base64');
  }
}
if (changedPixels < 1) throw new Error('Polish generated no pixel changes.');
project.serverRevision = revision + 1;

const browser = await playwrightChromium.launch({args:chromiumBinary.args, executablePath:await chromiumBinary.executablePath(), headless:true, timeout:60000});
try {
  const context = await browser.newContext({viewport:{width:1440,height:960},colorScheme:'dark'});
  const page = await context.newPage();
  const handoff = await bridgePost('/api/agent/bridge/admin-handoff');
  const response = await page.goto(baseUrl+'/api/auth/native-handoff?ticket='+encodeURIComponent(handoff.ticket),{waitUntil:'domcontentloaded',timeout:30000});
  if (!response || ![200,303].includes(response.status())) throw new Error('ADMIN handoff failed.');
  const saved = await uploadProject(page,project,revision);
  console.log('[POLISH-DIRECT] Upload saved:',JSON.stringify(saved));
} finally { await browser.close().catch(()=>{}); }

const verify = await bridgeGet('/api/agent/bridge/pixelforge/projects/' + encodeURIComponent(projectId));
if (Number(verify.serverRevision)!==revision+1) throw new Error('Revision did not advance exactly one step.');
if (verify.contentSha256===snapshot.contentSha256) throw new Error('Content hash did not change.');
console.log('[POLISH-DIRECT] Persisted verification:',JSON.stringify({
  beforeRevision:revision,afterRevision:Number(verify.serverRevision),
  beforeSha256:snapshot.contentSha256,afterSha256:verify.contentSha256,
  frameCount:verify.project.animation.frames.length,fps:verify.project.animation.fps,
  changedPixels,roles:roles.map(x=>({id:x.layer.id,name:x.layer.name,role:x.role}))
}));
await fs.writeFile(process.env.GITHUB_STEP_SUMMARY_FILE||'polish-verification.json',JSON.stringify({
  status:'verified',projectId,workspaceId:expectedWorkspace,beforeRevision:revision,
  afterRevision:Number(verify.serverRevision),beforeSha256:snapshot.contentSha256,
  afterSha256:verify.contentSha256,frameCount:verify.project.animation.frames.length,
  fps:verify.project.animation.fps,changedPixels,
  roles:roles.map(x=>({id:x.layer.id,name:x.layer.name,role:x.role})),
  method:'Authenticated ADMIN PixelForge snapshot + direct cel pose polish + authenticated chunk upload.'
},null,2));
