import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const repo = process.env.GITHUB_REPOSITORY;
const issueNumber = Number(process.env.ISSUE_NUMBER);
const token = process.env.GITHUB_TOKEN;
const targetUrl = new URL(process.env.TARGET_URL || 'https://codelab-pbw9.onrender.com/');
const commandSource = process.env.COMMAND_SOURCE || 'issue';

if (targetUrl.origin !== 'https://codelab-pbw9.onrender.com') {
  throw new Error('Target origin is not allowlisted.');
}

function parseCommand(raw) {
  if (typeof raw !== 'string' || raw.length > 12000) throw new Error('Issue body missing or too large.');
  const cleaned = raw.trim().replace(/^\u0060\u0060\u0060(?:json)?\s*/i, '').replace(/\s*\u0060\u0060\u0060$/, '');
  const command = JSON.parse(cleaned);
  if (command.protocol !== 'codelab-agent-bridge/v1') throw new Error('Unsupported protocol.');
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(String(command.command_id || ''))) throw new Error('Invalid command_id.');
  const allowed = new Set(['status', 'read_page', 'list_controls', 'connections_status', 'ai_ping', 'click', 'read_element', 'fill', 'select', 'sequence']);
  if (command.use_admin_session !== undefined && typeof command.use_admin_session !== 'boolean') throw new Error('use_admin_session must be a boolean.');
  if (!allowed.has(command.action)) throw new Error('Action is not allowlisted.');
  // Comments are a read-only mailbox. Mutating interactions remain available only through explicit issue commands.
  if (commandSource === 'comment' && !['status', 'connections_status', 'list_controls'].includes(command.action)) {
    throw new Error('Comment mailbox is read-only; use a separately approved issue command for interactions.');
  }
  if (!command.expires_at || !Number.isFinite(Date.parse(command.expires_at))) throw new Error('A valid expires_at is required.');
  if (Date.parse(command.expires_at) < Date.now()) throw new Error('Command expired.');
  const args = command.args && typeof command.args === 'object' && !Array.isArray(command.args) ? command.args : {};
  for (const key of ['selector', 'value']) {
    if (args[key] !== undefined && (typeof args[key] !== 'string' || args[key].length > 2000)) throw new Error('Invalid ' + key + '.');
  }
  if (['click', 'read_element', 'fill', 'select'].includes(command.action) && !args.selector) {
    throw new Error('This action requires args.selector.');
  }
  if (['fill', 'select'].includes(command.action) && typeof args.value !== 'string') {
    throw new Error('This action requires args.value.');
  }
  if (command.action === 'click' && command.approval !== 'approved') {
    throw new Error('Click commands require approval: "approved".');
  }
  if (command.action === 'sequence') {
    if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > 50) {
      throw new Error('Sequence requires between 1 and 50 steps.');
    }
    for (const step of args.steps) {
      if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error('Invalid sequence step.');
      if (!['click', 'fill', 'select'].includes(step.action)) throw new Error('Sequence step action is not allowlisted.');
      if (typeof step.selector !== 'string' || !step.selector.trim() || step.selector.length > 2000) {
        throw new Error('Each sequence step requires a valid selector.');
      }
      if (['fill', 'select'].includes(step.action) && (typeof step.value !== 'string' || step.value.length > 2000)) {
        throw new Error('Fill/select sequence steps require a string value of at most 2000 characters.');
      }
      if (step.action === 'click' && command.approval !== 'approved') {
        throw new Error('Sequence click steps require approval: "approved".');
      }
    }
  }
  return { ...command, args };
}

async function comment(body) {
  const response = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ body })
  });
  if (!response.ok) throw new Error('Could not post result to GitHub (HTTP ' + response.status + ').');
}

async function getJson(page, path) {
  try {
    const response = await page.request.get(new URL(path, targetUrl).href, { timeout: 12000 });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    return { httpStatus: response.status(), ok: response.ok(), data };
  } catch (error) {
    return { httpStatus: null, ok: false, error: String(error?.message || error).slice(0, 250) };
  }
}

