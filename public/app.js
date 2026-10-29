// ==========================================
// CodeLab XD Studio Pro v2.6.6
// Persistencia segura, ramas, merge 3 vías, plantillas IA locales
// ==========================================
const APP_VERSION = '2.6.6';
const STORAGE_KEY_PROJECTS = 'codelab_xd_projects_v2';
const STORAGE_KEY_PROJECTS_RECOVERY = 'codelab_xd_projects_recovery_v1';
const STORAGE_KEY_PROJECTS_WORKSPACE = 'codelab_xd_projects_workspace_v1';
const STORAGE_KEY_DELETED_PROJECTS = 'codelab_xd_deleted_projects_v1';
const STORAGE_KEY_DELETED_PROJECTS_RECOVERY = 'codelab_xd_deleted_projects_recovery_v1';
const STORAGE_KEY_PENDING_IMPORT = 'codelab_xd_pending_local_import_v1';
const STORAGE_KEY_PENDING_IMPORT_RECOVERY = 'codelab_xd_pending_import_recovery_v1';
const STORAGE_KEY_AUTH = 'codelab_xd_auth_v2';
const STORAGE_KEY_WORKSPACE = 'codelab_xd_workspace_v4';
const STORAGE_KEY_WORKSPACE_TOKEN = 'codelab_xd_workspace_token_v1';
const STORAGE_KEY_AI = 'codelab_xd_ai_settings_v1';
const AUTOSAVE_DEBOUNCE_MS = 600;
const PREVIEW_DEBOUNCE_MS = 250;
const RECONNECT_INTERVAL_MS = 15000;
const MAX_CONSOLE_LINES = 200;

let workspaceId = null;
let initialWorkspaceId = null;
let pendingLocalImportProjects = null;
let localProjectsSnapshotRecoveryFailed = false;
let localProjectsSnapshotWriteBlocked = false;
let localSnapshotBlockedWarningShown = false;
let generatedDefaultProjectId = null;
let workspaceToken = '';
let workspaceRevision = 0;
let serverSyncError = false;
let workspacePayloadTooLarge = false;
let projects = [];
let currentProjectId = null;
let currentUser = null;
let aiSettings = { mode: 'auto', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '' };
let serverAi = { serverKey: false, model: 'gpt-4o-mini', baseUrl: null, hint: '' };
let maxProjects = 50;
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
function preserveInvalidLocalProjectsSnapshot(raw, reason) {
  if (typeof raw !== 'string') return false;
  const key = STORAGE_KEY_PROJECTS_RECOVERY;
  const entry = { savedAt: new Date().toISOString(), reason: reason, raw: raw };
  const existing = lsGet(key);
  if (existing) {
    let backup;
    try { backup = JSON.parse(existing); } catch (_) {
      // An unreadable recovery slot may itself contain the only recoverable copy.
      // Never overwrite it with a new backup we cannot safely merge.
      return false;
    }
    if (!backup || typeof backup !== 'object' || Array.isArray(backup) ||
        (backup.backups != null && !Array.isArray(backup.backups))) return false;
    const extras = Array.isArray(backup.backups) ? backup.backups : [];
    if (backup.raw === raw || extras.some(item => item && item.raw === raw)) return true;
    if (typeof backup.raw === 'string') {
      // Preserve the first backup in its legacy top-level fields and append later
      // damaged snapshots instead of permanently blocking all future local saves.
      return lsSet(key, JSON.stringify({ ...backup, version: backup.version || 1, backups: extras.concat(entry) }));
    }
    if (Array.isArray(backup.backups)) {
      return lsSet(key, JSON.stringify({ ...backup, backups: extras.concat(entry) }));
    }
    return false;
  }
  return lsSet(key, JSON.stringify({
    version: 1,
    savedAt: entry.savedAt,
    reason: entry.reason,
    raw: entry.raw
  }));
}
function saveLocalProjectsSnapshot() {
  // Never overwrite a damaged snapshot unless its exact contents were first
  // preserved successfully in the recovery slot.
  if (localProjectsSnapshotRecoveryFailed || localProjectsSnapshotWriteBlocked) {
    console.warn('Local project snapshot was not overwritten because recovery backup failed.');
    if (!localSnapshotBlockedWarningShown && typeof showToast === 'function') {
      localSnapshotBlockedWarningShown = true;
      showToast('No se pudo asegurar la recuperación de la copia local. Mantén el servidor conectado y exporta tus proyectos antes de cerrar esta sesión.', 'warn');
    }
    return false;
  }
  const saved = lsSet(STORAGE_KEY_PROJECTS, JSON.stringify(projects));
  if (saved && workspaceId) lsSet(STORAGE_KEY_PROJECTS_WORKSPACE, workspaceId);
  if (saved) localSnapshotBlockedWarningShown = false;
  return saved;
}
function preserveInvalidLocalMapSnapshot(raw, recoveryKey, reason) {
  if (typeof raw !== 'string') return false;
  const entry = { savedAt: new Date().toISOString(), reason: reason, raw: raw };
  const existing = lsGet(recoveryKey);
  if (existing) {
    let backup;
    try { backup = JSON.parse(existing); } catch (_) { return false; }
    if (!backup || typeof backup !== 'object' || Array.isArray(backup) ||
        (backup.backups != null && !Array.isArray(backup.backups))) return false;
    const extras = Array.isArray(backup.backups) ? backup.backups : [];
    if (backup.raw === raw || extras.some(item => item && item.raw === raw)) return true;
    if (typeof backup.raw === 'string' || Array.isArray(backup.backups)) {
      return lsSet(recoveryKey, JSON.stringify({ ...backup, version: backup.version || 1, backups: extras.concat(entry) }));
    }
    return false;
  }
  return lsSet(recoveryKey, JSON.stringify({
    version: 1, savedAt: entry.savedAt, reason: entry.reason, raw: entry.raw
  }));
}
function isValidDeletedProjectMapSnapshot(raw) {
  try {
    const stored = JSON.parse(raw);
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return false;
    const modern = stored.byWorkspace && typeof stored.byWorkspace === 'object' && !Array.isArray(stored.byWorkspace) &&
      Object.values(stored.byWorkspace).every(ids => Array.isArray(ids) && ids.every(id => typeof id === 'string'));
    const legacy = typeof stored.workspaceId === 'string' && Array.isArray(stored.ids) &&
      stored.ids.every(id => typeof id === 'string');
    return !!(modern || legacy);
  } catch (_) { return false; }
}
function isValidPendingLocalImportSnapshot(raw) {
  try {
    const stored = JSON.parse(raw);
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return false;
    const modern = stored.byUser && typeof stored.byUser === 'object' && !Array.isArray(stored.byUser) &&
      Object.values(stored.byUser).every(projects => Array.isArray(projects));
    const legacy = typeof stored.userKey === 'string' && Array.isArray(stored.projects);
    return !!(modern || legacy);
  } catch (_) { return false; }
}
function readDeletedProjectMap() {
  const raw = lsGet(STORAGE_KEY_DELETED_PROJECTS);
  if (raw && !isValidDeletedProjectMapSnapshot(raw)) {
    preserveInvalidLocalMapSnapshot(raw, STORAGE_KEY_DELETED_PROJECTS_RECOVERY, 'invalid_deleted_project_map');
  }
  try {
    const stored = JSON.parse(raw || 'null');
    if (stored && stored.byWorkspace && typeof stored.byWorkspace === 'object' && !Array.isArray(stored.byWorkspace)) {
      // Arrays accept named properties in memory, but JSON.stringify drops them.
      // Reject this malformed envelope so deletion tombstones remain durable.
      return stored.byWorkspace;
    }
    // Read the original single-workspace format for migration.
    if (stored && typeof stored.workspaceId === 'string' && Array.isArray(stored.ids)) {
      return { [stored.workspaceId]: stored.ids };
    }
  } catch (_) {}
  return {};
}
function loadDeletedProjectIds(forWorkspaceId) {
  const byWorkspace = readDeletedProjectMap();
  return new Set(Array.isArray(byWorkspace[forWorkspaceId]) ? byWorkspace[forWorkspaceId].filter(id => typeof id === 'string') : []);
}
function recordDeletedProjectId(id) {
  if (!workspaceId || !id) return false;
  const raw = lsGet(STORAGE_KEY_DELETED_PROJECTS);
  if (raw && !isValidDeletedProjectMapSnapshot(raw) &&
      !preserveInvalidLocalMapSnapshot(raw, STORAGE_KEY_DELETED_PROJECTS_RECOVERY, 'invalid_deleted_project_map')) {
    return false;
  }
  const byWorkspace = readDeletedProjectMap();
  const ids = new Set(Array.isArray(byWorkspace[workspaceId]) ? byWorkspace[workspaceId] : []);
  ids.add(id);
  byWorkspace[workspaceId] = Array.from(ids);
  return lsSet(STORAGE_KEY_DELETED_PROJECTS, JSON.stringify({ byWorkspace: byWorkspace }));
}
function clearDeletedProjectIds(forWorkspaceId) {
  const raw = lsGet(STORAGE_KEY_DELETED_PROJECTS);
  if (raw && !isValidDeletedProjectMapSnapshot(raw) &&
      !preserveInvalidLocalMapSnapshot(raw, STORAGE_KEY_DELETED_PROJECTS_RECOVERY, 'invalid_deleted_project_map')) {
    return false;
  }
  const target = forWorkspaceId || workspaceId;
  const byWorkspace = readDeletedProjectMap();
  if (target) delete byWorkspace[target];
  if (Object.keys(byWorkspace).length) return lsSet(STORAGE_KEY_DELETED_PROJECTS, JSON.stringify({ byWorkspace: byWorkspace }));
  lsRemove(STORAGE_KEY_DELETED_PROJECTS);
  return lsGet(STORAGE_KEY_DELETED_PROJECTS) === null;
}
function currentRealUserKey() {
  return currentUser && currentUser.real ? currentUser.provider + '_' + currentUser.id : null;
}
function readPendingLocalImportMap() {
  const raw = lsGet(STORAGE_KEY_PENDING_IMPORT);
  if (raw && !isValidPendingLocalImportSnapshot(raw)) {
    preserveInvalidLocalMapSnapshot(raw, STORAGE_KEY_PENDING_IMPORT_RECOVERY, 'invalid_pending_import_map');
  }
  try {
    const saved = JSON.parse(raw || 'null');
    if (saved && saved.byUser && typeof saved.byUser === 'object' && !Array.isArray(saved.byUser)) {
      // Named account keys on an array are omitted by JSON.stringify and would
      // silently discard pending imports on the next write.
      return saved.byUser;
    }
    if (saved && typeof saved.userKey === 'string' && Array.isArray(saved.projects)) {
      return { [saved.userKey]: saved.projects };
    }
  } catch (_) {}
  return {};
}
function storePendingLocalImport(localProjects) {
  const nextProjects = Array.isArray(localProjects) ? localProjects : [];
  const raw = lsGet(STORAGE_KEY_PENDING_IMPORT);
  if (raw && !isValidPendingLocalImportSnapshot(raw) &&
      !preserveInvalidLocalMapSnapshot(raw, STORAGE_KEY_PENDING_IMPORT_RECOVERY, 'invalid_pending_import_map')) {
    pendingLocalImportProjects = nextProjects;
    return false;
  }
  const userKey = currentRealUserKey();
  if (!userKey) {
    pendingLocalImportProjects = nextProjects;
    return true;
  }
  const byUser = readPendingLocalImportMap();
  byUser[userKey] = nextProjects;
  // Do not report pending imports as durable unless localStorage confirms the write.
  // The caller can then leave the original project snapshot untouched for recovery.
  if (!lsSet(STORAGE_KEY_PENDING_IMPORT, JSON.stringify({ byUser: byUser }))) {
    pendingLocalImportProjects = nextProjects;
    return false;
  }
  pendingLocalImportProjects = nextProjects;
  // A durable account-scoped copy now exists, so the original snapshot may be
  // safely replaced by this workspace's own local state again.
  localProjectsSnapshotWriteBlocked = false;
  localSnapshotBlockedWarningShown = false;
  return true;
}
function restorePendingLocalImport() {
  const byUser = readPendingLocalImportMap();
  const userKey = currentRealUserKey();
  if (userKey && Array.isArray(byUser[userKey])) pendingLocalImportProjects = byUser[userKey];
}
function clearPendingLocalImport() {
  const raw = lsGet(STORAGE_KEY_PENDING_IMPORT);
  if (raw && !isValidPendingLocalImportSnapshot(raw) &&
      !preserveInvalidLocalMapSnapshot(raw, STORAGE_KEY_PENDING_IMPORT_RECOVERY, 'invalid_pending_import_map')) {
    return false;
  }
  const userKey = currentRealUserKey();
  const byUser = readPendingLocalImportMap();
  if (userKey) delete byUser[userKey];
  if (Object.keys(byUser).length) {
    if (!lsSet(STORAGE_KEY_PENDING_IMPORT, JSON.stringify({ byUser: byUser }))) return false;
  } else {
    lsRemove(STORAGE_KEY_PENDING_IMPORT);
    if (lsGet(STORAGE_KEY_PENDING_IMPORT) !== null) return false;
  }
  pendingLocalImportProjects = null;
  // The current workspace now owns the active snapshot; it is safe to resume
  // local saves after a previous cross-workspace recovery failure.
  localProjectsSnapshotWriteBlocked = false;
  localSnapshotBlockedWarningShown = false;
  return true;
}
function mergeWorkspaceProjects(serverProjects, localProjects, deletedIds, skipLocalIds) {
  const deleted = deletedIds instanceof Set ? deletedIds : new Set(deletedIds || []);
  const skipped = skipLocalIds instanceof Set ? skipLocalIds : new Set(skipLocalIds || []);
  const merged = new Map();
  const timestamp = project => {
    const value = Date.parse(project && project.updatedAt || '');
    return Number.isFinite(value) ? value : 0;
  };
  (Array.isArray(serverProjects) ? serverProjects : []).forEach(project => {
    if (project && typeof project.id === 'string' && !deleted.has(project.id)) merged.set(project.id, project);
  });
  (Array.isArray(localProjects) ? localProjects : []).forEach(project => {
    if (!project || typeof project.id !== 'string' || deleted.has(project.id) || skipped.has(project.id)) return;
    const serverProject = merged.get(project.id);
    if (!serverProject || timestamp(project) >= timestamp(serverProject)) merged.set(project.id, project);
  });
  return Array.from(merged.values()).sort((a, b) => timestamp(b) - timestamp(a));
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
  initialWorkspaceId = workspaceId;
  workspaceToken = lsGet(STORAGE_KEY_WORKSPACE_TOKEN) || '';
  setSyncStatus('saving', 'Conectando…');
  showBootLoading(true, 'Iniciando CodeLab…', 'Conectando con el workspace y cargando proyectos.');
  handleAuthQueryParams();
  loadAuthFromServer()
    .catch(() => loadAuthFromStorage())
    .then(() => {
      // Resolve account identity before loading provider credentials from local storage.
      loadAiSettings();
      return Promise.all([loadProjectsFromStorage(), loadServerAiStatus()]);
    })
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
        // Design projects store their canvas in the design object, not in the code editor.
        // Do not bump timestamps or replace their code when the page is merely closed.
        if (proj && proj.type !== 'design') {
          const existingCode = normalizeCode(proj.code);
          const changed = code.html !== existingCode.html || code.css !== existingCode.css || code.js !== existingCode.js;
          if (changed) {
            proj.code = code;
            proj.updatedAt = new Date().toISOString();
          }
        }
      }
    }
    saveLocalProjectsSnapshot();
  } catch (_) {}
});

