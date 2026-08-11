/**
 * Marquee (Rectangle Pixel Select) Tool
 *
 * Allows selecting a rectangular area from an image element,
 * then moving, cutting, or copying the selected pixels.
 */

import { state, getDom } from "./state.js";
import { screenToWorld, showToast } from "./utils.js";
import { pushUndo } from "./history.js";
import { scheduleSave } from "./persistence.js";
import { render } from "./rendering.js";

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
 * Check if a world-space point is inside an image element.
 * Returns the topmost image hit, or null.
 */
export function getImageAtWorldPos(worldPos) {
  for (let i = state.images.length - 1; i >= 0; i--) {
    const img = state.images[i];
    if (
      worldPos.x >= img.x && worldPos.x <= img.x + img.w &&
      worldPos.y >= img.y && worldPos.y <= img.y + img.h
    ) {
      return img;
    }
  }
  return null;
}

/**
 * Begin drawing a marquee selection rectangle.
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

  // Check if clicking on an image
  const targetImage = getImageAtWorldPos(worldPos);
  if (!targetImage) {
    exitMarqueeMode();
    return;
  }

  state.marqueeIsSelecting = true;
  state.marqueeStart = { x: worldPos.x, y: worldPos.y };
  state.marqueeTarget = targetImage;
  state.marqueeRect = { x: worldPos.x, y: worldPos.y, w: 0, h: 0 };
  state.marqueeOffset = { x: 0, y: 0 };
  state.marqueePixelCanvas = null;
  state.marqueeIsDragging = false;
  state.marqueeCut = false;
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

  // Clamp to target image bounds
  const img = state.marqueeTarget;
  if (!img) return;
  const clampedX = Math.max(img.x, x);
  const clampedY = Math.max(img.y, y);
  const clampedMaxX = Math.min(img.x + img.w, x + w);
  const clampedMaxY = Math.min(img.y + img.h, y + h);

  state.marqueeRect = {
    x: clampedX,
    y: clampedY,
    w: Math.max(0, clampedMaxX - clampedX),
    h: Math.max(0, clampedMaxY - clampedY),
  };

  render();
}

/**
 * Finalize drawing the marquee rectangle and extract pixels.
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
    // Selection too small, cancel
    exitMarqueeMode();
    return;
  }

  // Extract pixels from the source image
  extractMarqueePixels();
  state.marqueeMode = true;
  startMarchingAnts();
  render();
}

/**
 * Extract pixels from the target image within the marquee rectangle.
 */
function extractMarqueePixels() {
  const img = state.marqueeTarget;
  const rect = state.marqueeRect;
  if (!img || !rect) return;

  const imgEl = img.img;
  const natW = imgEl.naturalWidth || imgEl.width;
  const natH = imgEl.naturalHeight || imgEl.height;

  // Convert world-space marquee rect to image pixel coordinates
  const scaleX = natW / img.w;
  const scaleY = natH / img.h;

  let sx = (rect.x - img.x) * scaleX;
  let sy = (rect.y - img.y) * scaleY;
  let sw = rect.w * scaleX;
  let sh = rect.h * scaleY;

  // Handle crop
  if (img.crop) {
    const cropSx = img.crop.x * natW;
    const cropSy = img.crop.y * natH;
    sx += cropSx;
    sy += cropSy;
  }

  // Clamp to valid pixel bounds
  sx = Math.max(0, Math.round(sx));
  sy = Math.max(0, Math.round(sy));
  sw = Math.round(Math.min(sw, natW - sx));
  sh = Math.round(Math.min(sh, natH - sy));

  if (sw <= 0 || sh <= 0) return;

  // Create offscreen canvas with the selected pixels
  let offscreen, offCtx;
  if (typeof OffscreenCanvas !== "undefined") {
    offscreen = new OffscreenCanvas(sw, sh);
    offCtx = offscreen.getContext("2d");
  } else {
    offscreen = document.createElement("canvas");
    offscreen.width = sw;
    offscreen.height = sh;
    offCtx = offscreen.getContext("2d");
  }

  offCtx.drawImage(imgEl, sx, sy, sw, sh, 0, 0, sw, sh);
  state.marqueePixelCanvas = offscreen;
}

/**
 * Cut the selected pixels from the source image (replace with transparency/white).
 */
