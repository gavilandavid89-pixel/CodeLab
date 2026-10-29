(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.CodeLabComponentLibrary = api;
    if (typeof document !== 'undefined') {
      const start = () => api.init();
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
      else start();
    }
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const components = [
  {
    "id": "navbar",
    "name": "Navegación",
    "category": "Navegación",
    "description": "Barra adaptable con marca, enlaces y llamada a la acción.",
    "tags": "menu header navbar",
    "html": "<section class=\"cl-nav\"><style>.cl-nav{font:14px system-ui;color:#e2e8f0;background:#0f172a;padding:18px 22px;border-radius:14px}.cl-nav nav{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}.cl-nav strong{font-size:18px;color:white}.cl-nav .links{display:flex;gap:16px;flex-wrap:wrap}.cl-nav a{color:inherit;text-decoration:none}.cl-nav .cta{background:#06b6d4;color:#082f49;padding:9px 13px;border-radius:9px;font-weight:700}</style><nav aria-label=\"Navegación principal\"><strong>TuMarca</strong><div class=\"links\"><a href=\"#inicio\">Inicio</a><a href=\"#servicios\">Servicios</a><a href=\"#nosotros\">Nosotros</a></div><a class=\"cta\" href=\"#contacto\">Comenzar</a></nav></section>"
  },
  {
    "id": "hero",
    "name": "Hero de landing",
    "category": "Secciones",
    "description": "Portada con mensaje principal y dos acciones.",
    "tags": "landing portada principal",
    "html": "<section class=\"cl-hero\"><style>.cl-hero{font:16px/1.6 system-ui;text-align:center;padding:clamp(32px,7vw,76px) 20px;border-radius:18px;background:linear-gradient(135deg,#082f49,#172554 65%,#3b0764);color:#f8fafc}.cl-hero .eyebrow{display:inline-block;padding:5px 10px;border:1px solid #67e8f9;border-radius:999px;color:#a5f3fc;font-size:12px}.cl-hero h1{font-size:clamp(30px,5vw,54px);line-height:1.08;max-width:760px;margin:18px auto}.cl-hero p{max-width:600px;margin:0 auto 24px;color:#cbd5e1}.cl-hero .actions{display:flex;justify-content:center;gap:10px;flex-wrap:wrap}.cl-hero a{padding:11px 16px;border-radius:10px;text-decoration:none;font-weight:700}.cl-hero .primary{background:#06b6d4;color:#083344}.cl-hero .secondary{border:1px solid #64748b;color:#f8fafc}</style><span class=\"eyebrow\">Una forma más sencilla de avanzar</span><h1>Convierte tus ideas en algo extraordinario</h1><p>Explica el valor de tu producto y por qué debería importarle a tus visitantes.</p><div class=\"actions\"><a class=\"primary\" href=\"#empezar\">Empezar ahora →</a><a class=\"secondary\" href=\"#detalles\">Conocer más</a></div></section>"
  },
  {
    "id": "features",
    "name": "Tarjetas de características",
    "category": "Tarjetas",
    "description": "Tres tarjetas para explicar beneficios o servicios.",
    "tags": "features servicios beneficios cards",
    "html": "<section class=\"cl-features\"><style>.cl-features{font:15px/1.55 system-ui;color:#0f172a;padding:20px}.cl-features .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr));gap:14px}.cl-features article{border:1px solid #e2e8f0;border-radius:15px;padding:20px;background:white;box-shadow:0 5px 18px #0f172a0a}.cl-features .icon{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;background:#cffafe;color:#0e7490;font-size:21px}.cl-features h3{margin:14px 0 6px;font-size:17px}.cl-features p{margin:0;color:#475569}</style><div class=\"grid\"><article><div class=\"icon\" aria-hidden=\"true\">✦</div><h3>Simple de usar</h3><p>Reduce pasos innecesarios y ayuda a que todo fluya.</p></article><article><div class=\"icon\" aria-hidden=\"true\">↗</div><h3>Crece contigo</h3><p>Una base flexible que acompaña tus próximos objetivos.</p></article><article><div class=\"icon\" aria-hidden=\"true\">◈</div><h3>Todo conectado</h3><p>Mantén tus herramientas y procesos organizados.</p></article></div></section>"
  },
  {
    "id": "stats",
    "name": "Métricas",
    "category": "Tarjetas",
    "description": "Indicadores numéricos para un panel o landing.",
    "tags": "stats kpi números dashboard",
    "html": "<section class=\"cl-stats\"><style>.cl-stats{font:14px system-ui;padding:18px;background:#f8fafc;border-radius:14px}.cl-stats .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px}.cl-stats article{background:white;border:1px solid #e2e8f0;border-radius:12px;padding:16px}.cl-stats span{color:#64748b}.cl-stats strong{display:block;font-size:clamp(24px,4vw,32px);color:#0f172a;margin:6px 0}.cl-stats small{color:#047857}</style><div class=\"grid\"><article><span>Usuarios activos</span><strong>12.8k</strong><small>↗ 12% este mes</small></article><article><span>Conversión</span><strong>8.4%</strong><small>↗ 2.1% este mes</small></article><article><span>Ingresos</span><strong>$24.6k</strong><small>↗ 9% este mes</small></article></div></section>"
  },
  {
    "id": "pricing",
    "name": "Planes y precios",
    "category": "Secciones",
    "description": "Comparación de planes con una opción destacada.",
    "tags": "pricing precio suscripción planes",
    "html": "<section class=\"cl-pricing\"><style>.cl-pricing{font:14px/1.55 system-ui;padding:20px;color:#0f172a}.cl-pricing .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr));gap:14px}.cl-pricing article{border:1px solid #cbd5e1;border-radius:16px;padding:22px;background:white}.cl-pricing .featured{border:2px solid #0891b2;background:#ecfeff}.cl-pricing h3{margin:0;font-size:18px}.cl-pricing .price{font-size:32px;font-weight:800;margin:12px 0}.cl-pricing ul{padding-left:18px;color:#475569}.cl-pricing li{margin:7px 0}.cl-pricing a{display:block;text-align:center;padding:10px;border-radius:9px;background:#0e7490;color:white;text-decoration:none;font-weight:700}</style><div class=\"grid\"><article><h3>Inicial</h3><p class=\"price\">Gratis</p><ul><li>Funciones esenciales</li><li>Un proyecto</li><li>Soporte comunitario</li></ul><a href=\"#inicial\">Elegir plan</a></article><article class=\"featured\"><h3>Pro · Popular</h3><p class=\"price\">$12 <small>/mes</small></p><ul><li>Todos los componentes</li><li>Proyectos ilimitados</li><li>Soporte prioritario</li></ul><a href=\"#pro\">Elegir plan</a></article></div></section>"
  },
  {
    "id": "contact",
    "name": "Formulario de contacto",
    "category": "Formularios",
    "description": "Formulario accesible con etiquetas y campos nativos.",
    "tags": "contacto form email mensaje",
    "html": "<section class=\"cl-contact\"><style>.cl-contact{font:14px/1.5 system-ui;max-width:560px;margin:auto;padding:22px;border:1px solid #e2e8f0;border-radius:16px;color:#0f172a;background:white}.cl-contact h2{font-size:24px;margin:0 0 6px}.cl-contact p{color:#475569;margin:0 0 18px}.cl-contact form{display:grid;gap:13px}.cl-contact label{display:grid;gap:6px;font-weight:600}.cl-contact input,.cl-contact textarea{font:inherit;width:100%;box-sizing:border-box;padding:11px;border:1px solid #cbd5e1;border-radius:9px}.cl-contact textarea{min-height:100px;resize:vertical}.cl-contact button{border:0;border-radius:9px;background:#0891b2;color:white;padding:12px;font:inherit;font-weight:700;cursor:pointer}</style><h2>Hablemos</h2><p>Cuéntanos qué necesitas y te responderemos pronto.</p><form action=\"#\" method=\"post\"><label for=\"cl-contact-name\">Nombre<input id=\"cl-contact-name\" name=\"name\" autocomplete=\"name\" required></label><label for=\"cl-contact-email\">Correo electrónico<input id=\"cl-contact-email\" name=\"email\" type=\"email\" autocomplete=\"email\" required></label><label for=\"cl-contact-message\">Mensaje<textarea id=\"cl-contact-message\" name=\"message\" required></textarea></label><button type=\"submit\">Enviar mensaje</button></form></section>"
  },
  {
    "id": "dashboard",
    "name": "Panel de proyecto",
    "category": "Paneles",
    "description": "Resumen con estado, progreso y métricas.",
    "tags": "dashboard panel proyecto admin",
    "html": "<section class=\"cl-dashboard\"><style>.cl-dashboard{font:14px/1.5 system-ui;background:#f8fafc;padding:20px;border-radius:16px;color:#0f172a}.cl-dashboard .top{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap}.cl-dashboard h2{font-size:22px;margin:0}.cl-dashboard .status{background:#dcfce7;color:#166534;padding:5px 9px;border-radius:999px;font-size:12px}.cl-dashboard .progress{height:8px;background:#e2e8f0;border-radius:99px;overflow:hidden;margin:10px 0 18px}.cl-dashboard .progress span{display:block;width:68%;height:100%;background:#0891b2}.cl-dashboard .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:12px}.cl-dashboard article{background:white;border:1px solid #e2e8f0;border-radius:12px;padding:15px}.cl-dashboard small{color:#64748b}.cl-dashboard strong{display:block;font-size:24px;margin-top:6px}</style><div class=\"top\"><h2>Resumen del proyecto</h2><span class=\"status\">● En progreso</span></div><p>Objetivos completados: 68%</p><div class=\"progress\" role=\"progressbar\" aria-label=\"Progreso del proyecto\" aria-valuemin=\"0\" aria-valuemax=\"100\" aria-valuenow=\"68\"><span></span></div><div class=\"grid\"><article><small>Tareas completadas</small><strong>24 / 35</strong></article><article><small>Próxima entrega</small><strong>Viernes</strong></article><article><small>Personas asignadas</small><strong>4</strong></article></div></section>"
  },
  {
    "id": "footer",
    "name": "Pie de página",
    "category": "Navegación",
    "description": "Footer compacto con enlaces y aviso legal.",
    "tags": "footer enlaces legal",
    "html": "<footer class=\"cl-footer\"><style>.cl-footer{font:14px/1.5 system-ui;padding:22px;background:#0f172a;color:#cbd5e1;border-radius:14px;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}.cl-footer strong{color:white;font-size:17px}.cl-footer nav{display:flex;gap:14px;flex-wrap:wrap}.cl-footer a{color:inherit;text-decoration:none}.cl-footer small{width:100%;color:#94a3b8}</style><strong>TuMarca</strong><nav aria-label=\"Enlaces del pie\"><a href=\"#privacidad\">Privacidad</a><a href=\"#terminos\">Términos</a><a href=\"#contacto\">Contacto</a></nav><small>© 2026 TuMarca. Reemplaza este texto por tu aviso legal.</small></footer>"
  }
];
  function getComponent(id) { return components.find(item => item.id === id) || null; }
  function searchComponents(query, category) {
    const q = String(query || '').trim().toLocaleLowerCase();
    return components.filter(item => (!category || category === 'Todas' || item.category === category) &&
      (!q || [item.name, item.description, item.category, item.tags].join(' ').toLocaleLowerCase().includes(q)));
  }
  function escapeHtml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function standaloneHtml(component) {
    const item = typeof component === 'string' ? getComponent(component) : component;
    if (!item) throw new Error('Componente desconocido');
    return '<!doctype html>\n<html lang="es">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>' + escapeHtml(item.name) + ' · CodeLab</title>\n</head>\n<body>\n' + item.html + '\n</body>\n</html>\n';
  }
  function init() {
    if (typeof document === 'undefined') return;
    const modal = document.getElementById('componentLibraryModal');
    if (!modal || modal.dataset.componentLibraryInitialized === 'true') return;
    modal.dataset.componentLibraryInitialized = 'true';
    const get = id => document.getElementById(id);
    let selectedId = 'hero';
    let bodyHadOverflowHidden = false;
    const status = message => {
      const target = get('componentLibraryStatus');
      if (target) target.textContent = message;
      if (typeof window.showToast === 'function') window.showToast(message);
    };
    function setSelectionActionsEnabled(enabled) {
      ['componentLibraryCopy', 'componentLibraryDownload', 'componentLibraryInsert'].forEach(id => {
        const button = get(id);
        if (button) button.disabled = !enabled;
      });
    }
    function clearSelected() {
      selectedId = null;
      get('componentLibrarySelectedName').textContent = 'Sin selección';
      get('componentLibrarySelectedDescription').textContent = 'Elige un componente para ver, copiar, exportar o insertar su HTML.';
      get('componentLibraryPreview').srcdoc = '<!doctype html><html lang="es"><body style="font:14px system-ui;padding:24px;color:#475569">Selecciona un componente para ver su vista previa.</body></html>';
      get('componentLibraryCode').value = '';
      setSelectionActionsEnabled(false);
    }
    function renderSelected() {
      const item = getComponent(selectedId);
      if (!item) { clearSelected(); return; }
      get('componentLibrarySelectedName').textContent = item.name;
      get('componentLibrarySelectedDescription').textContent = item.description;
      get('componentLibraryPreview').srcdoc = '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;padding:12px;background:#e2e8f0;font-family:system-ui}*{box-sizing:border-box}</style></head><body>' + item.html + '</body></html>';
      get('componentLibraryCode').value = item.html;
      setSelectionActionsEnabled(true);
    }
    function renderList() {
      const host = get('componentLibraryList');
      if (!host) return;
      const results = searchComponents(get('componentLibrarySearch').value, get('componentLibraryCategory').value);
      if (!results.length) {
        host.innerHTML = '<p class="col-span-full p-5 text-center text-sm text-slate-400">No hay componentes que coincidan con la búsqueda.</p>';
        clearSelected();
        return;
      }
      if (!results.some(item => item.id === selectedId)) {
        selectedId = results.some(item => item.id === 'hero') ? 'hero' : results[0].id;
      }
      host.innerHTML = results.map(item => '<button type="button" data-component-id="' + item.id + '" class="text-left rounded-xl border p-3 transition ' + (item.id === selectedId ? 'border-cyan-400 bg-cyan-500/10' : 'border-slate-800 bg-slate-950/50 hover:border-slate-600') + '"><span class="block text-xs font-bold text-slate-100">' + item.name + '</span><span class="block text-[10px] text-slate-400 mt-1">' + item.category + '</span><span class="block text-[11px] text-slate-400 mt-2">' + item.description + '</span></button>').join('');
      host.querySelectorAll('[data-component-id]').forEach(button => button.addEventListener('click', () => {
        selectedId = button.dataset.componentId; renderList(); renderSelected();
      }));
      renderSelected();
    }
    function trapModalFocus(event) {
      if (event.key !== 'Tab') return;
      const focusable = Array.from(modal.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),iframe:not([tabindex="-1"]),[tabindex]:not([tabindex="-1"])'))
        .filter(element => element.getClientRects().length > 0 && window.getComputedStyle(element).visibility !== 'hidden');
      if (!focusable.length) { event.preventDefault(); return; }
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    }

    function open() {
      bodyHadOverflowHidden = document.body.classList.contains('overflow-hidden');
      modal.classList.remove('hidden');
      document.body.classList.add('overflow-hidden');
      renderList();
      get('componentLibrarySearch').focus();
    }
    function close() {
      modal.classList.add('hidden');
      if (!bodyHadOverflowHidden) document.body.classList.remove('overflow-hidden');
      get('openComponentLibrary').focus();
    }
    async function copyCode() {
      const item = getComponent(selectedId); if (!item) { status('Selecciona un componente antes de copiar.'); return; }
      try { await navigator.clipboard.writeText(item.html); status('Código de ' + item.name + ' copiado.'); }
      catch (_) { get('componentLibraryCode').focus(); get('componentLibraryCode').select(); status('Selecciona el código y cópialo manualmente.'); }
    }
    function insertIntoProject() {
      const item = getComponent(selectedId);
      if (!item) { status('Selecciona un componente antes de insertarlo.'); return; }
      const project = typeof window.getCurrentProject === 'function' ? window.getCurrentProject() : null;
      if (!project || project.type === 'design' || typeof window.getEditorValue !== 'function' || typeof window.setEditorValue !== 'function') {
        status('Abre primero un proyecto web para insertar un componente.'); return;
      }
      const html = String(window.getEditorValue('html') || '');
      const next = /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, item.html + '\n</body>') : html + '\n' + item.html;
      // Keep the editor within the same per-field limit enforced by the server.
      // Reject before touching the editor so a tool action cannot create a
      // project that then fails validation during persistence/synchronization.
      if (next.length > 500000) {
        status('No se insertó el componente: el HTML superaría el límite de 500.000 caracteres. Reduce el código existente e inténtalo de nuevo.');
        return;
      }
      if (typeof window.saveCurrentCodeToActiveProject !== 'function') {
        status('No se pudo guardar el componente porque el editor todavía no está listo. Inténtalo de nuevo.');
        return;
      }
      window.setEditorValue('html', next);
      window.saveCurrentCodeToActiveProject(true);
      if (typeof window.updatePreview === 'function') window.updatePreview();
      status('Componente insertado en el HTML del proyecto.');
    }
    get('openComponentLibrary').addEventListener('click', open);
    get('closeComponentLibrary').addEventListener('click', close);
    get('componentLibraryCloseFooter').addEventListener('click', close);
    modal.addEventListener('click', event => { if (event.target === modal) close(); });
    modal.addEventListener('keydown', trapModalFocus);
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !modal.classList.contains('hidden')) close(); });
    get('componentLibrarySearch').addEventListener('input', renderList);
    get('componentLibraryCategory').addEventListener('change', renderList);
    get('componentLibraryCopy').addEventListener('click', copyCode);
    get('componentLibraryDownload').addEventListener('click', () => {
      const item = getComponent(selectedId);
      if (!item) { status('Selecciona un componente antes de exportarlo.'); return; }
      const blob = new Blob([standaloneHtml(item)], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = 'codelab-' + item.id + '.html';
      document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
      status('Plantilla HTML exportada.');
    });
    get('componentLibraryInsert').addEventListener('click', insertIntoProject);
    renderList();
  }
  return { components, getComponent, searchComponents, standaloneHtml, escapeHtml, init };
});
