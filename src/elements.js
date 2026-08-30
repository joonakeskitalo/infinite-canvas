/**
 * Element Operations
 *
 * Functions for working with canvas elements: bounds, hit testing,
 * cloning, serialization, and translation.
 */

import { state, CONSTANTS, getDom, spatialIndex } from "./state.js";
import { getPtToSegmentDist } from "./utils.js";

const _textMeasureCache = new WeakMap();

export function getTextMeasureCache() {
  return _textMeasureCache;
}

export function isPointOnMeasureLabel(p, shape) {
  if (shape.type !== "measure") return false;
  const dx = shape.end.x - shape.start.x;
  const dy = shape.end.y - shape.start.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 0.1) return false;

  const zoomFactor = state.transform.zoom;
  const fontSize = Math.max(11, 13 / zoomFactor);
  const angle = Math.atan2(dy, dx);
  const midX = (shape.start.x + shape.end.x) / 2;
  const midY = (shape.start.y + shape.end.y) / 2;

  // Approximate label width based on digit count
  const labelText = `${Math.round(dist)}px`;
  const charWidth = fontSize * 0.65;
  const labelW = labelText.length * charWidth + 8 / zoomFactor;
  const labelH = fontSize + 6 / zoomFactor;

  const labelOffset = 12 / zoomFactor;
  const labelCx = midX + Math.sin(angle) * labelOffset;
  const labelCy = midY - Math.cos(angle) * labelOffset;

  // Check if point is within the label rect
  return (
    p.x >= labelCx - labelW / 2 &&
    p.x <= labelCx + labelW / 2 &&
    p.y >= labelCy - labelH &&
    p.y <= labelCy
  );
}

