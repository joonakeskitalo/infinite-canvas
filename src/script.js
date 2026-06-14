import { applyFilterToImageData } from "./filter-kernels.js";
import { FILTER_OPTIONS, FILTER_LABELS } from "./color-filter.js";

const container = document.getElementById("canvas-container");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const ghostInput = document.getElementById("text-ghost-input");
const fontSizeSelect = document.getElementById("font-size-select");
const zoomSlider = document.getElementById("zoom-slider");
const zoomValDisplay = document.getElementById("zoom-val");
const exportBtn = document.getElementById("export-btn");

const downloadImagesBtn = document.getElementById("download-images-btn");
const centerCanvasBtn = document.getElementById("center-canvas-btn");
const alignmentPanel = document.getElementById("alignment-panel");
const toast = document.getElementById("toast");
const bgColorPicker = document.getElementById("bg-color-picker");

const GRID_SIZE = 100;
const CONSTANT_LINE_WIDTH = 4;
const RESIZE_HANDLE_SIZE = 10;

let currentTool = "pan";
let preSpaceTool = null;
let drawColor = "#ff4444";
let bgColor = "#f0f0f0";
let currentFontSize = 32;
let transform = { x: 0, y: 0, zoom: 1 };

let isInteracting = false;
let startX, startY;
let panLockDirection = null;
let isMiddleClick = false;
let isRightClickHand = false;
let lastMousePos = {
  x: window.innerWidth / 2,
  y: window.innerHeight / 2,
};
let isShiftPressed = false;
let isSpacePressed = false;

let images = [];
let drawings = [];
let activeShape = null;
let activeTextCoord = null;

let selectedElements = [];
let isRegionSelecting = false;
let regionStart = { x: 0, y: 0 };
let regionEnd = { x: 0, y: 0 };
let dragOffsets = [];
let resizingElement = null;
let resizeStartBounds = null;

let elementIdCounter = 0;
let activeSnapGuides = []; // {axis: 'x'|'y', pos: number} for rendering
let activeProximityGuides = []; // {axis: 'x'|'y', pos: number, from: number, to: number} for proximity lines
let activeSpacingGuides = []; // {axis: 'x'|'y', from: number, to: number, pos: number, dist: number, isEqual: boolean}
let clipboardElements = []; // internal clipboard for copy/paste
let pasteOffset = 0; // increments each paste to offset duplicates
let internalCopyPerformed = false; // true when last copy was from canvas selection

// --- MEASUREMENT TOOL STATE ---
let measureHoverGuides = []; // distance guides shown on hover when measure tool active
let activeMeasureLine = null; // live measurement line while dragging

// --- SWAP TOOL STATE ---
let swapHoveredElement = null; // element currently hovered that is also selected
let isSwapDragging = false; // true while dragging from swap handle
let swapSourceElement = null; // source element for the swap operation
let swapDragWorldPos = null; // current world position during swap drag
let swapTargetElement = null; // element under cursor during swap drag

// --- CROP MODE STATE ---
let cropMode = false; // true when in crop mode
let cropTarget = null; // the image element being cropped
let cropRect = null; // {x, y, w, h} in world coords — the crop region
let cropDragEdge = null; // which edge/corner is being dragged: 'n','s','e','w','ne','nw','se','sw'
let cropDragStart = null; // starting mouse world position for crop drag

// --- COLOR FILTER SYSTEM ---
let currentFilter = "none";

// Cache for filtered image canvases (invalidated when filter changes)
let filteredImageCache = new WeakMap();
let filteredImageCacheFilter = "none";

// --- PERFORMANCE: requestAnimationFrame batching ---
let _renderScheduled = false;
let _renderAfterCallbacks = [];

function scheduleRender() {
  if (!_renderScheduled) {
    _renderScheduled = true;
    requestAnimationFrame(() => {
      _renderScheduled = false;
      _doRender(ctx, false);
      // Run any post-render callbacks (e.g., rulers)
      const cbs = _renderAfterCallbacks;
      _renderAfterCallbacks = [];
      for (let i = 0; i < cbs.length; i++) cbs[i]();
    });
  }
}

function addRenderCallback(cb) {
  _renderAfterCallbacks.push(cb);
}

// --- PERFORMANCE: Viewport culling helper ---
function getViewportBounds() {
  // Returns the visible world-space rectangle with some padding
  const pad = 100 / transform.zoom; // extra padding to avoid pop-in
  return {
    minX: -transform.x / transform.zoom - pad,
    minY: -transform.y / transform.zoom - pad,
    maxX: (-transform.x + canvas.width) / transform.zoom + pad,
    maxY: (-transform.y + canvas.height) / transform.zoom + pad,
  };
}

function isRectInViewport(x, y, w, h, vp) {
  return !(x + w < vp.minX || x > vp.maxX || y + h < vp.minY || y > vp.maxY);
}

// --- PERFORMANCE: Text measurement cache ---
const _textMeasureCache = new WeakMap();

function getFilteredImage(imgData) {
  // Invalidate cache if filter changed
  if (filteredImageCacheFilter !== currentFilter) {
    filteredImageCache = new WeakMap();
    filteredImageCacheFilter = currentFilter;
  }

  // Return cached version if available
  if (filteredImageCache.has(imgData.img)) {
    return filteredImageCache.get(imgData.img);
  }

  // Render filtered version to an offscreen canvas
  const w = imgData.img.naturalWidth || imgData.img.width;
  const h = imgData.img.naturalHeight || imgData.img.height;
  const offscreen = document.createElement("canvas");
  offscreen.width = w;
  offscreen.height = h;
  const offCtx = offscreen.getContext("2d");
  offCtx.drawImage(imgData.img, 0, 0);
  const imageData = offCtx.getImageData(0, 0, w, h);
  applyFilterToImageData(imageData, currentFilter);
  offCtx.putImageData(imageData, 0, 0);

  filteredImageCache.set(imgData.img, offscreen);
  return offscreen;
}

// --- CROP MODE FUNCTIONS ---

function enterCropMode(imgElement) {
  cropMode = true;
  cropTarget = imgElement;

  if (imgElement.crop && imgElement.fullBounds) {
    // Re-entering crop on an already-cropped image.
    // Reconstruct full bounds relative to current element position.
    // The element shows crop region {crop.x, crop.y, crop.w, crop.h} of the full image.
    // So: el.x = fullX + crop.x * fullW, el.y = fullY + crop.y * fullH
    //     el.w = crop.w * fullW, el.h = crop.h * fullH
    const c = imgElement.crop;
    const fullW = imgElement.w / c.w;
    const fullH = imgElement.h / c.h;
    const fullX = imgElement.x - c.x * fullW;
    const fullY = imgElement.y - c.y * fullH;
    imgElement.fullBounds = { x: fullX, y: fullY, w: fullW, h: fullH };
    cropRect = { x: imgElement.x, y: imgElement.y, w: imgElement.w, h: imgElement.h };
  } else {
    // First time cropping: initialize crop rect to the full image bounds
    cropRect = { x: imgElement.x, y: imgElement.y, w: imgElement.w, h: imgElement.h };
    imgElement.fullBounds = { x: imgElement.x, y: imgElement.y, w: imgElement.w, h: imgElement.h };
  }

  selectedElements = [imgElement];
  showToast("Crop mode — drag edges to crop, Enter to apply, Escape to cancel");
}

function getFullImageBounds(imgElement) {
  // Returns the world-space bounds of the full (uncropped) image
  if (imgElement.fullBounds) {
    return { ...imgElement.fullBounds };
  }
  return { x: imgElement.x, y: imgElement.y, w: imgElement.w, h: imgElement.h };
}

function exitCropMode(apply) {
  if (!cropMode || !cropTarget) return;
  if (apply && cropRect) {
    const el = cropTarget;
    const full = getFullImageBounds(el);

    // Compute the crop rect as a fraction of the full image bounds
    const fracX = Math.max(0, Math.min(1, (cropRect.x - full.x) / full.w));
    const fracY = Math.max(0, Math.min(1, (cropRect.y - full.y) / full.h));
    const fracW = Math.max(0.01, Math.min(1 - fracX, cropRect.w / full.w));
    const fracH = Math.max(0.01, Math.min(1 - fracY, cropRect.h / full.h));

    // Check if this is actually a crop (not the full image)
    const isCropped = fracX > 0.001 || fracY > 0.001 || fracW < 0.999 || fracH < 0.999;

    pushUndo();

    if (isCropped) {
      el.crop = { x: fracX, y: fracY, w: fracW, h: fracH };
      // Ensure fullBounds is stored
      if (!el.fullBounds) {
        el.fullBounds = { ...full };
      }
      // Update the element's display position/size to match the crop rect
      el.x = cropRect.x;
      el.y = cropRect.y;
      el.w = cropRect.w;
      el.h = cropRect.h;
    } else {
      // User expanded back to full image — remove crop
      delete el.crop;
      el.x = full.x;
      el.y = full.y;
      el.w = full.w;
      el.h = full.h;
      // Keep fullBounds for future reference (position may have drifted)
    }

    showToast(isCropped ? "Crop applied" : "Crop removed");
    scheduleSave();
  }
  cropMode = false;
  cropTarget = null;
  cropRect = null;
  cropDragEdge = null;
  cropDragStart = null;
  render();
}

function getCropEdgeAtPoint(worldPos) {
  if (!cropRect) return null;
  const threshold = 8 / transform.zoom;
  const r = cropRect;
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

  // Corners first (higher priority)
  if (nearLeft && nearTop) return "nw";
  if (nearRight && nearTop) return "ne";
  if (nearLeft && nearBottom) return "sw";
  if (nearRight && nearBottom) return "se";

  // Edges
  if (nearTop && withinX) return "n";
  if (nearBottom && withinX) return "s";
  if (nearLeft && withinY) return "w";
  if (nearRight && withinY) return "e";

  return null;
}

function getCropCursor(edge) {
  switch (edge) {
    case "n": case "s": return "ns-resize";
    case "e": case "w": return "ew-resize";
    case "nw": case "se": return "nwse-resize";
    case "ne": case "sw": return "nesw-resize";
    default: return "crosshair";
  }
}

// --- UNDO / REDO SYSTEM ---
const MAX_HISTORY = 50;
let undoStack = [];
let redoStack = [];

function captureState() {
  // Serialize current canvas state (images + drawings) into a snapshot
  return {
    images: images.map((el) => serializeElement(el)),
    drawings: drawings.map((el) => serializeElement(el)),
  };
}

function serializeElement(el) {
  if (el.elementType === "image") {
    const serialized = {
      id: el.id,
      elementType: "image",
      img: el.img,
      x: el.x,
      y: el.y,
      w: el.w,
      h: el.h,
      groupId: el.groupId || null,
      opacity: el.opacity != null ? el.opacity : 1,
    };
    if (el.crop) serialized.crop = { ...el.crop };
    if (el.fullBounds) serialized.fullBounds = { ...el.fullBounds };
    return serialized;
  }
  const clone = {
    id: el.id,
    elementType: el.elementType,
    type: el.type,
    color: el.color,
    width: el.width,
    groupId: el.groupId || null,
    opacity: el.opacity != null ? el.opacity : 1,
  };
  if (el.type === "pen") {
    clone.points = el.points.map((p) => ({ x: p.x, y: p.y }));
  } else if (el.type === "text") {
    clone.text = el.text;
    clone.fontSize = el.fontSize;
    clone.start = { x: el.start.x, y: el.start.y };
    if (el.w) clone.w = el.w;
    if (el.h) clone.h = el.h;
    if (el.bgColor) clone.bgColor = el.bgColor;
  } else {
    clone.start = { x: el.start.x, y: el.start.y };
    if (el.end) clone.end = { x: el.end.x, y: el.end.y };
  }
  return clone;
}

function restoreState(state) {
  images = state.images.map((el) => ({ ...el }));
  drawings = state.drawings.map((el) => {
    const d = { ...el };
    if (d.type === "pen") d.points = el.points.map((p) => ({ ...p }));
    else if (d.start) d.start = { ...el.start };
    if (d.end) d.end = { ...el.end };
    return d;
  });
  selectedElements = [];
  toggleAlignmentPanelVisibility();
  render();
}

function pushUndo() {
  undoStack.push(captureState());
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack = [];
  updateUndoRedoButtons();
  scheduleSave();
}

function undo() {
  if (undoStack.length === 0) return;
  if (cropMode) { cropMode = false; cropTarget = null; cropRect = null; cropDragEdge = null; cropDragStart = null; }
  redoStack.push(captureState());
  const state = undoStack.pop();
  restoreState(state);
  updateUndoRedoButtons();
  scheduleSave();
  showToast("Undo");
}

function redo() {
  if (redoStack.length === 0) return;
  if (cropMode) { cropMode = false; cropTarget = null; cropRect = null; cropDragEdge = null; cropDragStart = null; }
  undoStack.push(captureState());
  const state = redoStack.pop();
  restoreState(state);
  updateUndoRedoButtons();
  scheduleSave();
  showToast("Redo");
}

function updateUndoRedoButtons() {
  const undoBtn = document.getElementById("undo-btn");
  const redoBtn = document.getElementById("redo-btn");
  undoBtn.style.opacity = undoStack.length > 0 ? "1" : "0.4";
  undoBtn.style.pointerEvents = undoStack.length > 0 ? "auto" : "none";
  redoBtn.style.opacity = redoStack.length > 0 ? "1" : "0.4";
  redoBtn.style.pointerEvents = redoStack.length > 0 ? "auto" : "none";
}

document.getElementById("undo-btn").addEventListener("click", undo);
document.getElementById("redo-btn").addEventListener("click", redo);

// --- FILE-BASED PERSISTENCE (ZIP format via JSZip) ---
let fileHandle = null; // Persistent file handle for autosave
let saveTimeout = null;
let isDirty = false;

function scheduleSave() {
  isDirty = true;
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(autoSave, 500);
}

function dataURLToBlob(dataURL) {
  const [header, base64] = dataURL.split(",");
  const mime = header.match(/:(.*?);/)[1];
  const binary = atob(base64);
  const array = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) array[i] = binary.charCodeAt(i);
  return new Blob([array], { type: mime });
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function buildZipBlob() {
  const zip = new JSZip();
  const imgFolder = zip.folder("images");

  // Build manifest with image references as filenames instead of data URLs
  const imageEntries = [];
  for (let i = 0; i < images.length; i++) {
    const el = images[i];
    const src = el.img.src;
    // Determine file extension from data URL mime type
    const mime = src.match(/data:(.*?);/);
    const ext = mime ? mime[1].split("/")[1].replace("jpeg", "jpg") : "png";
    const filename = `${el.id}.${ext}`;

    // Store raw binary in zip
    imgFolder.file(filename, dataURLToBlob(src));

    imageEntries.push({
      id: el.id,
      elementType: "image",
      file: filename,
      x: el.x,
      y: el.y,
      w: el.w,
      h: el.h,
      groupId: el.groupId || null,
      opacity: el.opacity != null ? el.opacity : 1,
      crop: el.crop || null,
      fullBounds: el.fullBounds || null,
    });
  }

  const manifest = {
    version: 2,
    images: imageEntries,
    drawings: drawings.map((el) => serializeElement(el)),
    transform: transform,
    bgColor: bgColor,
    drawColor: drawColor,
    currentFilter: currentFilter,
  };

  zip.file("manifest.json", JSON.stringify(manifest));
  return await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

async function autoSave() {
  if (!fileHandle) return;
  try {
    const blob = await buildZipBlob();
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    isDirty = false;
  } catch (e) {
    console.warn("Autosave failed:", e.message);
  }
}

async function saveAs() {
  try {
    fileHandle = await window.showSaveFilePicker({
      suggestedName: "canvas.icv",
      types: [
        {
          description: "Infinite Canvas File",
          accept: { "application/zip": [".icv"] },
        },
      ],
    });
    await autoSave();
    showToast("Saved to " + fileHandle.name);
  } catch (e) {
    if (e.name !== "AbortError") console.warn("Save failed:", e.message);
  }
}

async function saveFile() {
  if (!fileHandle) {
    await saveAs();
  } else {
    await autoSave();
    showToast("Saved");
  }
}

async function openFile() {
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [
        {
          description: "Infinite Canvas File",
          accept: { "application/zip": [".icv"] },
        },
      ],
    });
    const file = await handle.getFile();
    const arrayBuf = await file.arrayBuffer();
    await restoreFromZip(arrayBuf);
    fileHandle = handle;
    showToast("Loaded " + handle.name);
  } catch (e) {
    if (e.name !== "AbortError") console.warn("Open failed:", e.message);
  }
}

async function restoreFromZip(arrayBuf) {
  const zip = await JSZip.loadAsync(arrayBuf);
  const manifestText = await zip.file("manifest.json").async("string");
  const manifest = JSON.parse(manifestText);

  // Restore drawings
  drawings = (manifest.drawings || []).map((el) => {
    const d = { ...el };
    if (d.type === "pen") d.points = el.points.map((p) => ({ ...p }));
    else if (d.start) d.start = { ...el.start };
    if (d.end) d.end = { ...el.end };
    return d;
  });

  // Restore images from zip blobs
  const imageData = manifest.images || [];
  images = [];

  if (imageData.length > 0) {
    const loadPromises = imageData.map(async (data) => {
      const imgFile = zip.file("images/" + data.file);
      if (!imgFile) return null;
      const blob = await imgFile.async("blob");
      const dataURL = await blobToDataURL(blob);
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const restored = {
            id: data.id,
            elementType: "image",
            img: img,
            x: data.x,
            y: data.y,
            w: data.w,
            h: data.h,
            groupId: data.groupId || null,
            opacity: data.opacity != null ? data.opacity : 1,
          };
          if (data.crop) restored.crop = { ...data.crop };
          if (data.fullBounds) restored.fullBounds = { ...data.fullBounds };
          resolve(restored);
        };
        img.onerror = () => resolve(null);
        img.src = dataURL;
      });
    });

    const loaded = await Promise.all(loadPromises);
    images = loaded.filter(Boolean);
  }

  restoreViewState(manifest, imageData);
  render();
}

function restoreViewState(state, imageData) {
  if (state.transform) {
    transform = state.transform;
    zoomSlider.value = Math.round(transform.zoom * 100);
    zoomValDisplay.textContent = Math.round(transform.zoom * 100) + "%";
  }
  if (state.bgColor) {
    bgColor = state.bgColor;
    bgColorPicker.value = bgColor;
    document.body.style.backgroundColor = bgColor;
  }
  if (state.drawColor) {
    drawColor = state.drawColor;
    colorPicker.value = drawColor;
  }
  if (state.currentFilter) {
    currentFilter = state.currentFilter;
    const filterSel = document.getElementById("filter-select");
    if (filterSel) {
      filterSel.value = currentFilter;
      filterSel.classList.toggle("filter-active", currentFilter !== "none");
    }
  }

  // Update elementIdCounter to avoid ID collisions
  const allIds = [...drawings, ...(imageData || [])].map((el) => {
    const match = el.id && el.id.match(/_(\d+)$/);
    return match ? parseInt(match[1]) : 0;
  });
  if (allIds.length > 0) {
    elementIdCounter = Math.max(...allIds) + 1;
  }

  selectedElements = [];
  undoStack = [];
  redoStack = [];
  updateUndoRedoButtons();
  toggleAlignmentPanelVisibility();
  isDirty = false;
}

document.getElementById("open-file-btn").addEventListener("click", openFile);
document.getElementById("save-file-btn").addEventListener("click", saveFile);

// --- GROUPING SYSTEM ---
let groupIdCounter = 0;

function groupSelection() {
  if (selectedElements.length < 2) return;
  pushUndo();
  const groupId = "group_" + groupIdCounter++;
  selectedElements.forEach((el) => {
    el.groupId = groupId;
  });
  toggleAlignmentPanelVisibility();
  render();
  showToast(`Grouped ${selectedElements.length} elements`);
}

function ungroupSelection() {
  const groupIds = new Set();
  selectedElements.forEach((el) => {
    if (el.groupId) groupIds.add(el.groupId);
  });
  if (groupIds.size === 0) return;
  pushUndo();
  // Ungroup all elements that share any of the selected group IDs
  const allElements = [...images, ...drawings];
  allElements.forEach((el) => {
    if (el.groupId && groupIds.has(el.groupId)) {
      delete el.groupId;
    }
  });
  toggleAlignmentPanelVisibility();
  render();
  showToast("Ungrouped");
}

function expandSelectionToGroups() {
  // When an element with a groupId is selected, also select all other elements in that group
  const groupIds = new Set();
  selectedElements.forEach((el) => {
    if (el.groupId) groupIds.add(el.groupId);
  });
  if (groupIds.size === 0) return;
  const allElements = [...images, ...drawings];
  allElements.forEach((el) => {
    if (el.groupId && groupIds.has(el.groupId)) {
      if (!selectedElements.some((s) => s.id === el.id)) {
        selectedElements.push(el);
      }
    }
  });
}

function updateGroupButtons() {
  const groupBtn = document.getElementById("group-btn");
  const ungroupBtn = document.getElementById("ungroup-btn");
  const canGroup = currentTool === "select" && selectedElements.length >= 2;
  const hasGroup = selectedElements.some((el) => el.groupId);
  groupBtn.style.opacity = canGroup ? "1" : "0.4";
  groupBtn.style.pointerEvents = canGroup ? "auto" : "none";
  ungroupBtn.style.opacity = hasGroup ? "1" : "0.4";
  ungroupBtn.style.pointerEvents = hasGroup ? "auto" : "none";
}

document.getElementById("group-btn").addEventListener("click", groupSelection);
document
  .getElementById("ungroup-btn")
  .addEventListener("click", ungroupSelection);

container.addEventListener("contextmenu", (e) => {
  e.preventDefault();
});

function showToast(message) {
  toast.textContent = message;
  toast.style.display = "block";
  setTimeout(() => (toast.style.display = "none"), 2500);
}

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  render();
}
window.addEventListener("resize", resize);

function updateToolbarUI() {
  buttons.forEach((b) => {
    if (!b.dataset.tool) return; // Skip non-tool buttons (e.g. ruler toggle)
    if (b.dataset.tool === currentTool) b.classList.add("active");
    else b.classList.remove("active");
  });
  toggleAlignmentPanelVisibility();
}

function toggleAlignmentPanelVisibility() {
  const scaleGroup = document.getElementById("scale-group");
  const alignmentGroup = document.getElementById("alignment-group");
  const hasImages = selectedElements.some((el) => el.elementType === "image");

  if (currentTool === "select" && selectedElements.length > 1) {
    alignmentPanel.style.display = "flex";
    alignmentGroup.style.display = "flex";
    updateSpacingInputs();
  } else if (
    currentTool === "select" &&
    selectedElements.length === 1 &&
    hasImages
  ) {
    alignmentPanel.style.display = "flex";
    alignmentGroup.style.display = "none";
  } else if (currentTool === "select" && selectedElements.length === 1) {
    alignmentPanel.style.display = "flex";
    alignmentGroup.style.display = "none";
  } else {
    alignmentPanel.style.display = "none";
    alignmentGroup.style.display = "none";
  }

  // Show scale group when image(s) are selected
  if (currentTool === "select" && selectedElements.length > 0 && hasImages) {
    scaleGroup.style.display = "flex";
    // Only show separator when alignment group is also visible
    const scaleSep = scaleGroup.querySelector(".scale-separator");
    if (scaleSep)
      scaleSep.style.display =
        alignmentGroup.style.display === "flex" ? "block" : "none";
  } else {
    scaleGroup.style.display = "none";
  }
  syncFontSizeFromSelection();
  syncOpacityFromSelection();
  updateGroupButtons();
}

function syncFontSizeFromSelection() {
  // If a single text element is selected, reflect its font size in the toolbar
  if (
    selectedElements.length === 1 &&
    selectedElements[0].elementType === "text"
  ) {
    const size = selectedElements[0].fontSize;
    currentFontSize = size;
    // Make sure the option exists in the select
    let option = fontSizeSelect.querySelector(`option[value="${size}"]`);
    if (!option) {
      option = document.createElement("option");
      option.value = size;
      option.textContent = size + "px";
      const options = Array.from(fontSizeSelect.options);
      let inserted = false;
      for (let i = 0; i < options.length; i++) {
        if (parseInt(options[i].value) > size) {
          fontSizeSelect.insertBefore(option, options[i]);
          inserted = true;
          break;
        }
      }
      if (!inserted) fontSizeSelect.appendChild(option);
    }
    fontSizeSelect.value = size;
  }
}

