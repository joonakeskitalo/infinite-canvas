/**
 * Bézier Pen Tool
 *
 * A precision vector drawing instrument for creating paths with anchor points
 * and control handles (direction handles). Supports straight lines, smooth
 * Bézier curves, and path editing.
 *
 * Data structure for a bezier-path element:
 * {
 *   id: "draw_N",
 *   elementType: "drawing",
 *   type: "bezier-path",
 *   color: "#ff4444",
 *   width: 4,
 *   opacity: 1,
 *   closed: false,
 *   points: [
 *     { x, y, cx1, cy1, cx2, cy2 }  // anchor + in-handle (cx1,cy1) + out-handle (cx2,cy2)
 *   ]
 * }
 *
 * cx1/cy1 = incoming control handle (controls curve arriving at this point)
 * cx2/cy2 = outgoing control handle (controls curve leaving this point)
 * For the first point, cx1/cy1 are unused.
 * For the last point (open path), cx2/cy2 are unused.
 */

import { state, CONSTANTS, spatialInsert, spatialUpdate, spatialRemove } from "./state.js";
import { screenToWorld } from "./utils.js";
import { pushUndo } from "./history.js";

// Forward deps set from main/interaction
let _render = null;
let _scheduleSave = null;
let _toggleAlignmentPanelVisibility = null;

export function setBezierPenDeps({ render, scheduleSave, toggleAlignmentPanelVisibility }) {
  _render = render;
  _scheduleSave = scheduleSave;
  _toggleAlignmentPanelVisibility = toggleAlignmentPanelVisibility;
}

// --- Constants ---
const HANDLE_RADIUS = 5;      // screen pixels
const ANCHOR_RADIUS = 5;      // screen pixels
const CLOSE_THRESHOLD = 10;   // screen pixels — distance to snap to first point to close path
const HIT_THRESHOLD = 8;      // screen pixels for handle/point hit detection

// --- Helper: distance in screen space ---
function screenDist(a, b, zoom) {
  const dx = (a.x - b.x) * zoom;
  const dy = (a.y - b.y) * zoom;
  return Math.sqrt(dx * dx + dy * dy);
}

// --- Helper: reflect a handle across anchor ---
function reflectHandle(anchor, handle) {
  return {
    x: 2 * anchor.x - handle.x,
    y: 2 * anchor.y - handle.y,
  };
}

// --- Create a new anchor point at worldPos ---
function createAnchorPoint(x, y) {
  return { x, y, cx1: x, cy1: y, cx2: x, cy2: y };
}

// --- Public API ---

/**
 * Handle mousedown for the bezier-pen tool.
 * Click to place points, drag to adjust handles.
 */
export function bezierPenMouseDown(e, worldPos) {
  const zoom = state.transform.zoom;

  // If we're editing an existing committed path, handle editing
  if (state.bezierEditingPath) {
    const editResult = handleEditMouseDown(worldPos, zoom);
    if (editResult) return;
  }

  // Check if clicking near the first point to close the path
  if (state.bezierPath && state.bezierPath.points.length >= 2) {
    const firstPt = state.bezierPath.points[0];
    if (screenDist(worldPos, firstPt, zoom) < CLOSE_THRESHOLD) {
      closePath();
      return;
    }
  }

  // If no path in progress, start a new one
  if (!state.bezierPath) {
    state.bezierPath = {
      id: "draw_" + state.elementIdCounter++,
      elementType: "drawing",
      type: "bezier-path",
      color: state.drawColor,
      width: state.currentLineWidth,
      fillColor: state.bezierFillColor || null,
      opacity: 1,
      closed: false,
      points: [createAnchorPoint(worldPos.x, worldPos.y)],
    };
    state.bezierDragging = true;
    if (_render) _render();
    return;
  }

  // Add a new point to the path
  const newPt = createAnchorPoint(worldPos.x, worldPos.y);
  state.bezierPath.points.push(newPt);
  state.bezierDragging = true;
  if (_render) _render();
}

