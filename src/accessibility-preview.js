/**
 * Accessibility Preview Tool
 *
 * A tool mode with a non-blocking side panel. When activated, a panel opens
 * on the right side showing color-filtered previews. The user draws a
 * marquee-style selection on the canvas that remains visible, and can be
 * moved and resized. The panel updates live as the selection changes.
 */

import { state, CONSTANTS, getElementsInZOrder, spatialInsert } from "./state.js";
import { screenToWorld, showToast } from "./utils.js";
import { render, drawShape, getFilteredImage } from "./rendering.js";
import { applyFilterToImageData } from "./filter-kernels.js";
import { pushUndo } from "./history.js";
import { scheduleSave } from "./persistence.js";
import { getSnapTargets, snapToElements, snapResizeEdges } from "./snap-guides.js";
import { getShapeBounds } from "./elements.js";

// --- Preview filters ---
const PREVIEW_FILTERS = [
  { key: "protanopia", label: "Protanopia (no red)" },
  { key: "protanomaly", label: "Protanomaly (weak red)" },
  { key: "deuteranopia", label: "Deuteranopia (no green)" },
  { key: "deuteranomaly", label: "Deuteranomaly (weak green)" },
  { key: "tritanopia", label: "Tritanopia (Blue-Yellow)" },
  { key: "tritanomaly", label: "Tritanomaly (mild)" },
  { key: "achromatopsia", label: "Achromatopsia (no color)" },
  { key: "achromatomaly", label: "Achromatomaly (almost no color)" },
  { key: "grayscale", label: "Grayscale" },
  { key: "low-contrast", label: "Low Contrast" },
  { key: "high-contrast", label: "High Contrast" },
  { key: "none", label: "Original" },
];

// --- Resize handle size (in screen pixels, will be divided by zoom) ---
const HANDLE_SIZE = 8;

// --- Tool state ---
let isDrawing = false;       // True while drawing a new selection
let drawStart = null;        // {x, y} world coords where drawing started

// Persistent selection rectangle (world coords) — stays on canvas
let activeRect = null;       // {x, y, w, h} or null

// Interaction mode for existing selection
let interactionMode = null;  // null | "move" | "resize-tl" | "resize-tr" | "resize-bl" | "resize-br" | "resize-t" | "resize-b" | "resize-l" | "resize-r"
let interactionStart = null; // {x, y} world pos at drag start
let interactionOrigRect = null; // copy of activeRect at drag start

// --- Panel state ---
let panelOpen = false;
let panelEl = null;
let gridEl = null;

// Debounce timer for live updates during move/resize
let updateTimer = null;

// --- Fullscreen modal preview state ---
let modalOverlay = null;
let modalImg = null;
let modalLabel = null;
let isShiftHeld = false;
let hoveredCellData = null; // { dataURL, label } of the cell currently under the cursor

/**
 * Create an OffscreenCanvas helper.
 */
function createOffscreen(w, h) {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(w, h);
    return { canvas, ctx: canvas.getContext("2d") };
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return { canvas, ctx: canvas.getContext("2d") };
}

/**
 * Rasterize the content of a world-space rectangle from the current canvas state.
 * Computes tight bounds from element extents clipped to the marquee rect
 * (same approach as marqueeExportPNG) so the output is auto-cropped to content.
 */
