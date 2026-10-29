// ==========================================
// CodeLab XD Studio Pro v2.5.0
// Persistencia segura, ramas, merge 3 vías, plantillas IA locales
// ==========================================
const APP_VERSION = '2.6.0';
const STORAGE_KEY_PROJECTS = 'codelab_xd_projects_v2';
const STORAGE_KEY_AUTH = 'codelab_xd_auth_v2';
const STORAGE_KEY_WORKSPACE = 'codelab_xd_workspace_v4';
const STORAGE_KEY_WORKSPACE_TOKEN = 'codelab_xd_workspace_token_v1';
const STORAGE_KEY_AI = 'codelab_xd_ai_settings_v1';
const AUTOSAVE_DEBOUNCE_MS = 600;
const PREVIEW_DEBOUNCE_MS = 250;
const RECONNECT_INTERVAL_MS = 15000;
const MAX_CONSOLE_LINES = 200;

let workspaceId = null;
let workspaceToken = '';
let workspaceRevision = 0;
let serverSyncError = false;
let projects = [];
let currentProjectId = null;
let currentUser = null;
let aiSettings = { mode: 'auto', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '' };
let serverAi = { serverKey: false, model: 'gpt-4o-mini', baseUrl: null, hint: '' };
let pendingAuthProvider = null;
let oauthConfig = { github: false, google: false, demoFallback: true };
let mobileStudioMode = 'code';
let editors = {};
let editorInitGeneration = 0;
let activeTab = 'html';
let isCopyBranchCreated = false;
let inCopyBranch = false;
let logsCount = 0;
let useMonaco = true;
let copyProjectCode = { html: '', css: '', js: '' };
let copyBaseCode = null;
let copyBranchId = null;
let serverReady = false;
let suppressEditorAutosave = false;
let aiRequestGeneration = 0;
let pendingConflict = null;
let autosaveTimer = null;
let previewTimer = null;
let syncGeneration = 0;
let syncRunning = false;
let syncWaiters = [];
let syncRetryTimer = null;
let syncRetryAttempt = 0;
const SYNC_RETRY_DELAYS_MS = [2000, 5000, 15000];
let reconnectTimer = null;


// ---------- Safe localStorage ----------
function lsGet(key) {
  try { return localStorage.getItem(key); } catch (_) { return null; }
}
function lsSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    console.warn('localStorage set failed', key, e);
    if (typeof showToast === 'function') {
      showToast('Almacenamiento local lleno o bloqueado. Los cambios pueden no persistir offline.', 'warn');
    }
    return false;
  }
}
function lsRemove(key) {
  try { localStorage.removeItem(key); } catch (_) {}
}
function deepClone(obj) {
  try {
    if (typeof structuredClone === 'function') return structuredClone(obj);
  } catch (_) {}
  return JSON.parse(JSON.stringify(obj));
}

/** Always returns { html, css, js } as strings — never null/undefined. */
function normalizeCode(code) {
  const c = code && typeof code === 'object' ? code : {};
  return {
    html: typeof c.html === 'string' ? c.html : '',
    css: typeof c.css === 'string' ? c.css : '',
    js: typeof c.js === 'string' ? c.js : ''
  };
}

function showBootLoading(show, title, subtitle) {
  const modal = document.getElementById('syncLoadingModal');
  if (!modal) return;
  if (show) {
    const h = modal.querySelector('h3');
    const p = modal.querySelector('p');
    if (h) h.textContent = title || 'Cargando workspace…';
    if (p) p.textContent = subtitle || 'Sincronizando proyectos con el servidor.';
    modal.classList.remove('hidden');
  } else {
    modal.classList.add('hidden');
  }
}

const defaultTemplate = {
  html: `<div class="card">\n  <h2>CodeLab XD Studio Pro</h2>\n  <p>Edita tu HTML, CSS y JS con persistencia automática.</p>\n  <button id="demoBtn">Probar Interacción</button>\n</div>`,
  css: `body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }\n.card { background: #1e293b; padding: 2.5rem; border-radius: 1rem; text-align: center; border: 1px solid #334155; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5); }\nh2 { margin-top: 0; color: #38bdf8; }\nbutton { background: #06b6d4; color: #fff; border: none; padding: 0.75rem 1.5rem; border-radius: 0.5rem; font-weight: 600; cursor: pointer; transition: all 0.2s; margin-top: 1rem; }\nbutton:hover { background: #0891b2; transform: translateY(-2px); }`,
  js: `document.getElementById('demoBtn').addEventListener('click', () => {\n  console.log('¡Acción ejecutada correctamente!');\n  alert('¡Proyecto guardado y sincronizado correctamente!');\n});`
};

// ---------- Status badge ----------
function setSyncStatus(state, text) {
  const badge = document.getElementById('statusBadge');
  const statusText = document.getElementById('statusText');
  const dot = badge ? badge.querySelector('span.w-2') : null;
  if (!badge || !statusText) return;
  const styles = {
    synced: { badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20', dot: 'bg-emerald-500' },
    saving: { badge: 'bg-amber-500/10 text-amber-300 border-amber-500/20', dot: 'bg-amber-400' },
    offline: { badge: 'bg-slate-700/40 text-slate-400 border-slate-600', dot: 'bg-slate-500' },
    conflict: { badge: 'bg-red-500/10 text-red-400 border-red-500/30', dot: 'bg-red-500' },
    branch: { badge: 'bg-amber-500/10 text-amber-300 border-amber-500/20', dot: 'bg-amber-400' }
  };
  const s = styles[state] || styles.synced;
  badge.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ' + s.badge;
  if (dot) dot.className = 'w-2 h-2 rounded-full ' + s.dot + (state === 'synced' || state === 'saving' ? ' pulse-dot' : '');
  statusText.innerText = text;
}

// ---------- Boot ----------
window.addEventListener('DOMContentLoaded', () => {
  workspaceId = lsGet(STORAGE_KEY_WORKSPACE);
  workspaceToken = lsGet(STORAGE_KEY_WORKSPACE_TOKEN) || '';
  loadAiSettings();
  setSyncStatus('saving', 'Conectando…');
  showBootLoading(true, 'Iniciando CodeLab…', 'Conectando con el workspace y cargando proyectos.');
  handleAuthQueryParams();
  loadAuthFromServer()
    .catch(() => loadAuthFromStorage())
    .then(() => Promise.all([loadProjectsFromStorage(), loadServerAiStatus()]))
    .then(() => {
      // Let optional workspace tools (e.g. design tokens) load their account-backed
      // settings only after auth has resolved the correct workspace credentials.
      window.codelabWorkspaceReady = true;
      window.dispatchEvent(new Event('codelab-workspace-ready'));
      renderProjectsList();
      updateDashboardStatus();
      updateAiUI();
      startReconnectLoop();
      setupSplitResize();
      setupKeyboardShortcuts();
      setupNewProjectModalKeys();
      const pg = document.getElementById('projectsGrid');
      if (pg && !pg._codelabBound) {
        pg._codelabBound = true;
        pg.addEventListener('click', onProjectsGridClick);
      }
      updateOauthDemoBanner();
      maybeOfferLocalImport();
    })
    .finally(() => {
      showBootLoading(false);
    });
});

window.addEventListener('beforeunload', () => {
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
  try {
    if (currentProjectId) {
      const code = {
        html: getEditorValue('html'),
        css: getEditorValue('css'),
        js: getEditorValue('js')
      };
      if (inCopyBranch) {
        copyProjectCode = deepClone(code);
        const proj = getCurrentProject();
        if (proj && isCopyBranchCreated) {
          proj.branch = {
            id: copyBranchId || 'branch_' + Date.now(),
            baseCode: deepClone(copyBaseCode),
            code: deepClone(copyProjectCode),
            baseMainUpdatedAt: (proj.branch && proj.branch.baseMainUpdatedAt) || proj.updatedAt,
            updatedAt: new Date().toISOString()
          };
        }
      } else {
        const proj = projects.find(p => p.id === currentProjectId);
        if (proj) {
          proj.code = code;
          proj.updatedAt = new Date().toISOString();
        }
      }
    }
    lsSet(STORAGE_KEY_PROJECTS, JSON.stringify(projects));
  } catch (_) {}
});

async function loadProjectsFromStorage() {
  setSyncStatus('saving', 'Conectando…');
  try {
    const init = await fetch('/api/workspace/init', {
      method: 'POST',
      credentials: 'same-origin',
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        workspaceToken ? { 'x-workspace-token': workspaceToken } : {}
      ),
      body: JSON.stringify({ id: workspaceId || null })
    });
    if (!init.ok) throw new Error('workspace_init_failed');
    const boot = await init.json();
    workspaceId = boot.workspaceId;
    workspaceToken = boot.token;
    lsSet(STORAGE_KEY_WORKSPACE, workspaceId);
    lsSet(STORAGE_KEY_WORKSPACE_TOKEN, workspaceToken);
    const data = boot.state || { projects: [], revision: 0 };
    const serverProjects = Array.isArray(data.projects) ? data.projects : [];
    let localProjects = [];
    const stored = lsGet(STORAGE_KEY_PROJECTS);
    if (stored) {
      try { localProjects = JSON.parse(stored); } catch (_) { localProjects = []; }
    }
    projects = serverProjects.length ? serverProjects : localProjects;
    workspaceRevision = Number.isInteger(data.revision) ? data.revision : 0;
    serverReady = true;
    setSyncStatus('synced', 'Sincronizado');
  } catch (e) {
    serverReady = false;
    console.warn('Servidor no disponible; usando copia local.', e);
    const stored = lsGet(STORAGE_KEY_PROJECTS);
    if (stored) {
      try { projects = JSON.parse(stored); } catch (_) { projects = []; }
    }
    setSyncStatus('offline', 'Solo local');
  }
  // Normalize every project code shape
  projects = projects.map(p => {
    if (!p || typeof p !== 'object') return null;
    return {
      ...p,
      id: typeof p.id === 'string' ? p.id : 'proj_' + Date.now(),
      name: typeof p.name === 'string' && p.name.trim() ? p.name : 'Sin título',
      type: p.type === 'design' ? 'design' : 'web',
      design: p.design && typeof p.design === 'object' ? { ...p.design, elements: Array.isArray(p.design.elements) ? p.design.elements : [], frame: p.design.frame || 'desktop', background: p.design.background || '#ffffff' } : (p.type === 'design' ? { elements: [], frame: 'desktop', background: '#ffffff' } : undefined),
      updatedAt: p.updatedAt || new Date().toISOString(),
      code: normalizeCode(p.code),
      branch: p.branch && typeof p.branch === 'object'
        ? {
            ...p.branch,
            code: normalizeCode(p.branch.code),
            baseCode: normalizeCode(p.branch.baseCode)
          }
        : undefined,
      mergeHistory: Array.isArray(p.mergeHistory) ? p.mergeHistory : undefined
    };
  }).filter(Boolean);

  if (projects.length === 0) {
    projects.push({
      id: 'proj_' + (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now()),
      name: 'Mi Primer Proyecto',
      updatedAt: new Date().toISOString(),
      code: normalizeCode(defaultTemplate)
    });
  }
  if (serverReady) await persistWorkspace();
  else lsSet(STORAGE_KEY_PROJECTS, JSON.stringify(projects));
}

function persistWorkspace() {
  lsSet(STORAGE_KEY_PROJECTS, JSON.stringify(projects));
  // Do not cancel a scheduled retry while a previous request is still in flight:
  // runWorkspaceSync() may be unable to start a newer save until that request settles.
  if (syncRetryTimer && !syncRunning) {
    clearTimeout(syncRetryTimer);
    syncRetryTimer = null;
  }
  if (!serverReady) {
    setSyncStatus('offline', 'Solo local');
    return Promise.resolve(false);
  }
  syncGeneration++;
  const target = syncGeneration;
  setSyncStatus('saving', 'Guardando…');
  return new Promise(resolve => {
    syncWaiters.push({ target, resolve });
    runWorkspaceSync();
  });
}

async function runWorkspaceSync() {
  if (syncRunning || !serverReady) return;
  syncRunning = true;
  try {
    while (syncGeneration > 0) {
      const generationAtStart = syncGeneration;
      const snapshot = JSON.parse(JSON.stringify(projects));
      const revisionAtStart = workspaceRevision;
      try {
        const r = await fetch('/api/workspace/' + encodeURIComponent(workspaceId), {
          method: 'PUT',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            'x-workspace-token': workspaceToken
          },
          body: JSON.stringify({ baseRevision: revisionAtStart, projects: snapshot })
        });
        if (r.status === 409) {
          const data = await r.json();
          serverSyncError = true;
          syncGeneration = 0;
          setSyncStatus('conflict', 'Conflicto');
          resolveSyncWaiters(false, generationAtStart);
          showConflictModal(data);
          break;
        }
        if (r.status === 429) {
          syncGeneration = 0;
          resolveSyncWaiters(false, generationAtStart);
          setSyncStatus('offline', 'Reintento pendiente');
          if (!syncRetryTimer) {
            const delay = SYNC_RETRY_DELAYS_MS[Math.min(syncRetryAttempt, SYNC_RETRY_DELAYS_MS.length - 1)];
            syncRetryAttempt = Math.min(syncRetryAttempt + 1, SYNC_RETRY_DELAYS_MS.length - 1);
            showToast('Límite de peticiones alcanzado. Se reintentará el guardado automáticamente.', 'warn');
            const retryWorkspaceSync = () => {
              syncRetryTimer = null;
              if (!serverReady) return;
              // A newer save may still be settling; don't lose the retry by starting
              // while runWorkspaceSync() is locked.
              if (syncRunning) {
                syncRetryTimer = setTimeout(retryWorkspaceSync, 1000);
                return;
              }
              persistWorkspace();
            };
            syncRetryTimer = setTimeout(retryWorkspaceSync, delay);
          }
          break;
        }
        if (!r.ok) throw new Error('workspace_save_failed');
        const data = await r.json();
        workspaceRevision = data.revision;
        syncRetryAttempt = 0;
        serverSyncError = false;
        resolveSyncWaiters(true, generationAtStart);
        setSyncStatus(inCopyBranch ? 'branch' : 'synced', inCopyBranch ? 'Copia · Guardada' : 'Sincronizado');
        if (syncGeneration === generationAtStart) break;
      } catch (e) {
        serverReady = false;
        syncGeneration = 0;
        resolveSyncWaiters(false, generationAtStart);
        console.warn('No se pudo sincronizar con el servidor.', e);
        setSyncStatus('offline', 'Solo local');
        showToast('Guardado local activo; el servidor no está disponible.', 'warn');
        break;
      }
    }
  } finally {
    syncRunning = false;
  }
}

function resolveSyncWaiters(completed, generation) {
  const remaining = [];
  for (const waiter of syncWaiters) {
    if (waiter.target <= generation) waiter.resolve(completed);
    else remaining.push(waiter);
  }
  syncWaiters = remaining;
}

function saveProjectsToStorage() {
  persistWorkspace();
}

