/**
 * DOM-independent pointer gesture lifecycle for sparse tiled brush strokes.
 *
 * The editor can bind pointerdown/move/up/cancel to this controller once its
 * document factory and all editing tools support the tiled document contract.
 */
import { TiledRasterStrokeHistory } from './raster-tiled-history.mjs';

export class TiledRasterPointerStrokeController {
  #history;
  #pointerId = null;
  #layerId = null;
  #lastPoint = null;
  #disposed = false;

  constructor(document, historyOptions = {}) {
    this.#history = new TiledRasterStrokeHistory(document, historyOptions);
  }

  get active() { return this.#pointerId !== null; }
  get history() { return this.#history; }

  async pointerDown({ pointerId, layerId, point, settings }) {
    this.#assertLive();
    if (this.active) throw new Error('A tiled pointer stroke is already active.');
    if (pointerId === undefined || pointerId === null || !point ||
        !Number.isInteger(point.x) || !Number.isInteger(point.y)) {
      throw new TypeError('A pointer ID and integer document point are required.');
    }
    this.#history.beginStroke(layerId, settings);
    this.#pointerId = pointerId;
    this.#layerId = layerId;
    this.#lastPoint = { x: point.x, y: point.y };
    try {
      return await this.#history.dab(point.x, point.y);
    } catch (error) {
      await this.#history.cancelStroke();
      this.#reset();
      throw error;
    }
  }

  async pointerMove({ pointerId, point }) {
    this.#assertLive();
    if (!this.active || pointerId !== this.#pointerId) return { changed: false, ignored: true };
    if (!point || !Number.isInteger(point.x) || !Number.isInteger(point.y)) {
      throw new TypeError('Pointer move requires an integer document point.');
    }
    const result = await this.#history.segment(this.#lastPoint, point);
    this.#lastPoint = { x: point.x, y: point.y };
    return result;
  }

  async pointerUp({ pointerId, commit = true } = {}) {
    this.#assertLive();
    if (!this.active || (pointerId !== undefined && pointerId !== this.#pointerId)) return false;
    if (commit) this.#history.commitStroke();
    else await this.#history.cancelStroke();
    this.#reset();
    return true;
  }

  async pointerCancel(pointerId) {
    return this.pointerUp({ pointerId, commit: false });
  }

  async lostPointerCapture(pointerId) {
    return this.pointerCancel(pointerId);
  }

  async dispose() {
    if (this.#disposed) return;
    if (this.active) await this.#history.cancelStroke();
    this.#reset();
    this.#history.dispose();
    this.#disposed = true;
  }

  #reset() {
    this.#pointerId = null;
    this.#layerId = null;
    this.#lastPoint = null;
  }
  #assertLive() {
    if (this.#disposed) throw new Error('Tiled pointer stroke controller has been disposed.');
  }
}