export function marqueeCut() {
  if (!state.marqueeMode || !state.marqueeTarget || !state.marqueeRect) return;
  if (state.marqueeCut) return; // Already cut

  pushUndo();

  const img = state.marqueeTarget;
  const rect = state.marqueeRect;
  const imgEl = img.img;
  const natW = imgEl.naturalWidth || imgEl.width;
  const natH = imgEl.naturalHeight || imgEl.height;

  const scaleX = natW / img.w;
  const scaleY = natH / img.h;

  let sx = (rect.x - img.x) * scaleX;
  let sy = (rect.y - img.y) * scaleY;
  let sw = rect.w * scaleX;
  let sh = rect.h * scaleY;

  if (img.crop) {
    const cropSx = img.crop.x * natW;
    const cropSy = img.crop.y * natH;
    sx += cropSx;
    sy += cropSy;
  }

  sx = Math.max(0, Math.round(sx));
  sy = Math.max(0, Math.round(sy));
  sw = Math.round(Math.min(sw, natW - sx));
  sh = Math.round(Math.min(sh, natH - sy));

  if (sw <= 0 || sh <= 0) return;

  // Create a new image with the selected region cleared
  let fullCanvas, fullCtx;
  if (typeof OffscreenCanvas !== "undefined") {
    fullCanvas = new OffscreenCanvas(natW, natH);
    fullCtx = fullCanvas.getContext("2d");
  } else {
    fullCanvas = document.createElement("canvas");
    fullCanvas.width = natW;
    fullCanvas.height = natH;
    fullCtx = fullCanvas.getContext("2d");
  }

  fullCtx.drawImage(imgEl, 0, 0);
  fullCtx.clearRect(sx, sy, sw, sh);

  // Replace the image source with the modified version
  const newImg = new Image();
  const dataURL = fullCanvas instanceof OffscreenCanvas
    ? null // will use blob approach
    : fullCanvas.toDataURL("image/png");

  if (fullCanvas instanceof OffscreenCanvas) {
    fullCanvas.convertToBlob({ type: "image/png" }).then((blob) => {
      const url = URL.createObjectURL(blob);
      newImg.onload = () => {
        img.img = newImg;
        state.marqueeCut = true;
        render();
        scheduleSave();
      };
      newImg.src = url;
    });
  } else {
    newImg.onload = () => {
      img.img = newImg;
      state.marqueeCut = true;
      render();
      scheduleSave();
    };
    newImg.src = dataURL;
  }

  showToast("Cut selection");
}

/**
 * Copy the selected pixels to the clipboard as a PNG image.
 */
export function marqueeCopy() {
  if (!state.marqueeMode || !state.marqueePixelCanvas) return;

  const canvas = state.marqueePixelCanvas;

  if (canvas instanceof OffscreenCanvas) {
    canvas.convertToBlob({ type: "image/png" }).then((blob) => {
      navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]).then(() => {
        showToast("Copied selection to clipboard");
      }).catch(() => {
        showToast("Failed to copy to clipboard");
      });
    });
  } else {
    canvas.toBlob((blob) => {
      if (!blob) return;
      navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]).then(() => {
        showToast("Copied selection to clipboard");
      }).catch(() => {
        showToast("Failed to copy to clipboard");
      });
    }, "image/png");
  }
}

/**
 * Commit the marquee selection — if pixels were moved, bake them into the target image
 * at the new position, or if not moved, just deselect.
 */
export function marqueeCommit() {
  if (!state.marqueeMode) return;

  const hasOffset = state.marqueeOffset.x !== 0 || state.marqueeOffset.y !== 0;

  if (hasOffset && state.marqueePixelCanvas && state.marqueeTarget) {
    if (!state.marqueeCut) {
      // Need to cut first before placing at new position
      cutAndPlace();
    } else {
      // Already cut, just place at new position
      placeMarqueePixels();
    }
  }

  exitMarqueeMode();
}

/**
 * Cut the original area and place pixels at the new offset position.
 */
