const { codeLabRequest, getCodeLabSession } = window.CodeLabStudioCore;

const API = '/api/pixelforge/projects';
let boundAccountKey = null;

function accountKey(user) {
  if (!user || typeof user.provider !== 'string' || user.id == null) return null;
  return user.provider + ':' + String(user.id);
}

// Bind this editor instance to the CodeLab account that authenticated at boot.
// Cookies are shared across tabs, so an account switch elsewhere must not cause
// this still-open editor to save the previous account's artwork into the new one.
export function bindAccountSession(user) {
  const key = accountKey(user);
  if (!key) throw new Error('No se pudo vincular PixelForge a una cuenta de CodeLab.');
  boundAccountKey = key;
}

async function assertBoundAccount() {
  if (!boundAccountKey) {
    const error = new Error('Recarga PixelForge para vincularlo a tu cuenta de CodeLab.');
    error.code = 'account_session_changed';
    error.status = 409;
    throw error;
  }
  const auth = await getCodeLabSession();
  if (accountKey(auth?.user) !== boundAccountKey) {
    const error = new Error('La sesión de CodeLab cambió. Recarga PixelForge antes de guardar o abrir proyectos.');
    error.code = 'account_session_changed';
    error.status = 409;
    throw error;
  }
}

async function request(path, options = {}) {
  try {
    await assertBoundAccount();
    return await codeLabRequest(path, options);
  } catch (error) {
    if (error.status === 401) {
      error.message = 'Inicia sesión en CodeLab para usar PixelForge y guardar tus proyectos en tu cuenta.';
      throw error;
    }
    const messages = {
      account_session_changed: 'La sesión de CodeLab cambió. Recarga PixelForge antes de guardar o abrir proyectos.',
      project_not_found: 'No se encontró ese proyecto en tu cuenta.',
      pixelforge_project_too_large: 'El proyecto supera el tamaño permitido para guardarlo.',
      pixelforge_account_storage_limit: 'Tu cuenta alcanzó el espacio reservado para PixelForge. Elimina proyectos antiguos o reduce el tamaño del documento.',
      pixelforge_project_limit: 'Tu cuenta alcanzó el máximo de proyectos PixelForge. Elimina uno antes de crear otro.',
      pixelforge_revision_conflict: 'Este proyecto cambió en otra sesión. Vuelve a abrir la versión más reciente antes de guardar para no sobrescribir cambios.',
      invalid_pixelforge_project: 'El proyecto contiene datos no válidos.',
      pixelforge_storage_unavailable: 'No se pudo acceder al almacenamiento de tu cuenta.',
      pixelforge_database_unavailable: 'El almacenamiento de PixelForge no está disponible en CodeLab. Inténtalo más tarde o contacta al administrador.'
    };
    if (messages[error.code]) error.message = messages[error.code];
    throw error;
  }
}

export async function saveProject(project) {
  const result = await request(API, { method: 'PUT', body: JSON.stringify({ project }) });
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