function updateSpacingInputs() {
  if (selectedElements.length < 2) return;

  // Use alignment units so groups are treated as single items for spacing calculation
  const units = buildAlignmentUnits(selectedElements);
  if (units.length < 2) return;

  // Calculate average horizontal gap between units
  const sortedX = [...units].sort((a, b) => a.b.x - b.b.x);
  let totalGapX = 0;
  let gapCountX = 0;
  for (let i = 1; i < sortedX.length; i++) {
    const gap = sortedX[i].b.x - (sortedX[i - 1].b.x + sortedX[i - 1].b.w);
    totalGapX += gap;
    gapCountX++;
  }
  const avgGapX = gapCountX > 0 ? Math.round(totalGapX / gapCountX) : 0;

  // Calculate average vertical gap between units
  const sortedY = [...units].sort((a, b) => a.b.y - b.b.y);
  let totalGapY = 0;
  let gapCountY = 0;
  for (let i = 1; i < sortedY.length; i++) {
    const gap = sortedY[i].b.y - (sortedY[i - 1].b.y + sortedY[i - 1].b.h);
    totalGapY += gap;
    gapCountY++;
  }
  const avgGapY = gapCountY > 0 ? Math.round(totalGapY / gapCountY) : 0;

  const spacingInputX = document.getElementById("spacing-input-x");
  const spacingInputY = document.getElementById("spacing-input-y");
  spacingInputX.value = avgGapX;
  spacingInputY.value = avgGapY;
}

const buttons = document.querySelectorAll(".tool-btn");
buttons.forEach((btn) => {
  btn.addEventListener("click", (e) => {
    const targetBtn = e.target.closest(".tool-btn");
    if (!targetBtn.dataset.tool) return; // Skip non-tool buttons (undo, redo, group, ungroup)
    if (ghostInput.style.display === "block") bakeText();
    if (cropMode) exitCropMode(false);
    currentTool = targetBtn.dataset.tool;
    if (currentTool !== "select") selectedElements = [];
    if (currentTool !== "select") { swapHoveredElement = null; isSwapDragging = false; swapSourceElement = null; swapDragWorldPos = null; swapTargetElement = null; }
    if (currentTool !== "measure") { measureHoverGuides = []; activeMeasureLine = null; }
    updateToolbarUI();
    updateCursor();
    render();
  });
});

const colorPicker = document.getElementById("color-picker");
colorPicker.addEventListener("input", (e) => {
  drawColor = e.target.value;
  applyColorToSelectedElements(drawColor);
});

const presetBtns = document.querySelectorAll(".preset-btn");
presetBtns.forEach((btn) => {
  btn.addEventListener("click", (e) => {
    const color = e.target.dataset.color;
    if (e.shiftKey) {
      bgColor = color;
      bgColorPicker.value = color;
      render();
    } else {
      drawColor = color;
      colorPicker.value = drawColor;
      applyColorToSelectedElements(drawColor);
    }
  });
});

function applyColorToSelectedElements(color) {
  if (selectedElements.length === 0) return;
  let changed = false;
  selectedElements.forEach((el) => {
    if (el.elementType === "text" || el.elementType === "drawing") {
      el.color = color;
      changed = true;
    }
  });
  if (changed) render();
}

bgColorPicker.addEventListener("input", (e) => {
  bgColor = e.target.value;
  document.body.style.backgroundColor = bgColor;
  render();
  scheduleSave();
});

// --- Filter Dropdown ---
const filterSelect = document.getElementById("filter-select");
filterSelect.addEventListener("change", (e) => {
  currentFilter = e.target.value;
  filteredImageCache = new WeakMap(); // invalidate cached filtered images
  filterSelect.classList.toggle("filter-active", currentFilter !== "none");
  render();
  if (currentFilter !== "none") {
    showToast(`Filter: ${e.target.options[e.target.selectedIndex].text}`);
  }
});

fontSizeSelect.addEventListener("change", (e) => {
  currentFontSize = parseInt(e.target.value);
  if (ghostInput.style.display === "block") {
    ghostInput.style.fontSize = `${currentFontSize * transform.zoom}px`;
  }
  // Update selected text elements
  applyFontSizeToSelectedText(currentFontSize);
});

function applyFontSizeToSelectedText(size) {
  if (selectedElements.length === 0) return;
  let changed = false;
  selectedElements.forEach((el) => {
    if (el.elementType === "text") {
      el.fontSize = size;
      changed = true;
    }
  });
  if (changed) render();
}

function setFontSizeAndSync(size) {
  size = Math.max(4, size);
  currentFontSize = size;
  // Sync the select element — pick matching option or add custom one
  let option = fontSizeSelect.querySelector(`option[value="${size}"]`);
  if (!option) {
    option = document.createElement("option");
    option.value = size;
    option.textContent = size + "px";
    // Insert in sorted order
    const options = Array.from(fontSizeSelect.options);
    let inserted = false;
    for (let i = 0; i < options.length; i++) {
      if (parseInt(options[i].value) > size) {
        fontSizeSelect.insertBefore(option, options[i]);
        inserted = true;
        break;
      }
    }
    if (!inserted) fontSizeSelect.appendChild(option);
  }
  fontSizeSelect.value = size;
  if (ghostInput.style.display === "block") {
    ghostInput.style.fontSize = `${currentFontSize * transform.zoom}px`;
  }
  applyFontSizeToSelectedText(size);
}

document.getElementById("font-size-minus").addEventListener("click", (e) => {
  e.stopPropagation();
  setFontSizeAndSync(currentFontSize - 16);
});

document.getElementById("font-size-plus").addEventListener("click", (e) => {
  e.stopPropagation();
  setFontSizeAndSync(currentFontSize + 16);
});

// Prevent spacing inputs from losing selection or triggering canvas interactions
const spacingInputX = document.getElementById("spacing-input-x");
const spacingInputY = document.getElementById("spacing-input-y");
[spacingInputX, spacingInputY].forEach((input) => {
  input.addEventListener("mousedown", (e) => e.stopPropagation());
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("focus", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => e.stopPropagation());
  input.addEventListener("input", () => {
    if (input === spacingInputX) {
      applyExactSpacing("x");
    } else {
      applyExactSpacing("y");
    }
  });
});

function applyExactSpacing(axis) {
  if (selectedElements.length < 2) return;
  const gap = Math.max(
    0,
    parseInt(axis === "x" ? spacingInputX.value : spacingInputY.value) || 10,
  );

  // Use alignment units so groups are treated as single items
  const units = buildAlignmentUnits(selectedElements);
  if (units.length < 2) return;

  if (axis === "x") {
    units.sort((a, b) => a.b.x - b.b.x);
    let currentX = units[0].b.x;
    for (let i = 0; i < units.length; i++) {
      const shiftX = currentX - units[i].b.x;
      if (shiftX !== 0) translateUnit(units[i], shiftX, 0);
      currentX += units[i].b.w + gap;
    }
  } else {
    units.sort((a, b) => a.b.y - b.b.y);
    let currentY = units[0].b.y;
    for (let i = 0; i < units.length; i++) {
      const shiftY = currentY - units[i].b.y;
      if (shiftY !== 0) translateUnit(units[i], 0, shiftY);
      currentY += units[i].b.h + gap;
    }
  }

  render();
  showToast(
    `${axis === "x" ? "Horizontal" : "Vertical"} spacing set to ${gap}px`,
  );
}

// --- SCALE PANEL BUTTON HANDLERS ---
document.querySelectorAll(".scale-btn").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    const scale = parseFloat(e.target.dataset.scale);
    if (!scale || selectedElements.length === 0) return;
    pushUndo();
    selectedElements.forEach((el) => {
      if (el.elementType === "image") {
        const naturalW = el.img.naturalWidth || el.w;
        const naturalH = el.img.naturalHeight || el.h;
        const newW = naturalW * scale;
        const newH = naturalH * scale;
        // Keep the center position
        const centerX = el.x + el.w / 2;
        const centerY = el.y + el.h / 2;
        el.w = newW;
        el.h = newH;
        el.x = centerX - newW / 2;
        el.y = centerY - newH / 2;
      }
    });
    render();
    showToast(`Scaled to ${scale * 100}%`);
  });
});

// --- OPACITY SLIDER ---
const opacitySlider = document.getElementById("opacity-slider");
const opacityValDisplay = document.getElementById("opacity-val");
const opacityGroup = document.getElementById("opacity-group");

let opacityUndoPushed = false;

opacitySlider.addEventListener("input", (e) => {
  const val = parseInt(e.target.value);
  opacityValDisplay.textContent = val + "%";
  if (selectedElements.length === 0) return;
  if (!opacityUndoPushed) {
    pushUndo();
    opacityUndoPushed = true;
  }
  selectedElements.forEach((el) => {
    el.opacity = val / 100;
  });
  render();
});

opacitySlider.addEventListener("mousedown", (e) => {
  e.stopPropagation();
  opacityUndoPushed = false;
});
opacitySlider.addEventListener("change", () => {
  opacityUndoPushed = false;
});

function syncOpacityFromSelection() {
  if (selectedElements.length === 0) {
    opacityGroup.style.display = "none";
    return;
  }
  opacityGroup.style.display = "flex";
  // Use the opacity of the first selected element
  const opacity =
    selectedElements[0].opacity != null ? selectedElements[0].opacity : 1;
  const val = Math.round(opacity * 100);
  opacitySlider.value = val;
  opacityValDisplay.textContent = val + "%";
}

function updateCursor() {
  if (currentTool === "pan" || isRightClickHand)
    container.style.cursor = isInteracting ? "grabbing" : "grab";
  else if (currentTool === "select") container.style.cursor = "default";
  else if (currentTool === "eraser") container.style.cursor = "pointer";
  else if (currentTool === "text") container.style.cursor = "text";
  else if (currentTool === "text-element") container.style.cursor = "text";
  else if (currentTool === "measure") container.style.cursor = "crosshair";
  else container.style.cursor = "crosshair";
}
updateCursor();

window.addEventListener("mousemove", (e) => {
  lastMousePos.x = e.clientX;
  lastMousePos.y = e.clientY;

  // Handle swap drag in progress
  if (isSwapDragging) {
    const mouseWorld = screenToWorld(e.clientX, e.clientY);
    swapDragWorldPos = mouseWorld;
    // Find what element is under the cursor (excluding the source)
    swapTargetElement = getElementAtWorldPos(mouseWorld, swapSourceElement);
    // Highlight only if target is also in the selection
    if (swapTargetElement && !selectedElements.some((el) => el.id === swapTargetElement.id)) {
      swapTargetElement = null;
    }
    container.style.cursor = "grabbing";
    render();
    return;
  }

  // Measure tool: show distances to nearby items on hover
  if (currentTool === "measure" && !isInteracting) {
    const mouseWorld = screenToWorld(e.clientX, e.clientY);
    measureHoverGuides = computeMeasureHoverGuides(mouseWorld);
    render();
  }

  // Handle context hover cursor changes for resizer handles
  if (
    currentTool === "select" &&
    !isInteracting &&
    !cropMode &&
    selectedElements.length === 1
  ) {
    const el = selectedElements[0];
    const mouseWorld = screenToWorld(e.clientX, e.clientY);
    const threshold = RESIZE_HANDLE_SIZE / transform.zoom;
    let handleHit = false;

    if (el.elementType === "image") {
      const handles = getElementResizeHandles(el);
      for (const h of handles) {
        if (
          Math.abs(mouseWorld.x - h.x) <= threshold &&
          Math.abs(mouseWorld.y - h.y) <= threshold
        ) {
          container.style.cursor = h.cursor;
          handleHit = true;
          break;
        }
      }
    } else {
      const handles = getElementResizeHandles(el);
      for (const h of handles) {
        if (
          Math.abs(mouseWorld.x - h.x) <= threshold &&
          Math.abs(mouseWorld.y - h.y) <= threshold
        ) {
          container.style.cursor = h.cursor;
          handleHit = true;
          break;
        }
      }
    }

    if (!handleHit) container.style.cursor = "default";
    if (handleHit) return;
  }

  // Handle swap handle hover detection for selected elements (multi-select)
  if (
    currentTool === "select" &&
    !isInteracting &&
    !isSwapDragging &&
    selectedElements.length >= 2
  ) {
    const mouseWorld = screenToWorld(e.clientX, e.clientY);
    let newHovered = null;

    // Check if cursor is over any selected element
    for (let i = selectedElements.length - 1; i >= 0; i--) {
      const el = selectedElements[i];
      let isOver = false;
      if (el.elementType === "image") {
        isOver =
          mouseWorld.x >= el.x &&
          mouseWorld.x <= el.x + el.w &&
          mouseWorld.y >= el.y &&
          mouseWorld.y <= el.y + el.h;
      } else {
        isOver = isPointHittingShape(mouseWorld, el);
      }
      if (isOver) {
        newHovered = el;
        break;
      }
    }

    if (newHovered !== swapHoveredElement) {
      swapHoveredElement = newHovered;
      render();
    }

    // Show grab cursor when hovering the swap handle
    if (swapHoveredElement && isPointOnSwapHandle(mouseWorld, swapHoveredElement)) {
      container.style.cursor = "grab";
      return;
    }
  } else if (!isSwapDragging && swapHoveredElement) {
    swapHoveredElement = null;
    render();
  }
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Shift") isShiftPressed = true;
  if (e.key === " " || e.code === "Space") {
    if (
      e.target.tagName === "INPUT" ||
      e.target.tagName === "SELECT" ||
      e.target.tagName === "TEXTAREA"
    )
      return;
    e.preventDefault();
    if (!isSpacePressed) {
      isSpacePressed = true;
      if (currentTool !== "pan") {
        preSpaceTool = currentTool;
        currentTool = "pan";
        updateToolbarUI();
        updateCursor();
      }
    }
  }
});

window.addEventListener("keyup", (e) => {
  if (e.key === "Shift") {
    isShiftPressed = false;
    panLockDirection = null;
    if (activeSnapGuides.length > 0) {
      activeSnapGuides = [];
      activeProximityGuides = [];
      activeSpacingGuides = [];
      render();
    }
  }
  if (e.key === " " || e.code === "Space") {
    if (isSpacePressed) {
      isSpacePressed = false;
      if (preSpaceTool !== null) {
        currentTool = preSpaceTool;
        preSpaceTool = null;
        updateToolbarUI();
        updateCursor();
        render();
      }
    }
  }
});

window.addEventListener("blur", () => {
  isShiftPressed = false;
  isSpacePressed = false;
  panLockDirection = null;
  if (preSpaceTool !== null) {
    currentTool = preSpaceTool;
    preSpaceTool = null;
    updateToolbarUI();
    updateCursor();
  }
  render();
});

window.addEventListener("keydown", (e) => {
  if (
    e.target.tagName === "INPUT" ||
    e.target.tagName === "SELECT" ||
    e.target.tagName === "TEXTAREA"
  )
    return;

  // Crop mode keyboard shortcuts
  if (cropMode) {
    if (e.key === "Enter") {
      e.preventDefault();
      exitCropMode(true);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      exitCropMode(false);
      return;
    }
    // Block other keys while in crop mode
    return;
  }

  const key = e.key.toLowerCase();
  if (e.key === "+" || e.key === "=") {
    e.preventDefault();
    applyZoom(transform.zoom * 1.1, lastMousePos.x, lastMousePos.y);
    return;
  }
  if (e.key === "-" || e.key === "_") {
    e.preventDefault();
    applyZoom(transform.zoom / 1.1, lastMousePos.x, lastMousePos.y);
    return;
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    if (currentTool === "select" && selectedElements.length > 0) {
      pushUndo();
      const idsToRemove = selectedElements.map((el) => el.id);
      images = images.filter((img) => !idsToRemove.includes(img.id));
      drawings = drawings.filter((d) => !idsToRemove.includes(d.id));
      showToast(`Removed ${selectedElements.length} selected asset(s)`);
      selectedElements = [];
      toggleAlignmentPanelVisibility();
      render();
    }
    return;
  }

  // Arrow keys to move selected elements
  if (
    (e.key === "ArrowUp" ||
      e.key === "ArrowDown" ||
      e.key === "ArrowLeft" ||
      e.key === "ArrowRight") &&
    currentTool === "select" &&
    selectedElements.length > 0
  ) {
    e.preventDefault();
    const step = e.altKey ? 500 : e.metaKey || e.ctrlKey ? 100 : e.shiftKey ? 10 : 1;
    let dx = 0;
    let dy = 0;
    if (e.key === "ArrowUp") dy = -step;
    if (e.key === "ArrowDown") dy = step;
    if (e.key === "ArrowLeft") dx = -step;
    if (e.key === "ArrowRight") dx = step;
    pushUndo();
    selectedElements.forEach((el) => translateElement(el, dx, dy));
    render();
    return;
  }

  let targetTool = null;
  if (e.metaKey || e.ctrlKey) return; // Let modifier combos be handled elsewhere
  if (key === "r" && e.shiftKey) {
    setRulersVisible(!rulersVisible);
    return;
  }
  if (key === "h") targetTool = "pan";
  if (key === "v") targetTool = "select";
  if (key === "b") targetTool = "pen";
  if (key === "l") targetTool = "line";
  if (key === "a") targetTool = "arrow";
  if (key === "r") targetTool = "rect-border";
  if (key === "f") targetTool = "rect-fill";
  if (key === "t") targetTool = "text";
  if (key === "n") targetTool = "text-element";
  if (key === "e") targetTool = "eraser";
  if (key === "m") targetTool = "measure";

  if (
    key === "g" &&
    !e.shiftKey &&
    currentTool === "select" &&
    selectedElements.length >= 2
  ) {
    const gridBtn = document.querySelector('[data-align="gridLayout"]');
    if (gridBtn) gridBtn.click();
    return;
  }

  if (
    key === "g" &&
    e.shiftKey &&
    currentTool === "select" &&
    selectedElements.length >= 2
  ) {
    const rowBtn = document.querySelector('[data-align="rowLayout"]');
    if (rowBtn) rowBtn.click();
    return;
  }

  if (targetTool) {
    preSpaceTool = null;
    const btn = document.querySelector(`[data-tool="${targetTool}"]`);
    if (btn) btn.click();
    return;
  }

  // P / Shift+P to cycle color filters forward/backward
  if (key === "p") {
    const idx = FILTER_OPTIONS.indexOf(currentFilter);
    let newIdx;
    if (e.shiftKey) {
      newIdx = (idx - 1 + FILTER_OPTIONS.length) % FILTER_OPTIONS.length;
    } else {
      newIdx = (idx + 1) % FILTER_OPTIONS.length;
    }
    currentFilter = FILTER_OPTIONS[newIdx];
    filteredImageCache = new WeakMap();
    const filterSel = document.getElementById("filter-select");
    if (filterSel) {
      filterSel.value = currentFilter;
      filterSel.classList.toggle("filter-active", currentFilter !== "none");
    }
    render();
    showToast(`Filter: ${FILTER_LABELS[currentFilter]}`);
    return;
  }

  // Number keys 0-9 set opacity on selected elements
  if (
    key >= "0" &&
    key <= "9" &&
    currentTool === "select" &&
    selectedElements.length > 0
  ) {
    const opacity = key === "0" ? 1 : parseInt(key) / 10;
    pushUndo();
    selectedElements.forEach((el) => {
      el.opacity = opacity;
    });
    syncOpacityFromSelection();
    render();
    showToast(`Opacity ${Math.round(opacity * 100)}%`);
    return;
  }
});

function screenToWorld(sx, sy) {
  return {
    x: (sx - transform.x) / transform.zoom,
    y: (sy - transform.y) / transform.zoom,
  };
}
function worldToScreen(wx, wy) {
  return {
    x: wx * transform.zoom + transform.x,
    y: wy * transform.zoom + transform.y,
  };
}

function snapToGrid(val) {
  return Math.round(val / GRID_SIZE) * GRID_SIZE;
}

function constraintToAngle(start, current) {
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

function getPtToSegmentDist(p, a, b) {
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

function getShapeBounds(shape) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  if (shape.type === "pen") {
    shape.points.forEach((p) => {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    });
  } else if (shape.type === "text") {
    if (!shape.w || !shape.h) {
      ctx.save();
      ctx.font = `${shape.fontSize}px sans-serif`;
      const lines = shape.text.split("\n");
      const lineHeight = shape.fontSize * 1.2;
      let maxWidth = 0;
      lines.forEach((line) => {
        const metrics = ctx.measureText(line);
        if (metrics.width > maxWidth) maxWidth = metrics.width;
      });
      shape.w = maxWidth;
      shape.h = lineHeight * (lines.length - 1) + shape.fontSize;
      ctx.restore();
    }
    const padding = shape.bgColor ? shape.fontSize * 0.4 : 0;
    minX = shape.start.x - padding;
    minY = shape.start.y - padding;
    maxX = shape.start.x + shape.w + padding;
    maxY = shape.start.y + shape.h + padding;
  } else {
    minX = Math.min(shape.start.x, shape.end.x);
    minY = Math.min(shape.start.y, shape.end.y);
    maxX = Math.max(shape.start.x, shape.end.x);
    maxY = Math.max(shape.start.y, shape.end.y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY, maxX, maxY };
}

function isPointHittingShape(p, shape) {
  const threshold = 12 / transform.zoom;
  if (shape.type === "pen") {
    for (let i = 0; i < shape.points.length - 1; i++) {
      if (
        getPtToSegmentDist(p, shape.points[i], shape.points[i + 1]) < threshold
      )
        return true;
    }
  } else if (shape.type === "line" || shape.type === "arrow" || shape.type === "measure") {
    return getPtToSegmentDist(p, shape.start, shape.end) < threshold;
  } else if (shape.type === "rect-border" || shape.type === "rect-fill") {
    const b = getShapeBounds(shape);
    if (shape.type === "rect-fill") {
      return p.x >= b.x && p.x <= b.maxX && p.y >= b.y && p.y <= b.maxY;
    } else {
      const top =
        getPtToSegmentDist(p, { x: b.x, y: b.y }, { x: b.maxX, y: b.y }) <
        threshold;
      const bot =
        getPtToSegmentDist(p, { x: b.x, y: b.maxY }, { x: b.maxX, y: b.maxY }) <
        threshold;
      const lft =
        getPtToSegmentDist(p, { x: b.x, y: b.y }, { x: b.x, y: b.maxY }) <
        threshold;
      const rgt =
        getPtToSegmentDist(p, { x: b.maxX, y: b.y }, { x: b.maxX, y: b.maxY }) <
        threshold;
      return top || bot || lft || rgt;
    }
  } else if (shape.type === "text") {
    const b = getShapeBounds(shape);
    return p.x >= b.x && p.x <= b.maxX && p.y >= b.y && p.y <= b.maxY;
  }
  return false;
}

function getElementResizeHandles(el) {
  // Returns array of {x, y, cursor, position} for each handle
  let b;
  if (el.elementType === "image") {
    b = {
      x: el.x,
      y: el.y,
      w: el.w,
      h: el.h,
      maxX: el.x + el.w,
      maxY: el.y + el.h,
    };
  } else {
    b = getShapeBounds(el);
  }
  return [
    { x: b.x, y: b.y, cursor: "nwse-resize", position: "tl" },
    { x: b.x + b.w, y: b.y, cursor: "nesw-resize", position: "tr" },
    { x: b.x, y: b.y + b.h, cursor: "nesw-resize", position: "bl" },
    { x: b.x + b.w, y: b.y + b.h, cursor: "nwse-resize", position: "br" },
  ];
}

// --- SWAP HANDLE HELPERS ---

function getElementCenter(el) {
  if (el.elementType === "image") {
    return { x: el.x + el.w / 2, y: el.y + el.h / 2 };
  }
  const b = getShapeBounds(el);
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

function getSwapHandleRadius() {
  return 14 / transform.zoom;
}

function isPointOnSwapHandle(worldPos, element) {
  const center = getElementCenter(element);
  const radius = getSwapHandleRadius();
  const dx = worldPos.x - center.x;
  const dy = worldPos.y - center.y;
  return dx * dx + dy * dy <= radius * radius;
}

function getElementAtWorldPos(worldPos, excludeElement) {
  // Check drawings (top to bottom in rendering order)
  for (let i = drawings.length - 1; i >= 0; i--) {
    if (excludeElement && drawings[i].id === excludeElement.id) continue;
    if (isPointHittingShape(worldPos, drawings[i])) {
      return drawings[i];
    }
  }
  // Check images
  for (let i = images.length - 1; i >= 0; i--) {
    if (excludeElement && images[i].id === excludeElement.id) continue;
    const img = images[i];
    if (
      worldPos.x >= img.x &&
      worldPos.x <= img.x + img.w &&
      worldPos.y >= img.y &&
      worldPos.y <= img.y + img.h
    ) {
      return img;
    }
  }
  return null;
}

function swapElementPositions(elA, elB) {
  pushUndo();

  // Get centers of both elements
  const boundsA = elA.elementType === "image"
    ? { x: elA.x, y: elA.y, w: elA.w, h: elA.h }
    : getShapeBounds(elA);
  const boundsB = elB.elementType === "image"
    ? { x: elB.x, y: elB.y, w: elB.w, h: elB.h }
    : getShapeBounds(elB);

  const centerA = { x: boundsA.x + boundsA.w / 2, y: boundsA.y + boundsA.h / 2 };
  const centerB = { x: boundsB.x + boundsB.w / 2, y: boundsB.y + boundsB.h / 2 };

  // Calculate shift needed: move A to where B's center is, and vice versa
  const shiftAtoB = { x: centerB.x - centerA.x, y: centerB.y - centerA.y };
  const shiftBtoA = { x: centerA.x - centerB.x, y: centerA.y - centerB.y };

  translateElement(elA, shiftAtoB.x, shiftAtoB.y);
  translateElement(elB, shiftBtoA.x, shiftBtoA.y);

  render();
  scheduleSave();
  showToast("Swapped positions");
}

function handleImageFile(file, worldX, worldY) {
  const reader = new FileReader();
  reader.onload = (event) => {
    const img = new Image();
    img.onload = () => {
      pushUndo();
      images.push({
        id: "img_" + elementIdCounter++,
        elementType: "image",
        img: img,
        x: worldX - img.width / 2,
        y: worldY - img.height / 2,
        w: img.width,
        h: img.height,
      });
      render();
    };
    img.src = event.target.result;
  };
  reader.readAsDataURL(file);
}

window.addEventListener("paste", (e) => {
  // Don't intercept paste if user is typing in the ghost text input
  if (
    ghostInput.style.display === "block" &&
    document.activeElement === ghostInput
  )
    return;

  const clipboardData = e.clipboardData || e.originalEvent.clipboardData;
  const items = clipboardData.items;
  const imageBlobs = [];
  for (let item of items) {
    if (item.type.indexOf("image") === 0) {
      imageBlobs.push(item.getAsFile());
    }
  }

  if (internalCopyPerformed && clipboardElements.length > 0) {
    // Check if the system clipboard still holds our internal copy marker.
    // If it has images or different text, the user copied something externally.
    const text = clipboardData.getData("text/plain");
    const isStillInternal = !imageBlobs.length && text === INTERNAL_COPY_MIME;

    if (isStillInternal) {
      e.preventDefault();
      pasteFromClipboard();
      return;
    }
    // Clipboard has new external content — reset internal state
    internalCopyPerformed = false;
    clipboardElements = [];
  }

  if (imageBlobs.length > 0) {
    // System clipboard has image(s) from an external source
    e.preventDefault();
    pushUndo();
    const worldCenter = screenToWorld(
      window.innerWidth / 2,
      window.innerHeight / 2,
    );
    // Sort blobs by filename for consistent ordering
    const sortedBlobs = [...imageBlobs].sort((a, b) => {
      const nameA = (a.name || "").toLowerCase();
      const nameB = (b.name || "").toLowerCase();
      return nameA.localeCompare(nameB, undefined, { numeric: true });
    });
    const pastedElements = new Array(sortedBlobs.length);
    let loadedCount = 0;
    const STAGGER_X = 150;
    const STAGGER_Y = 80;
    sortedBlobs.forEach((blob, index) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          const offsetX = index * STAGGER_X;
          const offsetY = index * STAGGER_Y;
          const element = {
            id: "img_" + elementIdCounter++,
            elementType: "image",
            img: img,
            x: worldCenter.x - img.width / 2 + offsetX,
            y: worldCenter.y - img.height / 2 + offsetY,
            w: img.width,
            h: img.height,
          };
          pastedElements[index] = element;
          loadedCount++;
          if (loadedCount === sortedBlobs.length) {
            // Add to images array in sorted order for correct z-order
            for (const el of pastedElements) {
              images.push(el);
            }
            selectedElements = pastedElements;
            currentTool = "select";
            updateToolbarUI();
            toggleAlignmentPanelVisibility();
            render();
            showToast(`Pasted ${pastedElements.length} image(s)`);
          }
        };
        img.src = event.target.result;
      };
      reader.readAsDataURL(blob);
    });
  } else if (clipboardElements.length > 0) {
    // No external content — fall back to internal clipboard
    e.preventDefault();
    pasteFromClipboard();
  } else {
    // Check for plain text in clipboard
    const text = clipboardData.getData("text/plain");
    if (text && text.trim().length > 0) {
      e.preventDefault();
      pasteTextToCanvas(text.trim());
    }
  }
});

