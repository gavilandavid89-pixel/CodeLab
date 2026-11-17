import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import chromium from '@sparticuz/chromium';
import { chromium as playwrightChromium } from 'playwright-core';
import { createHeadlessRuntime } from '../public/pixelforge/src/headless.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactDir = process.env.HEADLESS_VISUAL_ARTIFACT_DIR
  ? path.resolve(process.env.HEADLESS_VISUAL_ARTIFACT_DIR)
  : path.join(os.tmpdir(), 'codelab-headless-visual-artifacts');

async function ensureArtifactDir() {
  await fs.mkdir(artifactDir, { recursive: true });
}

function action(name, extra = {}) { return { name, ...extra }; }

function buildDetailedDrawingRuntime() {
  const runtime = createHeadlessRuntime({ width: 256, height: 192, name: 'Aurora Runner — Detailed Pixel Study' });
  const batch = [
    action('canvas.fill', { x: 0, y: 0, color: '#07111F' }),
    action('layer.add', { layerName: 'Aurora Gradient' }),
    action('canvas.fill_gradient', { x0: 0, y0: 20, x1: 255, y1: 150, startColor: '#102B55', endColor: '#173E43', opacity: 0.92 }),
    action('layer.add', { layerName: 'Distant Mountains' }),
    action('canvas.draw_stroke', { points: [{x:0,y:135},{x:28,y:118},{x:56,y:139},{x:84,y:108},{x:112,y:130},{x:145,y:102},{x:175,y:128},{x:205,y:112},{x:230,y:130},{x:255,y:110}], color:'#294A64', size:18, hardness:1 }),
    action('layer.add', { layerName: 'Runner Silhouette' }),
    action('canvas.draw_shape', { shape:'ellipse', x:91, y:62, width:32, height:32, color:'#F6C453', size:5 }),
    action('canvas.draw_shape', { shape:'rectangle', x:87, y:91, width:40, height:52, color:'#E65B48', size:7 }),
    action('canvas.draw_stroke', { points: [{x:92,y:101},{x:78,y:119},{x:63,y:135}], color:'#F0A13A', size:8, shape:'circle', symmetryMode:0 }),
    action('canvas.draw_stroke', { points: [{x:122,y:102},{x:137,y:119},{x:155,y:130}], color:'#F0A13A', size:8, shape:'circle' }),
    action('canvas.draw_stroke', { points: [{x:99,y:140},{x:86,y:157},{x:76,y:174}], color:'#3DC7B5', size:10, shape:'circle' }),
    action('canvas.draw_stroke', { points: [{x:117,y:140},{x:132,y:158},{x:151,y:169}], color:'#3DC7B5', size:10, shape:'circle' }),
    action('layer.add', { layerName: 'Armor Highlights' }),
    action('canvas.draw_line', { x0:93, y0:99, x1:121, y1:99, color:'#FFD76A', size:3 }),
    action('canvas.draw_line', { x0:96, y0:111, x1:118, y1:111, color:'#8CE7D8', size:3 }),
    action('canvas.draw_shape', { shape:'rectangle', x:103, y:69, width:8, height:8, color:'#EAF7FF', size:2 }),
    action('layer.add', { layerName: 'Energy Trails' }),
  ];
  for (let i = 0; i < 14; i++) {
    const y = 34 + i * 8;
    batch.push(action('canvas.draw_stroke', {
      points: [{x:28+i*5,y},{x:48+i*6,y:y-5},{x:68+i*7,y:y+2},{x:88+i*8,y:y-4}],
      color: i % 2 ? '#6DE7D0' : '#7FB7FF', size: 2, opacity: 0.48
    }));
  }
  batch.push(
    action('layer.add', { layerName: 'Foreground Particles' }),
    action('canvas.draw_shape', { shape:'ellipse', x:18, y:28, width:7, height:7, color:'#EAF7FF', size:2 }),
    action('canvas.draw_shape', { shape:'ellipse', x:44, y:72, width:5, height:5, color:'#BDE9FF', size:2 }),
    action('canvas.draw_shape', { shape:'ellipse', x:206, y:48, width:8, height:8, color:'#F8D878', size:2 }),
    action('canvas.draw_shape', { shape:'ellipse', x:225, y:84, width:5, height:5, color:'#EAF7FF', size:2 }),
    action('canvas.draw_shape', { shape:'ellipse', x:188, y:151, width:6, height:6, color:'#8CE7D8', size:2 }),
    action('canvas.draw_shape', { shape:'rectangle', x:0, y:181, width:255, height:11, color:'#09131E', size:6 })
  );
  const result = runtime.executeBatch(batch);
  assert.equal(result.ok, true, JSON.stringify(result));
  const proposal = runtime.createProposal('Detailed Aurora Runner pixel-art illustration');
  assert.ok(proposal && typeof proposal === 'object');
  const accepted = runtime.acceptProposal();
  assert.equal(accepted.status, 'applied');
  return runtime;
}

