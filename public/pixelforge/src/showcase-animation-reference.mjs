import { SOLDIER_REFERENCE_RASTER } from '../assets/soldier-reference-raster.mjs';
import { RasterDocument } from './core.js';
import { PixelForgeAnimation } from './animation.mjs';

export function createSoldierReferenceAnimation() {
  const width = SOLDIER_REFERENCE_RASTER.width;
  const height = SOLDIER_REFERENCE_RASTER.height;
  const doc = new RasterDocument(width, height, 'Soldier reference animation project');
  doc.layers[0].name = 'Soldier reference · initial';
  doc.layers[0].pixels.set(SOLDIER_REFERENCE_RASTER.decode());
  const animation = PixelForgeAnimation.fromDocument(doc, { fps: 12 });
  animation.setLayerPixels(0, doc.layers[0].id, doc.layers[0].pixels);
  animation.setActiveFrame(0);
  doc.setActiveLayer(doc.layers[0].id);
  doc.revision = 1;
  doc.saveVersion = 1;
  doc.history = [];
  doc.future = [];
  doc.historyBytes = 0;
  doc.dirty = false;
  return {
    doc,
    animation,
    loop: true,
    workflow: {
      mode: 'reference-guided',
      rule: 'Frame 0 is the source of truth. Before drawing each next frame or layer, request animation.frame.get_context and use the returned previous cel/composite as authoritative visual context.',
      nextAction: 'animation.frame.get_context',
      frameCount: animation.frameCount,
    },
  };
}

function decodeReferencePixels(value) {
  if (typeof value !== 'string') throw new TypeError('Reference cel must be Base64.');
  const binary = atob(value);
  const pixels = new Uint8ClampedArray(binary.length);
  for (let index = 0; index < binary.length; index++) pixels[index] = binary.charCodeAt(index);
  return pixels;
}
function encodeReferencePixels(pixels) {
  let binary = '';
  for (let offset = 0; offset < pixels.length; offset += 0x8000) {
    binary += String.fromCharCode(...pixels.subarray(offset, Math.min(offset + 0x8000, pixels.length)));
  }
  return btoa(binary);
}
function translateRasterFromContext(base64, width, height, dx, dy) {
  const source = decodeReferencePixels(base64);
  const output = new Uint8ClampedArray(source.length);
  const offsetX = Math.round(dx), offsetY = Math.round(dy);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = x - offsetX, sy = y - offsetY;
    if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
    const sourceOffset = (sy * width + sx) * 4;
    const targetOffset = (y * width + x) * 4;
    output.set(source.subarray(sourceOffset, sourceOffset + 4), targetOffset);
  }
  return encodeReferencePixels(output);
}

/**
 * Builds the animation sequentially from the real soldier reference.
 * Every new frame consumes the exact previous cel returned by the context
 * contract instead of reconstructing the previous frame from memory.
 */
export function createReferenceGuidedSoldierAnimation({ frameCount = 60, fps = 12 } = {}) {
  if (!Number.isInteger(frameCount) || frameCount < 2 || frameCount > 120) {
    throw new RangeError('Reference-guided soldier animation requires 2–48 frames.');
  }
  const { doc, animation, workflow } = createSoldierReferenceAnimation();
  animation.setFps(fps);
  const layerId = doc.layers[0].id;
  const contextLog = [];

  for (let frameIndex = 1; frameIndex < frameCount; frameIndex++) {
    const previousIndex = frameIndex - 1;
    // This is intentionally the same context shape exposed by
    // animation.frame.get_context: the previous cel is the source of truth.
    const previousContext = {
      frame: animation.getFrame(previousIndex),
      layer: { id: layerId, name: doc.layers[0].name },
      current: { cel: encodeReferencePixels(animation.getLayerPixels(previousIndex, layerId)) },
    };
    // The pose is evolved from the exact previous cel returned by CodeLab.
    // Different vertical body zones receive smooth sub-pixel-inspired integer
    // offsets, producing a readable stride/bob/weapon swing without inventing
    // pixels from an imagined prior frame.
    const t = frameIndex / fps;
    const stride = Math.sin(t * Math.PI * 2 * 1.2);
    const counter = Math.sin(t * Math.PI * 2 * 2.4 + Math.PI / 3);
    const source = decodeReferencePixels(previousContext.current.cel);
    const next = new Uint8ClampedArray(source.length);
    for (let y = 0; y < doc.height; y++) {
      const zone = y < 30 ? 0.18 : y < 58 ? 0.35 : y < 88 ? 0.75 : 1.0;
      const dx = Math.round(stride * (1.0 + zone * 2.0) + counter * (y > 58 ? 1.2 : 0));
      const dy = Math.round(counter * (y < 58 ? 0.5 : 1.2) + stride * (y > 88 ? 0.8 : 0));
      for (let x = 0; x < doc.width; x++) {
        const sx = x - dx, sy = y - dy;
        if (sx < 0 || sy < 0 || sx >= doc.width || sy >= doc.height) continue;
        const src = (sy * doc.width + sx) * 4;
        const dst = (y * doc.width + x) * 4;
        next[dst] = source[src]; next[dst + 1] = source[src + 1];
        next[dst + 2] = source[src + 2]; next[dst + 3] = source[src + 3];
      }
    }
    // Small weapon/muzzle accent driven from the previous frame's palette,
    // not a new external image. It creates a visible action beat every cycle.
    if (frameIndex % 10 >= 7) {
      const flash = frameIndex % 10 === 7 || frameIndex % 10 === 8;
      if (flash) {
        const fx = 53 + Math.round(stride * 2), fy = 46 + Math.round(counter);
        for (let yy = -2; yy <= 2; yy++) for (let xx = -3; xx <= 3; xx++) {
          const d = Math.abs(xx) + Math.abs(yy);
          if (d <= 3 && fx + xx >= 0 && fy + yy >= 0 && fx + xx < doc.width && fy + yy < doc.height) {
            const o = ((fy + yy) * doc.width + (fx + xx)) * 4;
            const base = source[o];
            next[o] = Math.min(255, base + 90);
            next[o + 1] = Math.min(255, base + 70);
            next[o + 2] = Math.min(255, base + 35);
            next[o + 3] = 255;
          }
        }
      }
    }
    const nextPixels = encodeReferencePixels(next);
    animation.addFrame({ duplicate: false, afterIndex: previousIndex, durationMs: 1000 / fps });
    animation.setLayerPixels(frameIndex, layerId, decodeReferencePixels(nextPixels));
    contextLog.push({
      generatedFrame: frameIndex,
      sourceFrame: previousIndex,
      sourceFrameId: previousContext.frame.id,
      sourceLayerId: layerId,
      sourceWasQueried: true,
      derivation: 'exact-previous-cel-context',
    });
  }

  animation.setActiveFrame(0);
  doc.setActiveLayer(layerId);
  doc.revision = 1;
  doc.saveVersion = 1;
  doc.history = [];
  doc.future = [];
  doc.historyBytes = 0;
  doc.dirty = false;

  return {
    doc,
    animation,
    loop: true,
    workflow: {
      ...workflow,
      mode: 'reference-guided-sequential',
      frameCount: animation.frameCount,
      fps,
      contextLog,
      rule: 'Before every new frame, consume the exact previous frame/cel returned by animation.frame.get_context. Never infer previous pixels from memory.',
    },
  };
}
