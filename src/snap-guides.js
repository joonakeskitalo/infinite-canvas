/**
 * Snap & Guide System
 *
 * Element snapping, proximity guides, spacing guides, and measurement hover guides.
 */

import { state, CONSTANTS, spatialIndex } from "./state.js";
import { getShapeBounds, getElementBounds } from "./elements.js";

// Threshold below which linear iteration is faster than spatial index overhead
const SPATIAL_INDEX_THRESHOLD = 50;

export function getClosestElements(bounds, excludeIds, maxCount) {
  const excluded = new Set(excludeIds);
  const myCx = bounds.x + bounds.w / 2;
  const myCy = bounds.y + bounds.h / 2;

  const groupBoundsMap = new Map();
  const candidates = [];

  function addElement(b, groupId) {
    if (groupId) {
      if (!groupBoundsMap.has(groupId)) {
        groupBoundsMap.set(groupId, { minX: b.x, minY: b.y, maxX: b.x + b.w, maxY: b.y + b.h });
      } else {
        const gb = groupBoundsMap.get(groupId);
        gb.minX = Math.min(gb.minX, b.x);
        gb.minY = Math.min(gb.minY, b.y);
        gb.maxX = Math.max(gb.maxX, b.x + b.w);
        gb.maxY = Math.max(gb.maxY, b.y + b.h);
      }
    } else {
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const dist = Math.hypot(cx - myCx, cy - myCy);
      candidates.push({ bounds: b, dist });
    }
  }

  const totalElements = state.images.length + state.drawings.length;

  if (totalElements > SPATIAL_INDEX_THRESHOLD) {
    // Use spatial index for large element counts
    const spatialBounds = {
      minX: bounds.x,
      minY: bounds.y,
      maxX: bounds.x + bounds.w,
      maxY: bounds.y + bounds.h,
    };
    const nearby = spatialIndex.queryNearest(spatialBounds, excluded, maxCount * 3);
    for (const el of nearby) {
      if (el.type === "connector") continue;
      const b = el.elementType === "image"
        ? { x: el.x, y: el.y, w: el.w, h: el.h }
        : getShapeBounds(el);
      addElement(b, el.groupId);
    }
  } else {
    // Direct iteration for small element counts (faster due to no overhead)
    for (const img of state.images) {
      if (excluded.has(img.id)) continue;
      addElement({ x: img.x, y: img.y, w: img.w, h: img.h }, img.groupId);
    }
    for (const shape of state.drawings) {
      if (excluded.has(shape.id)) continue;
      if (shape.type === "connector") continue;
      addElement(getShapeBounds(shape), shape.groupId);
    }
  }

  groupBoundsMap.forEach((gb) => {
    const b = { x: gb.minX, y: gb.minY, w: gb.maxX - gb.minX, h: gb.maxY - gb.minY };
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const dist = Math.hypot(cx - myCx, cy - myCy);
    candidates.push({ bounds: b, dist });
  });

  candidates.sort((a, b) => a.dist - b.dist);
  return candidates.slice(0, maxCount).map((c) => c.bounds);
}

export function getSnapTargets(excludeIds, bounds) {
  const targets = { x: [], y: [] };
  const excluded = new Set(excludeIds);

  for (const guide of state.guides) {
    if (guide.axis === "x") targets.x.push(guide.position);
    else targets.y.push(guide.position);
  }

  let elementBounds;
  if (bounds) {
    elementBounds = getClosestElements(bounds, excludeIds, CONSTANTS.MAX_GUIDE_NEIGHBORS);
  } else {
    const groupBoundsMap = new Map();
    elementBounds = [];

    function addEl(b, groupId) {
      if (groupId) {
        if (!groupBoundsMap.has(groupId)) {
          groupBoundsMap.set(groupId, { minX: b.x, minY: b.y, maxX: b.x + b.w, maxY: b.y + b.h });
        } else {
          const gb = groupBoundsMap.get(groupId);
          gb.minX = Math.min(gb.minX, b.x);
          gb.minY = Math.min(gb.minY, b.y);
          gb.maxX = Math.max(gb.maxX, b.x + b.w);
          gb.maxY = Math.max(gb.maxY, b.y + b.h);
        }
      } else {
        elementBounds.push(b);
      }
    }

    state.images.forEach((img) => {
      if (excluded.has(img.id)) return;
      addEl({ x: img.x, y: img.y, w: img.w, h: img.h }, img.groupId);
    });
    state.drawings.forEach((shape) => {
      if (excluded.has(shape.id)) return;
      if (shape.type === "connector") return;
      addEl(getShapeBounds(shape), shape.groupId);
    });

    groupBoundsMap.forEach((gb) => {
      elementBounds.push({ x: gb.minX, y: gb.minY, w: gb.maxX - gb.minX, h: gb.maxY - gb.minY });
    });
  }

  for (const b of elementBounds) {
    targets.x.push(b.x, b.x + b.w, b.x + b.w / 2);
    targets.y.push(b.y, b.y + b.h, b.y + b.h / 2);
  }

  return targets;
}

