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
  const allowed = new Set(['status', 'read_page', 'list_controls', 'connections_status', 'ai_ping', 'preview_diagnostics', 'preview_interact', 'preview_editor_smoke_test', 'click', 'read_element', 'fill', 'select', 'sequence', 'project_list', 'project_rename', 'project_save', 'branch_status', 'branch_create', 'branch_resume', 'branch_save', 'branch_merge', 'branch_undo_merge', 'workspace_inspect', 'project_inspect', 'project_code_read', 'design_read', 'project_code_write', 'component_search', 'component_inspect', 'component_insert', 'design_element_add', 'design_element_update', 'design_element_delete', 'design_elements_delete', 'design_element_duplicate', 'design_layer_move', 'design_layer_reorder', 'design_elements_align', 'design_elements_distribute', 'design_prototype_target_set', 'design_layout_configure', 'design_canvas_configure', 'design_element_duplicate', 'design_layer_move', 'design_elements_align', 'design_layout_configure', 'design_canvas_configure', 'project_create', 'project_duplicate', 'project_delete', 'design_template_apply', 'design_history', 'accessibility_audit', 'design_tokens_generate', 'design_export', 'design_import_json', 'ai_settings_inspect', 'design_flow_read', 'design_flow_connect', 'design_flow_disconnect', 'ai_generate', 'project_convert_design_to_web', 'project_export_html']);
  if (command.use_admin_session !== undefined && typeof command.use_admin_session !== 'boolean') throw new Error('use_admin_session must be a boolean.');
  if (!allowed.has(command.action)) throw new Error('Action is not allowlisted.');
  // Comments are a read-only mailbox. Mutating interactions remain available only through explicit issue commands.
  if (commandSource === 'comment' && !['status', 'connections_status', 'list_controls', 'preview_diagnostics'].includes(command.action)) {
    throw new Error('Comment mailbox is read-only; use a separately approved issue command for interactions.');
  }
  if (!command.expires_at || !Number.isFinite(Date.parse(command.expires_at))) throw new Error('A valid expires_at is required.');
  if (Date.parse(command.expires_at) < Date.now()) throw new Error('Command expired.');
  const args = command.args && typeof command.args === 'object' && !Array.isArray(command.args) ? command.args : {};
  if (args.self_test !== undefined && typeof args.self_test !== 'boolean') throw new Error('args.self_test must be a boolean.');
  const projectActions = ['project_list', 'project_rename', 'project_save', 'branch_status', 'branch_create', 'branch_resume', 'branch_save', 'branch_merge', 'branch_undo_merge', 'workspace_inspect', 'project_inspect', 'project_code_read', 'design_read', 'project_code_write', 'design_import_json', 'component_insert', 'design_element_add', 'design_element_update', 'design_element_delete', 'design_elements_delete', 'design_element_duplicate', 'design_layer_move', 'design_layer_reorder', 'design_elements_align', 'design_elements_distribute', 'design_prototype_target_set', 'design_layout_configure', 'design_canvas_configure', 'project_create', 'project_duplicate', 'project_delete', 'design_template_apply', 'design_history', 'accessibility_audit', 'design_export', 'design_flow_read', 'design_flow_connect', 'design_flow_disconnect', 'ai_generate', 'project_convert_design_to_web', 'project_export_html'];
  if (projectActions.includes(command.action) && command.use_admin_session !== true) {
    throw new Error('Project and branch tools require use_admin_session: true.');
  }
  if (['project_rename', 'project_save', 'branch_status', 'branch_create', 'branch_resume', 'branch_save', 'branch_merge', 'branch_undo_merge', 'project_inspect', 'project_code_read', 'design_read', 'project_code_write', 'component_insert', 'design_element_add', 'design_element_update', 'design_element_delete', 'design_element_duplicate', 'design_layer_move', 'design_elements_align', 'design_elements_distribute', 'design_prototype_target_set', 'design_layout_configure', 'design_canvas_configure', 'project_duplicate', 'project_delete', 'design_template_apply', 'design_history', 'accessibility_audit', 'design_export', 'design_flow_read', 'design_flow_connect', 'design_flow_disconnect', 'ai_generate', 'project_convert_design_to_web', 'project_export_html'].includes(command.action) &&
      (typeof args.project_id !== 'string' || !/^proj_[a-zA-Z0-9_-]{1,100}$/.test(args.project_id))) {
    throw new Error('This project action requires a valid args.project_id.');
  }
  if (['branch_merge', 'branch_undo_merge'].includes(command.action) && command.approval !== 'approved') {
    throw new Error(command.action + ' changes the main project state; approval: "approved" is required.');
  }
  if (command.action === 'project_rename' &&
      (typeof args.name !== 'string' || !args.name.trim() || args.name.trim().length > 200)) {
    throw new Error('project_rename requires args.name between 1 and 200 characters.');
  }
  if (command.action === 'project_code_write') {
  if (command.action === 'project_export_html' && args.max_chars !== undefined &&
      (!Number.isInteger(args.max_chars) || args.max_chars < 1000 || args.max_chars > 7000)) {
    throw new Error('project_export_html max_chars must be an integer from 1000 to 7000.');
  }
  if (command.action === 'ai_generate') {
    if (command.approval !== 'approved') throw new Error('AI generation changes project code and may consume API quota; approval: "approved" is required.');
    if (typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 4000) throw new Error('ai_generate requires a prompt between 1 and 4000 characters.');
    if (args.source !== undefined && !['main', 'branch'].includes(args.source)) throw new Error('ai_generate source must be main or branch.');
  }
  if (command.action === 'project_delete' && command.approval !== 'approved') throw new Error('Permanent project deletion requires approval: "approved".');
  if (command.action === 'design_template_apply') {
    if (!['landing', 'dashboard', 'portfolio'].includes(args.template_id)) throw new Error('design_template_apply requires a supported template_id.');
    if (args.replace_existing !== undefined && typeof args.replace_existing !== 'boolean') throw new Error('replace_existing must be a boolean.');
    if (args.replace_existing === true && command.approval !== 'approved') throw new Error('Replacing existing design layers requires approval: "approved".');
  }
  if (command.action === 'design_history' && !['undo', 'redo'].includes(args.operation)) throw new Error('design_history operation must be undo or redo.');
  if (command.action === 'design_flow_connect') {
    if (typeof args.element_id !== 'string' || !/^el_[a-zA-Z0-9_-]{1,100}$/.test(args.element_id)) throw new Error('design_flow_connect requires a valid element_id.');
    if (typeof args.target_project_id !== 'string' || !/^proj_[a-zA-Z0-9_-]{1,100}$/.test(args.target_project_id)) throw new Error('design_flow_connect requires a valid target_project_id.');
  }
  if (command.action === 'design_flow_disconnect') {
    if (typeof args.element_id !== 'string' || !/^el_[a-zA-Z0-9_-]{1,100}$/.test(args.element_id)) throw new Error('design_flow_disconnect requires a valid element_id.');
    if (typeof args.target_project_id !== 'string' || !/^proj_[a-zA-Z0-9_-]{1,100}$/.test(args.target_project_id)) throw new Error('design_flow_disconnect requires a valid target_project_id.');
  }
  if (command.action === 'design_export' && !['svg', 'json'].includes(args.format)) throw new Error('design_export format must be svg or json.');
  if (command.action === 'design_import_json' && (typeof args.json !== 'string' || args.json.length < 2 || args.json.length > 10000)) throw new Error('design_import_json requires a JSON string between 2 and 10000 characters.');
  if (command.action === 'design_tokens_generate') {
    if (args.settings !== undefined && (!args.settings || typeof args.settings !== 'object' || Array.isArray(args.settings))) throw new Error('settings must be an object.');
  }
  if (command.action === 'project_create') {
    if (typeof args.name !== 'string' || !args.name.trim() || args.name.trim().length > 200) throw new Error('project_create requires a name between 1 and 200 characters.');
    if (!['web', 'design'].includes(args.type || 'web')) throw new Error('project_create type must be web or design.');
  }
  if (command.action === 'component_search') {
    if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 200)) throw new Error('component_search query must be a string up to 200 characters.');
    if (args.category !== undefined && (typeof args.category !== 'string' || args.category.length > 100)) throw new Error('component_search category must be a string up to 100 characters.');
  }
  if (command.action === 'component_inspect' && (typeof args.component_id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(args.component_id))) throw new Error('component_inspect requires a valid component_id.');
  if (command.action === 'component_inspect' && args.max_chars !== undefined && (!Number.isInteger(args.max_chars) || args.max_chars < 1000 || args.max_chars > 7000)) throw new Error('component_inspect max_chars must be an integer from 1000 to 7000.');
  if (command.action === 'component_insert' && (typeof args.component_id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(args.component_id))) {
    throw new Error('component_insert requires a valid component_id.');
  }
  if (command.action === 'design_element_add' && !['heading', 'text', 'button', 'rectangle', 'ellipse', 'image'].includes(args.type)) {
    throw new Error('design_element_add requires a supported element type.');
  }
  if (command.action === 'design_elements_delete') {
    if (!Array.isArray(args.element_ids) || args.element_ids.length < 1 || args.element_ids.length > 100 || args.element_ids.some(id => typeof id !== 'string' || !/^el_[a-zA-Z0-9_-]{1,100}$/.test(id)) || new Set(args.element_ids).size !== args.element_ids.length) {
      throw new Error('design_elements_delete requires 1 to 100 unique valid element_ids.');
    }
  }
  if (command.action === 'design_element_update') {
    if (typeof args.element_id !== 'string' || !/^el_[a-zA-Z0-9_-]{1,100}$/.test(args.element_id)) throw new Error('design_element_update requires a valid element_id.');
    if (!args.properties || typeof args.properties !== 'object' || Array.isArray(args.properties)) throw new Error('design_element_update requires a properties object.');
    const allowedProperties = ['label', 'text', 'x', 'y', 'width', 'height', 'color', 'background', 'fontSize', 'weight', 'radius', 'href', 'src', 'alt', 'objectFit', 'textAlign'];
    for (const [key, value] of Object.entries(args.properties)) {
      if (!allowedProperties.includes(key)) throw new Error('Unsupported design element property: ' + key);
      if (typeof value === 'string' && value.length > 2000) throw new Error('Design element string properties are limited to 2000 characters.');
      if (key === 'textAlign' && !['left', 'center', 'right'].includes(value)) throw new Error('textAlign must be left, center, or right.');
      if (key === 'objectFit' && !['contain', 'cover', 'fill'].includes(value)) throw new Error('objectFit must be contain, cover, or fill.');
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Design element numeric properties must be finite.');
      if (!['string', 'number'].includes(typeof value)) throw new Error('Design element properties must be strings or numbers.');
    }
    if (!Object.keys(args.properties).length) throw new Error('design_element_update requires at least one property.');
  }
  if (command.action === 'design_element_delete' && (typeof args.element_id !== 'string' || !/^el_[a-zA-Z0-9_-]{1,100}$/.test(args.element_id))) {
    throw new Error('design_element_delete requires a valid element_id.');
  }
  if (command.action === 'design_element_duplicate' && (typeof args.element_id !== 'string' || !/^el_[a-zA-Z0-9_-]{1,100}$/.test(args.element_id))) throw new Error('design_element_duplicate requires a valid element_id.');
  if (command.action === 'design_layer_move') {
    if (typeof args.element_id !== 'string' || !/^el_[a-zA-Z0-9_-]{1,100}$/.test(args.element_id)) throw new Error('design_layer_move requires a valid element_id.');
    if (!['front', 'back'].includes(args.direction)) throw new Error('design_layer_move direction must be front or back.');
  }
  if (command.action === 'design_layer_reorder') {
    if (typeof args.element_id !== 'string' || !/^el_[a-zA-Z0-9_-]{1,100}$/.test(args.element_id)) throw new Error('design_layer_reorder requires a valid element_id.');
    if (!Number.isInteger(args.target_index) || args.target_index < 0 || args.target_index > 499) throw new Error('design_layer_reorder target_index must be an integer from 0 to 499.');
  }
  if (command.action === 'design_elements_align') {
    if (!['left', 'center-x', 'right', 'top', 'center-y', 'bottom'].includes(args.mode)) throw new Error('design_elements_align requires a supported alignment mode.');
    if (!Array.isArray(args.element_ids) || args.element_ids.length < 1 || args.element_ids.length > 50 || args.element_ids.some(id => typeof id !== 'string' || !/^el_[a-zA-Z0-9_-]{1,100}$/.test(id))) throw new Error('design_elements_align requires 1 to 50 valid element_ids.');
  }
  if (command.action === 'design_elements_distribute') {
    if (!Array.isArray(args.element_ids) || args.element_ids.length < 3 || args.element_ids.length > 100 ||
        args.element_ids.some(id => typeof id !== 'string' || !/^el_[a-zA-Z0-9_-]{1,100}$/.test(id)) ||
        new Set(args.element_ids).size !== args.element_ids.length) {
      throw new Error('design_elements_distribute requires 3 to 100 unique valid element_ids.');
    }
    if (!['horizontal', 'vertical'].includes(args.axis)) throw new Error('design_elements_distribute axis must be horizontal or vertical.');
  }
  if (command.action === 'design_prototype_target_set') {
    if (typeof args.element_id !== 'string' || !/^el_[a-zA-Z0-9_-]{1,100}$/.test(args.element_id)) throw new Error('design_prototype_target_set requires a valid element_id.');
    if (typeof args.target !== 'string' || args.target.length > 2048 || /[<>\u0000-\u001f]/.test(args.target)) throw new Error('design_prototype_target_set target must be a safe string up to 2048 characters.');
    const target = args.target.trim();
    const isLayerTarget = /^#layer-[a-z0-9_-]{1,120}$/i.test(target);
    let isWebTarget = false;
    try {
      const url = new URL(target);
      isWebTarget = (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
    } catch (_) {}
    if (target && !isLayerTarget && !isWebTarget) throw new Error('target must be an HTTP(S) URL without credentials or a #layer-<id> fragment supported by CodeLab.');
  }
  if (command.action === 'design_layout_configure') {
    const allowedLayoutKeys = ['mode', 'direction', 'gap', 'padding'];
    if (!allowedLayoutKeys.some(key => Object.prototype.hasOwnProperty.call(args, key))) throw new Error('design_layout_configure requires at least one layout property.');
    if (args.mode !== undefined && !['free', 'auto'].includes(args.mode)) throw new Error('Layout mode must be free or auto.');
    if (args.direction !== undefined && !['row', 'column'].includes(args.direction)) throw new Error('Layout direction must be row or column.');
    for (const key of ['gap', 'padding']) if (args[key] !== undefined && (!Number.isFinite(args[key]) || args[key] < 0 || args[key] > 200)) throw new Error(key + ' must be a number between 0 and 200.');
  }
  if (command.action === 'design_canvas_configure') {
    const allowedCanvasKeys = ['frame', 'grid', 'snap_to_grid', 'grid_size', 'zoom', 'background'];
    if (!allowedCanvasKeys.some(key => Object.prototype.hasOwnProperty.call(args, key))) throw new Error('design_canvas_configure requires at least one canvas property.');
    if (args.frame !== undefined && !['desktop', 'tablet', 'mobile'].includes(args.frame)) throw new Error('Frame must be desktop, tablet, or mobile.');
    for (const key of ['grid', 'snap_to_grid']) if (args[key] !== undefined && typeof args[key] !== 'boolean') throw new Error(key + ' must be boolean.');
    if (args.grid_size !== undefined && ![4, 8, 16, 32].includes(args.grid_size)) throw new Error('grid_size must be 4, 8, 16, or 32.');
    if (args.zoom !== undefined && (!Number.isFinite(args.zoom) || args.zoom < 10 || args.zoom > 150)) throw new Error('zoom must be between 10 and 150.');
    if (args.background !== undefined && (typeof args.background !== 'string' || !/^#[0-9a-f]{6}$/i.test(args.background))) throw new Error('background must be a six-digit hex color.');
  }
    if (!['main', 'branch'].includes(args.source || 'main')) throw new Error('project_code_write source must be main or branch.');
    const codeKeys = ['html', 'css', 'js'].filter(key => Object.prototype.hasOwnProperty.call(args, key));
    if (!codeKeys.length) throw new Error('project_code_write requires at least one of html, css, or js.');
    for (const key of codeKeys) {
      if (typeof args[key] !== 'string' || args[key].length > 50000) throw new Error('Each supplied code field must be a string of at most 50000 characters.');
    }
  }
  if (commandSource === 'comment' && args.self_test === true) throw new Error('Preview diagnostic self-test is not allowed from the read-only comment mailbox.');
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
  if (command.action === 'preview_interact') {
    if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > 20) {
      throw new Error('preview_interact requires between 1 and 20 steps.');
    }
    for (const step of args.steps) {
      if (!step || typeof step !== 'object' || Array.isArray(step) || !['click', 'fill', 'select', 'read'].includes(step.action)) {
        throw new Error('Invalid preview interaction step.');
      }
      if (typeof step.selector !== 'string' || !step.selector.trim() || step.selector.length > 2000) {
        throw new Error('Each preview interaction step requires a valid selector.');
      }
      if (['fill', 'select'].includes(step.action) && (typeof step.value !== 'string' || step.value.length > 2000)) {
        throw new Error('Preview fill/select steps require a string value of at most 2000 characters.');
      }
      if (step.action === 'click' && command.approval !== 'approved') {
        throw new Error('Preview click steps require approval: "approved".');
      }
    }
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
  const browserDiagnostics = { consoleErrors: [], pageErrors: [], failedRequests: [], expectedBlockedRequests: [] };
  const intentionallyBlockedUrls = new Set();
  const safeUrl = value => {
    try { const url = new URL(value); return url.origin + url.pathname; } catch (_) { return String(value || '').slice(0, 180); }
  };
  page.on('console', message => {
    const location = message.location()?.url || '';
    if (message.type() === 'error' && /net::ERR_FAILED/.test(message.text() || '') && intentionallyBlockedUrls.has(location)) return;
    if (message.type() === 'error' && browserDiagnostics.consoleErrors.length < 30) {
      browserDiagnostics.consoleErrors.push({
        text: String(message.text() || '').slice(0, 500),
        location: safeUrl(location)
      });
    }
  });
  page.on('pageerror', error => {
    if (browserDiagnostics.pageErrors.length < 30) browserDiagnostics.pageErrors.push(String(error?.message || error).slice(0, 500));
  });
  page.on('requestfailed', request => {
    if (intentionallyBlockedUrls.has(request.url())) {
      if (browserDiagnostics.expectedBlockedRequests.length < 30) browserDiagnostics.expectedBlockedRequests.push({
        url: safeUrl(request.url()),
        method: request.method(),
        reason: 'Intentionally blocked by the isolated preview test to prevent workspace persistence.'
      });
      return;
    }
    if (browserDiagnostics.failedRequests.length < 30) browserDiagnostics.failedRequests.push({
      url: safeUrl(request.url()),
      method: request.method(),
      failure: String(request.failure()?.errorText || 'request failed').slice(0, 200),
      resourceType: request.resourceType()
    });
  });
  if (command.action === 'preview_editor_smoke_test') {
    // Keep all workspace API traffic blocked in this disposable browser so the test cannot persist projects.
    await page.route('**/api/workspace**', route => {
      intentionallyBlockedUrls.add(route.request().url());
      return route.abort();
    });
  }
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

  if (command.action === 'ai_settings_inspect') {
    stage = 'ai_settings_inspect';
    result = await page.evaluate(() => ({
      mode: typeof aiSettings !== 'undefined' ? aiSettings.mode : null,
      model: typeof aiSettings !== 'undefined' ? aiSettings.model : null,
      baseUrl: typeof aiSettings !== 'undefined' ? aiSettings.baseUrl : null,
      apiKeyConfigured: !!(typeof aiSettings !== 'undefined' && aiSettings.apiKey),
      serverKeyConfigured: !!(typeof serverAi !== 'undefined' && serverAi.serverKey),
      serverModel: typeof serverAi !== 'undefined' ? serverAi.model : null,
      hint: typeof serverAi !== 'undefined' ? serverAi.hint : null,
      apiKeyExposed: false
    }));
  } else if (command.action === 'accessibility_audit') {
    stage = 'accessibility_audit';
    result = await page.evaluate(projectId => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project) throw new Error('Project not found in the authenticated workspace.');
      const api = window.CodeLabDesignTools;
      if (!api || typeof api.auditHtml !== 'function') throw new Error('Accessibility audit API is not ready.');
      const report = api.auditHtml(project.code?.html || '');
      return { projectId, projectName: project.name, report };
    }, command.args.project_id);
  } else if (command.action === 'design_tokens_generate') {
    stage = 'design_tokens_generate';
    result = await page.evaluate(settings => {
      const api = window.CodeLabDesignTools;
      if (!api || typeof api.sanitizeSettings !== 'function' || typeof api.buildDesignTokens !== 'function' || typeof api.toCssVariables !== 'function') {
        throw new Error('Design token API is not ready.');
      }
      const normalized = api.sanitizeSettings(settings || api.defaults);
      const tokens = api.buildDesignTokens(normalized);
      const css = api.toCssVariables(normalized);
      return { settings: normalized, tokens, css, verified: !!tokens && typeof css === 'string' };
    }, command.args.settings || null);
  } else if (command.action === 'design_export') {
    stage = 'design_export';
    result = await page.evaluate(({ projectId, format }) => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project || !project.design) throw new Error('Design project not found.');
      let content, mimeType;
      if (format === 'svg') {
        const api = window.CodeLabCapture;
        if (!api || typeof api.captureDesignSvg !== 'function') throw new Error('SVG export API is not ready.');
        const capture = api.captureDesignSvg(project);
        content = capture.svg;
        mimeType = 'image/svg+xml';
      } else {
        content = JSON.stringify({ format: 'codelab-design-project', version: 1, exportedAt: new Date().toISOString(), project }, null, 2);
        mimeType = 'application/json';
      }
      const max = 7000;
      return { projectId, format, mimeType, length: content.length, content: content.slice(0, max), truncated: content.length > max };
    }, { projectId: command.args.project_id, format: command.args.format });
  } else if (command.action === 'design_import_json') {
    stage = 'design_import_json';
    result = await (async () => {
      const before = await page.evaluate(() => ({
        ids: projects.map(project => project.id),
        count: projects.length,
        maxProjects: typeof maxProjects === 'number' ? maxProjects : null
      }));
      await page.locator('#designProjectJsonFile').setInputFiles({
        name: 'codelab-design-project-import.json',
        mimeType: 'application/json',
        buffer: Buffer.from(command.args.json, 'utf8')
      });
      try {
        await page.waitForFunction(
          beforeIds => projects.some(project => !beforeIds.includes(project.id)),
          before.ids,
          { timeout: 15000 }
        );
        await page.waitForFunction(() => typeof creatingProjectInFlight !== 'undefined' && !creatingProjectInFlight, null, { timeout: 20000 });
      } catch (_) {
        const state = await page.evaluate(beforeIds => ({
          projectCount: projects.length,
          newProjects: projects.filter(project => !beforeIds.includes(project.id)).map(project => ({ id: project.id, name: project.name })),
          toastText: document.querySelector('[role="status"]')?.textContent || document.querySelector('#toastContainer')?.textContent || null,
          syncStatus: document.getElementById('statusText')?.textContent || null
        }), before.ids);
        if (!state.newProjects.length) {
          return { imported: false, rejected: true, reason: 'The app rejected the JSON or did not create a project.', ...state };
        }
        throw new Error('Import started but did not settle: ' + JSON.stringify(state));
      }
      return await page.evaluate(beforeIds => {
        const added = projects.filter(project => !beforeIds.includes(project.id));
        if (added.length !== 1) throw new Error('Expected exactly one imported project; found ' + added.length + '.');
        const project = added[0];
        const snapshot = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || 'null');
        const localSnapshotVerified = Array.isArray(snapshot) && snapshot.some(item =>
          item?.id === project.id && item.name === project.name && item.design?.elements?.length === project.design?.elements?.length
        );
        return {
          imported: true,
          projectId: project.id,
          name: project.name,
          type: project.type,
          elementCount: project.design?.elements?.length || 0,
          frame: project.design?.frame || null,
          newProjectCount: added.length,
          localSnapshotVerified,
          syncStatus: document.getElementById('statusText')?.textContent || null
        };
      }, before.ids);
    })();
  } else if (command.action === 'project_export_html') {
    stage = 'project_export_html';
    result = await page.evaluate(({ projectId, maxChars }) => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project) throw new Error('Project not found in the authenticated workspace.');
      if (project.type === 'design') throw new Error('HTML export requires a web project.');
      const code = project.code || {};
      const content = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>' +
        String(code.css || '') + '</style></head><body>' + String(code.html || '') + '<script>' +
        String(code.js || '').replace(/<\/script/gi, '<\\/script') + '</script></body></html>';
      const limit = maxChars || 7000;
      return { projectId, name: project.name, mimeType: 'text/html', length: content.length, content: content.slice(0, limit), truncated: content.length > limit };
    }, { projectId: command.args.project_id, maxChars: command.args.max_chars || 7000 });
  } else if (command.action === 'project_convert_design_to_web') {
    stage = 'project_convert_design_to_web';
    result = await page.evaluate(async projectId => {
      const source = projects.find(item => item && item.id === projectId);
      if (!source || source.type !== 'design' || !source.design) throw new Error('Source must be an existing design project.');
      const sourceSnapshot = JSON.stringify(source.design);
      openProject(projectId);
      await new Promise(resolve => setTimeout(resolve, 250));
      await convertDesignToWeb();
      await new Promise(resolve => setTimeout(resolve, 500));
      const converted = projects.find(item => item && item.id === projectId);
      if (!converted || converted.type === 'design' || !converted.code?.html) {
        throw new Error('Design conversion did not convert the source project in place.');
      }
      const sourceUnchanged = JSON.stringify(converted.design) === sourceSnapshot;
      let localVerified = false;
      try {
        const snapshot = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || 'null');
        localVerified = Array.isArray(snapshot) && snapshot.some(item =>
          item?.id === projectId &&
          item.type !== 'design' &&
          item.code?.html === converted.code.html &&
          JSON.stringify(item.design) === sourceSnapshot
        );
      } catch (_) {}
      if (!sourceUnchanged) throw new Error('Source design changed during conversion.');
      if (!localVerified) throw new Error('Converted web project and preserved design were not verified in the local snapshot.');
      return {
        sourceProjectId: projectId,
        projectId: converted.id,
        name: converted.name,
        type: converted.type,
        convertedInPlace: true,
        sourceDesignPreserved: sourceUnchanged,
        codeLengths: { html: converted.code.html?.length || 0, css: converted.code.css?.length || 0, js: converted.code.js?.length || 0 },
        localSnapshotVerified: localVerified
      };
    }, command.args.project_id);
  } else if (command.action === 'ai_generate') {
    stage = 'ai_generate';
    result = await page.evaluate(async ({ projectId, source, prompt }) => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project) throw new Error('Project not found in the authenticated workspace.');
      if (project.type === 'design') throw new Error('AI code generation requires a web project.');
      if (source === 'branch' && !project.branch) throw new Error('Project has no saved copy branch.');
      openProject(projectId);
      await new Promise(resolve => setTimeout(resolve, 300));
      if (source === 'branch' && !inCopyBranch) await toggleCopyBranch();
      if (source === 'main' && inCopyBranch) await toggleCopyBranch();
      const before = { html: getEditorValue('html'), css: getEditorValue('css'), js: getEditorValue('js') };
      const input = document.getElementById('aiPromptInput');
      if (!input) throw new Error('AI prompt input is unavailable.');
      input.value = prompt;
      await processAiInstruction();
      const after = { html: getEditorValue('html'), css: getEditorValue('css'), js: getEditorValue('js') };
      const changedFields = ['html', 'css', 'js'].filter(key => before[key] !== after[key]);
      const latest = projects.find(item => item && item.id === projectId);
      const persisted = source === 'branch' ? latest?.branch?.code : latest?.code;
      const persistedMatches = !!persisted && ['html', 'css', 'js'].every(key => persisted[key] === after[key]);
      let localSnapshotVerified = false;
      try {
        const snapshot = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || 'null');
        const localProject = Array.isArray(snapshot) ? snapshot.find(item => item && item.id === projectId) : null;
        const localCode = source === 'branch' ? localProject?.branch?.code : localProject?.code;
        localSnapshotVerified = !!localCode && ['html', 'css', 'js'].every(key => localCode[key] === after[key]);
      } catch (_) {}
      return { projectId, source, changedFields, changed: changedFields.length > 0, persistedMatches, localSnapshotVerified, codeLengths: { html: after.html.length, css: after.css.length, js: after.js.length } };
    }, { projectId: command.args.project_id, source: command.args.source || 'main', prompt: command.args.prompt });
  } else if (command.action === 'design_flow_read') {
    stage = 'design_flow_read';
    result = await page.evaluate(projectId => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project || !project.design) throw new Error('Design project not found.');
      const elements = Array.isArray(project.design.elements) ? project.design.elements : [];
      const connections = Array.isArray(project.design.flowConnections) ? project.design.flowConnections : [];
      const targets = new Map(projects.filter(item => item?.type === 'design').map(item => [item.id, item]));
      return {
        projectId, projectName: project.name,
        connections: connections.map(connection => ({
          sourceElementId: connection.sourceElementId,
          sourceLabel: elements.find(element => element.id === connection.sourceElementId)?.label || null,
          targetProjectId: connection.targetProjectId,
          targetProjectName: targets.get(connection.targetProjectId)?.name || null,
          broken: !elements.some(element => element.id === connection.sourceElementId) || !targets.has(connection.targetProjectId)
        })),
        count: connections.length
      };
    }, command.args.project_id);
  } else if (command.action === 'design_flow_connect') {
    stage = 'design_flow_connect';
    result = await page.evaluate(async ({ projectId, elementId, targetProjectId }) => {
      const source = projects.find(item => item && item.id === projectId);
      const target = projects.find(item => item && item.id === targetProjectId);
      if (!source?.design || source.type !== 'design' || !target?.design || target.type !== 'design') throw new Error('Source and target must be design projects.');
      if (!source.design.elements?.some(element => element.id === elementId)) throw new Error('Source design element not found.');
      if (!Array.isArray(source.design.flowConnections)) source.design.flowConnections = [];
      if (source.design.flowConnections.some(connection => connection.sourceElementId === elementId && connection.targetProjectId === targetProjectId)) {
        return { projectId, elementId, targetProjectId, alreadyConnected: true, verified: true };
      }
      source.design.flowConnections.push({ sourceElementId: elementId, targetProjectId });
      const saved = await saveProjectsToStorage();
      const verified = source.design.flowConnections.some(connection => connection.sourceElementId === elementId && connection.targetProjectId === targetProjectId);
      if (!verified) throw new Error('Design flow connection could not be verified.');
      return { projectId, elementId, targetProjectId, alreadyConnected: false, saved: saved === true, verified };
    }, { projectId: command.args.project_id, elementId: command.args.element_id, targetProjectId: command.args.target_project_id });
  } else if (command.action === 'design_flow_disconnect') {
    stage = 'design_flow_disconnect';
    result = await page.evaluate(async ({ projectId, elementId, targetProjectId }) => {
      const source = projects.find(item => item && item.id === projectId);
      if (!source?.design || source.type !== 'design') throw new Error('Source design project not found.');
      const before = Array.isArray(source.design.flowConnections) ? source.design.flowConnections.length : 0;
      source.design.flowConnections = (source.design.flowConnections || []).filter(connection => !(connection.sourceElementId === elementId && connection.targetProjectId === targetProjectId));
      const removed = source.design.flowConnections.length < before;
      const saved = await saveProjectsToStorage();
      const verified = !source.design.flowConnections.some(connection => connection.sourceElementId === elementId && connection.targetProjectId === targetProjectId);
      if (!verified) throw new Error('Design flow disconnection could not be verified.');
      return { projectId, elementId, targetProjectId, removed, saved: saved === true, verified };
    }, { projectId: command.args.project_id, elementId: command.args.element_id, targetProjectId: command.args.target_project_id });
  } else if (command.action === 'project_delete') {
    stage = 'project_delete';
    result = await page.evaluate(async projectId => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project) throw new Error('Project not found in the authenticated workspace.');
      const originalConfirm = window.confirm;
      try {
        window.confirm = () => true;
        await deleteProject(projectId);
      } finally {
        window.confirm = originalConfirm;
      }
      const deleted = !projects.some(item => item && item.id === projectId);
      let localVerified = false;
      try {
        const snapshot = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || 'null');
        localVerified = Array.isArray(snapshot) && !snapshot.some(item => item && item.id === projectId);
      } catch (_) {}
      if (!deleted || !localVerified) throw new Error('Project deletion was not verified in memory and local snapshot.');
      return { projectId, deleted, localSnapshotVerified: localVerified };
    }, command.args.project_id);
  } else if (command.action === 'design_template_apply') {
    stage = 'design_template_apply';
    result = await page.evaluate(async ({ projectId, templateId, replaceExisting }) => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project || !project.design) throw new Error('Design project not found.');
      if (project.design.elements?.length && !replaceExisting) throw new Error('Design already has layers; set replace_existing=true and approval=approved to replace them.');
      openProject(projectId);
      await new Promise(resolve => setTimeout(resolve, 300));
      const originalConfirm = window.confirm;
      try {
        window.confirm = () => !!replaceExisting;
        applyDesignTemplate(templateId);
      } finally {
        window.confirm = originalConfirm;
      }
      const latest = projects.find(item => item && item.id === projectId);
      const hasLayers = Array.isArray(latest?.design?.elements) && latest.design.elements.length > 0;
      const saved = await saveProjectsToStorage();
      if (!hasLayers) throw new Error('Template application produced no design layers.');
      return { projectId, templateId, elementCount: latest.design.elements.length, saved: saved === true, verified: hasLayers };
    }, { projectId: command.args.project_id, templateId: command.args.template_id, replaceExisting: command.args.replace_existing === true });
  } else if (command.action === 'design_history') {
    stage = 'design_history';
    result = await page.evaluate(async ({ projectId, operation }) => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project || !project.design) throw new Error('Design project not found.');
      openProject(projectId);
      await new Promise(resolve => setTimeout(resolve, 300));
      const before = JSON.stringify(project.design);
      if (operation === 'undo') designUndo(); else designRedo();
      const latest = projects.find(item => item && item.id === projectId);
      const changed = JSON.stringify(latest.design) !== before;
      const saved = await saveProjectsToStorage();
      return { projectId, operation, changed, saved: saved === true, elementCount: latest.design.elements?.length || 0 };
    }, { projectId: command.args.project_id, operation: command.args.operation });
  } else if (command.action === 'project_create') {
    stage = 'project_create';
    result = await page.evaluate(async ({ name, type }) => {
      const beforeIds = new Set(projects.map(item => item.id));
      openNewProjectModal();
      const input = document.getElementById('newProjectNameInput');
      if (!input) throw new Error('New-project name input is unavailable.');
      input.value = name.trim();
      const radio = document.querySelector('input[name="newProjectType"][value="' + type + '"]');
      if (radio) radio.checked = true;
      await createNewProjectConfirm();
      const created = projects.find(item => !beforeIds.has(item.id));
      if (!created) throw new Error('Project creation did not produce a new project ID.');
      const snapshot = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || 'null');
      const localVerified = Array.isArray(snapshot) && snapshot.some(item => item?.id === created.id && item.name === name.trim());
      const serverSyncStatus = document.getElementById('statusText')?.textContent || null;
      if (!localVerified) throw new Error('Created project was not verified in the local snapshot.');
      if (serverSyncStatus !== 'Sincronizado') {
        throw new Error('Project creation was not confirmed by server sync (status: ' + (serverSyncStatus || 'unknown') + ').');
      }
      // A successful local snapshot and a stale status badge are not enough:
      // reload the authoritative workspace before reporting the project as created.
      if (typeof refreshWorkspaceFromServer !== 'function' || !(await refreshWorkspaceFromServer())) {
        throw new Error('Project creation could not be verified by reading the workspace back from the server.');
      }
      const serverReadbackVerified = projects.some(item => item?.id === created.id && item.name === name.trim() && item.type === (type || 'web'));
      if (!serverReadbackVerified) {
        throw new Error('Project creation was acknowledged but the project was missing from the server workspace readback.');
      }
      return { projectId: created.id, name: created.name, type: created.type, localSnapshotVerified: localVerified, serverSyncStatus, serverReadbackVerified };
    }, { name: command.args.name, type: command.args.type || 'web' });
  } else if (command.action === 'project_duplicate') {
    stage = 'project_duplicate';
    result = await page.evaluate(async projectId => {
      const source = projects.find(item => item && item.id === projectId);
      if (!source) throw new Error('Source project not found in the authenticated workspace.');
      const beforeIds = new Set(projects.map(item => item.id));
      const sourceCode = JSON.stringify(source.code || {});
      const sourceDesign = JSON.stringify(source.design || {});
      await duplicateProjectFromDashboard(projectId);
      const duplicate = projects.find(item => !beforeIds.has(item.id));
      if (!duplicate) throw new Error('Duplicate project was not created.');
      const sourceUnchanged = JSON.stringify(source.code || {}) === sourceCode && JSON.stringify(source.design || {}) === sourceDesign;
      let localVerified = false;
      try {
        const snapshot = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || 'null');
        localVerified = Array.isArray(snapshot) && snapshot.some(item => item?.id === duplicate.id && item.name === duplicate.name);
      } catch (_) {}
      if (!sourceUnchanged) throw new Error('Source project changed during duplication.');
      if (!localVerified) throw new Error('Duplicate was not verified in the local snapshot.');
      return { sourceProjectId: projectId, projectId: duplicate.id, name: duplicate.name, type: duplicate.type, sourceUnchanged, localSnapshotVerified: localVerified };
    }, command.args.project_id);
  } else if (command.action === 'workspace_inspect') {
    stage = 'workspace_inspect';
    result = await page.evaluate(() => ({
      initialized: Array.isArray(projects),
      projectCount: Array.isArray(projects) ? projects.length : 0,
      currentProjectId: currentProjectId || null,
      currentProjectName: getCurrentProject()?.name || null,
      activeEditor: document.getElementById('studioView')?.classList.contains('hidden') ? 'dashboard' : (getCurrentProject()?.type === 'design' ? 'design' : 'web'),
      copyBranchActive: !!inCopyBranch,
      syncStatus: document.getElementById('statusText')?.textContent || null,
      authVisible: !document.getElementById('authContainer')?.classList.contains('hidden'),
      version: typeof APP_VERSION === 'string' ? APP_VERSION : null
    }));
  } else if (command.action === 'project_inspect') {
    stage = 'project_inspect';
    result = await page.evaluate(projectId => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project) throw new Error('Project not found in the authenticated workspace.');
      return {
        id: project.id, name: project.name, type: project.type === 'design' ? 'design' : 'web',
        updatedAt: project.updatedAt || null, hasWebSpace: !!project.hasWebSpace, hasDesignSpace: !!project.hasDesignSpace,
        codeLengths: { html: project.code?.html?.length || 0, css: project.code?.css?.length || 0, js: project.code?.js?.length || 0 },
        design: project.design ? {
          elementCount: Array.isArray(project.design.elements) ? project.design.elements.length : 0,
          frame: project.design.frame || null, background: project.design.background || null,
          grid: project.design.grid ?? null, gridSize: project.design.gridSize ?? null,
          snapToGrid: project.design.snapToGrid ?? null
        } : null,
        branch: project.branch ? {
          id: project.branch.id || null, updatedAt: project.branch.updatedAt || null,
          codeLengths: { html: project.branch.code?.html?.length || 0, css: project.branch.code?.css?.length || 0, js: project.branch.code?.js?.length || 0 }
        } : null,
        mergeUndoAvailable: Array.isArray(project.mergeHistory) && project.mergeHistory.length > 0,
        isActive: currentProjectId === projectId
      };
    }, command.args.project_id);
  } else if (command.action === 'project_code_read') {
    stage = 'project_code_read';
    result = await page.evaluate(({ projectId, source }) => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project) throw new Error('Project not found in the authenticated workspace.');
      const code = source === 'branch' ? project.branch?.code : project.code;
      if (source === 'branch' && !project.branch) throw new Error('Project has no saved copy branch.');
      if (project.type === 'design' && source !== 'branch') return { projectId, source, designProject: true, message: 'This is a design project; use design_read for its layer structure.' };
      const max = 20000;
      const clip = value => ({ content: String(value || '').slice(0, max), length: String(value || '').length, truncated: String(value || '').length > max });
      return { projectId, source, html: clip(code?.html), css: clip(code?.css), js: clip(code?.js) };
    }, { projectId: command.args.project_id, source: command.args.source === 'branch' ? 'branch' : 'main' });
  } else if (command.action === 'design_read') {
    stage = 'design_read';
    result = await page.evaluate(projectId => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project) throw new Error('Project not found in the authenticated workspace.');
      if (!project.design) throw new Error('Project has no saved design state.');
      return {
        projectId, projectName: project.name, frame: project.design.frame || 'desktop',
        background: project.design.background || '#ffffff', grid: project.design.grid ?? true,
        gridSize: project.design.gridSize ?? 8, snapToGrid: project.design.snapToGrid ?? false,
        elements: (Array.isArray(project.design.elements) ? project.design.elements : []).slice(0, 200).map(element => ({
          id: element.id || null, type: element.type || null, name: element.name || null,
          x: element.x ?? null, y: element.y ?? null, width: element.width ?? null, height: element.height ?? null,
          text: typeof element.text === 'string' ? element.text.slice(0, 500) : null,
          src: typeof element.src === 'string' ? element.src.slice(0, 500) : null,
          zIndex: element.zIndex ?? null
        })),
        totalElements: Array.isArray(project.design.elements) ? project.design.elements.length : 0,
        truncated: (project.design.elements?.length || 0) > 200
      };
    }, command.args.project_id);
  } else if (command.action === 'project_code_write') {
    stage = 'project_code_write';
    result = await page.evaluate(async ({ projectId, source, patch }) => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project) throw new Error('Project not found in the authenticated workspace.');
      if (project.type === 'design') throw new Error('Code editing is not supported for design-only projects.');
      if (source === 'branch' && !project.branch) throw new Error('Project has no saved copy branch.');
      openProject(projectId);
      await new Promise(resolve => setTimeout(resolve, 300));
      if (source === 'branch' && !inCopyBranch) await toggleCopyBranch();
      if (source === 'main' && inCopyBranch) await toggleCopyBranch();
      const before = {
        html: getEditorValue('html'), css: getEditorValue('css'), js: getEditorValue('js')
      };
      const next = { ...before, ...patch };
      for (const key of ['html', 'css', 'js']) setEditorValue(key, next[key]);
      const saved = source === 'branch' ? await saveInCopyBranch() : await saveCurrentCodeToActiveProject(true);
      const latest = projects.find(item => item && item.id === projectId);
      const persisted = source === 'branch' ? latest?.branch?.code : latest?.code;
      const exact = !!persisted && ['html', 'css', 'js'].every(key => persisted[key] === next[key]);
      let localSnapshotVerified = false;
      try {
        const snapshot = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || 'null');
        const localProject = Array.isArray(snapshot) ? snapshot.find(item => item && item.id === projectId) : null;
        const localCode = source === 'branch' ? localProject?.branch?.code : localProject?.code;
        localSnapshotVerified = !!localCode && ['html', 'css', 'js'].every(key => localCode[key] === next[key]);
      } catch (_) {}
      if (!exact || (saved !== true && !localSnapshotVerified)) throw new Error('Code write was not verified by server sync or exact local snapshot.');
      return {
        projectId, source, changedFields: Object.keys(patch), saved: saved === true,
        persistedCodeMatchesRequested: exact, localSnapshotVerified,
        codeLengths: { html: next.html.length, css: next.css.length, js: next.js.length }
      };
    }, {
      projectId: command.args.project_id,
      source: command.args.source === 'branch' ? 'branch' : 'main',
      patch: Object.fromEntries(['html', 'css', 'js'].filter(key => Object.prototype.hasOwnProperty.call(command.args, key)).map(key => [key, command.args[key]]))
    });
  } else if (command.action === 'project_list') {
    stage = 'project_list';
    result = await page.evaluate(() => {
      if (!Array.isArray(projects)) throw new Error('Workspace projects are not initialized.');
      return {
        count: projects.length,
        projects: projects.map(project => ({
          id: project.id,
          name: project.name,
          type: project.type === 'design' ? 'design' : 'web',
          updatedAt: project.updatedAt || null,
          hasBranch: !!project.branch,
          branchId: project.branch?.id || null,
          branchUpdatedAt: project.branch?.updatedAt || null,
          mergeUndoAvailable: Array.isArray(project.mergeHistory) && project.mergeHistory.length > 0
        }))
      };
    });
  } else if (command.action === 'project_rename') {
    stage = 'project_rename';
    result = await page.evaluate(async ({ projectId, name }) => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project) throw new Error('Project not found in the authenticated workspace.');
      const previousName = project.name;
      const previousUpdatedAt = project.updatedAt;
      project.name = name.trim();
      project.updatedAt = new Date().toISOString();
      const saved = await saveProjectsToStorage();
      const persisted = projects.find(item => item && item.id === projectId);
      let localVerified = false;
      try {
        const snapshot = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || 'null');
        localVerified = Array.isArray(snapshot) && snapshot.some(item =>
          item && item.id === projectId && item.name === name.trim()
        );
      } catch (_) {}
      if (saved !== true && !localVerified) {
        project.name = previousName;
        project.updatedAt = previousUpdatedAt;
        saveLocalProjectsSnapshot();
        throw new Error('Rename was not durably confirmed; previous name restored.');
      }
      if (currentProjectId === projectId) {
        const title = document.getElementById('currentProjectTitle');
        if (title) title.textContent = project.name;
      }
      if (typeof renderProjectsList === 'function') renderProjectsList();
      return { projectId, previousName, name: project.name, serverSynced: saved === true, localSnapshotVerified: localVerified };
    }, { projectId: command.args.project_id, name: command.args.name });
  } else if (command.action === 'project_save') {
    stage = 'project_save';
    result = await page.evaluate(async projectId => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project) throw new Error('Project not found in the authenticated workspace.');
      if (currentProjectId !== projectId) openProject(projectId);
      await new Promise(resolve => setTimeout(resolve, 250));
      let saved;
      if (inCopyBranch) saved = await saveInCopyBranch();
      else saved = await saveCurrentCodeToActiveProject(true);
      const projectAfter = projects.find(item => item && item.id === projectId);
      const snapshot = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || 'null');
      const localProject = Array.isArray(snapshot) ? snapshot.find(item => item && item.id === projectId) : null;
      let localVerified = false;
      if (projectAfter?.type === 'design') {
        localVerified = !!localProject?.design && JSON.stringify(localProject.design) === JSON.stringify(projectAfter.design);
      } else {
        const expectedCode = inCopyBranch ? projectAfter?.branch?.code : projectAfter?.code;
        const localCode = inCopyBranch ? localProject?.branch?.code : localProject?.code;
        localVerified = !!expectedCode && !!localCode && ['html', 'css', 'js'].every(key => localCode[key] === expectedCode[key]);
      }
      return { projectId, saved: saved === true, localSnapshotVerified: localVerified, branchPresent: !!projectAfter?.branch };
    }, command.args.project_id);
    if (!result.saved && !result.localSnapshotVerified) throw new Error('Save could not be verified on server or exact local project state.');
  } else if (command.action === 'branch_status') {
    stage = 'branch_status';
    result = await page.evaluate(projectId => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project) throw new Error('Project not found in the authenticated workspace.');
      const branch = project.branch;
      return {
        projectId,
        projectName: project.name,
        hasBranch: !!branch,
        branchId: branch?.id || null,
        baseMainUpdatedAt: branch?.baseMainUpdatedAt || null,
        branchUpdatedAt: branch?.updatedAt || null,
        codeLengths: branch?.code ? { html: branch.code.html?.length || 0, css: branch.code.css?.length || 0, js: branch.code.js?.length || 0 } : null,
        currentViewIsBranch: currentProjectId === projectId && inCopyBranch
      };
    }, command.args.project_id);
  } else if (command.action === 'branch_resume') {
    stage = 'branch_resume';
    result = await page.evaluate(async projectId => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project || !project.branch) throw new Error('Project has no saved copy branch to resume.');
      openProject(projectId);
      await new Promise(resolve => setTimeout(resolve, 300));
      if (!inCopyBranch) await toggleCopyBranch();
      const resumed = getCurrentProject();
      const verified = !!(inCopyBranch && resumed?.branch && resumed.branch.id === copyBranchId &&
        getEditorValue('html') === resumed.branch.code.html &&
        getEditorValue('css') === resumed.branch.code.css &&
        getEditorValue('js') === resumed.branch.code.js);
      if (!verified) throw new Error('The saved branch could not be verified in the editor.');
      return { projectId, projectName: resumed.name, branchId: copyBranchId, resumed: true, editorMatchesSavedBranch: verified };
    }, command.args.project_id);
  } else if (command.action === 'branch_save') {
    stage = 'branch_save';
    result = await page.evaluate(async projectId => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project || !project.branch) throw new Error('Project has no copy branch to save.');
      if (currentProjectId !== projectId || !inCopyBranch) {
        openProject(projectId);
        await new Promise(resolve => setTimeout(resolve, 300));
        if (!inCopyBranch) await toggleCopyBranch();
      }
      const saved = await saveInCopyBranch();
      const latest = projects.find(item => item && item.id === projectId);
      const snapshot = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || 'null');
      const localBranch = Array.isArray(snapshot) ? snapshot.find(item => item && item.id === projectId)?.branch : null;
      const localVerified = !!localBranch && localBranch.id === latest?.branch?.id &&
        localBranch.code?.html === latest.branch.code?.html &&
        localBranch.code?.css === latest.branch.code?.css &&
        localBranch.code?.js === latest.branch.code?.js;
      if (!saved && !localVerified) throw new Error('Copy branch save could not be verified.');
      return { projectId, branchId: latest.branch.id, serverSynced: saved === true, localSnapshotVerified: localVerified, updatedAt: latest.branch.updatedAt };
    }, command.args.project_id);
  } else if (command.action === 'branch_create') {
    stage = 'branch_create';
    result = await page.evaluate(async projectId => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project) throw new Error('Project not found in the authenticated workspace.');
      if (project.type === 'design') throw new Error('Copy branches currently support web projects only.');
      if (project.branch) return { projectId, branchId: project.branch.id, created: false, alreadyExists: true };
      openProject(projectId);
      await new Promise(resolve => setTimeout(resolve, 300));
      if (inCopyBranch) await toggleCopyBranch();
      const originalCode = { html: getEditorValue('html'), css: getEditorValue('css'), js: getEditorValue('js') };
      await duplicateProject();
      const latest = projects.find(item => item && item.id === projectId);
      const snapshot = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || 'null');
      const localProject = Array.isArray(snapshot) ? snapshot.find(item => item && item.id === projectId) : null;
      const branch = latest?.branch;
      const localVerified = !!(localProject?.branch && branch &&
        localProject.branch.id === branch.id &&
        ['html', 'css', 'js'].every(key => localProject.branch.code?.[key] === branch.code?.[key]) &&
        ['html', 'css', 'js'].every(key => branch.baseCode?.[key] === originalCode[key]));
      if (!branch || !localVerified) throw new Error('Copy branch creation was not verified against the local durable snapshot.');
      return { projectId, branchId: branch.id, created: true, alreadyExists: false, localSnapshotVerified: true, branchMatchesMainAtCreation: ['html', 'css', 'js'].every(key => branch.code[key] === originalCode[key]), updatedAt: branch.updatedAt };
    }, command.args.project_id);
  } else if (command.action === 'branch_merge') {
    stage = 'branch_merge';
    result = await page.evaluate(async projectId => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project || !project.branch) throw new Error('Project has no saved copy branch to merge.');
      const branchId = project.branch.id;
      openProject(projectId);
      await new Promise(resolve => setTimeout(resolve, 300));
      if (!inCopyBranch) await toggleCopyBranch();
      const previousHistoryLength = Array.isArray(project.mergeHistory) ? project.mergeHistory.length : 0;
      const previousBranchCode = { html: project.branch.code.html, css: project.branch.code.css, js: project.branch.code.js };
      const oldConfirm = window.confirm;
      window.confirm = () => true;
      try { await mergeToMainProject(); } finally { window.confirm = oldConfirm; }
      const latest = projects.find(item => item && item.id === projectId);
      const snapshot = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || 'null');
      const localProject = Array.isArray(snapshot) ? snapshot.find(item => item && item.id === projectId) : null;
      const merged = !!latest && !latest.branch && (latest.mergeHistory?.length || 0) > previousHistoryLength;
      const localVerified = !!localProject && !localProject.branch &&
        ['html', 'css', 'js'].every(key => localProject.code?.[key] === latest.code?.[key]) &&
        (localProject.mergeHistory?.length || 0) === (latest.mergeHistory?.length || 0);
      if (!merged) throw new Error('Merge was not completed; the branch remains available or a conflict prevented the merge.');
      if (!localVerified) throw new Error('Merge result could not be verified in the durable local snapshot.');
      return { projectId, branchId, merged: true, mainCodeLengths: { html: latest.code.html.length, css: latest.code.css.length, js: latest.code.js.length }, backupCreated: true, localSnapshotVerified: true, serverSynced: !serverSyncError };
    }, command.args.project_id);
  } else if (command.action === 'branch_undo_merge') {
    stage = 'branch_undo_merge';
    result = await page.evaluate(async projectId => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project || !Array.isArray(project.mergeHistory) || !project.mergeHistory.length) throw new Error('Project has no merge to undo.');
      openProject(projectId);
      await new Promise(resolve => setTimeout(resolve, 300));
      const previousHistoryLength = project.mergeHistory.length;
      const previousBackup = project.mergeHistory[previousHistoryLength - 1];
      const expectedCode = { html: previousBackup.code.html, css: previousBackup.code.css, js: previousBackup.code.js };
      const oldConfirm = window.confirm;
      window.confirm = () => true;
      try { await undoLastMerge(); } finally { window.confirm = oldConfirm; }
      const latest = projects.find(item => item && item.id === projectId);
      const snapshot = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || 'null');
      const localProject = Array.isArray(snapshot) ? snapshot.find(item => item && item.id === projectId) : null;
      const restored = !!latest && (latest.mergeHistory?.length || 0) === previousHistoryLength - 1 &&
        ['html', 'css', 'js'].every(key => latest.code?.[key] === expectedCode[key]);
      const localVerified = !!localProject && ['html', 'css', 'js'].every(key => localProject.code?.[key] === expectedCode[key]) &&
        (localProject.mergeHistory?.length || 0) === previousHistoryLength - 1;
      if (!restored || !localVerified) throw new Error('Undo merge was not verified against the saved code and history.');
      return { projectId, undone: true, branchRestored: !!latest.branch, mergeHistoryRemaining: latest.mergeHistory.length, localSnapshotVerified: true, serverSynced: !serverSyncError };
    }, command.args.project_id);
  } else if (command.action === 'component_search') {
    stage = 'component_search';
    result = await page.evaluate(({ query, category }) => {
      const api = window.CodeLabComponentLibrary;
      if (!api || typeof api.searchComponents !== 'function') throw new Error('Component library API is not ready.');
      const matches = api.searchComponents(query || '', category || 'Todas');
      return { count: matches.length, components: matches.slice(0, 100).map(item => ({
        id: item.id, name: item.name, category: item.category, description: item.description, tags: item.tags
      })), truncated: matches.length > 100 };
    }, { query: command.args.query || '', category: command.args.category || 'Todas' });
  } else if (command.action === 'component_inspect') {
    stage = 'component_inspect';
    result = await page.evaluate(({ componentId, maxChars }) => {
      const api = window.CodeLabComponentLibrary;
      if (!api || typeof api.getComponent !== 'function' || typeof api.standaloneHtml !== 'function') {
        throw new Error('Component library inspection API is not ready.');
      }
      const item = api.getComponent(componentId);
      if (!item) throw new Error('Component ID was not found in the library.');
      const html = api.standaloneHtml(item);
      const limit = Number.isInteger(maxChars) ? Math.max(1000, Math.min(7000, maxChars)) : 5000;
      return {
        id: item.id, name: item.name, category: item.category, description: item.description,
        tags: item.tags, htmlLength: html.length, html: html.slice(0, limit),
        truncated: html.length > limit, format: 'text/html'
      };
    }, { componentId: command.args.component_id, maxChars: command.args.max_chars });
  } else if (command.action === 'component_insert') {
    stage = 'component_insert';
    result = await page.evaluate(async ({ projectId, componentId }) => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project) throw new Error('Project not found in the authenticated workspace.');
      if (project.type === 'design') throw new Error('Components can only be inserted into a web project.');
      const api = window.CodeLabComponentLibrary;
      const component = api?.getComponent?.(componentId);
      if (!component) throw new Error('Component ID was not found in the library.');
      openProject(projectId);
      await new Promise(resolve => setTimeout(resolve, 300));
      const marker = '<!-- codelab-component:' + componentId + ' -->';
      const current = String(getEditorValue('html') || '');
      if (current.includes(marker)) return { projectId, componentId, alreadyInserted: true, saved: true, localSnapshotVerified: true };
      const next = current + '\n' + marker + '\n' + component.html + '\n';
      if (next.length > 500000) throw new Error('Insertion would exceed the 500000-character HTML limit.');
      setEditorValue('html', next);
      if (typeof updatePreview === 'function') updatePreview();
      const saved = await saveCurrentCodeToActiveProject(true);
      const latest = projects.find(item => item && item.id === projectId);
      const exact = String(latest?.code?.html || '') === next;
      let localSnapshotVerified = false;
      try {
        const snapshot = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || 'null');
        const localProject = Array.isArray(snapshot) ? snapshot.find(item => item && item.id === projectId) : null;
        localSnapshotVerified = String(localProject?.code?.html || '') === next;
      } catch (_) {}
      if (!exact || (saved !== true && !localSnapshotVerified)) throw new Error('Component insertion was not verified by server sync or exact local snapshot.');
      return { projectId, componentId, alreadyInserted: false, saved: saved === true, persistedCodeMatches: exact, localSnapshotVerified };
    }, { projectId: command.args.project_id, componentId: command.args.component_id });
  } else if (command.action === 'design_element_add') {
    stage = 'design_element_add';
    result = await page.evaluate(async ({ projectId, type }) => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project) throw new Error('Project not found in the authenticated workspace.');
      if (project.type !== 'design' || !project.design) throw new Error('This action requires a design project.');
      openProject(projectId);
      await new Promise(resolve => setTimeout(resolve, 300));
      const before = project.design.elements.length;
      addDesignElement(type);
      const latest = projects.find(item => item && item.id === projectId);
      const element = latest?.design?.elements?.find(item => !project.design.elements.slice(0, before).some(old => old.id === item.id));
      await saveProjectsToStorage();
      if (!element) throw new Error('Design element was not created.');
      return { projectId, elementId: element.id, type: element.type, elementCount: latest.design.elements.length };
    }, { projectId: command.args.project_id, type: command.args.type });
  } else if (command.action === 'design_element_update') {
    stage = 'design_element_update';
    result = await page.evaluate(async ({ projectId, elementId, properties }) => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project || !project.design) throw new Error('Design project not found.');
      openProject(projectId);
      await new Promise(resolve => setTimeout(resolve, 300));
      const element = project.design.elements.find(item => item && item.id === elementId);
      if (!element) throw new Error('Design element not found.');
      recordDesignHistory();
      Object.assign(element, properties);
      renderDesignWorkspace();
      const saved = await saveProjectsToStorage();
      const exact = Object.entries(properties).every(([key, value]) => element[key] === value);
      let localVerified = false;
      try {
        const snapshot = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || 'null');
        const localProject = Array.isArray(snapshot) ? snapshot.find(item => item && item.id === projectId) : null;
        const localElement = localProject?.design?.elements?.find(item => item && item.id === elementId);
        localVerified = !!localElement && Object.entries(properties).every(([key, value]) => localElement[key] === value);
      } catch (_) {}
      if (!exact || (saved !== true && !localVerified)) throw new Error('Design element update was not verified by server sync or local snapshot.');
      return { projectId, elementId, changedProperties: Object.keys(properties), saved: saved === true, verified: exact, localSnapshotVerified: localVerified };
    }, { projectId: command.args.project_id, elementId: command.args.element_id, properties: command.args.properties });
  } else if (command.action === 'design_element_delete') {
    stage = 'design_element_delete';
    result = await page.evaluate(async ({ projectId, elementId }) => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project || !project.design) throw new Error('Design project not found.');
      openProject(projectId);
      await new Promise(resolve => setTimeout(resolve, 300));
      if (!project.design.elements.some(item => item && item.id === elementId)) throw new Error('Design element not found.');
      selectedDesignElementId = elementId;
      selectedDesignElementIds = [elementId];
      deleteDesignElement();
      await new Promise(resolve => setTimeout(resolve, 100));
      const latest = projects.find(item => item && item.id === projectId);
      const deleted = !latest.design.elements.some(item => item && item.id === elementId);
      const saved = await saveProjectsToStorage();
      if (!deleted) throw new Error('Design element deletion could not be verified.');
      return { projectId, elementId, deleted, saved: saved === true, remainingElements: latest.design.elements.length };
    }, { projectId: command.args.project_id, elementId: command.args.element_id });
  } else if (command.action === 'design_elements_delete') {
    stage = 'design_elements_delete';
    result = await page.evaluate(async ({ projectId, elementIds }) => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project?.design || !Array.isArray(project.design.elements)) throw new Error('Design project not found.');
      const existing = new Set(project.design.elements.map(item => item && item.id));
      const missing = elementIds.filter(id => !existing.has(id));
      if (missing.length) throw new Error('One or more design elements were not found: ' + missing.join(', '));
      openProject(projectId); await new Promise(resolve => setTimeout(resolve, 250));
      selectedDesignElementId = elementIds[0]; selectedDesignElementIds = [...elementIds];
      deleteDesignElement();
      await new Promise(resolve => setTimeout(resolve, 100));
      const latest = projects.find(item => item && item.id === projectId);
      const remainingIds = new Set(latest.design.elements.map(item => item.id));
      const deleted = elementIds.every(id => !remainingIds.has(id));
      const danglingConnections = Array.isArray(latest.design.flowConnections)
        ? latest.design.flowConnections.filter(connection => elementIds.includes(connection.sourceElementId)) : [];
      const saved = await saveProjectsToStorage();
      const snapshot = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || 'null');
      const local = Array.isArray(snapshot) ? snapshot.find(item => item && item.id === projectId) : null;
      const localIds = new Set(local?.design?.elements?.map(item => item.id) || []);
      const localSnapshotVerified = elementIds.every(id => !localIds.has(id));
      if (!deleted || danglingConnections.length || !localSnapshotVerified) throw new Error('Bulk deletion could not be fully verified.');
      return { projectId, deletedElementIds: elementIds, deleted, saved: saved === true, remainingElements: latest.design.elements.length, danglingConnections: danglingConnections.length, localSnapshotVerified };
    }, { projectId: command.args.project_id, elementIds: command.args.element_ids });
  } else if (command.action === 'design_element_duplicate') {
    stage = 'design_element_duplicate';
    result = await page.evaluate(async ({ projectId, elementId }) => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project || !project.design) throw new Error('Design project not found.');
      const source = project.design.elements.find(item => item && item.id === elementId);
      if (!source) throw new Error('Design element not found.');
      openProject(projectId); await new Promise(resolve => setTimeout(resolve, 250));
      selectedDesignElementId = elementId; selectedDesignElementIds = [elementId];
      const before = new Set(project.design.elements.map(item => item.id));
      duplicateDesignElement();
      const latest = projects.find(item => item && item.id === projectId);
      const created = latest.design.elements.find(item => !before.has(item.id));
      const saved = await saveProjectsToStorage();
      const snapshot = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || 'null');
      const local = Array.isArray(snapshot) ? snapshot.find(item => item && item.id === projectId) : null;
      const persisted = !!local?.design?.elements?.some(item => item.id === created?.id && item.type === source.type && item.x === (Number(source.x)||0)+24 && item.y === (Number(source.y)||0)+24);
      if (!created || !persisted) throw new Error('Duplicate element was not verified in the local snapshot.');
      return { projectId, sourceElementId: elementId, elementId: created.id, duplicated: true, saved: saved === true, localSnapshotVerified: true };
    }, { projectId: command.args.project_id, elementId: command.args.element_id });
  } else if (command.action === 'design_layer_move') {
    stage = 'design_layer_move';
    result = await page.evaluate(async ({ projectId, elementId, direction }) => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project?.design) throw new Error('Design project not found.');
      const before = project.design.elements.map(item => item.id);
      if (!before.includes(elementId)) throw new Error('Design element not found.');
      openProject(projectId); await new Promise(resolve => setTimeout(resolve, 250));
      selectedDesignElementId = elementId; selectedDesignElementIds = [elementId];
      moveDesignLayer(direction === 'back' ? -1 : 1);
      const latest = projects.find(item => item && item.id === projectId);
      const after = latest.design.elements.map(item => item.id);
      const moved = after.indexOf(elementId) !== before.indexOf(elementId);
      const saved = await saveProjectsToStorage();
      const snapshot = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || 'null');
      const local = Array.isArray(snapshot) ? snapshot.find(item => item && item.id === projectId) : null;
      const localOrder = local?.design?.elements?.map(item => item.id) || [];
      const verified = localOrder.length === after.length && localOrder.every((id, index) => id === after[index]);
      if (!verified) throw new Error('Layer order was not verified in the local snapshot.');
      return { projectId, elementId, direction, moved, saved: saved === true, localSnapshotVerified: true, order: after };
    }, { projectId: command.args.project_id, elementId: command.args.element_id, direction: command.args.direction });
  } else if (command.action === 'design_layer_reorder') {
    stage = 'design_layer_reorder';
    result = await page.evaluate(async ({ projectId, elementId, targetIndex }) => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project?.design || !Array.isArray(project.design.elements)) throw new Error('Design project not found.');
      const elements = project.design.elements;
      const currentIndex = elements.findIndex(item => item && item.id === elementId);
      if (currentIndex < 0) throw new Error('Design element not found.');
      if (targetIndex >= elements.length) throw new Error('target_index exceeds the current layer count.');
      if (currentIndex !== targetIndex) {
        openProject(projectId); await new Promise(resolve => setTimeout(resolve, 250));
        const active = projects.find(item => item && item.id === projectId);
        const list = active.design.elements;
        const from = list.findIndex(item => item && item.id === elementId);
        if (from < 0 || targetIndex >= list.length) throw new Error('Layer order changed before reorder could be applied.');
        recordDesignHistory();
        const [element] = list.splice(from, 1);
        list.splice(targetIndex, 0, element);
        active.updatedAt = new Date().toISOString();
        renderDesignWorkspace();
      }
      const latest = projects.find(item => item && item.id === projectId);
      const order = latest.design.elements.map(item => item.id);
      const verified = order[targetIndex] === elementId;
      const saved = await saveProjectsToStorage();
      const snapshot = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || 'null');
      const local = Array.isArray(snapshot) ? snapshot.find(item => item && item.id === projectId) : null;
      const localOrder = local?.design?.elements?.map(item => item.id) || [];
      const localSnapshotVerified = localOrder.length === order.length && localOrder.every((id, index) => id === order[index]);
      if (!verified || !localSnapshotVerified) throw new Error('Layer reorder could not be verified.');
      return { projectId, elementId, fromIndex: currentIndex, targetIndex, changed: currentIndex !== targetIndex, saved: saved === true, localSnapshotVerified, order };
    }, { projectId: command.args.project_id, elementId: command.args.element_id, targetIndex: command.args.target_index });
  } else if (command.action === 'design_elements_align') {
    stage = 'design_elements_align';
    result = await page.evaluate(async ({ projectId, elementIds, mode }) => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project?.design) throw new Error('Design project not found.');
      const selected = project.design.elements.filter(item => elementIds.includes(item.id));
      if (selected.length !== elementIds.length) throw new Error('One or more design elements were not found.');
      openProject(projectId); await new Promise(resolve => setTimeout(resolve, 250));
      selectedDesignElementId = selected[0].id; selectedDesignElementIds = selected.map(item => item.id);
      const before = selected.map(item => ({ id: item.id, x: item.x, y: item.y }));
      alignDesignElement(mode);
      const latest = projects.find(item => item && item.id === projectId);
      const after = latest.design.elements.filter(item => elementIds.includes(item.id)).map(item => ({ id: item.id, x: item.x, y: item.y }));
      const changed = JSON.stringify(before) !== JSON.stringify(after);
      const saved = await saveProjectsToStorage();
      const snapshot = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || 'null');
      const local = Array.isArray(snapshot) ? snapshot.find(item => item && item.id === projectId) : null;
      const localVerified = !!local && after.every(item => { const savedItem = local.design?.elements?.find(el => el.id === item.id); return savedItem && savedItem.x === item.x && savedItem.y === item.y; });
      if (!localVerified) throw new Error('Alignment was not verified in the local snapshot.');
      return { projectId, mode, elementIds, changed, saved: saved === true, localSnapshotVerified: true, positions: after };
    }, { projectId: command.args.project_id, elementIds: command.args.element_ids, mode: command.args.mode });
  } else if (command.action === 'design_elements_distribute') {
    stage = 'design_elements_distribute';
    result = await page.evaluate(async ({ projectId, elementIds, axis }) => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project?.design) throw new Error('Design project not found.');
      const selected = project.design.elements.filter(item => elementIds.includes(item.id));
      if (selected.length !== elementIds.length) throw new Error('One or more design elements were not found.');
      if (project.design.layoutMode === 'auto') throw new Error('Switch the design to free layout before manual distribution.');
      openProject(projectId); await new Promise(resolve => setTimeout(resolve, 250));
      selectedDesignElementId = selected[0].id; selectedDesignElementIds = selected.map(item => item.id);
      const key = axis === 'vertical' ? 'y' : 'x';
      const before = selected.map(item => ({ id: item.id, x: item.x, y: item.y }));
      distributeDesignElements(axis);
      const latest = projects.find(item => item && item.id === projectId);
      const after = latest.design.elements.filter(item => elementIds.includes(item.id)).map(item => ({ id: item.id, x: item.x, y: item.y }));
      const changed = JSON.stringify(before) !== JSON.stringify(after);
      const saved = await saveProjectsToStorage();
      const snapshot = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || 'null');
      const local = Array.isArray(snapshot) ? snapshot.find(item => item && item.id === projectId) : null;
      const localVerified = !!local && after.every(item => {
        const stored = local.design?.elements?.find(el => el.id === item.id);
        return stored && stored.x === item.x && stored.y === item.y;
      });
      if (!changed || !localVerified) throw new Error('Distribution did not change and persist the selected element positions.');
      return { projectId, axis, elementIds, changed, saved: saved === true, localSnapshotVerified: true, positions: after };
    }, { projectId: command.args.project_id, elementIds: command.args.element_ids, axis: command.args.axis });
  } else if (command.action === 'design_prototype_target_set') {
    stage = 'design_prototype_target_set';
    result = await page.evaluate(async ({ projectId, elementId, target }) => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project?.design) throw new Error('Design project not found.');
      openProject(projectId); await new Promise(resolve => setTimeout(resolve, 250));
      const element = project.design.elements.find(item => item && item.id === elementId);
      if (!element) throw new Error('Design element not found.');
      if (!['button', 'text', 'heading', 'image'].includes(element.type)) throw new Error('Prototype targets can only be assigned to interactive or content elements supported by the editor.');
      selectedDesignElementId = elementId; selectedDesignElementIds = [elementId];
      const before = element.href || '';
      setDesignPrototypeTarget(target);
      const latest = projects.find(item => item && item.id === projectId);
      const updated = latest.design.elements.find(item => item && item.id === elementId);
      const saved = await saveProjectsToStorage();
      const snapshot = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || 'null');
      const local = Array.isArray(snapshot) ? snapshot.find(item => item && item.id === projectId) : null;
      const stored = local?.design?.elements?.find(item => item && item.id === elementId);
      if (!updated || updated.href !== target || !stored || stored.href !== target) throw new Error('Prototype target was not persisted exactly.');
      return { projectId, elementId, previousTarget: before, target: updated.href, saved: saved === true, localSnapshotVerified: true };
    }, { projectId: command.args.project_id, elementId: command.args.element_id, target: command.args.target });
  } else if (command.action === 'design_layout_configure') {
    stage = 'design_layout_configure';
    result = await page.evaluate(async ({ projectId, settings }) => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project?.design) throw new Error('Design project not found.');
      openProject(projectId); await new Promise(resolve => setTimeout(resolve, 250));
      if (settings.mode !== undefined) setDesignLayoutMode(settings.mode);
      if (settings.direction !== undefined) setDesignLayoutDirection(settings.direction);
      if (settings.gap !== undefined) setDesignLayoutGap(settings.gap);
      if (settings.padding !== undefined) setDesignLayoutPadding(settings.padding);
      const latest = projects.find(item => item && item.id === projectId);
      const actual = { mode: latest.design.layoutMode || 'free', direction: latest.design.layoutDirection || 'row', gap: latest.design.layoutGap ?? 0, padding: latest.design.layoutPadding ?? 0 };
      const exact = Object.entries(settings).every(([key, value]) => actual[{mode:'mode',direction:'direction',gap:'gap',padding:'padding'}[key]] === value);
      const saved = await saveProjectsToStorage();
      const snapshot = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || 'null');
      const local = Array.isArray(snapshot) ? snapshot.find(item => item && item.id === projectId) : null;
      const localVerified = !!local && Object.entries(settings).every(([key, value]) => local.design?.[{mode:'layoutMode',direction:'layoutDirection',gap:'layoutGap',padding:'layoutPadding'}[key]] === value);
      if (!exact || !localVerified) throw new Error('Layout settings were not verified.');
      return { projectId, settings: actual, changed: Object.keys(settings), saved: saved === true, localSnapshotVerified: true };
    }, { projectId: command.args.project_id, settings: Object.fromEntries(['mode','direction','gap','padding'].filter(key => command.args[key] !== undefined).map(key => [key, command.args[key]])) });
  } else if (command.action === 'design_canvas_configure') {
    stage = 'design_canvas_configure';
    result = await page.evaluate(async ({ projectId, settings }) => {
      const project = projects.find(item => item && item.id === projectId);
      if (!project?.design) throw new Error('Design project not found.');
      openProject(projectId); await new Promise(resolve => setTimeout(resolve, 250));
      if (settings.frame !== undefined) setDesignFrame(settings.frame);
      if (settings.grid !== undefined) { if (!!project.design.grid !== settings.grid) toggleDesignGrid(); }
      if (settings.snap_to_grid !== undefined) { if (!!project.design.snapToGrid !== settings.snap_to_grid) toggleDesignSnap(); }
      if (settings.grid_size !== undefined) setDesignGridSize(settings.grid_size);
      if (settings.background !== undefined) setDesignBackground(settings.background);
      if (settings.zoom !== undefined) setDesignZoom(settings.zoom);
      const latest = projects.find(item => item && item.id === projectId);
      const actual = { frame: latest.design.frame || 'desktop', grid: latest.design.grid ?? true, snap_to_grid: latest.design.snapToGrid ?? false, grid_size: latest.design.gridSize ?? 8, background: latest.design.background || '#ffffff', zoom: Math.round(designZoom * 100) };
      const keys = Object.keys(settings).filter(key => key !== 'zoom');
      const exact = keys.every(key => actual[key] === settings[key]) && (settings.zoom === undefined || actual.zoom === settings.zoom);
      const saved = await saveProjectsToStorage();
      const snapshot = JSON.parse(localStorage.getItem('codelab_xd_projects_v2') || 'null');
      const local = Array.isArray(snapshot) ? snapshot.find(item => item && item.id === projectId) : null;
      const localVerified = !!local && keys.every(key => local.design?.[{frame:'frame',grid:'grid',snap_to_grid:'snapToGrid',grid_size:'gridSize',background:'background'}[key]] === settings[key]);
      if (!exact || !localVerified) throw new Error('Canvas settings were not verified; zoom is session-only.');
      return { projectId, settings: actual, changed: Object.keys(settings), saved: saved === true, localSnapshotVerified: true, zoomSessionOnly: settings.zoom !== undefined };
    }, { projectId: command.args.project_id, settings: Object.fromEntries(['frame','grid','snap_to_grid','grid_size','zoom','background'].filter(key => command.args[key] !== undefined).map(key => [key, command.args[key]])) });
  } else if (command.action === 'ai_ping') {
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
  } else if (command.action === 'preview_editor_smoke_test') {
    stage = 'editor_preview_smoke_test';
    const projectName = 'CodeLab Preview Probe ' + commandId.slice(-12);
    stage = 'editor_preview_wait_boot';
    await page.waitForFunction(() => document.getElementById('syncLoadingModal')?.classList.contains('hidden'), null, { timeout: 15000 });
    stage = 'editor_preview_open_create_modal';
    await page.getByRole('button', { name: /Crear proyecto/i }).click();
    stage = 'editor_preview_fill_project_name';
    await page.locator('#newProjectNameInput').fill(projectName);
    stage = 'editor_preview_select_web_type';
    await page.locator('input[name="newProjectType"][value="web"]').check();
    stage = 'editor_preview_confirm_create';
    await page.locator('#newProjectModal button[onclick="createNewProjectConfirm()"]').click();
    stage = 'editor_preview_wait_studio';
    await page.locator('#studioView').waitFor({ state: 'visible', timeout: 15000 });
    stage = 'editor_preview_wait_project_title';
    await page.waitForFunction(expected => document.getElementById('currentProjectTitle')?.textContent?.trim() === expected, projectName, { timeout: 15000 });
    stage = 'editor_preview_wait_editor_api';
    await page.waitForFunction(() => typeof setEditorValue === 'function' && typeof updatePreview === 'function' && typeof getEditorValue === 'function', null, { timeout: 15000 });
    const fixture = {
      html: '<main id="codelab-e2e"><button id="probe-increment">Increment</button><output id="probe-count">0</output><label>Name <input id="probe-input" value=""></label><output id="probe-echo"></output></main>',
      css: '#codelab-e2e { color: rgb(1, 2, 3); }',
      js: 'const b=document.getElementById("probe-increment");const c=document.getElementById("probe-count");const i=document.getElementById("probe-input");const e=document.getElementById("probe-echo");if(b&&c)b.addEventListener("click",()=>{c.textContent=String(Number(c.textContent)+1)});if(i&&e)i.addEventListener("input",()=>{e.textContent=i.value});console.log("CODELAB_EDITOR_PREVIEW_READY");'
    };
    stage = 'editor_preview_set_fixture';
    stage = 'editor_preview_set_fixture';
    const editorState = await page.evaluate(code => {
      setEditorValue('html', code.html, { silent: true });
      setEditorValue('css', code.css, { silent: true });
      setEditorValue('js', code.js, { silent: true });
      // Monaco emits content-change events after setValue; let its debounce settle before forcing one stable preview.
      const state = { html: getEditorValue('html'), css: getEditorValue('css'), js: getEditorValue('js') };
      return state;
    }, fixture);
    if (editorState.html !== fixture.html || editorState.css !== fixture.css || editorState.js !== fixture.js) {
      throw new Error('Editor did not retain the complete HTML/CSS/JS fixture: ' + JSON.stringify({
        htmlMatches: editorState.html === fixture.html,
        cssMatches: editorState.css === fixture.css,
        jsMatches: editorState.js === fixture.js
      }));
    }
    stage = 'editor_preview_wait_debounce';
    await page.waitForTimeout(500);
    stage = 'editor_preview_force_stable_refresh';
    await page.evaluate(() => {
      if (typeof previewTimer !== 'undefined' && previewTimer) {
        clearTimeout(previewTimer);
        previewTimer = null;
      }
      updatePreview();
    });
    const previewFrame = page.frameLocator('#previewIframe');
    stage = 'editor_preview_wait_fixture';
    await previewFrame.locator('#probe-increment').waitFor({ state: 'visible', timeout: 15000 });
    stage = 'editor_preview_click_fixture';
    await previewFrame.locator('#probe-increment').click({ timeout: 10000 });
    stage = 'editor_preview_fill_fixture';
    await previewFrame.locator('#probe-input').fill('CodeLab funciona', { timeout: 10000 });
    stage = 'editor_preview_verify_dom';
    const previewRoot = previewFrame.locator('#codelab-e2e');
    await previewRoot.waitFor({ state: 'attached', timeout: 5000 });
    const color = await previewRoot.evaluate(el => window.getComputedStyle(el).color);
    const observed = await previewFrame.locator('body').evaluate(body => ({
      title: document.title || '',
      text: (body.innerText || '').trim().slice(0, 800),
      count: document.getElementById('probe-count')?.textContent || null,
      echo: document.getElementById('probe-echo')?.textContent || null,
      inputValue: document.getElementById('probe-input')?.value || null,
      rootPresent: !!document.getElementById('codelab-e2e')
    }));
    observed.color = color;
    const passed = observed.rootPresent && observed.count === '1' && observed.echo === 'CodeLab funciona' && observed.inputValue === 'CodeLab funciona' && observed.color === 'rgb(1, 2, 3)';
    if (!passed) throw new Error('Editor preview smoke test did not match expected DOM/CSS/interaction results: ' + JSON.stringify(observed));
    result = {
      ok: true,
      projectCreatedInDisposableBrowser: true,
      serverWorkspaceWritesBlocked: true,
      projectName,
      editorToPreview: { html: true, css: true, js: true },
      interactionResults: observed,
      browserDiagnostics,
      message: 'El editor real ejecutó HTML/CSS/JS en su vista previa; el botón, el campo y los estilos respondieron como se esperaba.'
    };
  } else if (command.action === 'preview_diagnostics') {
    stage = 'inspect_preview';
    const frameElement = page.locator('#previewIframe');
    const frameExists = await frameElement.count() > 0;
    const previewFrame = page.frameLocator('#previewIframe');
    let preview = { available: false, reason: 'No se encontró #previewIframe en esta pantalla.' };
    if (frameExists) {
      const src = await frameElement.getAttribute('src');
      if (command.args.self_test === true) {
        // Safe diagnostic probe: only changes this disposable browser session's iframe, never the saved project.
        const probeHtml = '<!doctype html><html><head><title>CodeLab diagnostic probe</title></head><body><main id="codelab-diagnostic-probe"><h1>Preview probe</h1><button id="probe-action">Probe action</button></main><script>console.error("CODELAB_PREVIEW_DIAGNOSTIC_SELF_TEST"); throw new Error("CODELAB_PREVIEW_DIAGNOSTIC_SELF_TEST_PAGEERROR");</script></body></html>';
        await frameElement.evaluate((el, html) => { el.srcdoc = html; }, probeHtml);
        await previewFrame.locator('#codelab-diagnostic-probe').waitFor({ state: 'attached', timeout: 10000 });
        await page.waitForTimeout(300);
      }
      preview = await previewFrame.locator('html').evaluate(() => {
          const body = document.body;
          const elements = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"]')).slice(0, 60).map(el => ({
            tag: el.tagName.toLowerCase(),
            text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 100),
            id: el.id || null,
            type: el.getAttribute('type') || null,
            disabled: Boolean(el.disabled)
          }));
          const tagCounts = {};
          for (const el of Array.from(document.querySelectorAll('*')).slice(0, 5000)) {
            const tag = el.tagName.toLowerCase();
            tagCounts[tag] = (tagCounts[tag] || 0) + 1;
          }
          return {
            available: true,
            readyState: document.readyState,
            title: document.title || '',
            frameUrl: location.href,
            text: (body?.innerText || '').trim().slice(0, 1200),
            elementCount: document.querySelectorAll('*').length,
            tagCounts,
            interactiveElements: elements
          };
      });
      preview.src = src || null;
      preview.frameUrl = safeUrl(preview.frameUrl);
      preview.empty = !preview.title && !preview.text && preview.interactiveElements.length === 0;
      preview.selfTest = command.args.self_test === true;
    }
    result = {
      page: { url: safeUrl(page.url()), title: await page.title(), documentReady: await page.evaluate(() => document.readyState) },
      preview,
      browserDiagnostics
    };
  } else if (command.action === 'preview_interact') {
    stage = 'interact_with_preview';
    const frameElement = page.locator('#previewIframe');
    if (await frameElement.count() === 0) {
      result = { ok: false, reason: 'No se encontró la vista previa en esta pantalla.', steps: [] };
    } else {
      const previewFrame = page.frameLocator('#previewIframe');
      if (command.args.self_test === true) {
        // Disposable fixture only: this replaces srcdoc in the isolated bridge browser, not a saved project.
        const probeHtml = '<!doctype html><html><head><title>CodeLab interaction probe</title></head><body><main><button id="probe-increment">Increment</button><output id="probe-count">0</output><label>Nombre <input id="probe-input" value=""></label><output id="probe-echo"></output></main><script>const b=document.getElementById("probe-increment");const c=document.getElementById("probe-count");const i=document.getElementById("probe-input");const e=document.getElementById("probe-echo");b.addEventListener("click",()=>{c.textContent=String(Number(c.textContent)+1)});i.addEventListener("input",()=>{e.textContent=i.value});console.log("CODELAB_PREVIEW_INTERACTION_READY");</script></body></html>';
        await frameElement.evaluate((el, html) => {
          const probe = document.createElement('iframe');
          probe.id = 'previewIframe';
          probe.setAttribute('sandbox', 'allow-scripts allow-forms');
          probe.style.cssText = 'position:fixed;left:12px;bottom:12px;width:640px;height:360px;z-index:2147483000;background:white;border:2px solid #64748b';
          probe.srcdoc = html;
          el.remove();
          document.body.appendChild(probe);
        }, probeHtml);
        await previewFrame.locator('#probe-increment').waitFor({ state: 'attached', timeout: 10000 });
      }
      const isVisible = await frameElement.isVisible();
      if (!isVisible && command.args.self_test !== true) {
        result = { ok: false, reason: 'La vista previa está presente pero oculta; abre un proyecto web en el editor antes de interactuar.', steps: [] };
      } else {
        const steps = [];
        for (let index = 0; index < command.args.steps.length; index += 1) {
          currentStep = index + 1;
          const step = command.args.steps[index];
          const locator = previewFrame.locator(step.selector).first();
          if (await locator.count() === 0) throw new Error('Preview step ' + (index + 1) + ': selector did not match an element inside #previewIframe.');
          if (step.action === 'click') {
            const tag = await locator.evaluate(el => el.tagName.toLowerCase());
            if (tag === 'a') {
              const href = await locator.getAttribute('href') || '';
              if (href && !href.startsWith('#')) throw new Error('Preview anchor navigation is blocked; only in-page hash links may be clicked.');
            }
            await locator.click({ timeout: 10000 });
          } else if (step.action === 'fill') {
            await locator.fill(step.value, { timeout: 10000 });
          } else if (step.action === 'select') {
            await locator.selectOption(step.value, { timeout: 10000 });
          }
          const observed = await locator.evaluate(el => ({
            tag: el.tagName.toLowerCase(),
            text: (el.innerText || el.textContent || '').trim().slice(0, 300),
            value: ('value' in el) ? String(el.value).slice(0, 300) : null,
            disabled: Boolean(el.disabled)
          })).catch(() => null);
          steps.push({ step: index + 1, action: step.action, selector: step.selector, succeeded: true, observed });
        }
        currentStep = null;
        result = {
          ok: true,
          previewTitle: await previewFrame.locator('html').evaluate(() => document.title || ''),
          text: await previewFrame.locator('body').innerText({ timeout: 5000 }).then(value => value.slice(0, 1200)),
          steps,
          selfTest: command.args.self_test === true,
          browserDiagnostics
        };
      }
    }
  } else if (command.action === 'read_page') {
    result = {
      url: page.url(),
      title: await page.title(),
      documentReady: await page.evaluate(() => document.readyState),
      text: (await page.locator('body').innerText({ timeout: 10000 })).slice(0, 2500)
    };
  } else if (command.action === 'list_controls') {
    result = await page.locator('button,a,input,textarea,select,summary,[role="button"],[onclick],[data-action],[tabindex]:not([tabindex="-1"]),[contenteditable="true"]').evaluateAll((els, includeText) =>
      els.filter(el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      }).slice(0, 150).map(el => ({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role'),
        text: includeText ? (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '').trim().replace(/\\s+/g, ' ').slice(0, 120) : null,
        id: el.id || null,
        type: el.getAttribute('type'),
        name: el.getAttribute('name'),
        title: el.getAttribute('title'),
        ariaLabel: el.getAttribute('aria-label'),
        dataAction: el.getAttribute('data-action'),
        href: el.getAttribute('href'),
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
      result = { ...result, readableUiScreenshotCaptured: true };
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