async function refreshWorkspaceFromServer() {
  if (!serverReady) return false;
  try {
    const r = await fetch('/api/workspace/' + encodeURIComponent(workspaceId), {
      credentials: 'same-origin',
      headers: { 'x-workspace-token': workspaceToken }
    });
    if (!r.ok) return false;
    const data = await r.json();
    projects = Array.isArray(data.projects) ? data.projects : [];
    workspaceRevision = Number.isInteger(data.revision) ? data.revision : 0;
    lsSet(STORAGE_KEY_PROJECTS, JSON.stringify(projects));
    return true;
  } catch (_) {
    return false;
  }
}

// ---------- Conflict resolution ----------
function showConflictModal(serverData) {
  pendingConflict = serverData;
  const modal = document.getElementById('conflictModal');
  if (modal) {
    const info = document.getElementById('conflictInfo');
    if (info) {
      info.textContent =
        'El servidor tiene la revisión ' +
        (serverData.revision || '?') +
        ' (actualizada ' +
        (serverData.updatedAt ? new Date(serverData.updatedAt).toLocaleString() : '—') +
        '). Tu copia local no se ha perdido.';
    }
    modal.classList.remove('hidden');
  } else {
    showToast('Hay cambios nuevos en el servidor. Recarga para evitar perder trabajo.', 'warn');
  }
}

function closeConflictModal() {
  const modal = document.getElementById('conflictModal');
  if (modal) modal.classList.add('hidden');
}

function conflictTakeServer() {
  if (!pendingConflict) return;
  projects = Array.isArray(pendingConflict.projects) ? pendingConflict.projects : [];
  workspaceRevision = Number.isInteger(pendingConflict.revision) ? pendingConflict.revision : 0;
  lsSet(STORAGE_KEY_PROJECTS, JSON.stringify(projects));
  pendingConflict = null;
  closeConflictModal();
  serverSyncError = false;
  setSyncStatus('synced', 'Sincronizado');
  if (currentProjectId) {
    const proj = projects.find(p => p.id === currentProjectId);
    if (proj) {
      inCopyBranch = false;
      isCopyBranchCreated = loadBranchFromProject(proj);
      if (isCopyBranchCreated) {
        copyProjectCode = JSON.parse(JSON.stringify(proj.branch.code));
        copyBaseCode = JSON.parse(JSON.stringify(proj.branch.baseCode));
      }
      setEditorValue('html', proj.code.html, { silent: true });
      setEditorValue('css', proj.code.css, { silent: true });
      setEditorValue('js', proj.code.js, { silent: true });
      updatePreview();
      updateBranchButtons();
    } else {
      returnToDashboard();
    }
  }
  renderProjectsList();
  showToast('Se cargó la versión del servidor.');
}

function conflictKeepLocal() {
  if (!pendingConflict) return;
  // Preserve server version as a backup project before overwriting (C5)
  const serverProjects = Array.isArray(pendingConflict.projects) ? pendingConflict.projects : [];
  if (serverProjects.length) {
    const stamp = new Date().toLocaleString();
    serverProjects.forEach(sp => {
      const already = projects.some(
        p => p.name && p.name.indexOf('(servidor ') !== -1 && p.id === 'srv_bak_' + (sp.id || '')
      );
      if (already) return;
      projects.unshift({
        id: 'srv_bak_' + (sp.id || Date.now()) + '_' + Date.now().toString(36),
        name: (sp.name || 'Proyecto') + ' (servidor ' + stamp + ')',
        updatedAt: sp.updatedAt || new Date().toISOString(),
        code: cloneCode(sp.code),
        branch: sp.branch ? deepClone(sp.branch) : undefined,
        mergeHistory: Array.isArray(sp.mergeHistory) ? deepClone(sp.mergeHistory) : undefined
      });
    });
    showToast('Se guardó una copia de respaldo de la versión del servidor en el dashboard.');
  }
  workspaceRevision = Number.isInteger(pendingConflict.revision)
    ? pendingConflict.revision
    : workspaceRevision;
  pendingConflict = null;
  closeConflictModal();
  serverSyncError = false;
  persistWorkspace().then(ok => {
    if (ok) {
      showToast('Tu versión local se guardó en el servidor.');
      renderProjectsList();
    } else {
      showToast('No se pudo forzar el guardado. Revisa la conexión.', 'warn');
    }
  });
}

// ---------- Projects UI ----------
function renderProjectsList() {
  const grid = document.getElementById('projectsGrid');
  const countEl = document.getElementById('projectCount');
  if (!grid) return;
  const search = ((document.getElementById('searchProjectInput') || {}).value || '').toLowerCase().trim();
  const filtered = search
    ? projects.filter(p => (p.name || '').toLowerCase().includes(search))
    : projects;
  if (countEl) countEl.textContent = String(projects.length);

  const frag = document.createDocumentFragment();
  for (let i = 0; i < filtered.length; i++) {
    const p = filtered[i];
    const card = document.createElement('div');
    card.className =
      'bg-slate-900 border border-slate-800 hover:border-cyan-500/50 rounded-2xl p-4 sm:p-5 shadow-xl transition-all hover:-translate-y-0.5 flex flex-col justify-between gap-3 group';
    let dateStr = '';
    try {
      const d = new Date(p.updatedAt);
      if (!isNaN(d.getTime())) {
        dateStr =
          d.toLocaleDateString() +
          ' ' +
          d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
    } catch (_) {}
    const hasBranch = !!(p.branch && p.branch.id);
    const idAttr = escapeAttr(p.id);
    const nameHtml = escapeHtml(p.name || 'Sin título');
    card.innerHTML =
      '<div class="space-y-2">' +
      '<div class="flex items-center justify-between gap-2">' +
      '<span class="text-[10px] px-2 py-0.5 rounded-full ' + (p.type === 'design' ? 'bg-violet-500/10 text-violet-300 border-violet-500/20' : 'bg-cyan-500/10 text-cyan-300 border-cyan-500/20') + ' font-mono border">' + (p.type === 'design' ? 'DISEÑO · PROTOTIPO' : 'HTML / CSS / JS') + '</span>' +
      (hasBranch
        ? '<span class="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/20">Rama</span>'
        : '') +
      '<button type="button" data-action="delete" data-id="' +
      idAttr +
      '" class="text-slate-600 hover:text-red-400 p-2 touch-target transition" title="Eliminar" aria-label="Eliminar proyecto">' +
      '<i class="fa-solid fa-trash-can text-xs" aria-hidden="true"></i></button></div>' +
      '<h4 class="font-bold text-slate-100 text-base group-hover:text-cyan-400 transition line-clamp-1">' +
      nameHtml +
      '</h4>' +
      '<p class="text-xs text-slate-500 flex items-center gap-1.5"><i class="fa-regular fa-clock" aria-hidden="true"></i> ' +
      escapeHtml(dateStr || '—') +
      '</p></div>' +
      '<div class="flex items-center gap-2 pt-2 border-t border-slate-800/80">' +
      '<button type="button" data-action="open" data-id="' +
      idAttr +
      '" class="flex-1 py-2.5 bg-slate-800 hover:bg-cyan-600 text-slate-200 hover:text-white font-semibold text-xs rounded-xl border border-slate-700 hover:border-cyan-500 transition flex items-center justify-center gap-2 touch-target">' +
      '<i class="fa-solid fa-pen-to-square" aria-hidden="true"></i> Abrir</button>' +
      '<button type="button" data-action="dup" data-id="' +
      idAttr +
      '" class="p-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl border border-slate-700 text-xs touch-target" title="Duplicar" aria-label="Duplicar proyecto">' +
      '<i class="fa-solid fa-clone" aria-hidden="true"></i></button></div>';
    frag.appendChild(card);
  }
  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'col-span-full text-center text-slate-500 text-sm py-10 px-4';
    empty.setAttribute('role', 'status');
    empty.textContent = search
      ? 'Ningún proyecto coincide con «' + search + '».'
      : 'No hay proyectos todavía. Crea el primero.';
    frag.appendChild(empty);
  }
  grid.replaceChildren(frag);
}

function onProjectsGridClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn || !btn.dataset) return;
  const id = btn.dataset.id;
  const action = btn.dataset.action;
  if (!id || !action) return;
  if (action === 'open') openProject(id);
  else if (action === 'delete') deleteProject(id, e);
  else if (action === 'dup') duplicateProjectFromDashboard(id, e);
}


function escapeAttr(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function openNewProjectModal() {
  document.getElementById('newProjectNameInput').value = '';
  document.getElementById('newProjectModal').classList.remove('hidden');
}

function closeNewProjectModal() {
  document.getElementById('newProjectModal').classList.add('hidden');
}

function createNewProjectConfirm() {
  const name = document.getElementById('newProjectNameInput').value.trim() || 'Proyecto sin título';
  const selectedType = document.querySelector('input[name="newProjectType"]:checked');
  const type = selectedType && selectedType.value === 'design' ? 'design' : 'web';
  const newProj = {
    id: 'proj_' + crypto.randomUUID(),
    name: name,
    type,
    updatedAt: new Date().toISOString(),
    code: { ...defaultTemplate },
    ...(type === 'design' ? { design: { elements: [], frame: 'desktop', background: '#ffffff', grid: true } } : {})
  };
  projects.unshift(newProj);
  saveProjectsToStorage();
  closeNewProjectModal();
  renderProjectsList();
  openProject(newProj.id);
  showToast('Proyecto "' + name + '" creado.');
}

function deleteProject(id, e) {
  if (e) e.stopPropagation();
  if (!confirm('¿Eliminar este proyecto permanentemente?')) return;
  projects = projects.filter(p => p.id !== id);
  if (currentProjectId === id) {
    currentProjectId = null;
    inCopyBranch = false;
    isCopyBranchCreated = false;
  }
  saveProjectsToStorage();
  renderProjectsList();
  showToast('Proyecto eliminado.');
}

function duplicateProjectFromDashboard(id, e) {
  if (e) e.stopPropagation();
  const orig = projects.find(p => p.id === id);
  if (!orig) return;
  const dup = {
    id: 'proj_' + crypto.randomUUID(),
    name: orig.name + ' (Copia)',
    type: orig.type === 'design' ? 'design' : 'web',
    updatedAt: new Date().toISOString(),
    code: JSON.parse(JSON.stringify(orig.code)),
    ...(orig.design ? { design: JSON.parse(JSON.stringify(orig.design)) } : {})
  };
  projects.unshift(dup);
  saveProjectsToStorage();
  renderProjectsList();
  showToast('Copia del proyecto creada.');
}

function openProject(id) {
  const proj = projects.find(p => p.id === id);
  if (!proj) {
    showToast('Proyecto no encontrado.', 'warn');
    return;
  }
  // Flush pending save of previous project if any
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
    if (currentProjectId && currentProjectId !== id) {
      try { saveCurrentCodeToActiveProject(true); } catch (_) {}
    }
  }
  currentProjectId = id;
  aiRequestGeneration++;
  inCopyBranch = false;
  isCopyBranchCreated = loadBranchFromProject(proj);
  if (isCopyBranchCreated) {
    copyProjectCode = normalizeCode(proj.branch && proj.branch.code);
    copyBaseCode = normalizeCode(proj.branch && proj.branch.baseCode);
  } else {
    copyProjectCode = { html: '', css: '', js: '' };
    copyBaseCode = null;
    copyBranchId = null;
  }
  proj.code = normalizeCode(proj.code);
  const titleEl = document.getElementById('currentProjectTitle');
  if (titleEl) titleEl.innerText = proj.name;
  updateBranchButtons();
  const banner = document.getElementById('copyAlertBanner');
  if (banner) banner.classList.add('hidden');
  document.getElementById('welcomeDashboard').classList.add('hidden');
  document.getElementById('studioView').classList.remove('hidden');
  const isDesignProject = proj.type === 'design';
  document.getElementById('editorPanel').classList.toggle('hidden', isDesignProject);
  document.getElementById('splitDivider').classList.toggle('hidden', isDesignProject);
  document.getElementById('previewPanel').classList.toggle('hidden', isDesignProject);
  document.getElementById('designStudioPanel').classList.toggle('hidden', !isDesignProject);
  document.getElementById('designStudioPanel').classList.toggle('flex', isDesignProject);
  document.getElementById('mainSplit').classList.toggle('md:flex-row', !isDesignProject);
  document.getElementById('mainSplit').classList.toggle('flex-col', isDesignProject);
  const mobileBar = document.getElementById('mobileBottomBar');
  if (mobileBar) mobileBar.classList.toggle('hidden', isDesignProject);
  const desktopActions = document.getElementById('desktopProjectActions');
  const mobileActions = document.getElementById('mobileProjectActions');
  if (desktopActions) desktopActions.classList.toggle('hidden', isDesignProject);
  if (mobileActions) mobileActions.classList.toggle('hidden', isDesignProject);
  setMobileStudioMode('code');
  // Layout after studio is visible
  requestAnimationFrame(() => {
    if (isDesignProject) {
      initializeDesignProject(proj);
    } else {
      initMonacoOrFallback(proj.code);
      switchTab(activeTab || 'html');
    }
  });
  setSyncStatus(serverReady ? 'synced' : 'offline', serverReady ? 'Sincronizado' : 'Solo local');
}

async function returnToDashboard() {
  aiRequestGeneration++;
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
  try {
    if (inCopyBranch) await saveInCopyBranch();
    else saveCurrentCodeToActiveProject(true);
  } catch (e) {
    console.warn('Error guardando al salir', e);
  }
  document.getElementById('studioView').classList.add('hidden');
  document.getElementById('welcomeDashboard').classList.remove('hidden');
  renderProjectsList();
}

function saveCurrentCodeToActiveProject(immediate) {
  if (!currentProjectId) return;
  const active = projects.find(p => p.id === currentProjectId);
  if (active && active.type === 'design') {
    active.updatedAt = new Date().toISOString();
    if (immediate) saveProjectsToStorage();
    else scheduleAutosave();
    return;
  }
  const code = normalizeCode({
    html: getEditorValue('html'),
    css: getEditorValue('css'),
    js: getEditorValue('js')
  });
  if (inCopyBranch) {
    copyProjectCode = JSON.parse(JSON.stringify(code));
    persistBranch();
    return;
  }
  const proj = projects.find(p => p.id === currentProjectId);
  if (proj) {
    proj.code = code;
    proj.updatedAt = new Date().toISOString();
    if (immediate) saveProjectsToStorage();
    else scheduleAutosave();
  }
}

function scheduleAutosave() {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  setSyncStatus('saving', 'Pendiente…');
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    saveProjectsToStorage();
  }, AUTOSAVE_DEBOUNCE_MS);
}

function editCurrentProjectName() {
  const proj = projects.find(p => p.id === currentProjectId);
  if (!proj) return;
  const newName = prompt('Nuevo nombre del proyecto:', proj.name);
  if (newName && newName.trim()) {
    proj.name = newName.trim();
    document.getElementById('currentProjectTitle').innerText = proj.name;
    saveProjectsToStorage();
    showToast('Nombre actualizado.');
  }
}

