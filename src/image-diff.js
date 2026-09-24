/**
 * Image Diff Tool
 *
 * A tool mode with a non-blocking side panel — the same UX pattern as the
 * Accessibility Preview tool. When activated, a panel opens on the right side.
 * Select exactly two image elements on the canvas (Shift-click to add to the
 * selection) and the panel shows the visual difference between them in several
 * complementary views:
 *
 *   - Image A / Image B          (the two sources, normalized to a common size)
 *   - Difference                 (absolute per-channel |A-B|, brightened)
 *   - Heatmap                    (per-pixel magnitude mapped to a color ramp)
 *   - Changed Pixels             (a binary mask of pixels above a threshold)
 *   - A over B (50%)             (a blend, handy for spotting registration shifts)
 *
 * A summary line reports how many pixels changed and the mean difference.
 *
 * The panel updates live as the canvas selection changes. Selecting other than
 * two images shows a hint. Diff view cells can be dragged onto the canvas or
 * Cmd/Ctrl-clicked to insert them as new image elements, mirroring the
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

// The diff views computed once two images are available. `key` selects which
// renderer runs; `label` is shown under each cell.
const DIFF_VIEWS = [
  { key: "difference", label: "Difference" },
  { key: "heatmap", label: "Difference Heatmap" },
  { key: "mask", label: "Changed Pixels" },
  { key: "blend", label: "A over B (50%)" },
  { key: "a", label: "Image A" },
  { key: "b", label: "Image B" },
];

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
 * Compute all diff products from two ImageData buffers of identical size.
 * Returns the per-view canvases plus summary statistics.
 */