function rasterizeWorldRect(rect) {
  const elements = getElementsInZOrder();

  // Compute tight bounds from element extents clipped to the marquee rect
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of elements) {
    let elMinX, elMinY, elMaxX, elMaxY;
    if (el.elementType === "image") {
      elMinX = el.x; elMinY = el.y;
      elMaxX = el.x + el.w; elMaxY = el.y + el.h;
    } else {
      const b = getShapeBounds(el);
      elMinX = b.x; elMinY = b.y;
      elMaxX = b.x + b.w; elMaxY = b.y + b.h;
    }
    // Intersect element bounds with marquee rect
    const clippedMinX = Math.max(elMinX, rect.x);
    const clippedMinY = Math.max(elMinY, rect.y);
    const clippedMaxX = Math.min(elMaxX, rect.x + rect.w);
    const clippedMaxY = Math.min(elMaxY, rect.y + rect.h);
    if (clippedMinX >= clippedMaxX || clippedMinY >= clippedMaxY) continue;
    if (clippedMinX < minX) minX = clippedMinX;
    if (clippedMinY < minY) minY = clippedMinY;
    if (clippedMaxX > maxX) maxX = clippedMaxX;
    if (clippedMaxY > maxY) maxY = clippedMaxY;
  }

  // If no elements overlap the rect, fall back to the full rect
  if (minX >= maxX || minY >= maxY) {
    minX = rect.x; minY = rect.y;
    maxX = rect.x + rect.w; maxY = rect.y + rect.h;
  }

  const tightW = maxX - minX;
  const tightH = maxY - minY;

  const maxDim = 4096;
  let scale = 1;
  if (tightW > maxDim || tightH > maxDim) {
    scale = maxDim / Math.max(tightW, tightH);
  }

  const canvasW = Math.ceil(tightW * scale);
  const canvasH = Math.ceil(tightH * scale);
  if (canvasW <= 0 || canvasH <= 0) return null;

  const { canvas: offscreen, ctx } = createOffscreen(canvasW, canvasH);

  ctx.scale(scale, scale);
  ctx.translate(-minX, -minY);

  // Clip to the original marquee rect so elements are cropped at its edges
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();

  ctx.fillStyle = state.bgColor;
  ctx.fillRect(minX, minY, tightW, tightH);

  for (const el of elements) {
    if (el.elementType === "image") {
      if (el.x + el.w < rect.x || el.x > rect.x + rect.w ||
          el.y + el.h < rect.y || el.y > rect.y + rect.h) continue;

      ctx.save();
      ctx.globalAlpha = el.opacity != null ? el.opacity : 1;
      const drawSrc = state.currentFilter !== "none" ? getFilteredImage(el) : el.img;
      if (el.crop) {
        const natW = el.img.naturalWidth || el.img.width;
        const natH = el.img.naturalHeight || el.img.height;
        const c = el.crop;
        ctx.drawImage(drawSrc, c.x * natW, c.y * natH, c.w * natW, c.h * natH, el.x, el.y, el.w, el.h);
      } else {
        ctx.drawImage(drawSrc, el.x, el.y, el.w, el.h);
      }
      ctx.restore();
    } else {
      drawShape(ctx, el, true, scale);
    }
  }

  return { canvas: offscreen, worldW: tightW, worldH: tightH };
}

/**
 * Apply a filter to a canvas and return a new filtered canvas.
 */
function applyFilterToCanvas(sourceCanvas, filterName) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const { canvas: filtered, ctx } = createOffscreen(w, h);

  ctx.drawImage(sourceCanvas, 0, 0);

  if (filterName && filterName !== "none") {
    const imageData = ctx.getImageData(0, 0, w, h);
    applyFilterToImageData(imageData, filterName);
    ctx.putImageData(imageData, 0, 0);
  }

  return filtered;
}

/**
 * Convert a canvas to a data URL.
 */
function canvasToDataURL(canvas) {
  if (canvas instanceof OffscreenCanvas) {
    const tmp = document.createElement("canvas");
    tmp.width = canvas.width;
    tmp.height = canvas.height;
    const ctx = tmp.getContext("2d");
    ctx.drawImage(canvas, 0, 0);
    return tmp.toDataURL("image/png");
  }
  return canvas.toDataURL("image/png");
}

// --- Hit testing for the persistent selection ---

/**
 * Get the handle positions for the active selection rect.
 * Returns an array of { id, x, y } in world coords.
 */
function getHandles(rect, zoom) {
  const { x, y, w, h } = rect;
  return [
    { id: "resize-tl", x: x, y: y },
    { id: "resize-tr", x: x + w, y: y },
    { id: "resize-bl", x: x, y: y + h },
    { id: "resize-br", x: x + w, y: y + h },
  ];
}