async function loadProjectsFromStorage() {
  restorePendingLocalImport();
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
      try {
        const parsedLocalProjects = JSON.parse(stored);
        // Old or manually edited browser storage must never make workspace
        // bootstrap call array methods on an arbitrary JSON object.
        if (Array.isArray(parsedLocalProjects)) {
          localProjects = parsedLocalProjects;
        } else {
          localProjectsSnapshotRecoveryFailed = !preserveInvalidLocalProjectsSnapshot(stored, 'projects_not_array');
          localProjects = [];
        }
      } catch (_) {
        localProjectsSnapshotRecoveryFailed = !preserveInvalidLocalProjectsSnapshot(stored, 'invalid_json');
        localProjects = [];
      }
    }
    const localWorkspaceMarker = lsGet(STORAGE_KEY_PROJECTS_WORKSPACE) || initialWorkspaceId;
    const sameWorkspace = !!localWorkspaceMarker && localWorkspaceMarker === boot.workspaceId;
    const mayMergeLocal = sameWorkspace || !currentUser || !currentUser.real;
    if (currentUser && currentUser.real && localProjects.length && !sameWorkspace) {
      // Never silently mix another browser workspace into an OAuth account.
      // Keep it available for an explicit import after the account loads. Do
      // not overwrite a pending snapshot already preserved for this account.
      if (!(Array.isArray(pendingLocalImportProjects) && pendingLocalImportProjects.length)) {
        if (!storePendingLocalImport(localProjects)) {
          // Keep the original cross-workspace snapshot intact if its recovery
          // copy could not be persisted; startup's normal save must not replace it.
          localProjectsSnapshotWriteBlocked = true;
        }
      }
    }
    projects = mergeWorkspaceProjects(
      serverProjects,
      mayMergeLocal ? localProjects : [],
      loadDeletedProjectIds(boot.workspaceId)
    );
    workspaceRevision = Number.isInteger(data.revision) ? data.revision : 0;
    serverReady = true;
    setSyncStatus('synced', 'Sincronizado');
  } catch (e) {
    serverReady = false;
    console.warn('Servidor no disponible; usando copia local.', e);
    const stored = lsGet(STORAGE_KEY_PROJECTS);
    if (stored) {
      try {
        const parsedLocalProjects = JSON.parse(stored);
        if (!Array.isArray(parsedLocalProjects)) {
          localProjectsSnapshotRecoveryFailed = !preserveInvalidLocalProjectsSnapshot(stored, 'projects_not_array');
          throw new Error('local_projects_invalid');
        }
        const localProjects = parsedLocalProjects;
        const localWorkspaceMarker = lsGet(STORAGE_KEY_PROJECTS_WORKSPACE) || initialWorkspaceId;
        if (!currentUser || !currentUser.real || localWorkspaceMarker === workspaceId) {
          projects = mergeWorkspaceProjects([], localProjects, loadDeletedProjectIds(workspaceId));
        } else {
          if (!storePendingLocalImport(Array.isArray(localProjects) ? localProjects : [])) {
            // In offline startup the source snapshot is the only durable copy.
            localProjectsSnapshotWriteBlocked = true;
          }
          projects = [];
        }
      } catch (error) {
        if (error && error.message === 'local_projects_invalid') {
          // Recovery backup was attempted above; retain the raw snapshot if
          // storage was unavailable rather than pretending it was recovered.
        } else if (stored) {
          localProjectsSnapshotRecoveryFailed = !preserveInvalidLocalProjectsSnapshot(stored, 'invalid_json');
        }
        projects = [];
      }
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
    generatedDefaultProjectId = 'proj_' + (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now());
    projects.push({
      id: generatedDefaultProjectId,
      name: 'Mi Primer Proyecto',
      updatedAt: new Date().toISOString(),
      code: normalizeCode(defaultTemplate)
    });
  }
  if (serverReady) await persistWorkspace();
  else saveLocalProjectsSnapshot();
}