window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  if (e.dataTransfer && e.dataTransfer.files.length > 0) {
    const dropWorldPos = screenToWorld(e.clientX, e.clientY);
    for (let file of e.dataTransfer.files) {
      if (file.type.indexOf("image/") === 0) {
        handleImageFile(file, dropWorldPos.x, dropWorldPos.y);
      }
    }
  }
});

// --- COPY / PASTE / SELECT ALL ---
const INTERNAL_COPY_MIME = "text/x-infinite-canvas";
let pendingInternalCopy = false;

function copySelectionToClipboard() {
  if (selectedElements.length === 0) return;
  clipboardElements = selectedElements.map((el) => cloneElement(el));
  pasteOffset = 0;
  internalCopyPerformed = true;
  // Trigger a real copy event so we can write our marker to the system clipboard.
  // This ensures that on paste we can detect if the clipboard still has our data.
  pendingInternalCopy = true;
  document.execCommand("copy");
  pendingInternalCopy = false;
  showToast(`Copied ${clipboardElements.length} element(s)`);
}

// Write our marker to the system clipboard during internal copy
document.addEventListener("copy", (e) => {
  if (pendingInternalCopy) {
    e.preventDefault();
    e.clipboardData.setData("text/plain", INTERNAL_COPY_MIME);
  }
});

function pasteFromClipboard() {
  if (clipboardElements.length === 0) return;
  pushUndo();
  pasteOffset += 30;
  const newElements = [];
  // Remap group IDs so pasted groups are independent from originals
  const groupIdMap = new Map();
  clipboardElements.forEach((el) => {
    const clone = cloneElement(el);
    clone.id =
      (clone.elementType === "image" ? "img_" : "draw_") + elementIdCounter++;
    if (clone.groupId) {
      if (!groupIdMap.has(clone.groupId)) {
        groupIdMap.set(clone.groupId, "group_" + groupIdCounter++);
      }
      clone.groupId = groupIdMap.get(clone.groupId);
    }
    // Offset the pasted element
    if (clone.elementType === "image") {
      clone.x += pasteOffset;
      clone.y += pasteOffset;
      if (clone.fullBounds) {
        clone.fullBounds = {
          x: clone.fullBounds.x + pasteOffset,
          y: clone.fullBounds.y + pasteOffset,
          w: clone.fullBounds.w,
          h: clone.fullBounds.h,
        };
      }
    } else if (clone.type === "pen") {
      clone.points = clone.points.map((p) => ({
        x: p.x + pasteOffset,
        y: p.y + pasteOffset,
      }));
    } else {
      clone.start = {
        x: clone.start.x + pasteOffset,
        y: clone.start.y + pasteOffset,
      };
      if (clone.end) {
        clone.end = {
          x: clone.end.x + pasteOffset,
          y: clone.end.y + pasteOffset,
        };
      }
    }
    if (clone.elementType === "image") {
      images.push(clone);
    } else {
      drawings.push(clone);
    }
    newElements.push(clone);
  });
  // Select the pasted elements
  selectedElements = newElements;
  currentTool = "select";
  updateToolbarUI();
  toggleAlignmentPanelVisibility();
  render();
  showToast(`Pasted ${newElements.length} element(s)`);
}

function pasteTextToCanvas(text) {
  pushUndo();
  const worldCenter = screenToWorld(
    window.innerWidth / 2,
    window.innerHeight / 2,
  );
  const lines = text.split("\n");
  const pastedElements = [];
  let yOffset = 0;

  lines.forEach((line) => {
    if (line.trim().length === 0) {
      yOffset += currentFontSize * 0.5;
      return;
    }
    const textEl = {
      id: "text_" + elementIdCounter++,
      elementType: "text",
      type: "text",
      text: line,
      color: drawColor,
      fontSize: currentFontSize,
      start: { x: worldCenter.x, y: worldCenter.y + yOffset },
    };
    drawings.push(textEl);
    pastedElements.push(textEl);
    yOffset += currentFontSize * 1.2;
  });

  if (pastedElements.length > 0) {
    selectedElements = pastedElements;
    currentTool = "select";
    updateToolbarUI();
    toggleAlignmentPanelVisibility();
    render();
    showToast(`Pasted ${pastedElements.length} text line(s)`);
  }
}

function cloneElement(el) {
  if (el.elementType === "image") {
    const c = {
      id: el.id,
      elementType: "image",
      img: el.img, // share the same Image object
      x: el.x,
      y: el.y,
      w: el.w,
      h: el.h,
      opacity: el.opacity != null ? el.opacity : 1,
    };
    if (el.groupId) c.groupId = el.groupId;
    if (el.crop) c.crop = { ...el.crop };
    if (el.fullBounds) c.fullBounds = { ...el.fullBounds };
    return c;
  }
  // Drawing/shape clone
  const clone = {
    id: el.id,
    elementType: el.elementType,
    type: el.type,
    color: el.color,
    width: el.width,
    opacity: el.opacity != null ? el.opacity : 1,
  };
  if (el.groupId) clone.groupId = el.groupId;
  if (el.type === "pen") {
    clone.points = el.points.map((p) => ({ x: p.x, y: p.y }));
  } else if (el.type === "text") {
    clone.text = el.text;
    clone.fontSize = el.fontSize;
    clone.start = { x: el.start.x, y: el.start.y };
    if (el.w) clone.w = el.w;
    if (el.h) clone.h = el.h;
    if (el.bgColor) clone.bgColor = el.bgColor;
  } else {
    clone.start = { x: el.start.x, y: el.start.y };
    if (el.end) clone.end = { x: el.end.x, y: el.end.y };
  }
  return clone;
}

function duplicateSelection() {
  if (selectedElements.length === 0) return;
  pushUndo();
  const DUPLICATE_OFFSET = 30;
  const newElements = [];
  const groupIdMap = new Map();

  selectedElements.forEach((el) => {
    const clone = cloneElement(el);
    clone.id =
      (clone.elementType === "image" ? "img_" : "draw_") + elementIdCounter++;

    // Remap group IDs so duplicated groups are independent
    if (clone.groupId) {
      if (!groupIdMap.has(clone.groupId)) {
        groupIdMap.set(clone.groupId, "group_" + groupIdCounter++);
      }
      clone.groupId = groupIdMap.get(clone.groupId);
    }

    // Offset the duplicated element
    if (clone.elementType === "image") {
      clone.x += DUPLICATE_OFFSET;
      clone.y += DUPLICATE_OFFSET;
      if (clone.fullBounds) {
        clone.fullBounds = {
          x: clone.fullBounds.x + DUPLICATE_OFFSET,
          y: clone.fullBounds.y + DUPLICATE_OFFSET,
          w: clone.fullBounds.w,
          h: clone.fullBounds.h,
        };
      }
    } else if (clone.type === "pen") {
      clone.points = clone.points.map((p) => ({
        x: p.x + DUPLICATE_OFFSET,
        y: p.y + DUPLICATE_OFFSET,
      }));
    } else {
      clone.start = {
        x: clone.start.x + DUPLICATE_OFFSET,
        y: clone.start.y + DUPLICATE_OFFSET,
      };
      if (clone.end) {
        clone.end = {
          x: clone.end.x + DUPLICATE_OFFSET,
          y: clone.end.y + DUPLICATE_OFFSET,
        };
      }
    }

    if (clone.elementType === "image") {
      images.push(clone);
    } else {
      drawings.push(clone);
    }
    newElements.push(clone);
  });

  // Select the duplicated elements
  selectedElements = newElements;
  currentTool = "select";
  updateToolbarUI();
  toggleAlignmentPanelVisibility();
  render();
  showToast(`Duplicated ${newElements.length} element(s)`);
}

function selectAllElements() {
  currentTool = "select";
  selectedElements = [];
  images.forEach((img) => {
    img.elementType = "image";
    selectedElements.push(img);
  });
  drawings.forEach((shape) => {
    if (shape.type !== "text") shape.elementType = "drawing";
    selectedElements.push(shape);
  });
  updateToolbarUI();
  toggleAlignmentPanelVisibility();
  render();
  showToast(`Selected all ${selectedElements.length} element(s)`);
}