/**
 * Determine what the cursor hit: a handle, inside the rect (move), or outside (new draw).
 * Returns the interaction mode string or null.
 */
function hitTestSelection(worldPos, zoom) {
  if (!activeRect) return null;

  const hs = HANDLE_SIZE / zoom;

  // Check handles first
  const handles = getHandles(activeRect, zoom);
  for (const handle of handles) {
    if (Math.abs(worldPos.x - handle.x) <= hs && Math.abs(worldPos.y - handle.y) <= hs) {
      return handle.id;
    }
  }

  // Check if inside the rect (move)
  if (worldPos.x >= activeRect.x && worldPos.x <= activeRect.x + activeRect.w &&
      worldPos.y >= activeRect.y && worldPos.y <= activeRect.y + activeRect.h) {
    return "move";
  }

  return null;
}

// --- Selection rendering ---

/**
 * Render the persistent selection and its handles, or the in-progress drawing rect.
 */
export function renderAccessibilityPreviewSelection(ctx, transform) {
  const zoom = transform.zoom;

  // Draw the in-progress selection while dragging to create
  if (isDrawing && drawStart) {
    const rect = activeRect;
    if (rect && (rect.w > 1 || rect.h > 1)) {
      drawSelectionRect(ctx, rect, zoom, false);
    }
    return;
  }

  // Draw the persistent active selection
  if (activeRect && activeRect.w > 1 && activeRect.h > 1) {
    drawSelectionRect(ctx, activeRect, zoom, true);
  }
}

/**
 * Draw a selection rectangle with optional handles.
 */
function drawSelectionRect(ctx, rect, zoom, showHandles) {
  ctx.save();

  // Fill
  ctx.fillStyle = "rgba(124, 58, 237, 0.06)";
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

  // Border
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2 / zoom;
  ctx.setLineDash([]);
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);

  ctx.strokeStyle = "#7c3aed";
  ctx.lineWidth = 2 / zoom;
  const dashLen = 6 / zoom;
  ctx.setLineDash([dashLen, dashLen]);
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  ctx.setLineDash([]);

  // Handles
  if (showHandles) {
    const hs = HANDLE_SIZE / zoom;
    const handles = getHandles(rect, zoom);
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#7c3aed";
    ctx.lineWidth = 1.5 / zoom;
    for (const handle of handles) {
      ctx.fillRect(handle.x - hs / 2, handle.y - hs / 2, hs, hs);
      ctx.strokeRect(handle.x - hs / 2, handle.y - hs / 2, hs, hs);
    }
  }

  ctx.restore();
}

// --- Tool event handlers ---

/**
 * Called on mousedown when the accessibility-preview tool is active.
 */
export function accessibilityPreviewStart(worldPos) {
  if (!panelOpen) {
    openPanel();
  }

  const zoom = state.transform.zoom;

  // Check if clicking on existing selection (handles or inside)
  const hit = hitTestSelection(worldPos, zoom);

  if (hit) {
    // Start move or resize interaction
    interactionMode = hit;
    interactionStart = { x: worldPos.x, y: worldPos.y };
    interactionOrigRect = { ...activeRect };
    return;
  }

  // Check if clicking an image (no existing selection hit)
  const images = state.images;
  let hitImage = null;
  for (let i = state.elementOrder.length - 1; i >= 0; i--) {
    const id = state.elementOrder[i];
    const img = images.find((el) => el.id === id);
    if (!img) continue;
    if (worldPos.x >= img.x && worldPos.x <= img.x + img.w &&
        worldPos.y >= img.y && worldPos.y <= img.y + img.h) {
      hitImage = img;
      break;
    }
  }

  // Start drawing a new selection
  isDrawing = true;
  drawStart = { x: worldPos.x, y: worldPos.y };
  activeRect = { x: worldPos.x, y: worldPos.y, w: 0, h: 0 };
}

