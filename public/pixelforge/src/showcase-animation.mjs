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
function limb(b,w,h,a,bb,c,th=2){line(b,w,h,a[0],a[1],bb[0],bb[1],P.outline);if(th>1)line(b,w,h,a[0]+1,a[1],bb[0]+1,bb[1],P.outline);line(b,w,h,a[0],a[1],bb[0],bb[1],c);if(th>1)line(b,w,h,a[0]+1,a[1],bb[0]+1,bb[1],c);}
function drawSoldier(b,w,h,frame){
  const walk=Math.min(frame,15),phase=2*Math.PI*walk/16,crouch=Math.max(0,(frame-15)/8);
  const sx=64+Math.round(2*Math.sin(phase)),bob=Math.round(1.5*Math.sin(phase*2));
  const hipY=94+bob+Math.round(12*crouch),shoulderY=55+bob+Math.round(9*crouch),headY=35+bob+Math.round(8*crouch),torsoTop=48+bob+Math.round(6*crouch);
  const lHip=[sx-6,hipY],rHip=[sx+6,hipY],lKnee=[sx-10-Math.round(7*Math.sin(phase)),hipY+18+Math.round(3*crouch)],rKnee=[sx+10+Math.round(7*Math.sin(phase)),hipY+18-Math.round(3*crouch)],lFoot=[sx-14-Math.round(5*Math.sin(phase)),126+Math.round(5*crouch)],rFoot=[sx+14+Math.round(5*Math.sin(phase)),126+Math.round(5*crouch)];
  const lSh=[sx-16,shoulderY+2],rSh=[sx+16,shoulderY+2],lEl=[sx-25-Math.round(8*Math.sin(phase)),shoulderY+14],rEl=[sx+25+Math.round(8*Math.sin(phase)),shoulderY+14],lHand=[sx-20-Math.round(7*Math.sin(phase)),shoulderY+26],rHand=[sx+20+Math.round(7*Math.sin(phase)),shoulderY+26];
  limb(b,w,h,lHip,lKnee,P.cloth,3);limb(b,w,h,lKnee,lFoot,P.clothHi,3);limb(b,w,h,rHip,rKnee,P.clothHi,3);limb(b,w,h,rKnee,rFoot,P.cloth,3);
  ellipse(b,w,h,lKnee[0],lKnee[1],5,5,P.outline);ellipse(b,w,h,lKnee[0],lKnee[1],3,3,P.armorHi);ellipse(b,w,h,rKnee[0],rKnee[1],5,5,P.outline);ellipse(b,w,h,rKnee[0],rKnee[1],3,3,P.armorHi);
  poly(b,w,h,[[lFoot[0]-5,lFoot[1]-2],[lFoot[0]+5,lFoot[1]-3],[lFoot[0]+8,lFoot[1]+3],[lFoot[0]+4,lFoot[1]+6],[lFoot[0]-7,lFoot[1]+5]],P.boot);poly(b,w,h,[[rFoot[0]-4,rFoot[1]-3],[rFoot[0]+6,rFoot[1]-2],[rFoot[0]+9,rFoot[1]+4],[rFoot[0]+3,rFoot[1]+6],[rFoot[0]-7,rFoot[1]+5]],P.boot);
  line(b,w,h,lFoot[0]-5,lFoot[1]+3,lFoot[0]+6,lFoot[1]+3,P.bootHi);line(b,w,h,rFoot[0]-5,rFoot[1]+3,rFoot[0]+7,rFoot[1]+3,P.bootHi);
  poly(b,w,h,[[sx-13,torsoTop],[sx+13,torsoTop],[sx+20,shoulderY+7],[sx+13,hipY-3],[sx-13,hipY-3],[sx-20,shoulderY+7]],P.outline);poly(b,w,h,[[sx-11,torsoTop+2],[sx+11,torsoTop+2],[sx+16,shoulderY+7],[sx+10,hipY-5],[sx-10,hipY-5],[sx-16,shoulderY+7]],P.armor);
  poly(b,w,h,[[sx-9,torsoTop+7],[sx+9,torsoTop+7],[sx+11,hipY-6],[sx-11,hipY-6]],P.vest);rect(b,w,h,sx-7,torsoTop+12,5,6,P.vestHi);rect(b,w,h,sx+2,torsoTop+12,5,6,P.vestHi);rect(b,w,h,sx-7,torsoTop+22,5,6,P.armorShade);rect(b,w,h,sx+2,torsoTop+22,5,6,P.armorShade);line(b,w,h,sx,torsoTop+6,sx,hipY-6,P.outline);
  limb(b,w,h,lSh,lEl,P.armorHi,2);limb(b,w,h,lEl,lHand,P.skinShade,2);limb(b,w,h,rSh,rEl,P.armor,2);limb(b,w,h,rEl,rHand,P.skin,2);ellipse(b,w,h,lHand[0],lHand[1],3,3,P.skin);ellipse(b,w,h,rHand[0],rHand[1],3,3,P.skinHi);
  rect(b,w,h,sx-4,headY+9,8,8,P.skinShade);rect(b,w,h,sx-3,headY+9,6,6,P.skin);ellipse(b,w,h,sx,headY,12,13,P.outline);ellipse(b,w,h,sx,headY,10,11,P.skin);
  poly(b,w,h,[[sx-12,headY-2],[sx-10,headY-11],[sx-3,headY-15],[sx+8,headY-11],[sx+12,headY-3],[sx+9,headY-1],[sx-8,headY-2]],P.armor);poly(b,w,h,[[sx-8,headY-9],[sx-2,headY-13],[sx+6,headY-10],[sx+9,headY-5],[sx-1,headY-7]],P.armorHi);
  rect(b,w,h,sx-6,headY-1,2,1,P.eye);rect(b,w,h,sx+3,headY-1,2,1,P.eye);line(b,w,h,sx-3,headY+6,sx+4,headY+6,P.skinShade);
  const rifleY=torsoTop+24+Math.round(2*Math.sin(phase));line(b,w,h,sx-22,rifleY-8,sx+33,rifleY+23,P.outline);line(b,w,h,sx-22,rifleY-7,sx+33,rifleY+22,P.metal);line(b,w,h,sx+31,rifleY+22,sx+47,rifleY+30,P.outline);line(b,w,h,sx+31,rifleY+21,sx+46,rifleY+29,P.metalHi);poly(b,w,h,[[sx-27,rifleY-10],[sx-16,rifleY-14],[sx-8,rifleY-8],[sx-18,rifleY-2]],P.black);poly(b,w,h,[[sx-5,rifleY+1],[sx+2,rifleY+9],[sx-2,rifleY+21],[sx-9,rifleY+14]],P.black);line(b,w,h,sx-12,rifleY-3,sx+28,rifleY+20,P.metalHi);
  rect(b,w,h,sx-18,hipY-12,6,7,P.armorShade);rect(b,w,h,sx+12,hipY-12,6,7,P.armorShade);line(b,w,h,sx-11,shoulderY+2,sx+10,hipY-9,P.outline);line(b,w,h,sx-10,shoulderY+2,sx+9,hipY-10,P.armorHi);ellipse(b,w,h,sx,134,20,2,P.shadow);
}
export function createOrbitalShowcase(){
  const width=128,height=160,doc=new RasterDocument(width,height,'Soldier reference · Walk to Crouch · 24 frames');doc.layers[0].name='Reference background';const ground=doc.addLayer('Ground'),soldier=doc.addLayer('Soldier · reference-guided'),detail=doc.addLayer('Lighting and contact');
  const bg=doc.layers[0].pixels,gb=ground.pixels,sb=soldier.pixels,db=detail.pixels;for(let y=0;y<height;y++){const c=y<104?P.bg:y<132?P.bg2:P.ground;rect(bg,width,height,0,y,width,1,c);}ellipse(bg,width,height,96,26,13,13,[205,213,198,255]);for(const [x,y] of [[10,18],[21,32],[38,13],[73,21],[110,14],[117,42],[14,55],[91,48]])put(bg,width,height,x,y,P.white);rect(gb,width,height,0,132,width,28,P.ground);rect(gb,width,height,0,132,width,2,[55,57,55,255]);
  const animation=PixelForgeAnimation.fromDocument(doc,{fps:16});for(let i=0;i<24;i++){if(i>0)animation.addFrame({duplicate:false,durationMs:62.5});const bgf=new Uint8ClampedArray(bg),g=new Uint8ClampedArray(gb),s=new Uint8ClampedArray(sb),d=new Uint8ClampedArray(db);drawSoldier(s,width,height,i);const stepX=64+Math.round(2*Math.sin(2*Math.PI*i/16));line(g,width,height,stepX-18,137,stepX+18,137,[55,57,55,255]);put(d,width,height,stepX+12,128,P.armorHi);if(i%4===0)put(d,width,height,stepX+13,128,P.white);animation.setLayerPixels(i,doc.layers[0].id,bgf);animation.setLayerPixels(i,ground.id,g);animation.setLayerPixels(i,soldier.id,s);animation.setLayerPixels(i,detail.id,d);}
  animation.setFps(16);animation.setActiveFrame(0);doc.setActiveLayer(soldier.id);doc.revision=1;doc.saveVersion=1;doc.history=[];doc.future=[];doc.historyBytes=0;doc.dirty=false;return {doc,animation,loop:true};
}