function cutAndPlace() {
  const img = state.marqueeTarget;
  const rect = state.marqueeRect;
  if (!img || !rect || !state.marqueePixelCanvas) return;

  pushUndo();

  const imgEl = img.img;
  const natW = imgEl.naturalWidth || imgEl.width;
  const natH = imgEl.naturalHeight || imgEl.height;

  const scaleX = natW / img.w;
  const scaleY = natH / img.h;

  let sx = (rect.x - img.x) * scaleX;
  let sy = (rect.y - img.y) * scaleY;
  let sw = rect.w * scaleX;
  let sh = rect.h * scaleY;

  if (img.crop) {
    sx += img.crop.x * natW;
    sy += img.crop.y * natH;
  }

  sx = Math.max(0, Math.round(sx));
  sy = Math.max(0, Math.round(sy));
  sw = Math.round(Math.min(sw, natW - sx));
  sh = Math.round(Math.min(sh, natH - sy));

  // Destination in pixel space
  const destX = Math.round(sx + state.marqueeOffset.x * scaleX);
  const destY = Math.round(sy + state.marqueeOffset.y * scaleY);

  // Create new image with cleared source and placed destination
  let fullCanvas, fullCtx;
  if (typeof OffscreenCanvas !== "undefined") {
    fullCanvas = new OffscreenCanvas(natW, natH);
    fullCtx = fullCanvas.getContext("2d");
  } else {
    fullCanvas = document.createElement("canvas");
    fullCanvas.width = natW;
    fullCanvas.height = natH;
    fullCtx = fullCanvas.getContext("2d");
  }

  fullCtx.drawImage(imgEl, 0, 0);
  fullCtx.clearRect(sx, sy, sw, sh);
  fullCtx.drawImage(state.marqueePixelCanvas, 0, 0, sw, sh, destX, destY, sw, sh);

  const newImg = new Image();
  if (fullCanvas instanceof OffscreenCanvas) {
    fullCanvas.convertToBlob({ type: "image/png" }).then((blob) => {
      const url = URL.createObjectURL(blob);
      newImg.onload = () => {
        img.img = newImg;
        render();
        scheduleSave();
      };
      newImg.src = url;
    });
  } else {
    newImg.onload = () => {
      img.img = newImg;
      render();
      scheduleSave();
    };
    newImg.src = fullCanvas.toDataURL("image/png");
  }
}

/**
 * Place marquee pixels at the new position (after already being cut).
 */
function placeMarqueePixels() {
  const img = state.marqueeTarget;
  const rect = state.marqueeRect;
  if (!img || !rect || !state.marqueePixelCanvas) return;

  const imgEl = img.img;
  const natW = imgEl.naturalWidth || imgEl.width;
  const natH = imgEl.naturalHeight || imgEl.height;

  const scaleX = natW / img.w;
  const scaleY = natH / img.h;

  let sx = (rect.x - img.x) * scaleX;
  let sy = (rect.y - img.y) * scaleY;
  let sw = rect.w * scaleX;
  let sh = rect.h * scaleY;

  if (img.crop) {
    sx += img.crop.x * natW;
    sy += img.crop.y * natH;
  }

  sx = Math.max(0, Math.round(sx));
  sy = Math.max(0, Math.round(sy));
  sw = Math.round(Math.min(sw, natW - sx));
  sh = Math.round(Math.min(sh, natH - sy));

  const destX = Math.round(sx + state.marqueeOffset.x * scaleX);
  const destY = Math.round(sy + state.marqueeOffset.y * scaleY);

  let fullCanvas, fullCtx;
  if (typeof OffscreenCanvas !== "undefined") {
    fullCanvas = new OffscreenCanvas(natW, natH);
    fullCtx = fullCanvas.getContext("2d");
  } else {
    fullCanvas = document.createElement("canvas");
    fullCanvas.width = natW;
    fullCanvas.height = natH;
    fullCtx = fullCanvas.getContext("2d");
  }

  fullCtx.drawImage(imgEl, 0, 0);
  fullCtx.drawImage(state.marqueePixelCanvas, 0, 0, sw, sh, destX, destY, sw, sh);

  const newImg = new Image();
  if (fullCanvas instanceof OffscreenCanvas) {
    fullCanvas.convertToBlob({ type: "image/png" }).then((blob) => {
      const url = URL.createObjectURL(blob);
      newImg.onload = () => {
        img.img = newImg;
        render();
        scheduleSave();
      };
      newImg.src = url;
    });
  } else {
    newImg.onload = () => {
      img.img = newImg;
      render();
      scheduleSave();
    };
    newImg.src = fullCanvas.toDataURL("image/png");
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

  // Draw the selected pixels at offset position
  if (state.marqueePixelCanvas && state.marqueeMode) {
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.drawImage(
      state.marqueePixelCanvas,
      rect.x + ox, rect.y + oy,
      rect.w, rect.h
    );
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
 * Render just the selection rectangle while dragging to define it (before pixels are extracted).
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