async function saveProjectScreenshot(project, filename, { captureVideo = false, durationMs = 1800 } = {}) {
  await ensureArtifactDir();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codelab-visual-video-'));
  let browser;
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/api/pixelforge/mode') {
      res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({guestMode:true})); return;
    }
    if (url.pathname === '/api/pixelforge/projects/' + encodeURIComponent(project.id)) {
      res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({project})); return;
    }
    if (url.pathname === '/api/pixelforge/projects') {
      res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({projects:[{id:project.id,name:project.name}]})); return;
    }
    const relative = url.pathname === '/' ? 'pixelforge/index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const filePath = path.resolve(root, 'public', relative);
    const publicRoot = path.resolve(root, 'public');
    if (filePath !== publicRoot && !filePath.startsWith(publicRoot + path.sep)) { res.writeHead(403); res.end(); return; }
    try {
      const bytes = fsSync.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'};
      res.writeHead(200, {'content-type':types[ext] || 'application/octet-stream'}); res.end(bytes);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  try {
    chromium.setGraphicsMode = false;
    browser = await playwrightChromium.launch({args: chromium.args, executablePath: await chromium.executablePath(), headless:true, timeout:60000});
    const context = await browser.newContext({
      viewport:{width:1024,height:768}, deviceScaleFactor:1,
      ...(captureVideo ? {recordVideo:{dir:tempDir,size:{width:1024,height:768},fps:24}} : {})
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.stack || e.message || e)));
    await page.goto(baseUrl + '/pixelforge/index.html?projectId=' + encodeURIComponent(project.id) + (captureVideo ? '&capture=video' : ''), {waitUntil:'domcontentloaded',timeout:45000});
    await page.locator('#canvas').waitFor({state:'visible',timeout:30000});
    if (captureVideo) {
      await page.waitForFunction(() => document.documentElement.dataset.pixelforgeCapture === 'complete', null, {timeout: Math.max(30000,durationMs+30000)});
    } else {
      await page.waitForTimeout(900);
    }
    const png = await page.locator('#canvas').screenshot({type:'png'});
    const pngPath = path.join(artifactDir, filename + '.png');
    await fs.writeFile(pngPath, png);
    assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10]);
    const video = captureVideo ? page.video() : null;
    if (captureVideo) {
      await page.close(); await context.close();
      assert.ok(video);
      const webm = await fs.readFile(await video.path());
      const webmPath = path.join(artifactDir, filename + '.webm');
      await fs.writeFile(webmPath, webm);
      assert.ok(webm.length > 1000);
      assert.deepEqual([...webm.subarray(0,4)],[0x1a,0x45,0xdf,0xa3]);
    } else {
      await page.close(); await context.close();
    }
    assert.deepEqual(errors, []);
    return { pngPath, videoPath: captureVideo ? path.join(artifactDir, filename + '.webm') : null };
  } finally {
    if (browser) await browser.close().catch(()=>{});
    await new Promise(resolve => server.close(resolve));
    await fs.rm(tempDir,{recursive:true,force:true});
  }
}

