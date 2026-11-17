import chromium from '@sparticuz/chromium';
import { chromium as playwrightChromium } from 'playwright-core';

const MAX_ACTIONS = 100;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_WAIT_MS = 30000;
const MAX_SCROLL = 5000;

function assertActions(actions) {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > MAX_ACTIONS) {
    throw new Error('Browser UI execution requires 1–100 explicit actions.');
  }
}

function assertSelector(selector) {
  if (typeof selector !== 'string' || !selector.trim() || selector.length > 1000) {
    throw new Error('A valid DOM selector is required for this browser action.');
  }
}

function assertPath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//') ||
      pathname.includes('\\0') || pathname.length > 2048) {
    throw new Error('open_screen requires a CodeLab-relative path beginning with /.');
  }
  if (/^[a-z]+:/i.test(pathname)) throw new Error('Browser automation cannot navigate to an external URL.');
}

function assertText(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES) {
    throw new Error('Browser action text exceeds the 64 KiB limit.');
  }
}

function locatorFor(page, selector) {
  assertSelector(selector);
  return page.locator(selector).first();
}

async function executeAction(page, action, index) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw new Error('Browser action ' + index + ' must be an object.');
  }
  const type = String(action.type || '');
  switch (type) {
    case 'open_screen': {
      assertPath(action.path);
      const baseUrl = new URL(page.url());
      const target = new URL(action.path, baseUrl.origin);
      const response = await page.goto(target.href, { waitUntil: action.wait_until || 'domcontentloaded', timeout: 45000 });
      if (!response || !response.ok()) throw new Error('open_screen returned HTTP ' + (response?.status() || 'no response'));
      return { type, path: action.path, url: page.url(), status: response.status() };
    }
    case 'open_panel': {
      const locator = locatorFor(page, action.selector);
      await locator.click({ timeout: Number.isInteger(action.timeout_ms) ? Math.min(30000, Math.max(100, action.timeout_ms)) : 10000 });
      return { type, selector: action.selector, opened: true };
    }
    case 'click': {
      const locator = locatorFor(page, action.selector);
      await locator.click({ timeout: Number.isInteger(action.timeout_ms) ? Math.min(30000, Math.max(100, action.timeout_ms)) : 10000 });
      return { type, selector: action.selector, clicked: true };
    }
    case 'scroll': {
      const amount = Number.isFinite(action.amount) ? Math.max(-MAX_SCROLL, Math.min(MAX_SCROLL, Number(action.amount))) : 0;
      if (action.selector) {
        const locator = locatorFor(page, action.selector);
        await locator.scrollIntoViewIfNeeded({ timeout: 10000 });
      } else {
        await page.mouse.wheel(0, amount);
      }
      return { type, ...(action.selector ? { selector: action.selector } : { amount }), scrolled: true };
    }
    case 'type': {
      assertText(action.text);
      const locator = locatorFor(page, action.selector);
      if (action.clear !== false) await locator.fill('');
      await locator.type(action.text, { delay: Number.isFinite(action.delay_ms) ? Math.max(0, Math.min(250, action.delay_ms)) : 0 });
      return { type, selector: action.selector, textBytes: Buffer.byteLength(action.text, 'utf8'), typed: true };
    }
    case 'select': {
      const locator = locatorFor(page, action.selector);
      const value = action.value;
      if (typeof value !== 'string' && !Array.isArray(value)) throw new Error('select requires a string or string[] value.');
      const selected = await locator.selectOption(value);
      return { type, selector: action.selector, selected, changed: true };
    }
    case 'wait_for': {
      const locator = locatorFor(page, action.selector);
      const state = ['attached', 'detached', 'visible', 'hidden'].includes(action.state) ? action.state : 'visible';
      const timeout = Number.isInteger(action.timeout_ms) ? Math.min(MAX_WAIT_MS, Math.max(100, action.timeout_ms)) : 10000;
      await locator.waitFor({ state, timeout });
      return { type, selector: action.selector, state, ready: true };
    }
    case 'screenshot': {
      const target = action.selector ? locatorFor(page, action.selector) : page;
      const bytes = await target.screenshot({ type: 'png', fullPage: action.full_page === true, animations: 'disabled' });
      if (bytes.length > 8 * 1024 * 1024) throw new Error('Browser screenshot exceeds the 8 MiB inline artifact limit.');
      return {
        type, selector: action.selector || null, captured: true,
        artifact: { stored: false, mimeType: 'image/png', sizeBytes: bytes.length, dataBase64: bytes.toString('base64') }
      };
    }
    case 'record_video': {
      const durationMs = Number.isInteger(action.duration_ms) ? action.duration_ms : 5000;
      if (durationMs < 1000 || durationMs > 30000) throw new Error('record_video duration must be from 1 to 30 seconds.');
      await page.waitForTimeout(durationMs);
      return { type, durationMs, recorded: true, deferredArtifact: true };
    }
    default:
      throw new Error('Unsupported explicit browser UI action: ' + type);
  }
}

