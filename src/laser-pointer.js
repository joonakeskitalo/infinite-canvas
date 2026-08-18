/**
 * Laser Pointer Tool
 *
 * Provides a temporary visual laser pointer that renders dots (click)
 * and freeform pen strokes (drag) which fade away after a short duration.
 * None of these marks are persisted or added to undo history.
 */

import { state } from "./state.js";

let _renderFn = null;
let _animFrameId = null;

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
    createdAt: performance.now(),
    opacity: 1,
  });
  startFadeLoop();
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
    createdAt: performance.now(),
    opacity: 1,
  };
}

/**
 * Extend the current laser stroke with a new point.
 */
export function extendLaserStroke(worldPos) {
  if (!state.laserActiveStroke) return;
  state.laserActiveStroke.points.push(worldPos);
}

/**
 * Finish the current laser stroke and push it to the trails array.
 */
export function finishLaserStroke() {
  if (!state.laserActiveStroke) return;
  // Only keep strokes with at least 2 points; single-point strokes become dots
  if (state.laserActiveStroke.points.length < 2) {
    const p = state.laserActiveStroke.points[0];
    addLaserDot(p.x, p.y);
  } else {
    state.laserActiveStroke.createdAt = performance.now();
    state.laserTrails.push(state.laserActiveStroke);
  }
  state.laserActiveStroke = null;
  startFadeLoop();
}

/**
 * Render all laser trails and the active stroke onto the given canvas context.
 * Should be called within the world-space transform (after translate/scale).
 */
export function renderLaserTrails(ctx, zoom) {
  const now = performance.now();
  const fadeDuration = state.laserFadeDuration;

  // Draw completed trails
  for (const trail of state.laserTrails) {
    const elapsed = now - trail.createdAt;
    const alpha = Math.max(0, 1 - elapsed / fadeDuration);
    if (alpha <= 0) continue;
    drawLaserMark(ctx, trail, alpha, zoom);
  }

  // Draw active stroke
  if (state.laserActiveStroke) {
    drawLaserMark(ctx, state.laserActiveStroke, 1, zoom);
  }
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
    ctx.moveTo(mark.points[0].x, mark.points[0].y);
    for (let i = 1; i < mark.points.length; i++) {
      ctx.lineTo(mark.points[i].x, mark.points[i].y);
    }
    ctx.stroke();
    // Brighter thin center line
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "#ffffff";
    ctx.globalAlpha = alpha * 0.5;
    ctx.lineWidth = lineWidth * 0.3;
    ctx.beginPath();
    ctx.moveTo(mark.points[0].x, mark.points[0].y);
    for (let i = 1; i < mark.points.length; i++) {
      ctx.lineTo(mark.points[i].x, mark.points[i].y);
    }
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Start the fade animation loop if not already running.
 */
function startFadeLoop() {
  if (state.laserAnimating) return;
  state.laserAnimating = true;
  fadeLoop();
}

/**
 * Animation loop that re-renders while trails exist and removes expired ones.
 */
function fadeLoop() {
  const now = performance.now();
  const fadeDuration = state.laserFadeDuration;

  // Remove fully faded trails
  state.laserTrails = state.laserTrails.filter(
    (trail) => now - trail.createdAt < fadeDuration
  );

  // If nothing left to animate, stop
  if (state.laserTrails.length === 0 && !state.laserActiveStroke) {
    state.laserAnimating = false;
    _animFrameId = null;
    // One final render to clear the last frame
    if (_renderFn) _renderFn();
    return;
  }

  // Re-render and continue loop
  if (_renderFn) _renderFn();
  _animFrameId = requestAnimationFrame(fadeLoop);
}

/**
 * Check if there are any active laser visuals that need rendering.
 */
export function hasLaserVisuals() {
  return state.laserTrails.length > 0 || state.laserActiveStroke !== null;
}
