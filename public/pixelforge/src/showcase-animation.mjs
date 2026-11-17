import { RasterDocument } from './core.js';
import { PixelForgeAnimation } from './animation.mjs';

const P = Object.freeze({
  sky: [18, 24, 39, 255], sky2: [28, 36, 57, 255], moon: [220, 229, 210, 255],
  ground: [35, 42, 49, 255], groundHi: [65, 76, 77, 255], outline: [18, 20, 27, 255],
  skin: [224, 161, 120, 255], skinHi: [246, 194, 145, 255], skinShade: [166, 103, 82, 255],
  hair: [46, 34, 31, 255], hairHi: [78, 52, 43, 255], shirt: [61, 92, 124, 255],
  shirtHi: [91, 129, 161, 255], shirtShade: [39, 61, 85, 255], pants: [55, 60, 72, 255],
  pantsHi: [82, 88, 102, 255], shoe: [31, 34, 43, 255], sole: [104, 94, 87, 255],
  accent: [213, 132, 74, 255], eye: [24, 29, 35, 255], white: [242, 238, 221, 255]
});

function put(buf,w,h,x,y,c){x|=0;y|=0;if(x<0||y<0||x>=w||y>=h)return;buf[(y*w+x)*4]=c[0];buf[(y*w+x)*4+1]=c[1];buf[(y*w+x)*4+2]=c[2];buf[(y*w+x)*4+3]=c[3];}
function rect(buf,w,h,x,y,ww,hh,c){for(let yy=y;yy<y+hh;yy++)for(let xx=x;xx<x+ww;xx++)put(buf,w,h,xx,yy,c);}
function line(buf,w,h,x1,y1,x2,y2,c){x1=Math.round(x1);y1=Math.round(y1);x2=Math.round(x2);y2=Math.round(y2);let dx=Math.abs(x2-x1),sx=x1<x2?1:-1,dy=-Math.abs(y2-y1),sy=y1<y2?1:-1,e=dx+dy;for(;;){put(buf,w,h,x1,y1,c);if(x1===x2&&y1===y2)break;let e2=2*e;if(e2>=dy){e+=dy;x1+=sx;}if(e2<=dx){e+=dx;y1+=sy;}}}
function ellipse(buf,w,h,cx,cy,rx,ry,c){for(let y=-ry;y<=ry;y++)for(let x=-rx;x<=rx;x++)if((x*x)/(rx*rx)+(y*y)/(ry*ry)<=1)put(buf,w,h,cx+x,cy+y,c);}
function poly(buf,w,h,pts,c){const minY=Math.max(0,Math.min(...pts.map(p=>p[1]))),maxY=Math.min(h-1,Math.max(...pts.map(p=>p[1])));for(let y=minY;y<=maxY;y++){const xs=[];for(let i=0;i<pts.length;i++){const a=pts[i],b=pts[(i+1)%pts.length];if((a[1]<=y&&b[1]>y)||(b[1]<=y&&a[1]>y))xs.push(a[0]+(y-a[1])*(b[0]-a[0])/(b[1]-a[1]));}xs.sort((a,b)=>a-b);for(let i=0;i+1<xs.length;i+=2)for(let x=Math.ceil(xs[i]);x<=Math.floor(xs[i+1]);x++)put(buf,w,h,x,y,c);}}
function layerBuffer(doc,layer){const b=new Uint8ClampedArray(doc.width*doc.height*4);layer.pixels=b;return b;}