/**
 * Snap an accessibility preview rect's edges to the grid or other elements.
 * Returns the snapped rectangle.
 */
function snapAccessibilityRect(rect) {
  if (state.gridVisible && state.gridSize > 0) {
    const g = state.gridSize;
    const x = Math.round(rect.x / g) * g;
    const y = Math.round(rect.y / g) * g;
    const x2 = Math.round((rect.x + rect.w) / g) * g;
    const y2 = Math.round((rect.y + rect.h) / g) * g;
    state.activeSnapGuides = [];
    return { x, y, w: x2 - x, h: y2 - y };
  }
  const targets = getSnapTargets([], rect);
  const threshold = CONSTANTS.SNAP_THRESHOLD / state.transform.zoom;
  const snap = snapToElements(rect, targets, threshold);
  state.activeSnapGuides = snap.guides;
  return { x: rect.x + snap.dx, y: rect.y + snap.dy, w: rect.w, h: rect.h };
}

/**
 * Called on mousemove during interaction.
 * Pass shiftKey=true to enable snapping to grid or other elements.
 */
export function accessibilityPreviewMove(worldPos, shiftKey) {
  // Drawing a new selection
  if (isDrawing && drawStart) {
    let endX = worldPos.x;
    let endY = worldPos.y;

    if (shiftKey) {
      // Snap only the dragged endpoint, keep drawStart fixed
      if (state.gridVisible && state.gridSize > 0) {
        const g = state.gridSize;
        endX = Math.round(endX / g) * g;
        endY = Math.round(endY / g) * g;
        state.activeSnapGuides = [];
      } else {
        const tempRect = {
          x: Math.min(drawStart.x, endX), y: Math.min(drawStart.y, endY),
          w: Math.abs(endX - drawStart.x), h: Math.abs(endY - drawStart.y),
        };
        const targets = getSnapTargets([], tempRect);
        const threshold = CONSTANTS.SNAP_THRESHOLD / state.transform.zoom;
        let bestDistX = threshold, bestDistY = threshold;
        let dx = 0, dy = 0;
        for (const tX of targets.x) {
          const dist = Math.abs(endX - tX);
          if (dist < bestDistX) { bestDistX = dist; dx = tX - endX; }
        }
        for (const tY of targets.y) {
          const dist = Math.abs(endY - tY);
          if (dist < bestDistY) { bestDistY = dist; dy = tY - endY; }
        }
        endX += dx;
        endY += dy;
        const guides = [];
        if (dx !== 0) { for (const tX of targets.x) { if (Math.abs(endX - tX) < 0.5) guides.push({ axis: "x", pos: tX }); } }
        if (dy !== 0) { for (const tY of targets.y) { if (Math.abs(endY - tY) < 0.5) guides.push({ axis: "y", pos: tY }); } }
        state.activeSnapGuides = guides;
      }
    } else {
      state.activeSnapGuides = [];
    }

    const x = Math.min(drawStart.x, endX);
    const y = Math.min(drawStart.y, endY);
    const w = Math.abs(endX - drawStart.x);
    const h = Math.abs(endY - drawStart.y);

    activeRect = { x, y, w, h };
    render();
    return;
  }

  // Moving or resizing the existing selection
  if (interactionMode && interactionStart && interactionOrigRect) {
    const dx = worldPos.x - interactionStart.x;
    const dy = worldPos.y - interactionStart.y;
    const orig = interactionOrigRect;

    if (interactionMode === "move") {
      let movedRect = { x: orig.x + dx, y: orig.y + dy, w: orig.w, h: orig.h };
      if (shiftKey) {
        movedRect = snapAccessibilityRect(movedRect);
      } else {
        state.activeSnapGuides = [];
      }
      activeRect = movedRect;
    } else {
      let resized = computeResize(orig, interactionMode, dx, dy);
      if (shiftKey) {
        // Snap the resized edges to elements/grid
        if (state.gridVisible && state.gridSize > 0) {
          const g = state.gridSize;
          const x = Math.round(resized.x / g) * g;
          const y = Math.round(resized.y / g) * g;
          const x2 = Math.round((resized.x + resized.w) / g) * g;
          const y2 = Math.round((resized.y + resized.h) / g) * g;
          resized = { x, y, w: x2 - x, h: y2 - y };
          state.activeSnapGuides = [];
        } else {
          const handlePos = interactionMode.replace("resize-", "");
          const targets = getSnapTargets([], resized);
          const threshold = CONSTANTS.SNAP_THRESHOLD / state.transform.zoom;
          const snap = snapResizeEdges(resized, handlePos, targets, threshold);
          resized = { x: resized.x + (handlePos.includes("l") ? snap.dx : 0), y: resized.y + (handlePos.includes("t") ? snap.dy : 0), w: resized.w + (handlePos.includes("r") ? snap.dx : (handlePos.includes("l") ? -snap.dx : 0)), h: resized.h + (handlePos.includes("b") ? snap.dy : (handlePos.includes("t") ? -snap.dy : 0)) };
          state.activeSnapGuides = snap.guides;
        }
      } else {
        state.activeSnapGuides = [];
      }
      activeRect = resized;
    }

    render();
    scheduleLiveUpdate();
    return;
  }
}

