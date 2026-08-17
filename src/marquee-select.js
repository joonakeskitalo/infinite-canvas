/**
 * Marquee (Rectangle Select) Tool
 *
 * Allows selecting a rectangular area on the canvas to capture any elements
 * (images, drawings, text, connectors, etc.). Supports move, cut, copy, and
 * duplicate operations.
 *
 * Behavior:
 * - For images: only the pixels within the selection rectangle are affected.
 *   Copy/cut extracts those pixels; move relocates them within or out of the image.
 * - For vector elements (drawings, text, etc.): the entire element is affected
 *   if its bounding box intersects the selection.
 * - Copying always rasterizes to PNG for the system clipboard.
 */

import { state, CONSTANTS, spatialInsert, spatialRemove, spatialUpdate } from "./state.js";
import { showToast } from "./utils.js";
import { pushUndo } from "./history.js";
import { scheduleSave } from "./persistence.js";
import { render, drawShape, getFilteredImage } from "./rendering.js";
import { getShapeBounds, cloneElement, translateElement } from "./elements.js";
import { serializeClipboardElements } from "./selection.js";

// Marching ants animation
let _marchingAntsRAF = null;

function startMarchingAnts() {
  if (_marchingAntsRAF) return;
  const animate = () => {
    if (!state.marqueeMode) { _marchingAntsRAF = null; return; }
    render();
    _marchingAntsRAF = requestAnimationFrame(animate);
  };
  _marchingAntsRAF = requestAnimationFrame(animate);
}

function stopMarchingAnts() {
  if (_marchingAntsRAF) {
    cancelAnimationFrame(_marchingAntsRAF);
    _marchingAntsRAF = null;
  }
}

/**
 * Check if two axis-aligned rectangles overlap.
 */
function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x &&
         a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Check if rectangle `inner` is fully contained within `outer`.
 */
function rectContains(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y &&
         inner.x + inner.w <= outer.x + outer.w &&
         inner.y + inner.h <= outer.y + outer.h;
}

/**
 * Find all elements whose bounding box intersects the given rectangle.
 * Returns separate arrays for vector elements and images.
 */
function getElementsInRect(rect) {
  const vectors = [];
  const images = [];
  // Check images
  for (const img of state.images) {
    const b = { x: img.x, y: img.y, w: img.w, h: img.h };
    if (rectsOverlap(rect, b)) images.push(img);
  }
  // Check drawings (vector elements)
  for (const shape of state.drawings) {
    const b = getShapeBounds(shape);
    if (rectsOverlap(rect, b)) vectors.push(shape);
  }
  return { vectors, images };
}

/**
 * Create an offscreen canvas helper.
 */
function createOffscreen(w, h) {
  let canvas, ctx;
  if (typeof OffscreenCanvas !== "undefined") {
    canvas = new OffscreenCanvas(w, h);
    ctx = canvas.getContext("2d");
  } else {
    canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    ctx = canvas.getContext("2d");
  }
  return { canvas, ctx };
}

/**
 * Convert a canvas (OffscreenCanvas or regular) to an Image element via blob/dataURL.
 * Calls callback(imgEl) when ready.
 */
function canvasToImage(canvas, callback) {
  if (canvas instanceof OffscreenCanvas) {
    canvas.convertToBlob({ type: "image/png" }).then((blob) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => callback(img);
      img.src = url;
    });
  } else {
    const dataURL = canvas.toDataURL("image/png");
    const img = new Image();
    img.onload = () => callback(img);
    img.src = dataURL;
  }
}

/**
 * Copy a canvas to the system clipboard as PNG. Best-effort, may fail silently.
 */
function copyCanvasToClipboard(canvas, successMsg) {
  if (canvas instanceof OffscreenCanvas) {
    canvas.convertToBlob({ type: "image/png" }).then((blob) => {
      navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]).then(() => {
        showToast(successMsg || "Copied to clipboard");
      }).catch(() => {
        showToast("Copied selection (internal)");
      });
    });
  } else {
    canvas.toBlob((blob) => {
      if (!blob) { showToast("Copied selection (internal)"); return; }
      navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]).then(() => {
        showToast(successMsg || "Copied to clipboard");
      }).catch(() => {
        showToast("Copied selection (internal)");
      });
    }, "image/png");
  }
}

/**
 * Begin drawing a marquee selection rectangle.
 * Works anywhere on the canvas.
 */
