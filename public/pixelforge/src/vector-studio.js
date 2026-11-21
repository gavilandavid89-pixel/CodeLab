export const VECTOR_MODEL_VERSION = 1;

const NS = 'http://www.w3.org/2000/svg';
const clone = v => JSON.parse(JSON.stringify(v));
const uid = p => p + '-' + crypto.randomUUID();

export function createVectorModel(width, height, existing = null) {
  const m = existing && typeof existing === 'object' ? clone(existing) : {};
  return {
    version: VECTOR_MODEL_VERSION,
    width: Number(m.width) || width,
    height: Number(m.height) || height,
    grid: Number(m.grid) || 8,
    snap: m.snap !== false,
    objects: Array.isArray(m.objects) ? m.objects : [],
    frames: Array.isArray(m.frames) ? m.frames : []
  };
}

function snap(v, m) { return m.snap ? Math.round(v / m.grid) * m.grid : v; }
function bounds(o) {
  if (o.type === 'line') return {x:Math.min(o.x1,o.x2),y:Math.min(o.y1,o.y2),width:Math.abs(o.x2-o.x1),height:Math.abs(o.y2-o.y1)};
  if (o.type === 'path') { const p=o.points||[]; if(!p.length)return{x:0,y:0,width:0,height:0}; const xs=p.map(q=>q.x),ys=p.map(q=>q.y); return{x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)}; }
  return {x:o.x||0,y:o.y||0,width:o.width||0,height:o.height||0};
}
function pathD(o) { const p=o.points||[]; return p.length ? 'M '+p.map((q,i)=>(i?'L ':'')+q.x+' '+q.y).join(' ') + (o.closed?' Z':'') : ''; }
function style(o) { return {fill:o.fill??'none',stroke:o.stroke??'#E8EAF2','stroke-width':o.strokeWidth??1,opacity:o.opacity??1}; }

export function vectorModelToSVG(model) {
  const body=(model.objects||[]).map(o=>{
    const s=style(o), a=Object.entries(s).map(([k,v])=>`${k}="${String(v).replaceAll('"','&quot;')}"`).join(' ');
    if(o.type==='rect')return `<rect x="${o.x}" y="${o.y}" width="${o.width}" height="${o.height}" rx="${o.rx||0}" ${a}/>`;
    if(o.type==='ellipse')return `<ellipse cx="${o.x+o.width/2}" cy="${o.y+o.height/2}" rx="${o.width/2}" ry="${o.height/2}" ${a}/>`;
    if(o.type==='line')return `<line x1="${o.x1}" y1="${o.y1}" x2="${o.x2}" y2="${o.y2}" ${a}/>`;
    if(o.type==='path')return `<path d="${pathD(o)}" ${a}/>`;
    if(o.type==='text')return `<text x="${o.x}" y="${o.y}" font-size="${o.fontSize||16}" font-family="${o.fontFamily||'sans-serif'}" fill="${o.fill||'#E8EAF2}">${String(o.text||'').replaceAll('&','&amp;').replaceAll('<','&lt;')}</text>`;
    return '';
  }).join('');
  return `<svg xmlns="${NS}" width="${model.width}" height="${model.height}" viewBox="0 0 ${model.width} ${model.height}">${body}</svg>`;
}