// ---------- Auth (OAuth + demo fallback) ----------
function handleAuthQueryParams() {
  try {
    const params = new URLSearchParams(window.location.search);
    const auth = params.get('auth');
    if (!auth) return;
    if (auth === 'ok') {
      showToast('Sesión iniciada con ' + (params.get('provider') || 'OAuth') + '.');
    } else if (auth === 'error') {
      showToast('No se pudo iniciar sesión (' + (params.get('reason') || 'error') + ').', 'error');
    }
    // Clean URL without reload
    const url = new URL(window.location.href);
    url.searchParams.delete('auth');
    url.searchParams.delete('provider');
    url.searchParams.delete('reason');
    window.history.replaceState({}, '', url.pathname + url.search);
  } catch (_) {}
}

async function loadAuthFromServer() {
  try {
    const r = await fetch('/api/auth/status', { credentials: 'same-origin' });
    if (!r.ok) throw new Error('auth_status_failed');
    const data = await r.json();
    oauthConfig = {
      github: !!(data.oauth && data.oauth.github),
      google: !!(data.oauth && data.oauth.google),
      demoFallback: !!data.demoFallback
    };
    if (data.user) {
      currentUser = {
        id: data.user.id,
        provider: data.user.provider,
        name: data.user.name,
        email: data.user.email || null,
        avatar: data.user.avatar || null,
        real: true
      };
      lsSet(STORAGE_KEY_AUTH, JSON.stringify(currentUser));
      // Prefer server-bound workspace for logged-in users
      if (data.workspaceId) {
        workspaceId = data.workspaceId;
        lsSet(STORAGE_KEY_WORKSPACE, workspaceId);
      }
    } else {
      // Keep local demo profile only if no real session
      loadAuthFromStorage();
      if (currentUser && currentUser.real) {
        currentUser = null;
        lsRemove(STORAGE_KEY_AUTH);
      }
    }
    updateAuthUI();
    return data;
  } catch (e) {
    oauthConfig = { github: false, google: false, demoFallback: true };
    loadAuthFromStorage();
    updateAuthUI();
    throw e;
  }
}

function loadAuthFromStorage() {
  const auth = lsGet(STORAGE_KEY_AUTH);
  if (auth) {
    try {
      currentUser = JSON.parse(auth);
      updateAuthUI();
    } catch (e) {}
  }
}

function openAuthModal(provider) {
  provider = provider === 'google' ? 'google' : 'github';
  // Real OAuth redirect when configured
  if (provider === 'github' && oauthConfig.github) {
    window.location.href = '/api/auth/github';
    return;
  }
  if (provider === 'google' && oauthConfig.google) {
    window.location.href = '/api/auth/google';
    return;
  }
  // Demo fallback when OAuth env vars not set
  pendingAuthProvider = provider;
  const modal = document.getElementById('authModal');
  const title = document.getElementById('authModalTitle');
  const icon = document.getElementById('authModalIcon');
  const input = document.getElementById('authUsernameInput');
  const hint = document.getElementById('authModalHint');
  if (title) title.textContent = provider === 'github' ? 'GitHub (modo demo)' : 'Google (modo demo)';
  if (icon) {
    icon.className = provider === 'github' ? 'fa-brands fa-github' : 'fa-brands fa-google text-red-400';
  }
  if (hint) {
    hint.innerHTML =
      'OAuth real no está configurado en este servidor. Usa un perfil <strong class="text-amber-300">demo local</strong> o configura las variables en Render (ver README).';
  }
  if (input) {
    input.value = currentUser && currentUser.provider === provider ? currentUser.name : '';
    input.placeholder = provider === 'github' ? 'usuario_github' : 'nombre';
  }
  if (modal) modal.classList.remove('hidden');
  setTimeout(() => { if (input) input.focus(); }, 50);
}

function closeAuthModal() {
  const modal = document.getElementById('authModal');
  if (modal) modal.classList.add('hidden');
  pendingAuthProvider = null;
}

function confirmAuthModal() {
  const input = document.getElementById('authUsernameInput');
  const name = (input && input.value.trim()) || '';
  if (!name) {
    showToast('Escribe un nombre de usuario.', 'warn');
    return;
  }
  const provider = pendingAuthProvider || 'github';
  currentUser = {
    provider: provider,
    name: name,
    avatar:
      provider === 'github'
        ? 'https://github.com/identicons/' + encodeURIComponent(name) + '.png'
        : 'https://ui-avatars.com/api/?name=' + encodeURIComponent(name) + '&background=0891b2&color=fff',
    real: false
  };
  lsSet(STORAGE_KEY_AUTH, JSON.stringify(currentUser));
  updateAuthUI();
  closeAuthModal();
  showToast('Perfil demo guardado. Configura OAuth en Render para login real.');
}

function connectAuth(provider) {
  openAuthModal(provider);
}

async function logoutAuth() {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (_) {}
  currentUser = null;
  lsRemove(STORAGE_KEY_AUTH);
  updateAuthUI();
  showToast('Sesión cerrada.');
  // Reload workspace as anonymous
  try {
    await loadProjectsFromStorage();
    renderProjectsList();
    updateDashboardStatus();
  } catch (_) {}
}

function updateAuthUI() {
  const container = document.getElementById('authContainer');
  const badge = document.getElementById('userProfileBadge');
  if (!container || !badge) return;
  if (currentUser) {
    container.classList.add('hidden');
    badge.classList.remove('hidden');
    const av = document.getElementById('userAvatar');
    const un = document.getElementById('userName');
    if (av) av.src = currentUser.avatar || ('https://ui-avatars.com/api/?name=' + encodeURIComponent(currentUser.name || 'U'));
    if (un) {
      const tag = currentUser.real ? currentUser.provider : 'demo';
      un.innerText = (currentUser.name || 'Usuario') + ' · ' + tag;
    }
  } else {
    container.classList.remove('hidden');
    badge.classList.add('hidden');
  }
  const gh = document.getElementById('connGithubBadge');
  const gg = document.getElementById('connGoogleBadge');
  if (gh) {
    const on = currentUser && currentUser.provider === 'github';
    const oauthOn = oauthConfig.github;
    gh.textContent = on ? currentUser.name : oauthOn ? 'OAuth listo' : 'Demo / config';
    gh.className = on
      ? 'text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
      : oauthOn
        ? 'text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-500/30'
        : 'text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700';
  }
  if (gg) {
    const on = currentUser && currentUser.provider === 'google';
    const oauthOn = oauthConfig.google;
    gg.textContent = on ? currentUser.name : oauthOn ? 'OAuth listo' : 'Demo / config';
    gg.className = on
      ? 'text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
      : oauthOn
        ? 'text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-500/30'
        : 'text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700';
  }
  const btnGh = document.getElementById('btnAuthGithub');
  const btnGg = document.getElementById('btnAuthGoogle');
  if (btnGh) {
    btnGh.title = oauthConfig.github ? 'Iniciar sesión con GitHub' : 'GitHub (demo — configura OAuth)';
    btnGh.setAttribute('aria-label', btnGh.title);
    const lab = btnGh.querySelector('[data-auth-label]');
    if (lab) lab.textContent = oauthConfig.github ? 'Entrar' : 'Demo';
  }
  if (btnGg) {
    btnGg.title = oauthConfig.google ? 'Iniciar sesión con Google' : 'Google (demo — configura OAuth)';
    btnGg.setAttribute('aria-label', btnGg.title);
    const lab = btnGg.querySelector('[data-auth-label]');
    if (lab) lab.textContent = oauthConfig.google ? 'Entrar' : 'Demo';
  }
}


function updateOauthDemoBanner() {
  let bar = document.getElementById('oauthDemoBanner');
  const show = !oauthConfig.github && !oauthConfig.google;
  if (show) {
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'oauthDemoBanner';
      bar.setAttribute('role', 'status');
      bar.className =
        'mx-4 sm:mx-6 mt-3 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/25 text-[11px] text-amber-200/90 flex items-start gap-2';
      bar.innerHTML =
        '<i class="fa-solid fa-circle-info mt-0.5 text-amber-400" aria-hidden="true"></i>' +
        '<span>OAuth no configurado en este servidor: GitHub/Google usan <strong>perfil demo local</strong>. ' +
        'En Render define <code class="font-mono text-amber-100">GITHUB_CLIENT_*</code> / <code class="font-mono text-amber-100">GOOGLE_CLIENT_*</code> para login real.</span>';
      const main = document.querySelector('#welcomeDashboard main');
      if (main && main.parentNode) main.parentNode.insertBefore(bar, main);
    } else {
      bar.classList.remove('hidden');
    }
  } else if (bar) {
    bar.classList.add('hidden');
  }
}

/** One-shot: if user just logged in via OAuth and server workspace is empty, import local projects. */
function maybeOfferLocalImport() {
  try {
    if (!currentUser || !currentUser.real) return;
    if (projects.length > 0) return;
    const raw = lsGet(STORAGE_KEY_PROJECTS);
    if (!raw) return;
    const local = JSON.parse(raw);
    if (!Array.isArray(local) || local.length === 0) return;
    const flag = 'codelab_import_offered_' + (currentUser.provider + '_' + currentUser.id);
    if (lsGet(flag)) return;
    lsSet(flag, '1');
    const ok = confirm(
      'Tu workspace de cuenta está vacío, pero hay ' +
        local.length +
        ' proyecto(s) guardados en este navegador. ¿Importarlos a tu cuenta?'
    );
    if (!ok) return;
    projects = local.map(p => ({
      ...p,
      code: normalizeCode(p.code),
      id: typeof p.id === 'string' ? p.id : 'proj_' + Date.now()
    }));
    saveProjectsToStorage();
    renderProjectsList();
    showToast('Proyectos locales importados a tu cuenta.');
  } catch (_) {}
}

function updateDashboardStatus() {
  const badge = document.getElementById('dashSyncBadge');
  const wid = document.getElementById('dashWorkspaceId');
  if (badge) {
    if (currentUser && currentUser.real) {
      badge.innerHTML =
        '<i class="fa-solid fa-shield-halved mr-1 text-emerald-400"></i> Cuenta ' +
        currentUser.provider +
        (serverReady ? ' · sync' : ' · local');
      badge.className =
        'px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-300';
    } else if (serverReady) {
      badge.innerHTML = '<i class="fa-solid fa-check mr-1 text-emerald-400"></i> Workspace sincronizado';
      badge.className =
        'px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-300';
    } else {
      badge.innerHTML = '<i class="fa-solid fa-wifi mr-1"></i> Solo local (sin servidor)';
      badge.className = 'px-2.5 py-1 rounded-full bg-slate-800 border border-slate-700 text-slate-400';
    }
  }
  if (wid && workspaceId) {
    wid.textContent = workspaceId;
    wid.title = workspaceId;
  }
}



// ---------- Editors ----------
function getMonacoOptions() {
  return {
    theme: 'vs-dark',
    automaticLayout: true,
    fontSize: 14,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', 'Courier New', monospace",
    fontLigatures: true,
    minimap: { enabled: false },
    padding: { top: 12, bottom: 12 },
    tabSize: 2,
    insertSpaces: true,
    detectIndentation: false,
    wordWrap: 'on',
    lineNumbers: 'on',
    renderLineHighlight: 'line',
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    bracketPairColorization: { enabled: true },
    matchBrackets: 'always',
    autoClosingBrackets: 'languageDefined',
    autoClosingQuotes: 'languageDefined',
    autoIndent: 'full',
    formatOnPaste: true,
    formatOnType: false,
    suggestOnTriggerCharacters: true,
    quickSuggestions: true,
    snippetSuggestions: 'inline',
    tabCompletion: 'on',
    folding: true,
    renderWhitespace: 'selection',
    mouseWheelZoom: true,
    accessibilitySupport: 'auto',
    fixedOverflowWidgets: true
  };
}

function initMonacoOrFallback(code) {
  code = normalizeCode(code);
  const initGeneration = ++editorInitGeneration;
  if (useMonaco && typeof require !== 'undefined') {
    require.config({
      paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.38.0/min/vs' }
    });
    require(
      ['vs/editor/editor.main'],
      function () {
        if (initGeneration !== editorInitGeneration) return;
        try {
          const opts = getMonacoOptions();
          if (!editors.html) {
            const htmlEl = document.getElementById('monaco-html');
            const cssEl = document.getElementById('monaco-css');
            const jsEl = document.getElementById('monaco-js');
            if (!htmlEl || !cssEl || !jsEl) {
              enableFallbackMode(code);
              return;
            }
            editors.html = monaco.editor.create(htmlEl, {
              value: code.html,
              language: 'html',
              ...opts
            });
            editors.css = monaco.editor.create(cssEl, {
              value: code.css,
              language: 'css',
              ...opts
            });
            editors.js = monaco.editor.create(jsEl, {
              value: code.js,
              language: 'javascript',
              ...opts
            });
            Object.keys(editors).forEach(k => {
              editors[k].onDidChangeModelContent(onContentChange);
            });
            // Ctrl/Cmd+S already handled globally; add format
            Object.keys(editors).forEach(k => {
              editors[k].addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, function () {
                editors[k].getAction('editor.action.formatDocument').run();
              });
            });
          } else {
            setEditorValue('html', code.html, { silent: true });
            setEditorValue('css', code.css, { silent: true });
            setEditorValue('js', code.js, { silent: true });
          }
          // Ensure only active tab visible and layout
          switchTab(activeTab || 'html');
          Object.keys(editors).forEach(k => {
            try { editors[k].layout(); } catch (_) {}
          });
          updatePreview();
        } catch (err) {
          console.warn('Monaco init failed, using fallback', err);
          enableFallbackMode(code);
        }
      },
      function (err) {
        if (initGeneration !== editorInitGeneration) return;
        console.warn('Monaco load failed', err);
        enableFallbackMode(code);
      }
    );
  } else {
    enableFallbackMode(code);
  }
}

function enableFallbackMode(code) {
  useMonaco = false;
  code = normalizeCode(code);
  ['html', 'css', 'js'].forEach(lang => {
    const monacoEl = document.getElementById('monaco-' + lang);
    if (monacoEl) monacoEl.classList.add('hidden');
    const fb = document.getElementById('fallback-' + lang);
    if (fb) {
      fb.classList.remove('hidden');
      fb.value = code[lang] || '';
      // Avoid double-binding: HTML also has oninput — set once via property is fine
      fb.oninput = onContentChange;
      fb.spellcheck = false;
      fb.setAttribute('autocomplete', 'off');
      fb.setAttribute('autocapitalize', 'off');
    }
  });
  switchTab(activeTab || 'html');
  updatePreview();
}

function onContentChange() {
  if (!suppressEditorAutosave) saveCurrentCodeToActiveProject(false);
  schedulePreview();
}

function schedulePreview() {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    previewTimer = null;
    updatePreview();
  }, PREVIEW_DEBOUNCE_MS);
}

function setEditorValue(lang, val, options) {
  options = options || {};
  const previous = suppressEditorAutosave;
  if (options.silent) suppressEditorAutosave = true;
  const safe = typeof val === 'string' ? val : '';
  try {
    if (useMonaco && editors[lang]) {
      const model = editors[lang].getModel();
      if (model && model.getValue() !== safe) {
        editors[lang].setValue(safe);
      } else if (!model) {
        editors[lang].setValue(safe);
      }
    } else {
      const el = document.getElementById('fallback-' + lang);
      if (el && el.value !== safe) el.value = safe;
    }
  } catch (e) {
    console.warn('setEditorValue failed', lang, e);
    const el = document.getElementById('fallback-' + lang);
    if (el) el.value = safe;
  }
  suppressEditorAutosave = previous;
  if (!options.silent) onContentChange();
}

