/**
 * DOM-independent pointer gesture lifecycle for sparse tiled brush strokes.
 *
 * The editor can bind pointerdown/move/up/cancel to this controller once its
 * document factory and all editing tools support the tiled document contract.
 */
import { TiledRasterStrokeHistory } from './raster-tiled-history.mjs';

export class TiledRasterPointerStrokeController {
  #history;
  #fixedHistory = null;
  #activeHistory = null;
  #document;
  #pointerId = null;
  #layerId = null;
  #lastPoints = [];
  #ownsHistory = true;
  #pending = Promise.resolve();
  #disposed = false;

  constructor(document, historyOptions = {}) {
    this.#document = document;
    const sharedHistory = historyOptions.history || document.strokeHistory;
    this.#history = sharedHistory || new TiledRasterStrokeHistory(document, historyOptions);
    this.#fixedHistory = historyOptions.history || null;
    this.#ownsHistory = !sharedHistory;
  }

  get active() { return this.#pointerId !== null; }
  get history() { return this.#activeHistory || this.#resolveHistory(); }

  #resolveHistory() {
    return this.#fixedHistory || this.#document.strokeHistory || this.#history;
  }

  async pointerDown({ pointerId, layerId, point, points, settings }) {
    this.#assertLive();
    if (this.active) throw new Error('A tiled pointer stroke is already active.');
    const initialPoints = Array.isArray(points) ? points : [point];
    if (pointerId === undefined || pointerId === null ||
        !initialPoints.some(candidate => candidate && Number.isInteger(candidate.x) && Number.isInteger(candidate.y))) {
      throw new TypeError('A pointer ID and at least one integer document point are required.');
    }
    this.#activeHistory = this.#resolveHistory();
    this.#activeHistory.beginStroke(layerId, settings);
    this.#pointerId = pointerId;
    this.#layerId = layerId;
    this.#lastPoints = initialPoints.map(candidate =>
      candidate && Number.isInteger(candidate.x) && Number.isInteger(candidate.y)
        ? { x: candidate.x, y: candidate.y } : null);
    return this.#enqueue(async () => {
      try {
        let changed = false;
        for (const candidate of this.#lastPoints) {
          if (!candidate) continue;
          const result = await this.#activeHistory.dab(candidate.x, candidate.y);
          changed ||= result.changed;
        }
        return { changed };
      } catch (error) {
        if (this.#activeHistory?.isStrokeActive) await this.#activeHistory.cancelStroke();
        this.#reset();
        throw error;
      }
    });
  }

  pointerMove({ pointerId, point, points }) {
    this.#assertLive();
    if (!this.active || pointerId !== this.#pointerId) return Promise.resolve({ changed: false, ignored: true });
    if (point && (!Number.isInteger(point.x) || !Number.isInteger(point.y))) {
      throw new TypeError('Pointer move requires an integer document point.');
    }
    if (point && (point.x < 0 || point.y < 0 || point.x >= this.#document.width || point.y >= this.#document.height)) {
      return Promise.resolve({ changed: false, ignored: true, outside: true });
    }
    const nextPoints = (Array.isArray(points) ? points : [point]).map(candidate =>
      candidate ? { x: candidate.x, y: candidate.y } : null);
    if (!nextPoints.length) return Promise.resolve({ changed: false, ignored: true });
    return this.#enqueue(async () => {
      try {
        let changed = false, changedDabs = 0, changedPixels = 0;
        for (let index = 0; index < nextPoints.length; index++) {
          const next = nextPoints[index];
          const previous = this.#lastPoints[index] || null;
          if (!next) continue;
          if (!Number.isInteger(next.x) || !Number.isInteger(next.y)) {
            throw new TypeError('Symmetry points must be integer document coordinates or null.');
          }
          if (next.x < 0 || next.y < 0 || next.x >= this.#document.width || next.y >= this.#document.height) continue;
          const result = previous
            ? await this.#activeHistory.segment(previous, next)
            : await this.#activeHistory.dab(next.x, next.y);
          if (result.changed) changed = true;
          changedDabs += result.changedDabs || Number(Boolean(result.changed));
          changedPixels += result.changedPixels || 0;
        }
        this.#lastPoints = nextPoints;
        return { changed, changedDabs, changedPixels };
      } catch (error) {
        if (this.#activeHistory?.isStrokeActive) await this.#activeHistory.cancelStroke();
        this.#reset();
        throw error;
      }
    });
  }

  async pointerUp({ pointerId, commit = true } = {}) {
    this.#assertLive();
    await this.#pending;
    if (!this.active || (pointerId !== undefined && pointerId !== this.#pointerId)) return false;
    if (commit) this.#activeHistory.commitStroke();
    else await this.#activeHistory.cancelStroke();
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
    await this.#pending;
    if (this.active && this.#activeHistory?.isStrokeActive) await this.#activeHistory.cancelStroke();
    this.#reset();
    if (this.#ownsHistory) this.#history.dispose();
    this.#disposed = true;
  }

  #enqueue(operation) {
    const pending = this.#pending.then(operation);
    this.#pending = pending.catch(() => {});
    return pending;
  }
  #reset() {
    this.#pointerId = null;
    this.#layerId = null;
    this.#lastPoints = [];
    this.#activeHistory = null;
  }
  #assertLive() {
    if (this.#disposed) throw new Error('Tiled pointer stroke controller has been disposed.');
  }
}
