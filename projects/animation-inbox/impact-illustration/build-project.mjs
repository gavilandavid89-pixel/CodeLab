import { createHeadlessRuntime } from "../../../public/pixelforge/src/headless.js";
import { createPixelForgeCodeLabPackageZip } from "../../../pixelforge-codelab-package.mjs";
import { writeFile } from "node:fs/promises";

const W = 160, H = 214, MODE = "illustration";
const runtime = createHeadlessRuntime({ width: W, height: H, name: "Impact — Illustration" });
const run = action => {
  const response = runtime.execute(action);
  if (!response.ok) throw new Error(action.name + ": " + (response.error?.message || JSON.stringify(response.error)));
  return response.result;
};
const point = (x, y) => ({ x: Math.max(0, Math.min(W - 1, Math.round(x))), y: Math.max(0, Math.min(H - 1, Math.round(y))) });
const stroke = (points, color, size, opacity = 1) => run({ name: "canvas.draw_stroke", points: points.map(([x, y]) => point(x, y)), color, size, opacity, hardness: 0.96, shape: "circle", authoringMode: MODE });
const ellipse = (x, y, width, height, color, size = 2) => run({ name: "canvas.draw_shape", shape: "ellipse", x: Math.max(0, Math.min(W - 1, x)), y: Math.max(0, Math.min(H - 1, y)), width: Math.max(1, Math.min(W - Math.max(0, x), width)), height: Math.max(1, Math.min(H - Math.max(0, y), height)), color, size, authoringMode: MODE });
const C = { ink: "#17151A", skin: "#D99178", light: "#F0BCA5", shade: "#9E5D54", pants: "#D6CFC3", jacket: "#25242A", jacketLight: "#45434C", bg: "#D9DEE1", ground: "#BFC1C2", speed: "#A5ADB4" };

const background = runtime.sandbox.layers[0].id;
run({ name: "layer.rename", layerId: background, newName: "Escenario" });
const attacker = run({ name: "layer.add", layerName: "Atacante — Illustration" }).layerId;
const opponent = run({ name: "layer.add", layerName: "Oponente — Illustration" }).layerId;
run({ name: "drawing.mode.set", mode: MODE });
run({ name: "animation.frame.capture_document", durationMs: 100, frameName: "Preparación" });

run({ name: "layer.select", layerId: background });
run({ name: "drawing.mode.set", mode: MODE });
run({ name: "canvas.fill", x: 2, y: 2, color: C.bg, tolerance: 0, contiguous: true, authoringMode: MODE });
run({ name: "canvas.fill", x: 3, y: 178, color: C.ground, tolerance: 10, contiguous: true, authoringMode: MODE });
stroke([[0,165],[38,164],[82,166],[122,163],[159,165]], "#777C83", 2);
stroke([[0,183],[55,181],[110,184],[159,181]], "#92979D", 1);
for (let i = 0; i < 4; i++) stroke([[8+i*38,24+i*8],[27+i*35,18+i*7]], C.speed, 1, 0.5);

