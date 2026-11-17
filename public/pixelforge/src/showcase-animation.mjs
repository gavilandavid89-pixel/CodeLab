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
function line(buf,w,h,x1,y1,x2,y2,c){let dx=Math.abs(x2-x1),sx=x1<x2?1:-1,dy=-Math.abs(y2-y1),sy=y1<y2?1:-1,e=dx+dy;for(;;){put(buf,w,h,x1,y1,c);if(x1===x2&&y1===y2)break;let e2=2*e;if(e2>=dy){e+=dy;x1+=sx;}if(e2<=dx){e+=dx;y1+=sy;}}}
function ellipse(buf,w,h,cx,cy,rx,ry,c){for(let y=-ry;y<=ry;y++)for(let x=-rx;x<=rx;x++)if((x*x)/(rx*rx)+(y*y)/(ry*ry)<=1)put(buf,w,h,cx+x,cy+y,c);}
function poly(buf,w,h,pts,c){const minY=Math.max(0,Math.min(...pts.map(p=>p[1]))),maxY=Math.min(h-1,Math.max(...pts.map(p=>p[1])));for(let y=minY;y<=maxY;y++){const xs=[];for(let i=0;i<pts.length;i++){const a=pts[i],b=pts[(i+1)%pts.length];if((a[1]<=y&&b[1]>y)||(b[1]<=y&&a[1]>y))xs.push(a[0]+(y-a[1])*(b[0]-a[0])/(b[1]-a[1]));}xs.sort((a,b)=>a-b);for(let i=0;i+1<xs.length;i+=2)for(let x=Math.ceil(xs[i]);x<=Math.floor(xs[i+1]);x++)put(buf,w,h,x,y,c);}}
function layerBuffer(doc,layer){const b=new Uint8ClampedArray(doc.width*doc.height*4);layer.pixels=b;return b;}

