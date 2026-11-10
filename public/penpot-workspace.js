/* CodeLab ↔ Penpot workspace bridge.
 * Penpot owns visual design; CodeLab keeps runtime, generation and animation.
 */
(function () {
  'use strict';
  const DEFAULT_URL = 'https://design.penpot.app';
  function configUrl() { return window.CODELAB_PENPOT_URL || DEFAULT_URL; }
  function openPenpot() {
    const base = configUrl().replace(/\/$/, '');
    const returnUrl = window.location.origin + window.location.pathname + '?workspace=web';
    window.location.href = base + '/?codelab-return=' + encodeURIComponent(returnUrl);
  }
  function setStatus(message, kind) {
    const el = document.getElementById('penpotStatus');
    if (!el) return;
    el.textContent = message;
    el.className = 'text-xs ' + (kind === 'ok' ? 'text-emerald-300' : kind === 'warn' ? 'text-amber-300' : 'text-slate-400');
  }
  async function loadConfig() {
    try {
      const r = await fetch('/api/penpot/config', { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) throw new Error('config');
      const data = await r.json();
      window.CODELAB_PENPOT_URL = String(data.url || DEFAULT_URL).replace(/\/$/, '');
      setStatus('Penpot listo · ' + window.CODELAB_PENPOT_URL, 'ok');
    } catch (_) {
      window.CODELAB_PENPOT_URL = DEFAULT_URL;
      setStatus('Penpot Cloud · configuración por defecto', 'warn');
    }
  }
  function init() {
    const button = document.getElementById('openPenpotWorkspace');
    if (button) button.addEventListener('click', openPenpot);
    const copy = document.getElementById('copyPenpotUrl');
    if (copy) copy.addEventListener('click', async function () {
      try { await navigator.clipboard.writeText(configUrl()); setStatus('URL de Penpot copiada.', 'ok'); }
      catch (_) { setStatus(configUrl(), 'warn'); }
    });
    loadConfig();
  }
  window.CodeLabPenpot = { open: openPenpot, config: configUrl };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();