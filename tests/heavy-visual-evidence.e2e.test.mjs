import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import chromiumBinary from '@sparticuz/chromium';
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactDir = path.resolve(process.env.HEADLESS_VISUAL_ARTIFACT_DIR || path.join(os.tmpdir(), 'codelab-headless-visual-evidence'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startCodeLab() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codelab-visual-ui-'));
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', DATABASE_URL: '', CODELAB_DATA_DIR: dataDir, CODELAB_AGENT_BRIDGE_ENABLED: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = ''; child.stdout.on('data', c => logs += c); child.stderr.on('data', c => logs += c);
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) break;
    try { const r = await fetch(base + '/api/health'); if (r.ok && (await r.json()).ok) return { child, base, dataDir, logs: () => logs }; } catch {}
    await wait(100);
  }
  child.kill('SIGTERM'); throw new Error('CodeLab did not become healthy: ' + logs);
}
async function stopCodeLab(s) {
  if (s?.child?.exitCode === null) { s.child.kill('SIGTERM'); await wait(500); }
  if (s?.dataDir) await fs.rm(s.dataDir, { recursive: true, force: true });
}
async function ensureDir() { await fs.mkdir(artifactDir, { recursive: true }); }

function makeDesignProject(id, name, accent, targetId = null) {
  const buttonId = id + '_nav';
  return {
    id, name, type: 'design', hasDesignSpace: true, hasWebSpace: true,
    code: { html: '', css: '', js: '' },
    design: {
      elements: [
        { id: id + '_title', type: 'heading', text: name, label: name, x: 72, y: 70, width: 620, height: 72, identifier: id + '_hero' },
        { id: id + '_copy', type: 'text', text: id === 'aurora-home' ? 'Explore the expedition and follow the route through the web space.' : 'Destination reached. Continue the journey or return to command.', label: 'Narrative', x: 72, y: 170, width: 620, height: 90, identifier: id + '_copy' },
        { id: buttonId, type: 'button', text: id === 'aurora-home' ? 'Enter Expedition' : 'Return to Aurora', label: id === 'aurora-home' ? 'Enter Expedition' : 'Return to Aurora', x: 72, y: 310, width: 260, height: 58, identifier: buttonId, href: targetId ? '#' + targetId : '' },
        { id: id + '_panel', type: 'rectangle', label: 'Mission Panel', x: 720, y: 60, width: 360, height: 360, identifier: id + '_panel' },
        { id: id + '_orb', type: 'ellipse', label: 'Aurora Core', x: 790, y: 125, width: 220, height: 220, identifier: id + '_orb' }
      ],
      flowConnections: targetId ? [{ sourceElementId: buttonId, targetProjectId: targetId, targetElementId: targetId + '_title' }] : []
    },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
}

test('heavy visual evidence: real node graph, web navigation, polished drawing and animation', { timeout: 150000, concurrency: false }, async () => {
  await ensureDir();
  const s = await startCodeLab();
  chromiumBinary.setGraphicsMode = false;
  const browser = await chromium.launch({ headless: true, args: chromiumBinary.args, executablePath: await chromiumBinary.executablePath(), timeout: 60000 });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e.stack || e.message || e)));

  try {
    await page.goto(s.base, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => document.getElementById('syncLoadingModal')?.classList.contains('hidden'), null, { timeout: 15000 });

    const target = makeDesignProject('aurora-destination', 'Aurora Expedition · Archive', '#59d8b4');
    const source = makeDesignProject('aurora-home', 'Aurora Expedition · Command', '#9b8afb', target.id);
    const web = {
      ...source, id: 'aurora-web', type: 'web', hasWebSpace: true, hasDesignSpace: true,
      code: {
        html: '<!doctype html><html><head><meta charset="utf-8"><style>' +
          ':root{--bg:#070b16;--panel:#111a31;--cyan:#62e7d7;--violet:#a78bfa;--gold:#ffd66b}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 75% 25%,#263c72 0,transparent 32%),linear-gradient(135deg,#070b16,#101d36 60%,#080f1e);color:#edf7ff;font:16px system-ui}.page{min-height:100vh;padding:54px;max-width:1240px;margin:auto}.nav{display:flex;gap:14px;align-items:center;justify-content:space-between}.brand{font-weight:900;letter-spacing:2px}.badge{padding:8px 12px;border:1px solid #365073;border-radius:999px;color:#9fb7d0;font-size:12px}.hero{margin-top:34px;padding:38px;border:1px solid #345276;border-radius:30px;background:linear-gradient(135deg,#111c34e8,#0b1529e8);box-shadow:0 30px 100px #0008;display:grid;grid-template-columns:1.25fr .75fr;gap:34px}.kicker{color:var(--cyan);font-weight:800;letter-spacing:3px;font-size:12px}.hero h1{font-size:58px;line-height:.98;margin:12px 0}.hero p{max-width:620px;color:#adc4d8;line-height:1.7}.cta{display:inline-flex;margin-top:18px;padding:15px 24px;border-radius:999px;background:linear-gradient(90deg,var(--cyan),#91b8ff);color:#07111d;font-weight:900;text-decoration:none}.orb{min-height:320px;border-radius:28px;border:1px solid #365276;background:radial-gradient(circle,#dff 0 4%,#62e7d7 5% 18%,#a78bfa 19% 26%,transparent 27%),radial-gradient(circle at 50% 50%,#1b385a,#0a1324 65%);box-shadow:inset 0 0 70px #62e7d733,0 0 70px #62e7d722}.modules{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:22px}.module{padding:22px;border:1px solid #2d4868;border-radius:20px;background:#0e182b}.module b{display:block;font-size:30px;color:var(--gold)}.hidden{display:none!important}@media(max-width:800px){.hero{grid-template-columns:1fr}.modules{grid-template-columns:1fr}.page{padding:22px}.hero h1{font-size:40px}}</style></head><body><main class="page">' +
          '<nav class="nav"><div class="brand">CODELAB · AURORA</div><div class="badge">HEADLESS WEB SPACE</div></nav>' +
          '<section class="hero"><div><div class="kicker">EXPEDITION CONTROL</div><h1 id="home-title">Aurora Runner</h1><p>Navigate a multi-page visual experience generated from connected design nodes.</p><a id="go-destination" class="cta" href="#destination">Enter Expedition →</a></div><div class="orb"></div></section>' +
          '<section class="modules"><article class="module"><b>05</b> connected design layers</article><article class="module"><b>02</b> web destinations</article><article class="module"><b>01</b> live navigation route</article></section>' +
          '<section id="destination" class="hero hidden"><div><div class="kicker">DESTINATION</div><h2>Aurora Archive reached</h2><p id="arrival">The node route is working inside the web space.</p><a id="back-home" class="cta" href="#home">← Back to Command</a></div><div class="orb"></div></section>' +
          '</main><script>const home=document.querySelector("#home-title").closest(".hero");const dest=document.querySelector("#destination");const sync=()=>{const d=location.hash==="#destination";home.classList.toggle("hidden",d);dest.classList.toggle("hidden",!d)};addEventListener("hashchange",sync);sync();</script></body></html>',
        css: '', js: ''
      }
    };
    await page.evaluate(({ source, target, web }) => {
      localStorage.setItem('codelab_xd_projects_v2', JSON.stringify([source, target, web]));
    }, { source, target, web });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#welcomeDashboard:not(.hidden)', { timeout: 15000 });
    await page.evaluate(({ source, target, web }) => {
      if (typeof window.projects !== 'undefined') window.projects = [source, target, web];
      if (typeof window.saveProjectsToStorage === 'function') saveProjectsToStorage();
      if (typeof window.renderProjectsList === 'function') renderProjectsList();
    }, { source, target, web });
    await page.waitForFunction(() => document.querySelectorAll('#projectsGrid > div').length >= 3, null, { timeout: 10000 });

    const sourceCard = page.locator('#projectsGrid > div').filter({ hasText: 'Aurora Expedition · Command' }).first();
    await sourceCard.locator('button[data-action="open"]').click();
    await page.waitForFunction(() => getCurrentProject()?.id === 'aurora-home', null, { timeout: 10000 });
    await page.locator('#designStudioPanel').waitFor({ state: 'visible', timeout: 10000 });

    await page.locator('#openDesignFlowGraph').click();
    await page.locator('#designFlowGraphModal').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#designFlowChoose').click();
    const flowButtonId = 'aurora-home_nav';
    await page.locator('[data-flow-action="' + flowButtonId + '"][data-flow-source-project="aurora-home"]').click();
    const flowSource = page.locator('[data-flow-source-port="' + flowButtonId + '"][data-flow-project="aurora-home"]');
    const flowTarget = page.locator('[data-flow-target-element][data-flow-target-project="aurora-destination"]:visible').first();
    const sb = await flowSource.boundingBox(), tb = await flowTarget.boundingBox();
    assert.ok(sb && tb, 'node graph source and target must be visible');
    await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
    await page.mouse.down();
    await page.mouse.move(tb.x + 160, tb.y + 28, { steps: 18 });
    await page.mouse.up();
    await page.waitForFunction(() => projects.find(p => p.id === 'aurora-home')?.design?.flowConnections?.length === 1, null, { timeout: 10000 });
    const graphShot = await page.locator('#designFlowGraphModal').screenshot({ type: 'png' });
    await fs.writeFile(path.join(artifactDir, '04-real-node-graph.png'), graphShot);
    assert.ok(graphShot.length > 50000, 'node graph screenshot must contain substantial visual evidence');
    const overview = await page.locator('#designFlowOverviewToggle').count();
    assert.equal(overview, 1);

    await page.locator('#designFlowClose').click();
    await page.evaluate(() => {
      const p = projects.find(p => p.id === 'aurora-home');
      if (p) { p.design.flowConnections = [{ sourceElementId: 'aurora-home_nav', targetProjectId: 'aurora-destination', targetElementId: 'aurora-destination_title' }]; p.updatedAt = new Date().toISOString(); saveProjectsToStorage(); }
    });

    const webPage = await context.newPage();
    await webPage.setContent(web.code.html, { waitUntil: 'load' });
    await webPage.locator('#home-title').waitFor({ state: 'visible' });
    await webPage.locator('#go-destination').click();
    await webPage.waitForFunction(() => location.hash === '#destination');
    assert.equal(await webPage.locator('#destination').isVisible(), true);
    assert.equal(await webPage.locator('#home-title').isVisible(), false);
    const destinationShot = await webPage.locator('body').screenshot({ type: 'png' });
    await fs.writeFile(path.join(artifactDir, '05-web-node-navigation-destination.png'), destinationShot);
    const back = webPage.locator('#back-home'); await back.click(); await webPage.waitForFunction(() => location.hash === '#home');
    assert.equal(await webPage.locator('#home-title').isVisible(), true);
    const homeShot = await webPage.locator('body').screenshot({ type: 'png' });
    await fs.writeFile(path.join(artifactDir, '06-web-node-navigation-home.png'), homeShot);
    await webPage.close();

    const pf = await context.newPage();
    const pfVideoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pixelforge-visual-video-'));
    await pf.close();
    await context.close();
    const pfContext = await browser.newContext({ viewport: { width: 1440, height: 960 }, recordVideo: { dir: pfVideoDir, size: { width: 1440, height: 960 }, fps: 24 } });
    const pixel = await pfContext.newPage();
    const pixelErrors = []; pixel.on('pageerror', e => pixelErrors.push(String(e.message || e)));
    await pixel.goto(s.base + '/pixelforge/index.html?createDemo=orbital-12', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await pixel.locator('#canvas').waitFor({ state: 'visible', timeout: 30000 });
    await pixel.waitForFunction(() => document.getElementById('animation-frame-count')?.textContent.includes('12'), null, { timeout: 30000 });
    const canvasShot = await pixel.locator('#canvas').screenshot({ type: 'png' });
    await fs.writeFile(path.join(artifactDir, '07-polished-drawing.png'), canvasShot);
    const frameCount = await pixel.locator('#animation-frames [data-frame-index]').count();
    assert.equal(frameCount, 12, 'the visual drawing demo must expose 12 real animation frames');
    const layerCount = await pixel.locator('#layer-count').innerText();
    assert.match(layerCount, /[2-9]|1[0-9]/, 'the polished drawing must use multiple raster layers');
    const initialData = await pixel.locator('#canvas').evaluate(c => {
      const ctx = c.getContext('2d'); const d = ctx.getImageData(0,0,c.width,c.height).data;
      let opaque=0; for(let i=3;i<d.length;i+=4) if(d[i]>8) opaque++;
      return { width:c.width,height:c.height,opaque };
    });
    assert.ok(initialData.opaque > 1500, 'drawing must contain substantial non-transparent artwork');

    const play = pixel.locator('#animation-play'); await play.click();
    await pixel.waitForTimeout(850);
    const playingShot = await pixel.locator('#canvas').screenshot({ type: 'png' });
    await fs.writeFile(path.join(artifactDir, '08-animation-playing.png'), playingShot);
    const afterData = await pixel.locator('#canvas').evaluate(c => {
      const ctx = c.getContext('2d'); const d = ctx.getImageData(0,0,c.width,c.height).data;
      let opaque=0; let checksum=0; for(let i=0;i<d.length;i+=4){opaque += d[i+3]>8?1:0; checksum=(checksum+d[i]*3+d[i+1]*5+d[i+2]*7+d[i+3])%1000000007;} return {opaque,checksum};
    });
    assert.notEqual(afterData.checksum, initialData.checksum, 'animation playback must alter rendered canvas content');
    assert.ok(pixelErrors.length === 0, 'PixelForge must render without page errors: ' + pixelErrors.join(' | '));
    const video = pixel.video(); await pixel.close(); await pfContext.close();
    const webm = await fs.readFile(await video.path());
    const webmPath = path.join(artifactDir, '09-polished-animation.webm');
    await fs.writeFile(webmPath, webm);
    assert.ok(webm.length > 20000, 'animation video must contain substantial visual frames');
    await fs.rm(pfVideoDir, { recursive: true, force: true });
    assert.deepEqual(pageErrors, []);

    // Verify the evidence set itself has all expected visual stages.
    const expected = ['04-real-node-graph.png','05-web-node-navigation-destination.png','06-web-node-navigation-home.png','07-polished-drawing.png','08-animation-playing.png','09-polished-animation.webm'];
    for (const name of expected) { const st = await fs.stat(path.join(artifactDir,name)); assert.ok(st.size > 5000, name + ' is too small to be meaningful visual evidence'); }
  } finally {
    await browser.close().catch(() => {});
    await stopCodeLab(s);
  }
});