// Intercept Cmd/Ctrl+O in capture phase to prevent browser's native "Open File" dialog
window.addEventListener(
  "keydown",
  (e) => {
    const isMod = e.metaKey || e.ctrlKey;
    if (isMod && e.key.toLowerCase() === "o") {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true,
);

// Cmd/Ctrl+C, Cmd/Ctrl+V, Cmd/Ctrl+A, Cmd/Ctrl+Z, Cmd/Ctrl+S keyboard shortcuts
window.addEventListener("keydown", (e) => {
  if (
    e.target.tagName === "INPUT" ||
    e.target.tagName === "SELECT" ||
    e.target.tagName === "TEXTAREA"
  )
    return;
  const isMod = e.metaKey || e.ctrlKey;

  if (isMod && e.key.toLowerCase() === "s" && !e.shiftKey) {
    e.preventDefault();
    saveFile();
    return;
  }
  if (isMod && e.key.toLowerCase() === "s" && e.shiftKey) {
    e.preventDefault();
    saveAs();
    return;
  }
  if (isMod && e.key.toLowerCase() === "o") {
    e.preventDefault();
    openFile();
    return;
  }
  if (isMod && e.key.toLowerCase() === "z" && !e.shiftKey) {
    e.preventDefault();
    undo();
    return;
  }
  if (isMod && e.key.toLowerCase() === "z" && e.shiftKey) {
    e.preventDefault();
    redo();
    return;
  }
  if (isMod && e.key.toLowerCase() === "g" && !e.shiftKey) {
    e.preventDefault();
    groupSelection();
    return;
  }
  if (isMod && e.key.toLowerCase() === "g" && e.shiftKey) {
    e.preventDefault();
    ungroupSelection();
    return;
  }
  if (isMod && e.key.toLowerCase() === "c") {
    if (selectedElements.length > 0) {
      e.preventDefault();
      copySelectionToClipboard();
    }
    return;
  }
  if (isMod && e.key.toLowerCase() === "x") {
    if (selectedElements.length > 0) {
      e.preventDefault();
      pushUndo();
      copySelectionToClipboard();
      const idsToRemove = selectedElements.map((el) => el.id);
      images = images.filter((img) => !idsToRemove.includes(img.id));
      drawings = drawings.filter((d) => !idsToRemove.includes(d.id));
      showToast(`Cut ${selectedElements.length} element(s)`);
      selectedElements = [];
      toggleAlignmentPanelVisibility();
      render();
    }
    return;
  }
  if (isMod && e.key.toLowerCase() === "d") {
    if (selectedElements.length > 0) {
      e.preventDefault();
      duplicateSelection();
    }
    return;
  }
  if (isMod && e.key.toLowerCase() === "v") {
    // Don't preventDefault — let the native paste event fire so system
    // clipboard content (e.g. images) can be detected in the paste handler.
    return;
  }
  if (isMod && e.key.toLowerCase() === "a") {
    e.preventDefault();
    selectAllElements();
    return;
  }
});

const SNAP_THRESHOLD = 8; // pixels in world space (adjusted by zoom)
const MAX_GUIDE_NEIGHBORS = 6; // only consider the N closest elements for guides

function getClosestElements(bounds, excludeIds, maxCount) {
  // Returns the closest maxCount elements (by center-to-center distance) to bounds.
  // Grouped elements are consolidated into a single bounding box per group.
  const excluded = new Set(excludeIds);
  const myCx = bounds.x + bounds.w / 2;
  const myCy = bounds.y + bounds.h / 2;

  // Collect individual (ungrouped) elements and accumulate group bounding boxes
  const groupBoundsMap = new Map(); // groupId -> {minX, minY, maxX, maxY}
  const candidates = [];

  function addElement(b, groupId) {
    if (groupId) {
      if (!groupBoundsMap.has(groupId)) {
        groupBoundsMap.set(groupId, {
          minX: b.x,
          minY: b.y,
          maxX: b.x + b.w,
          maxY: b.y + b.h,
        });
      } else {
        const gb = groupBoundsMap.get(groupId);
        gb.minX = Math.min(gb.minX, b.x);
        gb.minY = Math.min(gb.minY, b.y);
        gb.maxX = Math.max(gb.maxX, b.x + b.w);
        gb.maxY = Math.max(gb.maxY, b.y + b.h);
      }
    } else {
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const dist = Math.hypot(cx - myCx, cy - myCy);
      candidates.push({ bounds: b, dist });
    }
  }

  images.forEach((img) => {
    if (excluded.has(img.id)) return;
    addElement({ x: img.x, y: img.y, w: img.w, h: img.h }, img.groupId);
  });
  drawings.forEach((shape) => {
    if (excluded.has(shape.id)) return;
    addElement(getShapeBounds(shape), shape.groupId);
  });

  // Convert consolidated group bounds into candidates
  groupBoundsMap.forEach((gb) => {
    const b = {
      x: gb.minX,
      y: gb.minY,
      w: gb.maxX - gb.minX,
      h: gb.maxY - gb.minY,
    };
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const dist = Math.hypot(cx - myCx, cy - myCy);
    candidates.push({ bounds: b, dist });
  });

  candidates.sort((a, b) => a.dist - b.dist);
  return candidates.slice(0, maxCount).map((c) => c.bounds);
}

function getSnapTargets(excludeIds, bounds) {
  // Collect edges and centers of closest elements not being dragged.
  // Grouped elements are consolidated into a single bounding box per group.
  const targets = { x: [], y: [] };
  const excluded = new Set(excludeIds);

  // Include guide lines as snap targets
  for (const guide of guides) {
    if (guide.axis === "x") {
      targets.x.push(guide.position);
    } else {
      targets.y.push(guide.position);
    }
  }

  // If bounds provided, limit to closest neighbors (already group-aware)
  let elementBounds;
  if (bounds) {
    elementBounds = getClosestElements(bounds, excludeIds, MAX_GUIDE_NEIGHBORS);
  } else {
    // Fallback: collect all elements, consolidating groups
    const groupBoundsMap = new Map();
    elementBounds = [];

    function addEl(b, groupId) {
      if (groupId) {
        if (!groupBoundsMap.has(groupId)) {
          groupBoundsMap.set(groupId, {
            minX: b.x,
            minY: b.y,
            maxX: b.x + b.w,
            maxY: b.y + b.h,
          });
        } else {
          const gb = groupBoundsMap.get(groupId);
          gb.minX = Math.min(gb.minX, b.x);
          gb.minY = Math.min(gb.minY, b.y);
          gb.maxX = Math.max(gb.maxX, b.x + b.w);
          gb.maxY = Math.max(gb.maxY, b.y + b.h);
        }
      } else {
        elementBounds.push(b);
      }
    }

    images.forEach((img) => {
      if (excluded.has(img.id)) return;
      addEl({ x: img.x, y: img.y, w: img.w, h: img.h }, img.groupId);
    });
    drawings.forEach((shape) => {
      if (excluded.has(shape.id)) return;
      addEl(getShapeBounds(shape), shape.groupId);
    });

    groupBoundsMap.forEach((gb) => {
      elementBounds.push({
        x: gb.minX,
        y: gb.minY,
        w: gb.maxX - gb.minX,
        h: gb.maxY - gb.minY,
      });
    });
  }

  for (const b of elementBounds) {
    targets.x.push(b.x, b.x + b.w, b.x + b.w / 2);
    targets.y.push(b.y, b.y + b.h, b.y + b.h / 2);
  }

  return targets;
}

function snapToElements(bounds, targets, threshold) {
  // bounds: {x, y, w, h} of the dragged element(s)
  // Returns {dx, dy, guides}
  let dx = 0,
    dy = 0;
  const guides = [];

  const myEdgesX = [bounds.x, bounds.x + bounds.w / 2, bounds.x + bounds.w];
  const myEdgesY = [bounds.y, bounds.y + bounds.h / 2, bounds.y + bounds.h];

  let bestDistX = threshold;
  for (const myX of myEdgesX) {
    for (const tX of targets.x) {
      const dist = Math.abs(myX - tX);
      if (dist < bestDistX) {
        bestDistX = dist;
        dx = tX - myX;
      }
    }
  }

  let bestDistY = threshold;
  for (const myY of myEdgesY) {
    for (const tY of targets.y) {
      const dist = Math.abs(myY - tY);
      if (dist < bestDistY) {
        bestDistY = dist;
        dy = tY - myY;
      }
    }
  }

  // Collect active guide lines after snap applied
  const snappedEdgesX = myEdgesX.map((v) => v + dx);
  const snappedEdgesY = myEdgesY.map((v) => v + dy);

  for (const sx of snappedEdgesX) {
    for (const tX of targets.x) {
      if (Math.abs(sx - tX) < 0.5) {
        guides.push({ axis: "x", pos: tX });
      }
    }
  }
  for (const sy of snappedEdgesY) {
    for (const tY of targets.y) {
      if (Math.abs(sy - tY) < 0.5) {
        guides.push({ axis: "y", pos: tY });
      }
    }
  }

  return { dx, dy, guides };
}

function snapToSpacing(bounds, excludeIds, threshold) {
  // Snaps the dragged element to positions where its gap to a neighbor
  // matches an existing gap between other elements on the canvas.
  const allElements = getClosestElements(
    bounds,
    excludeIds,
    MAX_GUIDE_NEIGHBORS,
  );

  if (allElements.length < 2) return { dx: 0, dy: 0 };

  const myLeft = bounds.x;
  const myRight = bounds.x + bounds.w;
  const myTop = bounds.y;
  const myBottom = bounds.y + bounds.h;

  // Collect reference gaps between non-dragged elements
  const refGapsX = []; // horizontal gaps (between elements side by side)
  const refGapsY = []; // vertical gaps (between elements stacked)

  for (let i = 0; i < allElements.length; i++) {
    for (let j = i + 1; j < allElements.length; j++) {
      const a = allElements[i];
      const b = allElements[j];
      const aL = a.x,
        aR = a.x + a.w,
        aT = a.y,
        aB = a.y + a.h;
      const bL = b.x,
        bR = b.x + b.w,
        bT = b.y,
        bB = b.y + b.h;

      // Horizontal gap (vertical overlap required)
      if (aB > bT && aT < bB) {
        if (aR <= bL && bL - aR > 0) refGapsX.push(bL - aR);
        if (bR <= aL && aL - bR > 0) refGapsX.push(aL - bR);
      }
      // Vertical gap (horizontal overlap required)
      if (aR > bL && aL < bR) {
        if (aB <= bT && bT - aB > 0) refGapsY.push(bT - aB);
        if (bB <= aT && aT - bB > 0) refGapsY.push(aT - bB);
      }
    }
  }

  // Deduplicate reference gaps
  const uniqueGapsX = [
    ...new Set(refGapsX.map((g) => Math.round(g * 10) / 10)),
  ];
  const uniqueGapsY = [
    ...new Set(refGapsY.map((g) => Math.round(g * 10) / 10)),
  ];

  let bestDx = 0,
    bestDistX = threshold;
  let bestDy = 0,
    bestDistY = threshold;

  // For each nearby element, check if we can position ourselves so the gap matches a reference gap
  for (const el of allElements) {
    const elL = el.x,
      elR = el.x + el.w,
      elT = el.y,
      elB = el.y + el.h;

    // Check vertical overlap for horizontal spacing snap
    if (myBottom > elT && myTop < elB) {
      // Element to the left: snap so myLeft - elR = refGap
      if (elR <= myLeft + threshold * 2) {
        for (const gap of uniqueGapsX) {
          const targetMyLeft = elR + gap;
          const dist = Math.abs(myLeft - targetMyLeft);
          if (dist < bestDistX) {
            bestDistX = dist;
            bestDx = targetMyLeft - myLeft;
          }
        }
      }
      // Element to the right: snap so elL - myRight = refGap
      if (elL >= myRight - threshold * 2) {
        for (const gap of uniqueGapsX) {
          const targetMyRight = elL - gap;
          const dist = Math.abs(myRight - targetMyRight);
          if (dist < bestDistX) {
            bestDistX = dist;
            bestDx = targetMyRight - myRight;
          }
        }
      }
    }

    // Check horizontal overlap for vertical spacing snap
    if (myRight > elL && myLeft < elR) {
      // Element above: snap so myTop - elB = refGap
      if (elB <= myTop + threshold * 2) {
        for (const gap of uniqueGapsY) {
          const targetMyTop = elB + gap;
          const dist = Math.abs(myTop - targetMyTop);
          if (dist < bestDistY) {
            bestDistY = dist;
            bestDy = targetMyTop - myTop;
          }
        }
      }
      // Element below: snap so elT - myBottom = refGap
      if (elT >= myBottom - threshold * 2) {
        for (const gap of uniqueGapsY) {
          const targetMyBottom = elT - gap;
          const dist = Math.abs(myBottom - targetMyBottom);
          if (dist < bestDistY) {
            bestDistY = dist;
            bestDy = targetMyBottom - myBottom;
          }
        }
      }
    }
  }

  return { dx: bestDx, dy: bestDy };
}

function getProximityGuides(bounds, excludeIds) {
  // Returns guide lines from the dragged element's edges to nearby elements' edges
  const PROXIMITY_RANGE = 150 / transform.zoom; // world units range to detect
  const guides = [];

  const myLeft = bounds.x;
  const myRight = bounds.x + bounds.w;
  const myCx = bounds.x + bounds.w / 2;
  const myTop = bounds.y;
  const myBottom = bounds.y + bounds.h;
  const myCy = bounds.y + bounds.h / 2;

  // Only consider the closest elements to reduce clutter
  const allElements = getClosestElements(
    bounds,
    excludeIds,
    MAX_GUIDE_NEIGHBORS,
  );

  for (const el of allElements) {
    const elLeft = el.x;
    const elRight = el.x + el.w;
    const elCx = el.x + el.w / 2;
    const elTop = el.y;
    const elBottom = el.y + el.h;
    const elCy = el.y + el.h / 2;

    // Check vertical alignment (x-axis guides)
    const xPairs = [
      [myLeft, elLeft],
      [myLeft, elRight],
      [myLeft, elCx],
      [myRight, elLeft],
      [myRight, elRight],
      [myRight, elCx],
      [myCx, elLeft],
      [myCx, elRight],
      [myCx, elCx],
    ];
    for (const [myX, elX] of xPairs) {
      const dist = Math.abs(myX - elX);
      if (dist < PROXIMITY_RANGE && dist > 0.5) {
        // Draw a vertical guide at the target's edge, spanning between the two elements
        const minY =
          Math.min(myTop, myBottom, elTop, elBottom) - 20 / transform.zoom;
        const maxY =
          Math.max(myTop, myBottom, elTop, elBottom) + 20 / transform.zoom;
        guides.push({ axis: "x", pos: elX, from: minY, to: maxY, dist });
      }
    }

    // Check horizontal alignment (y-axis guides)
    const yPairs = [
      [myTop, elTop],
      [myTop, elBottom],
      [myTop, elCy],
      [myBottom, elTop],
      [myBottom, elBottom],
      [myBottom, elCy],
      [myCy, elTop],
      [myCy, elBottom],
      [myCy, elCy],
    ];
    for (const [myY, elY] of yPairs) {
      const dist = Math.abs(myY - elY);
      if (dist < PROXIMITY_RANGE && dist > 0.5) {
        const minX =
          Math.min(myLeft, myRight, elLeft, elRight) - 20 / transform.zoom;
        const maxX =
          Math.max(myLeft, myRight, elLeft, elRight) + 20 / transform.zoom;
        guides.push({ axis: "y", pos: elY, from: minX, to: maxX, dist });
      }
    }
  }

  // Deduplicate and keep only guides with smallest distance per position
  const best = new Map();
  for (const g of guides) {
    const key = g.axis + "_" + g.pos.toFixed(1);
    if (!best.has(key) || g.dist < best.get(key).dist) {
      best.set(key, g);
    }
  }

  return Array.from(best.values());
}

function getSpacingGuides(bounds, excludeIds) {
  // Returns spacing measurement lines between the dragged element and nearby elements
  const guides = [];
  const SPACING_RANGE = 300 / transform.zoom; // max distance to show spacing

  const myLeft = bounds.x;
  const myRight = bounds.x + bounds.w;
  const myTop = bounds.y;
  const myBottom = bounds.y + bounds.h;
  const myCx = bounds.x + bounds.w / 2;
  const myCy = bounds.y + bounds.h / 2;

  // Only consider the closest elements to reduce clutter
  const allElements = getClosestElements(
    bounds,
    excludeIds,
    MAX_GUIDE_NEIGHBORS,
  );

  // For each nearby element, compute horizontal and vertical gaps
  for (const el of allElements) {
    const elLeft = el.x;
    const elRight = el.x + el.w;
    const elTop = el.y;
    const elBottom = el.y + el.h;

    // Check vertical overlap (needed for horizontal spacing)
    const vOverlap = myBottom > elTop && myTop < elBottom;
    // Check horizontal overlap (needed for vertical spacing)
    const hOverlap = myRight > elLeft && myLeft < elRight;

    if (vOverlap) {
      // Element is to the left of dragged element
      if (elRight <= myLeft) {
        const gap = myLeft - elRight;
        if (gap > 0 && gap < SPACING_RANGE) {
          const overlapTop = Math.max(myTop, elTop);
          const overlapBottom = Math.min(myBottom, elBottom);
          const midY = (overlapTop + overlapBottom) / 2;
          guides.push({
            axis: "x",
            from: elRight,
            to: myLeft,
            pos: midY,
            dist: gap,
            isEqual: false,
          });
        }
      }
      // Element is to the right of dragged element
      if (elLeft >= myRight) {
        const gap = elLeft - myRight;
        if (gap > 0 && gap < SPACING_RANGE) {
          const overlapTop = Math.max(myTop, elTop);
          const overlapBottom = Math.min(myBottom, elBottom);
          const midY = (overlapTop + overlapBottom) / 2;
          guides.push({
            axis: "x",
            from: myRight,
            to: elLeft,
            pos: midY,
            dist: gap,
            isEqual: false,
          });
        }
      }
    }

    if (hOverlap) {
      // Element is above the dragged element
      if (elBottom <= myTop) {
        const gap = myTop - elBottom;
        if (gap > 0 && gap < SPACING_RANGE) {
          const overlapLeft = Math.max(myLeft, elLeft);
          const overlapRight = Math.min(myRight, elRight);
          const midX = (overlapLeft + overlapRight) / 2;
          guides.push({
            axis: "y",
            from: elBottom,
            to: myTop,
            pos: midX,
            dist: gap,
            isEqual: false,
          });
        }
      }
      // Element is below the dragged element
      if (elTop >= myBottom) {
        const gap = elTop - myBottom;
        if (gap > 0 && gap < SPACING_RANGE) {
          const overlapLeft = Math.max(myLeft, elLeft);
          const overlapRight = Math.min(myRight, elRight);
          const midX = (overlapLeft + overlapRight) / 2;
          guides.push({
            axis: "y",
            from: myBottom,
            to: elTop,
            pos: midX,
            dist: gap,
            isEqual: false,
          });
        }
      }
    }
  }

  // Detect equal spacing: find gaps between other elements that match our gaps
  // Collect gaps between all non-dragged elements
  const otherGapsX = [];
  const otherGapsY = [];
  for (let i = 0; i < allElements.length; i++) {
    for (let j = i + 1; j < allElements.length; j++) {
      const a = allElements[i];
      const b = allElements[j];
      const aLeft = a.x,
        aRight = a.x + a.w,
        aTop = a.y,
        aBottom = a.y + a.h;
      const bLeft = b.x,
        bRight = b.x + b.w,
        bTop = b.y,
        bBottom = b.y + b.h;

      // Vertical overlap for horizontal gaps
      if (aBottom > bTop && aTop < bBottom) {
        if (aRight <= bLeft) {
          const gap = bLeft - aRight;
          if (gap > 0 && gap < SPACING_RANGE) {
            const overlapTop = Math.max(aTop, bTop);
            const overlapBottom = Math.min(aBottom, bBottom);
            otherGapsX.push({
              from: aRight,
              to: bLeft,
              pos: (overlapTop + overlapBottom) / 2,
              dist: gap,
            });
          }
        } else if (bRight <= aLeft) {
          const gap = aLeft - bRight;
          if (gap > 0 && gap < SPACING_RANGE) {
            const overlapTop = Math.max(aTop, bTop);
            const overlapBottom = Math.min(aBottom, bBottom);
            otherGapsX.push({
              from: bRight,
              to: aLeft,
              pos: (overlapTop + overlapBottom) / 2,
              dist: gap,
            });
          }
        }
      }

      // Horizontal overlap for vertical gaps
      if (aRight > bLeft && aLeft < bRight) {
        if (aBottom <= bTop) {
          const gap = bTop - aBottom;
          if (gap > 0 && gap < SPACING_RANGE) {
            const overlapLeft = Math.max(aLeft, bLeft);
            const overlapRight = Math.min(aRight, bRight);
            otherGapsY.push({
              from: aBottom,
              to: bTop,
              pos: (overlapLeft + overlapRight) / 2,
              dist: gap,
            });
          }
        } else if (bBottom <= aTop) {
          const gap = aTop - bBottom;
          if (gap > 0 && gap < SPACING_RANGE) {
            const overlapLeft = Math.max(aLeft, bLeft);
            const overlapRight = Math.min(aRight, bRight);
            otherGapsY.push({
              from: bBottom,
              to: aTop,
              pos: (overlapLeft + overlapRight) / 2,
              dist: gap,
            });
          }
        }
      }
    }
  }

  // Mark our guides as equal if they match any other gap (within tolerance)
  const EQUAL_TOLERANCE = 2 / transform.zoom;
  for (const guide of guides) {
    const otherGaps = guide.axis === "x" ? otherGapsX : otherGapsY;
    for (const other of otherGaps) {
      if (Math.abs(guide.dist - other.dist) < EQUAL_TOLERANCE) {
        guide.isEqual = true;
        // Also add the matching gap as a guide so user sees both
        const exists = guides.some(
          (g) =>
            g.axis === guide.axis &&
            Math.abs(g.from - other.from) < 1 &&
            Math.abs(g.to - other.to) < 1,
        );
        if (!exists) {
          guides.push({
            axis: guide.axis,
            from: other.from,
            to: other.to,
            pos: other.pos,
            dist: other.dist,
            isEqual: true,
          });
        }
        break;
      }
    }
  }

  return guides;
}

function render(targetCtx = ctx, isExporting = false) {
  // For export calls, render synchronously (no batching)
  if (isExporting || targetCtx !== ctx) {
    _doRender(targetCtx, isExporting);
    return;
  }
  // For interactive rendering, batch via requestAnimationFrame
  scheduleRender();
}

function _doRender(targetCtx = ctx, isExporting = false) {
  if (!isExporting) {
    targetCtx.fillStyle = bgColor;
    targetCtx.fillRect(0, 0, canvas.width, canvas.height);
  }

  targetCtx.save();
  if (!isExporting) {
    targetCtx.translate(transform.x, transform.y);
    targetCtx.scale(transform.zoom, transform.zoom);
  }

  // Compute viewport bounds for culling (skip off-screen objects)
  const _vp = !isExporting ? getViewportBounds() : null;

  // 1. Render Background Assets
  images.forEach((imgData) => {
    // Viewport culling: skip images completely off-screen (but never skip crop target)
    if (_vp && !(cropMode && cropTarget && cropTarget.id === imgData.id) &&
        !isRectInViewport(imgData.x, imgData.y, imgData.w, imgData.h, _vp)) return;

    targetCtx.save();
    targetCtx.globalAlpha = imgData.opacity != null ? imgData.opacity : 1;
    // Use pre-rendered filtered image if a filter is active
    const drawSrc =
      !isExporting && currentFilter !== "none"
        ? getFilteredImage(imgData)
        : imgData.img;

    // In crop mode, the crop target is rendered by the overlay section instead
    if (!isExporting && cropMode && cropTarget && cropTarget.id === imgData.id) {
      // Draw the cropped portion at normal opacity (overlay will draw full image faintly behind)
      if (imgData.crop) {
        const c = imgData.crop;
        const natW = imgData.img.naturalWidth || imgData.img.width;
        const natH = imgData.img.naturalHeight || imgData.img.height;
        const sx = c.x * natW;
        const sy = c.y * natH;
        const sw = c.w * natW;
        const sh = c.h * natH;
        targetCtx.drawImage(drawSrc, sx, sy, sw, sh, imgData.x, imgData.y, imgData.w, imgData.h);
      } else {
        targetCtx.drawImage(drawSrc, imgData.x, imgData.y, imgData.w, imgData.h);
      }
      targetCtx.restore();
      return; // Skip selection UI for crop target
    }

    // If the image has crop data, draw only the cropped portion
    if (imgData.crop) {
      const c = imgData.crop;
      const natW = imgData.img.naturalWidth || imgData.img.width;
      const natH = imgData.img.naturalHeight || imgData.img.height;
      // crop is stored as fractions [0..1]
      const sx = c.x * natW;
      const sy = c.y * natH;
      const sw = c.w * natW;
      const sh = c.h * natH;
      targetCtx.drawImage(drawSrc, sx, sy, sw, sh, imgData.x, imgData.y, imgData.w, imgData.h);
    } else {
      targetCtx.drawImage(drawSrc, imgData.x, imgData.y, imgData.w, imgData.h);
    }
    targetCtx.restore();
    if (!isExporting && currentTool === "select" && !(cropMode && cropTarget && cropTarget.id === imgData.id)) {
      const isSelected = selectedElements.some((el) => el.id === imgData.id);
      const isGrouped = !!imgData.groupId;
      targetCtx.save();
      targetCtx.strokeStyle = isSelected
        ? isGrouped
          ? "#28a745"
          : "#ff4444"
        : "#007acc";
      targetCtx.lineWidth = (isSelected ? 3 : 1.5) / transform.zoom;
      if (isGrouped && isSelected) {
        targetCtx.setLineDash([6 / transform.zoom, 3 / transform.zoom]);
      }
      targetCtx.strokeRect(imgData.x, imgData.y, imgData.w, imgData.h);

      if (isSelected && selectedElements.length === 1) {
        targetCtx.fillStyle = "#ff4444";
        const hSize = RESIZE_HANDLE_SIZE / transform.zoom;
        const handles = getElementResizeHandles(imgData);
        handles.forEach((h) => {
          targetCtx.fillRect(h.x - hSize / 2, h.y - hSize / 2, hSize, hSize);
        });
      }
      targetCtx.restore();
    }
  });

  // 1.5 Render crop mode overlay
  if (!isExporting && cropMode && cropTarget && cropRect) {
    targetCtx.save();
    const el = cropTarget;
    const full = getFullImageBounds(el);
    const drawSrc = currentFilter !== "none" ? getFilteredImage(el) : el.img;

    // Draw the full uncropped image at reduced opacity so user can see hidden areas
    targetCtx.globalAlpha = 0.35;
    targetCtx.drawImage(drawSrc, full.x, full.y, full.w, full.h);
    targetCtx.globalAlpha = 1.0;

    // Draw the crop region at full brightness (overwrite the dim version)
    const natW = el.img.naturalWidth || el.img.width;
    const natH = el.img.naturalHeight || el.img.height;
    const cropFracX = (cropRect.x - full.x) / full.w;
    const cropFracY = (cropRect.y - full.y) / full.h;
    const cropFracW = cropRect.w / full.w;
    const cropFracH = cropRect.h / full.h;
    targetCtx.drawImage(
      drawSrc,
      cropFracX * natW, cropFracY * natH, cropFracW * natW, cropFracH * natH,
      cropRect.x, cropRect.y, cropRect.w, cropRect.h
    );

    // Dark overlay on the portions outside the crop rect (within full image bounds)
    targetCtx.fillStyle = "rgba(0, 0, 0, 0.45)";
    // Top strip
    targetCtx.fillRect(full.x, full.y, full.w, cropRect.y - full.y);
    // Bottom strip
    targetCtx.fillRect(full.x, cropRect.y + cropRect.h, full.w, (full.y + full.h) - (cropRect.y + cropRect.h));
    // Left strip
    targetCtx.fillRect(full.x, cropRect.y, cropRect.x - full.x, cropRect.h);
    // Right strip
    targetCtx.fillRect(cropRect.x + cropRect.w, cropRect.y, (full.x + full.w) - (cropRect.x + cropRect.w), cropRect.h);

    // Dashed border around full image extent
    targetCtx.strokeStyle = "rgba(0, 191, 255, 0.4)";
    targetCtx.lineWidth = 1 / transform.zoom;
    targetCtx.setLineDash([6 / transform.zoom, 4 / transform.zoom]);
    targetCtx.strokeRect(full.x, full.y, full.w, full.h);
    targetCtx.setLineDash([]);

    // Draw crop border (double stroke for contrast on any background)
    targetCtx.strokeStyle = "rgba(0, 0, 0, 0.6)";
    targetCtx.lineWidth = 3 / transform.zoom;
    targetCtx.setLineDash([]);
    targetCtx.strokeRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
    targetCtx.strokeStyle = "#00bfff";
    targetCtx.lineWidth = 1.5 / transform.zoom;
    targetCtx.strokeRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);

    // Draw rule-of-thirds grid lines
    targetCtx.strokeStyle = "rgba(0, 191, 255, 0.5)";
    targetCtx.lineWidth = 1 / transform.zoom;
    for (let i = 1; i <= 2; i++) {
      // Vertical lines
      const vx = cropRect.x + (cropRect.w * i) / 3;
      targetCtx.beginPath();
      targetCtx.moveTo(vx, cropRect.y);
      targetCtx.lineTo(vx, cropRect.y + cropRect.h);
      targetCtx.stroke();
      // Horizontal lines
      const hy = cropRect.y + (cropRect.h * i) / 3;
      targetCtx.beginPath();
      targetCtx.moveTo(cropRect.x, hy);
      targetCtx.lineTo(cropRect.x + cropRect.w, hy);
      targetCtx.stroke();
    }

    // Draw corner handles for the crop rect
    const hSize = 10 / transform.zoom;
    const hThick = 3 / transform.zoom;
    targetCtx.strokeStyle = "#00bfff";
    targetCtx.lineWidth = hThick;
    targetCtx.setLineDash([]);
    const corners = [
      { x: cropRect.x, y: cropRect.y, dx: 1, dy: 1 },
      { x: cropRect.x + cropRect.w, y: cropRect.y, dx: -1, dy: 1 },
      { x: cropRect.x, y: cropRect.y + cropRect.h, dx: 1, dy: -1 },
      { x: cropRect.x + cropRect.w, y: cropRect.y + cropRect.h, dx: -1, dy: -1 },
    ];
    corners.forEach((c) => {
      targetCtx.beginPath();
      targetCtx.moveTo(c.x, c.y + c.dy * hSize);
      targetCtx.lineTo(c.x, c.y);
      targetCtx.lineTo(c.x + c.dx * hSize, c.y);
      targetCtx.stroke();
    });

    // Draw edge midpoint handles
    const midpoints = [
      { x: cropRect.x + cropRect.w / 2, y: cropRect.y }, // top
      { x: cropRect.x + cropRect.w / 2, y: cropRect.y + cropRect.h }, // bottom
      { x: cropRect.x, y: cropRect.y + cropRect.h / 2 }, // left
      { x: cropRect.x + cropRect.w, y: cropRect.y + cropRect.h / 2 }, // right
    ];
    targetCtx.fillStyle = "#00bfff";
    const mSize = 4 / transform.zoom;
    midpoints.forEach((m) => {
      targetCtx.fillRect(m.x - mSize / 2, m.y - mSize / 2, mSize, mSize);
    });

    // Draw half/quarter snap guides when shift is held during crop drag
    if (cropDragEdge && isShiftPressed) {
      targetCtx.strokeStyle = "rgba(255, 180, 0, 0.6)";
      targetCtx.lineWidth = 1 / transform.zoom;
      targetCtx.setLineDash([4 / transform.zoom, 4 / transform.zoom]);
      const fracs = [0.25, 0.5, 0.75];
      fracs.forEach((f) => {
        // Vertical guide lines
        const gx = full.x + f * full.w;
        targetCtx.beginPath();
        targetCtx.moveTo(gx, full.y);
        targetCtx.lineTo(gx, full.y + full.h);
        targetCtx.stroke();
        // Horizontal guide lines
        const gy = full.y + f * full.h;
        targetCtx.beginPath();
        targetCtx.moveTo(full.x, gy);
        targetCtx.lineTo(full.x + full.w, gy);
        targetCtx.stroke();
      });
      targetCtx.setLineDash([]);
    }

    targetCtx.restore();
  }

  // 2. Render Vector Graphics & Text elements
  drawings.forEach((shape) => {
    // Viewport culling: skip shapes completely off-screen
    let shapeBounds;
    if (_vp) {
      shapeBounds = getShapeBounds(shape);
      if (!isRectInViewport(shapeBounds.x, shapeBounds.y, shapeBounds.w, shapeBounds.h, _vp)) return;
    }
    drawShape(targetCtx, shape, isExporting);
    if (!isExporting && currentTool === "select") {
      const isSelected = selectedElements.some((el) => el.id === shape.id);
      if (isSelected) {
        const b = shapeBounds || getShapeBounds(shape);
        const isGrouped = !!shape.groupId;
        targetCtx.save();
        targetCtx.strokeStyle = isGrouped ? "#28a745" : "#ff4444";
        targetCtx.lineWidth = 1.5 / transform.zoom;
        targetCtx.setLineDash([4 / transform.zoom, 4 / transform.zoom]);
        targetCtx.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8);

        if (selectedElements.length === 1) {
          targetCtx.fillStyle = "#ff4444";
          const hSize = RESIZE_HANDLE_SIZE / transform.zoom;
          const handles = getElementResizeHandles(shape);
          handles.forEach((h) => {
            targetCtx.fillRect(h.x - hSize / 2, h.y - hSize / 2, hSize, hSize);
          });
        }
        targetCtx.restore();
      }
    }
  });

  // Live preview layer
  if (!isExporting && activeShape) {
    drawShape(targetCtx, activeShape, false);
  }

  targetCtx.restore();

  // 2.5 Draw group bounding boxes (green dashed outline around entire group)
  if (!isExporting && currentTool === "select" && selectedElements.length > 1) {
    targetCtx.save();
    targetCtx.translate(transform.x, transform.y);
    targetCtx.scale(transform.zoom, transform.zoom);
    const groupIds = new Set();
    selectedElements.forEach((el) => {
      if (el.groupId) groupIds.add(el.groupId);
    });
    groupIds.forEach((gid) => {
      const groupEls = selectedElements.filter((el) => el.groupId === gid);
      if (groupEls.length < 2) return;
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      groupEls.forEach((el) => {
        const b =
          el.elementType === "image"
            ? { x: el.x, y: el.y, w: el.w, h: el.h }
            : getShapeBounds(el);
        if (b.x < minX) minX = b.x;
        if (b.y < minY) minY = b.y;
        if (b.x + b.w > maxX) maxX = b.x + b.w;
        if (b.y + b.h > maxY) maxY = b.y + b.h;
      });
      const pad = 8;
      targetCtx.strokeStyle = "rgba(40, 167, 69, 0.7)";
      targetCtx.lineWidth = 2 / transform.zoom;
      targetCtx.setLineDash([8 / transform.zoom, 4 / transform.zoom]);
      targetCtx.strokeRect(
        minX - pad,
        minY - pad,
        maxX - minX + pad * 2,
        maxY - minY + pad * 2,
      );
    });
    targetCtx.restore();
  }

  // 3. Draw Selection Boxes
  if (!isExporting) {
    targetCtx.save();
    targetCtx.translate(transform.x, transform.y);
    targetCtx.scale(transform.zoom, transform.zoom);
    if (isRegionSelecting) {
      targetCtx.strokeStyle = "rgba(0, 122, 204, 0.8)";
      targetCtx.fillStyle = "rgba(0, 122, 204, 0.1)";
      targetCtx.lineWidth = 1.5 / transform.zoom;
      targetCtx.setLineDash([6 / transform.zoom, 4 / transform.zoom]);
      const rx = Math.min(regionStart.x, regionEnd.x);
      const ry = Math.min(regionStart.y, regionEnd.y);
      const rw = Math.abs(regionEnd.x - regionStart.x);
      const rh = Math.abs(regionEnd.y - regionStart.y);
      targetCtx.fillRect(rx, ry, rw, rh);
      targetCtx.strokeRect(rx, ry, rw, rh);
    }

    // Draw snap guides
    if (activeSnapGuides.length > 0) {
      targetCtx.save();
      targetCtx.strokeStyle = "rgba(255, 0, 200, 0.8)";
      targetCtx.lineWidth = 1 / transform.zoom;
      targetCtx.setLineDash([4 / transform.zoom, 3 / transform.zoom]);
      const viewBounds = {
        minX: -transform.x / transform.zoom - 5000,
        maxX: (-transform.x + canvas.width) / transform.zoom + 5000,
        minY: -transform.y / transform.zoom - 5000,
        maxY: (-transform.y + canvas.height) / transform.zoom + 5000,
      };
      const drawn = new Set();
      activeSnapGuides.forEach((g) => {
        const key = g.axis + "_" + g.pos.toFixed(1);
        if (drawn.has(key)) return;
        drawn.add(key);
        targetCtx.beginPath();
        if (g.axis === "x") {
          targetCtx.moveTo(g.pos, viewBounds.minY);
          targetCtx.lineTo(g.pos, viewBounds.maxY);
        } else {
          targetCtx.moveTo(viewBounds.minX, g.pos);
          targetCtx.lineTo(viewBounds.maxX, g.pos);
        }
        targetCtx.stroke();
      });
      targetCtx.restore();
    }

    // Draw proximity guides (shown without shift, softer style)
    if (activeProximityGuides.length > 0 && activeSnapGuides.length === 0) {
      targetCtx.save();
      const drawn = new Set();
      activeProximityGuides.forEach((g) => {
        const key = g.axis + "_" + g.pos.toFixed(1);
        if (drawn.has(key)) return;
        drawn.add(key);
        // Fade opacity based on distance
        const maxRange = 150 / transform.zoom;
        const opacity = Math.max(0.15, 0.7 * (1 - g.dist / maxRange));
        targetCtx.strokeStyle = `rgba(0, 180, 255, ${opacity})`;
        targetCtx.lineWidth = 1 / transform.zoom;
        targetCtx.setLineDash([3 / transform.zoom, 3 / transform.zoom]);
        targetCtx.beginPath();
        if (g.axis === "x") {
          targetCtx.moveTo(g.pos, g.from);
          targetCtx.lineTo(g.pos, g.to);
        } else {
          targetCtx.moveTo(g.from, g.pos);
          targetCtx.lineTo(g.to, g.pos);
        }
        targetCtx.stroke();
      });
      targetCtx.restore();
    }

    // Draw spacing guides (distance measurements between elements)
    if (activeSpacingGuides.length > 0) {
      targetCtx.save();
      activeSpacingGuides.forEach((g) => {
        const isEqual = g.isEqual;
        const color = isEqual
          ? "rgba(40, 200, 80, 0.9)"
          : "rgba(255, 90, 90, 0.85)";
        const lineWidth = (isEqual ? 1.5 : 1) / transform.zoom;

        targetCtx.strokeStyle = color;
        targetCtx.fillStyle = color;
        targetCtx.lineWidth = lineWidth;
        targetCtx.setLineDash([]);

        const capSize = 4 / transform.zoom;

        if (g.axis === "x") {
          // Horizontal spacing line at vertical position g.pos
          const y = g.pos;
          const x1 = g.from;
          const x2 = g.to;

          // Main measurement line
          targetCtx.beginPath();
          targetCtx.moveTo(x1, y);
          targetCtx.lineTo(x2, y);
          targetCtx.stroke();

          // End caps (vertical ticks)
          targetCtx.beginPath();
          targetCtx.moveTo(x1, y - capSize);
          targetCtx.lineTo(x1, y + capSize);
          targetCtx.stroke();
          targetCtx.beginPath();
          targetCtx.moveTo(x2, y - capSize);
          targetCtx.lineTo(x2, y + capSize);
          targetCtx.stroke();

          // Distance label
          const dist = Math.round(g.dist);
          const fontSize = Math.max(9, 11 / transform.zoom);
          targetCtx.font = `bold ${fontSize}px sans-serif`;
          targetCtx.textAlign = "center";
          targetCtx.textBaseline = "bottom";

          // Label background
          const labelText = `${dist}`;
          const labelMetrics = targetCtx.measureText(labelText);
          const labelW = labelMetrics.width + 4 / transform.zoom;
          const labelH = fontSize + 2 / transform.zoom;
          const labelX = (x1 + x2) / 2;
          const labelY = y - capSize - 2 / transform.zoom;

          targetCtx.fillStyle = isEqual
            ? "rgba(30, 60, 30, 0.85)"
            : "rgba(60, 20, 20, 0.85)";
          targetCtx.fillRect(
            labelX - labelW / 2,
            labelY - labelH,
            labelW,
            labelH,
          );
          targetCtx.fillStyle = "#fff";
          targetCtx.fillText(labelText, labelX, labelY - 1 / transform.zoom);
        } else {
          // Vertical spacing line at horizontal position g.pos
          const x = g.pos;
          const y1 = g.from;
          const y2 = g.to;

          // Main measurement line
          targetCtx.beginPath();
          targetCtx.moveTo(x, y1);
          targetCtx.lineTo(x, y2);
          targetCtx.stroke();

          // End caps (horizontal ticks)
          targetCtx.beginPath();
          targetCtx.moveTo(x - capSize, y1);
          targetCtx.lineTo(x + capSize, y1);
          targetCtx.stroke();
          targetCtx.beginPath();
          targetCtx.moveTo(x - capSize, y2);
          targetCtx.lineTo(x + capSize, y2);
          targetCtx.stroke();

          // Distance label
          const dist = Math.round(g.dist);
          const fontSize = Math.max(9, 11 / transform.zoom);
          targetCtx.font = `bold ${fontSize}px sans-serif`;
          targetCtx.textAlign = "left";
          targetCtx.textBaseline = "middle";

          // Label background
          const labelText = `${dist}`;
          const labelMetrics = targetCtx.measureText(labelText);
          const labelW = labelMetrics.width + 4 / transform.zoom;
          const labelH = fontSize + 2 / transform.zoom;
          const labelX = x + capSize + 2 / transform.zoom;
          const labelY = (y1 + y2) / 2;

          targetCtx.fillStyle = isEqual
            ? "rgba(30, 60, 30, 0.85)"
            : "rgba(60, 20, 20, 0.85)";
          targetCtx.fillRect(labelX, labelY - labelH / 2, labelW, labelH);
          targetCtx.fillStyle = "#fff";
          targetCtx.fillText(labelText, labelX + 2 / transform.zoom, labelY);
        }
      });
      targetCtx.restore();
    }

    targetCtx.restore();
  }

  // 4.5 Draw swap handle and swap drag line
  if (!isExporting && currentTool === "select" && selectedElements.length >= 2) {
    targetCtx.save();
    targetCtx.translate(transform.x, transform.y);
    targetCtx.scale(transform.zoom, transform.zoom);

    const radius = getSwapHandleRadius();

    // Draw swap handle on hovered selected element
    if (swapHoveredElement && !isSwapDragging) {
      const center = getElementCenter(swapHoveredElement);
      // Draw circular handle background
      targetCtx.beginPath();
      targetCtx.arc(center.x, center.y, radius, 0, Math.PI * 2);
      targetCtx.fillStyle = "rgba(100, 100, 255, 0.85)";
      targetCtx.fill();
      targetCtx.strokeStyle = "#fff";
      targetCtx.lineWidth = 2 / transform.zoom;
      targetCtx.stroke();

      // Draw swap icon (two arrows)
      const iconSize = radius * 0.55;
      targetCtx.strokeStyle = "#fff";
      targetCtx.lineWidth = 1.8 / transform.zoom;
      targetCtx.lineCap = "round";
      targetCtx.lineJoin = "round";
      // Arrow pointing right
      targetCtx.beginPath();
      targetCtx.moveTo(center.x - iconSize, center.y - iconSize * 0.35);
      targetCtx.lineTo(center.x + iconSize * 0.5, center.y - iconSize * 0.35);
      targetCtx.lineTo(center.x + iconSize * 0.1, center.y - iconSize * 0.75);
      targetCtx.stroke();
      // Arrow pointing left
      targetCtx.beginPath();
      targetCtx.moveTo(center.x + iconSize, center.y + iconSize * 0.35);
      targetCtx.lineTo(center.x - iconSize * 0.5, center.y + iconSize * 0.35);
      targetCtx.lineTo(center.x - iconSize * 0.1, center.y + iconSize * 0.75);
      targetCtx.stroke();
    }

    // Draw swap drag line and target highlight
    if (isSwapDragging && swapSourceElement && swapDragWorldPos) {
      const sourceCenter = getElementCenter(swapSourceElement);

      // Draw source element highlight
      targetCtx.beginPath();
      targetCtx.arc(sourceCenter.x, sourceCenter.y, radius, 0, Math.PI * 2);
      targetCtx.fillStyle = "rgba(100, 100, 255, 0.9)";
      targetCtx.fill();
      targetCtx.strokeStyle = "#fff";
      targetCtx.lineWidth = 2 / transform.zoom;
      targetCtx.stroke();

      // Draw drag line from source center to cursor
      targetCtx.beginPath();
      targetCtx.moveTo(sourceCenter.x, sourceCenter.y);
      targetCtx.lineTo(swapDragWorldPos.x, swapDragWorldPos.y);
      targetCtx.strokeStyle = "rgba(100, 100, 255, 0.6)";
      targetCtx.lineWidth = 2.5 / transform.zoom;
      targetCtx.setLineDash([6 / transform.zoom, 4 / transform.zoom]);
      targetCtx.stroke();
      targetCtx.setLineDash([]);

      // Highlight target element if hovering over one
      if (swapTargetElement) {
        const targetBounds = swapTargetElement.elementType === "image"
          ? { x: swapTargetElement.x, y: swapTargetElement.y, w: swapTargetElement.w, h: swapTargetElement.h }
          : getShapeBounds(swapTargetElement);
        targetCtx.strokeStyle = "rgba(100, 100, 255, 0.8)";
        targetCtx.lineWidth = 3 / transform.zoom;
        targetCtx.setLineDash([]);
        targetCtx.strokeRect(targetBounds.x - 4, targetBounds.y - 4, targetBounds.w + 8, targetBounds.h + 8);

        // Draw swap icon on target center
        const targetCenter = getElementCenter(swapTargetElement);
        targetCtx.beginPath();
        targetCtx.arc(targetCenter.x, targetCenter.y, radius, 0, Math.PI * 2);
        targetCtx.fillStyle = "rgba(80, 200, 80, 0.85)";
        targetCtx.fill();
        targetCtx.strokeStyle = "#fff";
        targetCtx.lineWidth = 2 / transform.zoom;
        targetCtx.stroke();

        // Checkmark on target
        const checkSize = radius * 0.5;
        targetCtx.beginPath();
        targetCtx.moveTo(targetCenter.x - checkSize * 0.5, targetCenter.y);
        targetCtx.lineTo(targetCenter.x - checkSize * 0.1, targetCenter.y + checkSize * 0.4);
        targetCtx.lineTo(targetCenter.x + checkSize * 0.5, targetCenter.y - checkSize * 0.4);
        targetCtx.strokeStyle = "#fff";
        targetCtx.lineWidth = 2 / transform.zoom;
        targetCtx.lineCap = "round";
        targetCtx.lineJoin = "round";
        targetCtx.stroke();
      }
    }

    targetCtx.restore();
  }

  // 4. Draw measurement tool overlays
  if (!isExporting && currentTool === "measure") {
    targetCtx.save();
    targetCtx.translate(transform.x, transform.y);
    targetCtx.scale(transform.zoom, transform.zoom);

    // Draw active measurement line (during drag)
    if (activeMeasureLine) {
      drawMeasureLine(targetCtx, activeMeasureLine.start, activeMeasureLine.end, "#00bcd4", false);
    }

    // Draw hover distance guides to nearby items
    if (measureHoverGuides.length > 0) {
      measureHoverGuides.forEach((g) => {
        const zf = transform.zoom;
        const lineWidth = 1 / zf;
        const capSize = 4 / zf;
        const fontSize = Math.max(9, 10 / zf);

        targetCtx.save();
        targetCtx.strokeStyle = "rgba(0, 188, 212, 0.6)";
        targetCtx.fillStyle = "rgba(0, 188, 212, 0.6)";
        targetCtx.lineWidth = lineWidth;
        targetCtx.setLineDash([3 / zf, 2 / zf]);

        // Draw guide line from cursor to element edge
        targetCtx.beginPath();
        targetCtx.moveTo(g.fromX, g.fromY);
        targetCtx.lineTo(g.toX, g.toY);
        targetCtx.stroke();

        // End caps
        targetCtx.setLineDash([]);
        const angle = Math.atan2(g.toY - g.fromY, g.toX - g.fromX);
        const perpX = -Math.sin(angle) * capSize;
        const perpY = Math.cos(angle) * capSize;

        targetCtx.beginPath();
        targetCtx.moveTo(g.toX + perpX, g.toY + perpY);
        targetCtx.lineTo(g.toX - perpX, g.toY - perpY);
        targetCtx.stroke();

        // Distance label
        const midX = (g.fromX + g.toX) / 2;
        const midY = (g.fromY + g.toY) / 2;
        const labelText = `${Math.round(g.dist)}`;
        targetCtx.font = `bold ${fontSize}px sans-serif`;
        targetCtx.textAlign = "center";
        targetCtx.textBaseline = "bottom";

        const metrics = targetCtx.measureText(labelText);
        const labelW = metrics.width + 4 / zf;
        const labelH = fontSize + 4 / zf;
        const labelOffset = 8 / zf;
        const lx = midX + Math.sin(angle) * labelOffset;
        const ly = midY - Math.cos(angle) * labelOffset;

        targetCtx.fillStyle = "rgba(0, 40, 50, 0.75)";
        targetCtx.fillRect(lx - labelW / 2, ly - labelH, labelW, labelH);
        targetCtx.fillStyle = "#fff";
        targetCtx.fillText(labelText, lx, ly - 1 / zf);
        targetCtx.restore();
      });
    }

    targetCtx.restore();
  }

  if (!isExporting && ghostInput.style.display === "block" && activeTextCoord) {
    const screenPos = worldToScreen(activeTextCoord.x, activeTextCoord.y);
    ghostInput.style.left = `${screenPos.x}px`;
    ghostInput.style.top = `${screenPos.y - currentFontSize * transform.zoom * 0.2}px`;
    ghostInput.style.fontSize = `${currentFontSize * transform.zoom}px`;
  }
}

