const { codeLabRequest } = window.CodeLabStudioCore;

const API = '/api/pixelforge/projects';
const DIRECT_SAVE_BYTES = 24 * 1024 * 1024;
const MAX_PROJECT_BYTES = 128 * 1024 * 1024;
const UPLOAD_CHUNK_BYTES = 6 * 1024 * 1024;
const pendingUploads = new Map();

function encodeBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), value => value.toString(16).padStart(2, '0')).join('');
}
async function saveProjectChunked(project) {
  const expectedServerRevision = Number.isInteger(project.serverRevision) ? project.serverRevision : 0;
  const uploadProject = { ...project, serverRevision: expectedServerRevision + 1 };
  const serialized = JSON.stringify(uploadProject);
  const blob = new Blob([serialized], { type: 'application/json' });
  if (blob.size > MAX_PROJECT_BYTES) {
    const error = new RangeError('El proyecto supera el límite total de 128 MiB para guardado.');
    error.code = 'pixelforge_project_too_large';
    throw error;
  }
  if (!globalThis.crypto?.subtle || typeof crypto.randomUUID !== 'function') {
    throw new Error('Este navegador no permite transferencias seguras por bloques. Actualiza el navegador para guardar proyectos grandes.');
  }
  const signature = [project.id, project.saveVersion, project.revision, expectedServerRevision, blob.size,
    project.name, project.width, project.height].join(':');
  let pending = pendingUploads.get(project.id);
  if (!pending || pending.signature !== signature) {
    pending = { signature, uploadId: crypto.randomUUID().replace(/-/g, '') };
    pendingUploads.set(project.id, pending);
  }
  const totalChunks = Math.ceil(blob.size / UPLOAD_CHUNK_BYTES);
  const begin = await request(API + '/uploads', {
    method: 'POST',
    body: JSON.stringify({
      uploadId: pending.uploadId,
      projectId: project.id,
      expectedServerRevision,
      totalBytes: blob.size,
      totalChunks
    })
  });
  if (begin.committed && begin.receipt?.project) {
    pendingUploads.delete(project.id);
    project.serverRevision = begin.receipt.project.serverRevision;
    return begin.receipt.project;
  }
  try {
    for (let index = 0; index < totalChunks; index++) {
      const bytes = new Uint8Array(await blob.slice(index * UPLOAD_CHUNK_BYTES, (index + 1) * UPLOAD_CHUNK_BYTES).arrayBuffer());
      const hash = toHex(await crypto.subtle.digest('SHA-256', bytes));
      await request(API + '/uploads/' + pending.uploadId + '/' + index, {
        method: 'PUT',
        body: JSON.stringify({ chunk: encodeBase64(bytes), sha256: hash })
      });
    }
    const result = await request(API + '/uploads/' + pending.uploadId + '/commit', {
      method: 'POST',
      body: '{}'
    });
    pendingUploads.delete(project.id);
    if (result.project && Number.isInteger(result.project.serverRevision)) {
      project.serverRevision = result.project.serverRevision;
    }
    return result.project;
  } catch (error) {
    // Keep the upload ID after transient failures. Re-sending identical chunks is idempotent.
    if (error.code === 'pixelforge_chunk_conflict' || error.code === 'pixelforge_upload_expired' ||
        error.code === 'pixelforge_upload_not_found' || error.code === 'pixelforge_upload_committed') {
      pendingUploads.delete(project.id);
    }
    throw error;
  }
}

async function request(path, options = {}) {
  try {
    return await codeLabRequest(path, options);
  } catch (error) {
    if (error.status === 401) {
      error.message = 'Inicia sesión en CodeLab para usar PixelForge y guardar tus proyectos en tu cuenta.';
      throw error;
    }
    const messages = {
      project_not_found: 'No se encontró ese proyecto en tu cuenta.',
      pixelforge_project_too_large: 'El proyecto supera el tamaño permitido para guardarlo.',
      pixelforge_account_storage_limit: 'Tu cuenta alcanzó el espacio reservado para PixelForge. Elimina proyectos antiguos o reduce el tamaño del documento.',
      pixelforge_project_limit: 'Tu cuenta alcanzó el máximo de proyectos PixelForge. Elimina uno antes de crear otro.',
      pixelforge_revision_conflict: 'Este proyecto cambió en otra sesión. Vuelve a abrir la versión más reciente antes de guardar para no sobrescribir cambios.',
      invalid_pixelforge_project: 'El proyecto contiene datos no válidos.',
      invalid_pixelforge_animation: 'La animación contiene fotogramas o capas no válidos para este documento.',
      pixelforge_upload_incomplete: 'La carga del proyecto quedó incompleta. Puedes volver a guardar para continuar.',
      pixelforge_upload_expired: 'La carga temporal caducó. Vuelve a guardar el proyecto.',
      pixelforge_upload_conflict: 'Ya existe otra carga con ese identificador. Vuelve a guardar el proyecto.',
      pixelforge_upload_manifest_mismatch: 'La carga no coincide con el proyecto que se intentó guardar.',
      pixelforge_chunk_integrity_failed: 'Un bloque del proyecto no superó la verificación de integridad.',
      pixelforge_chunk_conflict: 'Un bloque repetido no coincide con el que ya se había recibido.',
      pixelforge_storage_unavailable: 'No se pudo acceder al almacenamiento de tu cuenta.',
      pixelforge_database_unavailable: 'El almacenamiento de PixelForge no está disponible en CodeLab. Inténtalo más tarde o contacta al administrador.'
    };
    if (messages[error.code]) error.message = messages[error.code];
    throw error;
  }
}

export async function saveProject(project) {
  const directBody = JSON.stringify({ project });
  const result = new Blob([directBody]).size > DIRECT_SAVE_BYTES
    ? { project: await saveProjectChunked(project) }
    : await request(API, { method: 'PUT', body: directBody });
  if (result.project && Number.isInteger(result.project.serverRevision)) project.serverRevision = result.project.serverRevision;
  return result.project;
}
export async function listSavedProjects() {
  const result = await request(API);
  return Array.isArray(result.projects) ? result.projects : [];
}
export async function loadProjectById(id) {
  const result = await request(API + '/' + encodeURIComponent(id));
  return result.project || null;
}
export async function loadMostRecentProject() {
  const projects = await listSavedProjects();
  for (const metadata of projects) {
    const project = await loadProjectById(metadata.id);
    if (project) return project;
  }
  return null;
}
export async function deleteProject(id) {
  await request(API + '/' + encodeURIComponent(id), { method: 'DELETE' });
}