/**
 * Called on mouseup to finalize interaction.
 */
export function accessibilityPreviewEnd() {
  if (isDrawing) {
    const clickPos = drawStart;
    isDrawing = false;
    drawStart = null;

    // If too small, check if it was a click on an image
    if (!activeRect || activeRect.w < 5 || activeRect.h < 5) {
      const images = state.images;
      let hitImage = null;
      if (clickPos) {
        for (let i = state.elementOrder.length - 1; i >= 0; i--) {
          const id = state.elementOrder[i];
          const img = images.find((el) => el.id === id);
          if (!img) continue;
          if (clickPos.x >= img.x && clickPos.x <= img.x + img.w &&
              clickPos.y >= img.y && clickPos.y <= img.y + img.h) {
            hitImage = img;
            break;
          }
        }
      }
      if (hitImage) {
        activeRect = { x: hitImage.x, y: hitImage.y, w: hitImage.w, h: hitImage.h };
        render();
        refreshPreview();
        return;
      }
      activeRect = null;
      render();
      clearPanelGrid();
      return;
    }

    render();
    refreshPreview();
    return;
  }

  if (interactionMode) {
    interactionMode = null;
    interactionStart = null;
    interactionOrigRect = null;
    refreshPreview();
    return;
  }
}

/**
 * Compute new rect after a resize drag.
 */
function computeResize(orig, mode, dx, dy) {
  let { x, y, w, h } = orig;

  if (mode.includes("l")) { x += dx; w -= dx; }
  if (mode.includes("r")) { w += dx; }
  if (mode.includes("t")) { y += dy; h -= dy; }
  if (mode.includes("b")) { h += dy; }

  // Ensure minimum size
  if (w < 10) { w = 10; if (mode.includes("l")) x = orig.x + orig.w - 10; }
  if (h < 10) { h = 10; if (mode.includes("t")) y = orig.y + orig.h - 10; }

  return { x, y, w, h };
}

/**
 * Schedule a debounced live update of the panel during move/resize.
 */
function scheduleLiveUpdate() {
  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = setTimeout(() => {
    updateTimer = null;
    refreshPreview();
  }, 100);
}

/**
 * Clear the panel grid and show the empty state.
 */
function clearPanelGrid() {
  if (!gridEl) return;
  gridEl.innerHTML = "";
  const emptyState = document.createElement("div");
  emptyState.className = "accessibility-preview-empty";
  emptyState.innerHTML = `
    <div class="accessibility-preview-empty-icon">
      <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="4 2"/>
        <path d="M9 12h6M12 9v6"/>
      </svg>
    </div>
    <p>Click an image or draw a selection to preview color accessibility filters</p>
  `;
  gridEl.appendChild(emptyState);
}