function computeMeasureHoverGuides(worldPos) {
  const MAX_DIST = 800 / transform.zoom;
  const MAX_GUIDES = 8;
  const guides = [];

  // Collect all element bounding boxes
  const allBounds = [];
  images.forEach((img) => {
    allBounds.push({ x: img.x, y: img.y, w: img.w, h: img.h, id: img.id });
  });
  drawings.forEach((shape) => {
    if (shape.type === "measure") return;
    const b = getShapeBounds(shape);
    allBounds.push({ x: b.x, y: b.y, w: b.w, h: b.h, id: shape.id });
  });

  // Find which element the cursor is hovering over
  let hoveredBounds = null;
  for (let i = allBounds.length - 1; i >= 0; i--) {
    const b = allBounds[i];
    if (worldPos.x >= b.x && worldPos.x <= b.x + b.w && worldPos.y >= b.y && worldPos.y <= b.y + b.h) {
      hoveredBounds = b;
      break;
    }
  }

  if (!hoveredBounds) {
    // Not hovering over an item: show cursor-to-edge distances to nearby elements
    for (const bounds of allBounds) {
      const left = bounds.x;
      const right = bounds.x + bounds.w;
      const top = bounds.y;
      const bottom = bounds.y + bounds.h;

      // Horizontal distance (cursor vertically overlaps element)
      if (worldPos.y >= top && worldPos.y <= bottom) {
        if (worldPos.x < left) {
          const dist = left - worldPos.x;
          if (dist < MAX_DIST) {
            guides.push({ fromX: worldPos.x, fromY: worldPos.y, toX: left, toY: worldPos.y, dist });
          }
        } else if (worldPos.x > right) {
          const dist = worldPos.x - right;
          if (dist < MAX_DIST) {
            guides.push({ fromX: worldPos.x, fromY: worldPos.y, toX: right, toY: worldPos.y, dist });
          }
        }
      }

      // Vertical distance (cursor horizontally overlaps element)
      if (worldPos.x >= left && worldPos.x <= right) {
        if (worldPos.y < top) {
          const dist = top - worldPos.y;
          if (dist < MAX_DIST) {
            guides.push({ fromX: worldPos.x, fromY: worldPos.y, toX: worldPos.x, toY: top, dist });
          }
        } else if (worldPos.y > bottom) {
          const dist = worldPos.y - bottom;
          if (dist < MAX_DIST) {
            guides.push({ fromX: worldPos.x, fromY: worldPos.y, toX: worldPos.x, toY: bottom, dist });
          }
        }
      }
    }

    guides.sort((a, b) => a.dist - b.dist);
    return guides.slice(0, MAX_GUIDES);
  }

  const myLeft = hoveredBounds.x;
  const myRight = hoveredBounds.x + hoveredBounds.w;
  const myTop = hoveredBounds.y;
  const myBottom = hoveredBounds.y + hoveredBounds.h;

  // For each other element, compute axis-aligned distances between edges
  for (const b of allBounds) {
    if (b.id === hoveredBounds.id) continue;

    const elLeft = b.x;
    const elRight = b.x + b.w;
    const elTop = b.y;
    const elBottom = b.y + b.h;

    // Check vertical overlap (for horizontal spacing)
    const vOverlap = myBottom > elTop && myTop < elBottom;
    // Check horizontal overlap (for vertical spacing)
    const hOverlap = myRight > elLeft && myLeft < elRight;

    if (vOverlap) {
      const overlapTop = Math.max(myTop, elTop);
      const overlapBottom = Math.min(myBottom, elBottom);
      const midY = (overlapTop + overlapBottom) / 2;

      // Element is to the left
      if (elRight <= myLeft) {
        const dist = myLeft - elRight;
        if (dist < MAX_DIST) {
          guides.push({ fromX: elRight, fromY: midY, toX: myLeft, toY: midY, dist });
        }
      }
      // Element is to the right
      if (elLeft >= myRight) {
        const dist = elLeft - myRight;
        if (dist < MAX_DIST) {
          guides.push({ fromX: myRight, fromY: midY, toX: elLeft, toY: midY, dist });
        }
      }
    }

    if (hOverlap) {
      const overlapLeft = Math.max(myLeft, elLeft);
      const overlapRight = Math.min(myRight, elRight);
      const midX = (overlapLeft + overlapRight) / 2;

      // Element is above
      if (elBottom <= myTop) {
        const dist = myTop - elBottom;
        if (dist < MAX_DIST) {
          guides.push({ fromX: midX, fromY: elBottom, toX: midX, toY: myTop, dist });
        }
      }
      // Element is below
      if (elTop >= myBottom) {
        const dist = elTop - myBottom;
        if (dist < MAX_DIST) {
          guides.push({ fromX: midX, fromY: myBottom, toX: midX, toY: elTop, dist });
        }
      }
    }
  }

  // Sort by distance and take closest
  guides.sort((a, b) => a.dist - b.dist);
  return guides.slice(0, MAX_GUIDES);
}

function drawMeasureLine(targetCtx, start, end, color, isExporting) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 0.1) return;

  const zoomFactor = isExporting ? 1 : transform.zoom;
  const lineWidth = (isExporting ? 2 : 1.5) / zoomFactor;
  const capSize = 6 / zoomFactor;
  const fontSize = Math.max(11, 13 / zoomFactor);

  targetCtx.save();
  targetCtx.strokeStyle = color || "#00bcd4";
  targetCtx.fillStyle = color || "#00bcd4";
  targetCtx.lineWidth = lineWidth;
  targetCtx.setLineDash([4 / zoomFactor, 3 / zoomFactor]);

  // Main measurement line
  targetCtx.beginPath();
  targetCtx.moveTo(start.x, start.y);
  targetCtx.lineTo(end.x, end.y);
  targetCtx.stroke();

  // End caps (perpendicular ticks)
  targetCtx.setLineDash([]);
  const angle = Math.atan2(dy, dx);
  const perpX = -Math.sin(angle) * capSize;
  const perpY = Math.cos(angle) * capSize;

  targetCtx.beginPath();
  targetCtx.moveTo(start.x + perpX, start.y + perpY);
  targetCtx.lineTo(start.x - perpX, start.y - perpY);
  targetCtx.stroke();

  targetCtx.beginPath();
  targetCtx.moveTo(end.x + perpX, end.y + perpY);
  targetCtx.lineTo(end.x - perpX, end.y - perpY);
  targetCtx.stroke();

  // Start/end point dots
  const dotR = 3 / zoomFactor;
  targetCtx.beginPath();
  targetCtx.arc(start.x, start.y, dotR, 0, Math.PI * 2);
  targetCtx.fill();
  targetCtx.beginPath();
  targetCtx.arc(end.x, end.y, dotR, 0, Math.PI * 2);
  targetCtx.fill();

  // Distance label at midpoint
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  const labelText = `${Math.round(dist)}px`;

  targetCtx.font = `bold ${fontSize}px sans-serif`;
  targetCtx.textAlign = "center";
  targetCtx.textBaseline = "bottom";

  const metrics = targetCtx.measureText(labelText);
  const labelW = metrics.width + 8 / zoomFactor;
  const labelH = fontSize + 6 / zoomFactor;

  // Offset label perpendicular to the line
  const labelOffset = 12 / zoomFactor;
  const labelCx = midX + Math.sin(angle) * labelOffset;
  const labelCy = midY - Math.cos(angle) * labelOffset;

  // Label background
  targetCtx.fillStyle = "rgba(0, 40, 50, 0.85)";
  targetCtx.fillRect(labelCx - labelW / 2, labelCy - labelH, labelW, labelH);

  // Label text
  targetCtx.fillStyle = "#fff";
  targetCtx.fillText(labelText, labelCx, labelCy - 2 / zoomFactor);

  targetCtx.restore();
}

function drawShape(targetCtx, shape, isExporting) {
  let calculatedWidth = shape.width;
  if (shape.type !== "text") {
    // Boost the line width specifically for exports, otherwise scale with zoom
    calculatedWidth = isExporting ? 8 : CONSTANT_LINE_WIDTH / transform.zoom;
  }

  targetCtx.save();
  targetCtx.globalAlpha = shape.opacity != null ? shape.opacity : 1;
  targetCtx.strokeStyle = shape.color;
  targetCtx.fillStyle = shape.color;
  targetCtx.lineWidth = calculatedWidth;
  targetCtx.lineCap = "round";
  targetCtx.lineJoin = "round";

  if (shape.type === "pen") {
    if (shape.points.length < 2) {
      targetCtx.restore();
      return;
    }
    targetCtx.beginPath();
    targetCtx.moveTo(shape.points[0].x, shape.points[0].y);
    for (let i = 1; i < shape.points.length; i++)
      targetCtx.lineTo(shape.points[i].x, shape.points[i].y);
    targetCtx.stroke();
  } else if (shape.type === "line") {
    targetCtx.beginPath();
    targetCtx.moveTo(shape.start.x, shape.start.y);
    targetCtx.lineTo(shape.end.x, shape.end.y);
    targetCtx.stroke();
  } else if (shape.type === "arrow") {
    const dx = shape.end.x - shape.start.x;
    const dy = shape.end.y - shape.start.y;
    const len = Math.sqrt(dx * dx + dy * dy);

    if (len > 0.1) {
      const ux = dx / len;
      const uy = dy / len;
      const headLength = Math.max(
        16 / (isExporting ? 1 : transform.zoom),
        calculatedWidth * 3.5,
      );
      const headWidth = Math.max(
        10 / (isExporting ? 1 : transform.zoom),
        calculatedWidth * 2.2,
      );
      const cx = shape.end.x - headLength * ux;
      const cy = shape.end.y - headLength * uy;
      const nx = -uy * headWidth;
      const ny = ux * headWidth;

      targetCtx.beginPath();
      targetCtx.moveTo(shape.start.x, shape.start.y);
      targetCtx.lineTo(cx, cy);
      targetCtx.stroke();

      targetCtx.beginPath();
      targetCtx.moveTo(shape.end.x, shape.end.y);
      targetCtx.lineTo(cx + nx, cy + ny);
      targetCtx.lineTo(cx - nx, cy - ny);
      targetCtx.closePath();
      targetCtx.fill();
    } else {
      targetCtx.beginPath();
      targetCtx.moveTo(shape.start.x, shape.start.y);
      targetCtx.lineTo(shape.end.x, shape.end.y);
      targetCtx.stroke();
    }
  } else if (shape.type === "rect-border") {
    targetCtx.strokeRect(
      shape.start.x,
      shape.start.y,
      shape.end.x - shape.start.x,
      shape.end.y - shape.start.y,
    );
  } else if (shape.type === "rect-fill") {
    targetCtx.fillRect(
      shape.start.x,
      shape.start.y,
      shape.end.x - shape.start.x,
      shape.end.y - shape.start.y,
    );
  } else if (shape.type === "measure") {
    drawMeasureLine(targetCtx, shape.start, shape.end, shape.color, isExporting);
  } else if (shape.type === "text") {
    targetCtx.font = `${shape.fontSize}px sans-serif`;
    targetCtx.textBaseline = "top";
    const lineHeight = shape.fontSize * 1.2;
    const lines = shape.text.split("\n");

    // Use cached text dimensions (only remeasure if text/fontSize changed)
    let cached = _textMeasureCache.get(shape);
    if (!cached || cached.text !== shape.text || cached.fontSize !== shape.fontSize) {
      let maxWidth = 0;
      lines.forEach((line) => {
        const metrics = targetCtx.measureText(line);
        if (metrics.width > maxWidth) maxWidth = metrics.width;
      });
      cached = { text: shape.text, fontSize: shape.fontSize, w: maxWidth, h: lineHeight * (lines.length - 1) + shape.fontSize };
      _textMeasureCache.set(shape, cached);
    }
    shape.w = cached.w;
    shape.h = cached.h;

    // Draw background if present
    if (shape.bgColor) {
      const padding = shape.fontSize * 0.4;
      targetCtx.fillStyle = shape.bgColor;
      targetCtx.beginPath();
      const rx = 4 / (isExporting ? 1 : transform.zoom);
      const bx = shape.start.x - padding;
      const by = shape.start.y - padding;
      const bw = shape.w + padding * 2;
      const bh = shape.h + padding * 2;
      targetCtx.roundRect(bx, by, bw, bh, rx);
      targetCtx.fill();
    }

    // Draw text
    targetCtx.fillStyle = shape.color;
    lines.forEach((line, i) => {
      targetCtx.fillText(line, shape.start.x, shape.start.y + i * lineHeight);
    });

    if (!isExporting && currentTool === "select") {
      const isSelected = selectedElements.some((el) => el.id === shape.id);
      targetCtx.strokeStyle = isSelected ? "#ff4444" : "rgba(0, 122, 204, 0.4)";
      targetCtx.lineWidth = 1 / (isExporting ? 1 : transform.zoom);
      const selPadding = shape.bgColor ? shape.fontSize * 0.4 : 2;
      targetCtx.strokeRect(
        shape.start.x - selPadding,
        shape.start.y - selPadding,
        shape.w + selPadding * 2,
        shape.h + selPadding * 2,
      );
    }
  }
  targetCtx.restore();
}

