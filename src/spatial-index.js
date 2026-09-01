/**
 * Spatial Index — Grid-based spatial hash for fast spatial queries.
 *
 * Provides O(1) insertion/removal and efficient range & point queries
 * by dividing world space into a uniform grid of cells.
 *
 * Each element is stored in every cell its bounding box overlaps.
 * Queries return candidate sets that may need further refinement.
 */

export class SpatialIndex {
  /**
   * @param {number} cellSize - Size of each grid cell in world units.
   *   Larger cells = fewer cells per element but more candidates per query.
   *   A good default is ~200–500 for typical canvas element sizes.
   */
  constructor(cellSize = 300) {
    this.cellSize = cellSize;
    /** @type {Map<string, Set<object>>} cell key -> set of elements */
    this.cells = new Map();
    /** @type {Map<string, {minX:number,minY:number,maxX:number,maxY:number}>} element id -> cached bounds */
    this.elementBounds = new Map();
    /** @type {Map<string, object>} element id -> element reference */
    this.elements = new Map();
  }

  // --- Private helpers ---

  _cellKey(cx, cy) {
    return `${cx},${cy}`;
  }

  _getCellRange(minX, minY, maxX, maxY) {
    const cs = this.cellSize;
    return {
      x0: Math.floor(minX / cs),
      y0: Math.floor(minY / cs),
      x1: Math.floor(maxX / cs),
      y1: Math.floor(maxY / cs),
    };
  }

  // --- Public API ---

  /**
   * Insert an element into the index.
   * @param {object} element - Must have an `id` property.
   * @param {{minX:number, minY:number, maxX:number, maxY:number}} bounds
   */
  insert(element, bounds) {
    const id = element.id;
    if (this.elementBounds.has(id)) {
      this.remove(element);
    }
    this.elementBounds.set(id, bounds);
    this.elements.set(id, element);
    const { x0, y0, x1, y1 } = this._getCellRange(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const key = this._cellKey(cx, cy);
        let cell = this.cells.get(key);
        if (!cell) {
          cell = new Set();
          this.cells.set(key, cell);
        }
        cell.add(element);
      }
    }
  }

  /**
   * Remove an element from the index.
   * @param {object} element - Must have an `id` property.
   */
  remove(element) {
    const id = element.id;
    const bounds = this.elementBounds.get(id);
    if (!bounds) return;
    const { x0, y0, x1, y1 } = this._getCellRange(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const key = this._cellKey(cx, cy);
        const cell = this.cells.get(key);
        if (cell) {
          cell.delete(element);
          if (cell.size === 0) this.cells.delete(key);
        }
      }
    }
    this.elementBounds.delete(id);
    this.elements.delete(id);
  }

  /**
   * Update an element's position in the index.
   * Call this after moving or resizing an element.
   * @param {object} element
   * @param {{minX:number, minY:number, maxX:number, maxY:number}} newBounds
   */
  update(element, newBounds) {
    const id = element.id;
    const oldBounds = this.elementBounds.get(id);
    if (oldBounds &&
        oldBounds.minX === newBounds.minX && oldBounds.minY === newBounds.minY &&
        oldBounds.maxX === newBounds.maxX && oldBounds.maxY === newBounds.maxY) {
      return; // No change
    }
    this.remove(element);
    this.insert(element, newBounds);
  }

  /**
   * Query all elements whose bounding boxes intersect the given rectangle.
   * @param {{minX:number, minY:number, maxX:number, maxY:number}} rect
   * @param {Set<string>} [excludeIds] - Optional set of element IDs to skip.
   * @returns {object[]} Array of candidate elements (may include false positives at cell boundaries).
   */
  queryRect(rect, excludeIds) {
    const results = new Set();
    const { x0, y0, x1, y1 } = this._getCellRange(rect.minX, rect.minY, rect.maxX, rect.maxY);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const key = this._cellKey(cx, cy);
        const cell = this.cells.get(key);
        if (!cell) continue;
        for (const el of cell) {
          if (excludeIds && excludeIds.has(el.id)) continue;
          // AABB intersection test against stored bounds
          const b = this.elementBounds.get(el.id);
          if (b && b.minX <= rect.maxX && b.maxX >= rect.minX &&
              b.minY <= rect.maxY && b.maxY >= rect.minY) {
            results.add(el);
          }
        }
      }
    }
    return Array.from(results);
  }

  /**
   * Query elements near a specific point within a radius.
   * @param {number} x - World X coordinate.
   * @param {number} y - World Y coordinate.
   * @param {number} radius - Search radius in world units.
   * @param {Set<string>} [excludeIds] - Optional set of element IDs to skip.
   * @returns {object[]}
   */
  queryPoint(x, y, radius, excludeIds) {
    return this.queryRect({
      minX: x - radius,
      minY: y - radius,
      maxX: x + radius,
      maxY: y + radius,
    }, excludeIds);
  }

  /**
   * Find the K closest elements to a given bounding box center.
   * Searches outward in expanding rings until enough candidates are found.
   * @param {{minX:number, minY:number, maxX:number, maxY:number}} bounds
   * @param {Set<string>} excludeIds
   * @param {number} maxCount
   * @returns {object[]} Elements sorted by distance to bounds center.
   */
  queryNearest(bounds, excludeIds, maxCount) {
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    const bw = bounds.maxX - bounds.minX;
    const bh = bounds.maxY - bounds.minY;

    // Start with a search radius proportional to element size, expand if needed
    let radius = Math.max(bw, bh, this.cellSize) * 2;
    let candidates = [];
    const maxExpansions = 5;

    for (let i = 0; i < maxExpansions; i++) {
      candidates = this.queryRect({
        minX: cx - radius,
        minY: cy - radius,
        maxX: cx + radius,
        maxY: cy + radius,
      }, excludeIds);
      if (candidates.length >= maxCount) break;
      radius *= 2;
    }

    // Sort by shortest gap distance between the query box and each element's
    // bounds (0 when they overlap/touch). Ranking by edge proximity rather than
    // center distance keeps large adjacent elements (e.g. a big image whose edge
    // is right next to the query box) in the result set — their outer edges are
    // valid snap targets even though their center is far away.
    const gapDist = (eb) => {
      const dx = Math.max(eb.minX - bounds.maxX, bounds.minX - eb.maxX, 0);
      const dy = Math.max(eb.minY - bounds.maxY, bounds.minY - eb.maxY, 0);
      return Math.hypot(dx, dy);
    };
    candidates.sort((a, b) => {
      const ab = this.elementBounds.get(a.id);
      const bb = this.elementBounds.get(b.id);
      return gapDist(ab) - gapDist(bb);
    });

    return candidates.slice(0, maxCount);
  }

  /**
   * Clear the entire index.
   */
  clear() {
    this.cells.clear();
    this.elementBounds.clear();
    this.elements.clear();
  }

  /**
   * Get the number of indexed elements.
   */
  get size() {
    return this.elements.size;
  }
}