function getEditorValue(lang) {
  try {
    if (useMonaco && editors[lang]) {
      return editors[lang].getValue() || '';
    }
  } catch (_) {}
  const el = document.getElementById('fallback-' + lang);
  return el ? el.value || '' : '';
}

function switchTab(t) {
  if (!['html', 'css', 'js'].includes(t)) t = 'html';
  activeTab = t;
  ['html', 'css', 'js'].forEach(tab => {
    const btn = document.getElementById('tab-' + tab);
    const container = useMonaco
      ? document.getElementById('monaco-' + tab)
      : document.getElementById('fallback-' + tab);
    // When monaco mode, hide fallback; when fallback, hide monaco
    const other = useMonaco
      ? document.getElementById('fallback-' + tab)
      : document.getElementById('monaco-' + tab);
    if (other) other.classList.add('hidden');
    if (!btn || !container) return;
    if (tab === t) {
      btn.className =
        'tab-btn active border-b-2 border-cyan-500 text-cyan-400 font-semibold px-3 py-2 text-xs flex items-center gap-1.5';
      container.classList.remove('hidden');
      if (useMonaco && editors[tab]) {
        try {
          editors[tab].layout();
          editors[tab].focus();
        } catch (_) {}
      } else if (!useMonaco) {
        const fb = document.getElementById('fallback-' + tab);
        if (fb) {
          try { fb.focus(); } catch (_) {}
        }
      }
    } else {
      btn.className =
        'tab-btn text-slate-400 border-b-2 border-transparent px-3 py-2 text-xs flex items-center gap-1.5';
      container.classList.add('hidden');
    }
  });
}

function updatePreview() {
  const html = getEditorValue('html');
  const css = getEditorValue('css');
  const js = getEditorValue('js');
  const iframe = document.getElementById('previewIframe');
  if (!iframe) return;
  const errScript =
    '<script>' +
    'window.onerror=function(msg,url,line,col){' +
    'window.parent.postMessage({type:"CONSOLE_LOG",logType:"error",message:"Línea "+line+":"+col+" - "+msg}, window.location.origin||"*");' +
    '};' +
    'console.log=function(){var a=[].slice.call(arguments);window.parent.postMessage({type:"CONSOLE_LOG",logType:"log",message:a.join(" ")},window.location.origin||"*");};' +
    'console.error=function(){var a=[].slice.call(arguments);window.parent.postMessage({type:"CONSOLE_LOG",logType:"error",message:a.join(" ")},window.location.origin||"*");};' +
    '<\/script>';
  iframe.srcdoc =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; img-src data: https: http:; font-src data: https: http:; connect-src \'none\';">' +
    '<style>' +
    css +
    '</style>' +
    errScript +
    '</head><body>' +
    html +
    '<script>' +
    js +
    '<\/script></body></html>';
}

window.addEventListener('message', e => {
  // Only accept messages from our own origin (srcdoc inherits parent origin in most browsers)
  // or from null origin edge cases — reject foreign origins.
  if (e.origin && e.origin !== 'null' && e.origin !== window.location.origin) return;
  if (!e.data || e.data.type !== 'CONSOLE_LOG') return;
  const out = document.getElementById('consoleOutput');
  if (!out) return;
  const item = document.createElement('div');
  logsCount++;
  const counter = document.getElementById('logCountHeader');
  if (counter) counter.innerText = logsCount;
  item.className =
    e.data.logType === 'error'
      ? 'text-red-400 border-l-2 border-red-500 pl-2'
      : 'text-cyan-300 border-l-2 border-cyan-500 pl-2';
  item.innerText = String(e.data.message || '').slice(0, 2000);
  out.appendChild(item);
  while (out.children.length > MAX_CONSOLE_LINES) {
    out.removeChild(out.firstChild);
  }
  out.scrollTop = out.scrollHeight;
});

// ---------- Branches ----------
function getCurrentProject() {
  return projects.find(p => p.id === currentProjectId);
}
function cloneCode(code) {
  return normalizeCode(deepClone(code || { html: '', css: '', js: '' }));
}
function codeEqual(a, b) {
  return ['html', 'css', 'js'].every(k => (a?.[k] || '') === (b?.[k] || ''));
}

function persistBranch(immediate) {
  const proj = getCurrentProject();
  if (!proj || !isCopyBranchCreated) return;
  proj.branch = {
    id: copyBranchId || 'branch_' + Date.now(),
    baseCode: cloneCode(copyBaseCode),
    code: cloneCode(copyProjectCode),
    baseMainUpdatedAt: proj.branch?.baseMainUpdatedAt || proj.updatedAt,
    updatedAt: new Date().toISOString()
  };
  copyBranchId = proj.branch.id;
  if (immediate) saveProjectsToStorage();
  else scheduleAutosave();
}

function loadBranchFromProject(proj) {
  if (!proj || !proj.branch) return false;
  isCopyBranchCreated = true;
  copyBranchId = proj.branch.id;
  copyBaseCode = cloneCode(proj.branch.baseCode);
  copyProjectCode = cloneCode(proj.branch.code);
  return true;
}

function updateBranchButtons() {
  const proj = getCurrentProject();
  const hasBranch = !!(proj && proj.branch);
  ['toggleCopyBranchBtn', 'mobileCopyBranchBtn'].forEach(id => {
    const b = document.getElementById(id);
    if (b) {
      b.disabled = !hasBranch;
      if (hasBranch) {
        b.classList.remove('cursor-not-allowed', 'text-slate-500');
        b.classList.add('text-slate-200', 'hover:bg-slate-700');
      }
    }
  });
  const undo = document.getElementById('undoMergeBtn');
  if (undo) {
    const canUndo = !!(proj && Array.isArray(proj.mergeHistory) && proj.mergeHistory.length);
    undo.disabled = !canUndo;
    if (canUndo) {
      undo.classList.remove('cursor-not-allowed', 'text-slate-500');
      undo.classList.add('text-slate-200', 'hover:bg-slate-700');
    }
  }
}

function duplicateProject() {
  const proj = getCurrentProject();
  if (!proj) return;
  if (!inCopyBranch) saveCurrentCodeToActiveProject(true);
  const source = cloneCode(proj.code);
  copyBaseCode = source;
  copyProjectCode = cloneCode(source);
  copyBranchId = 'branch_' + crypto.randomUUID();
  isCopyBranchCreated = true;
  proj.branch = {
    id: copyBranchId,
    baseCode: cloneCode(source),
    code: cloneCode(source),
    baseMainUpdatedAt: proj.updatedAt,
    updatedAt: new Date().toISOString()
  };
  persistBranch(true);
  updateBranchButtons();
  showToast('Copia de trabajo creada. El original queda aislado.');
}

function toggleCopyBranch() {
  const proj = getCurrentProject();
  if (!proj || !proj.branch) return;
  if (inCopyBranch) saveInCopyBranch();
  aiRequestGeneration++;
  inCopyBranch = !inCopyBranch;
  const banner = document.getElementById('copyAlertBanner');
  const text = document.getElementById('copyBranchText');
  const mText = document.getElementById('mobileCopyBranchText');
  if (inCopyBranch) {
    if (text) text.innerText = 'Ir al Principal';
    if (mText) mText.innerText = 'Ir al Principal';
    if (banner) banner.classList.remove('hidden');
    setEditorValue('html', copyProjectCode.html, { silent: true });
    setEditorValue('css', copyProjectCode.css, { silent: true });
    setEditorValue('js', copyProjectCode.js, { silent: true });
    setSyncStatus('branch', 'EDITANDO COPIA');
  } else {
    if (text) text.innerText = 'Ir a la copia';
    if (mText) mText.innerText = 'Ir a la copia';
    if (banner) banner.classList.add('hidden');
    setEditorValue('html', proj.code.html, { silent: true });
    setEditorValue('css', proj.code.css, { silent: true });
    setEditorValue('js', proj.code.js, { silent: true });
    setSyncStatus('synced', 'Sincronizado');
  }
  updatePreview();
}

async function saveInCopyBranch() {
  if (!inCopyBranch || !getCurrentProject()) return false;
  copyProjectCode = cloneCode({
    html: getEditorValue('html'),
    css: getEditorValue('css'),
    js: getEditorValue('js')
  });
  persistBranch(true);
  const ok = await persistWorkspace();
  showToast(
    ok === false
      ? 'La copia quedó guardada localmente; el servidor no respondió.'
      : 'Cambios guardados únicamente en la copia.'
  );
  return ok !== false;
}

function buildThreeWayMerge(main, base, branch) {
  const merged = {};
  const conflicts = [];
  ['html', 'css', 'js'].forEach(k => {
    const m = main[k] || '';
    const b = base[k] || '';
    const c = branch[k] || '';
    if (m === b) merged[k] = c;
    else if (c === b || m === c) merged[k] = m;
    else conflicts.push(k.toUpperCase());
  });
  return { merged, conflicts };
}

async function mergeToMainProject() {
  if (!inCopyBranch) {
    showToast('Primero entra en la copia.');
    return;
  }
  const proj = getCurrentProject();
  if (!proj || !proj.branch) return;
  await saveInCopyBranch();
  await refreshWorkspaceFromServer();
  const latest = getCurrentProject();
  if (!latest) return;
  if (latest.branch && latest.branch.id === copyBranchId) {
    copyBaseCode = cloneCode(latest.branch.baseCode);
    copyProjectCode = cloneCode(latest.branch.code);
  }
  const result = buildThreeWayMerge(latest.code, copyBaseCode, copyProjectCode);
  if (result.conflicts.length) {
    showToast('Conflicto en ' + result.conflicts.join(', ') + '. No se modificó el original.', 'warn');
    return;
  }
  if (
    !confirm(
      '¿Aplicar los cambios de la copia al proyecto principal? Se guardará un respaldo y podrás deshacerlo.'
    )
  )
    return;

  // Snapshot for rollback if server save fails (C1)
  const snapshot = deepClone(latest);
  const prevInCopy = inCopyBranch;
  const prevCopyState = {
    copyBaseCode: deepClone(copyBaseCode),
    copyProjectCode: deepClone(copyProjectCode),
    copyBranchId: copyBranchId,
    isCopyBranchCreated: isCopyBranchCreated
  };

  const backup = {
    code: cloneCode(latest.code),
    updatedAt: latest.updatedAt,
    branch: deepClone(latest.branch),
    createdAt: new Date().toISOString()
  };
  latest.mergeHistory = Array.isArray(latest.mergeHistory) ? latest.mergeHistory : [];
  latest.mergeHistory.push(backup);
  latest.mergeHistory = latest.mergeHistory.slice(-10);
  latest.code = result.merged;
  latest.updatedAt = new Date().toISOString();
  delete latest.branch;
  copyBaseCode = null;
  copyProjectCode = { html: '', css: '', js: '' };
  copyBranchId = null;
  isCopyBranchCreated = false;
  inCopyBranch = false;

  const ok = await persistWorkspace();
  if (!ok) {
    // Rollback local state
    const idx = projects.findIndex(p => p.id === latest.id);
    if (idx >= 0) projects[idx] = snapshot;
    copyBaseCode = prevCopyState.copyBaseCode;
    copyProjectCode = prevCopyState.copyProjectCode;
    copyBranchId = prevCopyState.copyBranchId;
    isCopyBranchCreated = prevCopyState.isCopyBranchCreated;
    inCopyBranch = prevInCopy;
    showToast('No se pudo guardar el merge en el servidor. Se revirtieron los cambios locales.', 'error');
    return;
  }
  document.getElementById('copyAlertBanner').classList.add('hidden');
  setSyncStatus('synced', 'Sincronizado');
  updateBranchButtons();
  setEditorValue('html', latest.code.html, { silent: true });
  setEditorValue('css', latest.code.css, { silent: true });
  setEditorValue('js', latest.code.js, { silent: true });
  updatePreview();
  showToast('Cambios aplicados al original. Respaldo creado.');
}

async function undoLastMerge() {
  const proj = getCurrentProject();
  if (!proj || !Array.isArray(proj.mergeHistory) || !proj.mergeHistory.length) {
    showToast('No hay merges para deshacer.');
    return;
  }
  if (!confirm('¿Restaurar el estado anterior del último merge?')) return;

  const snapshot = deepClone(proj);
  const backup = proj.mergeHistory[proj.mergeHistory.length - 1];
  const nextHistory = proj.mergeHistory.slice(0, -1);
  const restoredCode = cloneCode(backup.code);
  const restoredUpdated = backup.updatedAt || new Date().toISOString();
  const restoredBranch = backup.branch ? deepClone(backup.branch) : null;

  proj.mergeHistory = nextHistory;
  proj.code = restoredCode;
  proj.updatedAt = restoredUpdated;
  if (restoredBranch) proj.branch = restoredBranch;
  else delete proj.branch;

  const ok = await persistWorkspace();
  if (!ok) {
    const idx = projects.findIndex(p => p.id === proj.id);
    if (idx >= 0) projects[idx] = snapshot;
    showToast('No se pudo guardar el deshacer en el servidor. Estado local revertido.', 'error');
    return;
  }
  loadBranchFromProject(proj);
  inCopyBranch = false;
  setEditorValue('html', proj.code.html, { silent: true });
  setEditorValue('css', proj.code.css, { silent: true });
  setEditorValue('js', proj.code.js, { silent: true });
  updatePreview();
  updateBranchButtons();
  const banner = document.getElementById('copyAlertBanner');
  if (banner) banner.classList.add('hidden');
  setSyncStatus('synced', 'Sincronizado');
  showToast('Merge deshecho.');
}


// ---------- AI settings & generation ----------
function loadAiSettings() {
  const raw = lsGet(STORAGE_KEY_AI);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      aiSettings = Object.assign({}, aiSettings, parsed);
      if (aiSettings.mode !== 'local' && aiSettings.mode !== 'api' && aiSettings.mode !== 'auto') {
        aiSettings.mode = 'auto';
      }
    } catch (_) {}
  }
  updateAiUI();
}

async function loadServerAiStatus() {
  try {
    const r = await fetch('/api/ai/status', { credentials: 'same-origin' });
    if (!r.ok) throw new Error('status');
    const data = await r.json();
    serverAi = {
      serverKey: !!data.serverKey,
      model: data.model || 'gpt-4o-mini',
      baseUrl: data.baseUrl || null,
      hint: data.hint || ''
    };
    // Server has AI: force Auto unless user explicitly locked Local after seeing the new UI
    if (serverAi.serverKey) {
      const lockLocal = lsGet('codelab_ai_force_local_v1') === '1';
      if (!lockLocal && aiSettings.mode === 'local') {
        aiSettings.mode = 'auto';
        lsSet(STORAGE_KEY_AI, JSON.stringify(aiSettings));
      }
      if (serverAi.model) aiSettings.model = serverAi.model;
    }
    updateAiUI();
    return data;
  } catch (_) {
    serverAi = { serverKey: false, model: 'gpt-4o-mini', baseUrl: null, hint: '' };
    updateAiUI();
  }
}