export class VectorStudio {
  constructor({host,getDocument,getModel,setModel,onChanged,status}={}) {
    this.host=host; this.getDocument=getDocument; this.setModel=setModel; this.onChanged=onChanged; this.status=status||(()=>{});
    this.model=createVectorModel(getDocument().width,getDocument().height,getModel?.());
    this.tool='select'; this.selected=new Set(); this.drag=null; this.pen=[]; this.enabled=false; this.build(); this.render();
  }
  build() {
    this.host.style.position='relative';
    this.svg=document.createElementNS(NS,'svg'); this.svg.id='pixelforge-vector-svg';
    Object.assign(this.svg.style,{position:'absolute',inset:0,width:'100%',height:'100%',display:'none',zIndex:8,touchAction:'none'});
    this.host.append(this.svg);
    this.bar=document.createElement('div'); this.bar.className='vector-toolbar';
    Object.assign(this.bar.style,{position:'absolute',top:'12px',left:'12px',zIndex:12,display:'none',gap:'5px',padding:'7px',border:'1px solid #3a3e4d',borderRadius:'10px',background:'rgba(15,17,24,.95)'});
    [['select','↖'],['rect','▭'],['ellipse','◯'],['line','／'],['pen','✒'],['text','T'],['import','⇧'],['export','⇩'],['snap','#']].forEach(([t,g])=>{const b=document.createElement('button');b.type='button';b.textContent=g;b.title=t;b.dataset.vectorTool=t;b.onclick=()=>this.toolAction(t);b.style.cssText='min-width:34px;height:32px;border:1px solid #414656;border-radius:7px;background:#20232d;color:#e8eaf2';this.bar.append(b);});
    this.host.append(this.bar);
    this.svg.addEventListener('pointerdown',e=>this.down(e)); this.svg.addEventListener('pointermove',e=>this.move(e)); this.svg.addEventListener('pointerup',e=>this.up(e));
  }
  toolAction(t){if(t==='import'){this.importSVG();return;}if(t==='export'){this.exportSVG();return;}if(t==='snap'){this.model.snap=!this.model.snap;this.status(this.model.snap?'Vector snapping on':'Vector snapping off','neutral');return;}this.tool=t;this.pen=[];this.status('Vector tool: '+t,'neutral');this.render();}
  point(e){const r=this.svg.getBoundingClientRect(),d=this.getDocument();return{x:Math.max(0,Math.min(d.width,snap((e.clientX-r.left)*d.width/r.width,this.model))),y:Math.max(0,Math.min(d.height,snap((e.clientY-r.top)*d.height/r.height,this.model)))}}
  down(e){const p=this.point(e);this.svg.setPointerCapture?.(e.pointerId);if(this.tool==='pen'){this.pen.push(p);this.render();return;}if(this.tool==='text'){const text=window.prompt('Texto vectorial','Texto');if(text)this.model.objects.push({id:uid('text'),type:'text',x:p.x,y:p.y,text,fontSize:16,fill:'#E8EAF2',stroke:'none'}),this.changed();return;}if(this.tool==='select'){const o=this.hit(p);this.selected=o?new Set([o.id]):new Set();this.drag=o?{start:p}:null;this.render();return;}this.drag={start:p,current:p};}
  move(e){if(this.drag){this.drag.current=this.point(e);this.render();}}
  up(e){if(!this.drag)return;const end=this.point(e),s=this.drag.start,d=end.x-s.x,eY=end.y-s.y;this.drag=null;
    if(this.tool==='select'){const o=this.model.objects.find(x=>x.id===[...this.selected][0]);if(o){if(o.type==='line'){o.x1+=d;o.x2+=d;o.y1+=eY;o.y2+=eY;}else if(o.type==='path')o.points=o.points.map(p=>({x:p.x+d,y:p.y+eY}));else{o.x=(o.x||0)+d;o.y=(o.y||0)+eY;}this.changed();}return;}
    if(Math.abs(d)<1&&Math.abs(eY)<1)return;
    if(this.tool==='rect'||this.tool==='ellipse')this.model.objects.push({id:uid(this.tool),type:this.tool,x:Math.min(s.x,end.x),y:Math.min(s.y,end.y),width:Math.abs(d),height:Math.abs(eY),fill:'#9B8AFB',stroke:'#E8EAF2',strokeWidth:1,rx:this.tool==='rect'?6:0});
    else if(this.tool==='line')this.model.objects.push({id:uid('line'),type:'line',x1:s.x,y1:s.y,x2:end.x,y2:end.y,fill:'none',stroke:'#E8EAF2',strokeWidth:2});
    if(this.tool==='rect'||this.tool==='ellipse'||this.tool==='line')this.changed();
  }
  hit(p){for(let i=this.model.objects.length-1;i>=0;i--){const o=this.model.objects[i],b=bounds(o);if(p.x>=b.x-6&&p.x<=b.x+b.width+6&&p.y>=b.y-6&&p.y<=b.y+b.height+6)return o;}return null;}
  finishPen(){if(this.pen.length<2)return;this.model.objects.push({id:uid('path'),type:'path',points:clone(this.pen),closed:false,fill:'none',stroke:'#E8EAF2',strokeWidth:2});this.pen=[];this.changed();}
  deleteSelected(){this.model.objects=this.model.objects.filter(o=>!this.selected.has(o.id));this.selected.clear();this.changed();}
  align(axis){const os=this.model.objects.filter(o=>this.selected.has(o.id));if(os.length<2)return;const bs=os.map(bounds),minX=Math.min(...bs.map(b=>b.x)),maxX=Math.max(...bs.map(b=>b.x+b.width)),minY=Math.min(...bs.map(b=>b.y)),maxY=Math.max(...bs.map(b=>b.y+b.height));for(const o of os){const b=bounds(o);if(axis==='left')o.x=minX;if(axis==='center')o.x=minX+(maxX-minX-b.width)/2;if(axis==='top')o.y=minY;if(axis==='middle')o.y=minY+(maxY-minY-b.height)/2;}this.changed();}
  changed(){this.setModel?.(clone(this.model));this.onChanged?.();this.render();}
  enable(){this.enabled=true;this.svg.style.display='block';this.bar.style.display='flex';this.status('Vector mode enabled · editable SVG objects','success');this.render();}
  disable(){this.enabled=false;this.svg.style.display='none';this.bar.style.display='none';}
  toggle(){this.enabled?this.disable():this.enable();return this.enabled;}
  render(){this.svg.replaceChildren();this.svg.setAttribute('viewBox',`0 0 ${this.model.width} ${this.model.height}`);for(const o of this.model.objects){let e;if(o.type==='rect'){e=document.createElementNS(NS,'rect');e.setAttribute('x',o.x);e.setAttribute('y',o.y);e.setAttribute('width',o.width);e.setAttribute('height',o.height);e.setAttribute('rx',o.rx||0);}else if(o.type==='ellipse'){e=document.createElementNS(NS,'ellipse');e.setAttribute('cx',o.x+o.width/2);e.setAttribute('cy',o.y+o.height/2);e.setAttribute('rx',o.width/2);e.setAttribute('ry',o.height/2);}else if(o.type==='line'){e=document.createElementNS(NS,'line');e.setAttribute('x1',o.x1);e.setAttribute('y1',o.y1);e.setAttribute('x2',o.x2);e.setAttribute('y2',o.y2);}else if(o.type==='path'){e=document.createElementNS(NS,'path');e.setAttribute('d',pathD(o));}else if(o.type==='text'){e=document.createElementNS(NS,'text');e.setAttribute('x',o.x);e.setAttribute('y',o.y);e.setAttribute('font-size',o.fontSize||16);e.textContent=o.text||'';}else continue;for(const[k,v]of Object.entries(style(o)))e.setAttribute(k,v);if(this.selected.has(o.id)){e.setAttribute('stroke','#59D8B4');e.setAttribute('stroke-width',Math.max(2,Number(o.strokeWidth||1)+1));}this.svg.append(e);}if(this.tool==='pen'&&this.pen.length){const e=document.createElementNS(NS,'path');e.setAttribute('d',pathD({points:this.pen}));e.setAttribute('fill','none');e.setAttribute('stroke','#59D8B4');e.setAttribute('stroke-dasharray','4 4');this.svg.append(e);}}
  importSVG(){const i=document.createElement('input');i.type='file';i.accept='.svg,image/svg+xml';i.onchange=async()=>{const f=i.files?.[0];if(!f)return;try{const x=new DOMParser().parseFromString(await f.text(),'image/svg+xml');if(x.querySelector('parsererror'))throw new Error('Invalid SVG');const m=createVectorModel(this.getDocument().width,this.getDocument().height);for(const n of x.querySelectorAll('rect,ellipse,line,text,path')){const c={id:uid('v'),fill:n.getAttribute('fill')||'none',stroke:n.getAttribute('stroke')||'#E8EAF2',strokeWidth:Number(n.getAttribute('stroke-width')||1)};if(n.tagName==='rect')m.objects.push({...c,type:'rect',x:Number(n.getAttribute('x')||0),y:Number(n.getAttribute('y')||0),width:Number(n.getAttribute('width')||0),height:Number(n.getAttribute('height')||0)});else if(n.tagName==='ellipse')m.objects.push({...c,type:'ellipse',x:Number(n.getAttribute('cx')||0)-Number(n.getAttribute('rx')||0),y:Number(n.getAttribute('cy')||0)-Number(n.getAttribute('ry')||0),width:Number(n.getAttribute('rx')||0)*2,height:Number(n.getAttribute('ry')||0)*2});else if(n.tagName==='line')m.objects.push({...c,type:'line',x1:Number(n.getAttribute('x1')||0),y1:Number(n.getAttribute('y1')||0),x2:Number(n.getAttribute('x2')||0),y2:Number(n.getAttribute('y2')||0)});else if(n.tagName==='text')m.objects.push({...c,type:'text',x:Number(n.getAttribute('x')||0),y:Number(n.getAttribute('y')||0),text:n.textContent||'',fontSize:Number(n.getAttribute('font-size')||16,)});else if(n.tagName==='path')m.objects.push({...c,type:'path',points:[],d:n.getAttribute('d')||''});}this.model=m;this.changed();this.status('SVG imported as editable vector objects','success');}catch(e){this.status('SVG import failed: '+e.message,'error');}};i.click();}
  exportSVG(){const b=new Blob([vectorModelToSVG(this.model)],{type:'image/svg+xml'}),u=URL.createObjectURL(b),a=document.createElement('a');a.href=u;a.download=(this.getDocument().name||'pixelforge')+'.svg';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);this.status('SVG exported','success');}
  getModel(){return clone(this.model);}
}
