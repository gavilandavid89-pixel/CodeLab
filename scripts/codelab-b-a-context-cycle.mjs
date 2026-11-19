import { createHash, randomUUID } from 'node:crypto';

const sessionId = String(process.env.CODELAB_SESSION_ID || '');
const mailboxBaseUrl = String(process.env.CODELAB_MAILBOX_BASE_URL || 'https://codelab-pbw9.onrender.com').replace(/\/+$/, '');
const mailboxToken = String(process.env.CODELAB_MAILBOX_TOKEN || createHash('sha256').update('codelab-headless-mailbox:v1:' + sessionId).digest('hex')).slice(0, 64);
const timeoutMs = Math.max(30000, Math.min(10 * 60 * 1000, Number(process.env.CODELAB_SESSION_TIMEOUT_MS || 240000)));
const FRAME_COUNT = 48;
const FPS = 12;
const ONE_STEP = process.env.CODELAB_WALK_ONE_STEP === '1';
const REQUESTED_FRAME = Math.max(1, Number(process.env.CODELAB_WALK_FRAME_INDEX || '1'));

if (!sessionId) throw new Error('CODELAB_SESSION_ID is required.');

async function mailbox(pathname, method='GET', body=null) {
  const response = await fetch(mailboxBaseUrl + pathname, {
    method,
    headers: { accept:'application/json', 'x-codelab-mailbox-token': mailboxToken, ...(body === null ? {} : {'content-type':'application/json'}) },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000)
  });
  let data=null; try { data=await response.json(); } catch {}
  if (!response.ok) throw new Error('Mailbox HTTP '+response.status+': '+JSON.stringify(data));
  return data;
}
async function send(payload) {
  const requestId=randomUUID();
  const request={...payload,requestId,sessionId};
  for(let attempt=1;attempt<=60;attempt++){
    try {
      await mailbox('/api/headless/session/request?sessionId='+encodeURIComponent(sessionId),'POST',{requestId,payload:request});
      break;
    } catch(error) {
      if(!/(HTTP 404|HTTP 502|HTTP 503|HTTP 504)/.test(String(error.message||error))||attempt===60) throw error;
      await new Promise(r=>setTimeout(r,3000));
    }
  }
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    const result=await mailbox('/api/headless/session/result?sessionId='+encodeURIComponent(sessionId)+'&requestId='+encodeURIComponent(requestId));
    if(result.status==='succeeded') return result.result;
    if(result.status==='failed'||result.status==='expired') throw new Error('A rejected request '+requestId+': '+JSON.stringify(result.result));
    await new Promise(r=>setTimeout(r,500));
  }
  throw new Error('Timed out waiting for A request '+requestId);
}
function decode64(v){const b=Buffer.from(v,'base64');return new Uint8ClampedArray(b.buffer,b.byteOffset,b.byteLength);}
function encode64(v){return Buffer.from(v).toString('base64');}

/*
 * B never invents a previous frame. It receives the exact previous cel from A,
 * then applies a deterministic local warp to that returned raster.
 * The warp deliberately keeps head/torso nearly fixed and moves separated
 * limb bands in opposite phases, which avoids the old whole-body sliding artifact.
 */