function openAiSettingsModal() {
  const modal = document.getElementById('aiSettingsModal');
  const local = document.getElementById('aiModeLocal');
  const api = document.getElementById('aiModeApi');
  const auto = document.getElementById('aiModeAuto');
  const base = document.getElementById('aiBaseUrl');
  const model = document.getElementById('aiModel');
  const key = document.getElementById('aiApiKey');
  const status = document.getElementById('aiServerStatus');
  if (auto) auto.checked = aiSettings.mode === 'auto' || (!aiSettings.mode);
  if (local) local.checked = aiSettings.mode === 'local';
  if (api) api.checked = aiSettings.mode === 'api';
  if (base) base.value = aiSettings.baseUrl || 'https://api.openai.com/v1';
  if (model) model.value = aiSettings.model || serverAi.model || 'gpt-4o-mini';
  if (key) key.value = aiSettings.apiKey || '';
  if (status) {
    status.innerHTML = serverAi.serverKey
      ? '<span class="text-emerald-300"><i class="fa-solid fa-check"></i> Servidor con API key · modelo ' +
        escapeHtml(serverAi.model) +
        '</span>'
      : '<span class="text-amber-300"><i class="fa-solid fa-triangle-exclamation"></i> Sin AI_API_KEY en el servidor. Puedes pegar tu key abajo o usar plantillas.</span>';
  }
  onAiModeChange();
  if (modal) modal.classList.remove('hidden');
}

function closeAiSettingsModal() {
  const modal = document.getElementById('aiSettingsModal');
  if (modal) modal.classList.add('hidden');
}

function onAiModeChange() {
  const api = document.getElementById('aiModeApi');
  const auto = document.getElementById('aiModeAuto');
  const local = document.getElementById('aiModeLocal');
  const fields = document.getElementById('aiApiFields');
  if (!fields) return;
  if (api && api.checked) {
    fields.classList.remove('hidden');
  } else if (auto && auto.checked && !serverAi.serverKey) {
    fields.classList.remove('hidden');
  } else {
    fields.classList.add('hidden');
  }
}

function saveAiSettings() {
  const api = document.getElementById('aiModeApi');
  const auto = document.getElementById('aiModeAuto');
  const local = document.getElementById('aiModeLocal');
  const base = document.getElementById('aiBaseUrl');
  const model = document.getElementById('aiModel');
  const key = document.getElementById('aiApiKey');
  let mode = 'auto';
  if (local && local.checked) mode = 'local';
  else if (api && api.checked) mode = 'api';
  else mode = 'auto';
  aiSettings = {
    mode: mode,
    baseUrl: (base && base.value.trim()) || 'https://api.openai.com/v1',
    model: (model && model.value.trim()) || 'gpt-4o-mini',
    apiKey: (key && key.value.trim()) || ''
  };
  if (mode === 'api' && !aiSettings.apiKey && !serverAi.serverKey) {
    showToast('Modo API: necesitas AI_API_KEY en el servidor o pegar tu key.', 'warn');
    return;
  }
  lsSet(STORAGE_KEY_AI, JSON.stringify(aiSettings));
  if (mode === 'local') lsSet('codelab_ai_force_local_v1', '1');
  else lsRemove('codelab_ai_force_local_v1');
  updateAiUI();
  closeAiSettingsModal();
  const label =
    mode === 'local'
      ? 'Modo plantillas (sin IA remota)'
      : serverAi.serverKey || aiSettings.apiKey
        ? 'Copiloto conectado'
        : 'Auto — falta API key';
  showToast(label);
  if (mode !== 'local' && (serverAi.serverKey || aiSettings.apiKey)) {
    testAiBridge().catch(() => {});
  }
}

function aiCanUseRemote() {
  if (aiSettings.mode === 'local') return false;
  if (serverAi.serverKey) return true;
  if (aiSettings.apiKey) return true;
  return false;
}

function updateAiUI() {
  const badge = document.getElementById('aiModeBadge');
  const motor = document.getElementById('aiMotorLabel');
  const conn = document.getElementById('connAiBadge');
  const remote = aiCanUseRemote();
  if (badge) {
    badge.textContent = remote ? 'IA' : 'LOCAL';
    badge.className = remote
      ? 'bg-purple-500/20 text-purple-300 text-[10px] px-1.5 py-0.5 rounded border border-purple-500/30'
      : 'bg-amber-500/20 text-amber-300 text-[10px] px-1.5 py-0.5 rounded border border-amber-500/30';
  }
  if (motor) {
    if (remote) {
      motor.textContent = (aiSettings.model || serverAi.model || 'API') + (serverAi.serverKey ? ' · servidor' : ' · tu key');
      motor.className = 'text-purple-300 font-semibold';
    } else {
      motor.textContent = 'Plantillas locales';
      motor.className = 'text-amber-300 font-semibold';
    }
  }
  if (conn) {
    conn.textContent = remote ? 'IA lista' : 'Plantillas';
    conn.className = remote
      ? 'text-[10px] px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-300 border border-purple-500/30'
      : 'text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700';
  }
}

function setMobileStudioMode(mode) {
  mobileStudioMode = mode === 'preview' ? 'preview' : 'code';
  const studio = document.getElementById('studioView');
  if (studio) {
    studio.classList.remove('mobile-mode-code', 'mobile-mode-preview');
    studio.classList.add(mobileStudioMode === 'preview' ? 'mobile-mode-preview' : 'mobile-mode-code');
  }
  const codeBtn = document.getElementById('mobileTabCode');
  const prevBtn = document.getElementById('mobileTabPreview');
  if (codeBtn)
    codeBtn.className =
      'flex-1 flex flex-col items-center justify-center gap-0.5 py-2 rounded-lg text-[10px] font-semibold ' +
      (mobileStudioMode === 'code' ? 'text-cyan-400' : 'text-slate-400');
  if (prevBtn)
    prevBtn.className =
      'flex-1 flex flex-col items-center justify-center gap-0.5 py-2 rounded-lg text-[10px] font-semibold ' +
      (mobileStudioMode === 'preview' ? 'text-cyan-400' : 'text-slate-400');
  if (mobileStudioMode === 'code') {
    Object.keys(editors).forEach(k => {
      try {
        editors[k].layout();
      } catch (_) {}
    });
  } else {
    updatePreview();
  }
}

/** Calls server proxy /api/ai/complete (avoids CORS, keeps path ready for real AI). */
async function callRemoteAi(prompt, code) {
  const payload = {
    prompt: prompt,
    code: {
      html: code.html || '',
      css: code.css || '',
      js: code.js || ''
    }
  };
  if (serverAi.serverKey) {
    // Let the server use AI_MODEL / AI_BASE_URL from env — do not override with a wrong browser default
    // Only send model if user explicitly set a non-default in settings
    if (aiSettings.model && aiSettings.model !== 'gpt-4o-mini') {
      payload.model = aiSettings.model;
    }
  } else {
    payload.model = aiSettings.model || 'gpt-4o-mini';
    if (aiSettings.baseUrl) payload.baseUrl = aiSettings.baseUrl;
    if (aiSettings.apiKey) payload.apiKey = aiSettings.apiKey;
  }
  const res = await fetch('/api/ai/complete', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  let data = {};
  try {
    data = await res.json();
  } catch (_) {}
  if (!res.ok) {
    const msg = (data && data.message) || (data && data.error) || 'HTTP ' + res.status;
    throw new Error(msg);
  }
  return {
    html: typeof data.html === 'string' ? data.html : code.html,
    css: typeof data.css === 'string' ? data.css : code.css,
    js: typeof data.js === 'string' ? data.js : code.js,
    message: typeof data.message === 'string' ? data.message : 'Respuesta IA aplicada.'
  };
}



// ---------- AI templates (local, not real LLM) ----------
function triggerQuickAi(action) {
  const input = document.getElementById('aiPromptInput');
  if (!input) return;
  if (action === 'landing') {
    input.value = 'Crea una Landing Page moderna con Hero, Tarjetas de Servicios y Footer estilizado.';
  } else if (action === 'form') {
    input.value = 'Genera un formulario de contacto con validación de email en JS y estilos responsive.';
  } else if (action === 'darkmode') {
    input.value = 'Añade un tema oscuro profesional y elegante a todo el CSS actual.';
  } else if (action === 'fix') {
    input.value = 'Revisa y optimiza el código JavaScript para prevenir errores de ejecución.';
  }
  processAiInstruction();
}

async function processAiInstruction() {
  const promptInput = document.getElementById('aiPromptInput');
  const prompt = (promptInput && promptInput.value.trim()) || '';
  if (!prompt) {
    showToast('Escribe una instrucción para el copiloto.', 'warn');
    return;
  }
  if (!getCurrentProject()) {
    showToast('Abre un proyecto antes de usar el copiloto.', 'warn');
    return;
  }

  const targetProjectId = currentProjectId;
  const targetBranchId = inCopyBranch ? copyBranchId : null;
  const targetInCopyBranch = inCopyBranch;
  const requestGeneration = ++aiRequestGeneration;

  const history = document.getElementById('aiChatHistory');
  if (!history) return;

  const userMsg = document.createElement('div');
  userMsg.className = 'bg-slate-800/90 p-3 rounded-xl text-slate-100 border border-slate-700 text-xs leading-relaxed';
  userMsg.textContent = prompt;
  history.appendChild(userMsg);
  promptInput.value = '';

  const aiMsg = document.createElement('div');
  aiMsg.className =
    'bg-slate-900 border border-purple-500/30 p-3 rounded-xl text-slate-200 text-xs leading-relaxed flex items-start gap-2';
  const isApi = aiCanUseRemote();
  aiMsg.innerHTML = isApi
    ? '<i class="fa-solid fa-spinner fa-spin text-purple-400 mt-0.5"></i><span><span class="text-purple-300 font-semibold">Copiloto</span> · generando código…</span>'
    : '<i class="fa-solid fa-wand-magic-sparkles text-amber-400 mt-0.5"></i><span><span class="text-amber-300 font-semibold">Plantillas</span> · aplicando patrón local…</span>';
  history.appendChild(aiMsg);
  history.scrollTop = history.scrollHeight;

  // Disable send while working
  const sendBtn = document.getElementById('aiSendBtn');
  if (sendBtn) {
    sendBtn.disabled = true;
    sendBtn.classList.add('opacity-50', 'cursor-not-allowed');
  }

  const stillValid = () =>
    requestGeneration === aiRequestGeneration &&
    currentProjectId === targetProjectId &&
    inCopyBranch === targetInCopyBranch &&
    (!targetInCopyBranch || copyBranchId === targetBranchId);

  const finish = () => {
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    }
  };

  const applyGenerated = (generated, meta) => {
    if (!stillValid()) {
      aiMsg.innerHTML =
        '<i class="fa-solid fa-ban text-slate-500 mt-0.5"></i><span class="text-slate-400">Cancelado: cambió el proyecto o la rama.</span>';
      finish();
      return;
    }
    setEditorValue('html', generated.html, { silent: true });
    setEditorValue('css', generated.css, { silent: true });
    setEditorValue('js', generated.js, { silent: true });
    saveCurrentCodeToActiveProject(true);
    updatePreview();
    const via = (meta && meta.via) || (isApi ? 'IA' : 'plantilla');
    aiMsg.className =
      'bg-emerald-950/30 border border-emerald-500/30 p-3 rounded-xl text-emerald-100 text-xs leading-relaxed';
    aiMsg.innerHTML =
      '<div class="flex items-start gap-2">' +
      '<i class="fa-solid fa-check-circle text-emerald-400 mt-0.5"></i>' +
      '<div><div class="font-semibold text-emerald-300 mb-0.5">Aplicado · ' +
      escapeHtml(via) +
      '</div><div class="text-emerald-100/90">' +
      escapeHtml(generated.message || 'Cambios aplicados al editor.') +
      '</div></div></div>';
    history.scrollTop = history.scrollHeight;
    showToast('Copiloto: cambios aplicados.');
    finish();
  };

  try {
    if (isApi) {
      const code = normalizeCode({
        html: getEditorValue('html'),
        css: getEditorValue('css'),
        js: getEditorValue('js')
      });
      const generated = await callRemoteAi(prompt, code);
      applyGenerated(generated, { via: serverAi.serverKey ? 'servidor' : 'API' });
      return;
    }
  } catch (e) {
    console.warn('API IA falló', e);
    aiMsg.className =
      'bg-red-950/40 border border-red-500/40 p-3 rounded-xl text-red-100 text-xs leading-relaxed';
    aiMsg.innerHTML =
      '<div class="flex items-start gap-2"><i class="fa-solid fa-circle-xmark text-red-400 mt-0.5"></i><div>' +
      '<div class="font-semibold text-red-300 mb-1">No se pudo completar</div>' +
      '<div class="text-red-100/90 mb-2">' +
      escapeHtml(String(e.message || e).slice(0, 280)) +
      '</div>' +
      '<div class="text-[11px] text-red-300/70">Comprueba AI_MODEL (ej. <code class="text-red-200">openai/gpt-4o-mini</code>), créditos y <code class="text-red-200">POST /api/ai/ping</code>.</div>' +
      '</div></div>';
    history.scrollTop = history.scrollHeight;
    showToast('Copiloto: error de IA', 'error');
    finish();
    return;
  }

  // Local templates
  setTimeout(() => {
    if (!stillValid()) {
      aiMsg.innerHTML = '<span class="text-slate-400">Cancelado.</span>';
      finish();
      return;
    }
    const pLower = prompt.toLowerCase();
    const generated = {
      html: getEditorValue('html'),
      css: getEditorValue('css'),
      js: getEditorValue('js'),
      message: ''
    };
    const willReplaceAll =
      pLower.includes('landing') || pLower.includes('form') || pLower.includes('formulario');
    if (willReplaceAll) {
      if (
        !confirm(
          'Esta plantilla reemplazará HTML, CSS y JS. ¿Continuar?\n\n(Con IA real no hace falta confirmar plantillas.)'
        )
      ) {
        aiMsg.className = 'bg-slate-800 border border-slate-700 p-3 rounded-xl text-slate-300 text-xs';
        aiMsg.textContent = 'Plantilla cancelada.';
        finish();
        return;
      }
    }
    if (pLower.includes('landing')) {
      generated.html =
        '<div class="hero">\n  <h1>Construye el Futuro con CodeLab XD</h1>\n  <p>La plataforma interactiva para desarrolladores y creadores web.</p>\n  <button id="ctaBtn">Empezar Ahora</button>\n</div>\n\n<div class="features">\n  <div class="feat-card">⚡ Alta Velocidad</div>\n  <div class="feat-card">🤖 Plantillas</div>\n  <div class="feat-card">💾 Autoguardado</div>\n</div>';
      generated.css =
        "body { font-family: 'Inter', system-ui, sans-serif; background: #030712; color: #f3f4f6; margin: 0; padding: 2rem; text-align: center; }\n.hero { padding: 4rem 1rem; background: linear-gradient(180deg, rgba(6, 182, 212, 0.1) 0%, transparent 100%); border-radius: 1.5rem; border: 1px solid #1e293b; }\nh1 { font-size: 2.5rem; color: #38bdf8; margin-bottom: 0.5rem; }\n.features { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-top: 2rem; }\n.feat-card { background: #0f172a; padding: 1.5rem; border-radius: 1rem; border: 1px solid #1e293b; font-weight: bold; }\n#ctaBtn { background: #06b6d4; color: white; border: none; padding: 0.8rem 2rem; font-weight: bold; border-radius: 0.75rem; cursor: pointer; margin-top: 1rem; transition: 0.2s; }\n#ctaBtn:hover { background: #0891b2; transform: scale(1.05); }";
      generated.js =
        "document.getElementById('ctaBtn').addEventListener('click', () => {\n  console.log('Landing interactiva activa!');\n  alert('¡Bienvenido a la Landing Page!');\n});";
      generated.message = 'Landing page de plantilla aplicada.';
    } else if (pLower.includes('form') || pLower.includes('formulario')) {
      generated.html =
        '<form id="contactForm" class="form-card">\n  <h3>Contacto Rápido</h3>\n  <input type="text" id="name" placeholder="Tu Nombre" required />\n  <input type="email" id="email" placeholder="Correo Electrónico" required />\n  <button type="submit">Enviar Mensaje</button>\n  <p id="formStatus" class="status"></p>\n</form>';
      generated.css =
        'body { font-family: system-ui; background: #0f172a; color: white; display: grid; place-content: center; min-height: 100vh; margin: 0; }\n.form-card { background: #1e293b; padding: 2rem; border-radius: 1rem; border: 1px solid #334155; display: flex; flex-direction: column; gap: 1rem; width: min(100%, 320px); }\ninput { padding: 0.75rem; border-radius: 0.5rem; border: 1px solid #475569; background: #0f172a; color: white; outline: none; }\nbutton { padding: 0.75rem; border-radius: 0.5rem; border: none; background: #10b981; color: white; font-weight: bold; cursor: pointer; }\n.status { font-size: 0.8rem; text-align: center; margin: 0; }';
      generated.js =
        "document.getElementById('contactForm').addEventListener('submit', (e) => {\n  e.preventDefault();\n  const email = document.getElementById('email').value;\n  const status = document.getElementById('formStatus');\n  status.innerText = '✅ Validado: ' + email;\n  status.style.color = '#34d399';\n});";
      generated.message = 'Formulario de plantilla aplicado.';
    } else if (pLower.includes('oscuro') || pLower.includes('dark')) {
      generated.css =
        generated.css +
        '\n/* Tema Oscuro */\nbody { background-color: #030712 !important; color: #f9fafb !important; }\n.card, div { border-color: #1e293b !important; }';
      generated.message = 'Tema oscuro añadido al CSS.';
    } else if (pLower.includes('fix') || pLower.includes('optimiza') || pLower.includes('error')) {
      generated.js =
        '// Revisado\ntry {\n' +
        generated.js
          .split('\n')
          .map(function (l) {
            return '  ' + l;
          })
          .join('\n') +
        '\n} catch (err) {\n  console.error("Error capturado:", err);\n}\n';
      generated.message = 'JS envuelto en try/catch (plantilla).';
    } else {
      generated.html =
        generated.html +
        '\n<!-- Sugerencia local -->\n<div class="ai-box">\n  <h4>' +
        escapeHtml(prompt) +
        '</h4>\n  <p>Activa el copiloto IA (Auto + AI_API_KEY) para generación real.</p>\n</div>';
      generated.css =
        generated.css +
        '\n.ai-box { background: #1e1b4b; border: 1px solid #6366f1; padding: 1rem; border-radius: 0.75rem; margin-top: 1rem; }';
      generated.message = 'Plantilla genérica. Configura IA en ⚙ para resultados reales.';
    }
    applyGenerated(generated, { via: 'plantilla' });
  }, 280);
}