export function marqueeStartSelection(worldPos) {
  // If there's an existing marquee selection and we clicked inside it, start dragging
  if (state.marqueeMode && state.marqueeRect) {
    const r = state.marqueeRect;
    const ox = state.marqueeOffset.x;
    const oy = state.marqueeOffset.y;
    if (
      worldPos.x >= r.x + ox && worldPos.x <= r.x + r.w + ox &&
      worldPos.y >= r.y + oy && worldPos.y <= r.y + r.h + oy
    ) {
      // Start dragging the selected region
      state.marqueeIsDragging = true;
      state.marqueeDragStart = { x: worldPos.x, y: worldPos.y, ox: state.marqueeOffset.x, oy: state.marqueeOffset.y };
      return;
    }
    // Clicked outside the current marquee — commit current selection and start fresh
    marqueeCommit();
  }

  // Start a new selection anywhere on the canvas
  state.marqueeIsSelecting = true;
  state.marqueeStart = { x: worldPos.x, y: worldPos.y };
  state.marqueeTarget = null;
  state.marqueeRect = { x: worldPos.x, y: worldPos.y, w: 0, h: 0 };
  state.marqueeOffset = { x: 0, y: 0 };
  state.marqueePixelCanvas = null;
  state.marqueeIsDragging = false;
  state.marqueeCut = false;
  state.marqueeElements = [];
  state.marqueeIsElementMode = false;
}

/**
 * Update the marquee rectangle while dragging to define it.
 */
export function marqueeUpdateSelection(worldPos) {
  if (state.marqueeIsDragging && state.marqueeDragStart) {
    const dx = worldPos.x - state.marqueeDragStart.x;
    const dy = worldPos.y - state.marqueeDragStart.y;
    state.marqueeOffset = {
      x: state.marqueeDragStart.ox + dx,
      y: state.marqueeDragStart.oy + dy,
    };
    render();
    return;
  }

  if (!state.marqueeIsSelecting || !state.marqueeStart) return;

  const startX = state.marqueeStart.x;
  const startY = state.marqueeStart.y;
  const x = Math.min(startX, worldPos.x);
  const y = Math.min(startY, worldPos.y);
  const w = Math.abs(worldPos.x - startX);
  const h = Math.abs(worldPos.y - startY);

  state.marqueeRect = { x, y, w, h };
  render();
}

/**
 * Finalize drawing the marquee rectangle and determine what was selected.
 */
export function marqueeEndSelection() {
  if (state.marqueeIsDragging) {
    state.marqueeIsDragging = false;
    state.marqueeDragStart = null;
    return;
  }

  if (!state.marqueeIsSelecting) return;
  state.marqueeIsSelecting = false;

  const rect = state.marqueeRect;
  if (!rect || rect.w < 2 || rect.h < 2) {
    exitMarqueeMode();
    return;
  }

  // Find all elements intersecting the marquee rectangle
  const { vectors, images } = getElementsInRect(rect);

  if (vectors.length === 0 && images.length === 0) {
    exitMarqueeMode();
    return;
  }

  // Store selected elements (vectors + images that overlap)
  state.marqueeElements = [...vectors, ...images];
  state.marqueeIsElementMode = true;
  state.marqueeMode = true;

  // Rasterize the selection area (clipped to marquee bounds)
  rasterizeMarqueeSelection();

  startMarchingAnts();
  render();
}

/**
 * Rasterize the content within the marquee rectangle into an OffscreenCanvas.
 * Images are clipped to the selection bounds (only the overlapping pixels are captured).
 * Vector elements are rendered in full but the canvas itself clips to the rect.
 */
function rasterizeMarqueeSelection() {
  const rect = state.marqueeRect;
  if (!rect || rect.w <= 0 || rect.h <= 0) return;

  const elements = state.marqueeElements;
  if (!elements || elements.length === 0) return;

  // Pixel density: 1:1 with world units, capped for performance
  const maxDim = 4096;
  let scale = 1;
  if (rect.w > maxDim || rect.h > maxDim) {
    scale = maxDim / Math.max(rect.w, rect.h);
  }

  const canvasW = Math.ceil(rect.w * scale);
  const canvasH = Math.ceil(rect.h * scale);
  const { canvas: offscreen, ctx: offCtx } = createOffscreen(canvasW, canvasH);

  // Set up coordinate system: marquee rect origin → (0,0), clipped to canvas bounds
  offCtx.scale(scale, scale);
  offCtx.translate(-rect.x, -rect.y);

  // Clip to marquee rectangle (ensures nothing outside it is rendered)
  offCtx.beginPath();
  offCtx.rect(rect.x, rect.y, rect.w, rect.h);
  offCtx.clip();

  // Render elements in z-order
  const orderedElements = [];
  for (const id of state.elementOrder) {
    const el = elements.find(e => e.id === id);
    if (el) orderedElements.push(el);
  }

  for (const el of orderedElements) {
    if (el.elementType === "image") {
      offCtx.save();
      offCtx.globalAlpha = el.opacity != null ? el.opacity : 1;
      const drawSrc = state.currentFilter !== "none" ? getFilteredImage(el) : el.img;
      if (el.crop) {
        const natW = el.img.naturalWidth || el.img.width;
        const natH = el.img.naturalHeight || el.img.height;
        const c = el.crop;
        offCtx.drawImage(drawSrc, c.x * natW, c.y * natH, c.w * natW, c.h * natH, el.x, el.y, el.w, el.h);
      } else {
        offCtx.drawImage(drawSrc, el.x, el.y, el.w, el.h);
      }
      offCtx.restore();
    } else {
      drawShape(offCtx, el, true);
    }
  }

  state.marqueePixelCanvas = offscreen;
}

