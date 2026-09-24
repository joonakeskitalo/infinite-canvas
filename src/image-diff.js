/**
 * Image Diff Tool
 *
 * A tool mode with a non-blocking side panel — the same UX pattern as the
 * Accessibility Preview tool. When activated, a panel opens on the right side.
 * Select two or more image elements on the canvas (Shift-click to add to the
 * selection). The panel shows a single combined difference across all of them
 * — for each pixel it measures the spread (max - min per channel) across every
 * selected image, so a region lights up wherever the images disagree and stays
 * dark where they all match. Views:
 *
 *   - Combined Difference        (per-channel spread across all images)
 *   - Difference Heatmap         (per-pixel spread mapped to a color ramp)
 *   - Changed Pixels             (a binary mask of pixels above a threshold)
 *   - Mean (average)             (the average composite of all images)
 *
 * A summary reports the percent of pixels that differ and the mean spread. All
 * selected source images are shown once in a final section.
 *
 * The panel updates live as the canvas selection changes. Selecting fewer than
 * two images shows a hint. Any cell can be dragged onto the canvas or
 * Cmd/Ctrl-clicked to insert it as a new image element, mirroring the
 * accessibility preview tool.
 */

import { state, spatialInsert } from "./state.js";
import { screenToWorld, showToast } from "./utils.js";
import { render } from "./rendering.js";
import { pushUndo } from "./history.js";
import { scheduleSave } from "./persistence.js";

// Pixels whose per-channel max difference exceeds this (0-255) count as "changed"
// and are highlighted in the mask / heatmap views.
const DIFF_THRESHOLD = 16;

// --- Panel state ---
let panelOpen = false;
let panelEl = null;
let gridEl = null;
let summaryEl = null;
let lastPanelWidth = null; // remembers user-resized width within session

// Debounce timer for live updates as the selection changes.
let updateTimer = null;

// Remembers the last pair of image IDs we rendered so we can skip redundant
// recomputes when the selection has not meaningfully changed.
let lastRenderedKey = null;

// --- Fullscreen modal preview state (Shift+hover), mirrors accessibility preview ---
let modalOverlay = null;
let modalImg = null;
let modalLabel = null;
let isShiftHeld = false;
let hoveredCellData = null; // { dataURL, label } of the cell currently under the cursor

/**
 * Create an OffscreenCanvas with a DOM-canvas fallback.
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
 * Convert a canvas (OffscreenCanvas or DOM canvas) to a PNG data URL.
 */
function canvasToDataURL(canvas) {
  if (typeof OffscreenCanvas !== "undefined" && canvas instanceof OffscreenCanvas) {
    const tmp = document.createElement("canvas");
    tmp.width = canvas.width;
    tmp.height = canvas.height;
    tmp.getContext("2d").drawImage(canvas, 0, 0);
    return tmp.toDataURL("image/png");
  }
  return canvas.toDataURL("image/png");
}

/**
 * The natural (source) pixel size of an image element, honoring a crop region.
 * Returns { w, h } in source pixels.
 */
function naturalSize(el) {
  const natW = el.img.naturalWidth || el.img.width;
  const natH = el.img.naturalHeight || el.img.height;
  if (el.crop) {
    return { w: Math.max(1, Math.round(el.crop.w * natW)), h: Math.max(1, Math.round(el.crop.h * natH)) };
  }
  return { w: natW, h: natH };
}

/**
 * Rasterize an image element into ImageData at the given target size. Honors the
 * element's crop region so the diff reflects what is actually shown on canvas.
 * The image is scaled to exactly targetW x targetH (the caller chooses a shared
 * size so the two images line up pixel-for-pixel).
 */
function rasterizeImage(el, targetW, targetH) {
  const { canvas, ctx } = createOffscreen(targetW, targetH);
  ctx.clearRect(0, 0, targetW, targetH);

  const natW = el.img.naturalWidth || el.img.width;
  const natH = el.img.naturalHeight || el.img.height;

  if (el.crop) {
    const c = el.crop;
    ctx.drawImage(
      el.img,
      c.x * natW, c.y * natH, c.w * natW, c.h * natH,
      0, 0, targetW, targetH,
    );
  } else {
    ctx.drawImage(el.img, 0, 0, targetW, targetH);
  }

  return { imageData: ctx.getImageData(0, 0, targetW, targetH), canvas };
}