export function snapToElements(bounds, targets, threshold) {
  let dx = 0, dy = 0;
  const guides = [];

  const myEdgesX = [bounds.x, bounds.x + bounds.w / 2, bounds.x + bounds.w];
  const myEdgesY = [bounds.y, bounds.y + bounds.h / 2, bounds.y + bounds.h];

  let bestDistX = threshold;
  for (const myX of myEdgesX) {
    for (const tX of targets.x) {
      const dist = Math.abs(myX - tX);
      if (dist < bestDistX) { bestDistX = dist; dx = tX - myX; }
    }
  }

  let bestDistY = threshold;
  for (const myY of myEdgesY) {
    for (const tY of targets.y) {
      const dist = Math.abs(myY - tY);
      if (dist < bestDistY) { bestDistY = dist; dy = tY - myY; }
    }
  }

  const snappedEdgesX = myEdgesX.map((v) => v + dx);
  const snappedEdgesY = myEdgesY.map((v) => v + dy);

  for (const sx of snappedEdgesX) {
    for (const tX of targets.x) {
      if (Math.abs(sx - tX) < 0.5) guides.push({ axis: "x", pos: tX });
    }
  }
  for (const sy of snappedEdgesY) {
    for (const tY of targets.y) {
      if (Math.abs(sy - tY) < 0.5) guides.push({ axis: "y", pos: tY });
    }
  }

  return { dx, dy, guides };
}

export function snapToSpacing(bounds, excludeIds, threshold) {
  const allElements = getClosestElements(bounds, excludeIds, CONSTANTS.MAX_GUIDE_NEIGHBORS);
  if (allElements.length < 2) return { dx: 0, dy: 0 };

  const myLeft = bounds.x, myRight = bounds.x + bounds.w;
  const myTop = bounds.y, myBottom = bounds.y + bounds.h;

  const refGapsX = [], refGapsY = [];

  for (let i = 0; i < allElements.length; i++) {
    for (let j = i + 1; j < allElements.length; j++) {
      const a = allElements[i], b = allElements[j];
      const aL = a.x, aR = a.x + a.w, aT = a.y, aB = a.y + a.h;
      const bL = b.x, bR = b.x + b.w, bT = b.y, bB = b.y + b.h;
      if (aB > bT && aT < bB) {
        if (aR <= bL && bL - aR > 0) refGapsX.push(bL - aR);
        if (bR <= aL && aL - bR > 0) refGapsX.push(aL - bR);
      }
      if (aR > bL && aL < bR) {
        if (aB <= bT && bT - aB > 0) refGapsY.push(bT - aB);
        if (bB <= aT && aT - bB > 0) refGapsY.push(aT - bB);
      }
    }
  }

  const uniqueGapsX = [...new Set(refGapsX.map((g) => Math.round(g * 10) / 10))];
  const uniqueGapsY = [...new Set(refGapsY.map((g) => Math.round(g * 10) / 10))];

  let bestDx = 0, bestDistX = threshold;
  let bestDy = 0, bestDistY = threshold;

  for (const el of allElements) {
    const elL = el.x, elR = el.x + el.w, elT = el.y, elB = el.y + el.h;

    if (myBottom > elT && myTop < elB) {
      if (elR <= myLeft + threshold * 2) {
        for (const gap of uniqueGapsX) {
          const targetMyLeft = elR + gap;
          const dist = Math.abs(myLeft - targetMyLeft);
          if (dist < bestDistX) { bestDistX = dist; bestDx = targetMyLeft - myLeft; }
        }
      }
      if (elL >= myRight - threshold * 2) {
        for (const gap of uniqueGapsX) {
          const targetMyRight = elL - gap;
          const dist = Math.abs(myRight - targetMyRight);
          if (dist < bestDistX) { bestDistX = dist; bestDx = targetMyRight - myRight; }
        }
      }
    }

    if (myRight > elL && myLeft < elR) {
      if (elB <= myTop + threshold * 2) {
        for (const gap of uniqueGapsY) {
          const targetMyTop = elB + gap;
          const dist = Math.abs(myTop - targetMyTop);
          if (dist < bestDistY) { bestDistY = dist; bestDy = targetMyTop - myTop; }
        }
      }
      if (elT >= myBottom - threshold * 2) {
        for (const gap of uniqueGapsY) {
          const targetMyBottom = elT - gap;
          const dist = Math.abs(myBottom - targetMyBottom);
          if (dist < bestDistY) { bestDistY = dist; bestDy = targetMyBottom - myBottom; }
        }
      }
    }
  }

  return { dx: bestDx, dy: bestDy };
}

