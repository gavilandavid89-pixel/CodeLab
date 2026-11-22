import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';

const ROOT = resolve(process.env.CODELAB_HEADLESS_ROOT || join(dirname(new URL(import.meta.url).pathname), '..'));
const PUBLIC = join(ROOT, 'public');
const DATA = resolve(process.env.CODELAB_HEADLESS_DATA || join(ROOT, 'assistant-runtime-data'));
const HOST = '127.0.0.1';
const PORT = Number(process.env.CODELAB_HEADLESS_PORT || 3187);
const CHROME = process.env.CODELAB_CHROMIUM || '/usr/bin/chromium';
let server, chrome, ws, seq = 0;
const pending = new Map(), sessions = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function json(res, status, value) { const body=JSON.stringify(value); res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'}); res.end(body); }
function mime(p) { return ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'})[extname(p).toLowerCase()] || 'application/octet-stream'; }
function publicPath(pathname) { const rel=pathname==='/'?'index.html':decodeURIComponent(pathname).replace(/^\\/+/, ''); const file=normalize(join(PUBLIC,rel)); return file===PUBLIC||file.startsWith(PUBLIC+'/')?file:null; }

async function startServer() {
  if (server) return;
  await mkdir(DATA,{recursive:true});
  server=createServer(async (req,res)=>{
    try {
      const u=new URL(req.url,`http://${HOST}:${PORT}`);
      if(u.pathname==='/api/health') return json(res,200,{ok:true,mode:'assistant-headless-offline',neon:false,render:false,accounts:false});
      if(req.method==='POST'&&u.pathname==='/api/workspace/init') return json(res,200,{ok:true,workspaceId:'ws_assistant_headless',token:'offline-assistant-token',user:{id:'assistant',provider:'local',role:'admin'},state:{version:5,revision:0,projects:[],owner:null}});
      if(u.pathname==='/api/ai/status') return json(res,200,{enabled:false,provider:'offline',model:'assistant-headless'});
      if(req.method==='POST'&&u.pathname==='/api/ai/ping') return json(res,200,{ok:true,offline:true});
      if(req.method==='POST'&&u.pathname==='/api/ai/complete') return json(res,200,{ok:true,offline:true,text:'Offline Assistant Headless Runtime'});
      const file=publicPath(u.pathname);
      if(!file||!existsSync(file)||!(await stat(file)).isFile()) return json(res,404,{error:'not_found'});
      res.writeHead(200,{'content-type':mime(file),'cache-control':'no-store'}); res.end(await readFile(file));
    } catch(e) { json(res,500,{error:e.message||'internal_error'}); }
  });
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(PORT,HOST,ok);});
}

function cdp(method,params={},sessionId=null){ const id=++seq; return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});const msg={id,method,params};if(sessionId)msg.sessionId=sessionId;ws.send(JSON.stringify(msg));}); }
function onMessage(raw){const m=JSON.parse(String(raw));if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message||'CDP error')):p.resolve(m.result);}if(m.method==='Target.attachedToTarget')sessions.set(m.params.targetInfo.targetId,m.params.sessionId);}
async function connect(){const info=await fetch('http://127.0.0.1:9222/json/version').then(r=>r.json());ws=new WebSocket(info.webSocketDebuggerUrl);await new Promise((ok,fail)=>{ws.addEventListener('open',ok,{once:true});ws.addEventListener('error',fail,{once:true});});ws.addEventListener('message',e=>onMessage(e.data));await cdp('Target.setDiscoverTargets',{discover:true});}
async function launchChrome(){if(chrome)return;chrome=spawn(CHROME,['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--remote-debugging-port=9222','--user-data-dir='+join(DATA,'chrome-profile'),'about:blank'],{stdio:'ignore'});for(let i=0;i<50;i++){try{await connect();return;}catch{await sleep(100);}}throw new Error('Chromium CDP unavailable at 127.0.0.1:9222');}
async function pageFor(url){const t=await cdp('Target.createTarget',{url});for(let i=0;i<50;i++){const s=sessions.get(t.targetId);if(s)return{targetId:t.targetId,sessionId:s};await sleep(50);}const a=await cdp('Target.attachToTarget',{targetId:t.targetId,flatten:true});return{targetId:t.targetId,sessionId:a.sessionId};}
async function evaluate(page,expression){const r=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},page.sessionId);if(r.exceptionDetails)throw new Error(r.exceptionDetails.text||'Browser evaluation failed');return r.result?.value;}

export async function launch(){await startServer();await launchChrome();return{baseUrl:`http://${HOST}:${PORT}`,chromium:CHROME,mode:'assistant-headless-offline'};}
export async function runActions(actions,{url=`http://${HOST}:${PORT}/` }={}){if(!Array.isArray(actions)||!actions.length||actions.length>100)throw new Error('actions must contain 1-100 items');await launch();const page=await pageFor(url);const results=[];for(const a of actions){
if(a.type==='open'){const target=new URL(a.path||'/',url).href;await cdp('Page.navigate',{url:target},page.sessionId);await sleep(Number(a.wait_ms||250));results.push({type:'open',url:target});}
else if(a.type==='click'){const ok=await evaluate(page,`(()=>{const e=document.querySelector(${JSON.stringify(a.selector)});if(!e)return false;e.click();return true})()`);if(!ok)throw new Error('click selector not found: '+a.selector);results.push({type:'click',selector:a.selector,ok:true});}
else if(a.type==='type'){const ok=await evaluate(page,`(()=>{const e=document.querySelector(${JSON.stringify(a.selector)});if(!e)return false;e.focus();return true})()`);if(!ok)throw new Error('type selector not found: '+a.selector);await cdp('Input.insertText',{text:String(a.text||'')},page.sessionId);results.push({type:'type',selector:a.selector,ok:true});}
else if(a.type==='wait') {await sleep(Math.min(30000,Math.max(0,Number(a.ms||500))));results.push({type:'wait',ms:Number(a.ms||500)});}
else if(a.type==='assert_visible'){const ok=await evaluate(page,`(()=>{const e=document.querySelector(${JSON.stringify(a.selector)});if(!e)return false;const s=getComputedStyle(e),r=e.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0})()`);if(!ok)throw new Error('element not visible: '+a.selector);results.push({type:'assert_visible',selector:a.selector,ok:true});}
else if(a.type==='evaluate')results.push({type:'evaluate',value:await evaluate(page,String(a.expression||'undefined'))});
else throw new Error('Unsupported action: '+a.type);
}return{ok:true,mode:'assistant-headless-offline',results};}

if(import.meta.url===`file://${process.argv[1]}`){console.log(JSON.stringify(await launch(),null,2));}