function checkAndEraseAtPosition(worldPos) {
  let erasedSomething = false;
  for (let i = drawings.length - 1; i >= 0; i--) {
    if (isPointHittingShape(worldPos, drawings[i])) {
      if (!erasedSomething) pushUndo();
      drawings.splice(i, 1);
      erasedSomething = true;
    }
  }
  if (erasedSomething) {
    render();
  }
}

// --- MOUSE & EVENT LOGIC ---
container.addEventListener("mousedown", (e) => {
  if (ghostInput.style.display === "block") {
    if (e.target === ghostInput) return; // Let the user click around inside their text input
    bakeText();
  }

  isInteracting = true;
  startX = e.clientX;
  startY = e.clientY;
  panLockDirection = null;
  resizingElement = null;

  isMiddleClick = e.button === 1;
  isRightClickHand = e.button === 2;

  let worldPos = screenToWorld(e.clientX, e.clientY);

  // --- Crop mode interaction ---
  if (cropMode && cropTarget && cropRect) {
    const full = getFullImageBounds(cropTarget);
    // Check if clicking outside the full image bounds exits crop mode
    if (
      worldPos.x < full.x - 20 / transform.zoom ||
      worldPos.x > full.x + full.w + 20 / transform.zoom ||
      worldPos.y < full.y - 20 / transform.zoom ||
      worldPos.y > full.y + full.h + 20 / transform.zoom
    ) {
      exitCropMode(false);
      isInteracting = false;
      return;
    }
    const edge = getCropEdgeAtPoint(worldPos);
    if (edge) {
      cropDragEdge = edge;
      cropDragStart = { ...worldPos, rect: { ...cropRect } };
      isInteracting = true;
      return;
    }
    // Click inside crop rect but not on edge — do nothing (allow repositioning later if needed)
    isInteracting = false;
    return;
  }

  if (isMiddleClick || isRightClickHand || currentTool === "pan") {
    updateCursor();
    return;
  }

  if (currentTool === "eraser") {
    checkAndEraseAtPosition(worldPos);
    return;
  }

  if (currentTool === "measure") {
    activeMeasureLine = {
      start: { ...worldPos },
      end: { ...worldPos },
    };
    measureHoverGuides = [];
    return;
  }

  if (currentTool === "text") {
    isInteracting = false;
    activeTextCoord = worldPos;
    ghostInput.value = "";
    ghostInput.style.display = "block";
    ghostInput.style.color = drawColor;
    ghostInput.dataset.bgColor = "";
    const screenPos = worldToScreen(worldPos.x, worldPos.y);
    ghostInput.style.left = `${screenPos.x}px`;
    ghostInput.style.top = `${screenPos.y - currentFontSize * transform.zoom * 0.2}px`;
    ghostInput.style.fontSize = `${currentFontSize * transform.zoom}px`;
    ghostInput.style.lineHeight = "1.2";
    ghostInput.style.height = "auto";
    ghostInput.style.background = "transparent";
    setTimeout(() => {
      ghostInput.focus();
      autoResizeGhostInput();
    }, 20);
    return;
  }

  if (currentTool === "text-element") {
    isInteracting = false;
    activeTextCoord = worldPos;
    ghostInput.value = "";
    ghostInput.style.display = "block";
    ghostInput.style.color = "#333333";
    ghostInput.dataset.bgColor = "#f5e642";
    const screenPos = worldToScreen(worldPos.x, worldPos.y);
    ghostInput.style.left = `${screenPos.x}px`;
    ghostInput.style.top = `${screenPos.y - currentFontSize * transform.zoom * 0.2}px`;
    ghostInput.style.fontSize = `${currentFontSize * transform.zoom}px`;
    ghostInput.style.lineHeight = "1.2";
    ghostInput.style.height = "auto";
    ghostInput.style.background = "#f5e642";
    ghostInput.style.border = "1px dashed #c4b800";
    setTimeout(() => {
      ghostInput.focus();
      autoResizeGhostInput();
    }, 20);
    return;
  }

  if (currentTool === "select") {
    // 0. Check swap handle hit (multi-select only)
    if (
      selectedElements.length >= 2 &&
      swapHoveredElement &&
      isPointOnSwapHandle(worldPos, swapHoveredElement)
    ) {
      isSwapDragging = true;
      swapSourceElement = swapHoveredElement;
      swapDragWorldPos = { ...worldPos };
      swapTargetElement = null;
      container.style.cursor = "grabbing";
      isInteracting = false; // Don't trigger normal drag
      return;
    }

    // 1. Check resize handle hits first
    if (selectedElements.length === 1) {
      const el = selectedElements[0];
      const threshold = RESIZE_HANDLE_SIZE / transform.zoom;
      const handles = getElementResizeHandles(el);

      for (const h of handles) {
        if (
          Math.abs(worldPos.x - h.x) <= threshold &&
          Math.abs(worldPos.y - h.y) <= threshold
        ) {
          // Store original bounds on first resize for restore-on-dblclick
          if (!el.originalBounds) {
            if (el.elementType === "image") {
              el.originalBounds = { w: el.w, h: el.h };
            } else if (el.type === "text") {
              el.originalBounds = { fontSize: el.fontSize };
            } else if (el.type === "pen") {
              el.originalBounds = {
                points: el.points.map((p) => ({ ...p })),
              };
            } else {
              el.originalBounds = {
                start: { ...el.start },
                end: el.end ? { ...el.end } : null,
              };
            }
          }
          pushUndo();
          resizingElement = el;
          const b =
            el.elementType === "image"
              ? { x: el.x, y: el.y, w: el.w, h: el.h }
              : getShapeBounds(el);
          resizeStartBounds = {
            x: b.x,
            y: b.y,
            w: b.w,
            h: b.h,
            ratio: b.w / b.h || 1,
            handlePosition: h.position,
            startMouse: { ...worldPos },
            // Store original element data for drawing shapes
            origStart: el.start ? { ...el.start } : null,
            origEnd: el.end ? { ...el.end } : null,
            origPoints: el.points ? el.points.map((p) => ({ ...p })) : null,
            origFontSize: el.fontSize || null,
            origW: el.w || null,
            origH: el.h || null,
            origX: el.x !== undefined ? el.x : null,
            origY: el.y !== undefined ? el.y : null,
          };
          return;
        }
      }
    }

    // 2. Normal element selection hit testing
    let clickedElement = null;
    const isModifierActive = e.metaKey || e.shiftKey || e.ctrlKey;

    for (let i = drawings.length - 1; i >= 0; i--) {
      if (isPointHittingShape(worldPos, drawings[i])) {
        clickedElement = drawings[i];
        if (clickedElement.type !== "text")
          clickedElement.elementType = "drawing";
        break;
      }
    }

    if (!clickedElement) {
      for (let i = images.length - 1; i >= 0; i--) {
        const img = images[i];
        if (
          worldPos.x >= img.x &&
          worldPos.x <= img.x + img.w &&
          worldPos.y >= img.y &&
          worldPos.y <= img.y + img.h
        ) {
          clickedElement = img;
          clickedElement.elementType = "image";
          if (!isModifierActive) {
            images.push(images.splice(i, 1)[0]);
          }
          break;
        }
      }
    }

    if (clickedElement) {
      isRegionSelecting = false;
      if (isModifierActive) {
        const alreadySelectedIdx = selectedElements.findIndex(
          (el) => el.id === clickedElement.id,
        );
        if (alreadySelectedIdx !== -1) {
          selectedElements.splice(alreadySelectedIdx, 1);
        } else {
          selectedElements.push(clickedElement);
        }
      } else {
        const isAlreadyInSelection = selectedElements.some(
          (el) => el.id === clickedElement.id,
        );
        if (!isAlreadyInSelection) {
          selectedElements = [clickedElement];
        }
      }

      // Expand selection to include all elements in the same group(s)
      expandSelectionToGroups();

      // Push undo before drag starts
      pushUndo();

      dragOffsets = selectedElements.map((el) => {
        if (el.elementType === "image") {
          return {
            id: el.id,
            type: "image",
            x: el.x,
            y: el.y,
            startMouse: { ...worldPos },
          };
        } else if (el.type === "pen") {
          return {
            id: el.id,
            type: "points",
            points: el.points.map((p) => ({ ...p })),
            startMouse: { ...worldPos },
          };
        } else {
          return {
            id: el.id,
            type: "vectors",
            start: { ...el.start },
            end: el.end ? { ...el.end } : null,
            startMouse: { ...worldPos },
          };
        }
      });
    } else {
      if (!isModifierActive) selectedElements = [];
      isRegionSelecting = true;
      regionStart = { ...worldPos };
      regionEnd = { ...worldPos };
    }
    toggleAlignmentPanelVisibility();
    render();
  } else if (
    ["pen", "line", "arrow", "rect-border", "rect-fill"].includes(currentTool)
  ) {
    activeShape = {
      id: "draw_" + elementIdCounter++,
      type: currentTool,
      color: drawColor,
      width: CONSTANT_LINE_WIDTH,
      start: worldPos,
      end: worldPos,
      points: [worldPos],
    };
  }
});

// Double-click to edit existing text elements
container.addEventListener("dblclick", (e) => {
  // If in crop mode, double-click applies the crop
  if (cropMode) {
    exitCropMode(true);
    return;
  }

  if (currentTool !== "select") return; // Only allow editing in Select Mode

  const worldPos = screenToWorld(e.clientX, e.clientY);

  // Check if double-clicking a resize handle to restore original size
  if (selectedElements.length === 1) {
    const el = selectedElements[0];
    const threshold = RESIZE_HANDLE_SIZE / transform.zoom;
    const handles = getElementResizeHandles(el);
    let hitHandle = false;

    for (const h of handles) {
      if (
        Math.abs(worldPos.x - h.x) <= threshold &&
        Math.abs(worldPos.y - h.y) <= threshold
      ) {
        hitHandle = true;
        break;
      }
    }

    if (hitHandle && el.originalBounds) {
      const ob = el.originalBounds;
      if (el.elementType === "image") {
        // Restore to natural image dimensions, centered on current position
        const centerX = el.x + el.w / 2;
        const centerY = el.y + el.h / 2;
        el.w = ob.w;
        el.h = ob.h;
        el.x = centerX - ob.w / 2;
        el.y = centerY - ob.h / 2;
      } else if (el.type === "text") {
        el.fontSize = ob.fontSize;
      } else if (el.type === "pen") {
        el.points = ob.points.map((p) => ({ ...p }));
      } else {
        el.start = { ...ob.start };
        if (ob.end) el.end = { ...ob.end };
      }
      showToast("Restored to original size");
      render();
      return;
    }
  }

  // Check if we double-clicked an image to enter crop mode
  for (let i = images.length - 1; i >= 0; i--) {
    const img = images[i];
    if (
      worldPos.x >= img.x &&
      worldPos.x <= img.x + img.w &&
      worldPos.y >= img.y &&
      worldPos.y <= img.y + img.h
    ) {
      enterCropMode(img);
      render();
      return;
    }
  }

  // Find if we double-clicked a text element (looping backwards for top-most)
  for (let i = drawings.length - 1; i >= 0; i--) {
    const shape = drawings[i];
    if (shape.type === "text" && isPointHittingShape(worldPos, shape)) {
      // 1. Remove it from the drawing array so it doesn't double-render
      const [editingText] = drawings.splice(i, 1);
      selectedElements = []; // Clear selection highlights

      // 2. Position the ghost input over the old text
      activeTextCoord = editingText.start;
      currentFontSize = editingText.fontSize;

      ghostInput.value = editingText.text;
      ghostInput.style.display = "block";
      ghostInput.style.color = editingText.color;

      // Preserve background color for sticky note editing
      if (editingText.bgColor) {
        ghostInput.dataset.bgColor = editingText.bgColor;
        ghostInput.style.background = editingText.bgColor;
        ghostInput.style.border = "1px dashed #c4b800";
      } else {
        ghostInput.dataset.bgColor = "";
        ghostInput.style.background = "transparent";
        ghostInput.style.border = "1px dashed #007acc";
      }

      const screenPos = worldToScreen(activeTextCoord.x, activeTextCoord.y);
      ghostInput.style.left = `${screenPos.x}px`;
      ghostInput.style.top = `${screenPos.y - currentFontSize * transform.zoom * 0.2}px`;
      ghostInput.style.fontSize = `${currentFontSize * transform.zoom}px`;
      ghostInput.style.lineHeight = "1.2";
      ghostInput.style.height = "auto";

      // 3. Focus and highlight the text for quick changing
      setTimeout(() => {
        ghostInput.focus();
        ghostInput.select();
        autoResizeGhostInput();
      }, 20);

      render();
      break;
    }
  }
});

container.addEventListener("mousemove", (e) => {
  // Crop mode: update cursor based on edge proximity even when not dragging
  if (cropMode && cropTarget && cropRect && !isInteracting) {
    const worldPos = screenToWorld(e.clientX, e.clientY);
    const edge = getCropEdgeAtPoint(worldPos);
    container.style.cursor = edge ? getCropCursor(edge) : "default";
    return;
  }

  if (!isInteracting) return;

  // Sync shift state from the live event to avoid stale keydown/keyup tracking
  isShiftPressed = e.shiftKey;

  let dx = e.clientX - startX;
  let dy = e.clientY - startY;
  let worldPos = screenToWorld(e.clientX, e.clientY);

  // --- Crop drag handling ---
  if (cropMode && cropDragEdge && cropDragStart && cropTarget) {
    const r = cropDragStart.rect;
    const mdx = worldPos.x - cropDragStart.x;
    const mdy = worldPos.y - cropDragStart.y;
    const minSize = 20 / transform.zoom;
    const full = getFullImageBounds(cropTarget);
    const imgLeft = full.x;
    const imgTop = full.y;
    const imgRight = full.x + full.w;
    const imgBottom = full.y + full.h;

    let newX = r.x, newY = r.y, newW = r.w, newH = r.h;

    // Apply edge/corner drag
    if (cropDragEdge.includes("w")) {
      const maxLeftMove = r.x - imgLeft;
      const moved = Math.max(-maxLeftMove, Math.min(mdx, r.w - minSize));
      newX = r.x + moved;
      newW = r.w - moved;
    }
    if (cropDragEdge.includes("e")) {
      const maxRightExtend = imgRight - (r.x + r.w);
      const moved = Math.max(-(r.w - minSize), Math.min(mdx, maxRightExtend));
      newW = r.w + moved;
    }
    if (cropDragEdge.includes("n")) {
      const maxTopMove = r.y - imgTop;
      const moved = Math.max(-maxTopMove, Math.min(mdy, r.h - minSize));
      newY = r.y + moved;
      newH = r.h - moved;
    }
    if (cropDragEdge.includes("s")) {
      const maxBottomExtend = imgBottom - (r.y + r.h);
      const moved = Math.max(-(r.h - minSize), Math.min(mdy, maxBottomExtend));
      newH = r.h + moved;
    }

    // Shift-snap: snap crop edges to half and quarter points of the full image
    if (e.shiftKey) {
      const snapThreshold = 10 / transform.zoom;
      // Snap points at 0%, 25%, 50%, 75%, 100% of image dimensions
      const xSnaps = [0, 0.25, 0.5, 0.75, 1].map(f => full.x + f * full.w);
      const ySnaps = [0, 0.25, 0.5, 0.75, 1].map(f => full.y + f * full.h);

      // Snap left edge (x)
      if (cropDragEdge.includes("w")) {
        for (const sx of xSnaps) {
          if (Math.abs(newX - sx) < snapThreshold) {
            newW += newX - sx;
            newX = sx;
            break;
          }
        }
      }
      // Snap right edge (x + w)
      if (cropDragEdge.includes("e")) {
        for (const sx of xSnaps) {
          if (Math.abs((newX + newW) - sx) < snapThreshold) {
            newW = sx - newX;
            break;
          }
        }
      }
      // Snap top edge (y)
      if (cropDragEdge.includes("n")) {
        for (const sy of ySnaps) {
          if (Math.abs(newY - sy) < snapThreshold) {
            newH += newY - sy;
            newY = sy;
            break;
          }
        }
      }
      // Snap bottom edge (y + h)
      if (cropDragEdge.includes("s")) {
        for (const sy of ySnaps) {
          if (Math.abs((newY + newH) - sy) < snapThreshold) {
            newH = sy - newY;
            break;
          }
        }
      }
    }

    cropRect = { x: newX, y: newY, w: newW, h: newH };
    render();
    return;
  }

  if (isMiddleClick || isRightClickHand || currentTool === "pan") {
    if (e.shiftKey) {
      if (!panLockDirection) {
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
          panLockDirection = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
        }
      }
      if (panLockDirection === "x") dy = 0;
      else if (panLockDirection === "y") dx = 0;
    } else {
      panLockDirection = null;
    }
    transform.x += dx;
    transform.y += dy;
    startX = e.clientX;
    startY = e.clientY;
    updateZoomSliderValue();
    render();
    return;
  }

  if (currentTool === "eraser") {
    checkAndEraseAtPosition(worldPos);
    return;
  }

  if (currentTool === "select") {
    if (resizingElement) {
      const el = resizingElement;
      const sb = resizeStartBounds;
      const hp = sb.handlePosition;
      const mouseDx = worldPos.x - sb.startMouse.x;
      const mouseDy = worldPos.y - sb.startMouse.y;

      if (el.elementType === "image") {
        // Proportional resize for images from any corner
        let newW, newH, newX, newY;
        if (hp === "br") {
          newW = Math.max(20, sb.w + mouseDx);
          newH = newW / sb.ratio;
          newX = sb.x;
          newY = sb.y;
        } else if (hp === "bl") {
          newW = Math.max(20, sb.w - mouseDx);
          newH = newW / sb.ratio;
          newX = sb.x + sb.w - newW;
          newY = sb.y;
        } else if (hp === "tr") {
          newW = Math.max(20, sb.w + mouseDx);
          newH = newW / sb.ratio;
          newX = sb.x;
          newY = sb.y + sb.h - newH;
        } else {
          // tl
          newW = Math.max(20, sb.w - mouseDx);
          newH = newW / sb.ratio;
          newX = sb.x + sb.w - newW;
          newY = sb.y + sb.h - newH;
        }

        // Shift: snap size to 25% increments of the natural image size
        if (e.shiftKey) {
          const naturalW = el.img.naturalWidth || sb.w;
          const naturalH = el.img.naturalHeight || sb.h;
          const stepW = naturalW * 0.25;
          const stepH = naturalH * 0.25;
          newW = Math.max(stepW, Math.round(newW / stepW) * stepW);
          newH = Math.max(stepH, Math.round(newH / stepH) * stepH);
          // Re-anchor position after snapping
          if (hp === "bl" || hp === "tl") {
            newX = sb.x + sb.w - newW;
          }
          if (hp === "tr" || hp === "tl") {
            newY = sb.y + sb.h - newH;
          }
        }

        el.x = newX;
        el.y = newY;
        el.w = newW;
        el.h = newH;
      } else if (el.type === "text") {
        // Scale font size based on width drag
        let scaleFactor;
        const initialW = sb.w || 50;
        if (hp === "br" || hp === "tr") {
          scaleFactor = (initialW + mouseDx) / initialW;
        } else {
          scaleFactor = (initialW - mouseDx) / initialW;
        }
        scaleFactor = Math.max(0.2, scaleFactor);
        el.fontSize = Math.max(8, Math.round(sb.origFontSize * scaleFactor));
      } else if (el.type === "pen") {
        // Scale all pen points relative to the bounding box
        const origBounds = { x: sb.x, y: sb.y, w: sb.w, h: sb.h };
        let scaleX = 1,
          scaleY = 1;
        let anchorX, anchorY;

        if (hp === "br") {
          anchorX = origBounds.x;
          anchorY = origBounds.y;
          scaleX =
            origBounds.w > 0 ? (origBounds.w + mouseDx) / origBounds.w : 1;
          scaleY =
            origBounds.h > 0 ? (origBounds.h + mouseDy) / origBounds.h : 1;
        } else if (hp === "bl") {
          anchorX = origBounds.x + origBounds.w;
          anchorY = origBounds.y;
          scaleX =
            origBounds.w > 0 ? (origBounds.w - mouseDx) / origBounds.w : 1;
          scaleY =
            origBounds.h > 0 ? (origBounds.h + mouseDy) / origBounds.h : 1;
        } else if (hp === "tr") {
          anchorX = origBounds.x;
          anchorY = origBounds.y + origBounds.h;
          scaleX =
            origBounds.w > 0 ? (origBounds.w + mouseDx) / origBounds.w : 1;
          scaleY =
            origBounds.h > 0 ? (origBounds.h - mouseDy) / origBounds.h : 1;
        } else {
          // tl
          anchorX = origBounds.x + origBounds.w;
          anchorY = origBounds.y + origBounds.h;
          scaleX =
            origBounds.w > 0 ? (origBounds.w - mouseDx) / origBounds.w : 1;
          scaleY =
            origBounds.h > 0 ? (origBounds.h - mouseDy) / origBounds.h : 1;
        }

        if (e.shiftKey) {
          const uniformScale = Math.max(scaleX, scaleY);
          scaleX = uniformScale;
          scaleY = uniformScale;
        }

        scaleX = Math.max(0.1, scaleX);
        scaleY = Math.max(0.1, scaleY);

        el.points = sb.origPoints.map((p) => ({
          x: anchorX + (p.x - anchorX) * scaleX,
          y: anchorY + (p.y - anchorY) * scaleY,
        }));
      } else {
        // Line, arrow, rect-border, rect-fill: resize via start/end
        const origStart = sb.origStart;
        const origEnd = sb.origEnd;
        const origBounds = { x: sb.x, y: sb.y, w: sb.w, h: sb.h };

        let scaleX = 1,
          scaleY = 1;
        let anchorX, anchorY;

        if (hp === "br") {
          anchorX = origBounds.x;
          anchorY = origBounds.y;
          scaleX =
            origBounds.w > 0 ? (origBounds.w + mouseDx) / origBounds.w : 1;
          scaleY =
            origBounds.h > 0 ? (origBounds.h + mouseDy) / origBounds.h : 1;
        } else if (hp === "bl") {
          anchorX = origBounds.x + origBounds.w;
          anchorY = origBounds.y;
          scaleX =
            origBounds.w > 0 ? (origBounds.w - mouseDx) / origBounds.w : 1;
          scaleY =
            origBounds.h > 0 ? (origBounds.h + mouseDy) / origBounds.h : 1;
        } else if (hp === "tr") {
          anchorX = origBounds.x;
          anchorY = origBounds.y + origBounds.h;
          scaleX =
            origBounds.w > 0 ? (origBounds.w + mouseDx) / origBounds.w : 1;
          scaleY =
            origBounds.h > 0 ? (origBounds.h - mouseDy) / origBounds.h : 1;
        } else {
          // tl
          anchorX = origBounds.x + origBounds.w;
          anchorY = origBounds.y + origBounds.h;
          scaleX =
            origBounds.w > 0 ? (origBounds.w - mouseDx) / origBounds.w : 1;
          scaleY =
            origBounds.h > 0 ? (origBounds.h - mouseDy) / origBounds.h : 1;
        }

        if (e.shiftKey) {
          const uniformScale = Math.max(scaleX, scaleY);
          scaleX = uniformScale;
          scaleY = uniformScale;
        }

        scaleX = Math.max(0.1, scaleX);
        scaleY = Math.max(0.1, scaleY);

        el.start = {
          x: anchorX + (origStart.x - anchorX) * scaleX,
          y: anchorY + (origStart.y - anchorY) * scaleY,
        };
        if (origEnd) {
          el.end = {
            x: anchorX + (origEnd.x - anchorX) * scaleX,
            y: anchorY + (origEnd.y - anchorY) * scaleY,
          };
        }
      }
      render();
      return;
    }

    if (isRegionSelecting) {
      regionEnd = { ...worldPos };
      render();
    } else if (selectedElements.length > 0) {
      // Compute preliminary positions without snapping
      const excludeIds = selectedElements.map((el) => el.id);
      let groupBounds = null;

      selectedElements.forEach((el) => {
        const offset = dragOffsets.find((o) => o.id === el.id);
        if (!offset) return;
        const curDx = worldPos.x - offset.startMouse.x;
        const curDy = worldPos.y - offset.startMouse.y;

        if (offset.type === "image") {
          el.x = offset.x + curDx;
          el.y = offset.y + curDy;
        } else if (offset.type === "points") {
          el.points = offset.points.map((p) => ({
            x: p.x + curDx,
            y: p.y + curDy,
          }));
        } else {
          el.start = { x: offset.start.x + curDx, y: offset.start.y + curDy };
          if (el.end && offset.end) {
            el.end = { x: offset.end.x + curDx, y: offset.end.y + curDy };
          }
        }
      });

      if (e.shiftKey) {
        // Calculate bounding box of all dragged elements
        let minX = Infinity,
          minY = Infinity,
          maxX = -Infinity,
          maxY = -Infinity;
        selectedElements.forEach((el) => {
          let b;
          if (el.elementType === "image") {
            b = { x: el.x, y: el.y, w: el.w, h: el.h };
          } else {
            b = getShapeBounds(el);
          }
          if (b.x < minX) minX = b.x;
          if (b.y < minY) minY = b.y;
          if (b.x + b.w > maxX) maxX = b.x + b.w;
          if (b.y + b.h > maxY) maxY = b.y + b.h;
        });
        groupBounds = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };

        const targets = getSnapTargets(excludeIds, groupBounds);
        const threshold = SNAP_THRESHOLD / transform.zoom;
        const snap = snapToElements(groupBounds, targets, threshold);
        const spacingSnap = snapToSpacing(groupBounds, excludeIds, threshold);

        // Combine: use spacing snap if it's closer than edge snap per axis
        let finalDx = snap.dx;
        let finalDy = snap.dy;
        if (
          Math.abs(spacingSnap.dx) > 0 &&
          (Math.abs(snap.dx) === 0 ||
            Math.abs(spacingSnap.dx) < Math.abs(snap.dx))
        ) {
          finalDx = spacingSnap.dx;
        }
        if (
          Math.abs(spacingSnap.dy) > 0 &&
          (Math.abs(snap.dy) === 0 ||
            Math.abs(spacingSnap.dy) < Math.abs(snap.dy))
        ) {
          finalDy = spacingSnap.dy;
        }

        if (finalDx !== 0 || finalDy !== 0) {
          // Apply snap offset to all selected elements
          selectedElements.forEach((el) => {
            if (el.elementType === "image") {
              el.x += finalDx;
              el.y += finalDy;
            } else if (el.type === "pen") {
              el.points = el.points.map((p) => ({
                x: p.x + finalDx,
                y: p.y + finalDy,
              }));
            } else {
              el.start.x += finalDx;
              el.start.y += finalDy;
              if (el.end) {
                el.end.x += finalDx;
                el.end.y += finalDy;
              }
            }
          });
        }

        // Recompute group bounds after snap for accurate spacing guides
        minX = Infinity;
        minY = Infinity;
        maxX = -Infinity;
        maxY = -Infinity;
        selectedElements.forEach((el) => {
          let b;
          if (el.elementType === "image") {
            b = { x: el.x, y: el.y, w: el.w, h: el.h };
          } else {
            b = getShapeBounds(el);
          }
          if (b.x < minX) minX = b.x;
          if (b.y < minY) minY = b.y;
          if (b.x + b.w > maxX) maxX = b.x + b.w;
          if (b.y + b.h > maxY) maxY = b.y + b.h;
        });
        groupBounds = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };

        activeSnapGuides = snap.guides;
        activeProximityGuides = [];
        activeSpacingGuides = getSpacingGuides(groupBounds, excludeIds);
      } else {
        activeSnapGuides = [];
        // Compute proximity guides (always visible during drag without shift)
        let minX = Infinity,
          minY = Infinity,
          maxX = -Infinity,
          maxY = -Infinity;
        selectedElements.forEach((el) => {
          let b;
          if (el.elementType === "image") {
            b = { x: el.x, y: el.y, w: el.w, h: el.h };
          } else {
            b = getShapeBounds(el);
          }
          if (b.x < minX) minX = b.x;
          if (b.y < minY) minY = b.y;
          if (b.x + b.w > maxX) maxX = b.x + b.w;
          if (b.y + b.h > maxY) maxY = b.y + b.h;
        });
        groupBounds = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
        activeProximityGuides = getProximityGuides(groupBounds, excludeIds);
        activeSpacingGuides = getSpacingGuides(groupBounds, excludeIds);
      }

      render();
    }
  } else if (activeMeasureLine) {
    if (e.shiftKey) worldPos = constraintToAngle(activeMeasureLine.start, worldPos);
    activeMeasureLine.end = { ...worldPos };
    render();
  } else if (activeShape) {
    if (activeShape.type === "pen") {
      if (e.shiftKey && activeShape.points.length > 0)
        worldPos = constraintToAngle(activeShape.points[0], worldPos);
      activeShape.points.push(worldPos);
    } else {
      if (e.shiftKey) worldPos = constraintToAngle(activeShape.start, worldPos);
      activeShape.end = worldPos;
    }
    render();
  }
});