export function getProximityGuides(bounds, excludeIds) {
  const PROXIMITY_RANGE = 150 / state.transform.zoom;
  const guides = [];

  const myLeft = bounds.x, myRight = bounds.x + bounds.w, myCx = bounds.x + bounds.w / 2;
  const myTop = bounds.y, myBottom = bounds.y + bounds.h, myCy = bounds.y + bounds.h / 2;

  const allElements = getClosestElements(bounds, excludeIds, CONSTANTS.MAX_GUIDE_NEIGHBORS);

  for (const el of allElements) {
    const elLeft = el.x, elRight = el.x + el.w, elCx = el.x + el.w / 2;
    const elTop = el.y, elBottom = el.y + el.h, elCy = el.y + el.h / 2;

    const xPairs = [
      [myLeft, elLeft], [myLeft, elRight], [myLeft, elCx],
      [myRight, elLeft], [myRight, elRight], [myRight, elCx],
      [myCx, elLeft], [myCx, elRight], [myCx, elCx],
    ];
    for (const [myX, elX] of xPairs) {
      const dist = Math.abs(myX - elX);
      if (dist < PROXIMITY_RANGE && dist > 0.5) {
        const minY = Math.min(myTop, myBottom, elTop, elBottom) - 20 / state.transform.zoom;
        const maxY = Math.max(myTop, myBottom, elTop, elBottom) + 20 / state.transform.zoom;
        guides.push({ axis: "x", pos: elX, from: minY, to: maxY, dist });
      }
    }

    const yPairs = [
      [myTop, elTop], [myTop, elBottom], [myTop, elCy],
      [myBottom, elTop], [myBottom, elBottom], [myBottom, elCy],
      [myCy, elTop], [myCy, elBottom], [myCy, elCy],
    ];
    for (const [myY, elY] of yPairs) {
      const dist = Math.abs(myY - elY);
      if (dist < PROXIMITY_RANGE && dist > 0.5) {
        const minX = Math.min(myLeft, myRight, elLeft, elRight) - 20 / state.transform.zoom;
        const maxX = Math.max(myLeft, myRight, elLeft, elRight) + 20 / state.transform.zoom;
        guides.push({ axis: "y", pos: elY, from: minX, to: maxX, dist });
      }
    }
  }

  const best = new Map();
  for (const g of guides) {
    const key = g.axis + "_" + g.pos.toFixed(1);
    if (!best.has(key) || g.dist < best.get(key).dist) best.set(key, g);
  }

  return Array.from(best.values());
}

