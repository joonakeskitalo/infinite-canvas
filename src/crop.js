/**
 * Crop Mode
 *
 * Functions for entering/exiting crop mode and computing crop geometry.
 */

import { state, spatialUpdate } from "./state.js";
import { showToast } from "./utils.js";
import { pushUndo } from "./history.js";
import { invalidateCropCache } from "./rendering.js";

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
    invalidateCropCache(el);
    spatialUpdate(el);
    if (_scheduleSave) _scheduleSave();
  }
  state.cropMode = false;
  state.cropTarget = null;
  state.cropRect = null;
  state.cropDragEdge = null;
  state.cropDragStart = null;
  if (_toggleAlignmentPanelVisibility) _toggleAlignmentPanelVisibility();
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

  // Point is inside the crop rect — allow moving
  if (worldPos.x >= left && worldPos.x <= right && worldPos.y >= top && worldPos.y <= bottom) {
    return "move";
  }

  return null;
}

export function getCropCursor(edge) {
  switch (edge) {
    case "n": case "s": return "ns-resize";
    case "e": case "w": return "ew-resize";
    case "nw": case "se": return "nwse-resize";
    case "ne": case "sw": return "nesw-resize";
    case "move": return "move";
    default: return "crosshair";
  }
}

/**
 * Copy the crop settings from the currently selected image element.
 * Returns true if crop was copied successfully.
 */
export function copyCropSettings() {
  if (state.selectedElements.length !== 1) {
    showToast("Select a single cropped image to copy its crop");
    return false;
  }
  const el = state.selectedElements[0];
  if (el.elementType !== "image") {
    showToast("Crop copy only works on images");
    return false;
  }
  if (!el.crop) {
    showToast("Selected image has no crop to copy");
    return false;
  }
  state.cropClipboard = { x: el.crop.x, y: el.crop.y, w: el.crop.w, h: el.crop.h };
  showToast("Crop settings copied");
  return true;
}

/**
 * Paste previously copied crop settings onto the currently selected image(s).
 * Returns true if crop was pasted successfully.
 */
export function pasteCropSettings() {
  if (!state.cropClipboard) {
    showToast("No crop settings to paste — copy a crop first");
    return false;
  }
  const imageElements = state.selectedElements.filter((el) => el.elementType === "image");
  if (imageElements.length === 0) {
    showToast("Select one or more images to paste crop onto");
    return false;
  }

  pushUndo();

  for (const el of imageElements) {
    // Recalculate full bounds from the current position if already cropped
    let full;
    if (el.crop) {
      const c = el.crop;
      const fullW = el.w / c.w;
      const fullH = el.h / c.h;
      const fullX = el.x - c.x * fullW;
      const fullY = el.y - c.y * fullH;
      full = { x: fullX, y: fullY, w: fullW, h: fullH };
    } else {
      full = { x: el.x, y: el.y, w: el.w, h: el.h };
    }

    const crop = state.cropClipboard;

    // Store (updated) full bounds
    el.fullBounds = { x: full.x, y: full.y, w: full.w, h: full.h };

    // Apply the fractional crop
    el.crop = { x: crop.x, y: crop.y, w: crop.w, h: crop.h };
    el.x = full.x + crop.x * full.w;
    el.y = full.y + crop.y * full.h;
    el.w = crop.w * full.w;
    el.h = crop.h * full.h;

    invalidateCropCache(el);
    spatialUpdate(el);
  }

  if (_scheduleSave) _scheduleSave();
  if (_render) _render();
  showToast(`Crop pasted onto ${imageElements.length} image(s)`);
  return true;
}
