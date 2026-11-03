const { codeLabRequest } = window.CodeLabStudioCore;

const API = '/api/pixelforge/projects';

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