// Static puncher: bare torso, pale trousers, swept dark hair and extended fist.
run({ name: "layer.select", layerId: attacker });
run({ name: "drawing.mode.set", mode: MODE });
stroke([[111,126],[106,151],[101,181],[96,198]], C.ink, 15);
stroke([[111,126],[106,151],[101,181],[96,198]], C.pants, 10);
stroke([[128,126],[135,151],[140,180],[149,194]], C.ink, 15);
stroke([[128,126],[135,151],[140,180],[149,194]], C.pants, 10);
stroke([[95,197],[87,202],[103,204],[110,199]], C.ink, 7);
stroke([[146,193],[149,201],[159,202]], C.ink, 7);
stroke([[103,66],[91,72],[87,91],[91,112],[103,130],[126,132],[141,116],[143,92],[136,73],[121,65],[103,66]], C.ink, 23);
stroke([[103,66],[91,72],[87,91],[91,112],[103,130],[126,132],[141,116],[143,92],[136,73],[121,65],[103,66]], C.skin, 17);
stroke([[96,78],[108,86],[120,84],[133,76]], C.light, 4, 0.8);
stroke([[97,93],[108,99],[120,100],[132,93]], C.shade, 3, 0.7);
stroke([[100,106],[112,112],[124,108]], C.shade, 2, 0.7);
stroke([[105,117],[116,121],[129,116]], C.light, 3, 0.7);
stroke([[106,58],[107,70],[119,77],[130,68],[129,56]], C.ink, 12);
stroke([[106,58],[107,70],[119,77],[130,68],[129,56]], C.skin, 8);
stroke([[96,77],[84,81],[73,84],[61,82],[51,78]], C.ink, 17);
stroke([[96,77],[84,81],[73,84],[61,82],[51,78]], C.skin, 11);
stroke([[83,82],[76,88],[67,88]], C.light, 3, 0.8);
stroke([[51,78],[43,72],[36,73],[32,80],[37,87],[47,88],[54,83]], C.ink, 11);
stroke([[51,78],[43,72],[36,73],[32,80],[37,87],[47,88],[54,83]], C.skin, 7);
stroke([[134,77],[146,78],[154,87],[151,98],[141,103]], C.ink, 13);
stroke([[134,77],[146,78],[154,87],[151,98],[141,103]], C.skin, 8);
ellipse(105,27,34,38,C.ink,3);
ellipse(108,30,28,32,C.skin,1);
stroke([[108,35],[106,26],[112,18],[124,16],[137,23],[141,33],[135,34],[128,27],[117,27],[111,34]], C.ink, 7);
stroke([[110,39],[117,36],[122,38],[128,37],[135,34]], C.ink, 2);
ellipse(117,38,2,3,C.ink,1);
ellipse(130,37,2,3,C.ink,1);
stroke([[125,39],[121,47],[126,49]], C.shade, 2);
stroke([[117,54],[126,56],[133,52]], C.ink, 2);
stroke([[108,47],[113,51],[117,49]], C.shade, 2);

// Save the completed static cels on frame zero; duplicate carries them through the timeline.
for (const layerId of [background, attacker]) {
  const layer = runtime.sandbox.layers.find(item => item.id === layerId);
  run({ name: "animation.frame.set_cel", layerId, index: 0, pixels: Buffer.from(layer.pixels).toString("base64"), authoringMode: MODE });
}
run({ name: "animation.set_fps", fps: 12 });
run({ name: "animation.set_loop", loop: false });