let browser;
let page;
let result;
let commandId = 'unknown';
let commandAction = 'unknown';
let stage = 'parse_command';
let currentStep = null;
const startedAt = Date.now();
try {
  const command = parseCommand(process.env.ISSUE_BODY || '');
  commandId = command.command_id;
  commandAction = command.action;
  stage = 'launch_browser';
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  stage = 'initial_navigation';
  await page.goto(targetUrl.href, { waitUntil: 'load', timeout: 45000 });
  // Credentials are read only from GitHub Actions secrets, never from issue bodies.
  if (command.use_admin_session === true) {
    stage = 'admin_authentication';
    const username = process.env.CODELAB_ADMIN_USERNAME || '';
    const password = process.env.CODELAB_ADMIN_PASSWORD || '';
    if (!username || !password) throw new Error('Authenticated bridge unavailable: configure CODELAB_ADMIN_USERNAME and CODELAB_ADMIN_PASSWORD as repository Actions secrets.');
    const login = await page.request.post(new URL('/api/auth/login', targetUrl).href, {
      timeout: 20000,
      headers: { 'content-type': 'application/json' },
      data: { username, password }
    });
    const loginData = await login.json().catch(() => ({}));
    if (!login.ok() || loginData.ok !== true) throw new Error('CodeLab ADMIN login failed (HTTP ' + login.status() + '). Check the Actions secrets and account status.');
    result = { authenticatedAs: loginData.user?.name || username, role: loginData.user?.role || null, mustChangePassword: !!loginData.mustChangePassword };
    stage = 'post_login_navigation';
    await page.goto(targetUrl.href, { waitUntil: 'load', timeout: 45000 });
  }
  // Let the app's own initialization and initial API calls finish before inspecting it.
  stage = 'page_initialization';
  await page.waitForTimeout(2500);
  stage = 'execute_action';

  if (command.action === 'ai_ping') {
    const response = await page.request.post(new URL('/api/ai/ping', targetUrl).href, {
      timeout: 70000,
      headers: { 'content-type': 'application/json' },
      data: {}
    });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    result = {
      httpStatus: response.status(),
      ok: response.ok() && data.ok === true,
      model: data.model || null,
      error: data.error || null,
      message: data.ok === true ? 'El proveedor de IA respondió al ping.' : (data.message || data.error || 'El ping de IA no fue exitoso.')
    };
  } else if (command.action === 'connections_status') {
    const [health, auth] = await Promise.all([
      getJson(page, '/api/health'),
      getJson(page, '/api/auth/status')
    ]);
    const healthData = health.data || {};
    const authData = auth.data || {};
    const oauth = healthData.oauth || authData.oauth || {};
    const ai = healthData.ai || {};
    result = {
      page: { url: page.url(), title: await page.title() },
      apiHealth: { httpStatus: health.httpStatus, ok: health.ok, version: healthData.version || null },
      githubOAuthConfigured: Boolean(oauth.github),
      googleOAuthConfigured: Boolean(oauth.google),
      authenticatedInBridgeSession: Boolean(authData.user),
      ai: {
        serverKeyConfigured: Boolean(ai.serverKey),
        provider: ai.groq ? 'Groq' : ai.openRouter ? 'OpenRouter' : (ai.baseUrl ? 'OpenAI-compatible' : null),
        model: ai.model || null,
        availableModes: ai.modes || ['auto', 'api', 'local'],
        hint: ai.hint || null
      }
    };
  } else if (command.action === 'status') {
    const [health, auth] = await Promise.all([
      getJson(page, '/api/health'),
      getJson(page, '/api/auth/status')
    ]);
    const healthData = health.data || {};
    const authData = auth.data || {};
    result = {
      url: page.url(),
      title: await page.title(),
      documentReady: await page.evaluate(() => document.readyState),
      apiHealth: { httpStatus: health.httpStatus, ok: health.ok, version: healthData.version || null },
      githubOAuthConfigured: Boolean((healthData.oauth || authData.oauth || {}).github),
      googleOAuthConfigured: Boolean((healthData.oauth || authData.oauth || {}).google),
      authenticatedInBridgeSession: Boolean(authData.user),
      visibleSignals: await page.locator('body').innerText({ timeout: 10000 }).then(text =>
        ['Conectando…', 'Iniciando CodeLab…', 'Proyectos', 'No conectado', 'Plantillas locales']
          .filter(signal => text.includes(signal))
      )
    };
  } else if (command.action === 'read_page') {
    result = {
      url: page.url(),
      title: await page.title(),
      documentReady: await page.evaluate(() => document.readyState),
      text: (await page.locator('body').innerText({ timeout: 10000 })).slice(0, 2500)
    };
  } else if (command.action === 'list_controls') {
    result = await page.locator('button,input,textarea,select,[role="button"]').evaluateAll((els, includeText) =>
      els.slice(0, 100).map(el => ({
        tag: el.tagName.toLowerCase(),
        text: includeText ? (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 100) : null,
        id: el.id || null,
        type: el.getAttribute('type'),
        disabled: Boolean(el.disabled)
      })),
      commandSource !== 'comment'
    );
  } else if (command.action === 'sequence') {
    result = [];
    for (let index = 0; index < command.args.steps.length; index += 1) {
      currentStep = index + 1;
      const step = command.args.steps[index];
      const locator = page.locator(step.selector).first();
      if (await locator.count() === 0) throw new Error('Sequence step ' + (index + 1) + ': selector did not match an element.');
      if (step.action === 'click') {
        const tag = await locator.evaluate(el => el.tagName.toLowerCase());
        if (tag === 'a') {
          const href = await locator.getAttribute('href');
          if (href) {
            const u = new URL(href, page.url());
            if (u.origin !== targetUrl.origin) throw new Error('External navigation is blocked by the bridge.');
          }
        }
        await locator.click({ timeout: 10000 });
        result.push({ step: index + 1, action: step.action, selector: step.selector, succeeded: true, urlAfter: page.url() });
      } else if (step.action === 'fill') {
        await locator.fill(step.value, { timeout: 10000 });
        result.push({ step: index + 1, action: step.action, selector: step.selector, succeeded: true });
      } else if (step.action === 'select') {
        await locator.selectOption(step.value, { timeout: 10000 });
        result.push({ step: index + 1, action: step.action, selector: step.selector, succeeded: true });
      }
    }
    currentStep = null;
  } else {
    const locator = page.locator(command.args.selector).first();
    if (await locator.count() === 0) throw new Error('Selector did not match an element.');
    if (command.action === 'read_element') {
      result = { text: (await locator.innerText().catch(() => locator.inputValue().catch(() => ''))).slice(0, 2000) };
    } else if (command.action === 'fill') {
      await locator.fill(command.args.value, { timeout: 10000 });
      result = { filled: true, selector: command.args.selector };
    } else if (command.action === 'select') {
      result = { selected: await locator.selectOption(command.args.value, { timeout: 10000 }) };
    } else if (command.action === 'click') {
      const tag = await locator.evaluate(el => el.tagName.toLowerCase());
      if (tag === 'a') {
        const href = await locator.getAttribute('href');
        if (href) {
          const u = new URL(href, page.url());
          if (u.origin !== targetUrl.origin) throw new Error('External navigation is blocked by the bridge.');
        }
      }
      await locator.click({ timeout: 10000 });
      result = { clicked: true, selector: command.args.selector, urlAfter: page.url() };
    }
  }
  // Capture the actual public interface so labels, controls, panels, and layout can be inspected.
  // Mask only fields that explicitly indicate passwords or secrets; preserve ordinary UI content.
  if (['click', 'fill', 'select', 'sequence'].includes(command.action)) {
    stage = 'capture_readable_ui_screenshot';
    await page.addStyleTag({ content: [
      'input[type="password"], [autocomplete="current-password"], [autocomplete="new-password"] { color: transparent !important; text-shadow: none !important; }',
      'input[name*="token" i], input[id*="token" i], textarea[name*="secret" i], input[name*="secret" i] { color: transparent !important; text-shadow: none !important; }'
    ].join('\n') });
    const screenshotPath = process.env.CODELAB_SCREENSHOT_PATH || '.codelab-artifacts/bridge-ui.png';
    await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: false, animations: 'disabled' });
    if (Array.isArray(result)) {
      result = { steps: result, readableUiScreenshotCaptured: true };
    } else if (result && typeof result === 'object') {
      result = { ...result, redactedScreenshotCaptured: true };
    }
  }
  stage = 'report_result';
  await comment('## CodeLab Bridge result\n\n```json\n' + JSON.stringify({
    protocol: 'codelab-agent-bridge/v1',
    command_id: commandId,
    status: 'succeeded',
    completed_at: new Date().toISOString(),
    diagnostics: {
      stage: 'completed',
      command_action: commandAction,
      command_source: commandSource,
      elapsed_ms: Date.now() - startedAt,
      workflow_run_id: process.env.GITHUB_RUN_ID || null,
      workflow_run_attempt: process.env.GITHUB_RUN_ATTEMPT || null,
      issue_number: Number.isFinite(issueNumber) ? issueNumber : null
    },
    result
  }, null, 2).slice(0, 9000) + '\n```');
} catch (error) {
  const rawMessage = String(error?.message || error);
  const safeMessage = rawMessage.replace(/<[^>]*>/g, '<element>').slice(0, 1000);
  const errorCode = stage === 'parse_command' ? 'command_validation_failed'
    : stage === 'admin_authentication' ? 'authentication_failed'
    : stage === 'capture_redacted_screenshot' ? 'screenshot_failed'
    : /timeout/i.test(rawMessage) ? 'interaction_timeout'
    : /selector did not match/i.test(rawMessage) ? 'selector_not_found'
    : 'bridge_execution_failed';
  const diagnostic = {
    stage,
    error_code: errorCode,
    command_action: commandAction,
    command_source: commandSource,
    elapsed_ms: Date.now() - startedAt,
    workflow_run_id: process.env.GITHUB_RUN_ID || null,
    workflow_run_attempt: process.env.GITHUB_RUN_ATTEMPT || null,
    issue_number: Number.isFinite(issueNumber) ? issueNumber : null,
    current_step: currentStep,
    page_url: page ? page.url() : null
  };
  try {
    await comment('## CodeLab Bridge result\n\n```json\n' + JSON.stringify({
      protocol: 'codelab-agent-bridge/v1',
      command_id: commandId,
      status: 'failed',
      completed_at: new Date().toISOString(),
      diagnostics: diagnostic,
      error: safeMessage
    }, null, 2) + '\n```');
  } catch (reportError) {
    console.error('Could not report result:', reportError.message);
  }
  console.error(safeMessage);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
}
