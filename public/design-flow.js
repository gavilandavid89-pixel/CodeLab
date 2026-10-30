/* CodeLab visual flow graph: explicit option-to-page connections. */
(function () {
  'use strict';
  let modal, canvas, svg, pendingStart = null, draftPath = null;
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function designProjects() { return projects.filter(p => p && p.type === 'design' && p.design && Array.isArray(p.design.elements)); }
  function findProject(id) { return designProjects().find(p => p.id === id); }
  function allConnections() {
    const out = [];
    for (const p of designProjects()) {
      if (!Array.isArray(p.design.flowConnections)) p.design.flowConnections = [];
      for (const c of p.design.flowConnections) {
        if (c && typeof c.sourceElementId === 'string' && typeof c.targetProjectId === 'string') out.push({ sourceProjectId: p.id, ...c });
      }
    }
    return out;
  }
  function ensureModal() {
    if (modal) return;
    modal = document.createElement('div');
    modal.id = 'designFlowGraphModal';
    modal.className = 'hidden fixed inset-0 z-[100] bg-slate-950/90 p-2 sm:p-5';
    modal.innerHTML = '<section class="mx-auto flex h-full max-w-[1600px] flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 text-slate-100 shadow-2xl">' +
      '<header class="flex flex-wrap items-center gap-3 border-b border-slate-700 px-4 py-3"><div class="min-w-0 flex-1"><h2 class="font-bold">Nodos y conexiones</h2><p class="text-xs text-slate-400">Arrastra una soga desde una opción hasta la página de destino. Los menús desplegables no navegan.</p></div><button id="designFlowClose" class="rounded-lg bg-slate-800 px-3 py-2 text-sm" type="button">Cerrar</button></header>' +
      '<div class="flex flex-wrap items-center gap-2 border-b border-slate-800 px-4 py-2 text-xs"><span class="rounded bg-violet-500/15 px-2 py-1 text-violet-200">Página = destino</span><span class="rounded bg-cyan-500/15 px-2 py-1 text-cyan-200">Opción = origen</span><span class="text-slate-400">Marca un botón como menú para quitarle el puerto de navegación.</span><button id="designFlowRefresh" class="ml-auto rounded-lg border border-slate-700 px-3 py-2">Actualizar nodos</button></div>' +
      '<div id="designFlowCanvas" class="relative flex-1 overflow-auto bg-[#12141d]"><svg id="designFlowWires" class="pointer-events-none absolute left-0 top-0 z-10 overflow-visible" style="width:100%;height:100%;min-width:100%;min-height:100%"></svg><div id="designFlowCards" class="relative z-20 grid min-w-max grid-cols-1 gap-5 p-5 sm:grid-cols-2 xl:grid-cols-3"></div></div>' +
      '<footer class="border-t border-slate-800 px-4 py-2 text-xs text-slate-400">Las conexiones se guardan con el proyecto de origen. Usa nombres de capa descriptivos para mantener el grafo legible.</footer></section>';
    document.body.appendChild(modal);
    canvas = modal.querySelector('#designFlowCanvas'); svg = modal.querySelector('#designFlowWires');
    modal.querySelector('#designFlowClose').addEventListener('click', closeDesignFlowGraph);
    modal.querySelector('#designFlowRefresh').addEventListener('click', renderGraph);
    modal.addEventListener('click', e => { if (e.target === modal) closeDesignFlowGraph(); });
    document.addEventListener('pointermove', moveDraft);
    document.addEventListener('pointerup', finishDraft);
    window.addEventListener('resize', drawWires);
  }
  function openDesignFlowGraph() {
    ensureModal(); modal.classList.remove('hidden'); renderGraph();
  }
  function closeDesignFlowGraph() { if (modal) modal.classList.add('hidden'); pendingStart = null; if (draftPath) draftPath.remove(); draftPath = null; }
  function renderGraph() {
    if (!modal || modal.classList.contains('hidden')) return;
    const cards = modal.querySelector('#designFlowCards');
    const list = designProjects();
    if (!list.length) { cards.innerHTML = '<p class="text-sm text-slate-400">Crea un proyecto de diseño para comenzar.</p>'; svg.innerHTML = ''; return; }
    cards.innerHTML = list.map(p => {
      if (!Array.isArray(p.design.flowConnections)) p.design.flowConnections = [];
      const actions = p.design.elements.filter(el => el.type === 'button');
      return '<article data-flow-page="' + esc(p.id) + '" class="w-[min(88vw,420px)] rounded-xl border border-slate-700 bg-slate-900 shadow-xl">' +
        '<div data-flow-target-project="' + esc(p.id) + '" class="flex min-h-16 items-center gap-3 border-b border-slate-700 bg-violet-500/10 p-3"><span class="grid h-9 w-9 place-items-center rounded-lg bg-violet-500/20 text-violet-200"><i class="fa-solid fa-window-maximize"></i></span><div class="min-w-0 flex-1"><div class="truncate font-semibold">' + esc(p.name) + '</div><div class="text-[10px] text-slate-400">Página · soltar aquí para conectar</div></div><span class="text-[10px] text-slate-500">' + actions.length + ' opciones</span></div>' +
        '<div class="space-y-2 p-3">' + (actions.length ? actions.map(el => {
          const isMenu = el.flowRole === 'menu';
          const outgoing = p.design.flowConnections.filter(c => c.sourceElementId === el.id);
          return '<div class="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/70 p-2" data-flow-action="' + esc(el.id) + '" data-flow-source-project="' + esc(p.id) + '">' +
            '<span class="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-cyan-500/15 text-cyan-200"><i class="fa-solid fa-arrow-pointer"></i></span><div class="min-w-0 flex-1"><div class="truncate text-xs font-medium">' + esc(el.label || el.text || 'Botón') + '</div><label class="mt-1 flex items-center gap-1.5 text-[10px] text-slate-400"><input type="checkbox" data-flow-menu="' + esc(el.id) + '" data-flow-project="' + esc(p.id) + '" ' + (isMenu ? 'checked' : '') + '> Menú desplegable</label></div>' +
            (isMenu ? '<span class="text-[10px] text-amber-300">Menú</span>' : '<button type="button" data-flow-source-port="' + esc(el.id) + '" data-flow-project="' + esc(p.id) + '" title="Arrastra para crear conexión" class="h-8 w-8 shrink-0 touch-none rounded-full border-2 border-cyan-300 bg-cyan-500/20 text-cyan-100">●</button>') +
            (outgoing.length ? '<span class="text-[10px] text-violet-300">' + outgoing.length + ' ↗</span>' : '') + '</div>';
        }).join('') : '<p class="text-xs text-slate-500">Añade capas de tipo Botón para crear opciones conectables.</p>') + '</div>' +
        (p.design.flowConnections.length ? '<div class="border-t border-slate-800 p-3"><div class="mb-2 text-[10px] font-semibold uppercase text-slate-500">Conexiones</div>' + p.design.flowConnections.map(c => {
          const source = p.design.elements.find(el => el.id === c.sourceElementId);
          const target = findProject(c.targetProjectId);
          return '<div class="flex items-center gap-2 py-1 text-xs"><span class="min-w-0 flex-1 truncate">' + esc(source ? (source.label || source.text || 'Opción') : 'Opción eliminada') + ' → ' + esc(target ? target.name : 'Página eliminada') + '</span><button data-flow-remove="' + esc(c.sourceElementId) + '" data-flow-project="' + esc(p.id) + '" data-flow-target="' + esc(c.targetProjectId) + '" class="rounded px-2 py-1 text-red-300 hover:bg-red-500/10" aria-label="Eliminar conexión">×</button></div>';
        }).join('') + '</div>' : '') + '</article>';
    }).join('');
    cards.querySelectorAll('[data-flow-source-port]').forEach(port => port.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      pendingStart = { projectId: port.dataset.flowProject, elementId: port.dataset.flowSourcePort };
      draftPath = document.createElementNS('http://www.w3.org/2000/svg','path');
      draftPath.setAttribute('fill','none'); draftPath.setAttribute('stroke','#22d3ee'); draftPath.setAttribute('stroke-width','3'); draftPath.setAttribute('stroke-dasharray','7 5'); svg.appendChild(draftPath);
      moveDraft(e);
    }));
    cards.querySelectorAll('[data-flow-target-project]').forEach(target => target.addEventListener('pointerup', e => {
      if (!pendingStart) return;
      e.preventDefault();
      const sourceProject = findProject(pendingStart.projectId), source = sourceProject && sourceProject.design.elements.find(el => el.id === pendingStart.elementId);
      const targetId = target.dataset.flowTargetProject;
      if (!sourceProject || !source || sourceProject.id === targetId) { showToast('Conecta una opción con otra página distinta.', 'warn'); return; }
      if (source.flowRole === 'menu') { showToast('Los menús desplegables no navegan a otra página.', 'warn'); return; }
      sourceProject.design.flowConnections = (sourceProject.design.flowConnections || []).filter(c => c.sourceElementId !== source.id);
      sourceProject.design.flowConnections.push({ sourceElementId: source.id, targetProjectId: targetId });
      source.flowRole = 'navigate';
      sourceProject.updatedAt = new Date().toISOString();
      saveProjectsToStorage(); renderGraph(); showToast('Conexión creada desde «' + (source.label || source.text || 'Opción') + '» a la página de destino.');
    }));
    cards.querySelectorAll('[data-flow-menu]').forEach(check => check.addEventListener('change', () => {
      const p = findProject(check.dataset.flowProject), el = p && p.design.elements.find(item => item.id === check.dataset.flowMenu);
      if (!p || !el) return;
      el.flowRole = check.checked ? 'menu' : '';
      if (check.checked) p.design.flowConnections = (p.design.flowConnections || []).filter(c => c.sourceElementId !== el.id);
      p.updatedAt = new Date().toISOString(); saveProjectsToStorage(); renderGraph();
    }));
    cards.querySelectorAll('[data-flow-remove]').forEach(button => button.addEventListener('click', () => {
      const p = findProject(button.dataset.flowProject);
      if (!p) return;
      p.design.flowConnections = (p.design.flowConnections || []).filter(c => !(c.sourceElementId === button.dataset.flowRemove && c.targetProjectId === button.dataset.flowTarget));
      p.updatedAt = new Date().toISOString(); saveProjectsToStorage(); renderGraph();
    }));
    requestAnimationFrame(drawWires);
  }
  function pointFor(selector, attr, id) {
    const el = Array.from(modal.querySelectorAll(selector)).find(item => item.getAttribute(attr) === id);
    if (!el) return null;
    const r = el.getBoundingClientRect(), c = canvas.getBoundingClientRect();
    return { x: r.left - c.left + canvas.scrollLeft + r.width/2, y: r.top - c.top + canvas.scrollTop + r.height/2 };
  }
  function drawWires() {
    if (!modal || modal.classList.contains('hidden')) return;
    const w = Math.max(canvas.scrollWidth, canvas.clientWidth), h = Math.max(canvas.scrollHeight, canvas.clientHeight);
    svg.setAttribute('width', w); svg.setAttribute('height', h); svg.style.width = w+'px'; svg.style.height = h+'px';
    svg.querySelectorAll('path[data-connection]').forEach(p => p.remove());
    for (const c of allConnections()) {
      const a = pointFor('[data-flow-source-port]','data-flow-source-port',c.sourceElementId);
      const sourceCard = Array.from(modal.querySelectorAll('[data-flow-source-project]')).find(el => el.dataset.flowSourceProject === c.sourceProjectId && el.dataset.flowAction === c.sourceElementId);
      const target = Array.from(modal.querySelectorAll('[data-flow-target-project]')).find(el => el.dataset.flowTargetProject === c.targetProjectId);
      if (!sourceCard || !target || !a) continue;
      const port = sourceCard.querySelector('[data-flow-source-port]');
      if (!port) continue;
      const r=port.getBoundingClientRect(), cr=canvas.getBoundingClientRect();
      const start={x:r.left-cr.left+canvas.scrollLeft+r.width/2,y:r.top-cr.top+canvas.scrollTop+r.height/2};
      const tr=target.getBoundingClientRect(), end={x:tr.left-cr.left+canvas.scrollLeft+tr.width/2,y:tr.top-cr.top+canvas.scrollTop+tr.height/2};
      const mid=(start.x+end.x)/2, path=document.createElementNS('http://www.w3.org/2000/svg','path');
      path.setAttribute('d','M '+start.x+' '+start.y+' C '+mid+' '+start.y+', '+mid+' '+end.y+', '+end.x+' '+end.y);
      path.setAttribute('fill','none'); path.setAttribute('stroke','#8b5cf6'); path.setAttribute('stroke-width','3'); path.setAttribute('data-connection','true'); svg.appendChild(path);
    }
  }
  function moveDraft(e) {
    if (!pendingStart || !draftPath || !canvas) return;
    const port = Array.from(modal.querySelectorAll('[data-flow-source-port]')).find(el => el.dataset.flowSourcePort === pendingStart.elementId && el.dataset.flowProject === pendingStart.projectId);
    if (!port) return;
    const a=port.getBoundingClientRect(), c=canvas.getBoundingClientRect();
    const x1=a.left-c.left+canvas.scrollLeft+a.width/2, y1=a.top-c.top+canvas.scrollTop+a.height/2;
    const x2=e.clientX-c.left+canvas.scrollLeft, y2=e.clientY-c.top+canvas.scrollTop, mid=(x1+x2)/2;
    draftPath.setAttribute('d','M '+x1+' '+y1+' C '+mid+' '+y1+', '+mid+' '+y2+', '+x2+' '+y2);
  }
  function finishDraft(e) {
    if (!pendingStart) return;
    const target = e.target && e.target.closest ? e.target.closest('[data-flow-target-project]') : null;
    if (target) {
      // The target pointerup handler performs the save; leave cleanup to the next frame.
      setTimeout(() => { pendingStart = null; if (draftPath) draftPath.remove(); draftPath = null; drawWires(); }, 0);
    } else {
      pendingStart = null; if (draftPath) draftPath.remove(); draftPath = null;
    }
  }
  window.openDesignFlowGraph = openDesignFlowGraph;
  window.closeDesignFlowGraph = closeDesignFlowGraph;
})();