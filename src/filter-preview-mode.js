/**
 * Filter Preview Mode
 *
 * Full-screen overlay that renders every canvas image with all available
 * color filters applied simultaneously. Navigate between images using
 * left/right arrow keys. Activated from the toolbar button.
 *
 * Flagging: Click a filtered preview to flag it. Flagged images are placed
 * on the canvas when the preview is closed.
 */

import { state, spatialInsert } from "./state.js";
import { FILTER_OPTIONS, FILTER_LABELS } from "./color-filter.js";
import { applyFilterToImageData } from "./filter-kernels.js";
import { render } from "./rendering.js";
import { pushUndo } from "./history.js";
import { scheduleSave } from "./persistence.js";

// --- State ---
let isActive = false;
let currentIndex = 0;
let keyHandler = null;

/** @type {Array<{sourceImg: object, filter: string, canvas: HTMLCanvasElement}>} */
let flaggedItems = [];

// --- DOM refs (lazily cached) ---
let overlay, grid, counter, title, closeBtn, prevBtn, nextBtn;

function getDomRefs() {
  if (overlay) return;
  overlay = document.getElementById("filter-preview-overlay");
  grid = document.getElementById("filter-preview-grid");
  counter = document.getElementById("filter-preview-counter");
  title = document.getElementById("filter-preview-title");
  closeBtn = document.getElementById("filter-preview-close");
  prevBtn = document.getElementById("filter-preview-prev");
  nextBtn = document.getElementById("filter-preview-next");
}

// --- Core rendering ---

/**
 * Render a single image through a filter and return a canvas element.
 */
function renderFilteredCanvas(img, filter) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  if (filter && filter !== "none") {
    const imageData = ctx.getImageData(0, 0, w, h);
    applyFilterToImageData(imageData, filter);
    ctx.putImageData(imageData, 0, 0);
  }

  return canvas;
}

/**
 * Check if a given source image + filter combo is already flagged.
 */
function isFlagged(sourceImg, filter) {
  return flaggedItems.some((f) => f.sourceImg === sourceImg && f.filter === filter);
}

/**
 * Toggle flagged state of a cell.
 */
function toggleFlag(sourceImg, filter, canvas, cell) {
  const idx = flaggedItems.findIndex((f) => f.sourceImg === sourceImg && f.filter === filter);
  if (idx >= 0) {
    flaggedItems.splice(idx, 1);
    cell.classList.remove("filter-preview-cell-flagged");
  } else {
    flaggedItems.push({ sourceImg, filter, canvas });
    cell.classList.add("filter-preview-cell-flagged");
  }
  updateFlagCount();
}

function updateFlagCount() {
  getDomRefs();
  const badge = document.getElementById("filter-preview-flag-count");
  if (badge) {
    badge.textContent = flaggedItems.length > 0 ? `${flaggedItems.length} flagged` : "";
  }
}

/**
 * Build the grid of filter previews for the image at the given index.
 */
function renderGrid(index) {
  const images = state.images;
  if (images.length === 0) return;

  currentIndex = Math.max(0, Math.min(index, images.length - 1));
  const imgEl = images[currentIndex];

  // Update header info
  const name = imgEl.fileName || imgEl.name || `Image ${currentIndex + 1}`;
  title.textContent = name;
  counter.textContent = `${currentIndex + 1} / ${images.length}`;

  // Clear previous grid
  grid.innerHTML = "";

  // Create a cell for each filter
  for (const filter of FILTER_OPTIONS) {
    const cell = document.createElement("div");
    cell.className = "filter-preview-cell";

    if (isFlagged(imgEl, filter)) {
      cell.classList.add("filter-preview-cell-flagged");
    }

    const canvas = renderFilteredCanvas(imgEl.img, filter);
    cell.appendChild(canvas);

    const label = document.createElement("span");
    label.className = "filter-preview-cell-label";
    label.textContent = FILTER_LABELS[filter] || filter;
    cell.appendChild(label);

    // Flag on click
    cell.addEventListener("click", () => {
      toggleFlag(imgEl, filter, renderFilteredCanvas(imgEl.img, filter), cell);
    });

    grid.appendChild(cell);
  }
}

// --- Navigation ---

function goNext() {
  if (state.images.length === 0) return;
  const next = (currentIndex + 1) % state.images.length;
  renderGrid(next);
}

function goPrev() {
  if (state.images.length === 0) return;
  const prev = (currentIndex - 1 + state.images.length) % state.images.length;
  renderGrid(prev);
}

// --- Place flagged images on canvas ---

function placeFlaggedImages() {
  if (flaggedItems.length === 0) return;

  pushUndo();

  // Place images in a row starting below the bottommost existing element
  let startY = 0;
  for (const img of state.images) {
    const bottom = img.y + img.h;
    if (bottom > startY) startY = bottom;
  }
  for (const shape of state.drawings) {
    if (shape.start) {
      const bottom = shape.start.y + (shape.h || 0);
      if (bottom > startY) startY = bottom;
    }
  }
  startY += 60; // gap below existing content

  let offsetX = 0;
  const gap = 40;

  for (const item of flaggedItems) {
    const canvas = item.canvas;
    const w = canvas.width;
    const h = canvas.height;

    // Convert canvas to an Image element for the canvas state
    const img = new Image();
    img.width = w;
    img.height = h;
    img.src = canvas.toDataURL("image/png");

    const newImg = {
      id: "img_" + state.elementIdCounter++,
      elementType: "image",
      img: img,
      x: offsetX,
      y: startY,
      w: w,
      h: h,
      fileName: `${item.sourceImg.fileName || item.sourceImg.name || "image"}_${item.filter}`,
    };

    state.images.push(newImg);
    spatialInsert(newImg);

    offsetX += w + gap;
  }

  render();
  scheduleSave();
  flaggedItems = [];
}

// --- Open / Close ---

export function openFilterPreview() {
  getDomRefs();

  if (state.images.length === 0) return;

  isActive = true;
  currentIndex = 0;
  flaggedItems = [];
  overlay.style.display = "flex";
  renderGrid(0);
  updateFlagCount();

  // Keyboard navigation
  keyHandler = (e) => {
    if (!isActive) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      goNext();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      goPrev();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFilterPreview();
    }
  };
  document.addEventListener("keydown", keyHandler, true);

  // Button listeners
  closeBtn.addEventListener("click", closeFilterPreview);
  prevBtn.addEventListener("click", goPrev);
  nextBtn.addEventListener("click", goNext);
}

export function closeFilterPreview() {
  getDomRefs();
  isActive = false;
  overlay.style.display = "none";
  grid.innerHTML = "";

  if (keyHandler) {
    document.removeEventListener("keydown", keyHandler, true);
    keyHandler = null;
  }

  closeBtn.removeEventListener("click", closeFilterPreview);
  prevBtn.removeEventListener("click", goPrev);
  nextBtn.removeEventListener("click", goNext);

  // Place any flagged images onto the canvas
  placeFlaggedImages();
}

export function isFilterPreviewActive() {
  return isActive;
}

/**
 * Initialize filter preview mode — wire toolbar button.
 */
export function initFilterPreviewMode() {
  const btn = document.getElementById("filter-preview-btn");
  if (btn) {
    btn.addEventListener("click", () => {
      if (isActive) {
        closeFilterPreview();
      } else {
        openFilterPreview();
      }
    });
  }
}