export function getSpacingGuides(bounds, excludeIds) {
  const guides = [];
  const SPACING_RANGE = 300 / state.transform.zoom;

  const myLeft = bounds.x, myRight = bounds.x + bounds.w;
  const myTop = bounds.y, myBottom = bounds.y + bounds.h;

  const allElements = getClosestElements(bounds, excludeIds, CONSTANTS.MAX_GUIDE_NEIGHBORS);

  for (const el of allElements) {
    const elLeft = el.x, elRight = el.x + el.w;
    const elTop = el.y, elBottom = el.y + el.h;
    const vOverlap = myBottom > elTop && myTop < elBottom;
    const hOverlap = myRight > elLeft && myLeft < elRight;

    if (vOverlap) {
      if (elRight <= myLeft) {
        const gap = myLeft - elRight;
        if (gap > 0 && gap < SPACING_RANGE) {
          const overlapTop = Math.max(myTop, elTop);
          const overlapBottom = Math.min(myBottom, elBottom);
          guides.push({ axis: "x", from: elRight, to: myLeft, pos: (overlapTop + overlapBottom) / 2, dist: gap, isEqual: false });
        }
      }
      if (elLeft >= myRight) {
        const gap = elLeft - myRight;
        if (gap > 0 && gap < SPACING_RANGE) {
          const overlapTop = Math.max(myTop, elTop);
          const overlapBottom = Math.min(myBottom, elBottom);
          guides.push({ axis: "x", from: myRight, to: elLeft, pos: (overlapTop + overlapBottom) / 2, dist: gap, isEqual: false });
        }
      }
    }

    if (hOverlap) {
      if (elBottom <= myTop) {
        const gap = myTop - elBottom;
        if (gap > 0 && gap < SPACING_RANGE) {
          const overlapLeft = Math.max(myLeft, elLeft);
          const overlapRight = Math.min(myRight, elRight);
          guides.push({ axis: "y", from: elBottom, to: myTop, pos: (overlapLeft + overlapRight) / 2, dist: gap, isEqual: false });
        }
      }
      if (elTop >= myBottom) {
        const gap = elTop - myBottom;
        if (gap > 0 && gap < SPACING_RANGE) {
          const overlapLeft = Math.max(myLeft, elLeft);
          const overlapRight = Math.min(myRight, elRight);
          guides.push({ axis: "y", from: myBottom, to: elTop, pos: (overlapLeft + overlapRight) / 2, dist: gap, isEqual: false });
        }
      }
    }
  }

  // Detect equal spacing
  const otherGapsX = [], otherGapsY = [];
  for (let i = 0; i < allElements.length; i++) {
    for (let j = i + 1; j < allElements.length; j++) {
      const a = allElements[i], b = allElements[j];
      const aL = a.x, aR = a.x + a.w, aT = a.y, aB = a.y + a.h;
      const bL = b.x, bR = b.x + b.w, bT = b.y, bB = b.y + b.h;

      if (aB > bT && aT < bB) {
        if (aR <= bL) { const gap = bL - aR; if (gap > 0 && gap < SPACING_RANGE) otherGapsX.push({ from: aR, to: bL, pos: (Math.max(aT, bT) + Math.min(aB, bB)) / 2, dist: gap }); }
        else if (bR <= aL) { const gap = aL - bR; if (gap > 0 && gap < SPACING_RANGE) otherGapsX.push({ from: bR, to: aL, pos: (Math.max(aT, bT) + Math.min(aB, bB)) / 2, dist: gap }); }
      }
      if (aR > bL && aL < bR) {
        if (aB <= bT) { const gap = bT - aB; if (gap > 0 && gap < SPACING_RANGE) otherGapsY.push({ from: aB, to: bT, pos: (Math.max(aL, bL) + Math.min(aR, bR)) / 2, dist: gap }); }
        else if (bB <= aT) { const gap = aT - bB; if (gap > 0 && gap < SPACING_RANGE) otherGapsY.push({ from: bB, to: aT, pos: (Math.max(aL, bL) + Math.min(aR, bR)) / 2, dist: gap }); }
      }
    }
  }

  const EQUAL_TOLERANCE = 2 / state.transform.zoom;
  for (const guide of guides) {
    const otherGaps = guide.axis === "x" ? otherGapsX : otherGapsY;
    for (const other of otherGaps) {
      if (Math.abs(guide.dist - other.dist) < EQUAL_TOLERANCE) {
        guide.isEqual = true;
        const exists = guides.some((g) => g.axis === guide.axis && Math.abs(g.from - other.from) < 1 && Math.abs(g.to - other.to) < 1);
        if (!exists) {
          guides.push({ axis: guide.axis, from: other.from, to: other.to, pos: other.pos, dist: other.dist, isEqual: true });
        }
        break;
      }
    }
  }

  return guides;
}