async function testAiBridge() {
  try {
    const r = await fetch('/api/ai/ping', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.ok) {
      showToast('Puente IA OK · ' + (data.model || 'modelo'));
      return true;
    }
    showToast('Puente IA falló: ' + ((data && data.message) || r.status), 'error');
    return false;
  } catch (e) {
    showToast('No se pudo probar el puente IA', 'error');
    return false;
  }
}


function toggleConsoleDrawer() {
  document.getElementById('consoleModal').classList.toggle('hidden');
}

function clearConsole() {
  document.getElementById('consoleOutput').innerHTML =
    '<div class="text-slate-500 italic text-[11px]">Consola limpiada.</div>';
  logsCount = 0;
  const counter = document.getElementById('logCountHeader');
  if (counter) counter.innerText = '0';
}

function toggleAiPanel() {
  const el = document.getElementById('aiDrawer');
  if (!el) return;
  el.classList.toggle('translate-x-full');
}

function toggleMobileMenu() {
  const dd = document.getElementById('mobileDropdown');
  if (!dd) return;
  const isMobile = window.innerWidth < 768;
  if (isMobile) {
    // Position near bottom bar
    dd.classList.remove('absolute', 'right-0', 'bottom-full', 'mb-2');
    dd.classList.add('fixed', 'left-3', 'right-3');
    dd.style.bottom = 'calc(60px + env(safe-area-inset-bottom))';
    dd.style.top = 'auto';
    dd.style.width = 'auto';
  } else {
    dd.classList.add('absolute', 'right-0');
    dd.classList.remove('fixed', 'left-3', 'right-3');
    dd.style.bottom = '';
    dd.style.top = '';
    dd.style.width = '';
  }
  dd.classList.toggle('hidden');
}

function copyNativeSourceCode() {
  const html = getEditorValue('html');
  const css = getEditorValue('css');
  const js = getEditorValue('js');
  const full =
    '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="UTF-8">\n<style>\n' +
    css +
    '\n</style>\n</head>\n<body>\n' +
    html +
    '\n<script>\n' +
    js +
    '\n<\/script>\n</body>\n</html>';
  navigator.clipboard.writeText(full).then(
    () => showToast('Código fuente copiado al portapapeles.'),
    () => showToast('No se pudo copiar. Selecciona y copia manualmente.', 'warn')
  );
}

function downloadProject() {
  const html = getEditorValue('html');
  const css = getEditorValue('css');
  const js = getEditorValue('js');
  const fullContent =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' +
    css +
    '</style></head><body>' +
    html +
    '<script>' +
    js +
    '<\/script></body></html>';
  const proj = getCurrentProject();
  const fileName =
    (proj ? proj.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'proyecto') + '.html';
  const blob = new Blob([fullContent], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(a.href);
}

function showToast(msg, type) {
  const t = document.getElementById('toast');
  const icon = document.getElementById('toastIcon');
  document.getElementById('toastMsg').innerText = msg;
  if (icon) {
    if (type === 'warn') {
      icon.className = 'fa-solid fa-triangle-exclamation text-amber-400 text-sm';
    } else if (type === 'error') {
      icon.className = 'fa-solid fa-circle-xmark text-red-400 text-sm';
    } else {
      icon.className = 'fa-solid fa-circle-check text-emerald-400 text-sm';
    }
  }
  t.classList.remove('translate-y-20', 'opacity-0');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.add('translate-y-20', 'opacity-0'), 3200);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Draggable console
(function setupConsoleDrag() {
  const consoleModal = document.getElementById('consoleModal');
  const consoleHeader = document.getElementById('consoleHeader');
  if (!consoleModal || !consoleHeader) return;
  let isDragging = false,
    startX,
    startY,
    initialLeft,
    initialTop;
  consoleHeader.style.touchAction = 'none';
  consoleHeader.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest('button')) return;
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    initialLeft = consoleModal.offsetLeft;
    initialTop = consoleModal.offsetTop;
    if (consoleHeader.setPointerCapture) {
      try { consoleHeader.setPointerCapture(e.pointerId); } catch (_) {}
    }
  });
  document.addEventListener('pointermove', e => {
    if (!isDragging) return;
    consoleModal.style.left = initialLeft + (e.clientX - startX) + 'px';
    consoleModal.style.top = initialTop + (e.clientY - startY) + 'px';
    consoleModal.style.transform = 'none';
  });
  const stopConsoleDrag = () => { isDragging = false; };
  document.addEventListener('pointerup', stopConsoleDrag);
  document.addEventListener('pointercancel', stopConsoleDrag);

})();

// ---------- Reconnect when offline (E2) ----------


// ---------- Keyboard shortcuts ----------
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', e => {
    const meta = e.ctrlKey || e.metaKey;
    const tag = (e.target && e.target.tagName) || '';
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable);

    // Ctrl/Cmd+S → save now
    if (meta && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      if (!currentProjectId) return;
      if (autosaveTimer) {
        clearTimeout(autosaveTimer);
        autosaveTimer = null;
      }
      if (inCopyBranch) {
        saveInCopyBranch().then(() => showToast('Copia guardada.'));
      } else {
        saveCurrentCodeToActiveProject(true);
        showToast('Proyecto guardado.');
      }
      return;
    }

    // Ctrl/Cmd+Enter → refresh preview
    if (meta && e.key === 'Enter') {
      e.preventDefault();
      updatePreview();
      return;
    }

    // Alt+1/2/3 → tabs (works even in editor)
    if (e.altKey && !meta && (e.key === '1' || e.key === '2' || e.key === '3')) {
      e.preventDefault();
      switchTab(e.key === '1' ? 'html' : e.key === '2' ? 'css' : 'js');
      return;
    }

    // Escape → close drawers/modals
    if (e.key === 'Escape') {
      const conflict = document.getElementById('conflictModal');
      if (conflict && !conflict.classList.contains('hidden')) {
        closeConflictModal();
        return;
      }
      const authM = document.getElementById('authModal');
      if (authM && !authM.classList.contains('hidden')) {
        closeAuthModal();
        return;
      }
      const aiSet = document.getElementById('aiSettingsModal');
      if (aiSet && !aiSet.classList.contains('hidden')) {
        closeAiSettingsModal();
        return;
      }
      const np = document.getElementById('newProjectModal');
      if (np && !np.classList.contains('hidden')) {
        closeNewProjectModal();
        return;
      }
      const ai = document.getElementById('aiDrawer');
      if (ai && !ai.classList.contains('translate-x-full')) {
        toggleAiPanel();
        return;
      }
      const cons = document.getElementById('consoleModal');
      if (cons && !cons.classList.contains('hidden')) {
        toggleConsoleDrawer();
        return;
      }
    }
  });
}


/* ---------- CodeLab visual design workspace ---------- */
let selectedDesignElementId = null;
let designUndoStack = [];
let designRedoStack = [];
let designDragState = null;
let designEventsBound = false;
let designZoom = 1;

function activeDesignProject() {
  const p = projects.find(item => item.id === currentProjectId);
  if (!p || p.type !== 'design') return null;
  if (!p.design || typeof p.design !== 'object') p.design = { elements: [], frame: 'desktop', background: '#ffffff', grid: true };
  if (p.design.grid == null) p.design.grid = true;
  if (!Array.isArray(p.design.elements)) p.design.elements = [];
  return p;
}
function designSnapshot() {
  const p = activeDesignProject();
  return p ? JSON.stringify(p.design) : null;
}
function recordDesignHistory() {
  const snap = designSnapshot();
  if (snap) {
    designUndoStack.push(snap);
    if (designUndoStack.length > 60) designUndoStack.shift();
    designRedoStack = [];
    updateDesignHistoryButtons();
  }
}
function updateDesignHistoryButtons() {
  const u = document.getElementById('designUndoBtn'), r = document.getElementById('designRedoBtn');
  if (u) u.disabled = !designUndoStack.length;
  if (r) r.disabled = !designRedoStack.length;
}
function designUndo() {
  const p = activeDesignProject(); if (!p || !designUndoStack.length) return;
  designRedoStack.push(JSON.stringify(p.design));
  p.design = JSON.parse(designUndoStack.pop());
  selectedDesignElementId = null; renderDesignWorkspace(); saveProjectsToStorage(); updateDesignHistoryButtons();
}
function designRedo() {
  const p = activeDesignProject(); if (!p || !designRedoStack.length) return;
  designUndoStack.push(JSON.stringify(p.design));
  p.design = JSON.parse(designRedoStack.pop());
  selectedDesignElementId = null; renderDesignWorkspace(); saveProjectsToStorage(); updateDesignHistoryButtons();
}
function initializeDesignProject(project) {
  if (!project.design || typeof project.design !== 'object') project.design = { elements: [], frame: 'desktop', background: '#ffffff', grid: true };
  if (project.design.grid == null) project.design.grid = true;
  if (!Array.isArray(project.design.elements)) project.design.elements = [];
  selectedDesignElementId = null; designUndoStack = []; designRedoStack = [];
  designZoom = 1;
  const zoomInput = document.getElementById('designZoom');
  if (zoomInput) zoomInput.value = '100';
  const frame = document.getElementById('designFrameSize');
  if (frame) frame.value = project.design.frame || 'desktop';
  renderDesignWorkspace();
  bindDesignCanvasEvents();
  updateDesignHistoryButtons();
}

