import { createHash, randomUUID } from 'node:crypto';

const sessionId = String(process.env.CODELAB_SESSION_ID || '');
const mailboxBaseUrl = String(process.env.CODELAB_MAILBOX_BASE_URL || 'https://codelab-pbw9.onrender.com').replace(/\/+$/, '');
const mailboxToken = String(process.env.CODELAB_MAILBOX_TOKEN || createHash('sha256').update('codelab-headless-mailbox:v1:' + sessionId).digest('hex')).slice(0, 64);
const timeoutMs = Math.max(30000, Math.min(10 * 60 * 1000, Number(process.env.CODELAB_SESSION_TIMEOUT_MS || 240000)));
const FRAME_COUNT = 48;
const FPS = 12;

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
  function sampleInto(dstX,dstY,srcX,srcY){
    if(dstX<0||dstY<0||dstX>=w||dstY>=h||srcX<0||srcY<0||srcX>=w||srcY>=h)return;
    const s=(srcY*w+srcX)*4,d=(dstY*w+dstX)*4;
    out[d]=src[s];out[d+1]=src[s+1];out[d+2]=src[s+2];out[d+3]=src[s+3];
  }
  // Clear only the motion envelopes back to the unchanged source before painting
  // translated pixels, so the body remains stable instead of becoming a smear.
  const regions=[
    {x:0,y:70,w:32,h:50,dx:Math.round(3*legL),dy:Math.round(2*Math.max(0,legL))},
    {x:32,y:70,w:32,h:50,dx:Math.round(3*legR),dy:Math.round(2*Math.max(0,legR))},
    {x:0,y:35,w:24,h:48,dx:Math.round(2*armL),dy:Math.round(1*armL)},
    {x:40,y:35,w:24,h:48,dx:Math.round(2*armR),dy:Math.round(1*armR)}
  ];
  for(const r of regions){
    for(let y=r.y;y<Math.min(h,r.y+r.h);y++) for(let x=r.x;x<Math.min(w,r.x+r.w);x++){
      const s=(y*w+x)*4,d=s;
      out[d]=src[s];out[d+1]=src[s+1];out[d+2]=src[s+2];out[d+3]=src[s+3];
    }
    for(let y=r.y;y<Math.min(h,r.y+r.h);y++) for(let x=r.x;x<Math.min(w,r.x+r.w);x++){
      const sx=x-r.dx,sy=y-r.dy;
      if(sx>=r.x&&sx<Math.min(w,r.x+r.w)&&sy>=r.y&&sy<Math.min(h,r.y+r.h)) sampleInto(x,y,sx,sy);
    }
  }
  // A subtle contact/bob motion affects only the lower silhouette; head and torso stay anchored.
  const bob=Math.round(Math.sin(phase*2)*1);
  for(let y=84;y<h;y++){
    for(let x=0;x<w;x++){
      const sx=x,sy=y-bob;
      if(sy>=84&&sy<h) sampleInto(x,y,sx,sy);
    }
  }
  return encode64(out);
}
function changedPixels(a64,b64){
  const a=decode64(a64),b=decode64(b64); let changed=0, sum=0;
  for(let i=0;i<a.length;i+=4){if(a[i]!==b[i]||a[i+1]!==b[i+1]||a[i+2]!==b[i+2]||a[i+3]!==b[i+3])changed++; sum+=Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2]);}
  return {changed,meanChannelDelta:sum/Math.max(1,changed*3)};
}

const opened=await send({kind:'browser',start_path:'/pixelforge/index.html',actions:[{type:'wait_for',selector:'#canvas',state:'visible',timeoutMs:30000}]});
const created=await send({kind:'pixelforge',operation:'create_blank_animation'});
const {SOLDIER_REFERENCE_RASTER}=await import('../public/pixelforge/assets/soldier-reference-raster.mjs');
const reference=SOLDIER_REFERENCE_RASTER.decode();
const reference64=encode64(reference);
await send({kind:'pixelforge',operation:'batch',project_id:created.projectId,summary:'B→A: seed walking source from authoritative soldier reference',actions:[{name:'animation.frame.set_cel',index:0,layerId:created.context.layer.id,pixels:reference64}]});

let previousFrame=0;
let previousCel=reference64;
const proof=[];
for(let i=1;i<FRAME_COUNT;i++){
  const duplicated=await send({kind:'pixelforge',operation:'batch',project_id:created.projectId,summary:'B→A: create next walking frame',actions:[{name:'animation.frame.duplicate',index:previousFrame}],return_context:false});
  const nextIndex=Number(duplicated.results?.[0]?.result?.index ?? i);
  const context=await send({kind:'pixelforge',operation:'frame_context',project_id:created.projectId,frame_index:nextIndex});
  const exactPrevious=context.context?.previous?.cel;
  if(!exactPrevious) throw new Error('A did not return the exact previous cel for frame '+nextIndex);
  const exactPreviousBytes=Buffer.from(exactPrevious,'base64').byteLength;
  const nextCel=walkFromExactPrevious(exactPrevious,context.context.visual.width,context.context.visual.height,i);
  const delta=changedPixels(exactPrevious,nextCel);
  if(delta.changed<40) throw new Error('Frame '+nextIndex+' changed too little: '+JSON.stringify(delta));
  const applied=await send({kind:'pixelforge',operation:'batch',project_id:created.projectId,summary:'B→A: apply walking pose derived only from exact previous cel',actions:[{name:'animation.frame.set_cel',index:nextIndex,layerId:context.context.layer.id,pixels:nextCel}]});
  if(!applied.context) throw new Error('A did not return post-mutation context for frame '+nextIndex);
  proof.push({frame:nextIndex,sourceFrameId:context.context.previous.frame.id,exactPreviousCelBytes:exactPreviousBytes,changedPixels:delta.changed,meanChannelDelta:delta.meanChannelDelta});
  previousFrame=nextIndex; previousCel=nextCel;
}

const visual=await send({
  kind:'browser',
  start_path:'/pixelforge/index.html?projectId='+encodeURIComponent(created.projectId)+'&capture=video',
  actions:[
    {type:'wait_for',selector:'#canvas',state:'visible',timeoutMs:30000},
    {type:'wait_for',selector:'#animation-frame-count',state:'visible',timeoutMs:30000},
    {type:'screenshot'}
  ]
});
console.log(JSON.stringify({
  ok:true,
  protocol:'B→A→context→B→A→context',
  animation:{projectId:created.projectId,frames:FRAME_COUNT,fps:FPS},
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
},null,2));