export function snapResizeEdges(bounds, handlePosition, targets, threshold) {
  let dx = 0, dy = 0;
  const guides = [];

  // Determine which edges are moving based on handle position
  const movingEdgesX = [];
  const movingEdgesY = [];

  if (handlePosition === "br" || handlePosition === "tr") {
    movingEdgesX.push(bounds.x + bounds.w); // right edge moves
  }
  if (handlePosition === "bl" || handlePosition === "tl") {
    movingEdgesX.push(bounds.x); // left edge moves
  }
  if (handlePosition === "br" || handlePosition === "bl") {
    movingEdgesY.push(bounds.y + bounds.h); // bottom edge moves
  }
  if (handlePosition === "tr" || handlePosition === "tl") {
    movingEdgesY.push(bounds.y); // top edge moves
  }

  let bestDistX = threshold;
  for (const myX of movingEdgesX) {
    for (const tX of targets.x) {
      const dist = Math.abs(myX - tX);
      if (dist < bestDistX) { bestDistX = dist; dx = tX - myX; }
    }
  }

  let bestDistY = threshold;
  for (const myY of movingEdgesY) {
    for (const tY of targets.y) {
      const dist = Math.abs(myY - tY);
      if (dist < bestDistY) { bestDistY = dist; dy = tY - myY; }
    }
  }

  // Generate visual guide lines for snapped edges
  if (dx !== 0) {
    const snappedX = movingEdgesX.map((v) => v + dx);
    for (const sx of snappedX) {
      for (const tX of targets.x) {
        if (Math.abs(sx - tX) < 0.5) guides.push({ axis: "x", pos: tX });
      }
    }
  }
  if (dy !== 0) {
    const snappedY = movingEdgesY.map((v) => v + dy);
    for (const sy of snappedY) {
      for (const tY of targets.y) {
        if (Math.abs(sy - tY) < 0.5) guides.push({ axis: "y", pos: tY });
      }
    }
  }

  return { dx, dy, guides };
}

