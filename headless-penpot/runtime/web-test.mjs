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
const capture = args.includes('--capture');

if (!url) throw new Error('--url is required');

const {chromium} = require('playwright-core');
const candidates = [
  process.env.CHROMIUM_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable'
].filter(Boolean);
const executablePath = candidates.find(p => fs.existsSync(p));
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

await context.route('**/*', route => {
  const requestUrl = new URL(route.request().url());
  if (requestUrl.hostname === '127.0.0.1' || requestUrl.hostname === 'localhost') {
    return route.continue();
  }
  return route.abort();
});

const page = await context.newPage();
await page.goto(url, {waitUntil:'networkidle', timeout:60000});

const bodyText = await page.locator('body').innerText({timeout:10000}).catch(() => '');
const result = {
  ok:true,
  url,
  title:await page.title(),
  viewport:await page.evaluate(() => ({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})),
  bodyTextLength:bodyText.length
};

if (capture) {
  const absolute = path.resolve(output);
  fs.mkdirSync(path.dirname(absolute), {recursive:true});
  await page.screenshot({path:absolute, fullPage:false});
  result.screenshot=absolute;
}

console.log(JSON.stringify(result, null, 2));
await browser.close();