container.addEventListener("mouseup", (e) => {
  if (!isInteracting) return;
  isInteracting = false;
  panLockDirection = null;
  resizingElement = null;
  activeSnapGuides = [];
  activeProximityGuides = [];
  activeSpacingGuides = [];

  // End crop drag
  if (cropMode && cropDragEdge) {
    cropDragEdge = null;
    cropDragStart = null;
    render();
    return;
  }

  if (currentTool === "measure" && activeMeasureLine) {
    const dx = activeMeasureLine.end.x - activeMeasureLine.start.x;
    const dy = activeMeasureLine.end.y - activeMeasureLine.start.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 5 / transform.zoom) {
      pushUndo();
      drawings.push({
        id: "draw_" + elementIdCounter++,
        elementType: "drawing",
        type: "measure",
        color: "#00bcd4",
        width: CONSTANT_LINE_WIDTH,
        start: { ...activeMeasureLine.start },
        end: { ...activeMeasureLine.end },
      });
    }
    activeMeasureLine = null;
    render();
    scheduleSave();
    isMiddleClick = false;
    isRightClickHand = false;
    updateCursor();
    return;
  }

  if (currentTool === "select" && isRegionSelecting) {
    isRegionSelecting = false;
    const rx = Math.min(regionStart.x, regionEnd.x);
    const ry = Math.min(regionStart.y, regionEnd.y);
    const rw = Math.abs(regionEnd.x - regionStart.x);
    const rh = Math.abs(regionEnd.y - regionStart.y);
    const isModifierActive = e.metaKey || e.ctrlKey;

    if (!isModifierActive) selectedElements = [];

    images.forEach((img) => {
      if (
        img.x >= rx &&
        img.x + img.w <= rx + rw &&
        img.y >= ry &&
        img.y + img.h <= ry + rh
      ) {
        if (!selectedElements.some((el) => el.id === img.id))
          selectedElements.push(img);
      }
    });

    drawings.forEach((shape) => {
      const b = getShapeBounds(shape);
      const fullyInside =
        b.x >= rx && b.x + b.w <= rx + rw && b.y >= ry && b.y + b.h <= ry + rh;
      if (fullyInside) {
        if (shape.type !== "text") shape.elementType = "drawing";
        if (!selectedElements.some((el) => el.id === shape.id))
          selectedElements.push(shape);
      }
    });
    // Expand selection to include all elements in the same group(s)
    expandSelectionToGroups();
    if (selectedElements.length > 0)
      showToast(`Selected group of ${selectedElements.length} assets`);
  }

  if (activeShape) {
    pushUndo();
    drawings.push(activeShape);
    activeShape = null;
  }

  toggleAlignmentPanelVisibility();
  render();
  isMiddleClick = false;
  isRightClickHand = false;
  updateCursor();
  scheduleSave();
});

function bakeText() {
  const val = ghostInput.value.trim();
  if (val && activeTextCoord) {
    pushUndo();
    const textEl = {
      id: "text_" + elementIdCounter++,
      elementType: "text",
      type: "text",
      text: val,
      color: ghostInput.style.color || drawColor,
      fontSize: currentFontSize,
      start: { x: activeTextCoord.x, y: activeTextCoord.y },
    };
    if (ghostInput.dataset.bgColor) {
      textEl.bgColor = ghostInput.dataset.bgColor;
    }
    drawings.push(textEl);
  }
  ghostInput.style.display = "none";
  ghostInput.style.background = "transparent";
  ghostInput.style.border = "1px dashed #007acc";
  ghostInput.dataset.bgColor = "";
  activeTextCoord = null;
  render();
}

ghostInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    bakeText();
    container.focus();
  } else if (e.key === "Escape") {
    ghostInput.style.display = "none";
    activeTextCoord = null;
    container.focus();
    render();
  }
});

ghostInput.addEventListener("input", () => {
  autoResizeGhostInput();
});

function autoResizeGhostInput() {
  ghostInput.style.height = "auto";
  ghostInput.style.height = ghostInput.scrollHeight + "px";
}

function applyZoom(newZoom, centerX, centerY) {
  if (newZoom < 0.05 || newZoom > 2.0) return;
  const oldZoom = transform.zoom;
  transform.x = centerX - (centerX - transform.x) * (newZoom / oldZoom);
  transform.y = centerY - (centerY - transform.y) * (newZoom / oldZoom);
  transform.zoom = newZoom;
  updateZoomSliderValue();
  render();
}

function updateZoomSliderValue() {
  const percent = Math.round(transform.zoom * 100);
  zoomSlider.value = percent;
  zoomValDisplay.textContent = `${percent}%`;
}

container.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();

    // Pinch-to-zoom on trackpad (or Ctrl+scroll on mouse)
    if (e.ctrlKey || e.metaKey) {
      const zoomFactor = 1 - e.deltaY * 0.01;
      const newZoom = transform.zoom * zoomFactor;
      applyZoom(newZoom, e.clientX, e.clientY);
    } else {
      // Two-finger pan on trackpad (or regular scroll wheel)
      transform.x -= e.deltaX;
      transform.y -= e.deltaY;
      updateZoomSliderValue();
      render();
    }
    scheduleSave();
  },
  { passive: false },
);

zoomSlider.addEventListener("input", (e) => {
  const targetZoom = parseFloat(e.target.value) / 100;
  applyZoom(targetZoom, window.innerWidth / 2, window.innerHeight / 2);
  scheduleSave();
});

zoomSlider.addEventListener("change", () => zoomSlider.blur());

centerCanvasBtn.addEventListener("click", () => {
  if (selectedElements.length > 0) {
    // Center view on selected element(s)
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    selectedElements.forEach((el) => {
      let b =
        el.elementType === "image"
          ? { x: el.x, y: el.y, w: el.w, h: el.h }
          : getShapeBounds(el);
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.x + b.w > maxX) maxX = b.x + b.w;
      if (b.y + b.h > maxY) maxY = b.y + b.h;
    });
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    transform.x = -centerX * transform.zoom + canvas.width / 2;
    transform.y = -centerY * transform.zoom + canvas.height / 2;
    render();
    showToast(
      "Centered view on selected item" +
        (selectedElements.length > 1 ? "s" : ""),
    );
  } else {
    transform.x = 0;
    transform.y = 0;
    render();
    showToast("Centered camera view to coordinate (0,0)");
  }
});

function translateElement(el, shiftX, shiftY) {
  if (el.elementType === "image") {
    el.x += shiftX;
    el.y += shiftY;
  } else if (el.type === "pen") {
    el.points.forEach((p) => {
      p.x += shiftX;
      p.y += shiftY;
    });
  } else {
    el.start.x += shiftX;
    el.start.y += shiftY;
    if (el.end) {
      el.end.x += shiftX;
      el.end.y += shiftY;
    }
  }
}

// --- ALIGNMENT PANEL COMPUTATION LOGIC ---

// Build alignment units: groups are treated as single atomic units,
// ungrouped elements are individual units.
function buildAlignmentUnits(elements) {
  const groupMap = new Map(); // groupId -> [elements]
  const ungrouped = [];

  elements.forEach((el) => {
    if (el.groupId) {
      if (!groupMap.has(el.groupId)) groupMap.set(el.groupId, []);
      groupMap.get(el.groupId).push(el);
    } else {
      ungrouped.push(el);
    }
  });

  const units = [];

  // Each group becomes one unit
  groupMap.forEach((groupEls, gid) => {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    groupEls.forEach((el) => {
      const b =
        el.elementType === "image"
          ? {
              x: el.x,
              y: el.y,
              w: el.w,
              h: el.h,
              maxX: el.x + el.w,
              maxY: el.y + el.h,
            }
          : getShapeBounds(el);
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if ((b.maxX || b.x + b.w) > maxX) maxX = b.maxX || b.x + b.w;
      if ((b.maxY || b.y + b.h) > maxY) maxY = b.maxY || b.y + b.h;
    });
    units.push({
      elements: groupEls,
      b: { x: minX, y: minY, w: maxX - minX, h: maxY - minY, maxX, maxY },
      isGroup: true,
      groupId: gid,
    });
  });

  // Each ungrouped element is its own unit
  ungrouped.forEach((el) => {
    const b =
      el.elementType === "image"
        ? {
            x: el.x,
            y: el.y,
            w: el.w,
            h: el.h,
            maxX: el.x + el.w,
            maxY: el.y + el.h,
          }
        : getShapeBounds(el);
    units.push({
      elements: [el],
      b,
      isGroup: false,
    });
  });

  return units;
}

function translateUnit(unit, shiftX, shiftY) {
  unit.elements.forEach((el) => translateElement(el, shiftX, shiftY));
}

const alignButtons = document.querySelectorAll(".align-btn");
alignButtons.forEach((btn) => {
  btn.addEventListener("click", (e) => {
    const targetBtn = e.target.closest(".align-btn");
    if (!targetBtn) return;
    const alignType = targetBtn.dataset.align;
    if (selectedElements.length < 2) return;
    pushUndo();

    // Build alignment units treating groups as atomic
    const units = buildAlignmentUnits(selectedElements);
    if (
      units.length < 2 &&
      !alignType.startsWith("spacing") &&
      alignType !== "gridLayout" &&
      alignType !== "rowLayout" &&
      alignType !== "columnLayout"
    ) {
      // If there's only one unit (e.g. all selected items are in the same group), fall back to per-element alignment
      // so alignment within a group still works
    }

    // Use units for alignment (groups move as one)
    let groupMinX = Infinity,
      groupMinY = Infinity;
    let groupMaxX = -Infinity,
      groupMaxY = -Infinity;

    units.forEach((unit) => {
      const b = unit.b;
      if (b.x < groupMinX) groupMinX = b.x;
      if (b.y < groupMinY) groupMinY = b.y;
      if (b.maxX > groupMaxX) groupMaxX = b.maxX;
      if (b.maxY > groupMaxY) groupMaxY = b.maxY;
    });

    const groupCenterX = (groupMinX + groupMaxX) / 2;
    const groupCenterY = (groupMinY + groupMaxY) / 2;

    if (alignType === "distributeX" || alignType === "distributeY") {
      if (units.length < 3) {
        showToast("Requires at least 3 units to distribute spacing");
        return;
      }
      if (alignType === "distributeX") {
        units.sort((a, b) => a.b.x + a.b.w / 2 - (b.b.x + b.b.w / 2));
        const totalWidth = units.reduce((sum, u) => sum + u.b.w, 0);
        const availableSpace = groupMaxX - groupMinX - totalWidth;
        const gap = availableSpace / (units.length - 1);
        let currentX = groupMinX;
        units.forEach((unit, index) => {
          if (index > 0 && index < units.length - 1) {
            translateUnit(unit, currentX - unit.b.x, 0);
          }
          currentX += unit.b.w + gap;
        });
      } else {
        units.sort((a, b) => a.b.y + a.b.h / 2 - (b.b.y + b.b.h / 2));
        const totalHeight = units.reduce((sum, u) => sum + u.b.h, 0);
        const availableSpace = groupMaxY - groupMinY - totalHeight;
        const gap = availableSpace / (units.length - 1);
        let currentY = groupMinY;
        units.forEach((unit, index) => {
          if (index > 0 && index < units.length - 1) {
            translateUnit(unit, 0, currentY - unit.b.y);
          }
          currentY += unit.b.h + gap;
        });
      }
    } else if (alignType.startsWith("spacing")) {
      const isX = alignType.includes("X");
      const isPlus = alignType.includes("Plus");
      const SPACING_STEP = 50;

      if (isX) {
        units.sort((a, b) => a.b.x - b.b.x);
        let totalGap = 0;
        for (let i = 1; i < units.length; i++) {
          totalGap += units[i].b.x - (units[i - 1].b.x + units[i - 1].b.w);
        }
        const avgGap = totalGap / (units.length - 1);
        const newGap = Math.max(
          0,
          avgGap + (isPlus ? SPACING_STEP : -SPACING_STEP),
        );

        let currentX = units[0].b.x;
        for (let i = 0; i < units.length; i++) {
          const shiftX = currentX - units[i].b.x;
          if (shiftX !== 0) translateUnit(units[i], shiftX, 0);
          currentX += units[i].b.w + newGap;
        }
      } else {
        units.sort((a, b) => a.b.y - b.b.y);
        let totalGap = 0;
        for (let i = 1; i < units.length; i++) {
          totalGap += units[i].b.y - (units[i - 1].b.y + units[i - 1].b.h);
        }
        const avgGap = totalGap / (units.length - 1);
        const newGap = Math.max(
          0,
          avgGap + (isPlus ? SPACING_STEP : -SPACING_STEP),
        );

        let currentY = units[0].b.y;
        for (let i = 0; i < units.length; i++) {
          const shiftY = currentY - units[i].b.y;
          if (shiftY !== 0) translateUnit(units[i], 0, shiftY);
          currentY += units[i].b.h + newGap;
        }
      }

      const direction = isPlus ? "increased" : "decreased";
      const axis = isX ? "horizontal" : "vertical";
      showToast(
        `${axis.charAt(0).toUpperCase() + axis.slice(1)} spacing ${direction}`,
      );
    } else if (alignType === "gridLayout") {
      applyGridLayout(units);
    } else if (alignType === "rowLayout") {
      applyRowLayout(units);
    } else if (alignType === "columnLayout") {
      applyColumnLayout(units);
    } else {
      units.forEach((unit) => {
        const b = unit.b;
        let shiftX = 0,
          shiftY = 0;
        if (alignType === "left") shiftX = groupMinX - b.x;
        else if (alignType === "centerX")
          shiftX = groupCenterX - (b.x + b.w / 2);
        else if (alignType === "right") shiftX = groupMaxX - b.maxX;
        else if (alignType === "top") shiftY = groupMinY - b.y;
        else if (alignType === "centerY")
          shiftY = groupCenterY - (b.y + b.h / 2);
        else if (alignType === "bottom") shiftY = groupMaxY - b.maxY;
        translateUnit(unit, shiftX, shiftY);
      });
    }
    render();
    updateSpacingInputs();
    showToast(`Executed selection ${alignType}`);
  });
});

function applyRowLayout(units) {
  const n = units.length;
  if (n < 2) return;

  const gap = 100;

  // Order by initial spatial position (left to right)
  units.sort((a, b) => a.b.x - b.b.x);

  // Use the leftmost unit's position as anchor
  const anchorX = units[0].b.x;
  const anchorY = units[0].b.y;

  // Place each unit sequentially without changing their relative order
  let currentX = anchorX;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const shiftX = currentX - unit.b.x;
    const shiftY = anchorY - unit.b.y;
    if (shiftX !== 0 || shiftY !== 0) {
      translateUnit(unit, shiftX, shiftY);
    }
    currentX += unit.b.w + gap;
  }

  showToast(`Row: ${n} items laid out horizontally`);
}

function applyColumnLayout(units) {
  const n = units.length;
  if (n < 2) return;

  const gap = 100;

  // Order by initial spatial position (top to bottom)
  units.sort((a, b) => a.b.y - b.b.y);

  // Use the topmost unit's position as anchor
  const anchorX = units[0].b.x;
  const anchorY = units[0].b.y;

  // Place each unit sequentially without changing their relative order
  let currentY = anchorY;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const shiftX = anchorX - unit.b.x;
    const shiftY = currentY - unit.b.y;
    if (shiftX !== 0 || shiftY !== 0) {
      translateUnit(unit, shiftX, shiftY);
    }
    currentY += unit.b.h + gap;
  }

  showToast(`Column: ${n} items laid out vertically`);
}

function applyGridLayout(units) {
  const n = units.length;
  if (n < 2) return;

  const gapX = 100;
  const gapY = 100;

  // Compute centroid of current selection to anchor the result
  let centroidX = 0,
    centroidY = 0;
  units.forEach((unit) => {
    centroidX += unit.b.x + unit.b.w / 2;
    centroidY += unit.b.y + unit.b.h / 2;
  });
  centroidX /= n;
  centroidY /= n;

  // MaxRects bin packing for smallest bounding area.
  // We try several container widths and pick the one yielding smallest area.
  function packWithMaxRects(items, containerW) {
    // Each item: {idx, w, h}
    // Returns {placements: [{idx, x, y}], usedW, usedH} or null if failed
    const freeRects = [{ x: 0, y: 0, w: containerW, h: Infinity }];
    const placements = [];
    let usedW = 0,
      usedH = 0;

    for (const item of items) {
      // Find the best free rect (Best Short Side Fit)
      let bestIdx = -1;
      let bestShortSide = Infinity;
      let bestLongSide = Infinity;

      for (let i = 0; i < freeRects.length; i++) {
        const r = freeRects[i];
        if (item.w <= r.w && item.h <= r.h) {
          const leftoverX = r.w - item.w;
          const leftoverY = r.h - item.h;
          const shortSide = Math.min(leftoverX, leftoverY);
          const longSide = Math.max(leftoverX, leftoverY);
          if (
            shortSide < bestShortSide ||
            (shortSide === bestShortSide && longSide < bestLongSide)
          ) {
            bestIdx = i;
            bestShortSide = shortSide;
            bestLongSide = longSide;
          }
        }
      }

      if (bestIdx === -1) return null; // doesn't fit

      const rect = freeRects[bestIdx];
      const px = rect.x;
      const py = rect.y;
      placements.push({ idx: item.idx, x: px, y: py });
      usedW = Math.max(usedW, px + item.w);
      usedH = Math.max(usedH, py + item.h);

      // Split the free rect around the placed item
      // Right remainder
      if (rect.w - item.w > 0) {
        freeRects.push({
          x: px + item.w,
          y: py,
          w: rect.w - item.w,
          h: item.h,
        });
      }
      // Bottom remainder
      if (rect.h - item.h > 0) {
        freeRects.push({
          x: px,
          y: py + item.h,
          w: rect.w,
          h: rect.h - item.h,
        });
      }
      // Remove the used rect
      freeRects.splice(bestIdx, 1);

      // Remove any free rects fully contained by others (dedup)
      // and clip overlapping rects against the placed item
      const placed = { x: px, y: py, w: item.w, h: item.h };
      for (let i = freeRects.length - 1; i >= 0; i--) {
        const fr = freeRects[i];
        // Check overlap with placed item
        if (
          fr.x < placed.x + placed.w &&
          fr.x + fr.w > placed.x &&
          fr.y < placed.y + placed.h &&
          fr.y + fr.h > placed.y
        ) {
          // Split this free rect to exclude the placed area
          const newRects = [];
          // Left part
          if (fr.x < placed.x) {
            newRects.push({ x: fr.x, y: fr.y, w: placed.x - fr.x, h: fr.h });
          }
          // Right part
          if (fr.x + fr.w > placed.x + placed.w) {
            newRects.push({
              x: placed.x + placed.w,
              y: fr.y,
              w: fr.x + fr.w - (placed.x + placed.w),
              h: fr.h,
            });
          }
          // Top part
          if (fr.y < placed.y) {
            newRects.push({ x: fr.x, y: fr.y, w: fr.w, h: placed.y - fr.y });
          }
          // Bottom part
          if (fr.y + fr.h > placed.y + placed.h) {
            newRects.push({
              x: fr.x,
              y: placed.y + placed.h,
              w: fr.w,
              h: fr.y + fr.h - (placed.y + placed.h),
            });
          }
          freeRects.splice(i, 1, ...newRects);
        }
      }

      // Prune contained rectangles
      for (let i = freeRects.length - 1; i >= 0; i--) {
        for (let j = freeRects.length - 1; j >= 0; j--) {
          if (i === j) continue;
          const a = freeRects[i],
            b = freeRects[j];
          if (
            a.x >= b.x &&
            a.y >= b.y &&
            a.x + a.w <= b.x + b.w &&
            a.y + a.h <= b.y + b.h
          ) {
            freeRects.splice(i, 1);
            break;
          }
        }
      }
    }

    return { placements, usedW, usedH };
  }

  // Prepare items with gap baked in (we add gap to dimensions, then offset at the end)
  const items = units.map((unit, idx) => ({
    idx,
    w: unit.b.w + gapX,
    h: unit.b.h + gapY,
    origW: unit.b.w,
    origH: unit.b.h,
  }));

  // Order by initial spatial position (reading order: top-to-bottom, left-to-right)
  const sortedItems = [...items].sort((a, b) => {
    const ay = units[a.idx].b.y;
    const by = units[b.idx].b.y;
    const ax = units[a.idx].b.x;
    const bx = units[b.idx].b.x;
    // Group by row (items within similar Y range), then by X
    const rowThreshold = Math.max(a.h, b.h) * 0.5;
    if (Math.abs(ay - by) < rowThreshold) return ax - bx;
    return ay - by;
  });

  // Try multiple container widths and pick the smallest resulting area
  const maxItemW = Math.max(...items.map((i) => i.w));
  const totalW = items.reduce((s, i) => s + i.w, 0);
  const totalArea = items.reduce((s, i) => s + i.w * i.h, 0);
  const sqrtArea = Math.sqrt(totalArea);

  // Candidate widths: from max single item width up to total width
  const candidates = new Set();
  candidates.add(maxItemW);
  candidates.add(totalW);
  candidates.add(sqrtArea * 0.8);
  candidates.add(sqrtArea);
  candidates.add(sqrtArea * 1.2);
  candidates.add(sqrtArea * 1.5);
  candidates.add(sqrtArea * 2.0);
  // Also add cumulative widths of sorted items as candidates
  let cumW = 0;
  for (const item of sortedItems) {
    cumW += item.w;
    if (cumW >= maxItemW) candidates.add(cumW);
  }

  let bestResult = null;
  let bestArea = Infinity;
  let bestAspectRatio = Infinity;

  for (const candidateW of candidates) {
    if (candidateW < maxItemW) continue;
    const result = packWithMaxRects(sortedItems, candidateW);
    if (result) {
      const area = result.usedW * result.usedH;
      const aspectRatio =
        Math.max(result.usedW, result.usedH) /
        Math.min(result.usedW, result.usedH);
      if (
        area < bestArea ||
        (area === bestArea && aspectRatio < bestAspectRatio)
      ) {
        bestArea = area;
        bestAspectRatio = aspectRatio;
        bestResult = result;
      }
    }
  }

  if (!bestResult) {
    // Fallback: just stack vertically
    let y = 0;
    const placements = [];
    for (const item of sortedItems) {
      placements.push({ idx: item.idx, x: 0, y });
      y += item.h;
    }
    bestResult = { placements, usedW: maxItemW, usedH: y };
  }

  // Center the layout on the centroid (subtract the gap padding from dimensions)
  const layoutW = bestResult.usedW - gapX;
  const layoutH = bestResult.usedH - gapY;
  const offsetX = centroidX - layoutW / 2;
  const offsetY = centroidY - layoutH / 2;

  // Apply positions
  for (const { idx, x, y } of bestResult.placements) {
    const unit = units[idx];
    const targetX = x + offsetX;
    const targetY = y + offsetY;
    const shiftX = targetX - unit.b.x;
    const shiftY = targetY - unit.b.y;
    if (shiftX !== 0 || shiftY !== 0) {
      translateUnit(unit, shiftX, shiftY);
    }
  }

  const cols = Math.round(bestResult.usedW / (totalW / n));
  showToast(
    `Mosaic: ${n} items packed (${Math.round(layoutW)}×${Math.round(layoutH)})`,
  );
}

