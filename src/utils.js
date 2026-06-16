/**
 * Utility Functions
 *
 * Pure helpers for coordinate transforms, geometry, and math.
 */

import { state } from "./state.js";

// --- Platform detection ---
export const isMacPlatform = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

export function formatShortcut(shortcutStr) {
  const parts = shortcutStr.split("+");
  return parts.map((part) => {
    const lower = part.toLowerCase();
    if (lower === "mod") return isMacPlatform ? "⌘" : "Ctrl+";
    if (lower === "shift") return isMacPlatform ? "⇧" : "Shift+";
    if (lower === "alt") return isMacPlatform ? "⌥" : "Alt+";
    return part;
  }).join("");
}

// --- Coordinate transforms ---
export function screenToWorld(sx, sy) {
  return {
    x: (sx - state.transform.x) / state.transform.zoom,
    y: (sy - state.transform.y) / state.transform.zoom,
  };
}

export function worldToScreen(wx, wy) {
  return {
    x: wx * state.transform.zoom + state.transform.x,
    y: wy * state.transform.zoom + state.transform.y,
  };
}

// --- Geometry helpers ---
export function snapToGrid(val, gridSize) {
  return Math.round(val / gridSize) * gridSize;
}

export function constraintToAngle(start, current) {
  const dx = current.x - start.x;
  const dy = current.y - start.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  let angle = Math.atan2(dy, dx);
  angle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
  return {
    x: start.x + distance * Math.cos(angle),
    y: start.y + distance * Math.sin(angle),
  };
}

export function getPtToSegmentDist(p, a, b) {
  const l2 = Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2);
  if (l2 === 0)
    return Math.sqrt(Math.pow(p.x - a.x, 2) + Math.pow(p.y - a.y, 2));
  let t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.sqrt(
    Math.pow(p.x - (a.x + t * (b.x - a.x)), 2) +
      Math.pow(p.y - (a.y + t * (b.y - a.y)), 2),
  );
}

// --- Viewport culling ---
export function getViewportBounds() {
  const pad = 100 / state.transform.zoom;
  const canvas = document.getElementById("canvas");
  return {
    minX: -state.transform.x / state.transform.zoom - pad,
    minY: -state.transform.y / state.transform.zoom - pad,
    maxX: (-state.transform.x + canvas.width) / state.transform.zoom + pad,
    maxY: (-state.transform.y + canvas.height) / state.transform.zoom + pad,
  };
}

export function isRectInViewport(x, y, w, h, vp) {
  return !(x + w < vp.minX || x > vp.maxX || y + h < vp.minY || y > vp.maxY);
}

// --- Toast ---
export function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.style.display = "block";
  setTimeout(() => (toast.style.display = "none"), 2500);
}