function computeDiff(dataA, dataB, w, h) {
  const a = dataA.data;
  const b = dataB.data;
  const n = w * h;

  // Output buffers for each computed view.
  const diffData = new Uint8ClampedArray(a.length);
  const heatData = new Uint8ClampedArray(a.length);
  const maskData = new Uint8ClampedArray(a.length);
  const blendData = new Uint8ClampedArray(a.length);

  let changedPixels = 0;
  let totalDiff = 0;

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const dr = Math.abs(a[o] - b[o]);
    const dg = Math.abs(a[o + 1] - b[o + 1]);
    const db = Math.abs(a[o + 2] - b[o + 2]);

    // Absolute difference view (per channel), fully opaque.
    diffData[o] = dr;
    diffData[o + 1] = dg;
    diffData[o + 2] = db;
    diffData[o + 3] = 255;

    // Magnitude of change for this pixel (max channel delta).
    const mag = Math.max(dr, dg, db);
    totalDiff += (dr + dg + db) / 3;

    // Heatmap: blue (small) -> green -> red (large).
    const t = mag / 255;
    const heat = heatColor(t);
    heatData[o] = heat[0];
    heatData[o + 1] = heat[1];
    heatData[o + 2] = heat[2];
    heatData[o + 3] = 255;

    // Binary mask: changed pixels are red, unchanged are light gray so the
    // changed regions stand out clearly.
    const changed = mag > DIFF_THRESHOLD;
    if (changed) changedPixels++;
    maskData[o] = changed ? 255 : 235;
    maskData[o + 1] = changed ? 60 : 235;
    maskData[o + 2] = changed ? 60 : 235;
    maskData[o + 3] = 255;

    // 50/50 blend of the two images.
    blendData[o] = (a[o] + b[o]) >> 1;
    blendData[o + 1] = (a[o + 1] + b[o + 1]) >> 1;
    blendData[o + 2] = (a[o + 2] + b[o + 2]) >> 1;
    blendData[o + 3] = 255;
  }

  return {
    canvases: {
      difference: imageDataToCanvas(new ImageData(diffData, w, h)),
      heatmap: imageDataToCanvas(new ImageData(heatData, w, h)),
      mask: imageDataToCanvas(new ImageData(maskData, w, h)),
      blend: imageDataToCanvas(new ImageData(blendData, w, h)),
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

/**
 * The two image elements to diff, in a stable order (by z-order) so "A" and "B"
 * are consistent across selection re-orderings. Returns null when the selection
 * is not exactly two images.
 */
function getSelectedImagePair() {
  const images = state.selectedElements.filter((el) => el && el.elementType === "image");
  if (images.length !== 2) return { images, ok: false };

  // Order by z-order (elementOrder index) for a stable A/B assignment.
  const sorted = [...images].sort((a, b) => {
    const ia = state.elementOrder.indexOf(a.id);
    const ib = state.elementOrder.indexOf(b.id);
    return ia - ib;
  });
  return { images: sorted, ok: true };
}

// --- Panel content ---

/**
 * Rebuild the panel grid from the current selection. Shows a hint when the
 * selection is not exactly two images.
 */
function refreshDiff() {
  if (!panelOpen || !gridEl) return;

  const { images, ok } = getSelectedImagePair();

  if (!ok) {
    lastRenderedKey = null;
    showHint(images.length);
    return;
  }

  const [elA, elB] = images;

  // Skip recompute if the same pair is already rendered.
  const key = elA.id + "|" + elB.id + "|" + selectionCropKey(elA) + "|" + selectionCropKey(elB);
  if (key === lastRenderedKey && gridEl.querySelector(".image-diff-cell")) return;
  lastRenderedKey = key;

  // Choose a shared working size: the larger of the two natural sizes, capped so
  // we don't allocate huge buffers. Both images are scaled to this size so the
  // comparison is pixel-aligned.
  const sizeA = naturalSize(elA);
  const sizeB = naturalSize(elB);
  const MAX_DIM = 1024;
  let targetW = Math.max(sizeA.w, sizeB.w);
  let targetH = Math.max(sizeA.h, sizeB.h);
  if (targetW > MAX_DIM || targetH > MAX_DIM) {
    const s = MAX_DIM / Math.max(targetW, targetH);
    targetW = Math.max(1, Math.round(targetW * s));
    targetH = Math.max(1, Math.round(targetH * s));
  }

  const rasterA = rasterizeImage(elA, targetW, targetH);
  const rasterB = rasterizeImage(elB, targetW, targetH);

  const { canvases, stats } = computeDiff(rasterA.imageData, rasterB.imageData, targetW, targetH);

  const cellCanvases = {
    a: rasterA.canvas,
    b: rasterB.canvas,
    ...canvases,
  };

  // The diff canvases share the aspect ratio of `targetW x targetH`. When a cell
  // is inserted onto the canvas we want it to match the on-canvas footprint of
  // the images being compared, not the raw pixel buffer size. Use the larger of
  // the two selected images' on-canvas dimensions.
  const placeW = Math.max(elA.w, elB.w);
  const placeH = Math.max(elA.h, elB.h);

  renderGrid(cellCanvases, placeW, placeH);
  renderSummary(stats, sizeA, sizeB);
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
 * Render the grid of diff view cells.
 */
function renderGrid(cellCanvases, worldW, worldH) {
  gridEl.innerHTML = "";

  for (const { key, label } of DIFF_VIEWS) {
    const canvas = cellCanvases[key];
    if (!canvas) continue;

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
}

/**
 * Render the summary statistics line under the header.
 */
function renderSummary(stats, sizeA, sizeB) {
  if (!summaryEl) return;
  const pct = stats.changedPercent;
  const pctStr = pct >= 10 ? pct.toFixed(1) : pct.toFixed(2);
  const mismatch = (sizeA.w !== sizeB.w || sizeA.h !== sizeB.h);
  const dimNote = mismatch
    ? ` · sizes differ (${sizeA.w}×${sizeA.h} vs ${sizeB.w}×${sizeB.h}), scaled to align`
    : "";
  summaryEl.innerHTML = `
    <span class="image-diff-summary-strong">${pctStr}%</span> of pixels changed
    · mean diff ${stats.meanDiff.toFixed(1)}/255
    · ${stats.changedPixels.toLocaleString()} of ${stats.totalPixels.toLocaleString()} px${dimNote}
  `;
}

/**
 * Show a hint in place of the grid when the selection is not exactly two images.
 */
function showHint(count) {
  if (!gridEl) return;
  gridEl.innerHTML = "";
  if (summaryEl) summaryEl.innerHTML = "";

  const message = count > 2
    ? `You have ${count} images selected. Select exactly two to compare.`
    : count === 1
      ? "One image selected. Shift-click another image to compare the two."
      : "Select two images on the canvas to see their visual difference. Click one, then Shift-click another.";

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
