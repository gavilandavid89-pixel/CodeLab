import { createHeadlessRuntime } from "../../../public/pixelforge/src/headless.js";
import { createPixelForgeCodeLabPackageZip } from "../../../pixelforge-codelab-package.mjs";
import { writeFile } from "node:fs/promises";

const PROJECT_ID = "6f9cdb50-55a3-4d78-bd34-9cc95b54a5be";
const BASE_URL = String(process.env.CODELAB_PUBLIC_URL || "https://codelab-qedi.onrender.com").replace(/\/+$/, "");
const BRIDGE_TOKEN = String(process.env.CODELAB_AGENT_BRIDGE_CONTROL_SECRET || "");
const MODE = "illustration";
if (!BRIDGE_TOKEN) throw new Error("Missing bridge token.");
if (!/^https:\/\//i.test(BASE_URL)) throw new Error("The ADMIN bridge must use HTTPS.");

// Fetch the persisted snapshot outside Headless. Only the project JSON is passed into the isolated runtime.
const response = await fetch(BASE_URL + "/api/agent/bridge/pixelforge/projects/" + encodeURIComponent(PROJECT_ID), {
  headers: { "x-codelab-agent-bridge-token": BRIDGE_TOKEN, accept: "application/json" },
  signal: AbortSignal.timeout(120000)
});
const snapshot = await response.json().catch(() => ({}));
if (!response.ok) throw new Error("ADMIN snapshot HTTP " + response.status + ": " + String(snapshot.error || "request_failed"));
if (snapshot.workspaceId !== "ws_local_admin" || snapshot.projectId !== PROJECT_ID || snapshot.project?.id !== PROJECT_ID) {
  throw new Error("Refusing to edit a project outside the pinned ADMIN project.");
}
if (!Number.isInteger(snapshot.serverRevision) || snapshot.serverRevision < 1 || !/^[a-f0-9]{64}$/i.test(snapshot.contentSha256 || "")) {
  throw new Error("Persisted ADMIN revision/hash is missing.");
}
const sourceProject = snapshot.project;
const sourceFrameCount = sourceProject.animation?.frames?.length || 0;
console.log("[Headless] incremental Illustration polish from ADMIN revision", snapshot.serverRevision, "with", sourceFrameCount, "source frames.");
if (sourceFrameCount < 2 || sourceProject.layers?.length !== 3) throw new Error("Unexpected source project structure.");
delete process.env.CODELAB_AGENT_BRIDGE_CONTROL_SECRET;
delete process.env.BRIDGE_TOKEN;

const W = sourceProject.width, H = sourceProject.height;
if (W !== 240 || H !== 426) throw new Error("Unexpected canvas dimensions; review before editing.");
const rt = createHeadlessRuntime({ project: sourceProject });
const run = action => {
  const result = rt.execute(action);
  if (!result.ok) throw new Error(action.name + ": " + (result.error?.message || JSON.stringify(result.error)));
  return result.result;
};
const inspect = rt.inspect();
if (!inspect || rt.hasPendingProposal) throw new Error("Headless did not open a clean persisted project.");
const mode = run({ name: "drawing.mode.get" });
if (mode.activeMode !== MODE && mode.layerMode !== MODE) run({ name: "drawing.mode.set", mode: MODE });
const layer = name => rt.sandbox.layers.find(item => item.name === name);
const background = layer("Escenario");
const attacker = layer("Atacante — Illustration");
const opponent = layer("Oponente — Illustration");
if (!background || !attacker || !opponent) throw new Error("Expected persisted layers were not found.");
const C = {
  ink:"#17151A", skin:"#D99178", light:"#F0BCA5", shade:"#9E5D54",
  hair:"#101116", pants:"#D6CFC3", pantsShade:"#8C8988",
  jacket:"#25242A", jacketLight:"#45434C", bg:"#D9DEE1",
  ground:"#BFC1C2", speed:"#A5ADB4", white:"#E8E3DA", seam:"#77727A"
};
const p = (x,y) => ({ x:Math.max(0,Math.min(W-1,Math.round(x))), y:Math.max(0,Math.min(H-1,Math.round(y))) });
const stroke = (points,color,size,opacity=1) => run({
  name:"canvas.draw_stroke", points:points.map(([x,y])=>p(x,y)),
  color,size,opacity,hardness:.94,shape:"circle",authoringMode:MODE
});
const ellipse = (x,y,w,h,color,size=3) => run({
  name:"canvas.draw_shape",shape:"ellipse",x,y,width:w,height:h,color,size,authoringMode:MODE
});
const clear = () => run({name:"canvas.erase_region",x:0,y:0,width:W,height:H,authoringMode:MODE});
const select = id => { run({name:"layer.select",layerId:id}); run({name:"drawing.mode.set",mode:MODE}); };
const outlineFill = (points,outer,inner,outerSize,innerSize) => {
  stroke(points,outer,outerSize);
  stroke(points,inner,innerSize);
};
function drawAttacker(){
  // Trouser legs, pelvis and shoes.
  outlineFill([[157,286],[176,290],[174,337],[163,378],[147,392]],C.ink,C.pants,22,14);
  outlineFill([[194,286],[214,290],[222,337],[231,376],[239,389]],C.ink,C.pants,22,14);
  stroke([[147,392],[133,401],[158,405],[174,397]],C.ink,13);
  stroke([[226,378],[234,392],[239,397]],C.ink,13);
  stroke([[167,310],[163,349],[155,375]],C.pantsShade,3,.75);
  stroke([[210,310],[219,346],[226,369]],C.pantsShade,3,.75);
  // Bare torso with a clean shoulder/waist silhouette.
  outlineFill([[157,184],[170,171],[190,169],[211,178],[226,199],[222,241],[211,283],[193,300],[168,292],[150,266],[143,224],[147,198],[157,184]],C.ink,C.skin,31,23);
  stroke([[158,204],[177,220],[196,218],[215,201]],C.light,7,.8);
  stroke([[155,236],[177,250],[199,249],[217,235]],C.shade,5,.7);
  stroke([[166,269],[184,278],[205,270]],C.shade,4,.65);
  stroke([[170,284],[188,291],[204,283]],C.light,4,.65);
  // Neck and head, facing left.
  outlineFill([[169,169],[168,145],[194,139],[210,163],[207,186],[188,198],[172,184]],C.ink,C.skin,17,11);
  ellipse(157,116,67,76,C.ink,5);
  ellipse(163,122,55,65,C.skin,2);
  stroke([[162,137],[160,118],[174,101],[199,99],[220,115],[226,139],[212,131],[201,116],[180,117],[166,135]],C.hair,18);
  stroke([[166,146],[178,141],[189,145],[202,140],[215,144]],C.ink,4);
  ellipse(177,145,5,7,C.ink,1); ellipse(202,143,5,7,C.ink,1);
  stroke([[190,148],[185,164],[194,167]],C.shade,3);
  stroke([[177,175],[194,178],[207,171]],C.ink,3);
  // Punching shoulder, extended arm and clenched fist pointing left.
  outlineFill([[157,201],[139,202],[121,193],[105,185],[87,184],[72,191],[69,207],[85,220],[107,216],[128,220],[151,230]],C.ink,C.skin,24,16);
  stroke([[135,205],[118,207],[101,199]],C.light,5,.75);
  outlineFill([[72,190],[61,180],[47,182],[38,194],[41,210],[55,219],[71,211],[78,199]],C.ink,C.skin,17,10);
  stroke([[46,195],[57,191],[67,196]],C.shade,3);
  // Non-punching arm tucked back for balance.
  outlineFill([[215,205],[230,213],[239,231]],C.ink,C.skin,20,12);
  stroke([[221,222],[235,231],[239,245]],C.shade,3,.75);
}
function drawOpponent(){
  // Black trousers and grounded stance.
  outlineFill([[47,283],[67,286],[65,331],[52,368],[37,382]],C.ink,"#303038",23,15);
  outlineFill([[91,283],[112,282],[119,325],[132,358],[144,374]],C.ink,"#303038",23,15);
  stroke([[37,382],[23,392],[47,397],[61,388]],C.ink,13);
  stroke([[136,369],[145,383],[160,387]],C.ink,13);
  // Jacket torso with visible lapels and seams.
  outlineFill([[40,193],[55,181],[77,179],[102,190],[119,213],[116,252],[106,291],[84,307],[51,298],[32,271],[27,230]],C.ink,C.jacket,34,26);
  stroke([[48,194],[68,219],[82,233],[99,208]],C.ink,8);
  stroke([[82,233],[81,286]],C.jacketLight,4,.9);
  stroke([[52,246],[72,255],[93,249]],C.jacketLight,5,.8);
  stroke([[50,269],[72,279],[94,271]],"#5B5862",4,.7);
  stroke([[42,222],[54,235],[62,239]],"#77727A",4,.8);
  // Arms are separated visually from the torso.
  outlineFill([[38,207],[22,216],[10,238],[7,257],[17,268],[31,258],[37,241],[51,230]],C.ink,C.jacket,22,14);
  outlineFill([[108,207],[128,215],[142,232],[151,249],[145,261],[131,253],[119,238],[103,230]],C.ink,C.jacket,22,14);
  stroke([[8,253],[15,263],[25,263]],C.ink,13);
  stroke([[143,249],[151,258],[160,256]],C.ink,13);
  // Neck, face and swept dark hair.
  outlineFill([[59,174],[59,154],[81,147],[98,166],[96,190],[78,201],[62,189]],C.ink,C.skin,17,11);
  ellipse(48,111,61,67,C.ink,5);
  ellipse(54,117,49,56,C.skin,2);
  stroke([[52,135],[48,115],[60,99],[81,96],[102,110],[111,133],[97,126],[87,111],[67,112],[55,130]],C.hair,17);
  stroke([[55,140],[66,136],[75,140],[87,136],[98,140]],C.ink,4);
  ellipse(66,140,4,6,C.ink,1); ellipse(89,139,4,6,C.ink,1);
  stroke([[79,143],[75,157],[83,160]],C.shade,3);
  stroke([[65,169],[81,172],[94,166]],C.ink,3);
} 
function drawOpponentHorizontal(offsetY){
  const y=offsetY;
  // Head leads the fall; the jacketed torso and legs stay on the ground plane.
  outlineFill([[8,y+19],[19,y+6],[39,y+4],[54,y+16],[53,y+37],[38,y+49],[17,y+43],[5,y+31]],C.ink,C.skin,16,10);
  ellipse(4,y-2,49,47,C.ink,4);
  ellipse(9,y+3,39,37,C.skin,1);
  stroke([[7,y+21],[8,y+4],[23,y-6],[42,y-1],[53,y+16],[42,y+11],[31,y+3],[16,y+9]],C.hair,12);
  stroke([[15,y+21],[23,y+18],[29,y+21],[38,y+18]],C.ink,2);
  ellipse(22,y+22,3,4,C.ink,1); ellipse(37,y+21,3,4,C.ink,1);
  stroke([[30,y+23],[28,y+31],[34,y+32]],C.shade,2);
  stroke([[21,y+39],[33,y+40],[40,y+36]],C.ink,2);
  // Shoulder, jacket and lapel detail.
  outlineFill([[42,y+17],[58,y+5],[86,y+4],[112,y+18],[119,y+38],[105,y+57],[74,y+60],[49,y+47],[36,y+31]],C.ink,C.jacket,28,21);
  stroke([[52,y+12],[72,y+29],[86,y+37],[101,y+18]],C.ink,6);
  stroke([[86,y+36],[83,y+53]],C.jacketLight,3,.85);
  stroke([[56,y+39],[77,y+47],[99,y+41]],"#5B5862",3,.8);
  // One arm is braced in front of the face; the other is tucked beneath the torso.
  outlineFill([[48,y+23],[31,y+28],[19,y+42],[7,y+45],[1,y+39],[13,y+26],[32,y+14]],C.ink,C.jacket,18,11);
  outlineFill([[91,y+18],[108,y+8],[125,y+13],[136,y+27],[130,y+37],[115,y+30],[101,y+34]],C.ink,C.jacket,18,11);
  // Legs trail behind to the right, with separate shoes.
  outlineFill([[103,y+44],[119,y+42],[139,y+54],[153,y+66]],C.ink,"#303038",18,12);
  outlineFill([[100,y+50],[115,y+58],[129,y+77],[143,y+84]],C.ink,"#303038",18,12);
  stroke([[151,y+64],[164,y+70],[157,y+76],[145,y+72]],C.ink,10);
  stroke([[141,y+82],[151,y+89],[139,y+91],[130,y+84]],C.ink,10);
  // Small dust and impact strokes keep the landing readable.
  stroke([[0,y+55],[15,y+57],[25,y+54]],C.speed,2,.7);
  stroke([[3,y+66],[20,y+68],[29,y+65]],C.speed,2,.7);
}

function stampCel(layerId,index){
  const active = rt.sandbox.layers.find(item=>item.id===layerId);
  const result = run({name:"animation.frame.set_cel",layerId,index,pixels:Buffer.from(active.pixels).toString("base64"),authoringMode:MODE});
  if(result.blockedPixels) throw new Error("Illustration ownership blocked "+result.blockedPixels+" pixels.");
  return result;
}

// Repair the existing project's character artwork in place; preserve its project identity and scene layer.
select(attacker.id); clear(); drawAttacker(); stampCel(attacker.id,0);
select(opponent.id); clear(); drawOpponent(); stampCel(opponent.id,0);

// Keep the original background and source project; replace the coarse six-pose timing with a ten-pose action arc.
for(let i=sourceFrameCount-1;i>=1;i--) run({name:"animation.frame.delete",index:i});
run({name:"animation.set_fps",fps:12});
run({name:"animation.set_loop",loop:false});
const poses = [
  {duration:75,dx:0,dy:0,skewY:0,scaleX:1,scaleY:1},
  {duration:55,dx:-3,dy:-2,skewY:-.03,scaleX:1,scaleY:1},
  {duration:65,dx:-8,dy:-8,skewY:-.08,scaleX:1.01,scaleY:.99},
  {duration:75,dx:-12,dy:-16,skewY:-.16,scaleX:1.02,scaleY:.97},
  {duration:80,dx:-10,dy:-22,skewY:-.25,scaleX:1.03,scaleY:.95},
  {duration:90,dx:-5,dy:-15,skewY:-.35,scaleX:1.04,scaleY:.94},
  {duration:90,horizontalY:275},
  {duration:100,dx:0,dy:25,skewY:0,scaleX:1,scaleY:1},
  {duration:120,dx:0,dy:10,skewY:0,scaleX:1,scaleY:1},
  {duration:450,hold:true}
];
let bounds = {x:0,y:90,width:170,height:320};
select(opponent.id);
for(let index=1;index<poses.length;index++){
  run({name:"animation.frame.duplicate",index:index-1});
  const pose=poses[index];
  let cel=null;
  if(Number.isInteger(pose.horizontalY)){
    run({name:"animation.frame.set_active",index});
    select(opponent.id);
    clear();
    drawOpponentHorizontal(pose.horizontalY);
    bounds={x:0,y:260,width:170,height:140};
    cel=stampCel(opponent.id,index);
  }else if(pose.hold!==true){
    const transformed=run({
      name:"canvas.transform_region",...bounds,
      dx:pose.dx,dy:pose.dy,rotate:0,
      skewY:pose.skewY||0,scaleX:pose.scaleX,scaleY:pose.scaleY,
      interpolation:"bilinear",authoringMode:MODE
    });
    if(transformed.bounds){
      bounds={
        x:Math.max(0,Math.floor(transformed.bounds.x)),
        y:Math.max(0,Math.floor(transformed.bounds.y)),
        width:Math.min(W-Math.max(0,Math.floor(transformed.bounds.x)),Math.ceil(transformed.bounds.width)),
        height:Math.min(H-Math.max(0,Math.floor(transformed.bounds.y)),Math.ceil(transformed.bounds.height))
      };
    }
    cel=stampCel(opponent.id,index);
  }
  if(pose.hold!==true && cel.changedPixels===0) throw new Error("Pose "+index+" did not change the opponent cel.");
  run({name:"animation.frame.set_duration",index,durationMs:pose.duration});
}
run({name:"animation.frame.set_duration",index:0,durationMs:poses[0].duration});
const summary=run({name:"animation.get_summary"});
rt.createProposal("Segunda pasada de pulido incremental de la animación de impacto: anatomía más clara y diez poses con anticipación, impacto, retroceso, vuelo, giro y caída, conservando proyecto ADMIN y modo Illustration.");
const diff=rt.getDiff();
if(!diff) throw new Error("Headless did not produce a reviewable diff.");
const accepted=rt.acceptProposal();
const project=rt.toJSON();
if(project.animation.frames.length!==poses.length) throw new Error("Unexpected final frame count.");
if(!project.layers.every(item=>item.authoringMode===MODE)) throw new Error("A layer lost Illustration metadata.");
if(!project.animation.frames.every(frame=>frame.authoringMode===MODE&&frame.cels.every(cel=>(cel.metadata?.authoringMode??cel.authoringMode)===MODE))) {
  throw new Error("A frame/cel lost Illustration metadata.");
}
const artifact=createPixelForgeCodeLabPackageZip(project);
const output=process.argv[2];
if(!output) throw new Error("Pass the output .codelab package path as argv[2].");
await writeFile(output,artifact.bytes);
console.log(JSON.stringify({
  sourceRevision:snapshot.serverRevision,sourceSha256:snapshot.contentSha256,
  projectId:project.id,workspaceId:snapshot.workspaceId,
  canvas:[W,H],frameCount:project.animation.frames.length,
  durationsMs:project.animation.frames.map(frame=>frame.durationMs),
  totalDurationMs:project.animation.frames.reduce((sum,frame)=>sum+frame.durationMs,0),
  fps:project.animation.fps,layerCount:project.layers.length,
  allLayersIllustration:true,allFramesAndCelsIllustration:true,
  diffSummary:diff?.summary||null,accepted,summary,package:artifact.metadata
},null,2));