/**
 * Handle mousemove for the bezier-pen tool.
 * If dragging after placing a point, adjust the control handles.
 */
export function bezierPenMouseMove(e, worldPos) {
  const zoom = state.transform.zoom;

  // Handle editing mode
  if (state.bezierEditingPath && state.bezierDragging) {
    handleEditMouseMove(worldPos);
    return;
  }

  // Not currently building a path — update hover state for visual feedback
  if (!state.bezierPath) {
    updateHoverState(worldPos, zoom);
    return;
  }

  // Dragging to create control handles on the current point
  if (state.bezierDragging) {
    const points = state.bezierPath.points;
    const currentPt = points[points.length - 1];

    // Outgoing handle follows the mouse
    currentPt.cx2 = worldPos.x;
    currentPt.cy2 = worldPos.y;

    // Incoming handle is reflected (smooth point)
    const reflected = reflectHandle(currentPt, { x: worldPos.x, y: worldPos.y });
    currentPt.cx1 = reflected.x;
    currentPt.cy1 = reflected.y;

    if (_render) _render();
    return;
  }

  // Not dragging — show preview of next segment (cursor position)
  if (_render) _render();
}

/**
 * Handle mouseup for the bezier-pen tool.
 */
export function bezierPenMouseUp(e, worldPos) {
  if (state.bezierEditingPath && state.bezierDragging) {
    handleEditMouseUp();
    return;
  }

  state.bezierDragging = false;
}

/**
 * Handle double-click to finish the current path (open path).
 */
export function bezierPenDoubleClick(e, worldPos) {
  if (state.bezierEditingPath) {
    // Double-click on a committed path enters/exits editing
    exitBezierEdit();
    return;
  }
  finishPath();
}

/**
 * Handle keydown events for the bezier-pen tool.
 * Escape: cancel/finish path. Enter: finish path. Backspace: delete last point.
 */
export function bezierPenKeyDown(e) {
  if (e.key === "Escape") {
    if (state.bezierEditingPath) {
      exitBezierEdit();
      return true;
    }
    if (state.bezierPath) {
      if (state.bezierPath.points.length <= 1) {
        // Cancel - too few points for a valid path
        state.bezierPath = null;
        state.bezierDragging = false;
        if (_render) _render();
      } else {
        finishPath();
      }
      return true;
    }
    return false;
  }

  if (e.key === "Enter") {
    if (state.bezierPath && state.bezierPath.points.length >= 2) {
      finishPath();
      return true;
    }
    return false;
  }

  if (e.key === "Backspace" || e.key === "Delete") {
    if (state.bezierEditingPath && state.bezierSelectedPoint >= 0) {
      deleteSelectedPoint();
      return true;
    }
    if (state.bezierPath && state.bezierPath.points.length > 1) {
      state.bezierPath.points.pop();
      state.bezierDragging = false;
      if (_render) _render();
      return true;
    }
    if (state.bezierPath && state.bezierPath.points.length === 1) {
      state.bezierPath = null;
      state.bezierDragging = false;
      if (_render) _render();
      return true;
    }
    return false;
  }

  return false;
}

/**
 * Close the current path by connecting back to the first point.
 */
function closePath() {
  if (!state.bezierPath || state.bezierPath.points.length < 2) return;
  state.bezierPath.closed = true;
  commitPath();
}

/**
 * Finish the open path and commit it.
 */
function finishPath() {
  if (!state.bezierPath || state.bezierPath.points.length < 2) {
    state.bezierPath = null;
    state.bezierDragging = false;
    if (_render) _render();
    return;
  }
  commitPath();
}

/**
 * Commit the current path to state.drawings.
 */