/**
 * Compute a single combined diff across N ImageData buffers of identical size.
 * For each pixel channel it measures the spread across all images (max - min),
 * so a pixel lights up wherever the images disagree and stays dark where they
 * all match. Also produces a mean (average) composite of the images.
 *
 * Returns the per-view canvases plus summary statistics.
 */
function computeCombinedDiff(datas, w, h) {
  const count = datas.length;
  const buffers = datas.map((d) => d.data);
  const len = buffers[0].length;
  const n = w * h;

  const diffData = new Uint8ClampedArray(len);
  const heatData = new Uint8ClampedArray(len);
  const maskData = new Uint8ClampedArray(len);
  const meanData = new Uint8ClampedArray(len);

  let changedPixels = 0;
  let totalDiff = 0;

  for (let i = 0; i < n; i++) {
    const o = i * 4;

    // Per-channel min / max / sum across all images.
    let minR = 255, minG = 255, minB = 255;
    let maxR = 0, maxG = 0, maxB = 0;
    let sumR = 0, sumG = 0, sumB = 0;
    for (let k = 0; k < count; k++) {
      const buf = buffers[k];
      const r = buf[o], g = buf[o + 1], b = buf[o + 2];
      if (r < minR) minR = r; if (r > maxR) maxR = r; sumR += r;
      if (g < minG) minG = g; if (g > maxG) maxG = g; sumG += g;
      if (b < minB) minB = b; if (b > maxB) maxB = b; sumB += b;
    }

    // Spread per channel — the combined difference.
    const dr = maxR - minR;
    const dg = maxG - minG;
    const db = maxB - minB;

    diffData[o] = dr;
    diffData[o + 1] = dg;
    diffData[o + 2] = db;
    diffData[o + 3] = 255;

    const mag = Math.max(dr, dg, db);
    totalDiff += (dr + dg + db) / 3;

    const heat = heatColor(mag / 255);
    heatData[o] = heat[0];
    heatData[o + 1] = heat[1];
    heatData[o + 2] = heat[2];
    heatData[o + 3] = 255;

    const changed = mag > DIFF_THRESHOLD;
    if (changed) changedPixels++;
    maskData[o] = changed ? 255 : 235;
    maskData[o + 1] = changed ? 60 : 235;
    maskData[o + 2] = changed ? 60 : 235;
    maskData[o + 3] = 255;

    // Mean composite (average of all images).
    meanData[o] = Math.round(sumR / count);
    meanData[o + 1] = Math.round(sumG / count);
    meanData[o + 2] = Math.round(sumB / count);
    meanData[o + 3] = 255;
  }

  return {
    canvases: {
      difference: imageDataToCanvas(new ImageData(diffData, w, h)),
      heatmap: imageDataToCanvas(new ImageData(heatData, w, h)),
      mask: imageDataToCanvas(new ImageData(maskData, w, h)),
      mean: imageDataToCanvas(new ImageData(meanData, w, h)),
    },
    stats: {
      changedPixels,
      totalPixels: n,
      changedPercent: n > 0 ? (changedPixels / n) * 100 : 0,
      meanDiff: n > 0 ? totalDiff / n : 0,
    },
  };
}

/**
 * Map a normalized magnitude t (0..1) to an [r,g,b] heatmap color.
 * Ramp: near-black (no change) -> blue -> cyan -> green -> yellow -> red.
 */
function heatColor(t) {
  if (t <= 0) return [20, 20, 30];
  // Piecewise linear ramp across five stops.
  const stops = [
    [20, 20, 60],    // very small
    [0, 120, 255],   // blue
    [0, 220, 180],   // teal
    [180, 230, 0],   // yellow-green
    [255, 40, 0],    // red
  ];
  const scaled = t * (stops.length - 1);
  const idx = Math.min(stops.length - 2, Math.floor(scaled));
  const f = scaled - idx;
  const c0 = stops[idx];
  const c1 = stops[idx + 1];
  return [
    Math.round(c0[0] + (c1[0] - c0[0]) * f),
    Math.round(c0[1] + (c1[1] - c0[1]) * f),
    Math.round(c0[2] + (c1[2] - c0[2]) * f),
  ];
}