export async function executeCodeLabBrowserActions(options = {}) {
  if (options.execution_mode !== 'browser') {
    throw new Error('Browser automation requires execution_mode=browser.');
  }
  assertActions(options.actions);
  const baseUrl = String(options.baseUrl || 'http://127.0.0.1:3000').replace(/\/$/, '');
  const origin = new URL(baseUrl).origin;
  const token = String(options.workspaceToken || '');
  if (!token) throw new Error('A CodeLab workspace token is required for browser automation.');
  const tempDir = options.tempDir || null;
  let browser;
  let context;
  try {
    chromium.setGraphicsMode = false;
    const wantsVideo = options.actions.some(action => action?.type === 'record_video');
    browser = await playwrightChromium.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
      timeout: 60000
    });
    const contextOptions = {
      viewport: {
        width: Number.isInteger(options.width) ? Math.max(320, Math.min(2560, options.width)) : 1440,
        height: Number.isInteger(options.height) ? Math.max(240, Math.min(1800, options.height)) : 1000
      },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      reducedMotion: 'reduce'
    };
    if (wantsVideo && tempDir) {
      contextOptions.recordVideo = {
        dir: tempDir,
        size: {
          width: Number.isInteger(options.width) ? Math.max(320, Math.min(1920, options.width)) : 1280,
          height: Number.isInteger(options.height) ? Math.max(240, Math.min(1080, options.height)) : 720
        }
      };
    }
    context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    await context.addInitScript(({ id, token }) => {
      localStorage.setItem('codelab_xd_workspace_v4', id);
      localStorage.setItem('codelab_xd_workspace_token_v1', token);
    }, { id: options.workspaceId, token });

    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', error => {
      if (pageErrors.length < 20) pageErrors.push(String(error.message || error).slice(0, 300));
    });
    page.on('console', message => {
      if (message.type() === 'error' && consoleErrors.length < 30) {
        consoleErrors.push(message.text().slice(0, 300));
      }
    });

    const startPath = options.start_path || '/';
    assertPath(startPath);
    const initialUrl = new URL(startPath, origin).href;
    await page.goto(initialUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

    const trace = [];
    let screenshots = [];
    let videoArtifact = null;
    for (let index = 0; index < options.actions.length; index++) {
      const action = options.actions[index];
      const result = await executeAction(page, action, index);
      trace.push({ index, ...result });
      if (result.artifact) screenshots.push({ index, ...result.artifact });
    }

    if (wantsVideo) {
      const video = page.video();
      await page.close();
      await context.close();
      const videoPath = video ? await video.path() : null;
      if (!videoPath) throw new Error('Chromium did not produce the requested browser video.');
      const fs = await import('node:fs');
      const stat = fs.statSync(videoPath);
      if (!stat.isFile() || stat.size < 1000) throw new Error('Requested browser video is invalid.');
      if (stat.size > 24 * 1024 * 1024) throw new Error('Browser video exceeds the 24 MiB artifact limit.');
      videoArtifact = {
        stored: false, mimeType: 'video/webm', sizeBytes: stat.size,
        dataBase64: fs.readFileSync(videoPath).toString('base64')
      };
    }

    const expectedSandboxPageErrors = pageErrors.filter(message =>
      /Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag\./.test(message)
    );
    const unexpectedPageErrors = pageErrors.filter(message => !expectedSandboxPageErrors.includes(message));
    const expectedSandboxConsoleErrors = consoleErrors.filter(message =>
      /Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag\./.test(message)
    );
    const unexpectedConsoleErrors = consoleErrors.filter(message => !expectedSandboxConsoleErrors.includes(message));
    return {
      execution_mode: 'browser',
      captureMethod: 'playwright-chromium-real-codelab-ui',
      origin,
      finalUrl: page.url(),
      actionCount: trace.length,
      ui_actions: trace,
      screenshots,
      ...(videoArtifact ? { video: videoArtifact } : {}),
      pageErrors: unexpectedPageErrors,
      consoleErrors: unexpectedConsoleErrors,
      expectedPageErrors: expectedSandboxPageErrors,
      expectedConsoleErrors: expectedSandboxConsoleErrors,
      passed: unexpectedPageErrors.length === 0 && unexpectedConsoleErrors.length === 0
    };
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}
