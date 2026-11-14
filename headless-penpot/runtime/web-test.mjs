import fs from 'node:fs';
import path from 'node:path';
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

if (!url) throw new Error('--url is required');

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

const browser = await chromium.launch({
  headless:false,
  executablePath,
  args:['--no-sandbox','--disable-dev-shm-usage']
});

const context = await browser.newContext({
  viewport:{
    width:Number(process.env.CODELAB_HEADLESS_WIDTH || 1600),
    height:Number(process.env.CODELAB_HEADLESS_HEIGHT || 1000)
  },
  deviceScaleFactor:Number(process.env.CODELAB_HEADLESS_SCALE || 1),
  serviceWorkers:'block'
});

const diagnostics = {
  console: [],
  pageErrors: [],
  requestFailures: [],
  httpErrors: []
};

await context.route('**/*', route => {
  const requestUrl = new URL(route.request().url());
  if (requestUrl.hostname === '127.0.0.1' || requestUrl.hostname === 'localhost') {
    return route.continue();
  }
  diagnostics.requestFailures.push({
    type:'blocked-external-network',
    method:route.request().method(),
    url:requestUrl.toString()
  });
  return route.abort();
});

const page = await context.newPage();

page.on('console', msg => {
  diagnostics.console.push({
    type:msg.type(),
    text:msg.text(),
    location:msg.location()
  });
});

page.on('pageerror', error => {
  diagnostics.pageErrors.push({
    message:error.message,
    stack:error.stack || null
  });
});

page.on('requestfailed', request => {
  diagnostics.requestFailures.push({
    type:'request-failed',
    method:request.method(),
    url:request.url(),
    errorText:request.failure()?.errorText || null
  });
});

page.on('response', response => {
  if (response.status() >= 400) {
    diagnostics.httpErrors.push({
      status:response.status(),
      method:response.request().method(),
      url:response.url()
    });
  }
});

const startedAt = Date.now();
let navigationError = null;
try {
  await page.goto(url, {waitUntil: networkIdle ? 'networkidle' : 'domcontentloaded', timeout:60000});
} catch (error) {
  navigationError = {message:error.message, stack:error.stack || null};
}

const bodyText = await page.locator('body').innerText({timeout:10000}).catch(() => '');
const result = {
  ok: !navigationError && diagnostics.pageErrors.length === 0 && diagnostics.httpErrors.length === 0,
  url,
  title:await page.title().catch(() => ''),
  viewport:await page.evaluate(() => ({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})).catch(() => null),
  bodyTextLength:bodyText.length,
  elapsedMs:Date.now() - startedAt,
  navigationError,
  diagnostics
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
await browser.close();

if (!result.ok) process.exitCode = 1;