export function computeMeasureHoverGuides(worldPos) {
  const NEARBY_RADIUS = 600 / state.transform.zoom;
  const MAX_DIST = 500 / state.transform.zoom;
  const MAX_GUIDES = 12;
  const guides = [];

  // Collect bounds of all relevant elements (include split lines, exclude regular lines, arrows & connectors)
  const allBounds = [];
  const splitLineMap = new Map(); // id -> split line shape for edge-distance calculation
  state.images.forEach((img) => {
    allBounds.push({ id: img.id, x: img.x, y: img.y, w: img.w, h: img.h });
  });
  state.drawings.forEach((shape) => {
    if (shape.type === "connector" || shape.type === "arrow") return;
    if (shape.type === "line" && !shape.isSplitLine) return;
    const b = getShapeBounds(shape);
    allBounds.push({ id: shape.id, x: b.x, y: b.y, w: b.w, h: b.h });
    if (shape.isSplitLine) splitLineMap.set(shape.id, shape);
  });

  // Determine if hovering over an element
  let hoveredBounds = null;
  for (let i = allBounds.length - 1; i >= 0; i--) {
    const b = allBounds[i];
    if (worldPos.x >= b.x && worldPos.x <= b.x + b.w && worldPos.y >= b.y && worldPos.y <= b.y + b.h) {
      hoveredBounds = b;
      break;
    }
  }

  // Find elements near the cursor
  const nearbyBounds = [];
  for (const b of allBounds) {
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const distToCursor = Math.hypot(cx - worldPos.x, cy - worldPos.y);
    if (distToCursor < NEARBY_RADIUS) {
      nearbyBounds.push(b);
    }
  }

  // If hovering over an element, show distances from cursor to element edges
  // and from that element to nearby elements
  if (hoveredBounds) {
    const myLeft = hoveredBounds.x, myRight = hoveredBounds.x + hoveredBounds.w;
    const myTop = hoveredBounds.y, myBottom = hoveredBounds.y + hoveredBounds.h;

    // Distance from cursor to each edge of the hovered element
    const distToLeft = worldPos.x - myLeft;
    const distToRight = myRight - worldPos.x;
    const distToTop = worldPos.y - myTop;
    const distToBottom = myBottom - worldPos.y;

    if (distToLeft > 0.5) guides.push({ fromX: myLeft, fromY: worldPos.y, toX: worldPos.x, toY: worldPos.y, dist: distToLeft, isEdge: true });
    if (distToRight > 0.5) guides.push({ fromX: worldPos.x, fromY: worldPos.y, toX: myRight, toY: worldPos.y, dist: distToRight, isEdge: true });
    if (distToTop > 0.5) guides.push({ fromX: worldPos.x, fromY: myTop, toX: worldPos.x, toY: worldPos.y, dist: distToTop, isEdge: true });
    if (distToBottom > 0.5) guides.push({ fromX: worldPos.x, fromY: worldPos.y, toX: worldPos.x, toY: myBottom, dist: distToBottom, isEdge: true });

    // If hovering a split line, show distance from the split line to the parent image edges
    // (only to the nearest edge, i.e., if no other split line is between it and the edge)
    const hoveredSplitLine = splitLineMap.get(hoveredBounds.id);
    if (hoveredSplitLine) {
      _addSplitLineEdgeGuides(guides, hoveredSplitLine, splitLineMap);
    }

    for (const b of nearbyBounds) {
      if (b.id === hoveredBounds.id) continue;
      _addPairGuides(guides, myLeft, myTop, myRight, myBottom, b.x, b.y, b.x + b.w, b.y + b.h, MAX_DIST, nearbyBounds, hoveredBounds.id, b.id);
    }
  }

  // Show distances between pairs of nearby elements (element-to-element gaps near cursor)
  for (let i = 0; i < nearbyBounds.length; i++) {
    for (let j = i + 1; j < nearbyBounds.length; j++) {
      const a = nearbyBounds[i];
      const b = nearbyBounds[j];
      // Skip if one of them is the hovered element (already handled above)
      if (hoveredBounds && (a.id === hoveredBounds.id || b.id === hoveredBounds.id)) continue;
      _addPairGuides(guides, a.x, a.y, a.x + a.w, a.y + a.h, b.x, b.y, b.x + b.w, b.y + b.h, MAX_DIST, nearbyBounds, a.id, b.id);
    }
  }

  // Show split-line-to-image-edge distances for nearby split lines
  // (only when the split line is the nearest element to that edge)
  for (const b of nearbyBounds) {
    const sl = splitLineMap.get(b.id);
    if (!sl) continue;
    // Skip if already handled as hovered
    if (hoveredBounds && b.id === hoveredBounds.id) continue;
    _addSplitLineEdgeGuides(guides, sl, splitLineMap);
  }

  // Also show cursor-to-element distances when not hovering an element
  if (!hoveredBounds) {
    for (const bounds of nearbyBounds) {
      const left = bounds.x, right = bounds.x + bounds.w;
      const top = bounds.y, bottom = bounds.y + bounds.h;

      if (worldPos.y >= top && worldPos.y <= bottom) {
        if (worldPos.x < left) {
          const dist = left - worldPos.x;
          if (dist < MAX_DIST) guides.push({ fromX: worldPos.x, fromY: worldPos.y, toX: left, toY: worldPos.y, dist });
        } else if (worldPos.x > right) {
          const dist = worldPos.x - right;
          if (dist < MAX_DIST) guides.push({ fromX: worldPos.x, fromY: worldPos.y, toX: right, toY: worldPos.y, dist });
        }
      }

      if (worldPos.x >= left && worldPos.x <= right) {
        if (worldPos.y < top) {
          const dist = top - worldPos.y;
          if (dist < MAX_DIST) guides.push({ fromX: worldPos.x, fromY: worldPos.y, toX: worldPos.x, toY: top, dist });
        } else if (worldPos.y > bottom) {
          const dist = worldPos.y - bottom;
          if (dist < MAX_DIST) guides.push({ fromX: worldPos.x, fromY: worldPos.y, toX: worldPos.x, toY: bottom, dist });
        }
      }
    }
  }

  // Deduplicate guides that are very close to each other
  const deduped = [];
  for (const g of guides) {
    if (g.isEdge) { deduped.push(g); continue; }
    let isDuplicate = false;
    for (const existing of deduped) {
      if (Math.abs(g.dist - existing.dist) < 1 &&
          Math.abs(g.fromX - existing.fromX) < 2 && Math.abs(g.fromY - existing.fromY) < 2 &&
          Math.abs(g.toX - existing.toX) < 2 && Math.abs(g.toY - existing.toY) < 2) {
        isDuplicate = true;
        break;
      }
    }
    if (!isDuplicate) deduped.push(g);
  }

  // Edge guides always included; inter-element guides sorted by distance and capped
  const edgeGuides = deduped.filter((g) => g.isEdge);
  const otherGuides = deduped.filter((g) => !g.isEdge);
  otherGuides.sort((a, b) => a.dist - b.dist);
  return edgeGuides.concat(otherGuides.slice(0, MAX_GUIDES));
}

/**
 * Show distance from a split line to the edges of its parent image,
 * but only if it's the nearest split line to that edge (no other split line is between it and the edge).
 */
