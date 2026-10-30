/* CodeLab visual flow graph: explicit option-to-page connections. */
(function () {
  'use strict';
  let modal, canvas, svg, pendingStart = null, draftPath = null, chooseMode = false, selectedSource = null, activeTarget = null, gestureOrigin = null;
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
    modal.className = 'hidden fixed inset-0 z-[100] bg-slate-950/95 p-1 sm:p-2';
    modal.innerHTML = '<section class="flex h-full w-full flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 text-slate-100 shadow-2xl">' +
      '<header class="flex flex-wrap items-center gap-3 border-b border-slate-700 px-4 py-3"><div class="min-w-0 flex-1"><h2 class="font-bold">Nodos y conexiones</h2><p class="text-xs text-slate-400">Activa Elegir, selecciona una capa existente y arrastra su conector gris hasta una página. Los menús no navegan.</p></div><button id="designFlowClose" class="rounded-lg bg-slate-800 px-3 py-2 text-sm" type="button">Cerrar</button></header>' +
      '<div class="flex flex-wrap items-center gap-2 border-b border-slate-800 px-4 py-2 text-xs"><span class="rounded bg-violet-500/15 px-2 py-1 text-violet-200">Página = destino</span><span class="rounded bg-cyan-500/15 px-2 py-1 text-cyan-200">Opción = origen</span><span class="text-slate-400">Marca un botón como menú para quitarle el puerto de navegación.</span><button id="designFlowChoose" type="button" aria-pressed="false" class="rounded-lg border border-yellow-400/60 px-3 py-2 text-yellow-200">Elegir: desactivado</button><button id="designFlowOverviewToggle" type="button" aria-expanded="false" class="rounded-lg border border-cyan-700/70 px-3 py-2 text-cyan-200">Ver mapa de conexiones</button><span class="text-slate-400">Amarillo = origen · blanco = destino · dos dedos para mover el lienzo</span><button id="designFlowRefresh" class="ml-auto rounded-lg border border-slate-700 px-3 py-2">Actualizar nodos</button></div>' +
      '<div id="designFlowOverview" class="hidden max-h-[32vh] overflow-auto border-b border-slate-800 bg-slate-950/80 px-4 py-3" aria-live="polite"></div><div id="designFlowCanvas" class="relative flex-1 min-h-0 overflow-auto bg-[#12141d]" style="touch-action:pan-x pan-y;overscroll-behavior:contain"><svg id="designFlowWires" class="pointer-events-none absolute left-0 top-0 z-10 overflow-visible" style="width:100%;height:100%;min-width:100%;min-height:100%"></svg><div id="designFlowCards" class="relative z-20 grid w-max min-w-full grid-cols-[minmax(280px,1fr)] gap-5 p-4 sm:grid-cols-[repeat(2,minmax(320px,1fr))] xl:grid-cols-[repeat(3,minmax(340px,1fr))] 2xl:grid-cols-[repeat(4,minmax(340px,1fr))]"></div></div>' +
      '<footer class="border-t border-slate-800 px-4 py-2 text-xs text-slate-400">Las conexiones se guardan con el proyecto de origen. Usa nombres de capa descriptivos para mantener el grafo legible.</footer></section>';
    document.body.appendChild(modal);
    canvas = modal.querySelector('#designFlowCanvas'); svg = modal.querySelector('#designFlowWires');
    modal.querySelector('#designFlowClose').addEventListener('click', closeDesignFlowGraph);
    modal.querySelector('#designFlowRefresh').addEventListener('click', renderGraph);
    modal.querySelector('#designFlowOverviewToggle').addEventListener('click', () => { const panel=modal.querySelector('#designFlowOverview'); const opening=panel.classList.contains('hidden'); panel.classList.toggle('hidden',!opening); modal.querySelector('#designFlowOverviewToggle').setAttribute('aria-expanded',String(opening)); modal.querySelector('#designFlowOverviewToggle').textContent=opening?'Ocultar mapa de conexiones':'Ver mapa de conexiones'; renderOverview(); });
    modal.querySelector('#designFlowChoose').addEventListener('click', () => { chooseMode = !chooseMode; if (!chooseMode) selectedSource = null; updateChooseButton(); renderGraph(); });
    modal.addEventListener('click', e => { if (e.target === modal) closeDesignFlowGraph(); });
    document.addEventListener('pointermove', moveDraft);
    document.addEventListener('pointerup', finishDraft);
    window.addEventListener('resize', drawWires);
  }
  function updateChooseButton() {
    if (!modal) return; const b=modal.querySelector('#designFlowChoose'); if (!b) return; b.textContent='Elegir: '+(chooseMode?'activado':'desactivado'); b.setAttribute('aria-pressed',String(chooseMode)); b.classList.toggle('bg-yellow-400/15',chooseMode);
  }
  function renderOverview() {
    if (!modal) return; const panel=modal.querySelector('#designFlowOverview'); if (!panel) return;
    const pages=designProjects(), connections=allConnections(), pageById=new Map(pages.map(p=>[p.id,p]));
    const broken=connections.filter(c=>!pageById.has(c.targetProjectId)||!pageById.get(c.sourceProjectId)?.design.elements.some(el=>el.id===c.sourceElementId));
    panel.innerHTML='<div class="mb-3 flex flex-wrap items-center gap-2"><strong class="text-sm text-slate-100">Mapa de conexiones</strong><span class="rounded-full bg-slate-800 px-2 py-1 text-xs">'+connections.length+' conexiones</span><span class="rounded-full '+(broken.length?'bg-red-500/15 text-red-300':'bg-emerald-500/15 text-emerald-300')+' px-2 py-1 text-xs">'+broken.length+' rotas</span></div>'+(connections.length?'<div class="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">'+connections.map(c=>{const p=pageById.get(c.sourceProjectId),el=p&&p.design.elements.find(item=>item.id===c.sourceElementId),target=pageById.get(c.targetProjectId),bad=!p||!el||!target;return '<div class="flex min-w-0 items-center gap-2 rounded-lg border '+(bad?'border-red-500/40':'border-slate-800')+' bg-slate-900 px-3 py-2"><span class="min-w-0 flex-1"><span class="block truncate text-xs font-semibold">'+esc(p?p.name:'Proyecto eliminado')+' · '+esc(el?(el.label||el.text||el.name||el.type||'Capa'):'Capa eliminada')+'</span><span class="block truncate text-[11px] '+(bad?'text-red-300':'text-cyan-300')+'">→ '+esc(target?target.name:'Destino inexistente')+'</span></span><button type="button" data-flow-overview-jump="'+esc(c.sourceProjectId)+'" class="shrink-0 rounded-md bg-slate-800 px-2 py-1 text-xs hover:bg-slate-700">Ver</button></div>';}).join('')+'</div>':'<p class="text-xs text-slate-400">Todavía no hay conexiones. Elige una capa existente y arrastra su conector a otra página.</p>');
    panel.querySelectorAll('[data-flow-overview-jump]').forEach(b=>b.addEventListener('click',()=>{const card=modal.querySelector('[data-flow-page="'+CSS.escape(b.dataset.flowOverviewJump)+'"]');if(card){card.scrollIntoView({behavior:'smooth',block:'nearest',inline:'nearest'});card.classList.add('ring-2','ring-cyan-400');setTimeout(()=>card.classList.remove('ring-2','ring-cyan-400'),1200);}}));
  }
  function openDesignFlowGraph() {
    ensureModal(); modal.classList.remove('hidden'); updateChooseButton(); renderGraph();
  }
  function closeDesignFlowGraph() { if (modal) modal.classList.add('hidden'); pendingStart = null; gestureOrigin = null; activeTarget = null; if (draftPath) draftPath.remove(); const halo=svg.querySelector('[data-draft-halo]'); if(halo) halo.remove(); draftPath = null; modal.querySelectorAll('[data-flow-target-project]').forEach(t=>t.classList.remove('border-white','ring-2','ring-white/90','shadow-[0_0_24px_rgba(255,255,255,0.45)]')); }
  function renderGraph() {
    if (!modal || modal.classList.contains('hidden')) return;
    const cards = modal.querySelector('#designFlowCards');
    const list = designProjects();
    if (!list.length) { cards.innerHTML = '<p class="text-sm text-slate-400">Crea un proyecto de diseño para comenzar.</p>'; svg.innerHTML = ''; return; }
    cards.innerHTML = list.map(p => {
      if (!Array.isArray(p.design.flowConnections)) p.design.flowConnections = [];
      const actions = p.design.elements;
      return '<article data-flow-page="' + esc(p.id) + '" data-flow-target-project="' + esc(p.id) + '" class="w-[min(88vw,420px)] rounded-xl border border-slate-700 bg-slate-900 shadow-xl transition-[border-color,box-shadow] duration-100">' +
        '<div class="flex min-h-16 items-center gap-3 border-b border-slate-700 bg-violet-500/10 p-3"><span class="grid h-9 w-9 place-items-center rounded-lg bg-violet-500/20 text-violet-200"><i class="fa-solid fa-window-maximize"></i></span><div class="min-w-0 flex-1"><div class="truncate font-semibold">' + esc(p.name) + '</div><div class="text-[10px] text-slate-400">Página · soltar aquí para conectar</div></div><span class="text-[10px] text-slate-500">' + actions.length + ' capas</span></div>' +
        '<div class="space-y-2 p-3">' + (actions.length ? actions.map(el => {
          const isMenu = el.flowRole === 'menu', isSelected = selectedSource && selectedSource.projectId === p.id && selectedSource.elementId === el.id;
          const outgoing = p.design.flowConnections.filter(c => c.sourceElementId === el.id);
          const hasConnection = outgoing.length > 0;
          const label = el.label || el.text || el.name || el.type || 'Capa';
          return '<div role="button" tabindex="0" data-flow-action="' + esc(el.id) + '" data-flow-source-project="' + esc(p.id) + '" class="flex items-center gap-2 rounded-lg border p-2 '+(isSelected?'border-yellow-300 ring-1 ring-yellow-300/70':'border-slate-800')+' bg-slate-950/70 '+(chooseMode?'cursor-pointer':'')+'" title="'+(chooseMode?'Elegir esta capa como origen':'Activa Elegir para seleccionar esta capa')+'">' +
            '<span class="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-cyan-500/15 text-cyan-200"><i class="fa-solid fa-shapes"></i></span><div class="min-w-0 flex-1"><div class="truncate text-xs font-medium">' + esc(label) + '</div><div class="text-[10px] text-slate-500">' + esc(el.type || 'capa') + (hasConnection?' · conectada':'') + '</div><label class="mt-1 flex items-center gap-1.5 text-[10px] text-slate-400"><input type="checkbox" data-flow-menu="' + esc(el.id) + '" data-flow-project="' + esc(p.id) + '" ' + (isMenu ? 'checked' : '') + '> Menú desplegable</label></div>' +
            (isMenu ? '<span class="text-[10px] text-amber-300">Menú</span>' : '<button type="button" data-flow-source-port="' + esc(el.id) + '" data-flow-project="' + esc(p.id) + '" title="'+(isSelected?'Arrastra la soga desde aquí':'Selecciona primero esta capa')+'" class="h-8 w-8 shrink-0 touch-none rounded-full border-2 '+(isSelected?'border-slate-300 bg-slate-500/30 text-slate-100':'border-slate-600 bg-slate-700/30 text-slate-400')+'">●</button>') +
            (outgoing.length ? '<span class="text-[10px] text-violet-300">' + outgoing.length + ' ↗</span>' : '') + '</div>';
        }).join('') : '<p class="text-xs text-slate-500">Añade formas, texto, imágenes u otras capas al diseño para crear opciones conectables.</p>') + '</div>' +
        (p.design.flowConnections.length ? '<div class="border-t border-slate-800 p-3"><div class="mb-2 text-[10px] font-semibold uppercase text-slate-500">Conexiones</div>' + p.design.flowConnections.map(c => {
          const source = p.design.elements.find(el => el.id === c.sourceElementId);
          const target = findProject(c.targetProjectId);
          return '<div class="flex items-center gap-2 py-1 text-xs"><span class="min-w-0 flex-1 truncate">' + esc(source ? (source.label || source.text || source.type || 'Capa') : 'Capa eliminada') + ' → ' + esc(target ? target.name : 'Página eliminada') + '</span><button data-flow-remove="' + esc(c.sourceElementId) + '" data-flow-project="' + esc(p.id) + '" data-flow-target="' + esc(c.targetProjectId) + '" class="rounded px-2 py-1 text-red-300 hover:bg-red-500/10" aria-label="Eliminar conexión">×</button></div>';
        }).join('') + '</div>' : '') + '</article>';
    }).join('');
    updateChooseButton();
    cards.querySelectorAll('[data-flow-action]').forEach(row => {
      const selectRow = e => {
        if (!chooseMode || e.target.closest('input,button,label')) return;
        selectedSource = { projectId: row.dataset.flowSourceProject, elementId: row.dataset.flowAction };
        renderGraph();
      };
      row.addEventListener('click', selectRow);
      row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectRow(e); } });
    });
    cards.querySelectorAll('[data-flow-source-port]').forEach(port => port.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      if (!chooseMode || !selectedSource || selectedSource.projectId !== port.dataset.flowProject || selectedSource.elementId !== port.dataset.flowSourcePort) { showToast('Activa Elegir y selecciona primero la capa.', 'warn'); return; }
      pendingStart = { projectId: port.dataset.flowProject, elementId: port.dataset.flowSourcePort };
      draftPath = document.createElementNS('http://www.w3.org/2000/svg','path');
      draftPath.setAttribute('fill','none'); draftPath.setAttribute('stroke','#9ca3af'); draftPath.setAttribute('stroke-width','3'); draftPath.setAttribute('stroke-linecap','round'); draftPath.setAttribute('stroke-dasharray','7 5'); draftPath.setAttribute('data-draft-wire','true'); const draftHalo=draftPath.cloneNode(false); draftHalo.setAttribute('stroke','#ffffff'); draftHalo.setAttribute('stroke-width','6'); draftHalo.setAttribute('stroke-opacity','0.8'); draftHalo.setAttribute('data-draft-halo','true'); svg.appendChild(draftHalo); svg.appendChild(draftPath);
      gestureOrigin = { x: e.clientX, y: e.clientY }; activeTarget = null;
      moveDraft(e);
    }));
    cards.querySelectorAll('[data-flow-target-project]').forEach(target => target.addEventListener('pointerup', e => {
      if (!pendingStart) return;
      e.preventDefault();
      commitConnection(activeTarget || target);
    }));
    cards.querySelectorAll('[data-flow-menu]').forEach(check => check.addEventListener('change', () => {
      const p = findProject(check.dataset.flowProject), el = p && p.design.elements.find(item => item.id === check.dataset.flowMenu);
      if (!p || !el) return;
      el.flowRole = check.checked ? 'menu' : '';
      if (check.checked && selectedSource && selectedSource.projectId === p.id && selectedSource.elementId === el.id) selectedSource = null;
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
  function commitConnection(target) {
    if (!pendingStart || !target) return;
    const sourceProject = findProject(pendingStart.projectId), source = sourceProject && sourceProject.design.elements.find(el => el.id === pendingStart.elementId);
    const targetId = target.dataset.flowTargetProject;
    if (!sourceProject || !source || sourceProject.id === targetId) { showToast('Conecta una opción con otra página distinta.', 'warn'); return; }
    if (source.flowRole === 'menu') { showToast('Los menús desplegables no navegan a otra página.', 'warn'); return; }
    sourceProject.design.flowConnections = (sourceProject.design.flowConnections || []).filter(c => c.sourceElementId !== source.id);
    sourceProject.design.flowConnections.push({ sourceElementId: source.id, targetProjectId: targetId });
    selectedSource = { projectId: sourceProject.id, elementId: source.id };
    source.flowRole = 'navigate';
    sourceProject.updatedAt = new Date().toISOString();
    saveProjectsToStorage(); renderGraph(); showToast('Conexión creada desde «' + (source.label || source.text || 'Opción') + '» a la página de destino.');
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
    svg.querySelectorAll('path[data-connection],path[data-wire-halo]').forEach(p => p.remove());
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
      const halo=path.cloneNode(false); halo.setAttribute('fill','none'); halo.setAttribute('stroke','#ffffff'); halo.setAttribute('stroke-width','6'); halo.setAttribute('stroke-opacity','0.72'); halo.setAttribute('stroke-linecap','round'); halo.setAttribute('data-wire-halo','true'); svg.appendChild(halo);
      path.setAttribute('fill','none'); path.setAttribute('stroke','#9ca3af'); path.setAttribute('stroke-width','3'); path.setAttribute('stroke-linecap','round'); path.setAttribute('data-connection','true'); svg.appendChild(path);
    }
  }
  function rayRectDistance(sx, sy, dx, dy, rect, maxDistance) {
    let near=0, far=maxDistance;
    for (const [origin, direction, min, max] of [[sx,dx,rect.left,rect.right],[sy,dy,rect.top,rect.bottom]]) {
      if (Math.abs(direction)<0.0001) { if(origin<min||origin>max) return null; continue; }
      let a=(min-origin)/direction, b=(max-origin)/direction; if(a>b){const swap=a;a=b;b=swap;}
      near=Math.max(near,a); far=Math.min(far,b); if(near>far) return null;
    }
    return far<0?null:Math.max(0,near);
  }
  function moveDraft(e) {
    if (!pendingStart || !draftPath || !canvas) return;
    const port = Array.from(modal.querySelectorAll('[data-flow-source-port]')).find(el => el.dataset.flowSourcePort === pendingStart.elementId && el.dataset.flowProject === pendingStart.projectId);
    if (!port) return;
    const a=port.getBoundingClientRect(), c=canvas.getBoundingClientRect();
    const x1=a.left-c.left+canvas.scrollLeft+a.width/2, y1=a.top-c.top+canvas.scrollTop+a.height/2;
    const sx=gestureOrigin?gestureOrigin.x:e.clientX, sy=gestureOrigin?gestureOrigin.y:e.clientY;
    let dx=e.clientX-sx, dy=e.clientY-sy, length=Math.hypot(dx,dy);
    if(length<1){dx=1;dy=0;length=1;}
    dx/=length;dy/=length;
    const rayLength=Math.max(260,Math.min(640,Math.max(canvas.clientWidth,canvas.clientHeight)*0.55));
    const ex=sx+dx*rayLength, ey=sy+dy*rayLength;
    const canvasRect=canvas.getBoundingClientRect(), x2=ex-canvasRect.left+canvas.scrollLeft, y2=ey-canvasRect.top+canvas.scrollTop, mid=(x1+x2)/2;
    const d='M '+x1+' '+y1+' C '+mid+' '+y1+', '+mid+' '+y2+', '+x2+' '+y2; draftPath.setAttribute('d',d); const draftHalo=svg.querySelector('[data-draft-halo]'); if(draftHalo) draftHalo.setAttribute('d',d);
    const targets=Array.from(modal.querySelectorAll('[data-flow-target-project]')); let hit=null, hitDistance=Infinity;
    for(const card of targets){if(card.dataset.flowTargetProject===pendingStart.projectId)continue;const t=rayRectDistance(sx,sy,dx,dy,card.getBoundingClientRect(),rayLength);if(t!==null&&t<hitDistance){hit=card;hitDistance=t;}}
    if(hit!==activeTarget){if(activeTarget)activeTarget.classList.remove('border-white','ring-2','ring-white/90','shadow-[0_0_24px_rgba(255,255,255,0.45)]');activeTarget=hit;if(activeTarget)activeTarget.classList.add('border-white','ring-2','ring-white/90','shadow-[0_0_24px_rgba(255,255,255,0.45)]');}
  }
  function finishDraft(e) {
    if (!pendingStart) return;
    const directTarget = e.target && e.target.closest ? e.target.closest('[data-flow-target-project]') : null;
    const target = activeTarget || directTarget;
    if (target) {
      if (target !== directTarget) commitConnection(target);
      setTimeout(() => { pendingStart = null; gestureOrigin = null; activeTarget = null; if (draftPath) draftPath.remove(); const halo=svg.querySelector('[data-draft-halo]'); if(halo) halo.remove(); draftPath = null; modal.querySelectorAll('[data-flow-target-project]').forEach(t=>t.classList.remove('border-white','ring-2','ring-white/90','shadow-[0_0_24px_rgba(255,255,255,0.45)]')); drawWires(); }, 0);
    } else {
      pendingStart = null; if (draftPath) draftPath.remove(); draftPath = null;
    }
  }
  function buildFlowAwareWebHtml(root, fallbackHtml) {
    const projectsById = new Map(designProjects().map(p => [p.id, p]));
    const reachable = [], seen = new Set();
    function visit(p) {
      if (!p || seen.has(p.id)) return;
      seen.add(p.id); reachable.push(p);
      for (const c of (p.design.flowConnections || [])) visit(projectsById.get(c.targetProjectId));
    }
    visit(root);
    if (reachable.length < 2) return fallbackHtml;
    const escAttr = value => esc(value).replace(/\`/g, '&#96;');
    const routeId = id => 'page-' + String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
    const frameWidth = p => ({desktop:1440,tablet:768,mobile:390})[p.design.frame] || 1440;
    const pages = reachable.map(p => {
      const d=p.design, width=frameWidth(p), layout=getDesignLayoutPositions(d), auto=d.layoutMode==='auto';
      const items=(Array.isArray(d.elements)?d.elements:[]).map(el=>{
        const pos=layout.positions.get(el.id)||{x:Number(el.x)||0,y:Number(el.y)||0};
        const x=Math.max(0,Math.min(10000,Number(pos.x)||0)), y=Math.max(0,Math.min(10000,Number(pos.y)||0));
        const w=Math.max(20,Math.min(4000,Number(el.width)||120)), h=Math.max(20,Math.min(4000,Number(el.height)||48));
        const color=safeDesignExportColor(el.color,'#111827'), bg=safeDesignExportColor(el.background,'transparent');
        const fs=Math.max(8,Math.min(240,Number(el.fontSize)||16)), weight=Math.max(100,Math.min(900,Number(el.weight)||400));
        const radius=Math.max(0,Math.min(500,Number(el.radius)||0)), align=['left','center','right'].includes(el.textAlign)?el.textAlign:'left';
        const posCss=auto?'position:relative;left:auto;top:auto;flex:0 0 auto;max-width:100%;':'position:absolute;left:'+x+'px;top:'+y+'px;';
        const style=posCss+'width:'+w+'px;height:'+h+'px;color:'+color+';background:'+bg+';font-size:'+fs+'px;font-weight:'+weight+';text-align:'+align+';border-radius:'+(el.type==='ellipse'?'50%':radius+'px')+';display:flex;align-items:center;box-sizing:border-box;padding:'+(el.type==='image'?'0':'4px')+';overflow:hidden;'+(el.type==='button'?'justify-content:center;text-decoration:none;':'')+(el.type==='image'?'object-fit:'+(['contain','cover','fill'].includes(el.objectFit)?el.objectFit:'cover')+';':'');
        const flow=(d.flowConnections||[]).find(c=>c.sourceElementId===el.id);
        const target=flow && projectsById.has(flow.targetProjectId) ? flow.targetProjectId : '';
        const text=el.type==='rectangle'||el.type==='ellipse'||el.type==='image'?'':esc(el.text||'');
        const id='layer-'+String(el.id||'').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,120);
        if(el.type==='image') {
          const src=safeDesignImageSource(el.src);
          const navAttrs = target && el.flowRole !== 'menu' ? ' role="link" tabindex="0" data-flow-to="'+escAttr(target)+'" style="'+style+';cursor:pointer"' : ' style="'+style+'"';
          return src?'<img id="'+escAttr(id)+'" src="'+escAttr(src)+'" alt="'+escAttr(String(el.alt||el.label||'Imagen').slice(0,300))+'"'+navAttrs+'>' : '<div id="'+escAttr(id)+'"'+(target && el.flowRole!=='menu'?' role="link" tabindex="0" data-flow-to="'+escAttr(target)+'"':'')+' style="'+style+'">'+esc(el.text||'Añade una imagen')+'</div>';
        }
        if(target && el.flowRole!=='menu') { const tag=el.type==='button'?'button':el.type==='heading'?'h1':(el.type==='rectangle'||el.type==='ellipse')?'div':el.type==='text'?'p':'div'; return '<'+tag+' id="'+escAttr(id)+'" role="link" tabindex="0" data-flow-to="'+escAttr(target)+'" style="'+style+';cursor:pointer">'+text+'</'+tag+'>'; }
        if(el.type==='button' && el.flowRole==='menu') return '<button type="button" id="'+escAttr(id)+'" data-flow-menu="true" aria-expanded="false" style="'+style+'">'+esc(el.text||'Menú')+'</button>';
        if(el.type==='button' && safeDesignLink(el.href) && !safeDesignLink(el.href).startsWith('#layer-')) return '<a id="'+escAttr(id)+'" href="'+escAttr(safeDesignLink(el.href))+'" target="_blank" rel="noopener noreferrer" style="'+style+'">'+esc(el.text||'Abrir enlace')+'</a>';
        const tag=el.type==='heading'?'h1':el.type==='button'?'button':(el.type==='rectangle'||el.type==='ellipse')?'div':'p';
        return '<'+tag+' id="'+escAttr(id)+'" style="'+style+'">'+text+'</'+tag+'>';
      }).join('');
      const frameStyle=auto?'position:relative;width:100%;max-width:'+width+'px;min-height:'+Math.max(900,layout.height)+'px;height:auto;display:flex;flex-direction:'+(d.layoutDirection==='column'?'column':'row')+';flex-wrap:'+(d.layoutDirection==='column'?'nowrap':'wrap')+';gap:'+Math.max(0,Math.min(200,Number(d.layoutGap)||0))+'px;padding:'+Math.max(0,Math.min(200,Number(d.layoutPadding)||0))+'px;align-items:flex-start;background:'+safeDesignExportColor(d.background,'#fff')+';margin:0 auto;':'position:relative;width:'+width+'px;height:900px;min-height:900px;background:'+safeDesignExportColor(d.background,'#fff')+';transform-origin:top left;margin:0 auto;';
      return '<section class="flow-screen" data-page-id="'+escAttr(p.id)+'" '+(p.id===root.id?'':'hidden')+'><div class="flow-viewport"><main class="flow-frame'+(auto?' auto-layout':'')+'" style="'+frameStyle+'">'+items+'</main></div></section>';
    }).join('');
    const routeMap=Object.fromEntries(reachable.map(p=>[p.id,routeId(p.id)]));
    return '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+esc(root.name)+'</title><style>*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:Inter,Arial,sans-serif;overflow-x:hidden}.flow-screen{width:100%;min-height:100vh}.flow-viewport{position:relative;width:100%;overflow:hidden}.flow-frame{transform-origin:top left}.flow-frame.auto-layout{width:100%;max-width:100%}@media(max-width:768px){.flow-frame.auto-layout{flex-direction:column!important;flex-wrap:nowrap!important;align-items:stretch!important}.flow-frame.auto-layout>*{max-width:100%}}</style></head><body>'+pages+'<script>(function(){var screens=[].slice.call(document.querySelectorAll(".flow-screen"));function show(id){var found=screens.find(function(s){return s.getAttribute("data-page-id")===id});if(!found)return;screens.forEach(function(s){s.hidden=s!==found});fit();window.scrollTo(0,0)}function fit(){var active=screens.find(function(s){return !s.hidden});if(!active)return;var f=active.querySelector(".flow-frame"),v=active.querySelector(".flow-viewport");if(!f||!v)return;if(f.classList.contains("auto-layout")){f.style.transform="none";f.style.marginLeft="auto";v.style.height="auto";return}var w=parseFloat(f.style.width)||1440,h=parseFloat(f.style.height)||900,s=Math.min(1,Math.max(.1,window.innerWidth/w));f.style.transform="scale("+s+")";f.style.marginLeft=Math.max(0,(window.innerWidth-w*s)/2)+"px";v.style.height=(h*s)+"px"}document.addEventListener("click",function(e){var nav=e.target.closest("[data-flow-to]");if(nav){e.preventDefault();show(nav.getAttribute("data-flow-to"));return}var menu=e.target.closest("[data-flow-menu]");if(menu){menu.setAttribute("aria-expanded",menu.getAttribute("aria-expanded")!=="true"?"true":"false")}});document.addEventListener("keydown",function(e){var nav=e.target.closest&&e.target.closest('[data-flow-to]');if(nav&&(e.key==='Enter'||e.key===' ')){e.preventDefault();show(nav.getAttribute('data-flow-to'))}});window.addEventListener("resize",fit,{passive:true});window.addEventListener("hashchange",function(){var id=decodeURIComponent(location.hash.slice(1));if(id)show(id)});fit()})();<\/script></body></html>';
  }

  const graphLauncher = document.getElementById('openDesignFlowGraph');
  if (graphLauncher) graphLauncher.addEventListener('click', openDesignFlowGraph);

  window.buildFlowAwareWebHtml = buildFlowAwareWebHtml;
  // Expose the launcher used by the HTML inline handler and automated UI checks.
  window.openDesignFlowGraph = openDesignFlowGraph;
  window.__openDesignFlowGraph = openDesignFlowGraph;
  window.closeDesignFlowGraph = closeDesignFlowGraph;
})();