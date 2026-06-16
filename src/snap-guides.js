/**
 * Snap & Guide System
 *
 * Element snapping, proximity guides, spacing guides, and measurement hover guides.
 */

import { state, CONSTANTS } from "./state.js";
import { getShapeBounds, getElementBounds } from "./elements.js";

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

  state.images.forEach((img) => {
    if (excluded.has(img.id)) return;
    addElement({ x: img.x, y: img.y, w: img.w, h: img.h }, img.groupId);
  });
  state.drawings.forEach((shape) => {
    if (excluded.has(shape.id)) return;
    if (shape.type === "connector") return;
    addElement(getShapeBounds(shape), shape.groupId);
  });

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

export function computeMeasureHoverGuides(worldPos) {
  const MAX_DIST = 500 / state.transform.zoom;
  const MAX_GUIDES = 4;
  const guides = [];

  const allBounds = [];
  state.images.forEach((img) => {
    allBounds.push({ id: img.id, x: img.x, y: img.y, w: img.w, h: img.h });
  });
  state.drawings.forEach((shape) => {
    if (shape.type === "connector") return;
    const b = getShapeBounds(shape);
    allBounds.push({ id: shape.id, x: b.x, y: b.y, w: b.w, h: b.h });
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

  if (!hoveredBounds) {
    for (const bounds of allBounds) {
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

    guides.sort((a, b) => a.dist - b.dist);
    return guides.slice(0, MAX_GUIDES);
  }

  const myLeft = hoveredBounds.x, myRight = hoveredBounds.x + hoveredBounds.w;
  const myTop = hoveredBounds.y, myBottom = hoveredBounds.y + hoveredBounds.h;

  for (const b of allBounds) {
    if (b.id === hoveredBounds.id) continue;
    const elLeft = b.x, elRight = b.x + b.w;
    const elTop = b.y, elBottom = b.y + b.h;
    const vOverlap = myBottom > elTop && myTop < elBottom;
    const hOverlap = myRight > elLeft && myLeft < elRight;

    if (vOverlap) {
      const overlapTop = Math.max(myTop, elTop);
      const overlapBottom = Math.min(myBottom, elBottom);
      const midY = (overlapTop + overlapBottom) / 2;
      if (elRight <= myLeft) {
        const dist = myLeft - elRight;
        if (dist < MAX_DIST) guides.push({ fromX: elRight, fromY: midY, toX: myLeft, toY: midY, dist });
      }
      if (elLeft >= myRight) {
        const dist = elLeft - myRight;
        if (dist < MAX_DIST) guides.push({ fromX: myRight, fromY: midY, toX: elLeft, toY: midY, dist });
      }
    }

    if (hOverlap) {
      const overlapLeft = Math.max(myLeft, elLeft);
      const overlapRight = Math.min(myRight, elRight);
      const midX = (overlapLeft + overlapRight) / 2;
      if (elBottom <= myTop) {
        const dist = myTop - elBottom;
        if (dist < MAX_DIST) guides.push({ fromX: midX, fromY: elBottom, toX: midX, toY: myTop, dist });
      }
      if (elTop >= myBottom) {
        const dist = elTop - myBottom;
        if (dist < MAX_DIST) guides.push({ fromX: midX, fromY: myBottom, toX: midX, toY: elTop, dist });
      }
    }
  }

  guides.sort((a, b) => a.dist - b.dist);
  return guides.slice(0, MAX_GUIDES);
}