test('heavy CodeLab visual project survives design-to-web inspection and real Chromium capture', {timeout:150000, concurrency:false}, async () => {
  await ensureArtifactDir();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codelab-heavy-project-'));
  const server = createServer();
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const child = spawn(process.execPath,[path.join(root,'server.js')],{
    env:{...process.env,PORT:String(port),NODE_ENV:'test',DATABASE_URL:'',CODELAB_DATA_DIR:dataDir,CODELAB_AGENT_BRIDGE_ENABLED:'0'},
    stdio:['ignore','pipe','pipe']
  });
  let output=''; child.stdout.on('data',c=>output+=c); child.stderr.on('data',c=>output+=c);
  const baseUrl='http://127.0.0.1:'+port;
  let browser;
  try {
    let healthy=false;
    for(let i=0;i<100;i++){ if(child.exitCode!==null) break; try{const r=await fetch(baseUrl+'/api/health'); if(r.ok&&(await r.json()).ok){healthy=true;break;}}catch{} await new Promise(r=>setTimeout(r,150));}
    assert.ok(healthy,'CodeLab must start: '+output);
    const ws=await (await fetch(baseUrl+'/api/workspace/init',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'ws_heavy_visual'})})).json();
    assert.ok(ws.token && ws.state);
    const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+
      ':root{--bg:#07111f;--panel:#10243b;--cyan:#61e7d8;--gold:#ffd66b;--pink:#ef6a8a}*{box-sizing:border-box}body{margin:0;background:linear-gradient(135deg,var(--bg),#122b48 55%,#07151e);color:#eef8ff;font:16px system-ui;min-height:100vh}main{max-width:1180px;margin:auto;padding:42px}header{display:flex;justify-content:space-between;gap:24px;align-items:center}h1{font-size:48px;margin:0;letter-spacing:-2px}p{color:#a9c4d8}.hero{margin-top:34px;padding:32px;border:1px solid #31516d;border-radius:28px;background:rgba(16,36,59,.72);box-shadow:0 20px 80px #0008}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:24px}.card{min-height:190px;padding:22px;border:1px solid #31516d;border-radius:20px;background:#0d1d30}.card strong{display:block;font-size:28px;color:var(--gold);margin-bottom:10px}.cta{display:inline-flex;margin-top:18px;padding:14px 22px;border-radius:999px;background:linear-gradient(90deg,var(--cyan),#86b9ff);color:#06101c;font-weight:800;text-decoration:none}.pulse{width:92px;height:92px;border-radius:50%;margin:28px auto;background:radial-gradient(circle,#fff 0 8%,var(--cyan) 9% 32%,transparent 33%),conic-gradient(var(--cyan),var(--pink),var(--gold),var(--cyan));animation:p 2.2s linear infinite}@keyframes p{to{transform:rotate(360deg) scale(1.08)}}@media(max-width:720px){main{padding:20px}h1{font-size:34px}.grid{grid-template-columns:1fr}} </style></head><body><main><header><div><div>CODELAB / AURORA LAB</div><h1>Aurora Runner</h1><p>Heavy headless project • design → web → runtime → visual QA</p></div><div class="pulse"></div></header><section class="hero"><h2>Mission Control</h2><p>Interactive project surface generated for native headless validation.</p><a class="cta" id="launch" href="#modules">Launch sequence</a><div id="status"></div></section><section id="modules" class="grid"><article class="card"><strong>24</strong> animation states</article><article class="card"><strong>8</strong> visual layers</article><article class="card"><strong>100%</strong> persisted runtime</article></section></main><script>document.getElementById("launch").addEventListener("click",()=>{document.getElementById("status").textContent="Interacción funcionando";});</script></body></html>';
    const project={id:'proj_heavy_aurora_runner',name:'Aurora Runner — Heavy Headless Showcase',type:'web',code:{html,css:'',js:''},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    const saved=await fetch(baseUrl+'/api/workspace/ws_heavy_visual',{method:'PUT',headers:{'content-type':'application/json','x-workspace-token':ws.token},body:JSON.stringify({projects:[project],baseRevision:ws.state.revision})});
    assert.equal(saved.status,200,await saved.text());
    chromium.setGraphicsMode=false;
    browser=await playwrightChromium.launch({args:chromium.args,executablePath:await chromium.executablePath(),headless:true,timeout:60000});
    const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'heavy-browser-'));
    const context=await browser.newContext({viewport:{width:1440,height:1000},recordVideo:{dir:tmp,size:{width:1440,height:1000},fps:24}});
    await context.addInitScript(({id,token})=>{localStorage.setItem('codelab_xd_workspace_v4',id);localStorage.setItem('codelab_xd_workspace_token_v1',token);},{id:'ws_heavy_visual',token:ws.token});
    const page=await context.newPage();
    const errors=[]; page.on('pageerror',e=>errors.push(String(e.message||e)));
    await page.goto(baseUrl+'/?projectId='+project.id,{waitUntil:'domcontentloaded',timeout:45000});
    await page.waitForFunction(name=>document.getElementById('currentProjectTitle')?.textContent.trim()===name,project.name,{timeout:45000});
    await page.frameLocator('#previewIframe').locator('body').waitFor({state:'visible',timeout:30000});
    const studioShot=await page.locator('#studioView').screenshot({type:'png'});
    await fs.writeFile(path.join(artifactDir,'01-heavy-codelab-studio.png'),studioShot);
    assert.match(await page.locator('#currentProjectTitle').innerText(),/Aurora Runner/);
    const webPage=await context.newPage();
    await webPage.setContent(html,{waitUntil:'load'});
    await webPage.locator('#launch').click();
    await webPage.waitForTimeout(250);
    assert.match(await webPage.locator('body').innerText(),/Interacción funcionando/);
    const bodyShot=await webPage.locator('body').screenshot({type:'png'});
    await fs.writeFile(path.join(artifactDir,'01-heavy-codelab-web.png'),bodyShot);
    await webPage.close();
    assert.deepEqual(errors,[]);
    const video=page.video(); await page.close(); await context.close();
    const webm=await fs.readFile(await video.path()); await fs.writeFile(path.join(artifactDir,'01-heavy-codelab-web.webm'),webm);
    assert.ok(webm.length>1000);
    await fs.rm(tmp,{recursive:true,force:true});
  } finally {
    if(browser) await browser.close().catch(()=>{});
    if(child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>{const t=setTimeout(r,5000);child.once('exit',()=>{clearTimeout(t);r();});});}
    await fs.rm(dataDir,{recursive:true,force:true});
  }
});

