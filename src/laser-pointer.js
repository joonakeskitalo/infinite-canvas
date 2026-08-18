/**
 * Laser Pointer Tool
 *
 * Provides a visual laser pointer that renders dots (click) and freeform
 * pen strokes (drag). Lines persist on screen until the user presses Escape
 * or switches to a different tool, at which point all laser marks are cleared.
 * None of these marks are persisted or added to undo history.
 */

import { state } from "./state.js";

let _renderFn = null;

/**
 * Wire up the render function dependency.
 */
export function setLaserRenderFn(fn) {
  _renderFn = fn;
}

/**
 * Add a dot at a world-space position.
 */
export function addLaserDot(worldX, worldY) {
  state.laserTrails.push({
    type: "dot",
    x: worldX,
    y: worldY,
    color: state.laserColor,
    width: state.laserWidth,
  });
  if (_renderFn) _renderFn();
}

/**
 * Begin a freeform laser stroke at a world-space position.
 */
export function startLaserStroke(worldPos) {
  state.laserActiveStroke = {
    type: "stroke",
    points: [worldPos],
    color: state.laserColor,
    width: state.laserWidth,
  };
}

/**
 * Extend the current laser stroke with a new point.
 * Applies input smoothing by averaging with the previous point to reduce jitter.
 */
export function extendLaserStroke(worldPos) {
  if (!state.laserActiveStroke) return;
  const pts = state.laserActiveStroke.points;
  if (pts.length > 0) {
    const prev = pts[pts.length - 1];
    // Moving average: blend 60% new position, 40% previous for smoother input
    const smoothed = {
      x: worldPos.x * 0.6 + prev.x * 0.4,
      y: worldPos.y * 0.6 + prev.y * 0.4,
    };
    // Skip points that are too close together
    const dx = smoothed.x - prev.x;
    const dy = smoothed.y - prev.y;
    if (dx * dx + dy * dy < 1) return;
    pts.push(smoothed);
  } else {
    pts.push(worldPos);
  }
}

/**
 * Finish the current laser stroke and push it to the trails array.
 * Applies Chaikin's corner-cutting algorithm for extra smoothness.
 */
export function finishLaserStroke() {
  if (!state.laserActiveStroke) return;
  // Only keep strokes with at least 2 points; single-point strokes become dots
  if (state.laserActiveStroke.points.length < 2) {
    const p = state.laserActiveStroke.points[0];
    addLaserDot(p.x, p.y);
  } else {
    // Apply Chaikin smoothing (2 iterations) for a polished curve
    state.laserActiveStroke.points = chaikinSmooth(state.laserActiveStroke.points, 2);
    state.laserTrails.push(state.laserActiveStroke);
  }
  state.laserActiveStroke = null;
  if (_renderFn) _renderFn();
}

/**
 * Clear all laser trails and the active stroke.
 * Called on Escape or when switching away from the laser tool.
 */
export function clearLaserTrails() {
  state.laserTrails = [];
  state.laserActiveStroke = null;
  if (_renderFn) _renderFn();
}

/**
 * Chaikin's corner-cutting subdivision algorithm.
 * Each iteration replaces each segment with two new points at 25% and 75%,
 * producing progressively smoother curves.
 */
function chaikinSmooth(points, iterations) {
  if (points.length < 3) return points;
  let pts = points;
  for (let iter = 0; iter < iterations; iter++) {
    const smoothed = [pts[0]]; // Keep the first point
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i];
      const p1 = pts[i + 1];
      smoothed.push({
        x: p0.x * 0.75 + p1.x * 0.25,
        y: p0.y * 0.75 + p1.y * 0.25,
      });
      smoothed.push({
        x: p0.x * 0.25 + p1.x * 0.75,
        y: p0.y * 0.25 + p1.y * 0.75,
      });
    }
    smoothed.push(pts[pts.length - 1]); // Keep the last point
    pts = smoothed;
  }
  return pts;
}

/**
 * Render all laser trails and the active stroke onto the given canvas context.
 * Should be called within the world-space transform (after translate/scale).
 */
export function renderLaserTrails(ctx, zoom) {
  // Draw completed trails at full opacity
  for (const trail of state.laserTrails) {
    drawLaserMark(ctx, trail, 1, zoom);
  }

  // Draw active stroke
  if (state.laserActiveStroke) {
    drawLaserMark(ctx, state.laserActiveStroke, 1, zoom);
  }
}

/**
 * Draw a smooth path through points using quadratic bezier curves through midpoints.
 * This produces natural, fluid lines from raw mouse input.
 */
function drawSmoothPath(ctx, points) {
  if (points.length < 2) return;
  ctx.moveTo(points[0].x, points[0].y);
  if (points.length === 2) {
    ctx.lineTo(points[1].x, points[1].y);
    return;
  }
  // Use quadratic curves through midpoints for smooth interpolation
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
  }
  // Curve to the last point
  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
}

/**
 * Draw a single laser mark (dot or stroke).
 */
function drawLaserMark(ctx, mark, alpha, zoom) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (mark.type === "dot") {
    const radius = Math.max(mark.width * 1.5, 6) / zoom;
    // Glow effect
    ctx.shadowColor = mark.color;
    ctx.shadowBlur = 12 / zoom;
    ctx.fillStyle = mark.color;
    ctx.beginPath();
    ctx.arc(mark.x, mark.y, radius, 0, Math.PI * 2);
    ctx.fill();
    // Bright center
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#ffffff";
    ctx.globalAlpha = alpha * 0.7;
    ctx.beginPath();
    ctx.arc(mark.x, mark.y, radius * 0.4, 0, Math.PI * 2);
    ctx.fill();
  } else if (mark.type === "stroke" && mark.points.length >= 2) {
    const lineWidth = mark.width / zoom;
    // Glow effect
    ctx.shadowColor = mark.color;
    ctx.shadowBlur = 8 / zoom;
    ctx.strokeStyle = mark.color;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    drawSmoothPath(ctx, mark.points);
    ctx.stroke();
    // Brighter thin center line
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "#ffffff";
    ctx.globalAlpha = alpha * 0.5;
    ctx.lineWidth = lineWidth * 0.3;
    ctx.beginPath();
    drawSmoothPath(ctx, mark.points);
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Check if there are any active laser visuals that need rendering.
 */
export function hasLaserVisuals() {
  return state.laserTrails.length > 0 || state.laserActiveStroke !== null;
}