/**
 * Put ImageData onto a fresh canvas and return it.
 */
function imageDataToCanvas(imageData) {
  const { canvas, ctx } = createOffscreen(imageData.width, imageData.height);
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

// The comparison / diff views rendered for each pair of images.
// The combined-diff views. Source images are rendered after these.
const DIFF_VIEWS = [
  { key: "difference", label: "Combined Difference" },
  { key: "heatmap", label: "Difference Heatmap" },
  { key: "mask", label: "Changed Pixels" },
  { key: "mean", label: "Mean (average)" },
];

const MAX_DIM = 1024;

/**
 * The selected image elements, in a stable order (by z-order) so the labelling
 * is consistent across selection re-orderings. Returns { images, ok } where ok
 * is true when there are at least two images.
 */
function getSelectedImages() {
  const images = state.selectedElements.filter((el) => el && el.elementType === "image");
  const sorted = [...images].sort((a, b) => {
    const ia = state.elementOrder.indexOf(a.id);
    const ib = state.elementOrder.indexOf(b.id);
    return ia - ib;
  });
  return { images: sorted, ok: sorted.length >= 2 };
}

// --- Panel content ---

/**
 * Rebuild the panel from the current selection. Produces a single combined diff
 * across all selected images (per-pixel spread), then shows every source image
 * once at the end. Shows a hint when fewer than two images are selected.
 */
function refreshDiff() {
  if (!panelOpen || !gridEl) return;

  const { images, ok } = getSelectedImages();

  if (!ok) {
    lastRenderedKey = null;
    showHint(images.length);
    return;
  }

  // Skip recompute if the same set of images (and crops) is already rendered.
  const key = images.map((el) => el.id + ":" + selectionCropKey(el)).join("|");
  if (key === lastRenderedKey && gridEl.querySelector(".image-diff-cell")) return;
  lastRenderedKey = key;

  gridEl.innerHTML = "";

  const n = images.length;

  // Shared working size: the largest natural dimension across all images (capped
  // by MAX_DIM) so every image is scaled to the same grid and the diff aligns.
  const sizes = images.map(naturalSize);
  let targetW = Math.max(...sizes.map((s) => s.w));
  let targetH = Math.max(...sizes.map((s) => s.h));
  if (targetW > MAX_DIM || targetH > MAX_DIM) {
    const s = MAX_DIM / Math.max(targetW, targetH);
    targetW = Math.max(1, Math.round(targetW * s));
    targetH = Math.max(1, Math.round(targetH * s));
  }

  const rasters = images.map((el) => rasterizeImage(el, targetW, targetH));
  const { canvases, stats } = computeCombinedDiff(rasters.map((r) => r.imageData), targetW, targetH);

  // Inserted cells match the on-canvas footprint of the compared images.
  const placeW = Math.max(...images.map((el) => el.w));
  const placeH = Math.max(...images.map((el) => el.h));

  const anyMismatch = sizes.some((s) => s.w !== sizes[0].w || s.h !== sizes[0].h);
  const pct = stats.changedPercent;
  const pctStr = pct >= 10 ? pct.toFixed(1) : pct.toFixed(2);
  if (summaryEl) {
    summaryEl.innerHTML = `
      Combined diff of <span class="image-diff-summary-strong">${n}</span> images
      · <span class="image-diff-summary-strong">${pctStr}%</span> of pixels differ
      · mean ${stats.meanDiff.toFixed(1)}/255${anyMismatch ? " · sizes differ, scaled to align" : ""}
    `;
  }

  // Single combined-diff section.
  for (const { key: viewKey, label } of DIFF_VIEWS) {
    appendCell(canvases[viewKey], label, placeW, placeH);
  }

  // Source images, once, at the end.
  renderSourcesSection(images, rasters);
}

/**
 * A cheap fingerprint of an image's crop so we recompute when a crop changes.
 */
function selectionCropKey(el) {
  if (!el.crop) return "full";
  const c = el.crop;
  return `${c.x.toFixed(4)},${c.y.toFixed(4)},${c.w.toFixed(4)},${c.h.toFixed(4)}`;
}

/**
 * Append a section header spanning the full grid width.
 */
function appendSectionHeader(title, subtitle) {
  const header = document.createElement("div");
  header.className = "image-diff-section-header";
  const titleEl = document.createElement("span");
  titleEl.className = "image-diff-section-title";
  titleEl.textContent = title;
  header.appendChild(titleEl);
  if (subtitle) {
    const subEl = document.createElement("span");
    subEl.className = "image-diff-section-subtitle";
    subEl.innerHTML = subtitle;
    header.appendChild(subEl);
  }
  gridEl.appendChild(header);
}

/**
 * Append one preview cell (image + label) to the grid, wired for drag-to-canvas,
 * shift-hover modal, and Cmd/Ctrl-click insert. `worldW`/`worldH` are the
 * on-canvas dimensions used when inserting the cell as a new image element.
 */
function appendCell(canvas, label, worldW, worldH) {
  const dataURL = canvasToDataURL(canvas);

  const cell = document.createElement("div");
  cell.className = "image-diff-cell";

  const imgWrapper = document.createElement("div");
  imgWrapper.className = "image-diff-img-wrapper";

  const img = document.createElement("img");
  img.src = dataURL;
  img.alt = label;
  img.className = "image-diff-img";
  img.draggable = true;
  imgWrapper.appendChild(img);

  const labelEl = document.createElement("div");
  labelEl.className = "image-diff-label";
  labelEl.textContent = label;

  cell.appendChild(imgWrapper);
  cell.appendChild(labelEl);
  gridEl.appendChild(cell);

  // Drag onto the canvas to insert as a new image.
  img.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", "image-diff-drag");
    e.dataTransfer.setData("application/x-image-diff", JSON.stringify({
      dataURL, w: worldW, h: worldH, label,
    }));
    e.dataTransfer.effectAllowed = "copy";
  });

  // Shift+hover: fullscreen modal preview.
  cell.addEventListener("mouseenter", () => {
    hoveredCellData = { dataURL, label };
    if (isShiftHeld) showModal(dataURL, label);
  });
  cell.addEventListener("mouseleave", () => {
    if (hoveredCellData && hoveredCellData.dataURL === dataURL) hoveredCellData = null;
    if (isShiftHeld) showModalBackdrop();
  });

  // Cmd/Ctrl-click: insert onto canvas.
  cell.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      insertImageToCanvas(dataURL, worldW, worldH, label);
    }
  });
}

