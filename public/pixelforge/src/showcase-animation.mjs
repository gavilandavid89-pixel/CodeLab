import { RasterDocument } from './core.js';
import { PixelForgeAnimation } from './animation.mjs';

const PALETTE = Object.freeze({
  space: [8, 12, 29, 255],
  nebula: [22, 35, 72, 150],
  nebulaPink: [53, 28, 70, 115],
  star: [210, 235, 255, 255],
  starWarm: [255, 204, 135, 255],
  planet: [70, 93, 154, 255],
  planetLight: [119, 157, 215, 255],
  planetDark: [39, 54, 104, 255],
  hull: [221, 234, 247, 255],
  hullShade: [115, 145, 178, 255],
  outline: [28, 39, 65, 255],
  glass: [63, 190, 232, 255],
  glassLight: [183, 245, 255, 255],
  gold: [255, 190, 87, 255],
});

function put(buffer, width, height, x, y, color) {
  x = Math.floor(x); y = Math.floor(y);
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const offset = (y * width + x) * 4;
  buffer.set(color, offset);
}
function rect(buffer, width, height, x, y, w, h, color) {
  for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) put(buffer, width, height, px, py, color);
}
function polygon(buffer, width, height, points, color) {
  const minY = Math.max(0, Math.min(...points.map(point => point[1])));
  const maxY = Math.min(height - 1, Math.max(...points.map(point => point[1])));
  for (let y = minY; y <= maxY; y++) {
    const intersections = [];
    for (let i = 0; i < points.length; i++) {
      const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) intersections.push(x1 + (y - y1) * (x2 - x1) / (y2 - y1));
    }
    intersections.sort((a, b) => a - b);
    for (let i = 0; i + 1 < intersections.length; i += 2) {
      for (let x = Math.ceil(intersections[i]); x <= Math.floor(intersections[i + 1]); x++) put(buffer, width, height, x, y, color);
    }
  }
}
function circle(buffer, width, height, cx, cy, radius, color) {
  for (let y = -radius; y <= radius; y++) for (let x = -radius; x <= radius; x++) {
    if (x * x + y * y <= radius * radius) put(buffer, width, height, cx + x, cy + y, color);
  }
}
function layerBuffer(doc, layer) {
  const target = new Uint8ClampedArray(doc.width * doc.height * 4);
  layer.pixels = target;
  return target;
}