/**
 * Refresh the panel with the current active rect content.
 */
function refreshPreview() {
  if (!activeRect || activeRect.w < 5 || activeRect.h < 5) return;
  if (!panelOpen) return;

  const result = rasterizeWorldRect(activeRect);
  if (result) {
    updatePanelGrid(result.canvas, result.worldW, result.worldH);
  }
}

/**
 * Check if the tool is currently in an active interaction (drawing, moving, or resizing).
 * Used by the main mousemove handler to route events.
 */
export function isAccessibilityPreviewInteracting() {
  return isDrawing || interactionMode != null;
}

/**
 * Check if there's a visible selection to render (for the render loop).
 */
export function isAccessibilityPreviewSelecting() {
  return activeRect != null;
}

/**
 * Check if the panel is currently open.
 */
export function isAccessibilityPreviewModalOpen() {
  return panelOpen;
}

/**
 * Get the current cursor style based on what the user is hovering.
 * Called from the main interaction module to set the cursor.
 */
export function getAccessibilityPreviewCursor(worldPos) {
  if (!activeRect) return "crosshair";

  const zoom = state.transform.zoom;
  const hit = hitTestSelection(worldPos, zoom);

  if (!hit) return "crosshair";
  if (hit === "move") return "move";
  if (hit === "resize-tl" || hit === "resize-br") return "nwse-resize";
  if (hit === "resize-tr" || hit === "resize-bl") return "nesw-resize";
  return "crosshair";
}

// --- Panel resize handle ---

function setupPanelResizeHandle(handle, panel) {
  let startX = 0;
  let startWidth = 0;

  const onMouseMove = (e) => {
    const dx = startX - e.clientX;
    const newWidth = Math.max(320, Math.min(window.innerWidth * 0.8 - 32, startWidth + dx));
    panel.style.width = newWidth + "px";
  };

  const onMouseUp = () => {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    startX = e.clientX;
    startWidth = panel.offsetWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });
}

// --- Panel lifecycle ---

/**
 * Open the side panel.
 */
export function openPanel() {
  if (panelOpen) return;
  panelOpen = true;

  const panel = document.createElement("div");
  panel.id = "accessibility-preview-panel";
  panel.className = "accessibility-preview-panel";

  // Resize handle on the left edge
  const resizeHandle = document.createElement("div");
  resizeHandle.className = "accessibility-preview-resize-handle";
  panel.appendChild(resizeHandle);
  setupPanelResizeHandle(resizeHandle, panel);

  // Header
  const header = document.createElement("div");
  header.className = "accessibility-preview-header";

  const title = document.createElement("span");
  title.className = "accessibility-preview-title";
  title.textContent = "Accessibility Preview";

  const closeBtn = document.createElement("button");
  closeBtn.className = "accessibility-preview-close";
  closeBtn.title = "Close (Escape)";
  closeBtn.innerHTML = "&times;";
  closeBtn.addEventListener("click", closePanel);

  header.appendChild(title);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  // Grid container
  const grid = document.createElement("div");
  grid.className = "accessibility-preview-grid";

  // Empty state
  const emptyState = document.createElement("div");
  emptyState.className = "accessibility-preview-empty";
  emptyState.innerHTML = `
    <div class="accessibility-preview-empty-icon">
      <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="4 2"/>
        <path d="M9 12h6M12 9v6"/>
      </svg>
    </div>
    <p>Click an image or draw a selection to preview color accessibility filters</p>
  `;
  grid.appendChild(emptyState);

  panel.appendChild(grid);
  document.body.appendChild(panel);

  panelEl = panel;
  gridEl = grid;

  // Register shift key listeners for modal preview
  document.addEventListener("keydown", onKeyDownForModal);
  document.addEventListener("keyup", onKeyUpForModal);

  // If there's already an active selection, show it
  if (activeRect && activeRect.w > 5 && activeRect.h > 5) {
    refreshPreview();
  }
}

