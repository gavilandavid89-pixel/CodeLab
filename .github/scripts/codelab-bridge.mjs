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
  const allowed = new Set(['status', 'read_page', 'list_controls', 'connections_status', 'ai_ping', 'preview_diagnostics', 'preview_interact', 'preview_editor_smoke_test', 'click', 'read_element', 'fill', 'select', 'sequence', 'project_list', 'project_rename', 'project_save', 'branch_status', 'branch_resume', 'branch_save', 'workspace_inspect', 'project_inspect', 'project_code_read', 'design_read']);
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
  const projectActions = ['project_list', 'project_rename', 'project_save', 'branch_status', 'branch_resume', 'branch_save', 'workspace_inspect', 'project_inspect', 'project_code_read', 'design_read'];
  if (projectActions.includes(command.action) && command.use_admin_session !== true) {
    throw new Error('Project and branch tools require use_admin_session: true.');
  }
  if (['project_rename', 'project_save', 'branch_status', 'branch_resume', 'branch_save', 'project_inspect', 'project_code_read', 'design_read'].includes(command.action) &&
      (typeof args.project_id !== 'string' || !/^proj_[a-zA-Z0-9_-]{1,100}$/.test(args.project_id))) {
    throw new Error('This project action requires a valid args.project_id.');
  }
  if (command.action === 'project_rename' &&
      (typeof args.name !== 'string' || !args.name.trim() || args.name.trim().length > 200)) {
    throw new Error('project_rename requires args.name between 1 and 200 characters.');
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

  if (command.action === 'workspace_inspect') {
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
      const localVerified = Array.isArray(snapshot) && snapshot.some(item =>
        item && item.id === projectId && item.name === projectAfter?.name
      );
      return { projectId, saved: saved === true, localSnapshotVerified: localVerified, branchPresent: !!projectAfter?.branch };
    }, command.args.project_id);
    if (!result.saved && !result.localSnapshotVerified) throw new Error('Save could not be verified on server or local snapshot.');
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