export function createOrbitalShowcase() {
  const width = 96, height = 96;
  const doc = new RasterDocument(width, height, 'Orbital · PixelForge 12-frame loop');
  doc.layers[0].name = 'Deep space';
  const starsLayer = doc.addLayer('Starlight');
  const engineLayer = doc.addLayer('Ion thruster');
  const shipLayer = doc.addLayer('Explorer');
  const background = layerBuffer(doc, doc.layers[0]);
  const starsBase = layerBuffer(doc, starsLayer);
  const engineBase = layerBuffer(doc, engineLayer);
  const shipBase = layerBuffer(doc, shipLayer);

  rect(background, width, height, 0, 0, width, height, PALETTE.space);
  circle(background, width, height, 24, 24, 24, PALETTE.nebula);
  circle(background, width, height, 72, 68, 29, PALETTE.nebulaPink);
  // A small ringed planet anchors the lower-right corner of the composition.
  for (let x = 58; x < 96; x++) {
    const y = 78 + Math.round(Math.sin((x - 58) / 38 * Math.PI * 2) * 3);
    put(background, width, height, x, y, [113, 145, 202, 150]);
  }
  circle(background, width, height, 78, 78, 10, PALETTE.planetDark);
  circle(background, width, height, 78, 76, 9, PALETTE.planet);
  circle(background, width, height, 75, 73, 3, PALETTE.planetLight);
  rect(background, width, height, 72, 79, 7, 2, [45, 64, 123, 255]);

  const stars = [
    [8, 10, 1], [18, 7, 1], [37, 13, 2], [55, 8, 1], [81, 12, 1],
    [91, 26, 2], [10, 32, 1], [25, 42, 1], [83, 43, 1], [7, 61, 2],
    [31, 75, 1], [48, 88, 1], [59, 54, 1], [68, 20, 1], [90, 61, 1],
    [14, 84, 1], [39, 31, 1], [51, 39, 1], [3, 47, 1], [86, 88, 1],
  ];
  stars.forEach(([x, y, size], index) => rect(starsBase, width, height, x, y, size, size, index % 4 === 0 ? PALETTE.starWarm : PALETTE.star));

  const animation = PixelForgeAnimation.fromDocument(doc, { fps: 12 });
  const durationMs = 1000 / 12;
  for (let frameIndex = 0; frameIndex < 12; frameIndex++) {
    if (frameIndex > 0) animation.addFrame({ duplicate: false, durationMs });
    const starPixels = new Uint8ClampedArray(starsBase);
    const enginePixels = new Uint8ClampedArray(engineBase);
    const shipPixels = new Uint8ClampedArray(shipBase);

    // Tiny stars pulse and drift by one pixel to make the loop feel alive.
    stars.forEach(([x, y, size], index) => {
      const phase = (frameIndex + index * 3) % 6;
      if (phase === 0 || phase === 1) {
        rect(starPixels, width, height, x + (frameIndex % 2), y, size, size, [245, 250, 255, 255]);
      }
      if (index % 7 === 0 && phase < 3) put(starPixels, width, height, x, y - 1, [120, 203, 255, 210]);
    });

    const bob = Math.round(Math.sin(frameIndex / 12 * Math.PI * 2) * 2);
    const shipX = 39 + Math.round(Math.sin(frameIndex / 12 * Math.PI * 2) * 1);
    const shipY = 29 + bob;
    const flameLength = [5, 7, 9, 7, 5, 8, 10, 7, 5, 8, 9, 6][frameIndex];

    // Flame is its own independent cel, behind the ship body.
    polygon(enginePixels, width, height, [
      [45 + shipX - 39, shipY + 20], [51 + shipX - 39, shipY + 20],
      [49 + shipX - 39, shipY + 20 + flameLength], [48 + shipX - 39, shipY + 23 + flameLength],
      [46 + shipX - 39, shipY + 20 + flameLength],
    ], [255, 105, 67, 255]);
    polygon(enginePixels, width, height, [
      [47 + shipX - 39, shipY + 21], [49 + shipX - 39, shipY + 21],
      [48 + shipX - 39, shipY + 22 + flameLength], [47 + shipX - 39, shipY + 21 + flameLength],
    ], [255, 214, 105, 255]);
    rect(enginePixels, width, height, 46 + shipX - 39, shipY + 20, 3, 2, [255, 242, 183, 255]);

    // Fins, hull, nose and cockpit are all rasterized on a separate cel.
    polygon(shipPixels, width, height, [
      [shipX + 2, shipY + 15], [shipX + 7, shipY + 20], [shipX + 4, shipY + 24],
      [shipX, shipY + 22], [shipX + 1, shipY + 16],
    ], PALETTE.outline);
    polygon(shipPixels, width, height, [
      [shipX + 11, shipY + 15], [shipX + 16, shipY + 16], [shipX + 16, shipY + 22],
      [shipX + 12, shipY + 24], [shipX + 9, shipY + 20],
    ], PALETTE.outline);
    polygon(shipPixels, width, height, [
      [shipX + 3, shipY + 15], [shipX + 7, shipY + 19], [shipX + 4, shipY + 21],
      [shipX + 2, shipY + 20],
    ], PALETTE.gold);
    polygon(shipPixels, width, height, [
      [shipX + 12, shipY + 16], [shipX + 15, shipY + 17], [shipX + 14, shipY + 21],
      [shipX + 12, shipY + 21], [shipX + 10, shipY + 19],
    ], PALETTE.gold);
    polygon(shipPixels, width, height, [
      [shipX + 5, shipY], [shipX + 11, shipY], [shipX + 14, shipY + 8],
      [shipX + 14, shipY + 19], [shipX + 11, shipY + 23],
      [shipX + 5, shipY + 23], [shipX + 2, shipY + 19], [shipX + 2, shipY + 8],
    ], PALETTE.outline);
    polygon(shipPixels, width, height, [
      [shipX + 6, shipY + 1], [shipX + 10, shipY + 1], [shipX + 13, shipY + 8],
      [shipX + 13, shipY + 18], [shipX + 10, shipY + 21], [shipX + 6, shipY + 21],
      [shipX + 3, shipY + 18], [shipX + 3, shipY + 8],
    ], PALETTE.hull);
    rect(shipPixels, width, height, shipX + 4, shipY + 11, 9, 6, PALETTE.hullShade);
    rect(shipPixels, width, height, shipX + 5, shipY + 11, 7, 5, PALETTE.hull);
    circle(shipPixels, width, height, shipX + 8, shipY + 7, 4, PALETTE.outline);
    circle(shipPixels, width, height, shipX + 8, shipY + 7, 3, PALETTE.glass);
    rect(shipPixels, width, height, shipX + 7, shipY + 4, 2, 1, PALETTE.glassLight);
    put(shipPixels, width, height, shipX + 5, shipY + 8, [37, 125, 183, 255]);
    rect(shipPixels, width, height, shipX + 7, shipY + 18, 3, 2, PALETTE.gold);
    rect(shipPixels, width, height, shipX + 7, shipY + 22, 3, 2, PALETTE.outline);

    animation.setLayerPixels(frameIndex, doc.layers[0].id, background);
    animation.setLayerPixels(frameIndex, starsLayer.id, starPixels);
    animation.setLayerPixels(frameIndex, engineLayer.id, enginePixels);
    animation.setLayerPixels(frameIndex, shipLayer.id, shipPixels);
  }
  animation.setActiveFrame(0);
  doc.setActiveLayer(shipLayer.id);
  doc.revision = 1;
  doc.saveVersion = 1;
  return { doc, animation, loop: true };
}
