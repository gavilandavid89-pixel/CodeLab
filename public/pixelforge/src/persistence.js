const DB_NAME = 'pixelforge-ai';
const DB_VERSION = 2;
const STORE = 'documents';
const META_STORE = 'projectMeta';
function timestampNow() { return globalThis.performance?.timeOrigin ? globalThis.performance.timeOrigin + globalThis.performance.now() : Date.now(); }
function metadataFor(record) {
  const project = record.project ?? {};
  return {
    id: record.id, name: record.name ?? project.name ?? 'Untitled artwork',
    width: project.width ?? 0, height: project.height ?? 0,
    updatedAt: record.updatedAt ?? 0,
    lastOpenedAt: record.lastOpenedAt ?? record.updatedAt ?? 0
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
export async function saveProject(project) {
  const db = await openDB();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE, META_STORE], 'readwrite');
      const updatedAt = timestampNow();
      const record = { id: project.id, name: project.name, updatedAt, lastOpenedAt: updatedAt, project };
      tx.objectStore(STORE).put(record);
      tx.objectStore(META_STORE).put(metadataFor(record));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error ?? new Error('Save failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('Save was interrupted.'));
    });
  } finally { db.close(); }
}
export async function listSavedProjects() {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(META_STORE, 'readonly');
      const request = tx.objectStore(META_STORE).getAll();
      request.onsuccess = () => resolve(request.result.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt));
      request.onerror = () => reject(request.error ?? new Error('Could not list saved projects.'));
    });
  } finally { db.close(); }
}
export async function loadProjectById(id) {
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
