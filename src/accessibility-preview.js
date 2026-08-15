/**
 * Accessibility Preview Tool
 *
 * A tool mode with a non-blocking side panel. When activated, a panel opens
 * on the right side (50% screen width) showing color-filtered previews.
 * The user draws marquee-style selections on the canvas (which remains fully
 * interactive) and the panel updates with the filtered versions of the
 * selected area.
 */

import { state, getElementsInZOrder, spatialInsert } from "./state.js";
import { screenToWorld, showToast } from "./utils.js";
import { render, drawShape, getFilteredImage } from "./rendering.js";
import { applyFilterToImageData } from "./filter-kernels.js";
import { pushUndo } from "./history.js";
import { scheduleSave } from "./persistence.js";

// --- Preview filters ---
const PREVIEW_FILTERS = [
  { key: "none", label: "Original" },
  { key: "protanopia", label: "Protanopia" },
  { key: "deuteranopia", label: "Deuteranopia" },
  { key: "tritanopia", label: "Tritanopia" },
  { key: "achromatopsia", label: "Achromatopsia" },
  { key: "grayscale", label: "Grayscale" },
  { key: "low-contrast", label: "Low Contrast" },
  { key: "high-contrast", label: "High Contrast" },
];

// --- Tool state ---
let isSelecting = false;
let selectionStart = null;
let selectionRect = null;

// --- Panel state ---
let panelOpen = false;
let panelEl = null;
let gridEl = null;

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
 */
function rasterizeWorldRect(rect) {
  const maxDim = 4096;
  let scale = 1;
  if (rect.w > maxDim || rect.h > maxDim) {
    scale = maxDim / Math.max(rect.w, rect.h);
  }

  const canvasW = Math.ceil(rect.w * scale);
  const canvasH = Math.ceil(rect.h * scale);
  if (canvasW <= 0 || canvasH <= 0) return null;

  const { canvas: offscreen, ctx } = createOffscreen(canvasW, canvasH);

  ctx.scale(scale, scale);
  ctx.translate(-rect.x, -rect.y);

  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();

  ctx.fillStyle = state.bgColor;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

  const elements = getElementsInZOrder();
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
      drawShape(ctx, el, true);
    }
  }

  return offscreen;
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

// --- Selection rendering ---

/**
 * Render the selection rectangle on the canvas while dragging.
 */
export function renderAccessibilityPreviewSelection(ctx, transform) {
  if (!isSelecting || !selectionRect) return;

  const rect = selectionRect;
  if (rect.w < 1 && rect.h < 1) return;

  const zoom = transform.zoom;

  ctx.save();

  ctx.fillStyle = "rgba(128, 0, 255, 0.08)";
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5 / zoom;
  ctx.setLineDash([]);
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);

  ctx.strokeStyle = "#7c3aed";
  ctx.lineWidth = 1.5 / zoom;
  const dashLen = 6 / zoom;
  ctx.setLineDash([dashLen, dashLen]);
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);

  ctx.setLineDash([]);
  ctx.restore();
}

// --- Tool event handlers ---

/**
 * Called on mousedown when the accessibility-preview tool is active.
 */
export function accessibilityPreviewStart(worldPos) {
  // Open the panel if not already open
  if (!panelOpen) {
    openPanel();
  }
  isSelecting = true;
  selectionStart = { x: worldPos.x, y: worldPos.y };
  selectionRect = { x: worldPos.x, y: worldPos.y, w: 0, h: 0 };
}

/**
 * Called on mousemove during selection.
 */
export function accessibilityPreviewMove(worldPos) {
  if (!isSelecting || !selectionStart) return;

  const x = Math.min(selectionStart.x, worldPos.x);
  const y = Math.min(selectionStart.y, worldPos.y);
  const w = Math.abs(worldPos.x - selectionStart.x);
  const h = Math.abs(worldPos.y - selectionStart.y);

  selectionRect = { x, y, w, h };
  render();
}

/**
 * Called on mouseup to finalize selection and update the panel.
 * If the drag was very small (a click), try to select the image under the cursor.
 */
export function accessibilityPreviewEnd() {
  if (!isSelecting) return;
  isSelecting = false;

  const rect = selectionRect;
  selectionRect = null;
  render();

  // If the selection is too small, treat it as a click — find image under cursor
  if (!rect || rect.w < 5 || rect.h < 5) {
    const clickPos = selectionStart;
    if (!clickPos) return;

    // Find the topmost image under the click position
    const images = state.images;
    let hitImage = null;
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

    if (hitImage) {
      // Rasterize the full image bounds
      const sourceCanvas = rasterizeWorldRect({
        x: hitImage.x, y: hitImage.y, w: hitImage.w, h: hitImage.h,
      });
      if (sourceCanvas) {
        if (!panelOpen) openPanel();
        updatePanelGrid(sourceCanvas);
      }
    }
    return;
  }

  const sourceCanvas = rasterizeWorldRect(rect);
  if (!sourceCanvas) {
    showToast("Could not capture area");
    return;
  }

  updatePanelGrid(sourceCanvas);
}

/**
 * Check if the tool is currently selecting.
 */
export function isAccessibilityPreviewSelecting() {
  return isSelecting && selectionRect != null;
}

/**
 * Check if the panel is currently open.
 */
export function isAccessibilityPreviewModalOpen() {
  return panelOpen;
}

// --- Resize logic ---

/**
 * Set up drag-to-resize behavior on the left edge handle.
 */
function setupResizeHandle(handle, panel) {
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
 * Open the side panel. Called when the tool is activated.
 */
export function openPanel() {
  if (panelOpen) return;
  panelOpen = true;

  // Create panel element (non-blocking, no overlay)
  const panel = document.createElement("div");
  panel.id = "accessibility-preview-panel";
  panel.className = "accessibility-preview-panel";

  // Resize handle on the left edge
  const resizeHandle = document.createElement("div");
  resizeHandle.className = "accessibility-preview-resize-handle";
  panel.appendChild(resizeHandle);
  setupResizeHandle(resizeHandle, panel);

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
}

/**
 * Close the panel and restore canvas size.
 */
export function closePanel() {
  if (!panelOpen) return;
  panelOpen = false;

  if (panelEl) {
    panelEl.remove();
    panelEl = null;
    gridEl = null;
  }

  render();
}

/**
 * Update the panel grid with filtered versions of the source canvas.
 * Each cell shows the filtered image with a label overlay and is draggable to the canvas.
 */
function updatePanelGrid(sourceCanvas) {
  if (!gridEl) return;

  gridEl.innerHTML = "";

  // Store the source dimensions for drop sizing
  const srcW = sourceCanvas.width;
  const srcH = sourceCanvas.height;

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

    // --- Drag to canvas ---
    img.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", "accessibility-preview-drag");
      e.dataTransfer.setData("application/x-a11y-preview", JSON.stringify({
        dataURL,
        w: srcW,
        h: srcH,
        label,
      }));
      e.dataTransfer.effectAllowed = "copy";
    });
  }
}

/**
 * Handle drop events on the canvas from the accessibility preview panel.
 * Creates a new image element at the drop position.
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
 * Called when the tool is activated (e.g., from toolbar click or keyboard shortcut).
 * Opens the panel immediately.
 */
export function activateAccessibilityPreview() {
  if (!panelOpen) {
    openPanel();
  }
}

/**
 * Called when switching away from this tool.
 * Closes the panel.
 */
export function deactivateAccessibilityPreview() {
  closePanel();
}