function walkFromExactPrevious(base64,w,h,frameIndex){
  const src=decode64(base64), out=new Uint8ClampedArray(src.length);
  out.set(src);
  const phase=2*Math.PI*frameIndex/24;
  const legL=Math.sin(phase), legR=Math.sin(phase+Math.PI);
  const armL=Math.sin(phase+Math.PI), armR=Math.sin(phase);
  // The returned cel itself determines the background colour. We only move
  // foreground pixels, never rectangular chunks of the background.
  const counts=new Map();
  for(let i=0;i<src.length;i+=4){
    const key=(src[i]<<16)|(src[i+1]<<8)|src[i+2];
    counts.set(key,(counts.get(key)||0)+1);
  }
  let bgKey=0,bgCount=-1;
  for(const [key,count] of counts){if(count>bgCount){bgKey=key;bgCount=count;}}
  const bgR=(bgKey>>16)&255,bgG=(bgKey>>8)&255,bgB=bgKey&255;
  const regions=[
    {x:0,y:70,w:32,h:50,dx:Math.round(3*legL),dy:Math.round(1*Math.max(0,legL))},
    {x:32,y:70,w:32,h:50,dx:Math.round(3*legR),dy:Math.round(1*Math.max(0,legR))},
    {x:0,y:35,w:24,h:48,dx:Math.round(2*armL),dy:Math.round(1*armL)},
    {x:40,y:35,w:24,h:48,dx:Math.round(2*armR),dy:Math.round(1*armR)}
  ];
  const isBg=(o)=>src[o]===bgR&&src[o+1]===bgG&&src[o+2]===bgB&&src[o+3]===255;
  for(const r of regions){
    const x1=Math.max(0,r.x),x2=Math.min(w,r.x+r.w),y1=Math.max(0,r.y),y2=Math.min(h,r.y+r.h);
    // Erase only foreground in the moving envelope.
    for(let y=y1;y<y2;y++) for(let x=x1;x<x2;x++){
      const o=(y*w+x)*4;
      if(!isBg(o)){out[o]=bgR;out[o+1]=bgG;out[o+2]=bgB;out[o+3]=255;}
    }
    // Repaint that foreground from its exact previous position, translated.
    for(let y=y1;y<y2;y++) for(let x=x1;x<x2;x++){
      const sx=x-r.dx,sy=y-r.dy;
      if(sx<x1||sx>=x2||sy<y1||sy>=y2) continue;
      const s=(sy*w+sx)*4;
      if(!isBg(s)){
        const d=(y*w+x)*4;
        out[d]=src[s];out[d+1]=src[s+1];out[d+2]=src[s+2];out[d+3]=src[s+3];
      }
    }
  }
  // A one-pixel contact bob is applied only below the hips and only to
  // foreground pixels, keeping the torso/head stable.
  const bob=Math.round(Math.sin(phase*2));
  if(bob!==0){
    const y1=88,y2=h;
    const copy=new Uint8ClampedArray(out);
    for(let y=y1;y<y2;y++) for(let x=0;x<w;x++){
      const sx=x,sy=y-bob;
      if(sy<y1||sy>=y2) continue;
      const s=(sy*w+sx)*4,d=(y*w+x)*4;
      const bgAtSource=src[s]===bgR&&src[s+1]===bgG&&src[s+2]===bgB&&src[s+3]===255;
      if(!bgAtSource){out[d]=copy[s];out[d+1]=copy[s+1];out[d+2]=copy[s+2];out[d+3]=copy[s+3];}
    }
  }
  return encode64(out);
}
function changedPixels(a64,b64,w,h){
  const a=decode64(a64),b=decode64(b64); let changed=0, sum=0, bgChanged=0, foregroundChanged=0;
  const counts=new Map();
  for(let i=0;i<a.length;i+=4){const key=(a[i]<<16)|(a[i+1]<<8)|a[i+2]; counts.set(key,(counts.get(key)||0)+1);}
  let bgKey=0,bgCount=-1; for(const [key,count] of counts){if(count>bgCount){bgKey=key;bgCount=count;}}
  const br=(bgKey>>16)&255,bg=(bgKey>>8)&255,bb=bgKey&255;
  for(let i=0;i<a.length;i+=4){
    const diff=a[i]!==b[i]||a[i+1]!==b[i+1]||a[i+2]!==b[i+2]||a[i+3]!==b[i+3];
    if(diff){changed++; sum+=Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2]);
      if(a[i]===br&&a[i+1]===bg&&a[i+2]===bb&&a[i+3]===255) bgChanged++; else foregroundChanged++;
    }
  }
  return {changed,meanChannelDelta:sum/Math.max(1,changed*3),backgroundChanged:bgChanged,foregroundChanged,backgroundLeakRatio:bgChanged/Math.max(1,w*h)};
}

