const API = '/api/pixelforge/projects';

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: { ...(options.headers || {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}) }
  });
  let data = {};
  try { data = await response.json(); } catch (_) {}
  if (response.status === 401) {
    const error = new Error('Inicia sesión en CodeLab para usar PixelForge y guardar tus proyectos en tu cuenta.');
    error.code = 'not_authenticated';
    error.status = 401;
    throw error;
  }
  if (!response.ok) {
    const messages = {
      project_not_found: 'No se encontró ese proyecto en tu cuenta.',
      pixelforge_project_too_large: 'El proyecto supera el tamaño permitido para guardarlo.',
      invalid_pixelforge_project: 'El proyecto contiene datos no válidos.',
      pixelforge_storage_unavailable: 'No se pudo acceder al almacenamiento de tu cuenta.'
    };
    const error = new Error(messages[data.error] || data.message || 'La solicitud de proyectos falló (' + response.status + ').');
    error.code = data.error || 'request_failed';
    error.status = response.status;
    throw error;
  }
  return data;
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