/**
 * Copy the marquee selection to the internal clipboard for paste.
 * Images are cropped to the selection rect, vector elements are stored as clones.
 * Writes serialized element data to the system clipboard for cross-tab paste support.
 */
export function marqueeCopy() {
  if (!state.marqueeMode || !state.marqueeRect) return;

  const rect = state.marqueeRect;
  const ox = state.marqueeOffset.x;
  const oy = state.marqueeOffset.y;

  if (state.marqueeIsElementMode && state.marqueeElements.length > 0) {
    // Build internal clipboard with properly cropped/clipped elements
    const clones = [];

    for (const el of state.marqueeElements) {
      if (el.elementType === "image") {
        // Crop the image to the intersection of its bounds and the marquee rect
        const imgClone = cropImageToRect(el, rect);
        if (imgClone) {
          imgClone.id = "img_" + state.elementIdCounter++;
          translateElement(imgClone, ox, oy);
          clones.push(imgClone);
        }
      } else {
        // Vector elements: clone the whole element
        const c = cloneElement(el);
        c.id = "draw_" + state.elementIdCounter++;
        translateElement(c, ox, oy);
        clones.push(c);
      }
    }

    state.clipboardElements = clones;
    state.pasteOffset = 0;
    state.internalCopyPerformed = true;

    // Serialize elements for cross-tab clipboard transfer (same as copySelectionToClipboard)
    const serialized = serializeClipboardElements(clones);
    const clipboardPayload = CONSTANTS.INTERNAL_COPY_MIME + "\n" + JSON.stringify(serialized);

    navigator.clipboard.writeText(clipboardPayload).then(() => {
      showToast(`Copied ${clones.length} element(s)`);
    }).catch(() => {
      showToast(`Copied ${clones.length} element(s) (internal)`);
    });
  }
}

/**
 * Crop an image element to the intersection with the marquee rect.
 * Returns a new image element with only the pixels within the rect,
 * positioned at the intersection's world coordinates.
 */
function cropImageToRect(imgEl, rect) {
  // Compute intersection of image bounds and marquee rect
  const ix = Math.max(imgEl.x, rect.x);
  const iy = Math.max(imgEl.y, rect.y);
  const ix2 = Math.min(imgEl.x + imgEl.w, rect.x + rect.w);
  const iy2 = Math.min(imgEl.y + imgEl.h, rect.y + rect.h);

  const iw = ix2 - ix;
  const ih = iy2 - iy;
  if (iw <= 0 || ih <= 0) return null;

  // Use filtered image source when a color filter is active
  const srcImg = (state.currentFilter && state.currentFilter !== "none")
    ? getFilteredImage(imgEl)
    : imgEl.img;
  const natW = srcImg.naturalWidth || srcImg.width;
  const natH = srcImg.naturalHeight || srcImg.height;

  // Map world intersection to source pixel coordinates
  const scaleX = natW / imgEl.w;
  const scaleY = natH / imgEl.h;

  let sx = (ix - imgEl.x) * scaleX;
  let sy = (iy - imgEl.y) * scaleY;
  let sw = iw * scaleX;
  let sh = ih * scaleY;

  // Handle crop offset
  if (imgEl.crop) {
    sx += imgEl.crop.x * natW;
    sy += imgEl.crop.y * natH;
  }

  sx = Math.max(0, Math.round(sx));
  sy = Math.max(0, Math.round(sy));
  sw = Math.round(Math.min(sw, natW - sx));
  sh = Math.round(Math.min(sh, natH - sy));

  if (sw <= 0 || sh <= 0) return null;

  // Extract the cropped pixels
  const { canvas: cropped, ctx: cropCtx } = createOffscreen(sw, sh);
  cropCtx.drawImage(srcImg, sx, sy, sw, sh, 0, 0, sw, sh);

  // Create image element for the cropped region
  // We'll need to convert to an Image synchronously for the clone.
  // Store the canvas as the img source — it works for drawImage.
  return {
    id: imgEl.id,
    elementType: "image",
    img: cropped, // OffscreenCanvas works with drawImage
    x: ix,
    y: iy,
    w: iw,
    h: ih,
    opacity: imgEl.opacity != null ? imgEl.opacity : 1,
  };
}

