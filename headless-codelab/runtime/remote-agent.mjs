import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const{chromium}=require('playwright-core');
let packagedChromium=null;try{packagedChromium=require('@sparticuz/chromium');}catch{}
const args=process.argv.slice(2),value=(name,fallback=null)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
const url=value('--url'),commandsPath=value('--commands'),reportPath=value('--report','./headless-codelab/artifacts/remote-report.json'),screenshotPath=value('--screenshot','./headless-codelab/artifacts/remote.png'),authState=value('--auth-state'),headed=!args.includes('--headless'),allowExternal=args.includes('--allow-external'),sessionDir=value('--session-dir',path.join(process.cwd(),'.codelab-headless-session'));
if(!url)throw new Error('--url is required');
const target=new URL(url),commands=commandsPath?JSON.parse(fs.readFileSync(commandsPath,'utf8')):[{action:'inspect',required:true}];
if(!Array.isArray(commands)||commands.length>200)throw new Error('Invalid command file');
const candidates=[process.env.CHROMIUM_PATH,'/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome','/usr/bin/google-chrome-stable'].filter(Boolean);
let executablePath=candidates.find(p=>fs.existsSync(p));if(!executablePath&&packagedChromium)executablePath=await packagedChromium.executablePath();if(!executablePath)throw new Error('Chromium executable not found');
fs.mkdirSync(sessionDir,{recursive:true});
const context=await chromium.launchPersistentContext(sessionDir,{headless:!headed,executablePath,args:['--no-sandbox','--disable-dev-shm-usage','--disable-features=Translate'],viewport:{width:Number(process.env.CODELAB_HEADLESS_WIDTH||1600),height:Number(process.env.CODELAB_HEADLESS_HEIGHT||1000)},serviceWorkers:'allow',...(authState?{storageState:authState}:{})});
const diagnostics={console:[],pageErrors:[],requestFailures:[],httpErrors:[],websocketErrors:[],blockedExternalNetwork:[],actions:[]};
const allowed=raw=>{try{const p=new URL(raw);return p.origin===target.origin||p.hostname==='localhost'||p.hostname==='127.0.0.1'||allowExternal;}catch{return false;}};
await context.route('**/*',route=>{const raw=route.request().url();if(allowed(raw))return route.continue();diagnostics.blockedExternalNetwork.push({method:route.request().method(),url:raw});return route.abort();});
const page=await context.newPage();
page.on('console',msg=>diagnostics.console.push({type:msg.type(),text:msg.text(),location:msg.location()}));
page.on('pageerror',error=>diagnostics.pageErrors.push({message:error.message,stack:error.stack||null}));
page.on('requestfailed',request=>diagnostics.requestFailures.push({method:request.method(),url:request.url(),errorText:request.failure()?.errorText||null}));
page.on('response',response=>{if(response.status()>=400)diagnostics.httpErrors.push({status:response.status(),method:response.request().method(),url:response.url()});});
page.on('websocket',ws=>{
  ws.on('socketerror',error=>diagnostics.websocketErrors.push({type:'socketerror',url:ws.url(),error:String(error)}));
  ws.on('framereceived',frame=>{
    const payload=typeof frame.payload==='string'?frame.payload:'';
    if(/error|exception|failed|unauthoriz|forbidden/i.test(payload))diagnostics.websocketErrors.push({type:'frame',url:ws.url(),payload:payload.slice(0,2000)});
  });
});
await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});await page.waitForTimeout(Number(process.env.CODELAB_HEADLESS_SETTLE_MS||1000));
async function dispatch(action,args){return page.evaluate(async payload=>{const fn=window.__codelabEditorAgentDispatch||window.__codelabHeadlessDispatch||window.__codelabAgentDispatch;if(typeof fn!=='function')throw new Error('CodeLab semantic dispatch is unavailable');return fn(payload.action,payload.args||{});},{action,args});}
async function inspect(){return page.evaluate(async()=>{const agent=window.__codelabEditorAgent||window.__codelabHeadless||window.__codelabAgent;if(!agent)throw new Error('CodeLab semantic headless agent is unavailable');return typeof agent.inspectState==='function'?await agent.inspectState():await agent.listCapabilities();});}
for(const command of commands){const started=Date.now();try{const result=await dispatch(command.action,command.args||{});diagnostics.actions.push({command,ok:true,elapsedMs:Date.now()-started,result});if(command.action==='navigate')await page.waitForTimeout(Number(command.waitMs||1000));}catch(error){diagnostics.actions.push({command,ok:false,elapsedMs:Date.now()-started,error:String(error),stack:error?.stack||null});if(command.required!==false)break;}}
const state=await inspect().catch(error=>({error:String(error)})),result={ok:diagnostics.actions.every(x=>x.ok||x.command?.required===false)&&diagnostics.pageErrors.length===0&&diagnostics.httpErrors.length===0&&diagnostics.requestFailures.length===0&&diagnostics.websocketErrors.every(x=>x.type!=='socketerror'),target:{origin:target.origin,path:target.pathname},finalUrl:await page.url(),title:await page.title().catch(()=>''),state,diagnostics,git:{repository:process.env.GITHUB_REPOSITORY||null,sha:process.env.GITHUB_SHA||null,runId:process.env.GITHUB_RUN_ID||null,workflow:process.env.GITHUB_WORKFLOW||null}};
if(args.includes('--screenshot')){const shot=path.resolve(screenshotPath);fs.mkdirSync(path.dirname(shot),{recursive:true});await page.screenshot({path:shot,fullPage:false});result.screenshot=shot;}
const report=path.resolve(reportPath);fs.mkdirSync(path.dirname(report),{recursive:true});fs.writeFileSync(report,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));await context.close();
if(!result.ok)process.exitCode=1;