function limb(buf,w,h,a,b,c1,c2,thickness=2){
  const aa=[Math.round(a[0]),Math.round(a[1])], bb=[Math.round(b[0]),Math.round(b[1])];
  line(buf,w,h,aa[0],aa[1],bb[0],bb[1],P.outline);
  if(thickness>1){
    line(buf,w,h,aa[0]+1,aa[1],bb[0]+1,bb[1],P.outline);
  }
  line(buf,w,h,aa[0],aa[1],bb[0],bb[1],c1);
  if(thickness>1) line(buf,w,h,aa[0]+1,aa[1],bb[0]+1,bb[1],c2||c1);
}
function joint(buf,w,h,p,r,c){ellipse(buf,w,h,p[0],p[1],r,r,c);}
function drawPerson(buf,w,h,frame){
  const N=20, walk=Math.min(frame,13), crouch=frame>=13;
  const walkT=walk/13;
  const crouchT=crouch?Math.min(1,(frame-13)/6):0;
  const step=Math.sin(walkT*Math.PI*6);
  const step2=Math.sin(walkT*Math.PI*6+Math.PI);
  const bob=walk<15 ? Math.abs(Math.sin(walkT*Math.PI*6))*1.5 : 0;
  const x=48 + (walk<15 ? walkT*8 : 8);
  const uprightHipY=70-bob, crouchHipY=82;
  const hipY=uprightHipY+(crouchHipY-uprightHipY)*crouchT;
  const torsoTop=44+(57-44)*crouchT;
  const headY=31+(47-31)*crouchT;
  const headX=x+2.5*crouchT;
  const shoulderY=47+(58-47)*crouchT;
  const lean=1.5*crouchT;

  const leftHip=[x-3,hipY], rightHip=[x+4,hipY];
  const leftKnee=crouch
    ? [x-8+3*crouchT, hipY+8]
    : [x-5-step*4, 88+step*2];
  const rightKnee=crouch
    ? [x+5, hipY+7]
    : [x+5-step2*4, 88+step2*2];
  const leftFoot=crouch
    ? [x-13,98]
    : [x-10-step*5,105-step*2];
  const rightFoot=crouch
    ? [x+13,96]
    : [x+8-step2*5,105-step2*2];

  // rear leg
  limb(buf,w,h,leftHip,leftKnee,P.pants,P.pantsHi,3);
  limb(buf,w,h,leftKnee,leftFoot,P.pantsHi,P.pants,3);
  poly(buf,w,h,[[leftFoot[0]-2,leftFoot[1]-1],[leftFoot[0]+8,leftFoot[1]-1],
    [leftFoot[0]+11,leftFoot[1]+3],[leftFoot[0]+7,leftFoot[1]+5],
    [leftFoot[0]-3,leftFoot[1]+4]],P.shoe);
  line(buf,w,h,leftFoot[0]-3,leftFoot[1]+4,leftFoot[0]+8,leftFoot[1]+4,P.sole);

  // front leg
  limb(buf,w,h,rightHip,rightKnee,P.pantsHi,P.pants,3);
  limb(buf,w,h,rightKnee,rightFoot,P.pants,P.pantsHi,3);
  poly(buf,w,h,[[rightFoot[0]-2,rightFoot[1]-1],[rightFoot[0]+8,rightFoot[1]-1],
    [rightFoot[0]+11,rightFoot[1]+3],[rightFoot[0]+6,rightFoot[1]+5],
    [rightFoot[0]-3,rightFoot[1]+4]],P.shoe);
  line(buf,w,h,rightFoot[0]-3,rightFoot[1]+4,rightFoot[0]+8,rightFoot[1]+4,P.sole);

  // torso silhouette and clothing
  poly(buf,w,h,[[x-9,torsoTop],[x+7,torsoTop],[x+13,shoulderY+5],[x+10,hipY],
    [x-8,hipY],[x-13,shoulderY+6]],P.outline);
  poly(buf,w,h,[[x-7,torsoTop+2],[x+5,torsoTop+2],[x+10,shoulderY+5],
    [x+7,hipY-2],[x-6,hipY-2],[x-10,shoulderY+6]],P.shirt);
  poly(buf,w,h,[[x-7,torsoTop+2],[x-1,torsoTop+4],[x-1,hipY-2],[x-6,hipY-2],
    [x-10,shoulderY+6]],P.shirtHi);
  poly(buf,w,h,[[x-1,torsoTop+4],[x+5,torsoTop+2],[x+10,shoulderY+5],
    [x+7,hipY-2],[x-1,hipY-2]],P.shirtShade);
  line(buf,w,h,x,torsoTop+3,x,hipY-3,P.accent);
  rect(buf,w,h,x-3,torsoTop+10,2,2,P.white);
  rect(buf,w,h,x-3,torsoTop+18,2,2,P.white);

  // arms use real opposing swing during walk and settle into a bent pose
  const armSwing=walk<15 ? step*7 : 0;
  const rearShoulder=[x-8-lean,shoulderY+2];
  const frontShoulder=[x+8-lean,shoulderY+1];
  const rearElbow=crouch
    ? [x-14,shoulderY+8]
    : [x-12-armSwing,shoulderY+10];
  const frontElbow=crouch
    ? [x+13,shoulderY+7]
    : [x+13+armSwing,shoulderY+10];
  const rearHand=crouch
    ? [x-11,shoulderY+14]
    : [x-13-armSwing,shoulderY+19];
  const frontHand=crouch
    ? [x+10,shoulderY+14]
    : [x+14+armSwing,shoulderY+19];
  limb(buf,w,h,rearShoulder,rearElbow,P.skinShade,P.skin,2);
  limb(buf,w,h,rearElbow,rearHand,P.skinShade,P.skin,2);
  limb(buf,w,h,frontShoulder,frontElbow,P.skin,P.skinHi,2);
  limb(buf,w,h,frontElbow,frontHand,P.skin,P.skinHi,2);
  joint(buf,w,h,rearHand,3,P.skin); joint(buf,w,h,frontHand,3,P.skinHi);

  // neck + head
  rect(buf,w,h,Math.round(headX-3),Math.round(headY+9),6,8,P.skinShade);
  rect(buf,w,h,Math.round(headX-2),Math.round(headY+9),5,6,P.skin);
  ellipse(buf,w,h,headX,headY,12,13,P.outline);
  ellipse(buf,w,h,headX,headY,10,11,P.skin);
  rect(buf,w,h,headX+8,headY-2,3,6,P.skinShade);
  rect(buf,w,h,headX+8,headY-1,2,4,P.skinHi);
  poly(buf,w,h,[[headX-10,headY-1],[headX-8,headY-10],[headX-1,headY-13],
    [headX+8,headY-9],[headX+11,headY-2],[headX+6,headY-1],[headX+1,headY-6],
    [headX-5,headY-4],[headX-9,headY+2]],P.hair);
  poly(buf,w,h,[[headX-7,headY-8],[headX-1,headY-11],[headX+6,headY-8],
    [headX+8,headY-4],[headX+2,headY-6],[headX-3,headY-3]],P.hairHi);
  rect(buf,w,h,headX-5,headY-1,2,1,P.eye);
  rect(buf,w,h,headX+2,headY-1,2,1,P.eye);
  line(buf,w,h,headX-3,headY+6,headX+3,headY+6,P.skinShade);
  // backpack strap and small lighting accents
  line(buf,w,h,x-7,shoulderY,x,hipY-4,P.outline);
  line(buf,w,h,x-6,shoulderY,x+1,hipY-5,P.accent);
  put(buf,w,h,Math.round(x+11),Math.round(shoulderY+1),P.skinHi);
  // contact shadow
  ellipse(buf,w,h,Math.round((leftFoot[0]+rightFoot[0])/2),crouch?101:109,
    crouch?18:20,crouch?3:2,[12,14,18,150]);
}