/**
 * Export the marquee selection as PNG — either to the clipboard or as a downloaded file.
 * Behaves like the regular selection export: bounds are computed from the captured elements
 * (not the marquee rectangle itself), with padding, and rendered with the canvas background.
 *
 * @param {number} scaleFactor - Export scale (1.0 = full, 0.5 = half).
 * @param {{download?: boolean}} options - If download is true, triggers a file download instead of clipboard copy.
 */
export function marqueeExportPNG(scaleFactor = 1.0, { download = false } = {}) {
  if (!state.marqueeMode || !state.marqueeRect) {
    showToast("No marquee selection active");
    return;
  }

  const elements = state.marqueeElements;
  if (!elements || elements.length === 0) {
    showToast("No elements in marquee selection");
    return;
  }

  // Compute bounds from the visible portion of elements (clipped to the marquee rect)
  const marqueeRect = state.marqueeRect;
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
    const clippedMinX = Math.max(elMinX, marqueeRect.x);
    const clippedMinY = Math.max(elMinY, marqueeRect.y);
    const clippedMaxX = Math.min(elMaxX, marqueeRect.x + marqueeRect.w);
    const clippedMaxY = Math.min(elMaxY, marqueeRect.y + marqueeRect.h);
    if (clippedMinX >= clippedMaxX || clippedMinY >= clippedMaxY) continue;
    if (clippedMinX < minX) minX = clippedMinX;
    if (clippedMinY < minY) minY = clippedMinY;
    if (clippedMaxX > maxX) maxX = clippedMaxX;
    if (clippedMaxY > maxY) maxY = clippedMaxY;
  }

  const padding = 50;
  const bounds = { minX: minX - padding, minY: minY - padding, maxX: maxX + padding, maxY: maxY + padding };

  // Compute export dimensions with scale limits
  const MAX_CANVAS_DIM = 16384;
  const MAX_CANVAS_AREA = 16384 * 16384;

  let exportW = (bounds.maxX - bounds.minX) * scaleFactor;
  let exportH = (bounds.maxY - bounds.minY) * scaleFactor;

  let effectiveScale = scaleFactor;
  const dimScale = Math.min(MAX_CANVAS_DIM / exportW, MAX_CANVAS_DIM / exportH, 1);
  const areaScale = Math.min(Math.sqrt(MAX_CANVAS_AREA / (exportW * exportH)), 1);
  const downscale = Math.min(dimScale, areaScale);

  if (downscale < 1) {
    effectiveScale = scaleFactor * downscale;
    exportW = Math.floor((bounds.maxX - bounds.minX) * effectiveScale);
    exportH = Math.floor((bounds.maxY - bounds.minY) * effectiveScale);
    showToast(`Selection too large — exporting at ${Math.round(effectiveScale * 100)}% scale`);
  }

  // Render elements in z-order onto export canvas
  const canvasW = Math.ceil(exportW);
  const canvasH = Math.ceil(exportH);
  const { canvas: exportCanvas, ctx: exportCtx } = createOffscreen(canvasW, canvasH);

  // Fill background
  exportCtx.fillStyle = state.bgColor;
  exportCtx.fillRect(0, 0, canvasW, canvasH);

  // Set up world coordinate system
  exportCtx.save();
  exportCtx.scale(effectiveScale, effectiveScale);
  exportCtx.translate(-bounds.minX, -bounds.minY);

  // Clip rendering to the marquee rectangle so elements are cropped to the selection area
  const rect = state.marqueeRect;
  exportCtx.beginPath();
  exportCtx.rect(rect.x, rect.y, rect.w, rect.h);
  exportCtx.clip();

  // Get elements in z-order
  const orderedElements = [];
  for (const id of state.elementOrder) {
    const el = elements.find(e => e.id === id);
    if (el) orderedElements.push(el);
  }

  for (const el of orderedElements) {
    if (el.elementType === "image") {
      exportCtx.save();
      exportCtx.globalAlpha = el.opacity != null ? el.opacity : 1;
      const drawSrc = state.currentFilter !== "none" ? getFilteredImage(el) : el.img;
      if (el.crop) {
        const natW = el.img.naturalWidth || el.img.width;
        const natH = el.img.naturalHeight || el.img.height;
        const c = el.crop;
        exportCtx.drawImage(drawSrc, c.x * natW, c.y * natH, c.w * natW, c.h * natH, el.x, el.y, el.w, el.h);
      } else {
        exportCtx.drawImage(drawSrc, el.x, el.y, el.w, el.h);
      }
      exportCtx.restore();
    } else {
      drawShape(exportCtx, el, true);
    }
  }

  exportCtx.restore();

  const scaleLabel = scaleFactor === 0.5 ? " at 50%" : "";
  const count = elements.length;

  if (download) {
    // Download as file
    const doDownload = (blob) => {
      if (!blob) { showToast("Failed to export marquee selection"); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const now = new Date();
      const dtPrefix = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
      a.href = url;
      a.download = `${dtPrefix}_marquee_export.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast(`Marquee selection (${count} elements) downloaded${scaleLabel}!`);
    };

    if (exportCanvas instanceof OffscreenCanvas) {
      exportCanvas.convertToBlob({ type: "image/png" }).then(doDownload);
    } else {
      exportCanvas.toBlob(doDownload, "image/png");
    }
  } else {
    // Copy to clipboard
    copyCanvasToClipboard(exportCanvas, `Marquee selection (${count} elements) copied${scaleLabel}!`);
  }
}

/**
 * Cut the selected area from the canvas and copy to clipboard.
 * - For images: clears only the pixels within the selection rect (replaces with transparency).
 * - For vector elements: removes them entirely from the canvas.
 */
export function marqueeCut() {
  if (!state.marqueeMode || !state.marqueeRect) return;
  if (state.marqueeCut) return; // Already cut

  // Copy first
  marqueeCopy();

  pushUndo();

  const rect = state.marqueeRect;

  if (state.marqueeIsElementMode && state.marqueeElements.length > 0) {
    const vectorsToCut = [];
    const imagesToCrop = [];

    for (const el of state.marqueeElements) {
      if (el.elementType === "image") {
        imagesToCrop.push(el);
      } else {
        vectorsToCut.push(el);
      }
    }

    // Remove vector elements entirely
    if (vectorsToCut.length > 0) {
      const idsToRemove = new Set(vectorsToCut.map(el => el.id));
      state.drawings = state.drawings.filter(d => !idsToRemove.has(d.id));
      for (const el of vectorsToCut) {
        spatialRemove(el);
      }
    }

    // For images: clear only the pixels within the marquee rect
    for (const img of imagesToCrop) {
      clearImageRect(img, rect);
    }

    state.marqueeCut = true;
    render();
    scheduleSave();

    const total = vectorsToCut.length + imagesToCrop.length;
    showToast(`Cut ${total} element(s)`);
  }
}

/**
 * Clear the pixels within a world-space rectangle from an image element.
 * Replaces the affected area with transparency.
 */
function clearImageRect(imgEl, rect) {
  const srcImg = imgEl.img;
  const natW = srcImg.naturalWidth || srcImg.width;
  const natH = srcImg.naturalHeight || srcImg.height;

  // Compute intersection
  const ix = Math.max(imgEl.x, rect.x);
  const iy = Math.max(imgEl.y, rect.y);
  const ix2 = Math.min(imgEl.x + imgEl.w, rect.x + rect.w);
  const iy2 = Math.min(imgEl.y + imgEl.h, rect.y + rect.h);
  const iw = ix2 - ix;
  const ih = iy2 - iy;
  if (iw <= 0 || ih <= 0) return;

  const scaleX = natW / imgEl.w;
  const scaleY = natH / imgEl.h;

  let sx = (ix - imgEl.x) * scaleX;
  let sy = (iy - imgEl.y) * scaleY;
  let sw = iw * scaleX;
  let sh = ih * scaleY;

  if (imgEl.crop) {
    sx += imgEl.crop.x * natW;
    sy += imgEl.crop.y * natH;
  }

  sx = Math.max(0, Math.round(sx));
  sy = Math.max(0, Math.round(sy));
  sw = Math.round(Math.min(sw, natW - sx));
  sh = Math.round(Math.min(sh, natH - sy));

  if (sw <= 0 || sh <= 0) return;

  // Redraw the full image with the intersection cleared
  const { canvas: fullCanvas, ctx: fullCtx } = createOffscreen(natW, natH);
  fullCtx.drawImage(srcImg, 0, 0);
  fullCtx.clearRect(sx, sy, sw, sh);

  // Use canvas directly to avoid flicker, then convert for persistence
  imgEl.img = fullCanvas;
  render();

  canvasToImage(fullCanvas, (newImg) => {
    imgEl.img = newImg;
    scheduleSave();
  });
}

/**
 * Duplicate the selected area as new elements placed with a small offset.
 */
export function marqueeDuplicate() {
  if (!state.marqueeMode || !state.marqueeRect) return;

  const rect = state.marqueeRect;
  const offset = 30;
  pushUndo();

  if (state.marqueeIsElementMode && state.marqueeElements.length > 0) {
    const ox = state.marqueeOffset.x;
    const oy = state.marqueeOffset.y;
    const newElements = [];
    let pendingImages = 0;
    let allDone = false;

    const finalize = () => {
      if (!allDone || pendingImages > 0) return;
      exitMarqueeMode();
      state.selectedElements = newElements;
      state.currentTool = "select";
      render();
      scheduleSave();
      showToast(`Duplicated ${newElements.length} element(s)`);
    };

    for (const el of state.marqueeElements) {
      if (el.elementType === "image") {
        // Duplicate only the cropped portion within the marquee
        const cropped = cropImageToRect(el, rect);
        if (cropped) {
          pendingImages++;
          const croppedCanvas = cropped.img; // This is an OffscreenCanvas
          canvasToImage(croppedCanvas, (imgEl) => {
            const newElement = {
              id: "img_" + state.elementIdCounter++,
              elementType: "image",
              img: imgEl,
              x: cropped.x + ox + offset,
              y: cropped.y + oy + offset,
              w: cropped.w,
              h: cropped.h,
              opacity: cropped.opacity,
            };
            state.images.push(newElement);
            spatialInsert(newElement);
            newElements.push(newElement);
            pendingImages--;
            finalize();
          });
        }
      } else {
        // Vector: clone the whole element
        const c = cloneElement(el);
        c.id = "draw_" + state.elementIdCounter++;
        translateElement(c, ox + offset, oy + offset);
        state.drawings.push(c);
        spatialInsert(c);
        newElements.push(c);
      }
    }

    allDone = true;
    finalize(); // In case there are no pending images
    return;
  }

  // Fallback: pixel canvas only
  if (state.marqueePixelCanvas) {
    const pixelCanvas = state.marqueePixelCanvas;
    const ox = state.marqueeOffset.x;
    const oy = state.marqueeOffset.y;

    canvasToImage(pixelCanvas, (imgEl) => {
      const newElement = {
        id: "img_" + state.elementIdCounter++,
        elementType: "image",
        img: imgEl,
        x: rect.x + ox + offset,
        y: rect.y + oy + offset,
        w: rect.w,
        h: rect.h,
        opacity: 1,
      };
      state.images.push(newElement);
      spatialInsert(newElement);
      exitMarqueeMode();
      state.selectedElements = [newElement];
      state.currentTool = "select";
      render();
      scheduleSave();
      showToast("Duplicated selection");
    });
  }
}

/**
 * Commit the marquee selection.
 * - If moved: vector elements are translated; image pixels are cut from source and placed at new position.
 * - If not moved: just deselect.
 */
export function marqueeCommit() {
  if (!state.marqueeMode) return;

  const hasOffset = state.marqueeOffset.x !== 0 || state.marqueeOffset.y !== 0;

  if (hasOffset && state.marqueeIsElementMode && state.marqueeElements.length > 0 && !state.marqueeCut) {
    pushUndo();
    const dx = state.marqueeOffset.x;
    const dy = state.marqueeOffset.y;
    const rect = state.marqueeRect;

    for (const el of state.marqueeElements) {
      if (el.elementType === "image") {
        // For images: cut the pixels from the selection area and place at new position
        moveImagePixels(el, rect, dx, dy);
      } else {
        // Vector elements: just translate
        translateElement(el, dx, dy);
        spatialUpdate(el);
      }
    }
    scheduleSave();
  }

  exitMarqueeMode();
}

/**
 * Move pixels within the marquee rect of an image to a new position (offset by dx, dy).
 * 
 * If the destination overlaps/touches the original image bounds, the image is expanded
 * to fit both the original content and the moved pixels.
 * If the destination is fully detached from the image, the moved pixels become a new
 * rasterized image element.
 */
function moveImagePixels(imgEl, rect, dx, dy) {
  const srcImg = imgEl.img;
  const natW = srcImg.naturalWidth || srcImg.width;
  const natH = srcImg.naturalHeight || srcImg.height;

  // Compute intersection of image and marquee rect (source area in world coords)
  const ix = Math.max(imgEl.x, rect.x);
  const iy = Math.max(imgEl.y, rect.y);
  const ix2 = Math.min(imgEl.x + imgEl.w, rect.x + rect.w);
  const iy2 = Math.min(imgEl.y + imgEl.h, rect.y + rect.h);
  const iw = ix2 - ix;
  const ih = iy2 - iy;
  if (iw <= 0 || ih <= 0) return;

  // Destination rect in world coords
  const destWorldX = ix + dx;
  const destWorldY = iy + dy;
  const destRect = { x: destWorldX, y: destWorldY, w: iw, h: ih };
  const imgRect = { x: imgEl.x, y: imgEl.y, w: imgEl.w, h: imgEl.h };

  // Source pixels in image pixel space
  const scaleX = natW / imgEl.w;
  const scaleY = natH / imgEl.h;

  let sx = (ix - imgEl.x) * scaleX;
  let sy = (iy - imgEl.y) * scaleY;
  let sw = iw * scaleX;
  let sh = ih * scaleY;

  if (imgEl.crop) {
    sx += imgEl.crop.x * natW;
    sy += imgEl.crop.y * natH;
  }

  sx = Math.max(0, Math.round(sx));
  sy = Math.max(0, Math.round(sy));
  sw = Math.round(Math.min(sw, natW - sx));
  sh = Math.round(Math.min(sh, natH - sy));
  if (sw <= 0 || sh <= 0) return;

  // Extract the selected pixels
  const { canvas: pixelBuf, ctx: pixelCtx } = createOffscreen(sw, sh);
  pixelCtx.drawImage(srcImg, sx, sy, sw, sh, 0, 0, sw, sh);

  // Check if destination touches the original image bounding box
  const touches = destRect.x < imgRect.x + imgRect.w &&
                  destRect.x + destRect.w > imgRect.x &&
                  destRect.y < imgRect.y + imgRect.h &&
                  destRect.y + destRect.h > imgRect.y;

  if (touches) {
    // Expand the image to fit both original bounds and the destination
    const newWorldX = Math.min(imgEl.x, destWorldX);
    const newWorldY = Math.min(imgEl.y, destWorldY);
    const newWorldX2 = Math.max(imgEl.x + imgEl.w, destWorldX + iw);
    const newWorldY2 = Math.max(imgEl.y + imgEl.h, destWorldY + ih);
    const newWorldW = newWorldX2 - newWorldX;
    const newWorldH = newWorldY2 - newWorldY;

    // New pixel dimensions (use original scale factor for consistency)
    const newPixW = Math.round(newWorldW * scaleX);
    const newPixH = Math.round(newWorldH * scaleY);

    const { canvas: fullCanvas, ctx: fullCtx } = createOffscreen(newPixW, newPixH);

    // Draw original image at its offset within the new canvas
    const origOffX = Math.round((imgEl.x - newWorldX) * scaleX);
    const origOffY = Math.round((imgEl.y - newWorldY) * scaleY);
    fullCtx.drawImage(srcImg, 0, 0, natW, natH, origOffX, origOffY, natW, natH);

    // Clear the source area (in the new coordinate system)
    const clearX = Math.round((ix - newWorldX) * scaleX);
    const clearY = Math.round((iy - newWorldY) * scaleY);
    fullCtx.clearRect(clearX, clearY, sw, sh);

    // Draw moved pixels at destination (in the new coordinate system)
    const destPixX = Math.round((destWorldX - newWorldX) * scaleX);
    const destPixY = Math.round((destWorldY - newWorldY) * scaleY);
    fullCtx.drawImage(pixelBuf, 0, 0, sw, sh, destPixX, destPixY, sw, sh);

    // Use the offscreen canvas directly as the image source to avoid flicker.
    // OffscreenCanvas is accepted by drawImage, so rendering works immediately.
    imgEl.img = fullCanvas;
    imgEl.x = newWorldX;
    imgEl.y = newWorldY;
    imgEl.w = newWorldW;
    imgEl.h = newWorldH;
    // Clear crop since we've baked everything into a new canvas
    if (imgEl.crop) delete imgEl.crop;
    if (imgEl.fullBounds) delete imgEl.fullBounds;
    spatialUpdate(imgEl);
    render();

    // Convert to a proper Image in the background for persistence/serialization
    canvasToImage(fullCanvas, (newImg) => {
      imgEl.img = newImg;
      scheduleSave();
    });
  } else {
    // Destination is fully detached — clear source and create a new element

    // Clear source pixels from original image — use canvas directly to avoid flicker
    const { canvas: clearedCanvas, ctx: clearedCtx } = createOffscreen(natW, natH);
    clearedCtx.drawImage(srcImg, 0, 0);
    clearedCtx.clearRect(sx, sy, sw, sh);

    imgEl.img = clearedCanvas;
    render();

    // Convert to proper Image for persistence
    canvasToImage(clearedCanvas, (newImg) => {
      imgEl.img = newImg;
      scheduleSave();
    });

    // Create a new image element from the extracted pixels at destination
    canvasToImage(pixelBuf, (movedImg) => {
      const newElement = {
        id: "img_" + state.elementIdCounter++,
        elementType: "image",
        img: movedImg,
        x: destWorldX,
        y: destWorldY,
        w: iw,
        h: ih,
        opacity: imgEl.opacity != null ? imgEl.opacity : 1,
      };
      state.images.push(newElement);
      spatialInsert(newElement);
      render();
      scheduleSave();
    });
  }
}

/**
 * Exit marquee mode and reset all marquee state.
 */
export function exitMarqueeMode() {
  stopMarchingAnts();
  state.marqueeMode = false;
  state.marqueeTarget = null;
  state.marqueeRect = null;
  state.marqueePixelCanvas = null;
  state.marqueeOffset = { x: 0, y: 0 };
  state.marqueeIsDragging = false;
  state.marqueeDragStart = null;
  state.marqueeIsSelecting = false;
  state.marqueeStart = null;
  state.marqueeCut = false;
  state.marqueeElements = [];
  state.marqueeIsElementMode = false;
  render();
}

/**
 * Check if a world position is inside the current marquee selection (with offset).
 */
export function isPointInMarquee(worldPos) {
  if (!state.marqueeMode || !state.marqueeRect) return false;
  const r = state.marqueeRect;
  const ox = state.marqueeOffset.x;
  const oy = state.marqueeOffset.y;
  return (
    worldPos.x >= r.x + ox && worldPos.x <= r.x + r.w + ox &&
    worldPos.y >= r.y + oy && worldPos.y <= r.y + r.h + oy
  );
}

/**
 * Render the marquee selection overlay on the canvas.
 * Called from the main render loop.
 */
export function renderMarquee(ctx, transform) {
  const rect = state.marqueeRect;
  if (!rect || (rect.w < 1 && rect.h < 1)) return;

  const zoom = transform.zoom;
  const ox = state.marqueeOffset.x;
  const oy = state.marqueeOffset.y;

  ctx.save();

  // If cut and moved, draw the cleared area indicator
  if (state.marqueeCut && (ox !== 0 || oy !== 0)) {
    ctx.fillStyle = "rgba(128, 128, 128, 0.3)";
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  }

  // Show preview of what's being moved
  if ((ox !== 0 || oy !== 0) && state.marqueePixelCanvas) {
    ctx.save();
    ctx.globalAlpha = state.marqueeCut ? 0.9 : 0.6;
    ctx.drawImage(state.marqueePixelCanvas, rect.x + ox, rect.y + oy, rect.w, rect.h);
    ctx.restore();
  }

  // Draw marching ants border around the selection
  const drawX = rect.x + ox;
  const drawY = rect.y + oy;
  const drawW = rect.w;
  const drawH = rect.h;

  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5 / zoom;
  ctx.setLineDash([]);
  ctx.strokeRect(drawX, drawY, drawW, drawH);

  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1.5 / zoom;
  const dashLen = 6 / zoom;
  const offset = (Date.now() / 80) % (dashLen * 2);
  ctx.setLineDash([dashLen, dashLen]);
  ctx.lineDashOffset = -offset;
  ctx.strokeRect(drawX, drawY, drawW, drawH);

  ctx.setLineDash([]);
  ctx.restore();
}

/**
 * Render just the selection rectangle while dragging to define it (before selection is finalized).
 */
export function renderMarqueeSelecting(ctx, transform) {
  if (!state.marqueeIsSelecting || !state.marqueeRect) return;

  const rect = state.marqueeRect;
  if (rect.w < 1 && rect.h < 1) return;

  const zoom = transform.zoom;

  ctx.save();

  // Semi-transparent fill
  ctx.fillStyle = "rgba(0, 120, 215, 0.1)";
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

  // Dashed border
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5 / zoom;
  ctx.setLineDash([]);
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);

  ctx.strokeStyle = "#0078d7";
  ctx.lineWidth = 1.5 / zoom;
  const dashLen = 6 / zoom;
  ctx.setLineDash([dashLen, dashLen]);
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);

  ctx.setLineDash([]);
  ctx.restore();
}
