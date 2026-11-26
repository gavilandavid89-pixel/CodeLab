import { createHeadlessRuntime } from "../../../public/pixelforge/src/headless.js";
import { createPixelForgeCodeLabPackageZip } from "../../../pixelforge-codelab-package.mjs";
import { writeFile } from "node:fs/promises";
const W=240,H=426,M="illustration";
const rt=createHeadlessRuntime({width:W,height:H,name:"Impact — Illustration Improved"});
const run=a=>{const r=rt.execute(a);if(!r.ok)throw new Error(a.name+": "+(r.error?.message||JSON.stringify(r.error)));return r.result;};
const pt=(x,y)=>({x:Math.max(0,Math.min(W-1,Math.round(x))),y:Math.max(0,Math.min(H-1,Math.round(y)))});
const s=(pts,color,size,opacity=1)=>run({name:"canvas.draw_stroke",points:pts.map(([x,y])=>pt(x,y)),color,size,opacity,hardness:.96,shape:"circle",authoringMode:M});
const e=(x,y,w,h,color,size=4)=>run({name:"canvas.draw_shape",shape:"ellipse",x:Math.max(0,x),y:Math.max(0,y),width:Math.max(1,Math.min(W-Math.max(0,x),w)),height:Math.max(1,Math.min(H-Math.max(0,y),h)),color,size,authoringMode:M});
const fill=(x,y,color)=>run({name:"canvas.fill",x,y,color,tolerance:0,contiguous:true,authoringMode:M});
const C={ink:"#17151A",skin:"#D99178",light:"#F0BCA5",shade:"#9E5D54",hair:"#101116",pants:"#D6CFC3",pantsShade:"#8C8988",jacket:"#25242A",jacketLight:"#45434C",bg:"#D9DEE1",ground:"#BFC1C2",speed:"#A5ADB4",white:"#E8E3DA"};
const bg=rt.sandbox.layers[0].id;run({name:"layer.rename",layerId:bg,newName:"Escenario"});
const attacker=run({name:"layer.add",layerName:"Atacante — Illustration"}).layerId;
const opponent=run({name:"layer.add",layerName:"Oponente — Illustration"}).layerId;
run({name:"drawing.mode.set",mode:M});run({name:"animation.frame.capture_document",durationMs:100,frameName:"Preparación"});
run({name:"layer.select",layerId:bg});run({name:"drawing.mode.set",mode:M});
run({name:"canvas.fill",x:2,y:2,color:C.bg,tolerance:0,contiguous:true,authoringMode:M});
run({name:"canvas.fill",x:3,y:360,color:C.ground,tolerance:8,contiguous:true,authoringMode:M});
s([[0,350],[55,348],[110,351],[170,347],[239,350]],"#777C83",3);
s([[0,388],[70,385],[150,389],[239,385]],"#92979D",2);
for(let i=0;i<6;i++)s([[12+i*40,65+(i%3)*18],[40+i*34,55+(i%3)*18]],C.speed,2,.45);
// The puncher stays in place: bare torso, pale trousers, and an extended left fist.
run({name:"layer.select",layerId:attacker});run({name:"drawing.mode.set",mode:M});
s([[177,298],[170,337],[165,378],[158,408]],C.ink,25);s([[177,298],[170,337],[165,378],[158,408]],C.pants,17);
s([[207,298],[216,338],[222,379],[231,405]],C.ink,25);s([[207,298],[216,338],[222,379],[231,405]],C.pants,17);
s([[158,408],[146,414],[169,417],[179,411]],C.ink,12);s([[224,403],[230,414],[239,414]],C.ink,12);
s([[170,200],[151,212],[143,243],[148,282],[166,313],[202,316],[224,291],[226,248],[214,214],[194,198],[170,200]],C.ink,44);
s([[170,200],[151,212],[143,243],[148,282],[166,313],[202,316],[224,291],[226,248],[214,214],[194,198],[170,200]],C.skin,34);
s([[158,219],[178,235],[198,232],[215,217]],C.light,8,.8);
s([[158,251],[179,263],[199,264],[215,251]],C.shade,5,.8);
s([[165,275],[183,285],[201,280]],C.shade,4,.7);
s([[171,294],[188,300],[207,293]],C.light,5,.7);
s([[171,183],[173,204],[192,216],[210,201],[208,178]],C.ink,28);s([[171,183],[173,204],[192,216],[210,201],[208,178]],C.skin,20);
s([[158,215],[138,220],[120,218],[102,208],[87,202],[75,200]],C.ink,34);s([[158,215],[138,220],[120,218],[102,208],[87,202],[75,200]],C.skin,24);
s([[123,216],[113,228],[98,229]],C.light,6,.8);
s([[76,200],[63,189],[50,191],[43,204],[49,219],[66,224],[80,213]],C.ink,25);s([[76,200],[63,189],[50,191],[43,204],[49,219],[66,224],[80,213]],C.skin,16);
s([[214,218],[233,224],[238,243],[231,261],[216,265]],C.ink,28);s([[214,218],[233,224],[238,243],[231,261],[216,265]],C.skin,18);
e(171,133,65,73,C.ink,5);e(177,139,54,62,C.skin,2);
s([[178,150],[174,135],[183,120],[202,116],[222,127],[235,148],[225,150],[212,135],[193,134],[181,146]],C.ink,17);
s([[181,158],[192,153],[201,157],[214,153],[226,155]],C.ink,4);e(192,157,5,7,C.ink,1);e(216,155,5,7,C.ink,1);
s([[206,160],[201,176],[210,179]],C.shade,4);s([[192,187],[207,191],[220,184]],C.ink,4);
// The opponent is a single complete jacketed figure on its own layer.
run({name:"layer.select",layerId:opponent});run({name:"drawing.mode.set",mode:M});
s([[77,308],[65,337],[55,365],[44,386]],C.ink,27);s([[77,308],[65,337],[55,365],[44,386]],"#34333A",18);
s([[111,308],[125,336],[140,360],[154,379]],C.ink,27);s([[111,308],[125,336],[140,360],[154,379]],"#34333A",18);
s([[44,385],[31,395],[57,398],[68,389]],C.ink,14);s([[150,378],[158,389],[177,392]],C.ink,14);
s([[65,208],[52,223],[48,263],[57,306],[78,322],[117,320],[137,300],[137,254],[124,218],[100,203],[65,208]],C.ink,42);
fill(91,260,C.jacket);
s([[62,223],[82,242],[101,246],[125,224]],C.jacketLight,7,.8);
s([[75,255],[91,265],[112,261]],"#66616B",5,.7);
s([[88,279],[103,287],[119,280]],"#66616B",4,.7);
s([[69,210],[86,235],[98,250],[112,231],[126,213]],C.ink,10);
s([[98,250],[99,301]],"#AAA4A2",3,.8);
s([[60,226],[39,235],[23,250],[15,264]],C.ink,27);s([[60,226],[39,235],[23,250],[15,264]],C.jacket,17);
s([[15,264],[8,271],[12,282],[25,283],[32,273]],C.ink,14);s([[15,264],[8,271],[12,282],[25,283],[32,273]],C.skin,8);
s([[127,224],[151,235],[165,253],[174,267]],C.ink,27);s([[127,224],[151,235],[165,253],[174,267]],C.jacket,17);
s([[174,267],[182,271],[189,264],[184,253],[174,254]],C.ink,14);s([[174,267],[182,271],[189,264],[184,253],[174,254]],C.skin,8);
s([[81,210],[82,193],[89,185],[105,185],[115,197],[115,214]],C.ink,19);s([[81,210],[82,193],[89,185],[105,185],[115,197],[115,214]],C.skin,12);
e(75,151,58,64,C.ink,5);e(80,157,48,54,C.skin,2);
s([[80,170],[78,153],[89,140],[107,140],[126,153],[130,170],[119,165],[108,153],[91,156],[83,169]],C.ink,14);
s([[85,176],[95,173],[102,177],[110,175],[119,177]],C.ink,3);e(95,177,4,5,C.ink,1);e(113,177,4,5,C.ink,1);
s([[106,179],[102,190],[108,193]],C.shade,3);s([[94,202],[106,205],[117,200]],C.ink,3);
s([[61,239],[74,249],[84,251]],"#77727A",4,.8);
const frames=[
 {duration:100,dx:0,dy:0,rotate:0},
 {duration:80,dx:-8,dy:-5,rotate:0},
 {duration:90,dx:-24,dy:-35,rotate:0},
 {duration:90,dx:-18,dy:-20,rotate:90,scaleY:0.85},
 {duration:90,dx:0,dy:20,rotate:90},
 {duration:400,dx:10,dy:50,rotate:90}
];
for(const layerId of [bg,attacker,opponent]){const layer=rt.sandbox.layers.find(item=>item.id===layerId);run({name:"animation.frame.set_cel",layerId,index:0,pixels:Buffer.from(layer.pixels).toString("base64"),authoringMode:M});}
run({name:"animation.set_fps",fps:12});run({name:"animation.set_loop",loop:false});
let bounds={x:35,y:130,width:150,height:280};
for(let index=0;index<frames.length;index++){
 if(index>0)run({name:"animation.frame.duplicate",index:index-1});
 const frame=frames[index];
 if(index>0){
  const transformed=run({name:"canvas.transform_region",...bounds,dx:frame.dx,dy:frame.dy,rotate:frame.rotate,scaleX:frame.scaleX??1,scaleY:frame.scaleY??1,interpolation:"bilinear",authoringMode:M});
  if(transformed.bounds)bounds={x:transformed.bounds.x,y:transformed.bounds.y,width:transformed.bounds.width,height:transformed.bounds.height};
  const layer=rt.sandbox.layers.find(item=>item.id===opponent);
  const cel=run({name:"animation.frame.set_cel",layerId:opponent,index,pixels:Buffer.from(layer.pixels).toString("base64"),authoringMode:M});
  if(cel.blockedPixels)throw new Error("Blocked incompatible Illustration pixels: "+cel.blockedPixels);
 }
 run({name:"animation.frame.set_duration",index,durationMs:frame.duration});
}
const summary=run({name:"animation.get_summary"});
rt.createProposal("Animación de impacto nativa en Illustration: atacante estable en una capa y oponente completo animado mediante transformaciones raster nativas del timeline, con vuelo, giro y caída.");
const accepted=rt.acceptProposal();
const project=rt.toJSON();
project.id="6f9cdb50-55a3-4d78-bd34-9cc95b54a5be";
if(!project.layers.every(layer=>layer.authoringMode===M))throw new Error("Every project layer must remain Illustration.");
if(!project.animation.frames.every(frame=>frame.authoringMode===M&&frame.cels.every(cel=>(cel.metadata?.authoringMode??cel.authoringMode)===M)))throw new Error("Every frame and cel must remain Illustration.");
const artifact=createPixelForgeCodeLabPackageZip(project);
const output=process.argv[2];
if(!output)throw new Error("Pass the output .codelab package path as argv[2].");
await writeFile(output,artifact.bytes);
console.log(JSON.stringify({summary,accepted,projectId:project.id,canvas:[W,H],allLayersIllustration:true,allFramesAndCelsIllustration:true,metadata:artifact.metadata},null,2));