export function getShapeBounds(shape) {
  const ctx = getDom().ctx;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  if (shape.type === "pen") {
    shape.points.forEach((p) => {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    });
    // Single-point dot: expand bounds by stroke radius so it's selectable
    if (shape.points.length === 1) {
      const r = shape.width || 4;
      minX -= r; minY -= r;
      maxX += r; maxY += r;
    }
  } else if (shape.type === "text") {
    if (!shape.w || !shape.h) {
      ctx.save();
      ctx.font = `${shape.fontSize}px ${shape.fontFamily || "sans-serif"}`;
      const rawLines = shape.text.split("\n");
      const lineHeight = shape.fontSize * 1.2;

      if (shape.textWidth) {
        // Word-wrap to compute height within fixed width
        let wrappedLineCount = 0;
        rawLines.forEach((rawLine) => {
          if (rawLine.length === 0) { wrappedLineCount++; return; }
          const words = rawLine.split(/(\s+)/);
          let currentLine = "";
          for (let i = 0; i < words.length; i++) {
            const word = words[i];
            const testLine = currentLine + word;
            const metrics = ctx.measureText(testLine);
            if (metrics.width > shape.textWidth && currentLine.length > 0) {
              wrappedLineCount++;
              currentLine = word.trimStart();
            } else {
              currentLine = testLine;
            }
            // Break long words that exceed textWidth by themselves
            while (ctx.measureText(currentLine).width > shape.textWidth && currentLine.length > 1) {
              let breakAt = currentLine.length - 1;
              for (let c = 1; c < currentLine.length; c++) {
                if (ctx.measureText(currentLine.slice(0, c + 1)).width > shape.textWidth) {
                  breakAt = c;
                  break;
                }
              }
              wrappedLineCount++;
              currentLine = currentLine.slice(breakAt);
            }
          }
          wrappedLineCount++;
        });
        shape.w = shape.textWidth;
        shape.h = lineHeight * (wrappedLineCount - 1) + shape.fontSize;
      } else {
        let maxWidth = 0;
        if (shape.segments && shape.segments.length > 0) {
          // Measure per-line using segment fonts for accurate bold widths
          const lineWidths = [];
          shape.segments.forEach((seg) => {
            while (lineWidths.length <= seg.line) lineWidths.push(0);
            const prefix = (seg.bold ? "bold " : "") + (seg.italic ? "italic " : "");
            const segSize = seg.fontSize || shape.fontSize;
            ctx.font = `${prefix}${segSize}px ${shape.fontFamily || "sans-serif"}`;
            lineWidths[seg.line] += ctx.measureText(seg.text).width;
          });
          lineWidths.forEach((w) => { if (w > maxWidth) maxWidth = w; });
        } else {
          rawLines.forEach((line) => {
            const metrics = ctx.measureText(line);
            if (metrics.width > maxWidth) maxWidth = metrics.width;
          });
        }
        shape.w = maxWidth;
        shape.h = lineHeight * (rawLines.length - 1) + shape.fontSize;
      }
      ctx.restore();
    }
    const padding = shape.bgColor ? shape.fontSize * 0.4 : 0;
    minX = shape.start.x - padding;
    minY = shape.start.y - padding;
    maxX = shape.start.x + shape.w + padding;
    maxY = shape.start.y + shape.h + padding;
  } else {
    minX = Math.min(shape.start.x, shape.end.x);
    minY = Math.min(shape.start.y, shape.end.y);
    maxX = Math.max(shape.start.x, shape.end.x);
    maxY = Math.max(shape.start.y, shape.end.y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY, maxX, maxY };
}

export function isPointHittingShape(p, shape) {
  const threshold = 12 / state.transform.zoom;
  if (shape.type === "pen") {
    // Single-point dot: hit test against the dot circle
    if (shape.points.length === 1) {
      const pt = shape.points[0];
      const radius = (shape.width || 4) / state.transform.zoom;
      const dx = p.x - pt.x;
      const dy = p.y - pt.y;
      return Math.sqrt(dx * dx + dy * dy) < radius + threshold;
    }
    for (let i = 0; i < shape.points.length - 1; i++) {
      if (getPtToSegmentDist(p, shape.points[i], shape.points[i + 1]) < threshold)
        return true;
    }
  } else if (shape.type === "line" || shape.type === "arrow" || shape.type === "measure" || shape.type === "connector" || shape.type === "contrast-line") {
    return getPtToSegmentDist(p, shape.start, shape.end) < threshold;
  } else if (shape.type === "rect-border" || shape.type === "rect-fill") {
    const b = getShapeBounds(shape);
    if (shape.type === "rect-fill") {
      return p.x >= b.x && p.x <= b.maxX && p.y >= b.y && p.y <= b.maxY;
    } else {
      const top = getPtToSegmentDist(p, { x: b.x, y: b.y }, { x: b.maxX, y: b.y }) < threshold;
      const bot = getPtToSegmentDist(p, { x: b.x, y: b.maxY }, { x: b.maxX, y: b.maxY }) < threshold;
      const lft = getPtToSegmentDist(p, { x: b.x, y: b.y }, { x: b.x, y: b.maxY }) < threshold;
      const rgt = getPtToSegmentDist(p, { x: b.maxX, y: b.y }, { x: b.maxX, y: b.maxY }) < threshold;
      return top || bot || lft || rgt;
    }
  } else if (shape.type === "text") {
    const b = getShapeBounds(shape);
    return p.x >= b.x && p.x <= b.maxX && p.y >= b.y && p.y <= b.maxY;
  }
  return false;
}

export function getElementResizeHandles(el) {
  if (el.type === "connector" || el.type === "line" || el.type === "arrow" || el.type === "measure") {
    return [
      { x: el.start.x, y: el.start.y, cursor: "move", position: "start" },
      { x: el.end.x, y: el.end.y, cursor: "move", position: "end" },
    ];
  }
  let b;
  if (el.elementType === "image") {
    b = { x: el.x, y: el.y, w: el.w, h: el.h, maxX: el.x + el.w, maxY: el.y + el.h };
  } else {
    b = getShapeBounds(el);
  }
  return [
    { x: b.x, y: b.y, cursor: "nwse-resize", position: "tl" },
    { x: b.x + b.w, y: b.y, cursor: "nesw-resize", position: "tr" },
    { x: b.x, y: b.y + b.h, cursor: "nesw-resize", position: "bl" },
    { x: b.x + b.w, y: b.y + b.h, cursor: "nwse-resize", position: "br" },
  ];
}

export function getElementCenter(el) {
  if (el.elementType === "image") {
    return { x: el.x + el.w / 2, y: el.y + el.h / 2 };
  }
  const b = getShapeBounds(el);
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

export function getElementBounds(el) {
  if (el.elementType === "image") {
    return { x: el.x, y: el.y, w: el.w, h: el.h };
  }
  return getShapeBounds(el);
}

export function getSwapHandleRadius() {
  return 14 / state.transform.zoom;
}

export function isPointOnSwapHandle(worldPos, element) {
  const center = getElementCenter(element);
  const radius = getSwapHandleRadius();
  const dx = worldPos.x - center.x;
  const dy = worldPos.y - center.y;
  return dx * dx + dy * dy <= radius * radius;
}

// Threshold below which linear iteration is faster than spatial index overhead
const SPATIAL_HIT_THRESHOLD = 50;

export function getElementAtWorldPos(worldPos, excludeElement) {
  const totalElements = state.images.length + state.drawings.length;

  if (totalElements > SPATIAL_HIT_THRESHOLD) {
    // Use spatial index to narrow candidates for large element counts.
    const hitRadius = 12 / state.transform.zoom;
    const excludeIds = excludeElement ? new Set([excludeElement.id]) : undefined;
    const candidates = spatialIndex.queryPoint(worldPos.x, worldPos.y, hitRadius, excludeIds);

    // Respect unified z-order: highest in elementOrder wins.
    let hitElement = null;
    let hitOrderIdx = -1;

    for (const el of candidates) {
      let isHit = false;
      if (el.elementType === "image") {
        isHit = worldPos.x >= el.x && worldPos.x <= el.x + el.w &&
                worldPos.y >= el.y && worldPos.y <= el.y + el.h;
      } else {
        isHit = isPointHittingShape(worldPos, el) || isPointOnMeasureLabel(worldPos, el);
      }
      if (isHit) {
        const idx = state.elementOrder.indexOf(el.id);
        if (idx > hitOrderIdx) { hitElement = el; hitOrderIdx = idx; }
      }
    }

    return hitElement;
  }

  // Direct iteration for small element counts — iterate elementOrder in reverse (top to bottom)
  for (let i = state.elementOrder.length - 1; i >= 0; i--) {
    const id = state.elementOrder[i];
    const el = findElementById(id);
    if (!el) continue;
    if (excludeElement && el.id === excludeElement.id) continue;
    if (el.elementType === "image") {
      if (worldPos.x >= el.x && worldPos.x <= el.x + el.w &&
          worldPos.y >= el.y && worldPos.y <= el.y + el.h) {
        return el;
      }
    } else {
      if (isPointHittingShape(worldPos, el) || isPointOnMeasureLabel(worldPos, el)) {
        return el;
      }
    }
  }
  return null;
}

export function findElementById(id) {
  for (let i = 0; i < state.drawings.length; i++) {
    if (state.drawings[i].id === id) return state.drawings[i];
  }
  for (let i = 0; i < state.images.length; i++) {
    if (state.images[i].id === id) return state.images[i];
  }
  return null;
}

export function translateElement(el, shiftX, shiftY) {
  if (el.elementType === "image") {
    el.x += shiftX;
    el.y += shiftY;
  } else if (el.type === "pen") {
    el.points.forEach((p) => {
      p.x += shiftX;
      p.y += shiftY;
    });
  } else {
    el.start.x += shiftX;
    el.start.y += shiftY;
    if (el.end) {
      el.end.x += shiftX;
      el.end.y += shiftY;
    }
  }
}

export function cloneElement(el) {
  if (el.elementType === "image") {
    const c = {
      id: el.id,
      elementType: "image",
      img: el.img,
      x: el.x, y: el.y, w: el.w, h: el.h,
      opacity: el.opacity != null ? el.opacity : 1,
    };
    if (el.groupId) c.groupId = el.groupId;
    if (el.locked) c.locked = true;
    if (el.crop) c.crop = { ...el.crop };
    if (el.fullBounds) c.fullBounds = { ...el.fullBounds };
    return c;
  }
  const clone = {
    id: el.id,
    elementType: el.elementType,
    type: el.type,
    color: el.color,
    width: el.width,
    opacity: el.opacity != null ? el.opacity : 1,
  };
  if (el.groupId) clone.groupId = el.groupId;
  if (el.locked) clone.locked = true;
  if (el.dash) clone.dash = el.dash;
  if (el.type === "pen") {
    clone.points = el.points.map((p) => ({ x: p.x, y: p.y }));
  } else if (el.type === "text") {
    clone.text = el.text;
    clone.fontSize = el.fontSize;
    clone.fontFamily = el.fontFamily;
    clone.start = { x: el.start.x, y: el.start.y };
    if (el.w) clone.w = el.w;
    if (el.h) clone.h = el.h;
    if (el.bgColor) clone.bgColor = el.bgColor;
    if (el.bgBorder) clone.bgBorder = el.bgBorder;
    if (el.textAlign) clone.textAlign = el.textAlign;
    if (el.textWidth) clone.textWidth = el.textWidth;
    if (el.segments) clone.segments = el.segments.map((s) => ({ ...s }));
  } else {
    clone.start = { x: el.start.x, y: el.start.y };
    if (el.end) clone.end = { x: el.end.x, y: el.end.y };
    if (el.type === "connector") {
      clone.startConn = el.startConn ? { ...el.startConn } : null;
      clone.endConn = el.endConn ? { ...el.endConn } : null;
    }
  }
  return clone;
}

export function serializeElement(el) {
  if (el.elementType === "image") {
    const serialized = {
      id: el.id, elementType: "image", img: el.img,
      x: el.x, y: el.y, w: el.w, h: el.h,
      groupId: el.groupId || null,
      opacity: el.opacity != null ? el.opacity : 1,
      locked: el.locked || false,
    };
    if (el.crop) serialized.crop = { ...el.crop };
    if (el.fullBounds) serialized.fullBounds = { ...el.fullBounds };
    return serialized;
  }
  const clone = {
    id: el.id, elementType: el.elementType,
    type: el.type, color: el.color, width: el.width,
    groupId: el.groupId || null,
    opacity: el.opacity != null ? el.opacity : 1,
    locked: el.locked || false,
  };
  if (el.dash) clone.dash = el.dash;
  if (el.type === "pen") {
    clone.points = el.points.map((p) => ({ x: p.x, y: p.y }));
  } else if (el.type === "text") {
    clone.text = el.text;
    clone.fontSize = el.fontSize;
    clone.fontFamily = el.fontFamily;
    clone.start = { x: el.start.x, y: el.start.y };
    if (el.w) clone.w = el.w;
    if (el.h) clone.h = el.h;
    if (el.bgColor) clone.bgColor = el.bgColor;
    if (el.bgBorder) clone.bgBorder = el.bgBorder;
    if (el.textAlign) clone.textAlign = el.textAlign;
    if (el.textWidth) clone.textWidth = el.textWidth;
    if (el.segments) clone.segments = el.segments.map((s) => ({ ...s }));
  } else {
    clone.start = { x: el.start.x, y: el.start.y };
    if (el.end) clone.end = { x: el.end.x, y: el.end.y };
    if (el.type === "connector") {
      clone.startConn = el.startConn ? { ...el.startConn } : null;
      clone.endConn = el.endConn ? { ...el.endConn } : null;
    }
  }
  return clone;
}