function commitPath() {
  pushUndo();
  state.drawings.push(state.bezierPath);
  spatialInsert(state.bezierPath);
  state.bezierPath = null;
  state.bezierDragging = false;
  state.bezierHoverPoint = -1;
  if (_render) _render();
  if (_scheduleSave) _scheduleSave();
}

/**
 * Enter edit mode for an existing bezier-path element.
 */
export function enterBezierEdit(element) {
  if (element.type !== "bezier-path") return;
  state.bezierEditingPath = element;
  state.bezierSelectedPoint = -1;
  state.bezierHoverPoint = -1;
  if (_render) _render();
}

/**
 * Exit bezier path editing mode.
 */
export function exitBezierEdit() {
  if (state.bezierEditingPath) {
    spatialUpdate(state.bezierEditingPath);
  }
  state.bezierEditingPath = null;
  state.bezierSelectedPoint = -1;
  state.bezierHoverPoint = -1;
  state.bezierDragging = false;
  if (_render) _render();
  if (_scheduleSave) _scheduleSave();
}

// --- Edit mode: point/handle dragging ---

let _editDragType = null;  // "anchor" | "cx1" | "cx2"
let _editDragIndex = -1;

function handleEditMouseDown(worldPos, zoom) {
  const path = state.bezierEditingPath;
  if (!path) return false;

  // Check if clicking on a control handle of the selected point
  if (state.bezierSelectedPoint >= 0) {
    const pt = path.points[state.bezierSelectedPoint];
    if (screenDist(worldPos, { x: pt.cx1, y: pt.cy1 }, zoom) < HIT_THRESHOLD) {
      _editDragType = "cx1";
      _editDragIndex = state.bezierSelectedPoint;
      state.bezierDragging = true;
      pushUndo();
      return true;
    }
    if (screenDist(worldPos, { x: pt.cx2, y: pt.cy2 }, zoom) < HIT_THRESHOLD) {
      _editDragType = "cx2";
      _editDragIndex = state.bezierSelectedPoint;
      state.bezierDragging = true;
      pushUndo();
      return true;
    }
  }

  // Check if clicking on any anchor point
  for (let i = 0; i < path.points.length; i++) {
    const pt = path.points[i];
    if (screenDist(worldPos, pt, zoom) < HIT_THRESHOLD) {
      state.bezierSelectedPoint = i;
      _editDragType = "anchor";
      _editDragIndex = i;
      state.bezierDragging = true;
      pushUndo();
      if (_render) _render();
      return true;
    }
  }

  // Check handles of all points (not just selected)
  for (let i = 0; i < path.points.length; i++) {
    const pt = path.points[i];
    if (screenDist(worldPos, { x: pt.cx1, y: pt.cy1 }, zoom) < HIT_THRESHOLD) {
      state.bezierSelectedPoint = i;
      _editDragType = "cx1";
      _editDragIndex = i;
      state.bezierDragging = true;
      pushUndo();
      if (_render) _render();
      return true;
    }
    if (screenDist(worldPos, { x: pt.cx2, y: pt.cy2 }, zoom) < HIT_THRESHOLD) {
      state.bezierSelectedPoint = i;
      _editDragType = "cx2";
      _editDragIndex = i;
      state.bezierDragging = true;
      pushUndo();
      if (_render) _render();
      return true;
    }
  }

  // Clicked empty space — deselect
  state.bezierSelectedPoint = -1;
  if (_render) _render();
  return false;
}