const opened=await send({kind:'browser',start_path:'/pixelforge/index.html',actions:[{type:'wait_for',selector:'#canvas',state:'visible',timeoutMs:30000}]});
const suppliedProjectId=String(process.env.CODELAB_WALK_PROJECT_ID || '');
let created=suppliedProjectId ? {projectId:suppliedProjectId} : await send({kind:'pixelforge',operation:'create_blank_animation'});
if(!suppliedProjectId){
  await send({kind:'pixelforge',operation:'batch',project_id:created.projectId,summary:'B→A: configure walking playback',actions:[{name:'animation.set_fps',fps:FPS},{name:'animation.set_loop',loop:true}]});
  const {SOLDIER_REFERENCE_RASTER}=await import('../public/pixelforge/assets/soldier-reference-raster.mjs');
  const reference=SOLDIER_REFERENCE_RASTER.decode();
  const reference64=encode64(reference);
  await send({kind:'pixelforge',operation:'batch',project_id:created.projectId,summary:'B→A: seed walking source from authoritative soldier reference',actions:[{name:'animation.frame.set_cel',index:0,layerId:created.context.layer.id,pixels:reference64}]});
}
const {SOLDIER_REFERENCE_RASTER}=await import('../public/pixelforge/assets/soldier-reference-raster.mjs');
const reference=SOLDIER_REFERENCE_RASTER.decode();
const reference64=encode64(reference);
let previousFrame=0;
let previousCel=reference64;
const proof=[];
const startFrame=ONE_STEP ? REQUESTED_FRAME : 1;
const endFrame=ONE_STEP ? REQUESTED_FRAME : FRAME_COUNT-1;
if(ONE_STEP && !suppliedProjectId && REQUESTED_FRAME !== 1) throw new Error('Frame >1 requires CODELAB_WALK_PROJECT_ID so A remains the source of truth.');
if(ONE_STEP) previousFrame=REQUESTED_FRAME-1;
for(let i=startFrame;i<=endFrame;i++){
  const duplicated=await send({kind:'pixelforge',operation:'batch',project_id:created.projectId,summary:'B→A: create next walking frame',actions:[{name:'animation.frame.duplicate',index:previousFrame}],return_context:false});
  const nextIndex=Number(duplicated.results?.[0]?.result?.index ?? i);
  const context=await send({kind:'pixelforge',operation:'frame_context',project_id:created.projectId,frame_index:nextIndex});
  const exactPrevious=context.context?.previous?.cel;
  if(!exactPrevious) throw new Error('A did not return the exact previous cel for frame '+nextIndex);
  const exactPreviousBytes=Buffer.from(exactPrevious,'base64').byteLength;
  const nextCel=walkFromExactPrevious(exactPrevious,context.context.visual.width,context.context.visual.height,i);
  const delta=changedPixels(exactPrevious,nextCel,context.context.visual.width,context.context.visual.height);
  if(delta.changed<40) throw new Error('Frame '+nextIndex+' changed too little: '+JSON.stringify(delta));
  if(delta.backgroundLeakRatio>0.012) throw new Error('Frame '+nextIndex+' moved too much background: '+JSON.stringify(delta));
  const applied=await send({kind:'pixelforge',operation:'batch',project_id:created.projectId,summary:'B→A: apply walking pose derived only from exact previous cel',actions:[{name:'animation.frame.set_cel',index:nextIndex,layerId:context.context.layer.id,pixels:nextCel}]});
  if(!applied.context) throw new Error('A did not return post-mutation context for frame '+nextIndex);
  proof.push({frame:nextIndex,sourceFrameId:context.context.previous.frame.id,exactPreviousCelBytes:exactPreviousBytes,changedPixels:delta.changed,meanChannelDelta:delta.meanChannelDelta});
  previousFrame=nextIndex; previousCel=nextCel;
  if(ONE_STEP) break;
}

const visual=await send({
  kind:'browser',
  start_path:'/pixelforge/index.html?projectId='+encodeURIComponent(created.projectId)+'&capture=video',
  actions:[
    {type:'wait_for',selector:'#canvas',state:'visible',timeoutMs:30000},
    {type:'wait_for',selector:'#animation-frame-count',state:'visible',timeoutMs:30000},
    {type:'click',selector:'#animation-play'},
    {type:'record_video',durationMs:4200},
    {type:'screenshot'}
  ]
});
console.log(JSON.stringify({
  ok:true,
  protocol:'B→A→context→B→A→context',
  animation:{projectId:created.projectId,frames:ONE_STEP ? REQUESTED_FRAME+1 : FRAME_COUNT,fps:FPS,oneStep:ONE_STEP,requestedFrame:REQUESTED_FRAME},
  browser:{finalUrl:visual.finalUrl,captureMethod:visual.captureMethod,uiActions:visual.ui_actions,screenshots:visual.screenshots},
  proof:{
    everyFrameUsedExactPreviousCel:true,
    noAssumedPreviousPixels:true,
    postMutationContextReturned:true,
    firstFrameSource:'authoritative-soldier-reference-raster',
    firstFrameProof:proof[0],
    lastFrameProof:proof[proof.length-1],
    frameSamples:proof.filter((_,i)=>i%8===0)
  }
}));
