import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const value = (name, fallback=null) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const url = value('--url');
const output = value('--output', './headless-penpot/artifacts/web-capture.png');
const reportOutput = value('--report', './headless-penpot/artifacts/web-report.json');
const capture = args.includes('--capture');
const networkIdle = !args.includes('--no-networkidle');
const allowExternal = args.includes('--allow-external');
const commandFile = value('--commands');

if (!url) throw new Error('--url is required');

const target = new URL(url);
const {chromium} = require('playwright-core');
let packagedChromium = null;
try { packagedChromium = require('@sparticuz/chromium'); } catch {}

const candidates = [
  process.env.CHROMIUM_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable'
].filter(Boolean);

let executablePath = candidates.find(p => fs.existsSync(p));
if (!executablePath && packagedChromium) executablePath = await packagedChromium.executablePath();
if (!executablePath) throw new Error('Chromium executable not found');

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codelab-headless-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  headless:false,
  executablePath,
  args:['--no-sandbox','--disable-dev-shm-usage','--disable-features=Translate'],
  viewport:{
    width:Number(process.env.CODELAB_HEADLESS_WIDTH || 1600),
    height:Number(process.env.CODELAB_HEADLESS_HEIGHT || 1000)
  },
  deviceScaleFactor:Number(process.env.CODELAB_HEADLESS_SCALE || 1),
  serviceWorkers:'allow'
});

const diagnostics = {
  console: [],
  pageErrors: [],
  requestFailures: [],
  httpErrors: [],
  websocketErrors: [],
  blockedExternalNetwork: [],
  semantic: {available:false, capabilities:null, probes:[]}
};

const allowedOrigins = new Set([target.origin, 'http://127.0.0.1', 'http://localhost']);
const isAllowed = raw => {
  try {
    const parsed = new URL(raw);
    if (parsed.origin === target.origin) return true;
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') return true;
    return allowExternal;
  } catch { return false; }
};

await context.route('**/*', route => {
  const requestUrl = route.request().url();
  if (isAllowed(requestUrl)) return route.continue();
  diagnostics.blockedExternalNetwork.push({
    method:route.request().method(),
    url:requestUrl
  });
  return route.abort();
});

const page = await context.newPage();
page.on('console', msg => diagnostics.console.push({
  type:msg.type(), text:msg.text(), location:msg.location()
}));
page.on('pageerror', error => diagnostics.pageErrors.push({
  message:error.message, stack:error.stack || null
}));
page.on('requestfailed', request => diagnostics.requestFailures.push({
  type:'request-failed', method:request.method(), url:request.url(),
  errorText:request.failure()?.errorText || null
}));
page.on('response', response => {
  if (response.status() >= 400) diagnostics.httpErrors.push({
    status:response.status(), method:response.request().method(), url:response.url()
  });
});
page.on('websocket', ws => {
  ws.on('framereceived', frame => {
    const text = typeof frame.payload === 'string' ? frame.payload : '';
    if (/error|exception|failed|unauthoriz|forbidden/i.test(text)) {
      diagnostics.websocketErrors.push({type:'frame', url:ws.url(), payload:text.slice(0,2000)});
    }
  });
  ws.on('socketerror', error => diagnostics.websocketErrors.push({
    type:'socketerror', url:ws.url(), error:String(error)
  }));
  ws.on('close', () => diagnostics.websocketErrors.push({
    type:'closed', url:ws.url()
  }));
});

const startedAt = Date.now();
let navigationError = null;
try {
  await page.goto(url, {waitUntil: networkIdle ? 'networkidle' : 'domcontentloaded', timeout:60000});
} catch (error) {
  navigationError = {message:error.message, stack:error.stack || null};
}

await page.waitForTimeout(Number(process.env.CODELAB_HEADLESS_SETTLE_MS || 1500));

const semantic = await page.evaluate(async () => {
  const agent = window.__codelabEditorAgent || window.__codelabHeadless || window.__codelabAgent;
  const dispatch = window.__codelabEditorAgentDispatch || window.__codelabHeadlessDispatch || window.__codelabAgentDispatch;
  const resolve = window.__codelabEditorAgentResolve || window.__codelabHeadlessResolve || window.__codelabAgentResolve;
  const capabilities = typeof agent?.listCapabilities === 'function'
    ? await agent.listCapabilities()
    : (typeof agent?.capabilities === 'function' ? await agent.capabilities() : null);
  return {
    available: !!agent || typeof dispatch === 'function',
    capabilities,
    hasDispatch: typeof dispatch === 'function',
    hasResolve: typeof resolve === 'function',
    location: {href: location.href, title: document.title}
  };
}).catch(error => ({available:false, error:String(error)}));
diagnostics.semantic = {...diagnostics.semantic, ...semantic};

if (commandFile && fs.existsSync(commandFile)) {
  const commands = JSON.parse(fs.readFileSync(commandFile, 'utf8'));
  if (!Array.isArray(commands) || commands.length > 100) throw new Error('Invalid --commands file');
  for (const command of commands) {
    const probe = await page.evaluate(async payload => {
      const dispatch = window.__codelabEditorAgentDispatch || window.__codelabHeadlessDispatch || window.__codelabAgentDispatch;
      if (typeof dispatch !== 'function') return {ok:false, error:'semantic_dispatch_unavailable'};
      try {
        const result = await dispatch(payload.action, payload.args || {});
        return {ok:true, result};
      } catch (error) {
        return {ok:false, error:String(error), stack:error?.stack || null};
      }
    }, command);
    diagnostics.semantic.probes.push({command, probe});
    if (!probe.ok && command.required === true) break;
  }
}

const bodyText = await page.locator('body').innerText({timeout:10000}).catch(() => '');
const result = {
  ok: !navigationError &&
      diagnostics.pageErrors.length === 0 &&
      diagnostics.httpErrors.length === 0 &&
      diagnostics.requestFailures.filter(x => x.type === 'request-failed').length === 0 &&
      diagnostics.websocketErrors.filter(x => x.type === 'socketerror').length === 0,
  target: {origin:target.origin, path:target.pathname},
  url:await page.url(),
  title:await page.title().catch(() => ''),
  viewport:await page.evaluate(() => ({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})).catch(() => null),
  bodyTextLength:bodyText.length,
  elapsedMs:Date.now() - startedAt,
  navigationError,
  diagnostics,
  git: {
    repository:process.env.GITHUB_REPOSITORY || null,
    sha:process.env.GITHUB_SHA || null,
    runId:process.env.GITHUB_RUN_ID || null,
    workflow:process.env.GITHUB_WORKFLOW || null
  }
};

if (capture) {
  const absolute = path.resolve(output);
  fs.mkdirSync(path.dirname(absolute), {recursive:true});
  await page.screenshot({path:absolute, fullPage:false});
  result.screenshot=absolute;
}

const report = path.resolve(reportOutput);
fs.mkdirSync(path.dirname(report), {recursive:true});
fs.writeFileSync(report, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await context.close();
fs.rmSync(userDataDir, {recursive:true, force:true});

if (!result.ok) process.exitCode = 1;