function persistWorkspace() {
  saveLocalProjectsSnapshot();
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
          updateDashboardStatus();
          setSyncStatus('conflict', 'Conflicto');
          // A newer save can queue while this request is in flight; fail every waiter on terminal conflict.
          resolveSyncWaiters(false, Number.MAX_SAFE_INTEGER);
          showConflictModal(data);
          break;
        }
        if (r.status === 429) {
          syncGeneration = 0;
          // All queued saves are deferred to the scheduled retry, so none may remain unresolved.
          resolveSyncWaiters(false, Number.MAX_SAFE_INTEGER);
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
        if (r.status === 400) {
          // A validation error means the server is reachable. Keep the workspace
          // online so a corrected next save can recover; do not misclassify this
          // as a network outage and permanently disable sync for the page session.
          let details = {};
          try { details = await r.json(); } catch (_) {}
          syncGeneration = 0;
          serverSyncError = true;
          resolveSyncWaiters(false, Number.MAX_SAFE_INTEGER);
          setSyncStatus('offline', 'Datos no válidos · solo local');
          updateDashboardStatus();
          const reason = details.detail || details.error || 'invalid_payload';
          showToast('El servidor rechazó los datos (' + reason + '). Tus cambios siguen guardados localmente; revisa los datos y vuelve a guardar.', 'warn');
          break;
        }
        if (r.status === 413) {
          // A newer save may already contain fewer projects or less code; try
          // that latest snapshot before deciding the workspace is too large.
          if (syncGeneration !== generationAtStart) {
            resolveSyncWaiters(false, generationAtStart);
            continue;
          }
          syncGeneration = 0;
          workspacePayloadTooLarge = true;
          resolveSyncWaiters(false, generationAtStart);
          setSyncStatus('offline', 'Límite de tamaño · solo local');
          updateDashboardStatus();
          showToast('El workspace supera el límite de tamaño del servidor. Tus cambios siguen guardados localmente; elimina o exporta proyectos para volver a sincronizar.', 'warn');
          break;
        }
        if (!r.ok) throw new Error('workspace_save_failed');
        const data = await r.json();
        workspaceRevision = data.revision;
        syncRetryAttempt = 0;
        serverSyncError = false;
        workspacePayloadTooLarge = false;
        updateDashboardStatus();
        if (syncGeneration === generationAtStart) {
          clearDeletedProjectIds(workspaceId);
          if (generatedDefaultProjectId && projects.some(project => project.id === generatedDefaultProjectId)) {
            generatedDefaultProjectId = null;
          }
        }
        resolveSyncWaiters(true, generationAtStart);
        setSyncStatus(inCopyBranch ? 'branch' : 'synced', inCopyBranch ? 'Copia · Guardada' : 'Sincronizado');
        if (syncGeneration === generationAtStart) break;
      } catch (e) {
        serverReady = false;
        syncGeneration = 0;
        resolveSyncWaiters(false, Number.MAX_SAFE_INTEGER);
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
  return persistWorkspace();
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
    // A successful HTTP status is not enough: reject malformed snapshots before
    // mutating memory or localStorage, otherwise a broken response can erase the
    // editor's current project list.
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        !Array.isArray(data.projects) ||
        !Number.isInteger(data.revision) || data.revision < 0) {
      console.warn('Workspace refresh returned an invalid snapshot.');
      return false;
    }
    projects = data.projects;
    workspaceRevision = data.revision;
    saveLocalProjectsSnapshot();
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
  saveLocalProjectsSnapshot();
  clearDeletedProjectIds();
  pendingConflict = null;
  clearDeletedProjectIds(workspaceId);
  closeConflictModal();
  serverSyncError = false;
  updateDashboardStatus();
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
      const sourceId = String(sp.id || 'project');
      const already = projects.some(p =>
        p.serverBackupOf === sourceId ||
        (typeof p.id === 'string' && p.id.startsWith('srv_bak_' + sourceId + '_'))
      );
      if (already) return;
      const backupSuffix = ' (servidor ' + stamp + ')';
      projects.unshift({
        // Keep backup IDs and names within the server's validation limits even
        // when the source project already uses the maximum allowed length.
        id: 'srv_bak_' + sourceId.slice(0, 45) + '_' + Date.now().toString(36),
        serverBackupOf: sourceId,
        name: (String(sp.name || 'Proyecto').slice(0, 200 - backupSuffix.length) || 'Proyecto') + backupSuffix,
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
  updateDashboardStatus();
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
  if (projects.length >= maxProjects) {
    showToast('Has alcanzado el límite de ' + maxProjects + ' proyectos de este workspace. Elimina o exporta uno antes de crear otro.', 'warn');
    return;
  }
  const name = document.getElementById('newProjectNameInput').value.trim() || 'Proyecto sin título';
  if (name.length > 200) {
    showToast('El nombre del proyecto no puede superar los 200 caracteres.', 'warn');
    return;
  }
  const selectedType = document.querySelector('input[name="newProjectType"]:checked');
  const type = selectedType && selectedType.value === 'design' ? 'design' : 'web';
  const newProj = {
    id: 'proj_' + crypto.randomUUID(),
    name: name,
    type,
    updatedAt: new Date().toISOString(),
    code: { ...defaultTemplate },
    ...(type === 'design' ? { design: { elements: [], frame: 'desktop', background: '#ffffff', grid: true, gridSize: 8, snapToGrid: false } } : {})
  };
  projects.unshift(newProj);
  saveProjectsToStorage();
  closeNewProjectModal();
  renderProjectsList();
  openProject(newProj.id);
  showToast('Proyecto "' + name + '" creado.');
}

async function deleteProject(id, e) {
  if (e) e.stopPropagation();
  if (!confirm('¿Eliminar este proyecto permanentemente?')) return;
  const index = projects.findIndex(project => project && project.id === id);
  if (index < 0) return;
  const deletedProject = projects[index];
  const previousCurrentProjectId = currentProjectId;
  const previousInCopyBranch = inCopyBranch;
  const previousIsCopyBranchCreated = isCopyBranchCreated;
  const tombstoneSaved = recordDeletedProjectId(id);
  projects = projects.filter(project => project.id !== id);
  if (currentProjectId === id) {
    currentProjectId = null;
    inCopyBranch = false;
    isCopyBranchCreated = false;
  }
  let synchronized = false;
  try { synchronized = await saveProjectsToStorage() === true; } catch (_) {}
  if (synchronized || tombstoneSaved) {
    renderProjectsList();
    showToast(
      synchronized
        ? 'Proyecto eliminado y sincronizado.'
        : 'Proyecto eliminado localmente; la marca de eliminación quedó guardada y se sincronizará al recuperar la conexión.',
      synchronized ? 'info' : 'warn'
    );
    return;
  }
  // Without either a durable tombstone or a confirmed server delete, rollback.
  // Otherwise the old server copy could reappear on the next workspace merge.
  projects.splice(Math.min(index, projects.length), 0, deletedProject);
  currentProjectId = previousCurrentProjectId;
  inCopyBranch = previousInCopyBranch;
  isCopyBranchCreated = previousIsCopyBranchCreated;
  saveLocalProjectsSnapshot();
  renderProjectsList();
  showToast('No se pudo asegurar la eliminación; se conservó el proyecto para evitar que reaparezca o se pierda.', 'error');
}

function duplicateProjectFromDashboard(id, e) {
  if (e) e.stopPropagation();
  if (projects.length >= maxProjects) {
    showToast('Has alcanzado el límite de ' + maxProjects + ' proyectos de este workspace. Elimina o exporta uno antes de duplicar.', 'warn');
    return;
  }
  const orig = projects.find(p => p.id === id);
  if (!orig) return;
  const dup = {
    id: 'proj_' + crypto.randomUUID(),
    name: String(orig.name || 'Proyecto').slice(0, 200 - ' (Copia)'.length) + ' (Copia)',
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
  if (!currentProjectId) return Promise.resolve(false);
  const active = projects.find(p => p.id === currentProjectId);
  if (active && active.type === 'design') {
    active.updatedAt = new Date().toISOString();
    if (immediate) {
      if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
      return saveProjectsToStorage();
    }
    scheduleAutosave();
    return Promise.resolve(true);
  }
  const code = normalizeCode({
    html: getEditorValue('html'),
    css: getEditorValue('css'),
    js: getEditorValue('js')
  });
  if (inCopyBranch) {
    copyProjectCode = JSON.parse(JSON.stringify(code));
    return persistBranch(!!immediate);
  }
  const proj = projects.find(p => p.id === currentProjectId);
  if (!proj) return Promise.resolve(false);
  proj.code = code;
  proj.updatedAt = new Date().toISOString();
  if (immediate) {
    if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
    return saveProjectsToStorage();
  }
  scheduleAutosave();
  return Promise.resolve(true);
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
  // Flush account work before dropping its bearer token. If the server cannot
  // accept the latest snapshot, preserve it in that user's pending-import slot.
  if (currentUser && currentUser.real) {
    const saved = await persistWorkspace();
    if (!saved) {
      const preserved = storePendingLocalImport(projects);
      if (!preserved) {
        // Logging out would delete the only active snapshot while offline work
        // has nowhere durable to go. Keep the account/session intact and let the
        // user retry after freeing browser storage.
        showToast('No se cerró la sesión porque no se pudieron proteger los cambios pendientes. Libera espacio del navegador e inténtalo de nuevo.', 'error');
        return;
      }
      pendingLocalImportProjects = null;
    }
  }
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (_) {}
  currentUser = null;
  lsRemove(STORAGE_KEY_AUTH);
  // The workspace token is a bearer credential independent of the session
  // cookie, so logout must remove it and start a fresh anonymous workspace.
  workspaceId = null;
  initialWorkspaceId = null;
  workspaceToken = '';
  workspaceRevision = 0;
  serverReady = false;
  projects = [];
  currentProjectId = null;
  pendingLocalImportProjects = null;
  lsRemove(STORAGE_KEY_WORKSPACE);
  lsRemove(STORAGE_KEY_WORKSPACE_TOKEN);
  lsRemove(STORAGE_KEY_PROJECTS);
  lsRemove(STORAGE_KEY_PROJECTS_WORKSPACE);
  loadAiSettings();
  updateAuthUI();
  showToast('Sesión cerrada.');
  // Reload into a new anonymous workspace without the previous account's token.
  try {
    await loadProjectsFromStorage();
    window.dispatchEvent(new Event('codelab-workspace-ready'));
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
    let local = Array.isArray(pendingLocalImportProjects) ? pendingLocalImportProjects : null;
    if (!local) {
      const raw = lsGet(STORAGE_KEY_PROJECTS);
      if (!raw) return;
      local = JSON.parse(raw);
    }
    if (!Array.isArray(local) || local.length === 0) return;
    const flag = 'codelab_import_offered_' + (currentUser.provider + '_' + currentUser.id);
    if (lsGet(flag)) {
      clearPendingLocalImport();
      return;
    }
    lsSet(flag, '1');
    const ok = confirm(
      'Hay ' + local.length +
        ' proyecto(s) guardados en otro workspace de este navegador. ¿Importarlos a tu cuenta sin reemplazar los proyectos actuales?'
    );
    if (!ok) {
      clearPendingLocalImport();
      return;
    }
    const existingIds = new Set(projects.map(project => project.id));
    const availableSlots = Math.max(0, maxProjects - projects.length);
    const seenIds = new Set(existingIds);
    const candidates = local.filter(project => project && typeof project === 'object' && !Array.isArray(project)).map((project, index) => ({
      ...project,
      id: typeof project.id === 'string' && project.id ? project.id : 'proj_import_' + Date.now() + '_' + index,
      name: typeof project.name === 'string' && project.name.trim() ? project.name.trim().slice(0, 200) : 'Proyecto importado',
      type: project.type === 'design' ? 'design' : 'web',
      code: normalizeCode(project.code)
    })).filter(project => {
      if (seenIds.has(project.id)) return false;
      seenIds.add(project.id);
      return true;
    });
    // Imports must obey the same server-configured project cap as creation and duplication.
    // Otherwise the client immediately enters a state the server will reject on every save.
    const imported = candidates.slice(0, availableSlots);
    const skippedProjects = candidates.slice(imported.length);
    const skipped = skippedProjects.length;
    if (skipped > 0 && !storePendingLocalImport(skippedProjects)) {
      // Do not overwrite the original local snapshot if overflow recovery could
      // not be persisted. The user can retry after storage space becomes available.
      lsRemove(flag);
      showToast('No se pudo guardar la lista de proyectos pendientes. No se importó nada; libera espacio del navegador e inténtalo de nuevo.', 'error');
      return;
    }
    projects = imported.concat(projects);
    if (skipped > 0) {
      // The overflow list is durable before the imported subset can overwrite the source snapshot.
      lsRemove(flag);
    } else {
      clearPendingLocalImport();
    }
    saveProjectsToStorage();
    renderProjectsList();
    if (skipped > 0) {
      showToast(imported.length
        ? imported.length + ' proyecto(s) importados. ' + skipped + ' quedan guardados para importar después de liberar espacio.'
        : 'Los proyectos siguen guardados para importarlos cuando liberes espacio en tu cuenta.', 'warn');
    } else {
      showToast(imported.length ? imported.length + ' proyecto(s) local(es) importados a tu cuenta.' : 'Los proyectos locales ya estaban presentes en tu cuenta.');
    }
  } catch (_) {}
}
function updateDashboardStatus() {
  const badge = document.getElementById('dashSyncBadge');
  const wid = document.getElementById('dashWorkspaceId');
  if (badge) {
    if (workspacePayloadTooLarge) {
      badge.innerHTML = '<i class="fa-solid fa-triangle-exclamation mr-1 text-amber-300"></i> Solo local · límite de tamaño';
      badge.className = 'px-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-300';
    } else if (serverSyncError) {
      badge.innerHTML = '<i class="fa-solid fa-triangle-exclamation mr-1 text-amber-300"></i> Sincronización pendiente · revisar';
      badge.className = 'px-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-300';
    } else if (currentUser && currentUser.real) {
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
    'window.parent.postMessage({type:"CONSOLE_LOG",logType:"error",message:"Línea "+line+":"+col+" - "+msg}, "*");' +
    '};' +
    'console.log=function(){var a=[].slice.call(arguments);window.parent.postMessage({type:"CONSOLE_LOG",logType:"log",message:a.join(" ")},"*");};' +
    'console.error=function(){var a=[].slice.call(arguments);window.parent.postMessage({type:"CONSOLE_LOG",logType:"error",message:a.join(" ")},"*");};' +
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
  // Only the preview iframe may report console output. Its sandbox intentionally
  // omits allow-same-origin, so its origin is opaque ("null") and cannot access
  // the app's localStorage or authenticated workspace credentials.
  const previewFrame = document.getElementById('previewIframe');
  if (!previewFrame || e.source !== previewFrame.contentWindow) return;
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
  if (!proj || !isCopyBranchCreated) return false;
  proj.branch = {
    id: copyBranchId || 'branch_' + Date.now(),
    baseCode: cloneCode(copyBaseCode),
    code: cloneCode(copyProjectCode),
    baseMainUpdatedAt: proj.branch?.baseMainUpdatedAt || proj.updatedAt,
    updatedAt: new Date().toISOString()
  };
  copyBranchId = proj.branch.id;
  if (immediate) {
    if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
    return saveProjectsToStorage();
  }
  scheduleAutosave();
  return true;
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

async function duplicateProject() {
  const proj = getCurrentProject();
  if (!proj) return;
  if (!inCopyBranch) await saveCurrentCodeToActiveProject(true);
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
  const saved = await persistBranch(true);
  updateBranchButtons();
  showToast(
    saved === true
      ? 'Copia de trabajo creada y sincronización confirmada. El original queda aislado.'
      : 'Copia de trabajo creada en esta sesión, pero no se confirmó la sincronización. Revisa el estado de guardado.',
    saved === true ? 'info' : 'warn'
  );
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
  const ok = await persistBranch(true);
  showToast(
    ok === false
      ? 'No se confirmó la sincronización de la copia. Se mantienen los cambios en el editor; revisa el estado de guardado.'
      : 'Cambios guardados y sincronización confirmada únicamente en la copia.',
    ok === false ? 'warn' : 'info'
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
  const branchSaved = await saveInCopyBranch();
  if (!branchSaved) {
    showToast('No se puede fusionar todavía: guarda y sincroniza la copia antes de continuar.', 'warn');
    return;
  }
  const refreshed = await refreshWorkspaceFromServer();
  if (!refreshed) {
    showToast('No se pudo verificar la versión principal del servidor. No se fusionó nada; inténtalo de nuevo cuando vuelva la conexión.', 'warn');
    return;
  }
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
function aiSettingsStorageKey() {
  const userKey = currentRealUserKey();
  return userKey ? STORAGE_KEY_AI + ':' + userKey : STORAGE_KEY_AI;
}

function aiForceLocalStorageKey() {
  const userKey = currentRealUserKey();
  return userKey ? 'codelab_ai_force_local_v1:' + userKey : 'codelab_ai_force_local_v1';
}

function loadAiSettings() {
  const userKey = currentRealUserKey();
  // Old releases used one browser-wide key. Never reuse it after a real account
  // is known: its owner cannot be determined safely, and it may contain another
  // account's provider secret.
  if (userKey) {
    lsRemove(STORAGE_KEY_AI);
    lsRemove('codelab_ai_force_local_v1');
  }
  aiSettings = { mode: 'auto', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '' };
  const raw = lsGet(aiSettingsStorageKey());
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
    if (Number.isInteger(data.maxProjects) && data.maxProjects > 0 && data.maxProjects <= 500) {
      maxProjects = data.maxProjects;
    }
    // Server has AI: force Auto unless user explicitly locked Local after seeing the new UI
    if (serverAi.serverKey) {
      const lockLocal = lsGet(aiForceLocalStorageKey()) === '1';
      if (!lockLocal && aiSettings.mode === 'local') {
        aiSettings.mode = 'auto';
        lsSet(aiSettingsStorageKey(), JSON.stringify(aiSettings));
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
  lsSet(aiSettingsStorageKey(), JSON.stringify(aiSettings));
  if (mode === 'local') lsSet(aiForceLocalStorageKey(), '1');
  else lsRemove(aiForceLocalStorageKey());
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
        // saveInCopyBranch owns its success/failure messaging.
        saveInCopyBranch();
      } else {
        saveCurrentCodeToActiveProject(true).then(ok => {
          showToast(
            ok === true
              ? 'Proyecto guardado y sincronizado.'
              : 'No se confirmó el guardado/sincronización del proyecto. Revisa el estado de guardado.',
            ok === true ? 'info' : 'warn'
          );
        }).catch(() => {
          showToast('Falló el guardado del proyecto. Revisa el estado de guardado e inténtalo de nuevo.', 'error');
        });
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
let selectedDesignElementIds = [];
let designUndoStack = [];
let designRedoStack = [];
let designDragState = null;
let designEventsBound = false;
let designZoom = 1;
const MAX_DESIGN_ELEMENTS = 500;

function activeDesignProject() {
  const p = projects.find(item => item.id === currentProjectId);
  if (!p || p.type !== 'design') return null;
  if (!p.design || typeof p.design !== 'object' || Array.isArray(p.design)) {
    p.design = { elements: [], frame: 'desktop', background: '#ffffff', grid: true };
  }
  if (p.design.grid == null) p.design.grid = true;
  if (!['free','auto'].includes(p.design.layoutMode)) p.design.layoutMode = 'free';
  if (!['row','column'].includes(p.design.layoutDirection)) p.design.layoutDirection = 'row';
  p.design.layoutGap = Number.isFinite(Number(p.design.layoutGap)) ? Math.max(0, Math.min(200, Number(p.design.layoutGap))) : 16;
  p.design.layoutPadding = Number.isFinite(Number(p.design.layoutPadding)) ? Math.max(0, Math.min(200, Number(p.design.layoutPadding))) : 24;
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
  const next = Math.max(0.1, Math.min(1.5, Number(value) / 100 || 1));
  designZoom = next;
  const canvas = document.getElementById('designCanvas');
  if (canvas) canvas.style.zoom = String(next);
  const label = document.getElementById('designZoomLabel');
  if (label) label.textContent = Math.round(next * 100) + '%';
  const slider = document.getElementById('designZoom');
  if (slider) slider.value = String(Math.round(next * 100 / 5) * 5);
}
function fitDesignToViewport() {
  const project = activeDesignProject();
  const canvas = document.getElementById('designCanvas');
  const viewport = document.getElementById('designCanvasScroll');
  if (!project || !canvas || !viewport) return;
  const widths = { desktop: 1440, tablet: 768, mobile: 390 };
  const frameWidth = widths[project.design.frame] || widths.desktop;
  const availableWidth = Math.max(200, viewport.clientWidth - 64);
  const fitScale = Math.min(1, availableWidth / frameWidth);
  const snappedScale = Math.max(0.1, Math.floor(fitScale * 20) / 20);
  setDesignZoom(Math.round(snappedScale * 100));
}
function toggleDesignGrid() {
  const p = activeDesignProject(); if (!p) return;
  recordDesignHistory(); p.design.grid = !p.design.grid;
  renderDesignWorkspace(); saveProjectsToStorage();
}
function toggleDesignSnap() {
  const p = activeDesignProject(); if (!p) return;
  recordDesignHistory(); p.design.snapToGrid = !p.design.snapToGrid;
  renderDesignWorkspace(); saveProjectsToStorage();
}
function setDesignGridSize(value) {
  const p = activeDesignProject(); if (!p) return;
  const size = [4, 8, 16, 32].includes(Number(value)) ? Number(value) : 8;
  if ((Number(p.design.gridSize) || 8) === size) return;
  recordDesignHistory(); p.design.gridSize = size;
  renderDesignWorkspace(); saveProjectsToStorage();
}
function setDesignBackground(color) {
  const p = activeDesignProject(); if (!p || !/^#[0-9a-f]{6}$/i.test(color)) return;
  recordDesignHistory(); p.design.background = color;
  renderDesignWorkspace(); saveProjectsToStorage();
}
function distributeDesignElements(axis = 'horizontal') {
  const p = activeDesignProject();
  if (p && p.design.layoutMode === 'auto') { showToast('Auto Layout distribuye las capas automáticamente; cambia a modo libre para distribuir manualmente.', 'warn'); return; }
  const selected = p && p.design ? p.design.elements.filter(el => selectedDesignElementIds.includes(el.id)) : [];
  if (selected.length < 3) { showToast('Selecciona al menos tres capas (Shift + clic) para distribuirlas.', 'warn'); return; }
  const horizontal = axis !== 'vertical';
  const ordered = selected.slice().sort((a, b) => (Number(horizontal ? a.x : a.y) || 0) - (Number(horizontal ? b.x : b.y) || 0));
  const start = Number(horizontal ? ordered[0].x : ordered[0].y) || 0;
  const last = ordered[ordered.length - 1];
  const end = (Number(horizontal ? last.x : last.y) || 0) + Math.max(20, Number(horizontal ? last.width : last.height) || (horizontal ? 120 : 48));
  const totalSize = ordered.reduce((sum, el) => sum + Math.max(20, Number(horizontal ? el.width : el.height) || (horizontal ? 120 : 48)), 0);
  const gap = (end - start - totalSize) / (ordered.length - 1);
  if (gap < 0) { showToast('No hay espacio suficiente para distribuir estas capas sin solaparlas.', 'warn'); return; }
  // Record history only after validation; a rejected operation must not create
  // a fake undo step for a state that never changed.
  recordDesignHistory();
  let cursor = start;
  for (const el of ordered) {
    if (horizontal) el.x = Math.round(cursor); else el.y = Math.round(cursor);
    cursor += Math.max(20, Number(horizontal ? el.width : el.height) || (horizontal ? 120 : 48)) + gap;
  }
  renderDesignWorkspace(); saveProjectsToStorage();
  showToast(horizontal ? 'Capas distribuidas horizontalmente.' : 'Capas distribuidas verticalmente.');
}

function alignDesignElement(mode = 'center-x') {
  const p = activeDesignProject(), el = selectedDesignElement();
  if (!p || !el) { showToast('Selecciona una capa primero.', 'warn'); return; }
  if (p.design.layoutMode === 'auto') { showToast('En Auto Layout la posición se calcula por flujo; cambia a modo libre para alinear manualmente.', 'warn'); return; }
  const selected = p.design.elements.filter(item => selectedDesignElementIds.includes(item.id));
  if (selected.length > 1) {
    const left = Math.min(...selected.map(item => Number(item.x) || 0));
    const top = Math.min(...selected.map(item => Number(item.y) || 0));
    const right = Math.max(...selected.map(item => (Number(item.x) || 0) + Math.max(20, Number(item.width) || 120)));
    const bottom = Math.max(...selected.map(item => (Number(item.y) || 0) + Math.max(20, Number(item.height) || 48)));
    const centerX = (left + right) / 2, centerY = (top + bottom) / 2;
    recordDesignHistory();
    for (const item of selected) {
      const width = Math.max(20, Number(item.width) || 120), height = Math.max(20, Number(item.height) || 48);
      if (mode === 'left') item.x = left;
      else if (mode === 'center-x') item.x = Math.round(centerX - width / 2);
      else if (mode === 'right') item.x = right - width;
      else if (mode === 'top') item.y = top;
      else if (mode === 'center-y') item.y = Math.round(centerY - height / 2);
      else if (mode === 'bottom') item.y = bottom - height;
    }
    renderDesignWorkspace(); saveProjectsToStorage();
    showToast('Capas alineadas respecto a la selección.');
    return;
  }
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
  let clicked = false;
  link.href = url; link.download = filename;
  try {
    document.body.appendChild(link);
    link.click();
    clicked = true;
  } finally {
    link.remove();
    if (clicked) setTimeout(() => URL.revokeObjectURL(url), 1500);
    else URL.revokeObjectURL(url);
  }
}

function designXmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function captureDesignSvg(project) {
  const width = ({ desktop: 1440, tablet: 768, mobile: 390 })[project.design.frame] || 1440;
  const layout = getDesignLayoutPositions(project.design);
  const height = layout.height;
  const safeColor = value => {
    const color = String(value || 'transparent').trim();
    return /^(#[0-9a-f]{3,8}|transparent|[a-z]{1,24}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/i.test(color) ? color : 'transparent';
  };
  const items = (Array.isArray(project.design.elements) ? project.design.elements.filter(el => !!el && typeof el === 'object') : []).map(el => {
    const position = layout.positions.get(el.id) || { x: Number(el.x) || 0, y: Number(el.y) || 0 };
    const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    const x = Math.max(-6000, Math.min(6000, finite(position.x, 0))), y = Math.max(-6000, Math.min(6000, finite(position.y, 0)));
    const w = Math.max(20, Math.min(4000, finite(el.width, 120) || 120)), h = Math.max(20, Math.min(4000, finite(el.height, 48) || 48));
    const fontSize = Math.max(8, Math.min(256, finite(el.fontSize, 16) || 16));
    const radius = Math.max(0, Math.min(4000, finite(el.radius, 0)));
    const background = safeColor(el.background);
    const color = safeColor(el.color || '#111827');
    const rect = background !== 'transparent'
      ? '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + radius + '" fill="' + designXmlEscape(background) + '"/>'
      : '';
    if (el.type === 'rectangle') {
      return rect || '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + radius + '" fill="none" stroke="#cbd5e1"/>';
    }
    if (el.type === 'ellipse') {
      const ellipseFill = background !== 'transparent' ? ' fill="' + designXmlEscape(background) + '"' : ' fill="none" stroke="#cbd5e1"';
      return '<ellipse cx="' + (x + w / 2) + '" cy="' + (y + h / 2) + '" rx="' + (w / 2) + '" ry="' + (h / 2) + '"' + ellipseFill + '/>';
    }
    if (el.type === 'image') {
      const source = safeDesignImageSource(el.src);
      const fit = el.objectFit === 'contain' ? 'xMidYMid meet' : el.objectFit === 'fill' ? 'none' : 'xMidYMid slice';
      if (source) return rect + '<image href="' + designXmlEscape(source) + '" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" preserveAspectRatio="' + fit + '"/>';
      return rect + '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + radius + '" fill="#e2e8f0"/><text x="' + (x + w / 2) + '" y="' + (y + h / 2) + '" fill="#475569" font-size="12" text-anchor="middle">Imagen sin archivo</text>';
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
    return rect + '<text x="' + textX + '" y="' + startY + '" fill="' + designXmlEscape(color) + '" font-family="Arial, Helvetica, sans-serif" font-size="' + fontSize + '" font-weight="' + Math.max(100, Math.min(900, Number.isFinite(Number(el.weight)) ? Number(el.weight) : 400)) + '" text-anchor="' + anchor + '">' + tspans + '</text>';
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
  const scaleControl = document.getElementById('designCaptureScale');
  const scale = [1, 2, 3].includes(Number(scaleControl && scaleControl.value)) ? Number(scaleControl.value) : 2;
  const pixelCount = captured.width * captured.height * scale * scale;
  const slug = (project.name || 'codelab-design').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'codelab-design';
  const designLayout = getDesignLayoutPositions(project.design);
  const elements = (Array.isArray(project.design.elements) ? project.design.elements.filter(el => !!el && typeof el === 'object') : []).map((el, index) => {
    const position = designLayout.positions.get(el.id) || { x: Number(el.x) || 0, y: Number(el.y) || 0 };
    const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    const x = Math.max(-6000, Math.min(6000, finite(position.x, 0)));
    const y = Math.max(-6000, Math.min(6000, finite(position.y, 0)));
    const width = Math.max(20, Math.min(4000, finite(el.width, 120) || 120));
    const height = Math.max(20, Math.min(4000, finite(el.height, 48) || 48));
    const fontSize = Math.max(8, Math.min(256, finite(el.fontSize, 16) || 16));
    const fontWeight = Math.max(100, Math.min(900, finite(el.weight, 400)));
    const radius = Math.max(0, Math.min(4000, finite(el.radius, 0)));
    return {
      order: index + 1,
    id: el.id || null,
    type: el.type || 'text',
    label: el.label || el.type || 'Elemento',
    text: el.text || '',
    bounds: { x, y, width, height },
    style: {
      color: el.color || '#111827',
      background: el.background || 'transparent',
      fontSize,
      fontWeight,
      radius,
      textAlign: ['left','center','right'].includes(el.textAlign) ? el.textAlign : 'left'
      }
    };
  });
  const context = {
    format: 'codelab-ai-design-capture',
    version: 1,
    project: project.name || 'Diseño sin título',
    frame: project.design.frame || 'desktop',
    image: slug + '-captura-ia.png',
    canvas: { width: captured.width, height: captured.height, pixelWidth: captured.width * scale, pixelHeight: captured.height * scale, scale, background: project.design.background || '#ffffff' },
    elementCount: elements.length,
    elements,
    aiInstructions: 'Analiza la imagen PNG para evaluar la apariencia visual y usa este JSON para conocer las posiciones, dimensiones, textos y estilos exactos. No inventes contenido. Distingue los problemas observables de las sugerencias. Propón cambios concretos y accesibles y considera también la adaptación móvil. Proyecto: ' + (project.name || 'Diseño sin título') + '. Marco: ' + (project.design.frame || 'desktop') + ' (' + captured.width + ' × ' + captured.height + ' px).'
  };
  const json = JSON.stringify(context, null, 2);
  downloadDesignAsset(slug + '-contexto-ia.json', json, 'application/json;charset=utf-8');
  let svgUrl = '';
  try {
    if (pixelCount > 32000000) throw new Error('La captura ocuparía demasiada memoria. Elige una escala menor.');
    const svgBlob = new Blob([captured.svg], { type: 'image/svg+xml;charset=utf-8' });
    svgUrl = URL.createObjectURL(svgBlob);
    const image = new Image();
    await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => finish(new Error('El SVG tardó demasiado en renderizarse.')), 10000);
      function finish(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        image.onload = null;
        image.onerror = null;
        if (error) reject(error);
        else resolve();
      }
      image.onload = () => finish();
      image.onerror = () => finish(new Error('No se pudo renderizar el SVG.'));
      image.src = svgUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = captured.width * scale; canvas.height = captured.height * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No se pudo crear el contexto gráfico.');
    ctx.scale(scale, scale);
    ctx.drawImage(image, 0, 0, captured.width, captured.height);
    const png = await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('El navegador no pudo generar el PNG.')), 'image/png'));
    downloadDesignAsset(slug + '-captura-ia.png', png, 'image/png');
    showToast('Captura IA lista: PNG ' + scale + '× (' + canvas.width + '×' + canvas.height + ' px) y contexto JSON.');
  } catch (error) {
    downloadDesignAsset(slug + '-captura-ia.svg', captured.svg, 'image/svg+xml;charset=utf-8');
    showToast('No se pudo generar el PNG; descargué el SVG junto al contexto.', 'warn');
  } finally {
    if (svgUrl) URL.revokeObjectURL(svgUrl);
  }
}

function safeDesignExportColor(value, fallback) {
  const color = String(value || fallback || '#ffffff').trim();
  return /^(#[0-9a-f]{3,8}|transparent|[a-z]{1,24}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/i.test(color) ? color : (fallback || '#ffffff');
}

function exportDesignHtml() {
  const p = activeDesignProject();
  if (!p || !p.design) { showToast('Abre un proyecto de diseño primero.', 'warn'); return; }
  const layout = getDesignLayoutPositions(p.design);
  const layoutPositions = layout.positions;
  const autoLayout = p.design.layoutMode === 'auto';
  const layoutDirection = p.design.layoutDirection === 'column' ? 'column' : 'row';
  const layoutGap = Math.max(0, Math.min(200, Number(p.design.layoutGap) || 0));
  const layoutPadding = Math.max(0, Math.min(200, Number(p.design.layoutPadding) || 0));
  const elements = (Array.isArray(p.design.elements) ? p.design.elements : []).map(el => {
    const imageSource = el.type === 'image' ? safeDesignImageSource(el.src) : '';
    const buttonHref = el.type === 'button' ? safeDesignLink(el.href) : '';
    const tag = el.type === 'image' ? (imageSource ? 'img' : 'div') : el.type === 'heading' ? 'h1' : el.type === 'button' ? 'a' : el.type === 'rectangle' ? 'div' : 'p';
    const text = el.type === 'rectangle' || (el.type === 'image' && imageSource) ? '' : el.type === 'image' ? 'Añade una imagen' : escapeHtml(el.text || '');
    const color = safeDesignExportColor(el.color, '#111827');
    const background = safeDesignExportColor(el.background, 'transparent');
    const position = layoutPositions.get(el.id) || { x: Number(el.x) || 0, y: Number(el.y) || 0 };
    const x = Number.isFinite(Number(position.x)) ? Number(position.x) : 0;
    const y = Number.isFinite(Number(position.y)) ? Number(position.y) : 0;
    const width = Math.max(20, Math.min(4000, Number(el.width) || 120));
    const height = Math.max(20, Math.min(4000, Number(el.height) || 48));
    const fontSize = Math.max(8, Math.min(240, Number(el.fontSize) || 16));
    const weight = Math.max(100, Math.min(900, Number(el.weight) || 400));
    const radius = Math.max(0, Math.min(500, Number(el.radius) || 0));
    const align = ['left','center','right'].includes(el.textAlign) ? el.textAlign : 'left';
    const style = (autoLayout ? 'position:relative;left:auto;top:auto;flex:0 0 auto;max-width:100%;' : 'position:absolute;left:'+x+'px;top:'+y+'px;')+'width:'+width+'px;height:'+height+'px;color:'+color+';background:'+background+';font-size:'+fontSize+'px;text-align:'+align+';font-weight:'+weight+';'+(el.type==='ellipse'?'border-radius:50%;':'border-radius:'+radius+'px;')+'display:flex;align-items:center;padding:4px;box-sizing:border-box;'+(el.type==='button'?'justify-content:center;text-decoration:none;':'')+(el.type==='image'?'padding:0;object-fit:'+(['contain','cover','fill'].includes(el.objectFit)?el.objectFit:'cover')+';':'');
    const domId = designLayerDomId(el.id);
    if (el.type === 'image' && imageSource) return '<img id="'+escapeAttr(domId)+'" src="'+escapeAttr(imageSource)+'" alt="'+escapeAttr(String(el.alt || el.label || 'Imagen').slice(0,300))+'" style="'+style+'">';
    return '<'+tag+' id="'+escapeAttr(domId)+'"'+designLinkAttributes(buttonHref)+' style="'+style+'">'+text+'</'+tag+'>';
  }).join('\n');
  const frameWidth = ({desktop:1440,tablet:768,mobile:390})[p.design.frame] || 1440;
  const frameBackground = safeDesignExportColor(p.design.background, '#ffffff');
  const frameStyle = autoLayout
    ? 'position:relative;width:100%;max-width:'+frameWidth+'px;min-height:900px;height:auto;display:flex;flex-direction:'+layoutDirection+';flex-wrap:'+(layoutDirection==='row'?'wrap':'nowrap')+';gap:'+layoutGap+'px;padding:'+layoutPadding+'px;align-items:flex-start;background:'+frameBackground+';margin:0 auto;'
    : 'position:relative;width:'+frameWidth+'px;height:900px;background:'+frameBackground+';transform-origin:top left;margin:0';
  const frameClass = 'design-frame' + (autoLayout ? ' auto-layout' : '');
  const mobileCss = autoLayout ? '@media(max-width:768px){.design-frame.auto-layout{flex-direction:column;flex-wrap:nowrap;align-items:stretch}.design-frame.auto-layout>*{max-width:100%}}' : '';
  const html = '<!doctype html>\n<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+escapeHtml(p.name)+'</title><style>*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:Inter,Arial,sans-serif;overflow-x:hidden}.design-viewport{position:relative;width:100%;overflow:hidden}.design-frame{transform-origin:top left}'+mobileCss+'</style></head><body><div class="design-viewport"><main id="designFrame" class="'+frameClass+'" style="'+frameStyle+'">'+elements+'</main></div><script>(function(){var f=document.getElementById("designFrame");var v=f.parentNode;var w='+frameWidth+';var h=900;function fit(){if(f.classList.contains("auto-layout")){f.style.transform="none";f.style.marginLeft="auto";v.style.height="auto";return;}var s=Math.min(1,Math.max(0.1,window.innerWidth/w));f.style.transform="scale("+s+")";f.style.marginLeft=Math.max(0,(window.innerWidth-w*s)/2)+"px";v.style.height=(h*s)+"px";}window.addEventListener("resize",fit,{passive:true});fit();})();<\/script></body></html>'
  const slug = (p.name || 'codelab-design').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'') || 'codelab-design';
  downloadDesignAsset(slug + '.html', html, 'text/html;charset=utf-8');
  showToast('Diseño exportado como HTML adaptable.');
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
  if (p.design.elements.length >= MAX_DESIGN_ELEMENTS) {
    showToast('Este diseño alcanzó el límite de ' + MAX_DESIGN_ELEMENTS + ' capas. Elimina alguna para añadir otra.', 'warn');
    return;
  }
  recordDesignHistory();
  const defaults = {
    heading: { label: 'Título', text: 'Título de tu diseño', x: 80, y: 70, width: 560, height: 76, color: '#111827', background: 'transparent', fontSize: 42, weight: 700, radius: 0 },
    text: { label: 'Texto', text: 'Escribe aquí tu texto', x: 84, y: 165, width: 420, height: 64, color: '#475569', background: 'transparent', fontSize: 18, weight: 400, radius: 0 },
    button: { label: 'Botón', text: 'Comenzar', x: 84, y: 250, width: 160, height: 48, color: '#ffffff', background: '#7c3aed', fontSize: 15, weight: 600, radius: 10, href: '' },
    rectangle: { label: 'Rectángulo', text: '', x: 100, y: 340, width: 240, height: 150, color: '#ffffff', background: '#dbeafe', fontSize: 16, weight: 400, radius: 16 },
    ellipse: { label: 'Elipse', text: '', x: 140, y: 340, width: 160, height: 160, color: '#ffffff', background: '#c4b5fd', fontSize: 16, weight: 400, radius: 9999 },
    image: { label: 'Imagen', text: '', x: 120, y: 420, width: 240, height: 160, color: '#111827', background: '#e2e8f0', fontSize: 16, weight: 400, radius: 8, src: '', alt: 'Imagen del diseño', objectFit: 'cover' }
  };
  const d = defaults[type] || defaults.text;
  const element = { id: 'el_' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + Math.random()), type, ...d };
  p.design.elements.push(element); selectedDesignElementId = element.id; selectedDesignElementIds = [element.id];
  renderDesignWorkspace(); saveProjectsToStorage();
}
function selectedDesignElement() {
  const p = activeDesignProject();
  return p && p.design.elements.find(el => el.id === selectedDesignElementId);
}
function selectDesignElement(id, additive = false) {
  if (additive) {
    const current = selectedDesignElementIds.length ? selectedDesignElementIds.slice() : (selectedDesignElementId ? [selectedDesignElementId] : []);
    selectedDesignElementIds = current.includes(id) ? current.filter(item => item !== id) : current.concat(id);
    if (!selectedDesignElementIds.includes(selectedDesignElementId)) selectedDesignElementId = selectedDesignElementIds[selectedDesignElementIds.length - 1] || null;
    else if (!selectedDesignElementId) selectedDesignElementId = selectedDesignElementIds[selectedDesignElementIds.length - 1] || null;
  } else {
    selectedDesignElementId = id;
    selectedDesignElementIds = id ? [id] : [];
  }
  renderDesignWorkspace();
}
function designLayerDomId(id) {
  return 'layer-' + String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);
}
function safeDesignLink(value) {
  const source = String(value || '').trim();
  if (!source || source.length > 2048) return '';
  if (/^#layer-[a-z0-9_-]{1,120}$/i.test(source)) return source;
  try {
    const url = new URL(source);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return url.href;
  } catch (_) {}
  return '';
}
function designLinkAttributes(value) {
  const href = safeDesignLink(value);
  if (!href) return '';
  if (href.startsWith('#layer-')) return ' href="' + escapeAttr(href) + '"';
  return ' href="' + escapeAttr(href) + '" target="_blank" rel="noopener noreferrer"';
}
function setDesignPrototypeTarget(value) {
  updateDesignProperty('href', value);
  const input = document.getElementById('designProperty-href');
  if (input) input.value = safeDesignLink(value);
}
function safeDesignImageSource(value) {
  const source = String(value || '').trim();
  if (!source || source.length > 2800000) return '';
  if (/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(source)) return source;
  try {
    const url = new URL(source, window.location.href);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return url.href;
  } catch (_) {}
  return '';
}
function renderDesignImageContent(node, el) {
  const resizeHandle = node.querySelector('[data-design-resize-handle]');
  Array.from(node.childNodes).forEach(child => { if (child !== resizeHandle) child.remove(); });
  const appendContent = child => resizeHandle ? node.insertBefore(child, resizeHandle) : node.appendChild(child);
  const src = safeDesignImageSource(el.src);
  if (src) {
    const image = document.createElement('img');
    image.src = src;
    image.alt = String(el.alt || el.label || 'Imagen del diseño').slice(0, 300);
    image.draggable = false;
    image.style.width = '100%'; image.style.height = '100%';
    image.style.objectFit = ['contain','cover','fill'].includes(el.objectFit) ? el.objectFit : 'cover';
    image.style.display = 'block';
    appendContent(image);
  } else {
    const placeholder = document.createElement('div');
    placeholder.textContent = 'Añade una URL o archivo de imagen';
    placeholder.style.cssText = 'display:flex;width:100%;height:100%;align-items:center;justify-content:center;text-align:center;padding:8px;font-size:12px;color:#475569;background:#e2e8f0;';
    appendContent(placeholder);
  }
}
function importDesignImage(file) {
  const project = activeDesignProject(), element = selectedDesignElement();
  if (!project || !element || element.type !== 'image' || !file) return;
  const allowedTypes = ['image/png','image/jpeg','image/webp','image/gif'];
  if (!allowedTypes.includes(file.type)) { showToast('Usa una imagen PNG, JPEG, WebP o GIF.', 'warn'); return; }
  if (file.size > 2 * 1024 * 1024) { showToast('La imagen supera el límite de 2 MB. Reduce su tamaño e inténtalo de nuevo.', 'warn'); return; }
  const reader = new FileReader();
  reader.onerror = () => showToast('No se pudo leer el archivo de imagen.', 'warn');
  reader.onload = () => {
    const src = safeDesignImageSource(reader.result);
    if (!src) { showToast('El archivo no produjo una imagen válida.', 'warn'); return; }
    recordDesignHistory();
    element.src = src;
    if (!element.alt || element.alt === 'Imagen del diseño') element.alt = file.name.replace(/\.[^.]+$/, '').slice(0, 300);
    project.updatedAt = new Date().toISOString();
    renderDesignWorkspace(); saveProjectsToStorage();
    showToast('Imagen añadida al diseño.');
  };
  reader.readAsDataURL(file);
}
function getDesignLayoutPositions(design) {
  const elements = Array.isArray(design && design.elements) ? design.elements.filter(el => !!el && typeof el === 'object') : [];
  const frameWidth = ({ desktop: 1440, tablet: 768, mobile: 390 })[design && design.frame] || 1440;
  const mode = design && design.layoutMode === 'auto' ? 'auto' : 'free';
  const positions = new Map();
  if (mode === 'free') {
    let contentBottom = 0;
    for (const el of elements) {
      const x = Number.isFinite(Number(el.x)) ? Number(el.x) : 0;
      const y = Number.isFinite(Number(el.y)) ? Number(el.y) : 0;
      const height = Math.max(20, Math.min(4000, Number(el.height) || 48));
      positions.set(el.id, { x, y });
      contentBottom = Math.max(contentBottom, y + height);
    }
    return { positions, height: Math.min(6000, Math.max(900, contentBottom + 24)), mode, frameWidth };
  }
  const direction = design.layoutDirection === 'column' ? 'column' : 'row';
  const gap = Math.max(0, Math.min(200, Number(design.layoutGap) || 0));
  const padding = Math.max(0, Math.min(200, Number(design.layoutPadding) || 0));
  let x = padding, y = padding, rowHeight = 0;
  for (const el of elements) {
    const width = Math.max(20, Math.min(4000, Number(el.width) || 120));
    const height = Math.max(20, Math.min(4000, Number(el.height) || 48));
    if (direction === 'row') {
      if (x > padding && x + width > frameWidth - padding) {
        x = padding; y += rowHeight + gap; rowHeight = 0;
      }
      positions.set(el.id, { x, y });
      x += width + gap; rowHeight = Math.max(rowHeight, height);
    } else {
      positions.set(el.id, { x: padding, y });
      y += height + gap;
    }
  }
  const contentBottom = direction === 'row' ? y + rowHeight : y - gap;
  return { positions, height: Math.min(6000, Math.max(900, contentBottom + padding)), mode, frameWidth, direction, gap, padding };
}
function setDesignLayoutMode(value) {
  const p = activeDesignProject(); if (!p) return;
  recordDesignHistory();
  p.design.layoutMode = value === 'auto' ? 'auto' : 'free';
  renderDesignWorkspace(); saveProjectsToStorage();
}
function setDesignLayoutDirection(value) {
  const p = activeDesignProject(); if (!p) return;
  recordDesignHistory();
  p.design.layoutDirection = value === 'column' ? 'column' : 'row';
  renderDesignWorkspace(); saveProjectsToStorage();
}
function setDesignLayoutGap(value) {
  const p = activeDesignProject(); if (!p) return;
  const gap = Number(value);
  if (!Number.isFinite(gap)) return;
  recordDesignHistory(); p.design.layoutGap = Math.max(0, Math.min(200, Math.round(gap)));
  renderDesignWorkspace(); saveProjectsToStorage();
}
function setDesignLayoutPadding(value) {
  const p = activeDesignProject(); if (!p) return;
  const padding = Number(value);
  if (!Number.isFinite(padding)) return;
  recordDesignHistory(); p.design.layoutPadding = Math.max(0, Math.min(200, Math.round(padding)));
  renderDesignWorkspace(); saveProjectsToStorage();
}
function renderDesignWorkspace() {
  const p = activeDesignProject(); if (!p) return;
  const canvas = document.getElementById('designCanvas');
  const layers = document.getElementById('designLayers');
  const props = document.getElementById('designProperties');
  const empty = document.getElementById('designCanvasEmpty');
  if (!canvas || !layers || !props) return;
  const validIds = new Set(p.design.elements.map(el => el.id));
  selectedDesignElementIds = selectedDesignElementIds.filter(id => validIds.has(id));
  if (selectedDesignElementId && !validIds.has(selectedDesignElementId)) selectedDesignElementId = null;
  const widths = { desktop: 1440, tablet: 768, mobile: 390 };
  const layout = getDesignLayoutPositions(p.design);
  canvas.style.width = (widths[p.design.frame] || widths.desktop) + 'px';
  canvas.style.height = layout.height + 'px';
  canvas.style.zoom = String(designZoom);
  const zoomLabel = document.getElementById('designZoomLabel');
  if (zoomLabel) zoomLabel.textContent = Math.round(designZoom * 100) + '%';
  canvas.style.backgroundColor = p.design.background || '#ffffff';
  const gridSize = [4, 8, 16, 32].includes(Number(p.design.gridSize)) ? Number(p.design.gridSize) : 8;
  canvas.style.backgroundImage = p.design.grid ? 'linear-gradient(#e2e8f0 1px,transparent 1px),linear-gradient(90deg,#e2e8f0 1px,transparent 1px)' : 'none';
  canvas.style.backgroundSize = p.design.grid ? gridSize + 'px ' + gridSize + 'px' : '';
  const bgPicker = document.getElementById('designBackgroundColor');
  if (bgPicker) bgPicker.value = /^#[0-9a-f]{6}$/i.test(p.design.background || '') ? p.design.background : '#ffffff';
  const gridBtn = document.getElementById('designGridBtn');
  if (gridBtn) gridBtn.classList.toggle('text-violet-300', !!p.design.grid);
  const snapBtn = document.getElementById('designSnapBtn');
  if (snapBtn) {
    snapBtn.classList.toggle('text-violet-300', !!p.design.snapToGrid);
    snapBtn.setAttribute('aria-pressed', String(!!p.design.snapToGrid));
  }
  const gridSizeSelect = document.getElementById('designGridSize');
  if (gridSizeSelect) gridSizeSelect.value = String(gridSize);
  canvas.replaceChildren();
  if (empty && p.design.elements.length === 0) canvas.appendChild(empty);
  const sorted = p.design.elements;
  for (const el of sorted) {
    const node = document.createElement('div');
    node.dataset.designId = el.id;
    node.className = 'absolute select-none cursor-move';
    // Keep element dragging reliable on touch screens; the surrounding canvas still scrolls normally.
    node.style.touchAction = 'none';
    const layoutPosition = layout.positions.get(el.id) || { x: Number(el.x) || 0, y: Number(el.y) || 0 };
    node.style.left = layoutPosition.x + 'px'; node.style.top = layoutPosition.y + 'px';
    node.style.width = Math.max(20, Number(el.width) || 120) + 'px'; node.style.height = Math.max(20, Number(el.height) || 48) + 'px';
    node.style.color = el.color || '#111827'; node.style.background = el.background || 'transparent';
    node.style.textAlign = ['left','center','right'].includes(el.textAlign) ? el.textAlign : 'left';
    node.style.fontSize = Math.max(8, Number(el.fontSize) || 16) + 'px'; node.style.fontWeight = String(el.weight || 400);
    node.style.borderRadius = el.type === 'ellipse' ? '50%' : Math.max(0, Number(el.radius) || 0) + 'px';
    node.style.display = 'flex'; node.style.alignItems = 'center';
    node.style.justifyContent = el.type === 'button' ? 'center' : 'flex-start';
    node.style.textAlign = ['left','center','right'].includes(el.textAlign) ? el.textAlign : 'left';
    node.style.padding = (el.type === 'rectangle' || el.type === 'image') ? '0' : '4px';
    node.style.whiteSpace = 'pre-wrap'; node.style.overflow = 'hidden';
    node.style.outline = selectedDesignElementIds.includes(el.id) || (!selectedDesignElementIds.length && el.id === selectedDesignElementId) ? '2px solid #8b5cf6' : '1px solid transparent';
    node.style.outlineOffset = '2px';
    if (el.type === 'heading') node.style.lineHeight = '1.1';
    if (el.type === 'image') renderDesignImageContent(node, el);
    else node.textContent = el.type === 'rectangle' ? '' : (el.text || '');
    if (el.id === selectedDesignElementId && selectedDesignElementIds.length <= 1) {
      const resizeHandle = document.createElement('span');
      resizeHandle.dataset.designResizeHandle = el.id;
      resizeHandle.setAttribute('role', 'slider');
      resizeHandle.setAttribute('aria-label', 'Redimensionar ' + (el.label || el.type));
      resizeHandle.setAttribute('aria-valuetext', Math.round(Number(el.width)||120) + ' por ' + Math.round(Number(el.height)||48) + ' píxeles');
      resizeHandle.tabIndex = 0;
      resizeHandle.style.cssText = 'position:absolute;right:0;bottom:0;width:14px;height:14px;border:2px solid #fff;border-radius:3px;background:#7c3aed;box-shadow:0 0 0 1px #7c3aed;cursor:nwse-resize;z-index:5;touch-action:none;';
      resizeHandle.addEventListener('pointerdown', ev => {
        if (ev.button !== 0) return;
        ev.preventDefault(); ev.stopPropagation();
        selectedDesignElementId = el.id;
        recordDesignHistory();
        const rect = canvas.getBoundingClientRect();
        designDragState = { mode: 'resize', id: el.id, startX: ev.clientX, startY: ev.clientY, width: Number(el.width)||120, height: Number(el.height)||48, scaleX: rect.width / (Number.parseFloat(canvas.style.width)||1440) };
        try { resizeHandle.setPointerCapture(ev.pointerId); } catch (_) {}
      });
      resizeHandle.addEventListener('keydown', ev => {
        if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(ev.key)) return;
        ev.preventDefault(); ev.stopPropagation();
        recordDesignHistory();
        const step = ev.shiftKey ? 10 : 1;
        if (ev.key === 'ArrowLeft') el.width = Math.max(20, (Number(el.width)||120) - step);
        if (ev.key === 'ArrowRight') el.width = Math.min(4000, (Number(el.width)||120) + step);
        if (ev.key === 'ArrowUp') el.height = Math.max(20, (Number(el.height)||48) - step);
        if (ev.key === 'ArrowDown') el.height = Math.min(4000, (Number(el.height)||48) + step);
        const resizeId = el.id;
        renderDesignWorkspace();
        const nextHandle = Array.from(document.querySelectorAll('[data-design-resize-handle]')).find(item => item.dataset.designResizeHandle === resizeId);
        if (nextHandle) nextHandle.focus();
        saveProjectsToStorage();
      });
      node.appendChild(resizeHandle);
    }
    node.setAttribute('role','button'); node.setAttribute('aria-label',el.label || el.type); node.tabIndex = 0;
    if (el.type === 'button' && safeDesignLink(el.href)) node.title = 'Alt + clic para probar navegación';
    node.addEventListener('click', ev => {
      ev.stopPropagation();
      if (ev.altKey && el.type === 'button' && safeDesignLink(el.href)) {
        const destination = safeDesignLink(el.href);
        if (destination.startsWith('#layer-')) {
          const target = Array.from(document.querySelectorAll('[data-design-id]')).find(item => designLayerDomId(item.dataset.designId) === destination.slice(1));
          if (target) {
            selectDesignElement(target.dataset.designId, false);
            const selectedTarget = Array.from(document.querySelectorAll('[data-design-id]')).find(item => item.dataset.designId === target.dataset.designId);
            if (selectedTarget) { selectedTarget.focus(); selectedTarget.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
            showToast('Destino interno del prototipo seleccionado.');
          } else showToast('No se encontró la capa de destino.', 'warn');
        } else window.open(destination, '_blank', 'noopener,noreferrer');
        return;
      }
      if (ev.shiftKey || ev.metaKey || ev.ctrlKey) selectDesignElement(el.id, true);
      else if (selectedDesignElementId !== el.id || selectedDesignElementIds.length !== 1) selectDesignElement(el.id, false);
    });
    node.addEventListener('pointerdown', ev => {
      if (ev.button !== 0) return;
      if (ev.shiftKey || ev.metaKey || ev.ctrlKey) { ev.preventDefault(); return; }
      if (activeDesignProject()?.design.layoutMode === 'auto') return;
      if (ev.altKey && el.type === 'button' && safeDesignLink(el.href)) { ev.preventDefault(); return; }
      // A plain drag acts on one layer; Shift/Ctrl/Meta-click is reserved for multi-selection.
      selectedDesignElementId = el.id;
      selectedDesignElementIds = [el.id];
      node.focus();
      recordDesignHistory();
      const rect = canvas.getBoundingClientRect();
      designDragState = { id: el.id, startX: ev.clientX, startY: ev.clientY, x: Number(el.x)||0, y: Number(el.y)||0, scaleX: rect.width / (Number.parseFloat(canvas.style.width)||1440) };
      node.setPointerCapture && node.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    });
    canvas.appendChild(node);
  }
  layers.innerHTML = sorted.length ? sorted.slice().reverse().map(el =>
    '<button type="button" data-design-select="' + escapeAttr(el.id) + '" class="w-full text-left px-2.5 py-2 rounded-lg text-[11px] flex items-center gap-2 ' + (selectedDesignElementIds.includes(el.id) || el.id === selectedDesignElementId ? 'bg-violet-500/20 text-violet-200 border border-violet-500/40' : 'text-slate-300 hover:bg-slate-800 border border-transparent') + '"><i class="fa-solid ' + (el.type === 'heading' ? 'fa-heading' : el.type === 'button' ? 'fa-square-caret-right' : el.type === 'rectangle' ? 'fa-square' : el.type === 'ellipse' ? 'fa-circle' : el.type === 'image' ? 'fa-image' : 'fa-font') + '"></i><span class="truncate">' + escapeHtml(el.label || el.type) + '</span></button>'
  ).join('') : '<p class="p-2 text-[11px] text-slate-500">Sin capas todavía.</p>';
  layers.querySelectorAll('[data-design-select]').forEach(button => button.addEventListener('click', ev => selectDesignElement(button.getAttribute('data-design-select'), ev.shiftKey || ev.ctrlKey || ev.metaKey)));
  const layoutControls = '<section class="rounded-xl border border-slate-700 bg-slate-900/70 p-3 mb-3 space-y-2"><div class="text-[11px] font-bold text-violet-300">Distribución del diseño</div>' +
    '<label class="block space-y-1"><span class="text-slate-400 text-[11px]">Modo de colocación</span><select id="designLayoutMode" aria-label="Modo de colocación" onchange="setDesignLayoutMode(this.value)" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-2 text-xs text-slate-100"><option value="free" '+((p.design.layoutMode||'free')==='free'?'selected':'')+'>Libre (posiciones manuales)</option><option value="auto" '+(p.design.layoutMode==='auto'?'selected':'')+'>Auto Layout (flujo)</option></select></label>' +
    (p.design.layoutMode === 'auto' ? '<label class="block space-y-1"><span class="text-slate-400 text-[11px]">Dirección</span><select id="designLayoutDirection" aria-label="Dirección Auto Layout" onchange="setDesignLayoutDirection(this.value)" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-2 text-xs text-slate-100"><option value="row" '+((p.design.layoutDirection||'row')==='row'?'selected':'')+'>Fila con ajuste de línea</option><option value="column" '+(p.design.layoutDirection==='column'?'selected':'')+'>Columna</option></select></label>' +
      '<div class="grid grid-cols-2 gap-2"><label class="block space-y-1"><span class="text-slate-400 text-[11px]">Espacio (px)</span><input id="designLayoutGap" type="number" min="0" max="200" value="'+Math.max(0,Math.min(200,Number(p.design.layoutGap)||0))+'" onchange="setDesignLayoutGap(this.value)" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-2 text-xs text-slate-100"></label><label class="block space-y-1"><span class="text-slate-400 text-[11px]">Relleno (px)</span><input id="designLayoutPadding" type="number" min="0" max="200" value="'+Math.max(0,Math.min(200,Number(p.design.layoutPadding)||0))+'" onchange="setDesignLayoutPadding(this.value)" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-2 text-xs text-slate-100"></label></div>'
    : '<p class="text-[10px] text-slate-500">Auto Layout organiza las capas por orden, espacio y relleno; al activarlo se deshabilita el arrastre libre.</p>') + '</section>';
  const el = selectedDesignElement();
  if (!el) {
    props.innerHTML = layoutControls + '<p class="text-slate-500 leading-relaxed">Selecciona una capa para editar su contenido, posición, tamaño y color.</p>';
    updateDesignHistoryButtons(); return;
  }
  const field = (label, key, type='number', extra='') => {
    const fieldValue = key === 'src' && String(el.src || '').startsWith('data:image/') ? '' : (el[key] == null ? '' : String(el[key]));
    return '<label class="block space-y-1"><span class="text-slate-400">' + label + '</span><input id="designProperty-' + key + '" ' + extra + ' type="' + type + '" value="' + escapeAttr(fieldValue) + '" onfocus="recordDesignHistory()" oninput="updateDesignProperty(\'' + key + '\',this.value)" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-2 text-xs text-slate-100 focus:border-violet-400 outline-none"></label>';
  };
  const buttonTargetOptions = p.design.elements.filter(item => item.id !== el.id).map(item => {
    const target = '#' + designLayerDomId(item.id);
    return '<option value="' + escapeAttr(target) + '" ' + (el.href === target ? 'selected' : '') + '>' + escapeHtml(item.label || item.type || 'Capa') + '</option>';
  }).join('');
  const buttonControls = el.type === 'button'
    ? field('Destino del botón (URL o capa)','href','text','placeholder="https://ejemplo.com o #layer-…"') +
      '<label class="block space-y-1"><span class="text-slate-400">Destino dentro del diseño</span><select id="designPrototypeTarget" aria-label="Destino interno del prototipo" onchange="setDesignPrototypeTarget(this.value)" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-2 text-xs text-slate-100"><option value="">Sin destino interno</option>' + buttonTargetOptions + '</select></label>'
    : '';
  const imageControls = el.type === 'image'
    ? '<label class="block space-y-1"><span class="text-slate-400">Archivo (máx. 2 MB)</span><input id="designImageFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onchange="importDesignImage(this.files && this.files[0])" class="w-full text-[11px] text-slate-300"></label>' +
      field('URL de imagen','src','url','placeholder="URL HTTP(S) o sube un archivo"') + field('Texto alternativo','alt','text') +
      '<label class="block space-y-1"><span class="text-slate-400">Ajuste de imagen</span><select id="designProperty-objectFit" onchange="updateDesignProperty(\'objectFit\',this.value)" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-2 text-xs text-slate-100"><option value="cover" '+((el.objectFit||'cover')==='cover'?'selected':'')+'>Cubrir</option><option value="contain" '+(el.objectFit==='contain'?'selected':'')+'>Contener</option><option value="fill" '+(el.objectFit==='fill'?'selected':'')+'>Estirar</option></select></label>'
    : '';
  const layerIndex = p.design.elements.findIndex(item => item.id === el.id);
  props.innerHTML = layoutControls + '<div class="text-[11px] font-bold text-violet-300">' + escapeHtml(el.label || el.type) + '</div>' +
    (el.type !== 'rectangle' && el.type !== 'ellipse' && el.type !== 'image' ? field('Contenido','text','text') : '') +
    field('Nombre de capa','label','text') + buttonControls + imageControls +
    (p.design.layoutMode === 'auto' ? '<p class="text-[10px] text-slate-500">La posición se calcula por orden, dirección, espacio y relleno.</p>' : '<div class="grid grid-cols-2 gap-2">' + field('X','x') + field('Y','y') + '</div>') +
    '<div class="grid grid-cols-2 gap-2">' + field('Ancho','width') + field('Alto','height') + '</div>' +
    '<div class="grid grid-cols-2 gap-2">' + field('Texto','color','color','') + field('Fondo','background','color','') + '</div>' +
    (el.type !== 'image' && el.type !== 'ellipse' ? field('Tamaño de texto','fontSize') : '') + field('Redondeado','radius') + (el.type !== 'rectangle' && el.type !== 'ellipse' && el.type !== 'image' ? '<label class="block space-y-1"><span class="text-slate-400">Alineación del texto</span><select onchange="updateDesignProperty(\'textAlign\',this.value)" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-2 text-xs text-slate-100"><option value="left" '+((el.textAlign||'left')==='left'?'selected':'')+'>Izquierda</option><option value="center" '+(el.textAlign==='center'?'selected':'')+'>Centro</option><option value="right" '+(el.textAlign==='right'?'selected':'')+'>Derecha</option></select></label>' : '') +
    '<div class="grid grid-cols-2 gap-2 mt-3"><button id="designLayerDown" type="button" onclick="moveDesignLayer(-1)" '+(layerIndex <= 0 ? 'disabled' : '')+' class="px-2 py-2 rounded-lg border border-slate-700 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"><i class="fa-solid fa-arrow-down mr-1"></i>Enviar atrás</button><button id="designLayerUp" type="button" onclick="moveDesignLayer(1)" '+(layerIndex >= p.design.elements.length - 1 ? 'disabled' : '')+' class="px-2 py-2 rounded-lg border border-slate-700 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"><i class="fa-solid fa-arrow-up mr-1"></i>Traer al frente</button></div>';
  updateDesignHistoryButtons();
}
function updateDesignProperty(key, value) {
  const el = selectedDesignElement(); if (!el) return;
  if (['text','label','alt'].includes(key)) el[key] = String(value).slice(0, 500);
  else if (key === 'src') el.src = safeDesignImageSource(value);
  else if (key === 'href') el.href = safeDesignLink(value);
  else if (key === 'objectFit') el.objectFit = ['contain','cover','fill'].includes(value) ? value : 'cover';
  else if (key === 'color' || key === 'background') el[key] = value;
  else el[key] = Math.max(key === 'radius' ? 0 : 1, Number(value) || 0);
  const p = activeDesignProject(); if (p) p.updatedAt = new Date().toISOString();
  // Keep typing responsive; update canvas/layers without rebuilding the focused property field.
  const node = Array.from(document.querySelectorAll('[data-design-id]')).find(item => item.dataset.designId === el.id);
  if (node) {
    if (el.type === 'image') renderDesignImageContent(node, el);
    else node.textContent = el.type === 'rectangle' ? '' : (el.text || '');
    const layoutPosition = getDesignLayoutPositions(p.design).positions.get(el.id) || { x: Number(el.x)||0, y: Number(el.y)||0 };
    node.style.left = layoutPosition.x+'px'; node.style.top = layoutPosition.y+'px';
    node.style.width = Math.max(20,Number(el.width)||120)+'px'; node.style.height = Math.max(20,Number(el.height)||48)+'px';
    node.style.color = el.color || '#111827'; node.style.background = el.background || 'transparent';
    node.style.fontSize = Math.max(8,Number(el.fontSize)||16)+'px'; node.style.borderRadius = el.type === 'ellipse' ? '50%' : Math.max(0,Number(el.radius)||0)+'px';
    node.style.textAlign = ['left','center','right'].includes(el.textAlign) ? el.textAlign : 'left';
    node.style.justifyContent = el.type === 'button' ? 'center' : (el.textAlign === 'center' ? 'center' : el.textAlign === 'right' ? 'flex-end' : 'flex-start');
  }
  if (p && p.design.layoutMode === 'auto') {
    const layout = getDesignLayoutPositions(p.design);
    document.querySelectorAll('[data-design-id]').forEach(item => {
      const pos = layout.positions.get(item.dataset.designId);
      if (pos) { item.style.left = pos.x + 'px'; item.style.top = pos.y + 'px'; }
    });
    const canvas = document.getElementById('designCanvas');
    if (canvas) canvas.style.height = layout.height + 'px';
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
    const dy = (ev.clientY - designDragState.startY) / (designDragState.scaleX || 1);
    const node = Array.from(document.querySelectorAll('[data-design-id]')).find(item => item.dataset.designId === el.id);
    if (designDragState.mode === 'resize') {
      el.width = Math.max(20, Math.min(4000, Math.round(designDragState.width + dx)));
      el.height = Math.max(20, Math.min(4000, Math.round(designDragState.height + dy)));
      if (node) { node.style.width = el.width + 'px'; node.style.height = el.height + 'px'; }
    } else {
      el.x = Math.max(0, Math.round(designDragState.x + dx)); el.y = Math.max(0, Math.round(designDragState.y + dy));
      if (node) { node.style.left = el.x + 'px'; node.style.top = el.y + 'px'; }
    }
  });
  const finishDesignDrag = () => {
    if (!designDragState) return;
    const p = activeDesignProject();
    const el = selectedDesignElement();
    if (p && el && p.design.snapToGrid) {
      const step = [4, 8, 16, 32].includes(Number(p.design.gridSize)) ? Number(p.design.gridSize) : 8;
      if (designDragState.mode === 'resize') {
        el.width = Math.max(20, Math.round((Number(el.width) || 120) / step) * step);
        el.height = Math.max(20, Math.round((Number(el.height) || 48) / step) * step);
      } else {
        el.x = Math.max(0, Math.round((Number(el.x) || 0) / step) * step);
        el.y = Math.max(0, Math.round((Number(el.y) || 0) / step) * step);
      }
    }
    const selectedId = selectedDesignElementId;
    designDragState = null;
    renderDesignWorkspace();
    const selectedNode = Array.from(document.querySelectorAll('[data-design-id]')).find(node => node.dataset.designId === selectedId);
    if (selectedNode) selectedNode.focus();
    saveProjectsToStorage();
  };
  document.addEventListener('pointerup', finishDesignDrag);
  document.addEventListener('pointercancel', finishDesignDrag);
  document.getElementById('designCanvas')?.addEventListener('click', ev => {
    if (ev.target.id === 'designCanvas') { selectedDesignElementId = null; selectedDesignElementIds = []; renderDesignWorkspace(); }
  });
  let nudgeHistoryActive = false;
  const arrowKeys = ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'];
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
    } else if (mod && ev.key.toLowerCase() === 'd' && selectedDesignElementId) {
      ev.preventDefault(); duplicateDesignElement();
    } else if ((ev.key === 'Delete' || ev.key === 'Backspace') && selectedDesignElementId) {
      ev.preventDefault(); deleteDesignElement();
    } else if (arrowKeys.includes(ev.key) && selectedDesignElementId &&
      (!target || target === document.body || target.id === 'designCanvas' || (target.closest && target.closest('#designCanvas')))) {
      const el = selectedDesignElement();
      if (!el) return;
      ev.preventDefault();
      if (!nudgeHistoryActive) recordDesignHistory();
      nudgeHistoryActive = true;
      const step = ev.shiftKey ? 10 : 1;
      if (ev.key === 'ArrowLeft') el.x = Math.max(0, (Number(el.x) || 0) - step);
      if (ev.key === 'ArrowRight') el.x = Math.max(0, (Number(el.x) || 0) + step);
      if (ev.key === 'ArrowUp') el.y = Math.max(0, (Number(el.y) || 0) - step);
      if (ev.key === 'ArrowDown') el.y = Math.max(0, (Number(el.y) || 0) + step);
      renderDesignWorkspace();
      saveProjectsToStorage();
    } else if (ev.key === 'Escape' && selectedDesignElementId) {
      selectedDesignElementId = null; renderDesignWorkspace();
    }
  });
  document.addEventListener('keyup', ev => {
    if (arrowKeys.includes(ev.key)) nudgeHistoryActive = false;
  });
}
function moveDesignLayer(direction) {
  const project = activeDesignProject(), element = selectedDesignElement();
  if (!project || !element || !Array.isArray(project.design.elements)) return;
  const currentIndex = project.design.elements.findIndex(item => item.id === element.id);
  const nextIndex = Math.max(0, Math.min(project.design.elements.length - 1, currentIndex + (direction < 0 ? -1 : 1)));
  if (currentIndex < 0 || nextIndex === currentIndex) return;
  recordDesignHistory();
  project.design.elements.splice(currentIndex, 1);
  project.design.elements.splice(nextIndex, 0, element);
  project.updatedAt = new Date().toISOString();
  renderDesignWorkspace();
  saveProjectsToStorage();
  showToast(nextIndex > currentIndex ? 'Capa traída al frente.' : 'Capa enviada atrás.');
}
function duplicateDesignElement() {
  const p = activeDesignProject(), el = selectedDesignElement(); if (!p || !el) return;
  if (p.design.elements.length >= MAX_DESIGN_ELEMENTS) {
    showToast('Este diseño alcanzó el límite de ' + MAX_DESIGN_ELEMENTS + ' capas. Elimina alguna para duplicar.', 'warn');
    return;
  }
  recordDesignHistory();
  const copy = { ...el, id: 'el_' + (crypto.randomUUID ? crypto.randomUUID() : Date.now()), x: (Number(el.x)||0)+24, y: (Number(el.y)||0)+24, label: (el.label || 'Capa') + ' copia' };
  p.design.elements.push(copy); selectedDesignElementId = copy.id; selectedDesignElementIds = [copy.id]; renderDesignWorkspace(); saveProjectsToStorage();
}
function deleteDesignElement() {
  const p = activeDesignProject(); if (!p || !selectedDesignElementId) return;
  recordDesignHistory(); p.design.elements = p.design.elements.filter(el => !selectedDesignElementIds.includes(el.id) && el.id !== selectedDesignElementId);
  selectedDesignElementId = null; selectedDesignElementIds = []; renderDesignWorkspace(); saveProjectsToStorage();
}
function convertDesignToWeb() {
  const p = activeDesignProject(); if (!p) return;
  const layout = getDesignLayoutPositions(p.design);
  const layoutPositions = layout.positions;
  const autoLayout = p.design.layoutMode === 'auto';
  const layoutDirection = p.design.layoutDirection === 'column' ? 'column' : 'row';
  const layoutGap = Math.max(0, Math.min(200, Number(p.design.layoutGap) || 0));
  const layoutPadding = Math.max(0, Math.min(200, Number(p.design.layoutPadding) || 0));
  const elements = (Array.isArray(p.design.elements) ? p.design.elements : []).map(el => {
    const imageSource = el.type === 'image' ? safeDesignImageSource(el.src) : '';
    const buttonHref = el.type === 'button' ? safeDesignLink(el.href) : '';
    const tag = el.type === 'image' ? (imageSource ? 'img' : 'div') : el.type === 'heading' ? 'h1' : el.type === 'button' ? 'a' : (el.type === 'rectangle' || el.type === 'ellipse') ? 'div' : 'p';
    const text = el.type === 'rectangle' || el.type === 'ellipse' || (el.type === 'image' && imageSource) ? '' : el.type === 'image' ? 'Añade una imagen' : escapeHtml(el.text || '');
    const color = safeDesignExportColor(el.color, '#111827');
    const background = safeDesignExportColor(el.background, 'transparent');
    const position = layoutPositions.get(el.id) || { x: Number(el.x) || 0, y: Number(el.y) || 0 };
    const x = Math.max(0, Math.min(10000, Number(position.x) || 0));
    const y = Math.max(0, Math.min(10000, Number(position.y) || 0));
    const width = Math.max(20, Math.min(4000, Number(el.width) || 120));
    const height = Math.max(20, Math.min(4000, Number(el.height) || 48));
    const fontSize = Math.max(8, Math.min(240, Number(el.fontSize) || 16));
    const weight = Math.max(100, Math.min(900, Number(el.weight) || 400));
    const radius = Math.max(0, Math.min(500, Number(el.radius) || 0));
    const align = ['left','center','right'].includes(el.textAlign) ? el.textAlign : 'left';
    const style = (autoLayout ? 'position:relative;left:auto;top:auto;flex:0 0 auto;max-width:100%;' : 'position:absolute;left:'+x+'px;top:'+y+'px;')+'width:'+width+'px;height:'+height+'px;color:'+color+';background:'+background+';font-size:'+fontSize+'px;text-align:'+align+';font-weight:'+weight+';'+(el.type==='ellipse'?'border-radius:50%;':'border-radius:'+radius+'px;')+'display:flex;align-items:center;padding:4px;box-sizing:border-box;'+(el.type==='button'?'justify-content:center;text-decoration:none;':'')+(el.type==='image'?'padding:0;object-fit:'+(['contain','cover','fill'].includes(el.objectFit)?el.objectFit:'cover')+';':'');
    const domId = designLayerDomId(el.id);
    if (el.type === 'image' && imageSource) return '<img id="'+escapeAttr(domId)+'" src="'+escapeAttr(imageSource)+'" alt="'+escapeAttr(String(el.alt || el.label || 'Imagen').slice(0,300))+'" style="'+style+'">';
    return '<'+tag+' id="'+escapeAttr(domId)+'"'+designLinkAttributes(buttonHref)+' style="'+style+'">'+text+'</'+tag+'>';
  }).join('\n');
  const frameWidth = ({desktop:1440,tablet:768,mobile:390})[p.design.frame] || 1440;
  const frameBackground = safeDesignExportColor(p.design.background, '#ffffff');
  const frameStyle = autoLayout
    ? 'position:relative;width:100%;max-width:'+frameWidth+'px;min-height:900px;height:auto;display:flex;flex-direction:'+layoutDirection+';flex-wrap:'+(layoutDirection==='row'?'wrap':'nowrap')+';gap:'+layoutGap+'px;padding:'+layoutPadding+'px;align-items:flex-start;background:'+safeDesignExportColor(p.design.background, '#ffffff')+';margin:0 auto;'
    : 'position:relative;width:'+frameWidth+'px;min-height:900px;height:900px;background:'+safeDesignExportColor(p.design.background, '#ffffff')+';transform-origin:top left;margin:0 auto;';
  const frameClass = 'design-frame' + (autoLayout ? ' auto-layout' : '');
  const mobileCss = autoLayout ? '@media(max-width:768px){.design-frame.auto-layout{flex-direction:column;flex-wrap:nowrap;align-items:stretch}.design-frame.auto-layout>*{max-width:100%}}' : '';
  const html = '<!doctype html>\n<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+escapeHtml(p.name)+'</title><style>*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:Inter,Arial,sans-serif;overflow-x:hidden}.design-viewport{position:relative;width:100%;overflow:hidden}.design-frame{transform-origin:top left}'+mobileCss+'</style></head><body><div class="design-viewport"><main id="designFrame" class="'+frameClass+'" style="'+frameStyle+'">'+elements+'</main></div><script>(function(){var f=document.getElementById("designFrame");var v=f.parentNode;var w='+frameWidth+';var h=900;function fit(){if(f.classList.contains("auto-layout")){f.style.transform="none";f.style.marginLeft="auto";v.style.height="auto";return;}var s=Math.min(1,Math.max(0.1,window.innerWidth/w));f.style.transform="scale("+s+")";f.style.marginLeft=Math.max(0,(window.innerWidth-w*s)/2)+"px";v.style.height=(h*s)+"px";}window.addEventListener("resize",fit,{passive:true});fit();})();<\/script></body></html>'
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
      const remoteProjects = Array.isArray(boot.state && boot.state.projects) ? boot.state.projects : [];
      const skipLocalIds = remoteProjects.length && generatedDefaultProjectId
        ? new Set([generatedDefaultProjectId])
        : new Set();
      projects = mergeWorkspaceProjects(remoteProjects, projects, loadDeletedProjectIds(workspaceId), skipLocalIds);
      if (skipLocalIds.size) generatedDefaultProjectId = null;
      if (Number.isInteger(boot.state && boot.state.revision)) workspaceRevision = boot.state.revision;
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


function toggleDesignExportMenu() {
  const menu = document.getElementById('designExportMenu');
  const button = document.getElementById('designExportMenuButton');
  if (!menu || !button) return;
  const opening = menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !opening);
  button.setAttribute('aria-expanded', String(opening));
}

function closeDesignExportMenu() {
  const menu = document.getElementById('designExportMenu');
  const button = document.getElementById('designExportMenuButton');
  if (menu) menu.classList.add('hidden');
  if (button) button.setAttribute('aria-expanded', 'false');
}


function toggleDesignTemplatesMenu() {
  const menu = document.getElementById('designTemplatesMenu');
  const button = document.getElementById('designTemplatesButton');
  if (!menu || !button) return;
  const opening = menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !opening);
  button.setAttribute('aria-expanded', String(opening));
}

function closeDesignTemplatesMenu() {
  const menu = document.getElementById('designTemplatesMenu');
  const button = document.getElementById('designTemplatesButton');
  if (menu) menu.classList.add('hidden');
  if (button) button.setAttribute('aria-expanded', 'false');
}

function applyDesignTemplate(templateId) {
  const project = activeDesignProject();
  if (!project || !project.design) {
    showToast('Abre un proyecto de diseño primero.', 'warn');
    return;
  }
  if (!['landing','dashboard','portfolio'].includes(templateId)) {
    showToast('Selecciona una plantilla válida.', 'warn');
    return;
  }
  if (project.design.elements.length && !window.confirm('Esta plantilla reemplazará las capas actuales. Puedes usar Deshacer para recuperar el diseño anterior. ¿Continuar?')) return;
  recordDesignHistory();
  const frameWidth = ({ desktop: 1440, tablet: 768, mobile: 390 })[project.design.frame] || 1440;
  const compact = frameWidth <= 768;
  const pad = compact ? 24 : 80;
  const contentWidth = Math.max(250, frameWidth - pad * 2);
  const make = (type, label, text, x, y, width, height, style) => ({
    id: 'el_' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + Math.random()),
    type, label, text: text || '', x, y, width, height,
    color: style.color || '#111827',
    background: style.background || 'transparent',
    fontSize: style.fontSize || 18,
    weight: style.weight || 400,
    radius: style.radius || 0,
    textAlign: style.textAlign || 'left',
    ...(type === 'image' ? { src: '', alt: label, objectFit: 'cover' } : {})
  });
  let elements = [];
  if (templateId === 'landing') {
    elements = [
      make('heading', 'Título principal', 'Tu producto, en primer plano', pad, 50, contentWidth, 76, { fontSize: compact ? 30 : 44, weight: 700 }),
      make('text', 'Descripción', 'Explica el valor de tu idea con una frase breve y clara.', pad, 138, contentWidth, 70, { fontSize: compact ? 16 : 20, color: '#475569' }),
      make('button', 'Acción principal', 'Comenzar', pad, 230, compact ? contentWidth : 190, 52, { fontSize: 16, weight: 700, color: '#ffffff', background: '#7c3aed', radius: 12 }),
      make('image', 'Imagen principal', '', pad, 320, contentWidth, compact ? 220 : 300, { background: '#e0e7ff', radius: 18 })
    ];
    project.design.background = '#ffffff';
  } else if (templateId === 'dashboard') {
    elements.push(make('heading', 'Título del panel', 'Panel de control', pad, 38, contentWidth, 64, { fontSize: compact ? 28 : 36, weight: 700 }));
    elements.push(make('text', 'Subtítulo', 'Resumen de actividad', pad, 105, contentWidth, 36, { fontSize: 16, color: '#64748b' }));
    const metrics = [
      { title: 'Usuarios', value: '12.8k', color: '#dbeafe' },
      { title: 'Ingresos', value: '$24.6k', color: '#dcfce7' },
      { title: 'Conversión', value: '8.4%', color: '#f3e8ff' }
    ];
    const gap = 16;
    const cardWidth = compact ? contentWidth : Math.floor((contentWidth - gap * 2) / 3);
    metrics.forEach((metric, i) => {
      const x = compact ? pad : pad + i * (cardWidth + gap);
      const y = compact ? 170 + i * 150 : 170;
      elements.push(make('rectangle', metric.title + ' tarjeta', '', x, y, cardWidth, 128, { background: metric.color, radius: 14 }));
      elements.push(make('text', metric.title, metric.title, x + 16, y + 18, cardWidth - 32, 30, { fontSize: 14, color: '#475569' }));
      elements.push(make('heading', metric.title + ' valor', metric.value, x + 16, y + 52, cardWidth - 32, 48, { fontSize: compact ? 26 : 30, weight: 700 }));
    });
    project.design.background = '#f8fafc';
  } else if (templateId === 'portfolio') {
    elements.push(make('heading', 'Nombre del portfolio', 'Mi portfolio', pad, 48, contentWidth, 70, { fontSize: compact ? 32 : 42, weight: 700 }));
    elements.push(make('text', 'Introducción', 'Una selección de proyectos y trabajos recientes.', pad, 128, contentWidth, 52, { fontSize: 18, color: '#64748b' }));
    const cards = [
      { title: 'Proyecto Alpha', color: '#dbeafe' },
      { title: 'Proyecto Beta', color: '#fce7f3' },
      { title: 'Proyecto Gamma', color: '#dcfce7' }
    ];
    const gap = 16;
    const cardWidth = compact ? contentWidth : Math.floor((contentWidth - gap * 2) / 3);
    cards.forEach((card, i) => {
      const x = compact ? pad : pad + i * (cardWidth + gap);
      const y = compact ? 205 + i * 180 : 205;
      elements.push(make('rectangle', card.title + ' tarjeta', '', x, y, cardWidth, 150, { background: card.color, radius: 16 }));
      elements.push(make('heading', card.title, card.title, x + 14, y + 45, cardWidth - 28, 55, { fontSize: compact ? 20 : 22, weight: 700 }));
    });
    project.design.background = '#ffffff';
  }
  project.design.elements = elements;
  project.updatedAt = new Date().toISOString();
  selectedDesignElementId = elements[0] ? elements[0].id : null;
  closeDesignTemplatesMenu();
  renderDesignWorkspace();
  saveProjectsToStorage();
  showToast('Plantilla aplicada. Puedes editar cada capa y deshacer el cambio.');
}

function exportDesignSvg() {
  const project = activeDesignProject();
  if (!project || !project.design) {
    showToast('Abre un proyecto de diseño primero.', 'warn');
    return;
  }
  try {
    const capture = window.CodeLabCapture && window.CodeLabCapture.captureDesignSvg;
    const result = typeof capture === 'function' ? capture(project) : captureDesignSvg(project);
    const slug = (project.name || 'codelab-design').toLowerCase().normalize('NFD')
      .replace(/[\\u0300-\\u036f]/g, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'codelab-design';
    downloadDesignAsset(slug + '.svg', result.svg, 'image/svg+xml;charset=utf-8');
    showToast('Diseño exportado como SVG vectorial.');
  } catch (error) {
    showToast('No se pudo exportar el SVG: ' + (error && error.message ? error.message : 'error de exportación'), 'warn');
  }
}

function exportDesignProjectJson() {
  const project = activeDesignProject();
  if (!project || !project.design) {
    showToast('Abre un proyecto de diseño primero.', 'warn');
    return;
  }
  const slug = (project.name || 'codelab-design').toLowerCase().normalize('NFD')
    .replace(/[\\u0300-\\u036f]/g, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'codelab-design';
  const payload = {
    format: 'codelab-design-project',
    version: 1,
    exportedAt: new Date().toISOString(),
    project: JSON.parse(JSON.stringify(project))
  };
  downloadDesignAsset(slug + '-proyecto.json', JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
  showToast('Respaldo JSON del proyecto exportado.');
}