function getCanvasContentBounds() {
  let minX = Infinity,
    minY = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity;
  function expandBounds(x, y) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  images.forEach((img) => {
    expandBounds(img.x, img.y);
    expandBounds(img.x + img.w, img.y + img.h);
  });
  drawings.forEach((shape) => {
    const b = getShapeBounds(shape);
    expandBounds(b.x, b.y);
    expandBounds(b.x + b.w, b.y + b.h);
  });
  const padding = 100;
  return {
    minX: minX - padding,
    minY: minY - padding,
    maxX: maxX + padding,
    maxY: maxY + padding,
  };
}

async function executePNGExport(scaleFactor = 1.0) {
  const exportingSelection = selectedElements.length > 0;

  if (!exportingSelection && images.length === 0 && drawings.length === 0) {
    showToast("Canvas is completely empty!");
    return;
  }

  let bounds;
  let exportImages, exportDrawings;

  if (exportingSelection) {
    // Export only selected elements
    let minX = Infinity,
      minY = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity;
    exportImages = [];
    exportDrawings = [];

    selectedElements.forEach((el) => {
      if (el.elementType === "image") {
        if (el.x < minX) minX = el.x;
        if (el.y < minY) minY = el.y;
        if (el.x + el.w > maxX) maxX = el.x + el.w;
        if (el.y + el.h > maxY) maxY = el.y + el.h;
        exportImages.push(el);
      } else {
        const b = getShapeBounds(el);
        if (b.x < minX) minX = b.x;
        if (b.y < minY) minY = b.y;
        if (b.x + b.w > maxX) maxX = b.x + b.w;
        if (b.y + b.h > maxY) maxY = b.y + b.h;
        exportDrawings.push(el);
      }
    });

    const padding = 50;
    bounds = {
      minX: minX - padding,
      minY: minY - padding,
      maxX: maxX + padding,
      maxY: maxY + padding,
    };
  } else {
    // Export entire canvas
    bounds = getCanvasContentBounds();
    exportImages = images;
    exportDrawings = drawings;
  }

  // Browsers enforce maximum canvas size limits. If the export dimensions
  // exceed these limits, toBlob() returns null ("Failed to compile image asset").
  // We cap to a safe maximum and scale down automatically if needed.
  const MAX_CANVAS_DIM = 16384;
  const MAX_CANVAS_AREA = 16384 * 16384; // ~268M pixels

  let exportW = (bounds.maxX - bounds.minX) * scaleFactor;
  let exportH = (bounds.maxY - bounds.minY) * scaleFactor;

  // Scale down if either dimension or total area exceeds browser limits
  let effectiveScale = scaleFactor;
  const dimScale = Math.min(MAX_CANVAS_DIM / exportW, MAX_CANVAS_DIM / exportH, 1);
  const areaScale = Math.min(Math.sqrt(MAX_CANVAS_AREA / (exportW * exportH)), 1);
  const downscale = Math.min(dimScale, areaScale);

  if (downscale < 1) {
    effectiveScale = scaleFactor * downscale;
    exportW = Math.floor((bounds.maxX - bounds.minX) * effectiveScale);
    exportH = Math.floor((bounds.maxY - bounds.minY) * effectiveScale);
    showToast(`Canvas too large — exporting at ${Math.round(effectiveScale * 100)}% scale`);
  }

  // --- Layer 1: Images (filtered) ---
  const imgLayer = document.createElement("canvas");
  imgLayer.width = exportW;
  imgLayer.height = exportH;
  const imgLayerCtx = imgLayer.getContext("2d");
  imgLayerCtx.save();
  imgLayerCtx.scale(effectiveScale, effectiveScale);
  imgLayerCtx.translate(-bounds.minX, -bounds.minY);
  exportImages.forEach((imgData) => {
    imgLayerCtx.save();
    imgLayerCtx.globalAlpha = imgData.opacity != null ? imgData.opacity : 1;
    if (imgData.crop) {
      const c = imgData.crop;
      const natW = imgData.img.naturalWidth || imgData.img.width;
      const natH = imgData.img.naturalHeight || imgData.img.height;
      const sx = c.x * natW;
      const sy = c.y * natH;
      const sw = c.w * natW;
      const sh = c.h * natH;
      imgLayerCtx.drawImage(imgData.img, sx, sy, sw, sh, imgData.x, imgData.y, imgData.w, imgData.h);
    } else {
      imgLayerCtx.drawImage(
        imgData.img,
        imgData.x,
        imgData.y,
        imgData.w,
        imgData.h,
      );
    }
    imgLayerCtx.restore();
  });
  imgLayerCtx.restore();

  // Apply pixel-accurate filter to the image layer only
  if (currentFilter !== "none") {
    const id = imgLayerCtx.getImageData(0, 0, exportW, exportH);
    applyFilterToImageData(id, currentFilter);
    imgLayerCtx.putImageData(id, 0, 0);
  }

  // --- Layer 2: Drawings (never filtered) ---
  const drawLayer = document.createElement("canvas");
  drawLayer.width = exportW;
  drawLayer.height = exportH;
  const drawLayerCtx = drawLayer.getContext("2d");
  drawLayerCtx.save();
  drawLayerCtx.scale(effectiveScale, effectiveScale);
  drawLayerCtx.translate(-bounds.minX, -bounds.minY);
  exportDrawings.forEach((shape) => drawShape(drawLayerCtx, shape, true));
  drawLayerCtx.restore();

  // --- Composite: background + filtered images + unfiltered drawings ---
  const finalCanvas = document.createElement("canvas");
  finalCanvas.width = exportW;
  finalCanvas.height = exportH;
  const finalCtx = finalCanvas.getContext("2d");
  finalCtx.fillStyle = bgColor;
  finalCtx.fillRect(0, 0, exportW, exportH);
  finalCtx.drawImage(imgLayer, 0, 0);
  finalCtx.drawImage(drawLayer, 0, 0);

  finalCanvas.toBlob(async (blob) => {
    if (!blob) {
      showToast("Failed to compile image asset");
      return;
    }
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      internalCopyPerformed = false;
      if (exportingSelection) {
        showToast(
          scaleFactor === 0.5
            ? `Selection (${selectedElements.length}) copied at 50%!`
            : `Selection (${selectedElements.length}) copied as PNG!`,
        );
      } else {
        showToast(
          scaleFactor === 0.5
            ? "50% scale PNG copied!"
            : "Full scale PNG copied!",
        );
      }
    } catch (err) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `canvas_export_${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast("Downloaded PNG File");
    }
  }, "image/png");
}

exportBtn.addEventListener("click", (e) => executePNGExport(e.shiftKey ? 0.5 : 1.0));

downloadImagesBtn.addEventListener("click", () => {
  if (images.length === 0) {
    showToast("No pasted images found to download!");
    return;
  }
  images.forEach((imgData, index) => {
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = imgData.img.naturalWidth || imgData.w;
    tempCanvas.height = imgData.img.naturalHeight || imgData.h;
    tempCanvas.getContext("2d").drawImage(imgData.img, 0, 0);
    // Apply pixel-accurate color filter before download
    if (currentFilter !== "none") {
      const tempCtx = tempCanvas.getContext("2d");
      const imgDataPixels = tempCtx.getImageData(
        0,
        0,
        tempCanvas.width,
        tempCanvas.height,
      );
      applyFilterToImageData(imgDataPixels, currentFilter);
      tempCtx.putImageData(imgDataPixels, 0, 0);
    }
    const a = document.createElement("a");
    a.href = tempCanvas.toDataURL("image/png");
    a.download = `pasted_asset_${index + 1}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });
  const filterLabel = currentFilter !== "none" ? ` (${currentFilter})` : "";
  showToast(`Downloading ${images.length} asset files${filterLabel}...`);
});

// --- RULERS & GUIDE LINES ---
const rulerTop = document.getElementById("ruler-top");
const rulerLeft = document.getElementById("ruler-left");
const rulerTopCtx = rulerTop.getContext("2d");
const rulerLeftCtx = rulerLeft.getContext("2d");
const rulerCorner = document.getElementById("ruler-corner");
const toggleRulersBtn = document.getElementById("toggle-rulers-btn");

const RULER_SIZE = 12; // px
let guides = []; // {axis: 'x'|'y', position: number (world coords)}
let guidesVisible = true; // toggle visibility of guide lines
let rulersVisible = false; // rulers hidden by default
let draggingGuide = null; // {guide, axis}
let draggingNewGuide = null; // {axis: 'x'|'y'} when pulling from ruler

function setRulersVisible(visible) {
  rulersVisible = visible;
  rulerTop.style.display = visible ? "" : "none";
  rulerLeft.style.display = visible ? "" : "none";
  rulerCorner.style.display = visible ? "" : "none";
  toggleRulersBtn.classList.toggle("active", visible);
  if (visible) {
    renderRulers();
    renderGuides();
  } else {
    // Hide guide lines when rulers are hidden
    document.querySelectorAll(".guide-line").forEach((el) => el.remove());
  }
}

toggleRulersBtn.addEventListener("click", () => {
  setRulersVisible(!rulersVisible);
});

// Corner button: click to toggle guide visibility, shift+click to clear all
rulerCorner.style.cursor = "pointer";
rulerCorner.title = "Click: toggle guides · Shift+Click: remove all";

rulerCorner.addEventListener("click", (e) => {
  e.stopPropagation();
  if (e.shiftKey) {
    guides = [];
    guidesVisible = true;
    renderGuides();
    showToast("All guides removed");
  } else {
    guidesVisible = !guidesVisible;
    renderGuides();
    showToast(guidesVisible ? "Guides visible" : "Guides hidden");
  }
});

function resizeRulers() {
  const topW = window.innerWidth - RULER_SIZE;
  const leftH = window.innerHeight - RULER_SIZE;
  rulerTop.width = topW;
  rulerTop.height = RULER_SIZE;
  rulerTop.style.width = topW + "px";
  rulerTop.style.height = RULER_SIZE + "px";
  rulerLeft.width = RULER_SIZE;
  rulerLeft.height = leftH;
  rulerLeft.style.width = RULER_SIZE + "px";
  rulerLeft.style.height = leftH + "px";
}

function isColorDark(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.5;
}

function getRulerBackground(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Darken or lighten the bg color slightly for contrast, with transparency
  if (isColorDark(hex)) {
    // Dark bg: make ruler slightly lighter
    return `rgba(${Math.min(255, r + 40)}, ${Math.min(255, g + 40)}, ${Math.min(255, b + 40)}, 0.92)`;
  } else {
    // Light bg: make ruler slightly darker
    return `rgba(${Math.max(0, r - 30)}, ${Math.max(0, g - 30)}, ${Math.max(0, b - 30)}, 0.92)`;
  }
}

function renderRulers() {
  // Derive ruler background from the canvas bgColor with transparency
  const rulerBg = getRulerBackground(bgColor);
  const isDark = isColorDark(bgColor);
  const tickColor = isDark ? "#666" : "#aaa";
  const textColor = isDark ? "#999" : "#555";

  // Update corner element background
  const cornerEl = document.getElementById("ruler-corner");
  cornerEl.style.background = rulerBg;

  // --- Top Ruler ---
  const topW = rulerTop.width;
  const topH = rulerTop.height;
  rulerTopCtx.clearRect(0, 0, topW, topH);
  rulerTopCtx.fillStyle = rulerBg;
  rulerTopCtx.fillRect(0, 0, topW, topH);

  // Calculate world-space tick spacing based on zoom
  const baseStep = getTickStep(transform.zoom);
  const startWorldX = (0 - RULER_SIZE - transform.x) / transform.zoom;
  const endWorldX = (topW - transform.x) / transform.zoom;
  const firstTick = Math.floor(startWorldX / baseStep) * baseStep;

  rulerTopCtx.fillStyle = textColor;
  rulerTopCtx.strokeStyle = tickColor;
  rulerTopCtx.lineWidth = 1;
  rulerTopCtx.font = "9px sans-serif";
  rulerTopCtx.textAlign = "center";
  rulerTopCtx.textBaseline = "top";

  for (let wx = firstTick; wx <= endWorldX; wx += baseStep) {
    const sx = wx * transform.zoom + transform.x - RULER_SIZE;
    const isMajor = Math.round(wx / baseStep) % 5 === 0;
    const tickH = isMajor ? topH * 0.6 : topH * 0.3;

    rulerTopCtx.beginPath();
    rulerTopCtx.moveTo(sx, topH);
    rulerTopCtx.lineTo(sx, topH - tickH);
    rulerTopCtx.stroke();

    if (isMajor) {
      rulerTopCtx.fillText(Math.round(wx).toString(), sx, 2);
    }
  }

  // --- Left Ruler ---
  const leftW = rulerLeft.width;
  const leftH = rulerLeft.height;
  rulerLeftCtx.clearRect(0, 0, leftW, leftH);
  rulerLeftCtx.fillStyle = rulerBg;
  rulerLeftCtx.fillRect(0, 0, leftW, leftH);

  const startWorldY = (0 - RULER_SIZE - transform.y) / transform.zoom;
  const endWorldY = (leftH - transform.y) / transform.zoom;
  const firstTickY = Math.floor(startWorldY / baseStep) * baseStep;

  rulerLeftCtx.fillStyle = textColor;
  rulerLeftCtx.strokeStyle = tickColor;
  rulerLeftCtx.lineWidth = 1;
  rulerLeftCtx.font = "9px sans-serif";
  rulerLeftCtx.textAlign = "center";
  rulerLeftCtx.textBaseline = "middle";

  for (let wy = firstTickY; wy <= endWorldY; wy += baseStep) {
    const sy = wy * transform.zoom + transform.y - RULER_SIZE;
    const isMajor = Math.round(wy / baseStep) % 5 === 0;
    const tickW = isMajor ? leftW * 0.6 : leftW * 0.3;

    rulerLeftCtx.beginPath();
    rulerLeftCtx.moveTo(leftW, sy);
    rulerLeftCtx.lineTo(leftW - tickW, sy);
    rulerLeftCtx.stroke();

    if (isMajor) {
      rulerLeftCtx.save();
      rulerLeftCtx.translate(8, sy);
      rulerLeftCtx.rotate(-Math.PI / 2);
      rulerLeftCtx.fillText(Math.round(wy).toString(), 0, 0);
      rulerLeftCtx.restore();
    }
  }
}

function getTickStep(zoom) {
  // Choose a sensible tick spacing based on zoom level
  const targetScreenPx = 20; // desired pixel gap between small ticks
  const worldPx = targetScreenPx / zoom;
  const magnitudes = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
  for (const m of magnitudes) {
    if (m >= worldPx) return m;
  }
  return 5000;
}

function getGuideSnapPositions(axis) {
  // Collect all edges and centers of canvas items for snapping guides to
  const positions = [];
  const prop = axis === "y" ? "y" : "x";
  const sizeProp = axis === "y" ? "h" : "w";

  images.forEach((img) => {
    const pos = img[prop];
    const size = img[sizeProp];
    positions.push(pos, pos + size, pos + size / 2);
  });

  drawings.forEach((shape) => {
    const b = getShapeBounds(shape);
    const pos = b[prop];
    const size = b[sizeProp];
    positions.push(pos, pos + size, pos + size / 2);
  });

  return positions;
}

// Track last click info for manual double-click detection on guides
let guideLastClickTime = 0;
let guideLastClickIdx = -1;

function renderGuides() {
  // Remove existing guide DOM elements
  document.querySelectorAll(".guide-line").forEach((el) => el.remove());

  // Update corner indicator
  rulerCorner.classList.toggle("guides-hidden", !guidesVisible);
  rulerCorner.classList.toggle("has-guides", guides.length > 0);

  if (!guidesVisible) return;

  guides.forEach((guide, idx) => {
    const div = document.createElement("div");
    div.className = `guide-line ${guide.axis === "x" ? "vertical" : "horizontal"}`;
    div.dataset.guideIdx = idx;

    if (guide.axis === "x") {
      const sx = guide.position * transform.zoom + transform.x;
      div.style.left = sx + "px";
    } else {
      const sy = guide.position * transform.zoom + transform.y;
      div.style.top = sy + "px";
    }

    // Allow dragging existing guides, with manual double-click detection
    div.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      e.preventDefault();

      const now = Date.now();
      if (now - guideLastClickTime < 400 && guideLastClickIdx === idx) {
        // Double-click detected — remove guide
        guideLastClickTime = 0;
        guideLastClickIdx = -1;
        guides.splice(idx, 1);
        renderGuides();
        return;
      }
      guideLastClickTime = now;
      guideLastClickIdx = idx;

      draggingGuide = { guide, startPos: guide.axis === "x" ? e.clientX : e.clientY };
      document.body.style.cursor = guide.axis === "x" ? "ew-resize" : "ns-resize";
    });

    document.body.appendChild(div);
  });
}

// Drag from top ruler to create horizontal guide
rulerTop.addEventListener("mousedown", (e) => {
  e.preventDefault();
  draggingNewGuide = { axis: "y", startScreen: e.clientY };
  document.body.style.cursor = "ns-resize";
});

// Drag from left ruler to create vertical guide
rulerLeft.addEventListener("mousedown", (e) => {
  e.preventDefault();
  draggingNewGuide = { axis: "x", startScreen: e.clientX };
  document.body.style.cursor = "ew-resize";
});

window.addEventListener("mousemove", (e) => {
  if (draggingNewGuide) {
    const axis = draggingNewGuide.axis;
    let pos = axis === "y" ? e.clientY : e.clientX;

    // Shift-snap to canvas item edges
    if (isShiftPressed) {
      const worldPos = axis === "y"
        ? (e.clientY - transform.y) / transform.zoom
        : (e.clientX - transform.x) / transform.zoom;
      const threshold = 8 / transform.zoom;
      const snapPositions = getGuideSnapPositions(axis);
      let bestDist = threshold;
      let snapped = worldPos;
      for (const sp of snapPositions) {
        const dist = Math.abs(worldPos - sp);
        if (dist < bestDist) {
          bestDist = dist;
          snapped = sp;
        }
      }
      if (axis === "y") {
        pos = snapped * transform.zoom + transform.y;
      } else {
        pos = snapped * transform.zoom + transform.x;
      }
    }

    // Show a temporary preview guide
    let previewEl = document.getElementById("guide-preview");
    if (!previewEl) {
      previewEl = document.createElement("div");
      previewEl.id = "guide-preview";
      previewEl.style.position = "fixed";
      previewEl.style.zIndex = "9";
      previewEl.style.pointerEvents = "none";
      if (axis === "y") {
        previewEl.style.left = RULER_SIZE + "px";
        previewEl.style.width = `calc(100% - ${RULER_SIZE}px)`;
        previewEl.style.height = "1px";
        previewEl.style.background = "rgba(0, 180, 255, 0.5)";
      } else {
        previewEl.style.top = RULER_SIZE + "px";
        previewEl.style.height = `calc(100% - ${RULER_SIZE}px)`;
        previewEl.style.width = "1px";
        previewEl.style.background = "rgba(0, 180, 255, 0.5)";
      }
      document.body.appendChild(previewEl);
    }
    if (axis === "y") {
      previewEl.style.top = pos + "px";
    } else {
      previewEl.style.left = pos + "px";
    }
    draggingNewGuide.snappedPos = pos;
    return;
  }

  if (draggingGuide) {
    const guide = draggingGuide.guide;
    if (guide.axis === "x") {
      const worldX = (e.clientX - transform.x) / transform.zoom;
      guide.position = worldX;
    } else {
      const worldY = (e.clientY - transform.y) / transform.zoom;
      guide.position = worldY;
    }
    renderGuides();
    return;
  }
});

window.addEventListener("mouseup", (e) => {
  // Complete swap drag operation
  if (isSwapDragging) {
    if (swapTargetElement && swapSourceElement && swapTargetElement.id !== swapSourceElement.id) {
      swapElementPositions(swapSourceElement, swapTargetElement);
    }
    isSwapDragging = false;
    swapSourceElement = null;
    swapDragWorldPos = null;
    swapTargetElement = null;
    swapHoveredElement = null;
    container.style.cursor = "default";
    render();
    return;
  }

  if (draggingNewGuide) {
    const axis = draggingNewGuide.axis;
    // Remove preview
    const previewEl = document.getElementById("guide-preview");
    if (previewEl) previewEl.remove();

    // Use snapped position if available, otherwise raw mouse position
    const screenPos = draggingNewGuide.snappedPos != null
      ? draggingNewGuide.snappedPos
      : (axis === "y" ? e.clientY : e.clientX);

    // Only add if dragged far enough away from ruler
    if (axis === "y" && screenPos > RULER_SIZE + 5) {
      const worldY = (screenPos - transform.y) / transform.zoom;
      guides.push({ axis: "y", position: worldY });
      renderGuides();
    } else if (axis === "x" && screenPos > RULER_SIZE + 5) {
      const worldX = (screenPos - transform.x) / transform.zoom;
      guides.push({ axis: "x", position: worldX });
      renderGuides();
    }

    draggingNewGuide = null;
    document.body.style.cursor = "";
    return;
  }

  if (draggingGuide) {
    const guide = draggingGuide.guide;
    // If dragged back onto the ruler, remove the guide
    if (guide.axis === "x" && e.clientX <= RULER_SIZE) {
      const idx = guides.indexOf(guide);
      if (idx !== -1) guides.splice(idx, 1);
    } else if (guide.axis === "y" && e.clientY <= RULER_SIZE) {
      const idx = guides.indexOf(guide);
      if (idx !== -1) guides.splice(idx, 1);
    }
    draggingGuide = null;
    document.body.style.cursor = "";
    renderGuides();
    return;
  }
});

// Hook rulers into the render cycle
const _originalRender = render;
let _rulerCallbackScheduled = false;
render = function (...args) {
  _originalRender(...args);
  // Only update rulers for live rendering (not exports)
  if (!args[1] && rulersVisible) {
    if (args[0] && args[0] !== ctx) {
      // Synchronous export path: render rulers immediately
      renderRulers();
      renderGuides();
    } else if (!_rulerCallbackScheduled) {
      // Interactive path: schedule ruler render after rAF (once per frame)
      _rulerCallbackScheduled = true;
      addRenderCallback(() => {
        _rulerCallbackScheduled = false;
        renderRulers();
        renderGuides();
      });
    }
  }
};

// Hook rulers into resize
const _originalResize = resize;
resize = function () {
  resizeRulers();
  _originalResize();
};

window.addEventListener("resize", resizeRulers);

resizeRulers();
setRulersVisible(false); // hidden by default
resize();