export function createOrbitalShowcase(){
  const width=96,height=120;
  const doc=new RasterDocument(width,height,'Person · Walk to Crouch · 20-frame study');
  doc.layers[0].name='Twilight background';
  const ground=doc.addLayer('Ground');
  const person=doc.addLayer('Character');
  const details=doc.addLayer('Lighting details');
  const bg=layerBuffer(doc,doc.layers[0]), gb=layerBuffer(doc,ground), pb=layerBuffer(doc,person), db=layerBuffer(doc,details);
  rect(bg,width,height,0,0,width,height,P.sky);
  for(let y=0;y<height;y++){const c=y<52?P.sky:y<88?P.sky2:P.ground;rect(bg,width,height,0,y,width,1,c);}
  ellipse(bg,width,height,75,18,11,11,P.moon);
  rect(bg,width,height,74,15,3,2,P.sky2);
  const stars=[[8,12],[17,25],[29,9],[68,11],[84,27],[73,40],[13,47],[90,51],[26,39]];
  for(const [x,y] of stars){rect(bg,width,height,x,y,1,1,P.white);put(bg,width,height,x+1,y-1,P.white);}
  rect(gb,width,height,0,91,width,29,P.ground);
  for(let x=0;x<width;x+=7)line(gb,width,height,x,91,x+3,86+(x%3),P.groundHi);
  rect(gb,width,height,0,91,width,2,P.groundHi);

  const animation=PixelForgeAnimation.fromDocument(doc,{fps:16});
  const durationMs=Math.round(1000/16);
  for(let i=0;i<20;i++){
    if(i>0)animation.addFrame({duplicate:false,durationMs});
    const bp=new Uint8ClampedArray(bg), gp=new Uint8ClampedArray(gb), pp=new Uint8ClampedArray(pb), dp=new Uint8ClampedArray(db);
    drawPerson(pp,width,height,i);
    // Ground contact and tiny motion accents make the walk readable frame-to-frame.
    if(i<12){
      const foot=i%2?45:42; line(gp,width,height,foot,109,foot+9,109,P.groundHi);
      const glowX=63 + (i % 6);\n      for(let gy=0;gy<3;gy++) for(let gx=0;gx<3;gx++) put(dp,width,height,glowX+gx,101+gy, gx===1&&gy===1 ? P.white : P.accent);
    }else{
      line(gp,width,height,55,99,70,99,P.groundHi);
      const glowX=69 + Math.min(2,i-12);\n      for(let gy=0;gy<3;gy++) for(let gx=0;gx<3;gx++) put(dp,width,height,glowX+gx,95+gy, gx===1&&gy===1 ? P.white : P.accent);
    }
    animation.setLayerPixels(i,doc.layers[0].id,bp);
    animation.setLayerPixels(i,ground.id,gp);
    animation.setLayerPixels(i,person.id,pp);
    animation.setLayerPixels(i,details.id,dp);
  }
  animation.setFps(16); animation.setActiveFrame(0);
  doc.setActiveLayer(person.id); doc.revision=1; doc.saveVersion=1; doc.history=[]; doc.future=[]; doc.historyBytes=0; doc.dirty=false;
  return {doc,animation,loop:true};
}
