/**
 * CodeLab shared studio runtime.
 * Studio-specific tools remain modular; session and request semantics are shared.
 */
export async function getCodeLabSession() {
  const response = await fetch('/api/auth/status', {
    credentials: 'same-origin',
    cache: 'no-store'
  });
  if (!response.ok) {
    const error = new Error('No se pudo comprobar la sesión de CodeLab.');
    error.code = 'session_check_failed';
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export async function codeLabRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {})
    }
  });
  let data = {};
  try { data = await response.json(); } catch (_) {}
  if (response.status === 401) {
    const error = new Error('Tu sesión de CodeLab ha caducado o no está iniciada. Vuelve a CodeLab e inicia sesión.');
    error.code = 'not_authenticated';
    error.status = 401;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(data.message || data.error || 'La solicitud a CodeLab falló (' + response.status + ').');
    error.code = data.error || 'request_failed';
    error.status = response.status;
    throw error;
  }
  return data;
}
