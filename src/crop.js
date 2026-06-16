/**
 * Crop Mode
 *
 * Functions for entering/exiting crop mode and computing crop geometry.
 */

import { state } from "./state.js";
import { showToast } from "./utils.js";
import { pushUndo } from "./history.js";

// Forward declarations
let _render = null;
let _toggleAlignmentPanelVisibility = null;
let _scheduleSave = null;

export function setCropDeps({ render, toggleAlignmentPanelVisibility, scheduleSave }) {
  _render = render;
  _toggleAlignmentPanelVisibility = toggleAlignmentPanelVisibility;
  _scheduleSave = scheduleSave;
}

export function enterCropMode(imgElement) {
  state.cropMode = true;
  state.cropTarget = imgElement;

  if (imgElement.crop && imgElement.fullBounds) {
    const c = imgElement.crop;
    const fullW = imgElement.w / c.w;
    const fullH = imgElement.h / c.h;
    const fullX = imgElement.x - c.x * fullW;
    const fullY = imgElement.y - c.y * fullH;
    imgElement.fullBounds = { x: fullX, y: fullY, w: fullW, h: fullH };
    state.cropRect = { x: imgElement.x, y: imgElement.y, w: imgElement.w, h: imgElement.h };
  } else {
    state.cropRect = { x: imgElement.x, y: imgElement.y, w: imgElement.w, h: imgElement.h };
    imgElement.fullBounds = { x: imgElement.x, y: imgElement.y, w: imgElement.w, h: imgElement.h };
  }

  state.selectedElements = [imgElement];
  if (_toggleAlignmentPanelVisibility) _toggleAlignmentPanelVisibility();
  showToast("Crop mode — drag edges to crop, Enter to apply, Escape to cancel");
}

export function getFullImageBounds(imgElement) {
  if (imgElement.fullBounds) {
    return { ...imgElement.fullBounds };
  }
  return { x: imgElement.x, y: imgElement.y, w: imgElement.w, h: imgElement.h };
}

export function exitCropMode(apply) {
  if (!state.cropMode || !state.cropTarget) return;
  if (apply && state.cropRect) {
    const el = state.cropTarget;
    const full = getFullImageBounds(el);

    const fracX = Math.max(0, Math.min(1, (state.cropRect.x - full.x) / full.w));
    const fracY = Math.max(0, Math.min(1, (state.cropRect.y - full.y) / full.h));
    const fracW = Math.max(0.01, Math.min(1 - fracX, state.cropRect.w / full.w));
    const fracH = Math.max(0.01, Math.min(1 - fracY, state.cropRect.h / full.h));

    const isCropped = fracX > 0.001 || fracY > 0.001 || fracW < 0.999 || fracH < 0.999;

    pushUndo();

    if (isCropped) {
      el.crop = { x: fracX, y: fracY, w: fracW, h: fracH };
      if (!el.fullBounds) el.fullBounds = { ...full };
      el.x = state.cropRect.x;
      el.y = state.cropRect.y;
      el.w = state.cropRect.w;
      el.h = state.cropRect.h;
    } else {
      delete el.crop;
      el.x = full.x;
      el.y = full.y;
      el.w = full.w;
      el.h = full.h;
    }

    showToast(isCropped ? "Crop applied" : "Crop removed");
    if (_scheduleSave) _scheduleSave();
  }
  state.cropMode = false;
  state.cropTarget = null;
  state.cropRect = null;
  state.cropDragEdge = null;
  state.cropDragStart = null;
  if (_render) _render();
}

export function getCropEdgeAtPoint(worldPos) {
  if (!state.cropRect) return null;
  const threshold = 8 / state.transform.zoom;
  const r = state.cropRect;
  const left = r.x;
  const right = r.x + r.w;
  const top = r.y;
  const bottom = r.y + r.h;

  const nearLeft = Math.abs(worldPos.x - left) < threshold;
  const nearRight = Math.abs(worldPos.x - right) < threshold;
  const nearTop = Math.abs(worldPos.y - top) < threshold;
  const nearBottom = Math.abs(worldPos.y - bottom) < threshold;

  const withinX = worldPos.x >= left - threshold && worldPos.x <= right + threshold;
  const withinY = worldPos.y >= top - threshold && worldPos.y <= bottom + threshold;

  if (nearLeft && nearTop) return "nw";
  if (nearRight && nearTop) return "ne";
  if (nearLeft && nearBottom) return "sw";
  if (nearRight && nearBottom) return "se";
  if (nearTop && withinX) return "n";
  if (nearBottom && withinX) return "s";
  if (nearLeft && withinY) return "w";
  if (nearRight && withinY) return "e";

  return null;
}

export function getCropCursor(edge) {
  switch (edge) {
    case "n": case "s": return "ns-resize";
    case "e": case "w": return "ew-resize";
    case "nw": case "se": return "nwse-resize";
    case "ne": case "sw": return "nesw-resize";
    default: return "crosshair";
  }
}