function setDesignZoom(value) {
  const next = Math.max(0.5, Math.min(1.5, Number(value) / 100 || 1));
  designZoom = next;
  const canvas = document.getElementById('designCanvas');
  if (canvas) canvas.style.zoom = String(next);
  const label = document.getElementById('designZoomLabel');
  if (label) label.textContent = Math.round(next * 100) + '%';
}
function toggleDesignGrid() {
  const p = activeDesignProject(); if (!p) return;
  recordDesignHistory(); p.design.grid = !p.design.grid;
  renderDesignWorkspace(); saveProjectsToStorage();
}
function setDesignBackground(color) {
  const p = activeDesignProject(); if (!p || !/^#[0-9a-f]{6}$/i.test(color)) return;
  recordDesignHistory(); p.design.background = color;
  renderDesignWorkspace(); saveProjectsToStorage();
}
function alignDesignElement(mode = 'center-x') {
  const p = activeDesignProject(), el = selectedDesignElement();
  if (!p || !el) { showToast('Selecciona una capa primero.', 'warn'); return; }
  recordDesignHistory();
  const width = ({desktop:1440,tablet:768,mobile:390})[p.design.frame] || 1440;
  const height = 900;
  const ew = Math.max(20, Number(el.width) || 120), eh = Math.max(20, Number(el.height) || 48);
  if (mode === 'left') el.x = 0;
  else if (mode === 'center-x') el.x = Math.max(0, Math.round((width - ew) / 2));
  else if (mode === 'right') el.x = Math.max(0, width - ew);
  else if (mode === 'top') el.y = 0;
  else if (mode === 'center-y') el.y = Math.max(0, Math.round((height - eh) / 2));
  else if (mode === 'bottom') el.y = Math.max(0, height - eh);
  renderDesignWorkspace(); saveProjectsToStorage();
}
function downloadDesignAsset(filename, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: type || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function designXmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function captureDesignSvg(project) {
  const width = ({ desktop: 1440, tablet: 768, mobile: 390 })[project.design.frame] || 1440;
  const height = 900;
  const safeColor = value => {
    const color = String(value || 'transparent').trim();
    return /^(#[0-9a-f]{3,8}|transparent|[a-z]{1,24}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/i.test(color) ? color : 'transparent';
  };
  const items = (project.design.elements || []).map(el => {
    const x = Number(el.x) || 0, y = Number(el.y) || 0;
    const w = Math.max(20, Number(el.width) || 120), h = Math.max(20, Number(el.height) || 48);
    const fontSize = Math.max(8, Number(el.fontSize) || 16);
    const radius = Math.max(0, Number(el.radius) || 0);
    const background = safeColor(el.background);
    const color = safeColor(el.color || '#111827');
    const rect = background !== 'transparent'
      ? '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + radius + '" fill="' + designXmlEscape(background) + '"/>'
      : '';
    if (el.type === 'rectangle') {
      return rect || '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + radius + '" fill="none" stroke="#cbd5e1"/>';
    }
    const raw = String(el.text || '').split(/\r?\n/);
    const maxChars = Math.max(1, Math.floor((w - 12) / (fontSize * 0.56)));
    const lines = [];
    raw.forEach(line => {
      const words = line.split(/\s+/); let current = '';
      words.forEach(word => {
        if (!word && !current) return;
        const next = current ? current + ' ' + word : word;
        if (next.length > maxChars && current) { lines.push(current); current = word; }
        else current = next;
      });
      lines.push(current);
    });
    const lineHeight = el.type === 'heading' ? fontSize * 1.1 : fontSize * 1.25;
    const totalHeight = Math.max(lineHeight, lines.length * lineHeight);
    const align = el.type === 'button' ? 'center' : (['left','center','right'].includes(el.textAlign) ? el.textAlign : 'left');
    const anchor = align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle';
    const textX = align === 'left' ? x + 6 : align === 'right' ? x + w - 6 : x + w / 2;
    const startY = y + Math.max(fontSize, (h - totalHeight) / 2 + fontSize * 0.82);
    const tspans = lines.map((line, i) => '<tspan x="' + textX + '" y="' + (startY + i * lineHeight) + '">' + designXmlEscape(line) + '</tspan>').join('');
    return rect + '<text x="' + textX + '" y="' + startY + '" fill="' + designXmlEscape(color) + '" font-family="Arial, Helvetica, sans-serif" font-size="' + fontSize + '" font-weight="' + Math.max(100, Number(el.weight) || 400) + '" text-anchor="' + anchor + '">' + tspans + '</text>';
  }).join('');
  return {
    width, height,
    svg: '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '"><rect width="100%" height="100%" fill="' + designXmlEscape(safeColor(project.design.background || '#ffffff')) + '"/>' + items + '</svg>'
  };
}

async function captureDesignForAI() {
  const project = activeDesignProject();
  if (!project || !project.design) { showToast('Abre un proyecto de diseño primero.', 'warn'); return; }
  const captured = captureDesignSvg(project);
  const slug = (project.name || 'codelab-design').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'codelab-design';
  const elements = (project.design.elements || []).map((el, index) => ({
    order: index + 1,
    id: el.id || null,
    type: el.type || 'text',
    label: el.label || el.type || 'Elemento',
    text: el.text || '',
    bounds: { x: Number(el.x) || 0, y: Number(el.y) || 0, width: Math.max(20, Number(el.width) || 120), height: Math.max(20, Number(el.height) || 48) },
    style: {
      color: el.color || '#111827',
      background: el.background || 'transparent',
      fontSize: Number(el.fontSize) || 16,
      fontWeight: Number(el.weight) || 400,
      radius: Number(el.radius) || 0,
      textAlign: ['left','center','right'].includes(el.textAlign) ? el.textAlign : 'left'
    }
  }));
  const context = {
    format: 'codelab-ai-design-capture',
    version: 1,
    project: project.name || 'Diseño sin título',
    frame: project.design.frame || 'desktop',
    image: slug + '-captura-ia.png',
    canvas: { width: captured.width, height: captured.height, background: project.design.background || '#ffffff' },
    elementCount: elements.length,
    elements,
    aiInstructions: 'Analiza la imagen PNG para evaluar la apariencia visual y usa este JSON para conocer las posiciones, dimensiones, textos y estilos exactos. No inventes contenido. Distingue los problemas observables de las sugerencias. Propón cambios concretos y accesibles y considera también la adaptación móvil. Proyecto: ' + (project.name || 'Diseño sin título') + '. Marco: ' + (project.design.frame || 'desktop') + ' (' + captured.width + ' × ' + captured.height + ' px).'
  };
  const json = JSON.stringify(context, null, 2);
  downloadDesignAsset(slug + '-contexto-ia.json', json, 'application/json;charset=utf-8');
  try {
    const svgBlob = new Blob([captured.svg], { type: 'image/svg+xml;charset=utf-8' });
    const svgUrl = URL.createObjectURL(svgBlob);
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = svgUrl;
    });
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = captured.width * scale; canvas.height = captured.height * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No se pudo crear el contexto gráfico.');
    ctx.scale(scale, scale);
    ctx.drawImage(image, 0, 0, captured.width, captured.height);
    URL.revokeObjectURL(svgUrl);
    const png = await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('El navegador no pudo generar el PNG.')), 'image/png'));
    downloadDesignAsset(slug + '-captura-ia.png', png, 'image/png');
    showToast('Captura IA lista: PNG 2×, contexto JSON y prompt.');
  } catch (error) {
    downloadDesignAsset(slug + '-captura-ia.svg', captured.svg, 'image/svg+xml;charset=utf-8');
    showToast('No se pudo generar el PNG; descargué el SVG junto al contexto.', 'warn');
  }
}

function exportDesignHtml() {
  const p = activeDesignProject(); if (!p) return;
  const elements = p.design.elements.map(el => {
    const tag = el.type === 'heading' ? 'h1' : el.type === 'button' ? 'a' : el.type === 'rectangle' ? 'div' : 'p';
    const text = el.type === 'rectangle' ? '' : escapeHtml(el.text || '');
    const style = 'position:absolute;left:'+(Number(el.x)||0)+'px;top:'+(Number(el.y)||0)+'px;width:'+(Number(el.width)||120)+'px;height:'+(Number(el.height)||48)+'px;color:'+(el.color||'#111827')+';background:'+(el.background||'transparent')+';font-size:'+(Number(el.fontSize)||16)+'px;text-align:'+(['left','center','right'].includes(el.textAlign)?el.textAlign:'left')+';font-weight:'+(Number(el.weight)||400)+';border-radius:'+(Number(el.radius)||0)+'px;display:flex;align-items:center;padding:4px;box-sizing:border-box;'+(el.type==='button'?'justify-content:center;text-decoration:none;':'');
    return '<'+tag+' style="'+style+'">'+text+'</'+tag+'>';
  }).join('\n');
  const width = ({desktop:1440,tablet:768,mobile:390})[p.design.frame] || 1440;
  const html = '<!doctype html>\n<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+escapeHtml(p.name)+'</title><style>*{box-sizing:border-box}body{margin:0;font-family:Inter,Arial,sans-serif;overflow-x:auto}.design-frame{position:relative;width:'+width+'px;min-height:900px;background:'+(p.design.background||'#fff')+';margin:0 auto}</style></head><body><main class="design-frame">'+elements+'</main></body></html>';
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = (p.name || 'codelab-design').replace(/[^a-z0-9_-]+/gi,'-') + '.html';
  document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
  showToast('Diseño exportado como HTML.');
}

function setDesignFrame(frame) {
  const p = activeDesignProject(); if (!p) return;
  recordDesignHistory();
  p.design.frame = ['desktop','tablet','mobile'].includes(frame) ? frame : 'desktop';
  const canvas = document.getElementById('designCanvas');
  const widths = { desktop: 1440, tablet: 768, mobile: 390 };
  if (canvas) canvas.style.width = widths[p.design.frame] + 'px';
  renderDesignWorkspace(); saveProjectsToStorage();
}
function addDesignElement(type) {
  const p = activeDesignProject(); if (!p) return;
  recordDesignHistory();
  const defaults = {
    heading: { label: 'Título', text: 'Título de tu diseño', x: 80, y: 70, width: 560, height: 76, color: '#111827', background: 'transparent', fontSize: 42, weight: 700, radius: 0 },
    text: { label: 'Texto', text: 'Escribe aquí tu texto', x: 84, y: 165, width: 420, height: 64, color: '#475569', background: 'transparent', fontSize: 18, weight: 400, radius: 0 },
    button: { label: 'Botón', text: 'Comenzar', x: 84, y: 250, width: 160, height: 48, color: '#ffffff', background: '#7c3aed', fontSize: 15, weight: 600, radius: 10 },
    rectangle: { label: 'Rectángulo', text: '', x: 100, y: 340, width: 240, height: 150, color: '#ffffff', background: '#dbeafe', fontSize: 16, weight: 400, radius: 16 }
  };
  const d = defaults[type] || defaults.text;
  const element = { id: 'el_' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + Math.random()), type, ...d };
  p.design.elements.push(element); selectedDesignElementId = element.id;
  renderDesignWorkspace(); saveProjectsToStorage();
}
function selectedDesignElement() {
  const p = activeDesignProject();
  return p && p.design.elements.find(el => el.id === selectedDesignElementId);
}
function selectDesignElement(id) {
  selectedDesignElementId = id; renderDesignWorkspace();
}
function renderDesignWorkspace() {
  const p = activeDesignProject(); if (!p) return;
  const canvas = document.getElementById('designCanvas');
  const layers = document.getElementById('designLayers');
  const props = document.getElementById('designProperties');
  const empty = document.getElementById('designCanvasEmpty');
  if (!canvas || !layers || !props) return;
  const widths = { desktop: 1440, tablet: 768, mobile: 390 };
  canvas.style.width = (widths[p.design.frame] || widths.desktop) + 'px';
  canvas.style.zoom = String(designZoom);
  const zoomLabel = document.getElementById('designZoomLabel');
  if (zoomLabel) zoomLabel.textContent = Math.round(designZoom * 100) + '%';
  canvas.style.backgroundColor = p.design.background || '#ffffff';
  canvas.style.backgroundImage = p.design.grid ? 'linear-gradient(#e2e8f0 1px,transparent 1px),linear-gradient(90deg,#e2e8f0 1px,transparent 1px)' : 'none';
  const bgPicker = document.getElementById('designBackgroundColor');
  if (bgPicker) bgPicker.value = /^#[0-9a-f]{6}$/i.test(p.design.background || '') ? p.design.background : '#ffffff';
  const gridBtn = document.getElementById('designGridBtn');
  if (gridBtn) gridBtn.classList.toggle('text-violet-300', !!p.design.grid);
  canvas.replaceChildren();
  if (empty && p.design.elements.length === 0) canvas.appendChild(empty);
  const sorted = p.design.elements;
  for (const el of sorted) {
    const node = document.createElement('div');
    node.dataset.designId = el.id;
    node.className = 'absolute select-none cursor-move';
    // Keep element dragging reliable on touch screens; the surrounding canvas still scrolls normally.
    node.style.touchAction = 'none';
    node.style.left = (Number(el.x) || 0) + 'px'; node.style.top = (Number(el.y) || 0) + 'px';
    node.style.width = Math.max(20, Number(el.width) || 120) + 'px'; node.style.height = Math.max(20, Number(el.height) || 48) + 'px';
    node.style.color = el.color || '#111827'; node.style.background = el.background || 'transparent';
    node.style.textAlign = ['left','center','right'].includes(el.textAlign) ? el.textAlign : 'left';
    node.style.fontSize = Math.max(8, Number(el.fontSize) || 16) + 'px'; node.style.fontWeight = String(el.weight || 400);
    node.style.borderRadius = Math.max(0, Number(el.radius) || 0) + 'px';
    node.style.display = 'flex'; node.style.alignItems = 'center';
    node.style.justifyContent = el.type === 'button' ? 'center' : 'flex-start';
    node.style.textAlign = ['left','center','right'].includes(el.textAlign) ? el.textAlign : 'left';
    node.style.padding = el.type === 'rectangle' ? '0' : '4px';
    node.style.whiteSpace = 'pre-wrap'; node.style.overflow = 'hidden';
    node.style.outline = el.id === selectedDesignElementId ? '2px solid #8b5cf6' : '1px solid transparent';
    node.style.outlineOffset = '2px';
    if (el.type === 'heading') node.style.lineHeight = '1.1';
    node.textContent = el.type === 'rectangle' ? '' : (el.text || '');
    node.setAttribute('role','button'); node.setAttribute('aria-label',el.label || el.type);
    node.addEventListener('click', ev => { ev.stopPropagation(); if (selectedDesignElementId !== el.id) { selectedDesignElementId = el.id; renderDesignWorkspace(); } });
    node.addEventListener('pointerdown', ev => {
      if (ev.button !== 0) return;
      selectedDesignElementId = el.id;
      recordDesignHistory();
      const rect = canvas.getBoundingClientRect();
      designDragState = { id: el.id, startX: ev.clientX, startY: ev.clientY, x: Number(el.x)||0, y: Number(el.y)||0, scaleX: rect.width / (Number.parseFloat(canvas.style.width)||1440) };
      node.setPointerCapture && node.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    });
    canvas.appendChild(node);
  }
  layers.innerHTML = sorted.length ? sorted.slice().reverse().map(el =>
    '<button type="button" data-design-select="' + escapeAttr(el.id) + '" class="w-full text-left px-2.5 py-2 rounded-lg text-[11px] flex items-center gap-2 ' + (el.id === selectedDesignElementId ? 'bg-violet-500/20 text-violet-200 border border-violet-500/40' : 'text-slate-300 hover:bg-slate-800 border border-transparent') + '"><i class="fa-solid ' + (el.type === 'heading' ? 'fa-heading' : el.type === 'button' ? 'fa-square-caret-right' : el.type === 'rectangle' ? 'fa-square' : 'fa-font') + '"></i><span class="truncate">' + escapeHtml(el.label || el.type) + '</span></button>'
  ).join('') : '<p class="p-2 text-[11px] text-slate-500">Sin capas todavía.</p>';
  layers.querySelectorAll('[data-design-select]').forEach(button => button.addEventListener('click', () => selectDesignElement(button.getAttribute('data-design-select'))));
  const el = selectedDesignElement();
  if (!el) {
    props.innerHTML = '<p class="text-slate-500 leading-relaxed">Selecciona una capa para editar su contenido, posición, tamaño y color.</p>';
    updateDesignHistoryButtons(); return;
  }
  const field = (label, key, type='number', extra='') => '<label class="block space-y-1"><span class="text-slate-400">' + label + '</span><input ' + extra + ' type="' + type + '" value="' + escapeAttr(el[key] == null ? '' : String(el[key])) + '" onfocus="recordDesignHistory()" oninput="updateDesignProperty(\'' + key + '\',this.value)" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-2 text-xs text-slate-100 focus:border-violet-400 outline-none"></label>';
  props.innerHTML = '<div class="text-[11px] font-bold text-violet-300">' + escapeHtml(el.label || el.type) + '</div>' +
    (el.type !== 'rectangle' ? field('Contenido','text','text') : '') +
    field('Nombre de capa','label','text') +
    '<div class="grid grid-cols-2 gap-2">' + field('X','x') + field('Y','y') + field('Ancho','width') + field('Alto','height') + '</div>' +
    '<div class="grid grid-cols-2 gap-2">' + field('Texto','color','color','') + field('Fondo','background','color','') + '</div>' +
    field('Tamaño de texto','fontSize') + field('Redondeado','radius') + (el.type !== 'rectangle' ? '<label class="block space-y-1"><span class="text-slate-400">Alineación del texto</span><select onchange="updateDesignProperty(\'textAlign\',this.value)" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-2 text-xs text-slate-100"><option value="left" '+((el.textAlign||'left')==='left'?'selected':'')+'>Izquierda</option><option value="center" '+(el.textAlign==='center'?'selected':'')+'>Centro</option><option value="right" '+(el.textAlign==='right'?'selected':'')+'>Derecha</option></select></label>' : '');
  updateDesignHistoryButtons();
}
function updateDesignProperty(key, value) {
  const el = selectedDesignElement(); if (!el) return;
  if (key === 'text' || key === 'label') el[key] = value;
  else if (key === 'color' || key === 'background') el[key] = value;
  else el[key] = Math.max(key === 'radius' ? 0 : 1, Number(value) || 0);
  const p = activeDesignProject(); if (p) p.updatedAt = new Date().toISOString();
  // Keep typing responsive; update canvas/layers without rebuilding the focused property field.
  const node = document.querySelector('[data-design-id="' + el.id + '"]');
  if (node) {
    node.textContent = el.type === 'rectangle' ? '' : (el.text || '');
    node.style.left = (Number(el.x)||0)+'px'; node.style.top = (Number(el.y)||0)+'px';
    node.style.width = Math.max(20,Number(el.width)||120)+'px'; node.style.height = Math.max(20,Number(el.height)||48)+'px';
    node.style.color = el.color || '#111827'; node.style.background = el.background || 'transparent';
    node.style.fontSize = Math.max(8,Number(el.fontSize)||16)+'px'; node.style.borderRadius = Math.max(0,Number(el.radius)||0)+'px';
    node.style.textAlign = ['left','center','right'].includes(el.textAlign) ? el.textAlign : 'left';
    node.style.justifyContent = el.type === 'button' ? 'center' : (el.textAlign === 'center' ? 'center' : el.textAlign === 'right' ? 'flex-end' : 'flex-start');
  }
  if (key === 'label') {
    const layerButtons = document.querySelectorAll('#designLayers button');
    layerButtons.forEach(b => { if (b.getAttribute('onclick') && b.getAttribute('onclick').includes(el.id)) b.lastElementChild.textContent = el.label || el.type; });
  }
  scheduleAutosave();
}
function bindDesignCanvasEvents() {
  if (designEventsBound) return; designEventsBound = true;
  document.addEventListener('pointermove', ev => {
    if (!designDragState) return;
    const el = selectedDesignElement(); if (!el || el.id !== designDragState.id) return;
    const dx = (ev.clientX - designDragState.startX) / (designDragState.scaleX || 1);
    const dy = (ev.clientY - designDragState.startY) / (designZoom || 1);
    el.x = Math.max(0, Math.round(designDragState.x + dx)); el.y = Math.max(0, Math.round(designDragState.y + dy));
    const node = document.querySelector('[data-design-id="' + el.id + '"]');
    if (node) { node.style.left = el.x + 'px'; node.style.top = el.y + 'px'; }
  });
  const finishDesignDrag = () => {
    if (!designDragState) return;
    designDragState = null; renderDesignWorkspace(); saveProjectsToStorage();
  };
  document.addEventListener('pointerup', finishDesignDrag);
  document.addEventListener('pointercancel', finishDesignDrag);
  document.getElementById('designCanvas')?.addEventListener('click', ev => {
    if (ev.target.id === 'designCanvas') { selectedDesignElementId = null; renderDesignWorkspace(); }
  });
  document.addEventListener('keydown', ev => {
    const p = activeDesignProject();
    if (!p) return;
    const target = ev.target;
    if (target && (target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(target.tagName))) return;
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      if (ev.shiftKey) designRedo(); else designUndo();
    } else if (mod && ev.key.toLowerCase() === 'y') {
      ev.preventDefault(); designRedo();
    } else if ((ev.key === 'Delete' || ev.key === 'Backspace') && selectedDesignElementId) {
      ev.preventDefault(); deleteDesignElement();
    } else if (ev.key === 'Escape' && selectedDesignElementId) {
      selectedDesignElementId = null; renderDesignWorkspace();
    }
  });
}
function duplicateDesignElement() {
  const p = activeDesignProject(), el = selectedDesignElement(); if (!p || !el) return;
  recordDesignHistory();
  const copy = { ...el, id: 'el_' + (crypto.randomUUID ? crypto.randomUUID() : Date.now()), x: (Number(el.x)||0)+24, y: (Number(el.y)||0)+24, label: (el.label || 'Capa') + ' copia' };
  p.design.elements.push(copy); selectedDesignElementId = copy.id; renderDesignWorkspace(); saveProjectsToStorage();
}
function deleteDesignElement() {
  const p = activeDesignProject(); if (!p || !selectedDesignElementId) return;
  recordDesignHistory(); p.design.elements = p.design.elements.filter(el => el.id !== selectedDesignElementId);
  selectedDesignElementId = null; renderDesignWorkspace(); saveProjectsToStorage();
}
function convertDesignToWeb() {
  const p = activeDesignProject(); if (!p) return;
  const elements = p.design.elements.map(el => {
    const tag = el.type === 'heading' ? 'h1' : el.type === 'button' ? 'a' : el.type === 'rectangle' ? 'div' : 'p';
    const text = el.type === 'rectangle' ? '' : escapeHtml(el.text || '');
    const style = 'position:absolute;left:'+(Number(el.x)||0)+'px;top:'+(Number(el.y)||0)+'px;width:'+(Number(el.width)||120)+'px;height:'+(Number(el.height)||48)+'px;color:'+(el.color||'#111827')+';background:'+(el.background||'transparent')+';font-size:'+(Number(el.fontSize)||16)+'px;font-weight:'+(Number(el.weight)||400)+';border-radius:'+(Number(el.radius)||0)+'px;display:flex;align-items:center;padding:4px;box-sizing:border-box;'+(el.type==='button'?'justify-content:center;text-decoration:none;':'');
    return '<'+tag+' style="'+style+'">'+text+'</'+tag+'>';
  }).join('\n');
  const width = ({desktop:1440,tablet:768,mobile:390})[p.design.frame] || 1440;
  const html = '<!doctype html>\n<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+escapeHtml(p.name)+'</title><style>*{box-sizing:border-box}body{margin:0;font-family:Inter,Arial,sans-serif;overflow-x:auto}.design-frame{position:relative;width:'+width+'px;min-height:900px;background:'+(p.design.background||'#fff')+';margin:0 auto}@media(max-width:'+width+'px){.design-frame{transform-origin:top left;transform:scale(calc(100vw / '+width+'));margin-bottom:calc(900px * (100vw / '+width+' - 1))}}</style></head><body><main class="design-frame">'+elements+'</main></body></html>';
  const next = { id: 'proj_' + (crypto.randomUUID ? crypto.randomUUID() : Date.now()), name: p.name + ' · Web', type: 'web', updatedAt: new Date().toISOString(), code: { html, css: '', js: '' } };
  projects.unshift(next); saveProjectsToStorage(); renderProjectsList(); openProject(next.id);
  showToast('Página web creada a partir del diseño.');
}

function setupNewProjectModalKeys() {
  const input = document.getElementById('newProjectNameInput');
  if (input) {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        createNewProjectConfirm();
      }
    });
  }
  const authIn = document.getElementById('authUsernameInput');
  if (authIn) {
    authIn.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        confirmAuthModal();
      }
    });
  }
  // Debounced search (avoids re-render on every keystroke)
  const search = document.getElementById('searchProjectInput');
  if (search && !search._codelabBound) {
    search._codelabBound = true;
    let tmr = null;
    search.removeAttribute('oninput');
    search.addEventListener('input', () => {
      if (tmr) clearTimeout(tmr);
      tmr = setTimeout(() => {
        tmr = null;
        renderProjectsList();
      }, 120);
    });
  }
}