/**
 * Render each source image once, in its own section at the end. Reuses the
 * rasterized canvases already produced for the combined diff.
 */
function renderSourcesSection(images, rasters) {
  appendSectionHeader("Source images", `${images.length} selected`);
  images.forEach((el, idx) => {
    appendCell(rasters[idx].canvas, `Image ${idx + 1}`, el.w, el.h);
  });
}

/**
 * Show a hint in place of the grid when the selection is not exactly two images.
 */
function showHint(count) {
  if (!gridEl) return;
  gridEl.innerHTML = "";
  if (summaryEl) summaryEl.innerHTML = "";

  const message = count === 1
    ? "One image selected. Shift-click one or more images to compare them."
    : "Select two or more images on the canvas to compare them. Click one, then Shift-click others. Every image is diffed against every other.";

  const hint = document.createElement("div");
  hint.className = "image-diff-empty";
  hint.innerHTML = `
    <div class="image-diff-empty-icon">
      <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="4" width="7" height="16" rx="1.5"/>
        <rect x="14" y="4" width="7" height="16" rx="1.5"/>
        <path d="M10 12h4" stroke-dasharray="2 2"/>
      </svg>
    </div>
    <p>${message}</p>
  `;
  gridEl.appendChild(hint);
}

/**
 * Insert a generated diff image onto the canvas at the center of the viewport.
 */
