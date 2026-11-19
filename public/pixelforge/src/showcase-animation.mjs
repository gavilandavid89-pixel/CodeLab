import { RasterDocument } from './core.js';
import { PixelForgeAnimation } from './animation.mjs';

const P = Object.freeze({
  bg:[20,22,30,255], bg2:[27,30,39,255], ground:[25,27,32,255], shadow:[8,9,12,170],
  outline:[20,18,17,255], armor:[112,91,65,255], armorHi:[164,132,92,255], armorShade:[72,60,46,255],
  vest:[59,59,50,255], vestHi:[91,89,70,255], cloth:[84,80,63,255], clothHi:[133,118,84,255],
  skin:[225,163,122,255], skinHi:[246,195,147,255], skinShade:[158,99,76,255],
  black:[28,29,31,255], metal:[70,69,67,255], metalHi:[116,113,108,255], boot:[48,43,39,255],
  bootHi:[86,73,62,255], eye:[20,24,25,255], white:[238,231,211,255]
});
function put(b,w,h,x,y,c){x|=0;y|=0;if(x<0||y<0||x>=w||y>=h)return;b[(y*w+x)*4]=c[0];b[(y*w+x)*4+1]=c[1];b[(y*w+x)*4+2]=c[2];b[(y*w+x)*4+3]=c[3];}
function rect(b,w,h,x,y,ww,hh,c){for(let yy=y;yy<y+hh;yy++)for(let xx=x;xx<x+ww;xx++)put(b,w,h,xx,yy,c);}
function line(b,w,h,x1,y1,x2,y2,c){x1=Math.round(x1);y1=Math.round(y1);x2=Math.round(x2);y2=Math.round(y2);let dx=Math.abs(x2-x1),sx=x1<x2?1:-1,dy=-Math.abs(y2-y1),sy=y1<y2?1:-1,e=dx+dy;for(;;){put(b,w,h,x1,y1,c);if(x1===x2&&y1===y2)break;let e2=2*e;if(e2>=dy){e+=dy;x1+=sx;}if(e2<=dx){e+=dx;y1+=sy;}}}
function poly(b,w,h,pts,c){const minY=Math.max(0,Math.floor(Math.min(...pts.map(p=>p[1])))),maxY=Math.min(h-1,Math.ceil(Math.max(...pts.map(p=>p[1]))));for(let y=minY;y<=maxY;y++){const xs=[];for(let i=0;i<pts.length;i++){const a=pts[i],bb=pts[(i+1)%pts.length];if((a[1]<=y&&bb[1]>y)||(bb[1]<=y&&a[1]>y))xs.push(a[0]+(y-a[1])*(bb[0]-a[0])/(bb[1]-a[1]));}xs.sort((a,bb)=>a-bb);for(let i=0;i+1<xs.length;i+=2)for(let x=Math.ceil(xs[i]);x<=Math.floor(xs[i+1]);x++)put(b,w,h,x,y,c);}}
function ellipse(b,w,h,cx,cy,rx,ry,c){for(let y=-ry;y<=ry;y++)for(let x=-rx;x<=rx;x++)if((x*x)/(rx*rx)+(y*y)/(ry*ry)<=1)put(b,w,h,cx+x,cy+y,c);}
function capsule(b,w,h,a,bb,r,c){const steps=Math.max(2,Math.ceil(Math.hypot(bb[0]-a[0],bb[1]-a[1])/2));for(let i=0;i<=steps;i++){const t=i/steps;ellipse(b,w,h,Math.round(a[0]+(bb[0]-a[0])*t),Math.round(a[1]+(bb[1]-a[1])*t),r,r,c);}}
function outlineCapsule(b,w,h,a,bb,r,c){capsule(b,w,h,a,bb,r+2,P.outline);capsule(b,w,h,a,bb,r,c);}
function joint(b,w,h,p,r,c=P.armorHi){ellipse(b,w,h,p[0],p[1],r+2,r+2,P.outline);ellipse(b,w,h,p[0],p[1],r,r,c);}
function drawSoldier(b,w,h,frame,{walkOnly=false}={}){
  const phase=2*Math.PI*frame/16,gait=Math.sin(phase),opp=-gait,bob=Math.round(0.8*Math.sin(phase*2));
  const sx=64,headY=33+bob,neckY=47+bob,shoulderY=53+bob,hipY=91+bob;
  const lHip=[57,hipY],rHip=[71,hipY],lK=[53+Math.round(3*gait),108+Math.round(2*gait)],rK=[75+Math.round(3*opp),108+Math.round(2*opp)];
  const lFoot=[48+Math.round(10*gait),127-Math.round(3*Math.max(0,gait))],rFoot=[80+Math.round(10*opp),127-Math.round(3*Math.max(0,opp))];
  const lSh=[48,shoulderY+2],rSh=[80,shoulderY+2];
  const lEl=[43-Math.round(5*gait),68+bob],rEl=[85+Math.round(5*gait),68+bob];
  const lHand=[45-Math.round(6*gait),82+bob],rHand=[83+Math.round(6*gait),82+bob];

  // Boots and grounded feet.
  poly(b,w,h,[[lFoot[0]-6,lFoot[1]-3],[lFoot[0]+3,lFoot[1]-4],[lFoot[0]+8,lFoot[1]+2],[lFoot[0]+6,lFoot[1]+6],[lFoot[0]-8,lFoot[1]+5]],P.boot);
  poly(b,w,h,[[rFoot[0]-3,rFoot[1]-4],[rFoot[0]+6,rFoot[1]-3],[rFoot[0]+9,rFoot[1]+3],[rFoot[0]+5,rFoot[1]+6],[rFoot[0]-7,rFoot[1]+5]],P.boot);
  line(b,w,h,lFoot[0]-5,lFoot[1]+2,lFoot[0]+6,lFoot[1]+2,P.bootHi);line(b,w,h,rFoot[0]-5,rFoot[1]+2,rFoot[0]+7,rFoot[1]+2,P.bootHi);

  // Legs: broad anatomical thigh/calf masses with knee articulation.
  outlineCapsule(b,w,h,lHip,lK,6,P.cloth);outlineCapsule(b,w,h,lK,lFoot,5,P.clothHi);
  outlineCapsule(b,w,h,rHip,rK,6,P.clothHi);outlineCapsule(b,w,h,rK,rFoot,5,P.cloth);
  joint(b,w,h,lK,4,P.armorHi);joint(b,w,h,rK,4,P.armorHi);
  line(b,w,h,lK[0]-4,lK[1],lK[0]+3,lK[1]+2,P.armorShade);line(b,w,h,rK[0]-3,rK[1]+1,rK[0]+4,rK[1],P.armorShade);

  // Pelvis and tapered torso: shoulder width, ribcage and waist read as a human body.
  poly(b,w,h,[[54,88],[50,82],[49,59],[55,50],[64,47],[73,50],[79,59],[78,82],[74,88],[68,94],[60,94]],P.outline);
  poly(b,w,h,[[56,86],[53,81],[53,61],[58,53],[64,50],[70,53],[75,61],[75,81],[72,86],[67,90],[61,90]],P.armor);
  poly(b,w,h,[[56,60],[60,54],[64,52],[68,54],[72,60],[71,78],[64,84],[57,78]],P.vest);
  rect(b,w,h,56,62,5,7,P.vestHi);rect(b,w,h,67,62,5,7,P.vestHi);rect(b,w,h,56,72,5,7,P.armorShade);rect(b,w,h,67,72,5,7,P.armorShade);
  line(b,w,h,64,53,64,83,P.outline);line(b,w,h,53,82,75,82,P.outline);
  rect(b,w,h,56,85,6,5,P.armorShade);rect(b,w,h,66,85,6,5,P.armorShade);

  // Arms: upper/lower segments with elbows and gloves.
  outlineCapsule(b,w,h,lSh,lEl,4,P.armorHi);outlineCapsule(b,w,h,lEl,lHand,3,P.cloth);
  outlineCapsule(b,w,h,rSh,rEl,4,P.armor);outlineCapsule(b,w,h,rEl,rHand,3,P.clothHi);
  joint(b,w,h,lEl,3,P.armorHi);joint(b,w,h,rEl,3,P.armor);
  ellipse(b,w,h,lHand[0],lHand[1],4,3,P.skinShade);ellipse(b,w,h,rHand[0],rHand[1],4,3,P.skinHi);

  // Neck, face and helmet.
  rect(b,w,h,60,43,8,7,P.skinShade);rect(b,w,h,61,43,6,6,P.skin);
  ellipse(b,w,h,sx,headY,13,14,P.outline);ellipse(b,w,h,sx,headY+1,11,12,P.skin);
  poly(b,w,h,[[51,31],[52,22],[58,17],[67,17],[74,22],[77,31],[73,29],[54,29]],P.armor);
  poly(b,w,h,[[55,23],[60,18],[68,19],[73,23],[72,27],[53,27]],P.armorHi);
  rect(b,w,h,54,29,20,3,P.outline);rect(b,w,h,56,29,16,1,P.black);
  rect(b,w,h,58,32,2,1,P.eye);rect(b,w,h,68,32,2,1,P.eye);
  line(b,w,h,60,38,67,38,P.skinShade);put(b,w,h,64,39,P.skinShade);

  // Tactical harness, straps and pouches.
  line(b,w,h,55,55,60,82,P.armorHi);line(b,w,h,73,55,68,82,P.armorHi);
  rect(b,w,h,52,58,4,6,P.armorShade);rect(b,w,h,72,58,4,6,P.armorShade);
  rect(b,w,h,53,69,5,6,P.armorShade);rect(b,w,h,70,69,5,6,P.armorShade);
  rect(b,w,h,52,80,6,6,P.armorShade);rect(b,w,h,70,80,6,6,P.armorShade);

  // Rifle crossing the chest, integrated with the hands.
  const ry=68+Math.round(2*Math.sin(phase));
  line(b,w,h,43,ry-9,94,ry+25,P.outline);line(b,w,h,43,ry-8,94,ry+24,P.metal);
  line(b,w,h,47,ry-6,86,ry+20,P.metalHi);line(b,w,h,91,ry+23,101,ry+28,P.outline);line(b,w,h,91,ry+22,100,ry+27,P.metalHi);
  poly(b,w,h,[[43,ry-11],[52,ry-14],[58,ry-9],[50,ry-3]],P.black);poly(b,w,h,[[62,ry+3],[68,ry+10],[65,ry+21],[59,ry+15]],P.black);
  ellipse(b,w,h,96,ry+27,3,2,P.metalHi);

  // Ground contact.
  ellipse(b,w,h,64,135,23,3,P.shadow);
  for(const p of [lFoot,rFoot]) line(b,w,h,p[0]-4,p[1]+5,p[0]+5,p[1]+5,P.bootHi);
}
export function createOrbitalShowcase({ frameCount = 60, fps = 12, walkOnly = false } = {}){
  const width=128,height=160,doc=new RasterDocument(width,height,walkOnly ? 'Soldier reference · Clean walking cycle · 60 frames' : 'Soldier reference · Walk to Crouch · 60 frames');doc.layers[0].name='Reference background';const ground=doc.addLayer('Ground'),soldier=doc.addLayer('Soldier · reference-guided'),detail=doc.addLayer('Lighting and contact');
  const bg=doc.layers[0].pixels,gb=ground.pixels,sb=soldier.pixels,db=detail.pixels;for(let y=0;y<height;y++){const c=y<104?P.bg:y<132?P.bg2:P.ground;rect(bg,width,height,0,y,width,1,c);}ellipse(bg,width,height,96,26,13,13,[205,213,198,255]);for(const [x,y] of [[10,18],[21,32],[38,13],[73,21],[110,14],[117,42],[14,55],[91,48]])put(bg,width,height,x,y,P.white);rect(gb,width,height,0,132,width,28,P.ground);rect(gb,width,height,0,132,width,2,[55,57,55,255]);
  const animation=PixelForgeAnimation.fromDocument(doc,{fps});for(let i=0;i<frameCount;i++){if(i>0)animation.addFrame({duplicate:false,durationMs:1000/fps});const bgf=new Uint8ClampedArray(bg),g=new Uint8ClampedArray(gb),s=new Uint8ClampedArray(sb),d=new Uint8ClampedArray(db);drawSoldier(s,width,height,i,{walkOnly});const stepX=64+Math.round(2*Math.sin(2*Math.PI*i/16));line(g,width,height,stepX-18,137,stepX+18,137,[55,57,55,255]);put(d,width,height,stepX+12,128,P.armorHi);if(i%4===0)put(d,width,height,stepX+13,128,P.white);animation.setLayerPixels(i,doc.layers[0].id,bgf);animation.setLayerPixels(i,ground.id,g);animation.setLayerPixels(i,soldier.id,s);animation.setLayerPixels(i,detail.id,d);}
  animation.setFps(fps);animation.setActiveFrame(0);doc.setActiveLayer(soldier.id);doc.revision=1;doc.saveVersion=1;doc.history=[];doc.future=[];doc.historyBytes=0;doc.dirty=false;return {doc,animation,loop:true};
}


