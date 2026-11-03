/**
 * CodeLab shared studio runtime.
 * Classic-script API so both the CodeLab dashboard and modular studios use the
 * same session and same-origin request semantics without bundler/runtime coupling.
 */
(function (root) {
  'use strict';

  async function getCodeLabSession() {
    const data = await codeLabRequest('/api/auth/status');
    return data;
  }

  async function getCodeLabAISettings() {
    // Resolve the live server session each time; never trust a stale caller-supplied identity.
    const auth = await getCodeLabSession();
    if (!auth.user || !auth.user.provider || auth.user.id == null) {
      return { configured: false, mode: 'auto', baseUrl: '', model: '', apiKey: '' };
    }
    const key = 'codelab_xd_ai_settings_v1:' + auth.user.provider + '_' + auth.user.id;
    let settings = {};
    try {
      const raw = root.localStorage && root.localStorage.getItem(key);
      if (raw) settings = JSON.parse(raw) || {};
    } catch (_) {}
    const mode = ['api', 'auto', 'local'].includes(settings.mode) ? settings.mode : 'auto';
    const apiKey = mode === 'api' && typeof settings.apiKey === 'string' ? settings.apiKey : '';
    const baseUrl = typeof settings.baseUrl === 'string' ? settings.baseUrl.trim() : '';
    const model = typeof settings.model === 'string' ? settings.model.trim() : '';
    return {
      configured: mode === 'api' && !!apiKey && !!baseUrl && !!model,
      mode,
      baseUrl,
      model,
      apiKey
    };
  }

  async function codeLabRequest(path, options = {}) {
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
      error.code = data.error || 'not_authenticated';
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

  root.CodeLabStudioCore = Object.freeze({ getCodeLabSession, getCodeLabAISettings, codeLabRequest });
})(typeof window !== 'undefined' ? window : globalThis);