function _addSplitLineEdgeGuides(guides, splitLine, splitLineMap) {
  const slStartX = Math.min(splitLine.start.x, splitLine.end.x);
  const slStartY = Math.min(splitLine.start.y, splitLine.end.y);
  const slEndX = Math.max(splitLine.start.x, splitLine.end.x);
  const slEndY = Math.max(splitLine.start.y, splitLine.end.y);
  const isVertical = Math.abs(splitLine.start.x - splitLine.end.x) < 1;

  // Find the parent image
  let parentImg = null;
  for (const img of state.images) {
    if (slStartX >= img.x - 1 && slEndX <= img.x + img.w + 1 &&
        slStartY >= img.y - 1 && slEndY <= img.y + img.h + 1) {
      parentImg = img;
      break;
    }
  }
  if (!parentImg) return;

  // Collect other split lines within the same parent image with the same orientation
  const siblingSplitPositions = [];
  for (const [id, sl] of splitLineMap) {
    if (id === splitLine.id) continue;
    const slIsVertical = Math.abs(sl.start.x - sl.end.x) < 1;
    if (slIsVertical !== isVertical) continue;
    // Check it belongs to the same parent image
    const sMinX = Math.min(sl.start.x, sl.end.x);
    const sMinY = Math.min(sl.start.y, sl.end.y);
    const sMaxX = Math.max(sl.start.x, sl.end.x);
    const sMaxY = Math.max(sl.start.y, sl.end.y);
    if (sMinX >= parentImg.x - 1 && sMaxX <= parentImg.x + parentImg.w + 1 &&
        sMinY >= parentImg.y - 1 && sMaxY <= parentImg.y + parentImg.h + 1) {
      if (isVertical) {
        siblingSplitPositions.push((sl.start.x + sl.end.x) / 2);
      } else {
        siblingSplitPositions.push((sl.start.y + sl.end.y) / 2);
      }
    }
  }

  if (isVertical) {
    const lineX = (splitLine.start.x + splitLine.end.x) / 2;
    const midY = (Math.max(slStartY, parentImg.y) + Math.min(slEndY, parentImg.y + parentImg.h)) / 2;
    const imgLeft = parentImg.x;
    const imgRight = parentImg.x + parentImg.w;

    // Check if this is the nearest to the left edge
    let nearestToLeft = true;
    for (const pos of siblingSplitPositions) {
      if (pos > imgLeft && pos < lineX) { nearestToLeft = false; break; }
    }
    // Check if this is the nearest to the right edge
    let nearestToRight = true;
    for (const pos of siblingSplitPositions) {
      if (pos < imgRight && pos > lineX) { nearestToRight = false; break; }
    }

    const distLeft = lineX - imgLeft;
    const distRight = imgRight - lineX;
    if (nearestToLeft && distLeft > 0.5) guides.push({ fromX: imgLeft, fromY: midY, toX: lineX, toY: midY, dist: distLeft, isEdge: true });
    if (nearestToRight && distRight > 0.5) guides.push({ fromX: lineX, fromY: midY, toX: imgRight, toY: midY, dist: distRight, isEdge: true });
  } else {
    const lineY = (splitLine.start.y + splitLine.end.y) / 2;
    const midX = (Math.max(slStartX, parentImg.x) + Math.min(slEndX, parentImg.x + parentImg.w)) / 2;
    const imgTop = parentImg.y;
    const imgBottom = parentImg.y + parentImg.h;

    // Check if this is the nearest to the top edge
    let nearestToTop = true;
    for (const pos of siblingSplitPositions) {
      if (pos > imgTop && pos < lineY) { nearestToTop = false; break; }
    }
    // Check if this is the nearest to the bottom edge
    let nearestToBottom = true;
    for (const pos of siblingSplitPositions) {
      if (pos < imgBottom && pos > lineY) { nearestToBottom = false; break; }
    }

    const distTop = lineY - imgTop;
    const distBottom = imgBottom - lineY;
    if (nearestToTop && distTop > 0.5) guides.push({ fromX: midX, fromY: imgTop, toX: midX, toY: lineY, dist: distTop, isEdge: true });
    if (nearestToBottom && distBottom > 0.5) guides.push({ fromX: midX, fromY: lineY, toX: midX, toY: imgBottom, dist: distBottom, isEdge: true });
  }
}

/**
 * Compute edge-to-edge distance guides between two axis-aligned rectangles.
 * Adds horizontal, vertical, or diagonal distance guides depending on overlap.
 * Skips guides whose measurement line passes through another element (occlusion).
 */