test('isolated detailed drawing is created by headless raster actions and captured visually', {timeout:120000, concurrency:false}, async () => {
  const runtime=buildDetailedDrawingRuntime();
  const project=runtime.toJSON();
  project.id='pf_isolated_detailed_drawing';
  const info=runtime.inspect();
  assert.ok(info.project.layerCount>=6);
  assert.ok(info.sandbox.hasChanges===false);
  const result=await saveProjectScreenshot(project,'02-isolated-detailed-drawing');
  assert.ok(result.pngPath);
});

test('the exact isolated drawing becomes a multi-frame animation and records native playback', {timeout:150000, concurrency:false}, async () => {
  const runtime=buildDetailedDrawingRuntime();
  const layerId=runtime.document.layers.find(layer=>layer.name==='Runner Silhouette')?.id;
  assert.ok(layerId);
  let frames=0;
  const capture=()=>{const r=runtime.execute(action('animation.frame.capture_document',{frameName:'Runner pose '+(frames+1),durationMs:90}));assert.equal(r.ok,true,JSON.stringify(r));frames++;};
  capture();
  const poses=[
    [{x:91,y:90},{x:84,y:105},{x:72,y:118},{x:58,y:128}],
    [{x:95,y:90},{x:90,y:104},{x:78,y:116},{x:65,y:125}],
    [{x:99,y:90},{x:99,y:105},{x:88,y:114},{x:75,y:120}],
    [{x:103,y:90},{x:108,y:104},{x:98,y:112},{x:86,y:116}],
    [{x:107,y:90},{x:116,y:103},{x:108,y:110},{x:96,y:112}]
  ];
  for(const pose of poses){
    runtime.execute(action('canvas.draw_stroke',{points:pose,color:'#FFD66B',size:5,shape:'circle'}));
    capture();
  }
  for(let i=0;i<6;i++){
    runtime.execute(action('canvas.draw_stroke',{points:[{x:60+i*20,y:154},{x:72+i*20,y:148},{x:84+i*20,y:154}],color:'#7FB7FF',size:2,opacity:0.6}));
    capture();
  }
  const fps=runtime.execute(action('animation.set_fps',{fps:24})); assert.equal(fps.ok,true);
  const proposal=runtime.createProposal('Animate the exact Aurora Runner drawing with progressive running poses and energy trails');
  assert.ok(proposal && typeof proposal === 'object');
  const accepted=runtime.acceptProposal(); assert.equal(accepted.status,'applied');
  const project=runtime.toJSON(); project.id='pf_isolated_runner_animation';
  assert.equal(project.animation.frames.length,12);
  assert.equal(project.animation.fps,24);
  assert.ok(project.animation.frames.every(frame=>frame.durationMs===90));
  const result=await saveProjectScreenshot(project,'03-isolated-runner-animation',{captureVideo:true,durationMs:project.animation.frames.reduce((s,f)=>s+f.durationMs,0)});
  assert.ok(result.videoPath);
});