function drawOpponent(cx, cy, angle, pose, previous) {
  run({ name: "layer.select", layerId: opponent });
  run({ name: "drawing.mode.set", mode: MODE });
  if (previous) run({ name: "canvas.erase_region", x: 0, y: 0, width: W, height: H, authoringMode: MODE });
  const transform = (x, y) => point(cx + x * Math.cos(angle) - y * Math.sin(angle), cy + x * Math.sin(angle) + y * Math.cos(angle));
  const draw = (points, color, size, opacity = 1) => run({ name: "canvas.draw_stroke", points: points.map(([x,y]) => transform(x,y)), color, size, opacity, hardness: 0.95, shape: "circle", authoringMode: MODE });
  draw([[-12,-13],[-20,-4],[-18,13],[-10,21],[11,21],[20,10],[17,-9],[8,-16],[-12,-13]], C.ink, 20);
  draw([[-11,-12],[-16,-3],[-14,10],[-8,16],[9,16],[14,8],[13,-7],[6,-13],[-11,-12]], C.jacket, 13);
  draw([[-9,-16],[8,-14],[10,14],[-8,15]], C.jacket, 19);
  const arms = pose === "impact" ? [[-14,-10],[-25,-4],[-33,-10],[-38,-17],[12,-10],[22,-1],[29,7]]
    : pose === "air" ? [[-14,-10],[-25,-23],[-34,-27],[-40,-35],[12,-10],[24,-23],[34,-29]]
    : pose === "fall" ? [[-14,-9],[-24,0],[-33,13],[-40,17],[12,-9],[24,2],[34,15]]
    : pose === "land" ? [[-13,-7],[-23,2],[-34,7],[-41,7],[12,-7],[24,3],[37,8]]
    : [[-14,-10],[-23,-3],[-32,0],[-39,0],[12,-10],[23,-3],[32,1]];
  draw(arms.slice(0,4), C.ink, 10);
  draw(arms.slice(0,4), C.jacketLight, 6);
  draw(arms.slice(4), C.ink, 10);
  draw(arms.slice(4), C.jacketLight, 6);
  const legs = pose === "land" ? [[-7,18],[-20,27],[-32,28],[7,18],[22,25],[36,25]]
    : pose === "fall" ? [[-7,18],[-18,28],[-26,39],[7,18],[22,29],[34,37]]
    : pose === "air" ? [[-7,18],[-19,28],[-31,35],[7,18],[22,30],[34,42]]
    : pose === "impact" ? [[-7,18],[-12,29],[-17,40],[7,18],[15,30],[20,41]]
    : [[-7,18],[-14,30],[-20,41],[7,18],[16,30],[23,41]];
  draw(legs.slice(0,3), C.ink, 10);
  draw(legs.slice(0,3), C.jacketLight, 6);
  draw(legs.slice(3), C.ink, 10);
  draw(legs.slice(3), C.jacketLight, 6);
  const head = transform(-1,-34);
  ellipse(head.x, head.y, 20, 23, C.ink, 2);
  ellipse(head.x+2, head.y+2, 16, 19, C.skin, 1);
  draw([[-10,-40],[-8,-47],[1,-49],[9,-45],[11,-38]], C.ink, 6);
  draw([[-7,-34],[-3,-33],[2,-34],[6,-33]], C.ink, 1);
}

const poses = [
  {x:48,y:118,a:0,pose:"stand",duration:100},
  {x:45,y:115,a:-0.2,pose:"impact",duration:80},
  {x:31,y:92,a:-0.65,pose:"air",duration:80},
  {x:17,y:75,a:-1.25,pose:"air",duration:80},
  {x:22,y:111,a:-2.0,pose:"fall",duration:80},
  {x:43,y:146,a:-2.65,pose:"fall",duration:90},
  {x:68,y:161,a:-3.0,pose:"land",duration:150},
  {x:70,y:161,a:-3.05,pose:"land",duration:400}
];
let previous = null;
for (let index = 0; index < poses.length; index++) {
  if (index > 0) run({ name: "animation.frame.duplicate", index: index - 1 });
  const pose = poses[index];
  drawOpponent(pose.x, pose.y, pose.a, pose.pose, previous);
  const layer = runtime.sandbox.layers.find(item => item.id === opponent);
  const result = run({ name: "animation.frame.set_cel", layerId: opponent, index, pixels: Buffer.from(layer.pixels).toString("base64"), authoringMode: MODE });
  if (result.blockedPixels) throw new Error("Blocked incompatible Illustration pixels: " + result.blockedPixels);
  run({ name: "animation.frame.set_duration", index, durationMs: pose.duration });
  previous = [pose.x, pose.y];
}

const summary = run({ name: "animation.get_summary" });
runtime.createProposal("Animación de impacto dibujada con acciones raster y de timeline nativas de PixelForge Headless en modo Illustration. El atacante permanece estable y el oponente de chaqueta oscura retrocede, vuela, gira y cae.");
const accepted = runtime.acceptProposal();
const project = runtime.toJSON();
project.id = "abd33d81-5480-49a7-90e8-6818d2190460";
const artifact = createPixelForgeCodeLabPackageZip(project);
const output = process.argv[2];
if (!output) throw new Error("Pass the output .codelab package path as argv[2].");
await writeFile(output, artifact.bytes);
console.log(JSON.stringify({ summary, accepted, metadata: artifact.metadata, projectId: project.id, allModesIllustration: project.animation.frames.every(frame => frame.authoringMode === MODE && frame.cels.every(cel => (cel.metadata?.authoringMode ?? cel.authoringMode) === MODE)) }, null, 2));