/**
 * Close the panel.
 */
export function closePanel() {
  if (!panelOpen) return;
  panelOpen = false;

  // Remove shift key listeners
  document.removeEventListener("keydown", onKeyDownForModal);
  document.removeEventListener("keyup", onKeyUpForModal);
  isShiftHeld = false;
  hoveredCellData = null;
  hideModal();

  // Remove modal overlay
  if (modalOverlay) {
    modalOverlay.remove();
    modalOverlay = null;
    modalImg = null;
    modalLabel = null;
  }

  if (panelEl) {
    panelEl.remove();
    panelEl = null;
    gridEl = null;
  }

  activeRect = null;
  render();
}

// --- Fullscreen modal preview ---

/**
 * Create the fullscreen modal overlay element (lazily, once).
 */
function ensureModalOverlay() {
  if (modalOverlay) return;

  modalOverlay = document.createElement("div");
  modalOverlay.className = "accessibility-preview-modal-overlay";

  modalImg = document.createElement("img");
  modalImg.className = "accessibility-preview-modal-img";

  modalLabel = document.createElement("div");
  modalLabel.className = "accessibility-preview-modal-label";

  modalOverlay.appendChild(modalImg);
  modalOverlay.appendChild(modalLabel);
  document.body.appendChild(modalOverlay);
}

/**
 * Show the fullscreen modal backdrop and set its content.
 * The backdrop stays visible as long as Shift is held over the grid;
 * only the image/label inside updates when switching cells.
 */
function showModal(dataURL, label) {
  ensureModalOverlay();
  modalImg.src = dataURL;
  modalImg.style.opacity = "1";
  modalLabel.textContent = label;
  modalLabel.style.visibility = "visible";

  // Center the image in the space left of the panel
  if (panelEl) {
    const panelWidth = window.innerWidth - panelEl.getBoundingClientRect().left;
    modalOverlay.style.paddingRight = panelWidth + "px";
  } else {
    modalOverlay.style.paddingRight = "0";
  }

  modalOverlay.classList.add("visible");
}

/**
 * Show just the backdrop without specific image content (between cells).
 */
function showModalBackdrop() {
  ensureModalOverlay();
  modalImg.style.opacity = "0";
  modalLabel.style.visibility = "hidden";

  if (panelEl) {
    const panelWidth = window.innerWidth - panelEl.getBoundingClientRect().left;
    modalOverlay.style.paddingRight = panelWidth + "px";
  } else {
    modalOverlay.style.paddingRight = "0";
  }

  modalOverlay.classList.add("visible");
}

/**
 * Hide the fullscreen modal completely.
 */
function hideModal() {
  if (modalOverlay) {
    modalOverlay.classList.remove("visible");
  }
}

/**
 * Track shift key state for the modal preview hover behavior.
 */
function onKeyDownForModal(e) {
  if (e.key === "Shift") {
    isShiftHeld = true;
    // If already hovering over a cell, show the modal with its content
    if (hoveredCellData) {
      showModal(hoveredCellData.dataURL, hoveredCellData.label);
    } else if (gridEl && gridEl.matches(":hover")) {
      // Over the grid but between cells — show backdrop only
      showModalBackdrop();
    }
  }
}

function onKeyUpForModal(e) {
  if (e.key === "Shift") {
    isShiftHeld = false;
    hideModal();
  }
}

/**
 * Insert a filtered preview image onto the canvas at the center of the current view.
 * Uses the world-space dimensions of the rasterized content for placement.
 */