function insertImageToCanvas(dataURL, w, h, label) {
  const img = new Image();
  img.onload = () => {
    pushUndo();
    const cx = (-state.transform.x + window.innerWidth / 2) / state.transform.zoom;
    const cy = (-state.transform.y + window.innerHeight / 2) / state.transform.zoom;

    // Place at the on-canvas size of the compared images (passed as w/h).
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
 * Handle drop of a diff cell back onto the canvas.
 */
export function handleImageDiffDrop(e) {
  const payload = e.dataTransfer.getData("application/x-image-diff");
  if (!payload) return false;
  e.preventDefault();
  const { dataURL, w, h, label } = JSON.parse(payload);
  const worldPos = screenToWorld(e.clientX, e.clientY);

  const img = new Image();
  img.onload = () => {
    pushUndo();
    // Place at the on-canvas size of the compared images (passed as w/h).
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
 * Called by the interaction layer whenever the canvas selection changes while
 * the image-diff tool is active, so the panel can update live.
 */
export function imageDiffSelectionChanged() {
  if (!panelOpen) return;
  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = setTimeout(() => {
    updateTimer = null;
    refreshDiff();
  }, 60);
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
    lastPanelWidth = panel.offsetWidth;
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

export function openPanel() {
  if (panelOpen) return;
  panelOpen = true;

  const panel = document.createElement("div");
  panel.id = "image-diff-panel";
  panel.className = "image-diff-panel";
  if (lastPanelWidth) panel.style.width = lastPanelWidth + "px";

  const resizeHandle = document.createElement("div");
  resizeHandle.className = "image-diff-resize-handle";
  panel.appendChild(resizeHandle);
  setupPanelResizeHandle(resizeHandle, panel);

  const header = document.createElement("div");
  header.className = "image-diff-header";

  const title = document.createElement("span");
  title.className = "image-diff-title";
  title.textContent = "Image Diff";

  const closeBtn = document.createElement("button");
  closeBtn.className = "image-diff-close";
  closeBtn.title = "Close (Escape)";
  closeBtn.innerHTML = "&times;";
  closeBtn.addEventListener("click", closePanel);

  header.appendChild(title);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const summary = document.createElement("div");
  summary.className = "image-diff-summary";
  panel.appendChild(summary);

  const grid = document.createElement("div");
  grid.className = "image-diff-grid";
  panel.appendChild(grid);

  document.body.appendChild(panel);

  panelEl = panel;
  gridEl = grid;
  summaryEl = summary;
  lastRenderedKey = null;

  document.addEventListener("keydown", onKeyDownForModal);
  document.addEventListener("keyup", onKeyUpForModal);

  refreshDiff();
}

export function closePanel() {
  if (!panelOpen) return;
  panelOpen = false;

  document.removeEventListener("keydown", onKeyDownForModal);
  document.removeEventListener("keyup", onKeyUpForModal);
  isShiftHeld = false;
  hoveredCellData = null;
  hideModal();

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
    summaryEl = null;
  }
  lastRenderedKey = null;
}

/**
 * Tool enter/leave hooks used by the interaction layer.
 */
export function activateImageDiff() {
  if (!panelOpen) openPanel();
  else refreshDiff();
}

export function deactivateImageDiff() {
  closePanel();
}

export function isImageDiffPanelOpen() {
  return panelOpen;
}

// --- Fullscreen modal preview (Shift+hover) ---

function ensureModalOverlay() {
  if (modalOverlay) return;
  modalOverlay = document.createElement("div");
  modalOverlay.className = "image-diff-modal-overlay";
  modalImg = document.createElement("img");
  modalImg.className = "image-diff-modal-img";
  modalLabel = document.createElement("div");
  modalLabel.className = "image-diff-modal-label";
  modalOverlay.appendChild(modalImg);
  modalOverlay.appendChild(modalLabel);
  document.body.appendChild(modalOverlay);
}

function showModal(dataURL, label) {
  ensureModalOverlay();
  modalImg.src = dataURL;
  modalImg.style.opacity = "1";
  modalLabel.textContent = label;
  modalLabel.style.visibility = "visible";
  if (panelEl) {
    const panelWidth = window.innerWidth - panelEl.getBoundingClientRect().left;
    modalOverlay.style.paddingRight = panelWidth + "px";
  } else {
    modalOverlay.style.paddingRight = "0";
  }
  modalOverlay.classList.add("visible");
}

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

function hideModal() {
  if (modalOverlay) modalOverlay.classList.remove("visible");
}

function onKeyDownForModal(e) {
  if (e.key === "Shift") {
    isShiftHeld = true;
    if (hoveredCellData) {
      showModal(hoveredCellData.dataURL, hoveredCellData.label);
    } else if (gridEl && gridEl.matches(":hover")) {
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
