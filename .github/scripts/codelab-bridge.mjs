import { chromium } from 'playwright';

const repo = process.env.GITHUB_REPOSITORY;
const issueNumber = Number(process.env.ISSUE_NUMBER);
const token = process.env.GITHUB_TOKEN;
const targetUrl = new URL(process.env.TARGET_URL || 'https://codelab-pbw9.onrender.com/');

if (targetUrl.origin !== 'https://codelab-pbw9.onrender.com') {
  throw new Error('Target origin is not allowlisted.');
}

function parseCommand(raw) {
  if (typeof raw !== 'string' || raw.length > 12000) throw new Error('Issue body missing or too large.');
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const command = JSON.parse(cleaned);
  if (command.protocol !== 'codelab-agent-bridge/v1') throw new Error('Unsupported protocol.');
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(String(command.command_id || ''))) throw new Error('Invalid command_id.');
  const allowed = new Set(['status', 'read_page', 'list_controls', 'click', 'read_element', 'fill', 'select']);
  if (!allowed.has(command.action)) throw new Error('Action is not allowlisted.');
  if (command.expires_at && Date.parse(command.expires_at) < Date.now()) throw new Error('Command expired.');
  const args = command.args && typeof command.args === 'object' ? command.args : {};
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

let browser;
let result;
let commandId = 'unknown';
try {
  const command = parseCommand(process.env.ISSUE_BODY || '');
  commandId = command.command_id;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(targetUrl.href, { waitUntil: 'domcontentloaded', timeout: 45000 });

  if (command.action === 'status' || command.action === 'read_page') {
    result = {
      url: page.url(),
      title: await page.title(),
      text: (await page.locator('body').innerText({ timeout: 10000 })).slice(0, 8000)
    };
  } else if (command.action === 'list_controls') {
    result = await page.locator('button,input,textarea,select,[role="button"]').evaluateAll(els =>
      els.slice(0, 100).map(el => ({
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 100),
        id: el.id || null,
        type: el.getAttribute('type'),
        disabled: Boolean(el.disabled)
      }))
    );
  } else {
    const locator = page.locator(command.args.selector).first();
    if (await locator.count() === 0) throw new Error('Selector did not match an element.');
    if (command.action === 'read_element') {
      result = { text: (await locator.innerText().catch(() => locator.inputValue().catch(() => ''))).slice(0, 4000) };
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
  await comment('## CodeLab Bridge result\n\n```json\n' + JSON.stringify({
    protocol: 'codelab-agent-bridge/v1',
    command_id: commandId,
    status: 'succeeded',
    completed_at: new Date().toISOString(),
    result
  }, null, 2).slice(0, 10000) + '\n```');
} catch (error) {
  const safeMessage = String(error?.message || error).slice(0, 1500);
  try {
    await comment('## CodeLab Bridge result\n\n```json\n' + JSON.stringify({
      protocol: 'codelab-agent-bridge/v1',
      command_id: commandId,
      status: 'failed',
      completed_at: new Date().toISOString(),
      error: safeMessage
    }, null, 2) + '\n```');
  } catch (reportError) {
    console.error('Could not report command result:', reportError.message);
  }
  console.error(safeMessage);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
}