function drawPerson(buf,w,h,phase){
  const walk=phase<12, crouch=phase>=12;
  const t=walk?phase:phase-12;
  const cycle=[0,1,2,3,4,5,6,5,4,3,2,1][t%12];
  const bob=walk?(cycle===0||cycle===6?0:-1):0;
  const hipY=crouch?76:69+bob, torsoTop=crouch?57:43+bob;
  const lean=crouch?3:0;
  const headX=49+lean, headY=crouch?47:32+bob;
  const swing=[-5,-4,-2,1,4,5,3,0,-3,-5,-3,0][t%12];
  const legA=crouch?0:swing, legB=crouch?0:-swing;
  const armA=crouch?7:-swing, armB=crouch?-7:swing;

  // rear leg and shoe
  if(crouch){
    poly(buf,w,h,[[39,72],[50,73],[58,82],[55,88],[48,87],[44,81],[37,79]],P.pantsShade||P.pants);
    poly(buf,w,h,[[52,83],[61,85],[66,90],[62,94],[52,92],[48,87]],P.pants);
    poly(buf,w,h,[[60,91],[69,92],[72,95],[69,98],[59,97],[56,94]],P.shoe);
  }else{
    poly(buf,w,h,[[43,68],[52,69],[50,91+legA],[44,91+legA],[40,75]],P.pants);
    poly(buf,w,h,[[43,90+legA],[51,90+legA],[50,101+legA],[43,101+legA]],P.pantsHi);
    poly(buf,w,h,[[40,99+legA],[51,99+legA],[54,104+legA],[50,107+legA],[38,106+legA]],P.shoe);
    rect(buf,w,h,39,105+legA,13,2,P.sole);
  }
  // rear arm
  const rearX=38+armB;
  line(buf,w,h,44,51,35+armB,65+armB,P.outline); line(buf,w,h,43,51,36+armB,65+armB,P.skinShade);
  ellipse(buf,w,h,35+armB,67+armB,4,5,P.skin);

  // torso outline and jacket/shirt
  poly(buf,w,h,[[43,42],[55,42],[62,50],[60,69],[54,74],[42,72],[38,63],[39,50]],P.outline);
  poly(buf,w,h,[[44,44],[54,44],[59,51],[57,67],[52,70],[43,68],[41,62],[42,51]],P.shirt);
  poly(buf,w,h,[[44,44],[49,46],[49,68],[43,67],[41,61],[42,51]],P.shirtHi);
  poly(buf,w,h,[[49,46],[54,44],[59,51],[57,67],[53,69],[49,67]],P.shirtShade);
  line(buf,w,h,49,46,49,66,P.accent); rect(buf,w,h,46,52,2,2,P.white); rect(buf,w,h,46,60,2,2,P.white);

  // front arm
  const frontX=46+armA;
  line(buf,w,h,54,50,frontX,64+armA,P.outline); line(buf,w,h,53,50,frontX,64+armA,P.skin);
  ellipse(buf,w,h,frontX,66+armA,4,5,P.skinHi);

  // neck
  rect(buf,w,h,47,39+bob,6,7,P.skinShade); rect(buf,w,h,48,39+bob,5,5,P.skin);

  // head outline, face, ears
  ellipse(buf,w,h,headX,headY,11,13,P.outline);
  ellipse(buf,w,h,headX,headY,9,11,P.skin);
  rect(buf,w,h,57,headY-2,3,5,P.skinShade); rect(buf,w,h,57,headY-1,2,3,P.skinHi);
  // hair silhouette
  poly(buf,w,h,[[39,32],[42,23],[49,20],[57,23],[61,30],[58,35],[55,30],[49,29],[44,34]],P.hair);
  poly(buf,w,h,[[42,25],[49,21],[56,24],[59,29],[55,28],[51,25],[46,28],[42,31]],P.hairHi);
  rect(buf,w,h,43,28,3,3,P.hair);
  // face details
  rect(buf,w,h,45,33,2,1,P.eye); rect(buf,w,h,52,33,2,1,P.eye);
  put(buf,w,h,47,38,P.skinShade); put(buf,w,h,48,39,P.skinShade);
  line(buf,w,h,46,41,52,41,P.skinShade);
  // backpack / shoulder strap
  line(buf,w,h,42,48,48,67,P.outline); line(buf,w,h,43,48,49,66,P.accent);
  // ground shadow
  ellipse(buf,w,h,48,crouch?98:108,18,crouch?3:2,[12,14,18,150]);
}

export function createOrbitalShowcase(){
  const width=96,height=120;
  const doc=new RasterDocument(width,height,'Person · Walk to Crouch · 18-frame study');
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

  const animation=PixelForgeAnimation.fromDocument(doc,{fps:12});
  const durationMs=Math.round(1000/12);
  for(let i=0;i<18;i++){
    if(i>0)animation.addFrame({duplicate:false,durationMs});
    const bp=new Uint8ClampedArray(bg), gp=new Uint8ClampedArray(gb), pp=new Uint8ClampedArray(pb), dp=new Uint8ClampedArray(db);
    drawPerson(pp,width,height,i);
    // Ground contact and tiny motion accents make the walk readable frame-to-frame.
    if(i<12){
      const foot=i%2?45:42; line(gp,width,height,foot,109,foot+9,109,P.groundHi);
      if(i%3===0)put(dp,width,height,63,102,P.accent);
    }else{
      line(gp,width,height,55,99,70,99,P.groundHi);
      put(dp,width,height,71,96,P.accent);
    }
    animation.setLayerPixels(i,doc.layers[0].id,bp);
    animation.setLayerPixels(i,ground.id,gp);
    animation.setLayerPixels(i,person.id,pp);
    animation.setLayerPixels(i,details.id,dp);
  }
  animation.setFps(12); animation.setActiveFrame(0);
  doc.setActiveLayer(person.id); doc.revision=1; doc.saveVersion=1; doc.history=[]; doc.future=[]; doc.historyBytes=0; doc.dirty=false;
  return {doc,animation,loop:true};
}
