/**
 * Accessibility Grid Tool
 *
 * Creates color-filtered versions of the selected image (or marquee area)
 * and places them in a labeled grid below the original. This makes it easy
 * to visually check how a design looks under various color vision deficiencies.
 */

import { state, spatialInsert } from "./state.js";
import { showToast } from "./utils.js";
import { pushUndo } from "./history.js";
import { scheduleSave } from "./persistence.js";
import { render } from "./rendering.js";
import { applyFilterToImageData } from "./filter-kernels.js";
import { FILTER_LABELS } from "./color-filter.js";
import { updateToolbarUI, toggleAlignmentPanelVisibility } from "./toolbar.js";
import { exitMarqueeMode } from "./marquee-select.js";

/**
 * Filters applied in the accessibility grid.
 * These represent the most common color vision deficiency simulations
 * plus useful contrast/display conditions.
 */
const GRID_FILTERS = [
  "protanopia",
  "deuteranopia",
  "tritanopia",
  "achromatopsia",
  "grayscale",
  "low-contrast",
];

/** Gap between grid cells in world units */
const GRID_GAP = 20;

/** Height of the label area above each image in world units */
const LABEL_HEIGHT = 24;

/** Number of columns in the grid */
const GRID_COLUMNS = 3;

/**
 * Create an OffscreenCanvas (or fallback canvas) of given dimensions.
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
 * Rasterize the source content (selected image or marquee area) into a canvas.
 * Returns { canvas, width, height } in pixels, or null if nothing suitable is selected.
 */
function getSourcePixels() {
  // Priority 1: Active marquee with rasterized content
  if (state.marqueeMode && state.marqueePixelCanvas) {
    const src = state.marqueePixelCanvas;
    const w = src.width;
    const h = src.height;
    return { canvas: src, width: w, height: h, worldW: state.marqueeRect.w, worldH: state.marqueeRect.h };
  }

  // Priority 2: Selected image element(s) — use the first image in selection
  const selectedImage = state.selectedElements.find((el) => el.elementType === "image");
  if (selectedImage) {
    const img = selectedImage.img;
    const natW = img.naturalWidth || img.width;
    const natH = img.naturalHeight || img.height;

    const { canvas, ctx } = createOffscreen(natW, natH);

    if (selectedImage.crop) {
      const c = selectedImage.crop;
      ctx.drawImage(img, c.x * natW, c.y * natH, c.w * natW, c.h * natH, 0, 0, natW, natH);
    } else {
      ctx.drawImage(img, 0, 0);
    }

    return { canvas, width: natW, height: natH, worldW: selectedImage.w, worldH: selectedImage.h };
  }

  return null;
}

/**
 * Get the bounding box of the source (for positioning the grid below it).
 * Returns { x, y, w, h } in world coordinates.
 */
function getSourceBounds() {
  if (state.marqueeMode && state.marqueeRect) {
    const r = state.marqueeRect;
    const ox = state.marqueeOffset.x;
    const oy = state.marqueeOffset.y;
    return { x: r.x + ox, y: r.y + oy, w: r.w, h: r.h };
  }

  const selectedImage = state.selectedElements.find((el) => el.elementType === "image");
  if (selectedImage) {
    return { x: selectedImage.x, y: selectedImage.y, w: selectedImage.w, h: selectedImage.h };
  }

  return null;
}

/**
 * Apply a named filter to a source canvas and return a new canvas with the result.
 */
function applyFilter(sourceCanvas, filterName) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const { canvas: filtered, ctx: fCtx } = createOffscreen(w, h);

  // Draw source
  fCtx.drawImage(sourceCanvas, 0, 0);

  // Get pixel data and apply filter
  const imageData = fCtx.getImageData(0, 0, w, h);
  applyFilterToImageData(imageData, filterName);
  fCtx.putImageData(imageData, 0, 0);

  return filtered;
}

/**
 * Generate the accessibility grid. This is the main entry point.
 * Creates filtered copies of the selected image/marquee area and places them
 * in a grid layout below the original.
 */
export function generateAccessibilityGrid() {
  const source = getSourcePixels();
  if (!source) {
    showToast("Select an image or marquee area first");
    return;
  }

  const bounds = getSourceBounds();
  if (!bounds) {
    showToast("Could not determine source bounds");
    return;
  }

  pushUndo();

  // Exit marquee mode if active (we've already captured the pixels)
  if (state.marqueeMode) {
    exitMarqueeMode();
  }

  const { canvas: sourceCanvas, worldW, worldH } = source;

  // Calculate grid layout
  const cellW = worldW;
  const cellH = worldH + LABEL_HEIGHT;
  const cols = Math.min(GRID_COLUMNS, GRID_FILTERS.length);
  const rows = Math.ceil(GRID_FILTERS.length / cols);

  // Start position: below the original with some gap
  const startX = bounds.x;
  const startY = bounds.y + bounds.h + GRID_GAP * 2;

  const newElements = [];
  const groupId = "group_" + state.groupIdCounter++;

  GRID_FILTERS.forEach((filterName, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);

    const cellX = startX + col * (cellW + GRID_GAP);
    const cellY = startY + row * (cellH + GRID_GAP);

    // Apply the filter
    const filteredCanvas = applyFilter(sourceCanvas, filterName);

    // Create an image element for the filtered version
    const imgElement = {
      id: "img_" + state.elementIdCounter++,
      elementType: "image",
      img: filteredCanvas,
      x: cellX,
      y: cellY + LABEL_HEIGHT,
      w: worldW,
      h: worldH,
      opacity: 1,
      groupId,
    };
    state.images.push(imgElement);
    spatialInsert(imgElement);
    newElements.push(imgElement);

    // Create a text label for the filter name
    const label = FILTER_LABELS[filterName] || filterName;
    const textElement = {
      id: "draw_" + state.elementIdCounter++,
      elementType: "text",
      type: "text",
      text: label,
      color: "#333333",
      fontSize: Math.min(16, LABEL_HEIGHT * 0.7),
      fontFamily: "sans-serif",
      start: { x: cellX, y: cellY + LABEL_HEIGHT * 0.75 },
      groupId,
    };
    state.drawings.push(textElement);
    spatialInsert(textElement);
    newElements.push(textElement);
  });

  // Select the newly created elements
  state.selectedElements = newElements;
  state.currentTool = "select";
  updateToolbarUI();
  toggleAlignmentPanelVisibility();
  render();
  scheduleSave();

  showToast(`Generated ${GRID_FILTERS.length} color accessibility variants`);
}