function _addPairGuides(guides, aLeft, aTop, aRight, aBottom, bLeft, bTop, bRight, bBottom, maxDist, allBounds, idA, idB) {
  const vOverlap = aBottom > bTop && aTop < bBottom;
  const hOverlap = aRight > bLeft && aLeft < bRight;

  if (vOverlap) {
    const overlapTop = Math.max(aTop, bTop);
    const overlapBottom = Math.min(aBottom, bBottom);
    const midY = (overlapTop + overlapBottom) / 2;
    if (bRight <= aLeft) {
      const dist = aLeft - bRight;
      if (dist > 0.5 && dist < maxDist && !_isOccluded(bRight, midY, aLeft, midY, allBounds, idA, idB)) {
        guides.push({ fromX: bRight, fromY: midY, toX: aLeft, toY: midY, dist });
      }
    }
    if (bLeft >= aRight) {
      const dist = bLeft - aRight;
      if (dist > 0.5 && dist < maxDist && !_isOccluded(aRight, midY, bLeft, midY, allBounds, idA, idB)) {
        guides.push({ fromX: aRight, fromY: midY, toX: bLeft, toY: midY, dist });
      }
    }
  }

  if (hOverlap) {
    const overlapLeft = Math.max(aLeft, bLeft);
    const overlapRight = Math.min(aRight, bRight);
    const midX = (overlapLeft + overlapRight) / 2;
    if (bBottom <= aTop) {
      const dist = aTop - bBottom;
      if (dist > 0.5 && dist < maxDist && !_isOccluded(midX, bBottom, midX, aTop, allBounds, idA, idB)) {
        guides.push({ fromX: midX, fromY: bBottom, toX: midX, toY: aTop, dist });
      }
    }
    if (bTop >= aBottom) {
      const dist = bTop - aBottom;
      if (dist > 0.5 && dist < maxDist && !_isOccluded(midX, aBottom, midX, bTop, allBounds, idA, idB)) {
        guides.push({ fromX: midX, fromY: aBottom, toX: midX, toY: bTop, dist });
      }
    }
  }

  // Diagonal distance for elements without axis overlap
  if (!vOverlap && !hOverlap) {
    const closestOnA = _clampPointToRect((bLeft + bRight) / 2, (bTop + bBottom) / 2, aLeft, aTop, aRight, aBottom);
    const closestOnB = _clampPointToRect(closestOnA.x, closestOnA.y, bLeft, bTop, bRight, bBottom);
    const refined = _clampPointToRect(closestOnB.x, closestOnB.y, aLeft, aTop, aRight, aBottom);
    const dx = closestOnB.x - refined.x;
    const dy = closestOnB.y - refined.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 0.5 && dist < maxDist && !_isOccluded(refined.x, refined.y, closestOnB.x, closestOnB.y, allBounds, idA, idB)) {
      guides.push({ fromX: refined.x, fromY: refined.y, toX: closestOnB.x, toY: closestOnB.y, dist });
    }
  }
}

/**
 * Check if any element's bounding box occludes the line segment between two points.
 * Returns true if another element sits between the two measured elements.
 */
function _isOccluded(x1, y1, x2, y2, allBounds, idA, idB) {
  // Build a tight AABB around the measurement line
  const lineMinX = Math.min(x1, x2);
  const lineMaxX = Math.max(x1, x2);
  const lineMinY = Math.min(y1, y2);
  const lineMaxY = Math.max(y1, y2);

  for (const b of allBounds) {
    if (b.id === idA || b.id === idB) continue;
    const elLeft = b.x, elTop = b.y, elRight = b.x + b.w, elBottom = b.y + b.h;
    // Quick AABB rejection
    if (elRight < lineMinX || elLeft > lineMaxX || elBottom < lineMinY || elTop > lineMaxY) continue;
    // For horizontal lines, check if the element spans the gap vertically
    if (Math.abs(y1 - y2) < 0.5) {
      // Horizontal: element must overlap the y position and span some x range within the line
      if (elTop <= y1 && elBottom >= y1 && elLeft < lineMaxX && elRight > lineMinX) return true;
    }
    // For vertical lines, check if the element spans the gap horizontally
    else if (Math.abs(x1 - x2) < 0.5) {
      if (elLeft <= x1 && elRight >= x1 && elTop < lineMaxY && elBottom > lineMinY) return true;
    }
    // For diagonal lines, check if the element's AABB overlaps the line's AABB significantly
    else {
      // Use a simple overlap area check — if the element covers a meaningful portion of the line path
      const overlapX = Math.min(elRight, lineMaxX) - Math.max(elLeft, lineMinX);
      const overlapY = Math.min(elBottom, lineMaxY) - Math.max(elTop, lineMinY);
      if (overlapX > 0 && overlapY > 0) return true;
    }
  }
  return false;
}
/**
 * Clamp a point to the nearest position on a rectangle's boundary.
 */
function _clampPointToRect(px, py, left, top, right, bottom) {
  const x = Math.max(left, Math.min(px, right));
  const y = Math.max(top, Math.min(py, bottom));
  return { x, y };
}