function insertPreviewImageToCanvas(dataURL, w, h, label) {
  const img = new Image();
  img.onload = () => {
    pushUndo();

    // Place at center of current viewport
    const cx = (-state.transform.x + window.innerWidth / 2) / state.transform.zoom;
    const cy = (-state.transform.y + window.innerHeight / 2) / state.transform.zoom;

    const newImg = {
      id: "img_" + state.elementIdCounter++,
      elementType: "image",
      img,
      x: cx - w / 2,
      y: cy - h / 2,
      w,
      h,
      opacity: 1,
    };
    state.images.push(newImg);
    spatialInsert(newImg);

    state.selectedElements = [newImg];
    render();
    scheduleSave();
    showToast(`Placed "${label}" on canvas`);
  };
  img.src = dataURL;
}

/**
 * Update the panel grid with filtered versions of the source canvas.
 * @param {HTMLCanvasElement|OffscreenCanvas} sourceCanvas - The rasterized content.
 * @param {number} worldW - World-space width of the rasterized content.
 * @param {number} worldH - World-space height of the rasterized content.
 */
function updatePanelGrid(sourceCanvas, worldW, worldH) {
  if (!gridEl) return;

  gridEl.innerHTML = "";

  for (const { key, label } of PREVIEW_FILTERS) {
    const cell = document.createElement("div");
    cell.className = "accessibility-preview-cell";

    const imgWrapper = document.createElement("div");
    imgWrapper.className = "accessibility-preview-img-wrapper";

    const filteredCanvas = applyFilterToCanvas(sourceCanvas, key);
    const dataURL = canvasToDataURL(filteredCanvas);

    const img = document.createElement("img");
    img.src = dataURL;
    img.alt = label;
    img.className = "accessibility-preview-img";
    img.draggable = true;

    imgWrapper.appendChild(img);

    const labelEl = document.createElement("div");
    labelEl.className = "accessibility-preview-label";
    labelEl.textContent = label;

    cell.appendChild(imgWrapper);
    cell.appendChild(labelEl);
    gridEl.appendChild(cell);

    // Drag to canvas
    img.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", "accessibility-preview-drag");
      e.dataTransfer.setData("application/x-a11y-preview", JSON.stringify({
        dataURL,
        w: worldW,
        h: worldH,
        label,
      }));
      e.dataTransfer.effectAllowed = "copy";
    });

    // Shift+hover: fullscreen modal preview
    cell.addEventListener("mouseenter", () => {
      hoveredCellData = { dataURL, label };
      if (isShiftHeld) {
        showModal(dataURL, label);
      }
    });

    cell.addEventListener("mouseleave", () => {
      if (hoveredCellData && hoveredCellData.dataURL === dataURL) {
        hoveredCellData = null;
      }
      // Keep backdrop visible while shift is held — avoids flash between cells
      if (isShiftHeld) {
        showModalBackdrop();
      }
    });

    // Cmd+click (Meta+click): insert image to canvas
    cell.addEventListener("click", (e) => {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        insertPreviewImageToCanvas(dataURL, worldW, worldH, label);
      }
    });
  }
}

/**
 * Handle drop events on the canvas from the accessibility preview panel.
 */
export function handleAccessibilityPreviewDrop(e) {
  const payload = e.dataTransfer.getData("application/x-a11y-preview");
  if (!payload) return false;

  e.preventDefault();
  const { dataURL, w, h, label } = JSON.parse(payload);

  const worldPos = screenToWorld(e.clientX, e.clientY);

  const img = new Image();
  img.onload = () => {
    pushUndo();

    const newImg = {
      id: "img_" + state.elementIdCounter++,
      elementType: "image",
      img,
      x: worldPos.x - w / 2,
      y: worldPos.y - h / 2,
      w,
      h,
      opacity: 1,
    };
    state.images.push(newImg);
    spatialInsert(newImg);

    state.selectedElements = [newImg];
    render();
    scheduleSave();
    showToast(`Placed "${label}" on canvas`);
  };
  img.src = dataURL;

  return true;
}

/**
 * Called when the tool is activated.
 */
export function activateAccessibilityPreview() {
  if (!panelOpen) {
    openPanel();
  }
}

/**
 * Called when switching away from this tool.
 */
export function deactivateAccessibilityPreview() {
  activeRect = null;
  closePanel();
}