function startReconnectLoop() {
  if (reconnectTimer) clearInterval(reconnectTimer);
  reconnectTimer = setInterval(async () => {
    if (serverReady) return;
    try {
      const r = await fetch('/api/health');
      if (!r.ok) return;
      // Try to re-init workspace
      const init = await fetch('/api/workspace/init', {
        method: 'POST',
        credentials: 'same-origin',
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          workspaceToken ? { 'x-workspace-token': workspaceToken } : {}
        ),
        body: JSON.stringify({ id: workspaceId || null })
      });
      if (!init.ok) return;
      const boot = await init.json();
      workspaceId = boot.workspaceId;
      workspaceToken = boot.token;
      lsSet(STORAGE_KEY_WORKSPACE, workspaceId);
      lsSet(STORAGE_KEY_WORKSPACE_TOKEN, workspaceToken);
      if (Number.isInteger(boot.state && boot.state.revision)) {
        // Only adopt server revision if we can; prefer local until explicit sync
        if (!projects.length && Array.isArray(boot.state.projects) && boot.state.projects.length) {
          projects = boot.state.projects;
          workspaceRevision = boot.state.revision;
        } else if (Number.isInteger(boot.state.revision)) {
          workspaceRevision = boot.state.revision;
        }
      }
      serverReady = true;
      setSyncStatus('synced', 'Reconectado');
      updateDashboardStatus();
      showToast('Conexión con el servidor restaurada.');
      await persistWorkspace();
    } catch (_) {
      // still offline
    }
  }, RECONNECT_INTERVAL_MS);
}

// ---------- Split panel resize (U1) ----------
function applySplitRatio(pct) {
  const editorPanel = document.getElementById('editorPanel');
  const previewPanel = document.getElementById('previewPanel');
  const main = document.getElementById('mainSplit');
  if (!editorPanel || !main) return;
  pct = Math.min(80, Math.max(20, Number(pct) || 50));
  const isRow = window.innerWidth >= 768;
  if (isRow) {
    editorPanel.style.width = pct + '%';
    editorPanel.style.flex = 'none';
    editorPanel.style.height = '';
    if (previewPanel) {
      previewPanel.style.width = 100 - pct + '%';
      previewPanel.style.flex = 'none';
      previewPanel.style.height = '';
    }
  } else {
    editorPanel.style.height = pct + '%';
    editorPanel.style.flex = 'none';
    editorPanel.style.width = '100%';
    if (previewPanel) {
      previewPanel.style.height = 100 - pct + '%';
      previewPanel.style.flex = 'none';
      previewPanel.style.width = '100%';
    }
  }
  try {
    lsSet('codelab_split_pct', String(pct));
  } catch (_) {}
  Object.keys(editors).forEach(k => {
    try {
      if (editors[k] && editors[k].layout) editors[k].layout();
    } catch (_) {}
  });
}

function closeSplitMenu() {
  const m = document.getElementById('splitMenu');
  if (m) m.classList.add('hidden');
}

function openSplitMenu(anchor) {
  let menu = document.getElementById('splitMenu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'splitMenu';
    menu.className =
      'hidden absolute z-50 w-52 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl py-1 text-xs text-slate-200';
    menu.innerHTML =
      '<div class="px-3 py-2 text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-800">Panel</div>' +
      '<button type="button" data-split="30" class="w-full text-left px-3 py-2.5 hover:bg-slate-800 flex items-center gap-2"><i class="fa-solid fa-left-right text-cyan-400 w-4"></i> Código 30% / Vista 70%</button>' +
      '<button type="button" data-split="50" class="w-full text-left px-3 py-2.5 hover:bg-slate-800 flex items-center gap-2"><i class="fa-solid fa-table-columns text-cyan-400 w-4"></i> 50% / 50%</button>' +
      '<button type="button" data-split="70" class="w-full text-left px-3 py-2.5 hover:bg-slate-800 flex items-center gap-2"><i class="fa-solid fa-left-right text-cyan-400 w-4"></i> Código 70% / Vista 30%</button>' +
      '<button type="button" data-split="bar" class="w-full text-left px-3 py-2.5 hover:bg-slate-800 flex items-center gap-2 border-t border-slate-800"><i class="fa-solid fa-grip-lines-vertical text-amber-400 w-4"></i> Solo ajustar barra (arrastrar)</button>';
    document.body.appendChild(menu);
    menu.addEventListener('click', e => {
      const btn = e.target.closest('[data-split]');
      if (!btn) return;
      const v = btn.getAttribute('data-split');
      if (v === 'bar') {
        closeSplitMenu();
        showToast('Arrastra la barra divisoria para ajustar el tamaño.');
        return;
      }
      applySplitRatio(Number(v));
      closeSplitMenu();
      showToast('Panel: código ' + v + '%');
    });
  }
  const rect = anchor.getBoundingClientRect();
  menu.classList.remove('hidden');
  menu.style.position = 'fixed';
  menu.style.left = Math.min(rect.left, window.innerWidth - 220) + 'px';
  menu.style.top = Math.min(rect.bottom + 6, window.innerHeight - 200) + 'px';
}

function setupSplitResize() {
  const divider = document.getElementById('splitDivider');
  const editorPanel = document.getElementById('editorPanel');
  const main = document.getElementById('mainSplit');
  if (!divider || !editorPanel || !main) return;

  // Restore saved ratio
  const saved = Number(lsGet('codelab_split_pct'));
  if (saved >= 20 && saved <= 80) applySplitRatio(saved);

  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;

  divider.style.touchAction = 'none';
  divider.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    document.body.style.cursor = window.innerWidth >= 768 ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    if (divider.setPointerCapture) {
      try { divider.setPointerCapture(e.pointerId); } catch (_) {}
    }
    closeSplitMenu();
  });

  document.addEventListener('pointermove', e => {
    if (!dragging) return;
    if (Math.abs(e.clientX - startX) > 4 || Math.abs(e.clientY - startY) > 4) moved = true;
    if (!moved) return;
    const rect = main.getBoundingClientRect();
    const isRow = window.innerWidth >= 768;
    let pct;
    if (isRow) pct = ((e.clientX - rect.left) / rect.width) * 100;
    else pct = ((e.clientY - rect.top) / rect.height) * 100;
    applySplitRatio(pct);
  });

  const stopSplitDrag = () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Tap/click without drag → open size menu.
    if (!moved) openSplitMenu(divider);
  };
  document.addEventListener('pointerup', stopSplitDrag);
  document.addEventListener('pointercancel', stopSplitDrag);

  document.addEventListener('click', e => {
    const menu = document.getElementById('splitMenu');
    if (!menu || menu.classList.contains('hidden')) return;
    if (menu.contains(e.target) || e.target === divider || divider.contains(e.target)) return;
    closeSplitMenu();
  });
}