function handleEditMouseMove(worldPos) {
  const path = state.bezierEditingPath;
  if (!path || _editDragIndex < 0) return;

  const pt = path.points[_editDragIndex];

  if (_editDragType === "anchor") {
    const dx = worldPos.x - pt.x;
    const dy = worldPos.y - pt.y;
    pt.x = worldPos.x;
    pt.y = worldPos.y;
    pt.cx1 += dx;
    pt.cy1 += dy;
    pt.cx2 += dx;
    pt.cy2 += dy;
  } else if (_editDragType === "cx1") {
    pt.cx1 = worldPos.x;
    pt.cy1 = worldPos.y;
    // If not holding Alt, mirror the opposite handle for smooth curves
    if (!state.isMetaPressed) {
      const reflected = reflectHandle(pt, { x: worldPos.x, y: worldPos.y });
      pt.cx2 = reflected.x;
      pt.cy2 = reflected.y;
    }
  } else if (_editDragType === "cx2") {
    pt.cx2 = worldPos.x;
    pt.cy2 = worldPos.y;
    // If not holding Alt, mirror the opposite handle for smooth curves
    if (!state.isMetaPressed) {
      const reflected = reflectHandle(pt, { x: worldPos.x, y: worldPos.y });
      pt.cx1 = reflected.x;
      pt.cy1 = reflected.y;
    }
  }

  if (_render) _render();
}

function handleEditMouseUp() {
  state.bezierDragging = false;
  _editDragType = null;
  _editDragIndex = -1;
  if (state.bezierEditingPath) {
    spatialUpdate(state.bezierEditingPath);
  }
  if (_scheduleSave) _scheduleSave();
}

/**
 * Delete the currently selected point from the editing path.
 */
function deleteSelectedPoint() {
  const path = state.bezierEditingPath;
  if (!path || state.bezierSelectedPoint < 0) return;

  pushUndo();
  path.points.splice(state.bezierSelectedPoint, 1);

  if (path.points.length < 2) {
    // Path is no longer valid — remove it
    const idx = state.drawings.indexOf(path);
    if (idx >= 0) {
      spatialRemove(path);
      state.drawings.splice(idx, 1);
    }
    exitBezierEdit();
    return;
  }

  state.bezierSelectedPoint = Math.min(state.bezierSelectedPoint, path.points.length - 1);
  spatialUpdate(path);
  if (_render) _render();
  if (_scheduleSave) _scheduleSave();
}

/**
 * Update hover state for visual feedback when not building a path.
 */
function updateHoverState(worldPos, zoom) {
  // Check committed bezier paths for hover feedback
  for (let i = state.drawings.length - 1; i >= 0; i--) {
    const shape = state.drawings[i];
    if (shape.type !== "bezier-path") continue;
    for (let j = 0; j < shape.points.length; j++) {
      if (screenDist(worldPos, shape.points[j], zoom) < HIT_THRESHOLD) {
        if (state.bezierHoverPoint !== j) {
          state.bezierHoverPoint = j;
          if (_render) _render();
        }
        return;
      }
    }
  }
  if (state.bezierHoverPoint !== -1) {
    state.bezierHoverPoint = -1;
    if (_render) _render();
  }
}

// --- Rendering helpers (called from rendering.js) ---

/**
 * Draw a bezier-path shape (committed or in-progress).
 */
export function drawBezierPath(ctx, shape, isExporting, zoom) {
  const points = shape.points;
  if (points.length < 1) return;

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    ctx.bezierCurveTo(prev.cx2, prev.cy2, curr.cx1, curr.cy1, curr.x, curr.y);
  }

  if (shape.closed && points.length >= 2) {
    const last = points[points.length - 1];
    const first = points[0];
    ctx.bezierCurveTo(last.cx2, last.cy2, first.cx1, first.cy1, first.x, first.y);
    ctx.closePath();
  }

  // Fill if fillColor is set
  if (shape.fillColor) {
    ctx.save();
    ctx.fillStyle = shape.fillColor;
    ctx.fill();
    ctx.restore();
  }

  ctx.stroke();
}

/**
 * Render the in-progress path preview including the segment from the last point
 * to the current mouse position.
 */
