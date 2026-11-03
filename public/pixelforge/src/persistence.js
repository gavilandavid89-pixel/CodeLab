const DB_NAME = 'pixelforge-ai';
const DB_VERSION = 2;
const STORE = 'documents';
const META_STORE = 'projectMeta';

// When PixelForge is hosted inside CodeLab, reuse its HttpOnly session and cloud
// project API. Standalone deployments remain local-first through IndexedDB.
let codeLabSessionPromise = null;
let codeLabSessionCache = null;
let codeLabSessionKnown = false;
let codeLabSessionCheckedAt = 0;
const cloudRevisions = new Map();
async function codeLabSession() {
  if (codeLabSessionKnown && Date.now() - codeLabSessionCheckedAt < 30000) return codeLabSessionCache;
  if (!codeLabSessionPromise) {
    codeLabSessionPromise = (async () => {
      try {
        const response = await fetch('/api/pixelforge/session', { credentials: 'same-origin', cache: 'no-store' });
        if (response.status === 401 || response.status === 404) return null;
        if (!response.ok) throw new Error('CodeLab account status is temporarily unavailable.');
        return await response.json();
      } catch (error) {
        if (error instanceof TypeError) return null;
        throw error;
      }
    })().then(session => {
      const oldIdentity = codeLabSessionCache && codeLabSessionCache.user
        ? codeLabSessionCache.user.provider + ':' + codeLabSessionCache.user.id : null;
      const newIdentity = session && session.user ? session.user.provider + ':' + session.user.id : null;
      if (oldIdentity !== newIdentity) cloudRevisions.clear();
      codeLabSessionCache = session;
      codeLabSessionKnown = true;
      codeLabSessionCheckedAt = Date.now();
      return session;
    }).catch(error => {
      codeLabSessionPromise = null;
      throw error;
    }).finally(() => { codeLabSessionPromise = null; });
  }
  return codeLabSessionPromise;
}
function invalidateCodeLabSession() {
  codeLabSessionPromise = null;
  codeLabSessionCache = null;
  codeLabSessionKnown = false;
  codeLabSessionCheckedAt = 0;
  cloudRevisions.clear();
}
async function cloudProjectList(session) {
  if (!session) return null;
  let response = await fetch('/api/pixelforge/projects', { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error(response.status === 401 ? 'Sign in to CodeLab to sync PixelForge projects.' : 'Could not load PixelForge cloud projects.');
  let payload = await response.json();
  // Detect account changes even while this tab has a cached session. Never combine a
  // stale account's local metadata with the newly authenticated account's cloud list.
  if (payload.workspaceId !== session.workspaceId) {
    invalidateCodeLabSession();
    session = await codeLabSession();
    if (!session) return null;
    response = await fetch('/api/pixelforge/projects', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('Could not reload PixelForge projects after the CodeLab account changed.');
    payload = await response.json();
    if (payload.workspaceId !== session.workspaceId) {
      invalidateCodeLabSession();
      throw new Error('CodeLab account changed during project listing. Reload PixelForge and retry.');
    }
  }
  for (const item of payload.projects || []) if (item && typeof item.id === 'string' && Number.isInteger(item.revision)) cloudRevisions.set(item.id, item.revision);
  return payload.projects || [];
}
function timestampNow() { return globalThis.performance?.timeOrigin ? globalThis.performance.timeOrigin + globalThis.performance.now() : Date.now(); }
function metadataFor(record) {
  const project = record.project ?? {};
  return {
    id: record.id, name: record.name ?? project.name ?? 'Untitled artwork',
    width: project.width ?? 0, height: project.height ?? 0,
    updatedAt: record.updatedAt ?? 0,
    lastOpenedAt: record.lastOpenedAt ?? record.updatedAt ?? 0,
    cloudOwner: record.cloudOwner ?? null
  };
}

function openDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('This browser does not support local project storage.'));
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = event => {
      const db = request.result, tx = request.transaction;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (event.oldVersion < 2 && !db.objectStoreNames.contains(META_STORE)) {
        const metadata = db.createObjectStore(META_STORE, { keyPath: 'id' });
        const cursorRequest = tx.objectStore(STORE).openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          metadata.put(metadataFor(cursor.value));
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open project storage.'));
    request.onblocked = () => reject(new Error('Project storage upgrade is blocked by another open tab. Close other editor tabs and retry.'));
  });
}
function cloudOwnerKey(session) {
  return session && session.user ? String(session.user.provider) + ':' + String(session.user.id) : null;
}
export async function saveProject(project) {
  const session = await codeLabSession().catch(() => codeLabSessionCache);
  const ownerKey = cloudOwnerKey(session);
  const db = await openDB();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE, META_STORE], 'readwrite');
      const updatedAt = timestampNow();
      const record = { id: project.id, name: project.name, updatedAt, lastOpenedAt: updatedAt, cloudOwner: ownerKey, project };
      tx.objectStore(STORE).put(record);
      tx.objectStore(META_STORE).put(metadataFor(record));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error ?? new Error('Save failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('Save was interrupted.'));
    });
  } finally { db.close(); }

  if (!session) return { savedLocally: true, cloud: false };
  const baseRevision = cloudRevisions.get(project.id);
  let response;
  try {
    response = await fetch('/api/pixelforge/projects/' + encodeURIComponent(project.id), {
      method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, workspaceId: session.workspaceId, ...(baseRevision == null ? {} : { baseRevision }) })
    });
  } catch (error) {
    throw new Error('Local backup saved, but CodeLab cloud sync failed: ' + (error.message || 'network unavailable'));
  }
  if (response.status === 409) {
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (payload?.error === 'pixelforge_account_changed') {
      invalidateCodeLabSession();
      throw new Error('Local backup saved. Your CodeLab account changed; reload PixelForge before syncing again.');
    }
    throw new Error('Local backup saved. This project changed in another tab or device; reload the cloud version before continuing.');
  }
  if (!response.ok) throw new Error('Local backup saved, but CodeLab cloud sync failed (' + response.status + ').');
  const result = await response.json();
  if (result.workspaceId !== session.workspaceId) {
    invalidateCodeLabSession();
    throw new Error('Local backup saved. Your CodeLab account changed; reload PixelForge before syncing again.');
  }
  if (Number.isInteger(result.revision)) cloudRevisions.set(project.id, result.revision);
  return { savedLocally: true, cloud: true, revision: result.revision };
}
export async function listSavedProjects() {
  const db = await openDB();
  let local;
  try {
    local = await new Promise((resolve, reject) => {
      const tx = db.transaction(META_STORE, 'readonly');
      const request = tx.objectStore(META_STORE).getAll();
      request.onsuccess = () => resolve(request.result.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt));
      request.onerror = () => reject(request.error ?? new Error('Could not list saved projects.'));
    });
  } finally { db.close(); }
  let session = await codeLabSession().catch(() => codeLabSessionCache);
  try {
    const cloud = await cloudProjectList(session);
    session = await codeLabSession().catch(() => codeLabSessionCache);
    const ownerKey = cloudOwnerKey(session);
    const scopedLocal = ownerKey ? local.filter(item => item.cloudOwner === ownerKey) : local;
    if (!cloud) return scopedLocal;
    const merged = new Map(scopedLocal.map(item => [item.id, item]));
    for (const item of cloud) merged.set(item.id, { ...item, lastOpenedAt: Date.parse(item.updatedAt) || 0, cloud: true, cloudOwner: ownerKey });
    return [...merged.values()].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  } catch {
    session = await codeLabSession().catch(() => codeLabSessionCache);
    const ownerKey = cloudOwnerKey(session);
    return ownerKey ? local.filter(item => item.cloudOwner === ownerKey) : local;
  }
}
export async function loadProjectById(id) {
  let session = codeLabSessionCache;
  try {
    session = await codeLabSession();
    if (session) {
      const response = await fetch('/api/pixelforge/projects/' + encodeURIComponent(id), { credentials: 'same-origin', cache: 'no-store' });
      if (response.ok) {
        const payload = await response.json();
        if (payload.workspaceId !== session.workspaceId) {
          invalidateCodeLabSession();
          throw new Error('CodeLab account changed. Reload PixelForge before opening cloud projects.');
        }
        if (Number.isInteger(payload.revision)) cloudRevisions.set(id, payload.revision);
        return payload.project;
      }
      if (response.status !== 404) throw new Error('Could not load the CodeLab cloud project (' + response.status + ').');
    }
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE, META_STORE], 'readwrite');
      const documents = tx.objectStore(STORE), metadata = tx.objectStore(META_STORE);
      let project = null;
      const request = documents.get(id);
      request.onsuccess = () => {
        const record = request.result;
        if (!record) { metadata.delete(id); return; }
        const ownerKey = cloudOwnerKey(session);
        if (ownerKey && record.cloudOwner !== ownerKey) return;
        project = record.project;
        const metaRequest = metadata.get(id);
        metaRequest.onsuccess = () => {
          const meta = metaRequest.result ?? metadataFor(record);
          meta.lastOpenedAt = timestampNow();
          metadata.put(meta);
        };
        metaRequest.onerror = () => reject(metaRequest.error ?? new Error('Could not update project recency.'));
      };
      request.onerror = () => reject(request.error ?? new Error('Could not open the selected project.'));
      tx.oncomplete = () => resolve(project);
      tx.onerror = () => reject(tx.error ?? new Error('Could not update project recency.'));
      tx.onabort = () => reject(tx.error ?? new Error('Opening the project was interrupted.'));
    });
  } finally { db.close(); }
}
export async function loadMostRecentProject() {
  const projects = await listSavedProjects();
  for (const metadata of projects) {
    const project = await loadProjectById(metadata.id);
    if (project) return project;
  }
  return null;
}