export function renderBezierPreview(ctx, zoom) {
  const path = state.bezierPath;
  if (!path || path.points.length === 0) return;

  const points = path.points;

  // Draw the committed segments
  ctx.save();
  ctx.strokeStyle = path.color;
  ctx.lineWidth = path.width / zoom;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (points.length >= 2) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      ctx.bezierCurveTo(prev.cx2, prev.cy2, curr.cx1, curr.cy1, curr.x, curr.y);
    }
    ctx.stroke();
  }

  // Draw anchor points
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const r = ANCHOR_RADIUS / zoom;

    // Anchor square
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = path.color;
    ctx.lineWidth = 1.5 / zoom;
    ctx.fillRect(pt.x - r, pt.y - r, r * 2, r * 2);
    ctx.strokeRect(pt.x - r, pt.y - r, r * 2, r * 2);

    // Control handles (only show for last point while dragging, or all points)
    const showHandles = (i === points.length - 1 && state.bezierDragging) || points.length > 1;
    if (showHandles) {
      const hr = HANDLE_RADIUS / zoom;

      // Draw handle lines
      ctx.strokeStyle = "rgba(0, 120, 215, 0.7)";
      ctx.lineWidth = 1 / zoom;

      if (i > 0 || path.closed) {
        // cx1 handle (incoming)
        if (pt.cx1 !== pt.x || pt.cy1 !== pt.y) {
          ctx.beginPath();
          ctx.moveTo(pt.x, pt.y);
          ctx.lineTo(pt.cx1, pt.cy1);
          ctx.stroke();

          // Handle dot
          ctx.fillStyle = "#0078d7";
          ctx.beginPath();
          ctx.arc(pt.cx1, pt.cy1, hr * 0.7, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      if (i < points.length - 1 || path.closed) {
        // cx2 handle (outgoing)
        if (pt.cx2 !== pt.x || pt.cy2 !== pt.y) {
          ctx.beginPath();
          ctx.moveTo(pt.x, pt.y);
          ctx.lineTo(pt.cx2, pt.cy2);
          ctx.stroke();

          // Handle dot
          ctx.fillStyle = "#0078d7";
          ctx.beginPath();
          ctx.arc(pt.cx2, pt.cy2, hr * 0.7, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  // Draw close indicator when hovering near first point
  if (points.length >= 2) {
    const firstPt = points[0];
    const mouseWorld = screenToWorld(state.lastMousePos.x, state.lastMousePos.y);
    if (screenDist(mouseWorld, firstPt, zoom) < CLOSE_THRESHOLD) {
      const r = (ANCHOR_RADIUS + 3) / zoom;
      ctx.strokeStyle = path.color;
      ctx.lineWidth = 2 / zoom;
      ctx.beginPath();
      ctx.arc(firstPt.x, firstPt.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  ctx.restore();
}

/**
 * Render editing overlay for a committed path (control points and handles).
 */
export function renderBezierEditOverlay(ctx, zoom) {
  const path = state.bezierEditingPath;
  if (!path) return;

  const points = path.points;

  ctx.save();

  // Draw all control handles and anchor points
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const isSelected = i === state.bezierSelectedPoint;
    const r = ANCHOR_RADIUS / zoom;
    const hr = HANDLE_RADIUS / zoom;

    // Handle lines and dots
    ctx.lineWidth = 1 / zoom;
    ctx.strokeStyle = "rgba(0, 120, 215, 0.7)";

    // cx1 handle (incoming)
    if ((i > 0 || path.closed) && (pt.cx1 !== pt.x || pt.cy1 !== pt.y)) {
      ctx.beginPath();
      ctx.moveTo(pt.x, pt.y);
      ctx.lineTo(pt.cx1, pt.cy1);
      ctx.stroke();

      ctx.fillStyle = isSelected ? "#ff6600" : "#0078d7";
      ctx.beginPath();
      ctx.arc(pt.cx1, pt.cy1, hr * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }

    // cx2 handle (outgoing)
    if ((i < points.length - 1 || path.closed) && (pt.cx2 !== pt.x || pt.cy2 !== pt.y)) {
      ctx.beginPath();
      ctx.moveTo(pt.x, pt.y);
      ctx.lineTo(pt.cx2, pt.cy2);
      ctx.stroke();

      ctx.fillStyle = isSelected ? "#ff6600" : "#0078d7";
      ctx.beginPath();
      ctx.arc(pt.cx2, pt.cy2, hr * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }

    // Anchor point (filled square for selected, hollow for others)
    if (isSelected) {
      ctx.fillStyle = "#0078d7";
      ctx.fillRect(pt.x - r, pt.y - r, r * 2, r * 2);
    } else {
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#0078d7";
      ctx.lineWidth = 1.5 / zoom;
      ctx.fillRect(pt.x - r, pt.y - r, r * 2, r * 2);
      ctx.strokeRect(pt.x - r, pt.y - r, r * 2, r * 2);
    }
  }

  ctx.restore();
}

// --- Hit testing for bezier paths ---

/**
 * Sample points along a cubic Bézier segment and check distance.
 * Returns true if the point p is within threshold of the curve.
 */
export function isPointOnBezierSegment(p, p0, p1, threshold, steps = 32) {
  // p0 = {x, y, cx2, cy2}, p1 = {x, y, cx1, cy1}
  const ax = p0.x, ay = p0.y;
  const bx = p0.cx2, by = p0.cy2;
  const cx = p1.cx1, cy = p1.cy1;
  const dx = p1.x, dy = p1.y;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const mt2 = mt * mt;
    const mt3 = mt2 * mt;
    const t2 = t * t;
    const t3 = t2 * t;

    const x = mt3 * ax + 3 * mt2 * t * bx + 3 * mt * t2 * cx + t3 * dx;
    const y = mt3 * ay + 3 * mt2 * t * by + 3 * mt * t2 * cy + t3 * dy;

    const distSq = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
    if (distSq < threshold * threshold) return true;
  }
  return false;
}

/**
 * Check if a point hits a bezier-path shape.
 */
export function isPointHittingBezierPath(p, shape, threshold) {
  const points = shape.points;
  if (points.length < 2) return false;

  for (let i = 0; i < points.length - 1; i++) {
    if (isPointOnBezierSegment(p, points[i], points[i + 1], threshold)) {
      return true;
    }
  }

  if (shape.closed && points.length >= 2) {
    const last = points[points.length - 1];
    const first = points[0];
    if (isPointOnBezierSegment(p, last, first, threshold)) {
      return true;
    }
  }

  return false;
}

/**
 * Calculate bounding box for a bezier-path shape.
 * Uses control points as a conservative bound (slightly larger than tight).
 */
export function getBezierPathBounds(shape) {
  const points = shape.points;
  if (points.length === 0) return { x: 0, y: 0, w: 0, h: 0, maxX: 0, maxY: 0 };

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const pt of points) {
    // Include anchor
    if (pt.x < minX) minX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y > maxY) maxY = pt.y;

    // Include control handles
    if (pt.cx1 < minX) minX = pt.cx1;
    if (pt.cy1 < minY) minY = pt.cy1;
    if (pt.cx1 > maxX) maxX = pt.cx1;
    if (pt.cy1 > maxY) maxY = pt.cy1;

    if (pt.cx2 < minX) minX = pt.cx2;
    if (pt.cy2 < minY) minY = pt.cy2;
    if (pt.cx2 > maxX) maxX = pt.cx2;
    if (pt.cy2 > maxY) maxY = pt.cy2;
  }

  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY, maxX, maxY };
}

/**
 * Check if tool should be finalized when switching away.
 */
export function finalizeBezierPenIfNeeded() {
  if (state.bezierPath) {
    if (state.bezierPath.points.length >= 2) {
      commitPath();
    } else {
      state.bezierPath = null;
      state.bezierDragging = false;
    }
  }
  if (state.bezierEditingPath) {
    exitBezierEdit();
  }
}
