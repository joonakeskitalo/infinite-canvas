/**
 * Canvas Rendering
 *
 * Main render loop, shape drawing, measurement lines, and PNG export.
 */

import { state, CONSTANTS, getDom, getElementsInZOrder, spatialIndex, getSplitLineExtent, trimSplitLineExtentAtCrossings } from "./state.js";
import { getViewportBounds, isRectInViewport, worldToScreen, screenToWorld } from "./utils.js";
import { applyFilterToImageData } from "./filter-kernels.js";
import {
  getShapeBounds, getElementResizeHandles, getElementCenter,
  getElementBounds, getSwapHandleRadius, isPointOnSwapHandle,
} from "./elements.js";
import { getFullImageBounds } from "./crop.js";
import { renderMarquee, renderMarqueeSelecting } from "./marquee-select.js";
import { renderAccessibilityPreviewSelection, isAccessibilityPreviewSelecting } from "./accessibility-preview.js";
import { renderLaserTrails, renderLaserTrailsForExport, hasLaserVisuals } from "./laser-pointer.js";
import { snapSplitLineAxis } from "./snap-guides.js";

// --- Empty canvas placeholder ---
let _placeholderEl = null;
let _placeholderVisible = true;

function updateEmptyCanvasPlaceholder() {
  if (!_placeholderEl) {
    _placeholderEl = document.getElementById("empty-canvas-placeholder");
    if (!_placeholderEl) return;
  }
  const isEmpty = state.images.length === 0 && state.drawings.length === 0;
  if (isEmpty && !_placeholderVisible) {
    _placeholderEl.classList.remove("hidden");
    _placeholderVisible = true;
  } else if (!isEmpty && _placeholderVisible) {
    _placeholderEl.classList.add("hidden");
    _placeholderVisible = false;
  }
}

// --- PERFORMANCE: requestAnimationFrame batching ---
let _renderScheduled = false;
let _renderAfterCallbacks = [];
let _postRenderHook = null;

// --- PERFORMANCE: Text measurement cache ---
export const _textMeasureCache = new WeakMap();

export function setPostRenderHook(fn) {
  _postRenderHook = fn;
}

export function scheduleRender() {
  if (!_renderScheduled) {
    _renderScheduled = true;
    requestAnimationFrame(() => {
      _renderScheduled = false;
      const { ctx } = getDom();
      _doRender(ctx, false);
      const cbs = _renderAfterCallbacks;
      _renderAfterCallbacks = [];
      for (let i = 0; i < cbs.length; i++) cbs[i]();
      if (_postRenderHook) _postRenderHook();
    });
  }
}

export function addRenderCallback(cb) {
  _renderAfterCallbacks.push(cb);
}

/**
 * Snap a split-line preview coordinate. Mirrors placement snapping: quadrant
 * lines of the hovered image plus other elements' edges/centers and existing
 * split lines. Delegates to the shared helper so preview matches placement.
 * @param {"x"|"y"} axis which axis pos lies on
 */
function snapSplitLinePreviewPos(pos, axis, origin, size) {
  return snapSplitLineAxis(pos, axis, origin, size);
}

export function render(targetCtx, isExporting = false) {
  if (!targetCtx) targetCtx = getDom().ctx;
  if (isExporting || targetCtx !== getDom().ctx) {
    _doRender(targetCtx, isExporting);
    return;
  }
  scheduleRender();
}

/**
 * Force a synchronous render to the main canvas.
 * Use sparingly — needed when pixel sampling must follow immediately after a state change.
 */
export function renderSync() {
  const { ctx } = getDom();
  _doRender(ctx, false);
}

export function getFilteredImage(imgData) {
  if (state.filteredImageCacheFilter !== state.currentFilter) {
    state.filteredImageCache = new WeakMap();
    state.filteredImageCacheFilter = state.currentFilter;
  }

  if (state.filteredImageCache.has(imgData.img)) {
    return state.filteredImageCache.get(imgData.img);
  }

  const w = imgData.img.naturalWidth || imgData.img.width;
  const h = imgData.img.naturalHeight || imgData.img.height;

  // Use OffscreenCanvas when available for better performance (no DOM overhead)
  let offscreen, offCtx;
  if (typeof OffscreenCanvas !== "undefined") {
    offscreen = new OffscreenCanvas(w, h);
    offCtx = offscreen.getContext("2d");
  } else {
    offscreen = document.createElement("canvas");
    offscreen.width = w;
    offscreen.height = h;
    offCtx = offscreen.getContext("2d");
  }

  offCtx.drawImage(imgData.img, 0, 0);
  const imageData = offCtx.getImageData(0, 0, w, h);
  applyFilterToImageData(imageData, state.currentFilter);
  offCtx.putImageData(imageData, 0, 0);

  state.filteredImageCache.set(imgData.img, offscreen);
  return offscreen;
}

/**
 * Get a cached pre-rendered canvas containing just the cropped sub-region of an image.
 * This avoids the expensive 9-arg drawImage call on every frame during panning.
 * The cache is keyed by the source image and validated against the current crop parameters.
 */
export function getCroppedImage(imgData, drawSrc) {
  const c = imgData.crop;
  const cached = state.cropImageCache.get(imgData);
  if (cached && cached.cx === c.x && cached.cy === c.y && cached.cw === c.w && cached.ch === c.h && cached.src === drawSrc) {
    return cached.canvas;
  }

  const natW = drawSrc.naturalWidth || drawSrc.width;
  const natH = drawSrc.naturalHeight || drawSrc.height;
  const sx = c.x * natW;
  const sy = c.y * natH;
  const sw = c.w * natW;
  const sh = c.h * natH;

  // Round to integer pixel dimensions for the cached canvas
  const cw = Math.round(sw);
  const ch = Math.round(sh);
  if (cw < 1 || ch < 1) return null;

  let offscreen, offCtx;
  if (typeof OffscreenCanvas !== "undefined") {
    offscreen = new OffscreenCanvas(cw, ch);
    offCtx = offscreen.getContext("2d");
  } else {
    offscreen = document.createElement("canvas");
    offscreen.width = cw;
    offscreen.height = ch;
    offCtx = offscreen.getContext("2d");
  }

  offCtx.drawImage(drawSrc, sx, sy, sw, sh, 0, 0, cw, ch);

  state.cropImageCache.set(imgData, { canvas: offscreen, cx: c.x, cy: c.y, cw: c.w, ch: c.h, src: drawSrc });
  return offscreen;
}

/**
 * Invalidate the crop cache entry for a specific image element.
 */
export function invalidateCropCache(imgElement) {
  state.cropImageCache.delete(imgElement);
}

/**
 * Draw a small lock icon at the top-left corner of an element to indicate it's locked.
 */
function drawLockIcon(ctx, x, y, zoom) {
  const size = 16 / zoom;
  const padding = 4 / zoom;
  const ix = x + padding;
  const iy = y + padding;

  ctx.save();
  // Background circle
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.beginPath();
  ctx.arc(ix + size / 2, iy + size / 2, size * 0.65, 0, Math.PI * 2);
  ctx.fill();

  // Lock body
  const bw = size * 0.55;
  const bh = size * 0.4;
  const bx = ix + (size - bw) / 2;
  const by = iy + size * 0.48;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(bx, by, bw, bh);

  // Lock shackle
  const sw = bw * 0.6;
  const sh = size * 0.3;
  const sx = ix + (size - sw) / 2;
  const sy = by - sh;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5 / zoom;
  ctx.beginPath();
  ctx.arc(sx + sw / 2, sy + sh, sw / 2, Math.PI, 0);
  ctx.stroke();
  ctx.restore();
}

export function drawMeasureLine(targetCtx, start, end, color, isExporting) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 0.1) return;

  const zoomFactor = isExporting ? 1 : state.transform.zoom;
  const lineWidth = (isExporting ? 2 : 1.5) / zoomFactor;
  const capSize = 6 / zoomFactor;
  const fontSize = Math.max(9, 10 / zoomFactor);

  targetCtx.save();
  targetCtx.strokeStyle = color || "#00bcd4";
  targetCtx.fillStyle = color || "#00bcd4";
  targetCtx.lineWidth = lineWidth;
  targetCtx.lineCap = "butt";
  targetCtx.setLineDash([4 / zoomFactor, 3 / zoomFactor]);

  targetCtx.beginPath();
  targetCtx.moveTo(start.x, start.y);
  targetCtx.lineTo(end.x, end.y);
  targetCtx.stroke();

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

  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  const labelText = `${Math.round(dist)}px`;

  targetCtx.font = `${fontSize}px sans-serif`;
  targetCtx.textAlign = "center";
  targetCtx.textBaseline = "bottom";

  const metrics = targetCtx.measureText(labelText);
  const labelW = metrics.width + 8 / zoomFactor;
  const labelH = fontSize + 6 / zoomFactor;

  const labelOffset = 4 / zoomFactor;
  const labelCx = midX + Math.sin(angle) * labelOffset;
  const labelCy = midY - Math.cos(angle) * labelOffset;

  targetCtx.fillStyle = "rgba(0, 40, 50, 0.4)";
  targetCtx.beginPath();
  targetCtx.roundRect(labelCx - labelW / 2, labelCy - labelH, labelW, labelH, 3 / zoomFactor);
  targetCtx.fill();

  targetCtx.fillStyle = "rgba(255, 255, 255, 0.75)";
  targetCtx.fillText(labelText, labelCx, labelCy - 2 / zoomFactor);

  targetCtx.restore();
}

/**
 * Draw a contrast line between two sampled color points.
 * Shows color swatches at each end and the contrast ratio in the middle.
 */
export function drawContrastLine(targetCtx, shape, isExporting) {
  const { start, end, hex1, hex2, ratio } = shape;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 0.1) return;

  const zoomFactor = isExporting ? 1 : state.transform.zoom;
  const lineWidth = (isExporting ? 2 : 2) / zoomFactor;
  const swatchRadius = 10 / zoomFactor;
  const fontSize = Math.max(9, 11 / zoomFactor);

  targetCtx.save();

  // Draw connecting line
  targetCtx.strokeStyle = "#e040fb";
  targetCtx.lineWidth = lineWidth;
  targetCtx.lineCap = "round";
  targetCtx.setLineDash([6 / zoomFactor, 4 / zoomFactor]);
  targetCtx.beginPath();
  targetCtx.moveTo(start.x, start.y);
  targetCtx.lineTo(end.x, end.y);
  targetCtx.stroke();
  targetCtx.setLineDash([]);

  // Draw color swatches at endpoints — larger with shadow and strong border
  // Swatch 1 (start)
  targetCtx.shadowColor = "rgba(0, 0, 0, 0.5)";
  targetCtx.shadowBlur = 4 / zoomFactor;
  targetCtx.shadowOffsetX = 0;
  targetCtx.shadowOffsetY = 1 / zoomFactor;

  targetCtx.fillStyle = hex1;
  targetCtx.beginPath();
  targetCtx.arc(start.x, start.y, swatchRadius, 0, Math.PI * 2);
  targetCtx.fill();

  targetCtx.shadowColor = "transparent";
  targetCtx.strokeStyle = "#ffffff";
  targetCtx.lineWidth = 2.5 / zoomFactor;
  targetCtx.stroke();
  targetCtx.strokeStyle = "rgba(0, 0, 0, 0.4)";
  targetCtx.lineWidth = 1 / zoomFactor;
  targetCtx.beginPath();
  targetCtx.arc(start.x, start.y, swatchRadius + 1.5 / zoomFactor, 0, Math.PI * 2);
  targetCtx.stroke();

  // Swatch 2 (end)
  targetCtx.shadowColor = "rgba(0, 0, 0, 0.5)";
  targetCtx.shadowBlur = 4 / zoomFactor;
  targetCtx.shadowOffsetX = 0;
  targetCtx.shadowOffsetY = 1 / zoomFactor;

  targetCtx.fillStyle = hex2;
  targetCtx.beginPath();
  targetCtx.arc(end.x, end.y, swatchRadius, 0, Math.PI * 2);
  targetCtx.fill();

  targetCtx.shadowColor = "transparent";
  targetCtx.strokeStyle = "#ffffff";
  targetCtx.lineWidth = 2.5 / zoomFactor;
  targetCtx.stroke();
  targetCtx.strokeStyle = "rgba(0, 0, 0, 0.4)";
  targetCtx.lineWidth = 1 / zoomFactor;
  targetCtx.beginPath();
  targetCtx.arc(end.x, end.y, swatchRadius + 1.5 / zoomFactor, 0, Math.PI * 2);
  targetCtx.stroke();

  // Draw ratio label at midpoint
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  const ratioText = ratio.toFixed(1) + ":1";
  const passes45 = ratio >= 4.5;

  targetCtx.font = `bold ${fontSize}px sans-serif`;
  targetCtx.textAlign = "center";
  targetCtx.textBaseline = "middle";

  const metrics = targetCtx.measureText(ratioText);
  const labelW = metrics.width + 10 / zoomFactor;
  const labelH = fontSize + 8 / zoomFactor;

  // Offset label perpendicular to line
  const angle = Math.atan2(dy, dx);
  const labelOffset = 10 / zoomFactor;
  const labelCx = midX + Math.sin(angle) * labelOffset;
  const labelCy = midY - Math.cos(angle) * labelOffset;

  // Background pill
  targetCtx.fillStyle = passes45 ? "rgba(20, 80, 40, 0.85)" : "rgba(100, 20, 20, 0.85)";
  targetCtx.beginPath();
  targetCtx.roundRect(labelCx - labelW / 2, labelCy - labelH / 2, labelW, labelH, 4 / zoomFactor);
  targetCtx.fill();

  // Border
  targetCtx.strokeStyle = passes45 ? "rgba(92, 219, 92, 0.6)" : "rgba(255, 107, 107, 0.6)";
  targetCtx.lineWidth = 1 / zoomFactor;
  targetCtx.stroke();

  // Ratio text
  targetCtx.fillStyle = passes45 ? "#5cdb5c" : "#ff6b6b";
  targetCtx.fillText(ratioText, labelCx, labelCy);

  targetCtx.restore();
}

export function drawShape(targetCtx, shape, isExporting, exportScale) {
  let calculatedWidth = shape.width;
  if (shape.type !== "text") {
    if (isExporting) {
      if (shape.isSplitLine) {
        // Split lines are rendered as constant-pixel-width hairlines on canvas
        // (shape.width CSS pixels regardless of zoom). In the export, compensate for
        // the export scale so the line stays the same pixel width in the output image.
        const scale = exportScale || 1;
        calculatedWidth = shape.width / scale;
      } else {
        calculatedWidth = shape.width * 2;
      }
    } else {
      calculatedWidth = shape.width / state.transform.zoom;
    }
  }

  targetCtx.save();
  targetCtx.globalAlpha = shape.opacity != null ? shape.opacity : 1;
  targetCtx.strokeStyle = shape.color;
  targetCtx.fillStyle = shape.color;
  targetCtx.lineWidth = calculatedWidth;
  targetCtx.lineCap = "round";
  targetCtx.lineJoin = "round";

  // Apply dash pattern for general drawing tools
  if (shape.dash && shape.dash !== "solid" && !shape.isSplitLine) {
    if (shape.dash === "dashed") {
      targetCtx.setLineDash([calculatedWidth * 4, calculatedWidth * 3]);
    } else if (shape.dash === "dotted") {
      targetCtx.setLineDash([calculatedWidth * 1, calculatedWidth * 2]);
    } else if (shape.dash === "dash-dot") {
      targetCtx.setLineDash([calculatedWidth * 4, calculatedWidth * 2, calculatedWidth * 1, calculatedWidth * 2]);
    }
  }

  if (shape.type === "pen") {
    if (shape.points.length === 1) {
      // Single-point pen stroke — draw as a filled dot
      const p = shape.points[0];
      const radius = calculatedWidth;
      targetCtx.beginPath();
      targetCtx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      targetCtx.fillStyle = shape.color;
      targetCtx.fill();
      targetCtx.restore();
      return;
    }
    if (shape.points.length < 2) { targetCtx.restore(); return; }
    targetCtx.beginPath();
    targetCtx.moveTo(shape.points[0].x, shape.points[0].y);
    for (let i = 1; i < shape.points.length; i++)
      targetCtx.lineTo(shape.points[i].x, shape.points[i].y);
    targetCtx.stroke();
  } else if (shape.type === "line") {
    // Apply dash pattern for split lines
    if (shape.isSplitLine && shape.dash && shape.dash !== "solid") {
      // In export mode, scale dashes to produce consistent pixel sizes in the output.
      // On canvas, compensate for zoom so dashes appear constant-size on screen.
      const dashScale = isExporting ? (1 / (exportScale || 1)) : (1 / state.transform.zoom);
      if (shape.dash === "dashed") {
        targetCtx.setLineDash([8 * dashScale, 4 * dashScale]);
      } else if (shape.dash === "dotted") {
        targetCtx.setLineDash([2 * dashScale, 3 * dashScale]);
      } else if (shape.dash === "dash-dot") {
        targetCtx.setLineDash([8 * dashScale, 3 * dashScale, 2 * dashScale, 3 * dashScale]);
      }
    }
    if (isExporting && shape.isSplitLine && exportScale) {
      // Snap split line coordinates to pixel grid for crisp 1px rendering.
      // A line with odd-pixel width needs a 0.5px offset to align to the pixel grid.
      const s = exportScale;
      const offset = (Math.round(calculatedWidth * s) % 2 === 1) ? 0.5 / s : 0;
      const isVertical = shape.start.x === shape.end.x;
      const isHorizontal = shape.start.y === shape.end.y;
      let sx = shape.start.x, sy = shape.start.y, ex = shape.end.x, ey = shape.end.y;
      if (isVertical) {
        sx = Math.round(sx * s) / s + offset;
        ex = sx;
      } else if (isHorizontal) {
        sy = Math.round(sy * s) / s + offset;
        ey = sy;
      }
      targetCtx.lineCap = "butt";
      targetCtx.beginPath();
      targetCtx.moveTo(sx, sy);
      targetCtx.lineTo(ex, ey);
      targetCtx.stroke();
    } else {
      targetCtx.beginPath();
      targetCtx.moveTo(shape.start.x, shape.start.y);
      targetCtx.lineTo(shape.end.x, shape.end.y);
      targetCtx.stroke();
    }
  } else if (shape.type === "arrow") {
    const dx = shape.end.x - shape.start.x;
    const dy = shape.end.y - shape.start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0.1) {
      const ux = dx / len;
      const uy = dy / len;
      const headLength = Math.max(16 / (isExporting ? 1 : state.transform.zoom), calculatedWidth * 3.5);
      const headWidth = Math.max(10 / (isExporting ? 1 : state.transform.zoom), calculatedWidth * 2.2);
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
    targetCtx.strokeRect(shape.start.x, shape.start.y, shape.end.x - shape.start.x, shape.end.y - shape.start.y);
  } else if (shape.type === "rect-fill") {
    targetCtx.fillRect(shape.start.x, shape.start.y, shape.end.x - shape.start.x, shape.end.y - shape.start.y);
  } else if (shape.type === "measure") {
    drawMeasureLine(targetCtx, shape.start, shape.end, shape.color, isExporting);
  } else if (shape.type === "contrast-line") {
    drawContrastLine(targetCtx, shape, isExporting);
  } else if (shape.type === "connector") {
    const dx = shape.end.x - shape.start.x;
    const dy = shape.end.y - shape.start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0.1) {
      const ux = dx / len;
      const uy = dy / len;
      const headLength = Math.max(16 / (isExporting ? 1 : state.transform.zoom), calculatedWidth * 3.5);
      const headWidth = Math.max(10 / (isExporting ? 1 : state.transform.zoom), calculatedWidth * 2.2);
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
    if (!isExporting) {
      const dotRadius = 4 / state.transform.zoom;
      if (shape.startConn) {
        targetCtx.beginPath();
        targetCtx.arc(shape.start.x, shape.start.y, dotRadius, 0, Math.PI * 2);
        targetCtx.fill();
      }
    }
  } else if (shape.type === "text") {
    targetCtx.font = `${shape.fontSize}px ${shape.fontFamily || "sans-serif"}`;
    targetCtx.textBaseline = "top";
    const lineHeight = shape.fontSize * 1.2;
    const rawLines = shape.text.split("\n");
    const textAlign = shape.textAlign || "left";

    // Word-wrap lines if textWidth is set
    let lines;
    if (shape.textWidth) {
      lines = [];
      rawLines.forEach((rawLine) => {
        if (rawLine.length === 0) { lines.push(""); return; }
        const words = rawLine.split(/(\s+)/);
        let currentLine = "";
        for (let i = 0; i < words.length; i++) {
          const word = words[i];
          const testLine = currentLine + word;
          const metrics = targetCtx.measureText(testLine);
          if (metrics.width > shape.textWidth && currentLine.length > 0) {
            lines.push(currentLine);
            currentLine = word.trimStart();
          } else {
            currentLine = testLine;
          }
          // Break long words that exceed textWidth by themselves
          while (targetCtx.measureText(currentLine).width > shape.textWidth && currentLine.length > 1) {
            let breakAt = currentLine.length - 1;
            for (let c = 1; c < currentLine.length; c++) {
              if (targetCtx.measureText(currentLine.slice(0, c + 1)).width > shape.textWidth) {
                breakAt = c;
                break;
              }
            }
            lines.push(currentLine.slice(0, breakAt));
            currentLine = currentLine.slice(breakAt);
          }
        }
        lines.push(currentLine);
      });
    } else {
      lines = rawLines;
    }

    // Measure and cache
    const segKey = shape.segments ? JSON.stringify(shape.segments.map((s) => ({ b: s.bold ? 1 : 0, i: s.italic ? 1 : 0, u: s.underline ? 1 : 0, s: s.strikethrough ? 1 : 0, fs: s.fontSize || 0, t: s.text, l: s.line }))) : "";
    const cacheKey = shape.text + "|" + shape.fontSize + "|" + (shape.fontFamily || "sans-serif") + "|" + (shape.textWidth || "") + "|" + segKey;
    let cached = _textMeasureCache.get(shape);
    if (!cached || cached.cacheKey !== cacheKey) {
      let maxWidth = 0;
      if (shape.segments && shape.segments.length > 0) {
        // Measure per-line using segment fonts
        const lineWidths = [];
        shape.segments.forEach((seg) => {
          while (lineWidths.length <= seg.line) lineWidths.push(0);
          const prefix = (seg.bold ? "bold " : "") + (seg.italic ? "italic " : "");
          const segSize = seg.fontSize || shape.fontSize;
          targetCtx.font = `${prefix}${segSize}px ${shape.fontFamily || "sans-serif"}`;
          lineWidths[seg.line] += targetCtx.measureText(seg.text).width;
        });
        lineWidths.forEach((w) => { if (w > maxWidth) maxWidth = w; });
        // Reset font
        targetCtx.font = `${shape.fontSize}px ${shape.fontFamily || "sans-serif"}`;
      } else {
        lines.forEach((line) => {
          const metrics = targetCtx.measureText(line);
          if (metrics.width > maxWidth) maxWidth = metrics.width;
        });
      }
      const effectiveW = shape.textWidth ? shape.textWidth : maxWidth;
      cached = { cacheKey, w: effectiveW, h: lineHeight * (lines.length - 1) + shape.fontSize, lines };
      _textMeasureCache.set(shape, cached);
    } else {
      lines = cached.lines;
    }
    shape.w = cached.w;
    shape.h = cached.h;

    if (shape.bgColor) {
      const padding = shape.fontSize * 0.4;
      targetCtx.fillStyle = shape.bgColor;
      targetCtx.beginPath();
      const rx = 4 / (isExporting ? 1 : state.transform.zoom);
      const bx = shape.start.x - padding;
      const by = shape.start.y - padding;
      const bw = shape.w + padding * 2;
      const bh = shape.h + padding * 2;
      if (shape.bgBorder) {
        // Pin tip at top-left: the tip point is the pick location
        const tipSize = padding * 0.6;
        targetCtx.moveTo(bx - tipSize, by - tipSize); // tip = pick point
        targetCtx.lineTo(bx + tipSize * 1.5, by);
        targetCtx.lineTo(bx + bw - rx, by);
        targetCtx.arcTo(bx + bw, by, bx + bw, by + rx, rx);
        targetCtx.lineTo(bx + bw, by + bh - rx);
        targetCtx.arcTo(bx + bw, by + bh, bx + bw - rx, by + bh, rx);
        targetCtx.lineTo(bx + rx, by + bh);
        targetCtx.arcTo(bx, by + bh, bx, by + bh - rx, rx);
        targetCtx.lineTo(bx, by + tipSize * 1.5);
        targetCtx.closePath();
      } else {
        targetCtx.roundRect(bx, by, bw, bh, rx);
      }
      targetCtx.fill();

      // Inset border with matching pin shape
      if (shape.bgBorder) {
        const borderWidth = 2 / (isExporting ? 1 : state.transform.zoom);
        const inset = borderWidth / 2;
        const ibx = bx + inset;
        const iby = by + inset;
        const ibw = bw - borderWidth;
        const ibh = bh - borderWidth;
        const tipSize = padding * 0.6;

        targetCtx.strokeStyle = shape.bgBorder;
        targetCtx.lineWidth = borderWidth;
        targetCtx.lineJoin = "miter";
        targetCtx.beginPath();
        targetCtx.moveTo(ibx - tipSize + inset, iby - tipSize + inset); // tip
        targetCtx.lineTo(ibx + tipSize * 1.5, iby);
        targetCtx.lineTo(ibx + ibw - rx, iby);
        targetCtx.arcTo(ibx + ibw, iby, ibx + ibw, iby + rx, rx);
        targetCtx.lineTo(ibx + ibw, iby + ibh - rx);
        targetCtx.arcTo(ibx + ibw, iby + ibh, ibx + ibw - rx, iby + ibh, rx);
        targetCtx.lineTo(ibx + rx, iby + ibh);
        targetCtx.arcTo(ibx, iby + ibh, ibx, iby + ibh - rx, rx);
        targetCtx.lineTo(ibx, iby + tipSize * 1.5);
        targetCtx.closePath();
        targetCtx.stroke();
      }
    }

    targetCtx.fillStyle = shape.color;

    // Rich text rendering with per-segment bold/italic/underline/strikethrough/fontSize
    if (shape.segments && shape.segments.length > 0) {
      // Group segments by line
      const lineSegments = [];
      shape.segments.forEach((seg) => {
        while (lineSegments.length <= seg.line) lineSegments.push([]);
        lineSegments[seg.line].push(seg);
      });

      // Render each line's segments
      for (let i = 0; i < lines.length; i++) {
        const segs = lineSegments[i];
        let x = shape.start.x;

        // Calculate line width for alignment
        if (textAlign !== "left") {
          let lineWidth = 0;
          if (segs && segs.length > 0) {
            segs.forEach((seg) => {
              const prefix = (seg.bold ? "bold " : "") + (seg.italic ? "italic " : "");
              const segSize = seg.fontSize || shape.fontSize;
              targetCtx.font = `${prefix}${segSize}px ${shape.fontFamily || "sans-serif"}`;
              lineWidth += targetCtx.measureText(seg.text).width;
            });
          } else {
            targetCtx.font = `${shape.fontSize}px ${shape.fontFamily || "sans-serif"}`;
            lineWidth = targetCtx.measureText(lines[i]).width;
          }
          if (textAlign === "center") x = shape.start.x + (shape.w - lineWidth) / 2;
          else if (textAlign === "right") x = shape.start.x + shape.w - lineWidth;
        }

        if (segs && segs.length > 0) {
          segs.forEach((seg) => {
            const prefix = (seg.bold ? "bold " : "") + (seg.italic ? "italic " : "");
            const segSize = seg.fontSize || shape.fontSize;
            targetCtx.font = `${prefix}${segSize}px ${shape.fontFamily || "sans-serif"}`;
            targetCtx.fillText(seg.text, x, shape.start.y + i * lineHeight);
            const segWidth = targetCtx.measureText(seg.text).width;

            // Draw underline
            if (seg.underline) {
              const underlineY = shape.start.y + i * lineHeight + segSize * 1.05;
              const thickness = Math.max(1, segSize / 16);
              targetCtx.save();
              targetCtx.strokeStyle = shape.color;
              targetCtx.lineWidth = thickness;
              targetCtx.beginPath();
              targetCtx.moveTo(x, underlineY);
              targetCtx.lineTo(x + segWidth, underlineY);
              targetCtx.stroke();
              targetCtx.restore();
            }

            // Draw strikethrough
            if (seg.strikethrough) {
              const strikeY = shape.start.y + i * lineHeight + segSize * 0.55;
              const thickness = Math.max(1, segSize / 18);
              targetCtx.save();
              targetCtx.strokeStyle = shape.color;
              targetCtx.lineWidth = thickness;
              targetCtx.beginPath();
              targetCtx.moveTo(x, strikeY);
              targetCtx.lineTo(x + segWidth, strikeY);
              targetCtx.stroke();
              targetCtx.restore();
            }

            x += segWidth;
          });
        } else {
          targetCtx.font = `${shape.fontSize}px ${shape.fontFamily || "sans-serif"}`;
          targetCtx.fillText(lines[i], x, shape.start.y + i * lineHeight);
        }
      }
    } else {
      // Plain text path (no segments)
      lines.forEach((line, i) => {
        let x = shape.start.x;
        if (textAlign === "center") {
          const lw = targetCtx.measureText(line).width;
          x = shape.start.x + (shape.w - lw) / 2;
        } else if (textAlign === "right") {
          const lw = targetCtx.measureText(line).width;
          x = shape.start.x + shape.w - lw;
        }
        targetCtx.fillText(line, x, shape.start.y + i * lineHeight);
      });
    }

    if (!isExporting && state.currentTool === "select" && !state.overlaysHidden) {
      const isSelected = state.selectedElements.some((el) => el.id === shape.id);
      targetCtx.strokeStyle = isSelected ? "#ff4444" : "rgba(0, 122, 204, 0.4)";
      targetCtx.lineWidth = 1 / (isExporting ? 1 : state.transform.zoom);
      const selPadding = shape.bgColor ? shape.fontSize * 0.4 : 2;
      targetCtx.strokeRect(
        shape.start.x - selPadding, shape.start.y - selPadding,
        shape.w + selPadding * 2, shape.h + selPadding * 2,
      );
    }
  }
  targetCtx.restore();
}

// Cache for the eyedropper highlight overlay to avoid recomputing every frame
let _highlightCache = { color: null, dataKey: null, canvas: null };

/**
 * Render a highlight overlay showing pixels that match the hovered color.
 * Dims non-matching pixels and brightens matching ones within the marquee rect.
 */
function renderEyedropperHighlight(ctx, rect, imageData, hexColor) {
  // Parse the target hex color
  const tr = parseInt(hexColor.slice(1, 3), 16);
  const tg = parseInt(hexColor.slice(3, 5), 16);
  const tb = parseInt(hexColor.slice(5, 7), 16);

  const w = imageData.width;
  const h = imageData.height;
  const cacheKey = `${hexColor}_${w}_${h}`;

  // Use cached overlay if the color and data haven't changed
  if (_highlightCache.color === hexColor && _highlightCache.dataKey === cacheKey && _highlightCache.canvas) {
    ctx.save();
    ctx.drawImage(_highlightCache.canvas, rect.x, rect.y, rect.w, rect.h);
    ctx.restore();
    return;
  }

  // Create the highlight mask canvas
  let offscreen, offCtx;
  if (typeof OffscreenCanvas !== "undefined") {
    offscreen = new OffscreenCanvas(w, h);
    offCtx = offscreen.getContext("2d");
  } else {
    offscreen = document.createElement("canvas");
    offscreen.width = w;
    offscreen.height = h;
    offCtx = offscreen.getContext("2d");
  }

  // Build overlay: checkerboard transparency grid for non-matching pixels
  const overlay = offCtx.createImageData(w, h);
  const src = imageData.data;
  const dst = overlay.data;
  const shift = 4; // Same quantization as marquee-colors.js
  const checkSize = 6; // Checkerboard square size in pixels

  for (let i = 0; i < src.length; i += 4) {
    const px = (i / 4) % w;
    const py = Math.floor((i / 4) / w);
    const a = src[i + 3];
    if (a < 10) {
      // Transparent pixel — show checkerboard
      const isLight = ((Math.floor(px / checkSize) + Math.floor(py / checkSize)) % 2) === 0;
      dst[i] = isLight ? 255 : 204; dst[i + 1] = isLight ? 255 : 204; dst[i + 2] = isLight ? 255 : 204; dst[i + 3] = 255;
      continue;
    }

    // Quantize both source pixel and target color to check match
    const sr = (src[i] >> shift) << shift;
    const sg = (src[i + 1] >> shift) << shift;
    const sb = (src[i + 2] >> shift) << shift;
    const qr = (tr >> shift) << shift;
    const qg = (tg >> shift) << shift;
    const qb = (tb >> shift) << shift;

    if (sr === qr && sg === qg && sb === qb) {
      // Matching pixel — no overlay (fully transparent so the original shows through)
      dst[i] = 0; dst[i + 1] = 0; dst[i + 2] = 0; dst[i + 3] = 0;
    } else {
      // Non-matching pixel — show checkerboard (like transparency grid)
      const isLight = ((Math.floor(px / checkSize) + Math.floor(py / checkSize)) % 2) === 0;
      dst[i] = isLight ? 255 : 204; dst[i + 1] = isLight ? 255 : 204; dst[i + 2] = isLight ? 255 : 204; dst[i + 3] = 255;
    }
  }

  offCtx.putImageData(overlay, 0, 0);

  // Cache the result
  _highlightCache = { color: hexColor, dataKey: cacheKey, canvas: offscreen };

  ctx.save();
  ctx.drawImage(offscreen, rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}

function _doRender(targetCtx, isExporting) {
  const { canvas, textEditor } = getDom();
  const transform = state.transform;

  if (!isExporting) {
    // Toggle empty-canvas placeholder visibility
    updateEmptyCanvasPlaceholder();

    targetCtx.fillStyle = state.bgColor;
    targetCtx.fillRect(0, 0, canvas.width, canvas.height);
  }

  targetCtx.save();
  if (!isExporting) {
    targetCtx.translate(transform.x, transform.y);
    targetCtx.scale(transform.zoom, transform.zoom);
  }

  const _vp = !isExporting ? getViewportBounds() : null;

  // PERFORMANCE: Pre-build a Set of selected element IDs for O(1) lookups in the render loop.
  // Replaces repeated O(n) state.selectedElements.some() calls per element.
  const _selectedIdSet = !isExporting && state.selectedElements.length > 0
    ? new Set(state.selectedElements.map(el => el.id))
    : null;

  // 0. Render background grid
  if (!isExporting && state.gridVisible && state.gridSize > 0) {
    const gridSize = state.gridSize;
    const vp = _vp;
    // Compute visible world-space range
    const startX = Math.floor(vp.minX / gridSize) * gridSize;
    const endX = Math.ceil(vp.maxX / gridSize) * gridSize;
    const startY = Math.floor(vp.minY / gridSize) * gridSize;
    const endY = Math.ceil(vp.maxY / gridSize) * gridSize;

    targetCtx.save();
    // Adapt grid color to background luminance
    const bg = state.bgColor;
    let lum = 0.5;
    if (bg && bg[0] === "#") {
      const hex = bg.length === 4
        ? bg[1]+bg[1]+bg[2]+bg[2]+bg[3]+bg[3]
        : bg.slice(1);
      const r = parseInt(hex.slice(0,2),16)/255;
      const g = parseInt(hex.slice(2,4),16)/255;
      const b = parseInt(hex.slice(4,6),16)/255;
      lum = 0.299*r + 0.587*g + 0.114*b;
    }
    targetCtx.strokeStyle = lum > 0.5 ? "rgba(0, 0, 0, 0.06)" : "rgba(255, 255, 255, 0.07)";
    targetCtx.lineWidth = 1 / transform.zoom;
    targetCtx.beginPath();
    for (let x = startX; x <= endX; x += gridSize) {
      targetCtx.moveTo(x, startY);
      targetCtx.lineTo(x, endY);
    }
    for (let y = startY; y <= endY; y += gridSize) {
      targetCtx.moveTo(startX, y);
      targetCtx.lineTo(endX, y);
    }
    targetCtx.stroke();
    targetCtx.restore();
  }

  // 1. Render all elements in z-order (images and drawings intermixed)
  // PERFORMANCE: Use spatial index to pre-filter visible elements instead of
  // checking viewport intersection for every element individually.
  const zOrderedElements = getElementsInZOrder();
  let visibleSet = null;
  if (_vp && zOrderedElements.length > 50) {
    const vpRect = { minX: _vp.minX, minY: _vp.minY, maxX: _vp.maxX, maxY: _vp.maxY };
    const visibleCandidates = spatialIndex.queryRect(vpRect);
    visibleSet = new Set(visibleCandidates.map(el => el.id));
    // Always include elements being dragged (their spatial index may be stale)
    for (const el of state.selectedElements) visibleSet.add(el.id);
    // Always include crop target
    if (state.cropMode && state.cropTarget) visibleSet.add(state.cropTarget.id);
  }

  // PERFORMANCE: Batch consecutive split lines into single stroke calls.
  // Split lines sharing color+width+opacity are drawn together with one beginPath/stroke.
  let _splitBatch = null; // { color, width, opacity, dash, lines: [{start, end}] }

  function _flushSplitBatch() {
    if (!_splitBatch || _splitBatch.lines.length === 0) return;
    targetCtx.save();
    targetCtx.globalAlpha = _splitBatch.opacity;
    targetCtx.strokeStyle = _splitBatch.color;
    targetCtx.lineWidth = _splitBatch.width;
    targetCtx.lineCap = "round";
    // Apply dash pattern for the batch
    if (_splitBatch.dash && _splitBatch.dash !== "solid") {
      const dashScale = 1 / transform.zoom;
      if (_splitBatch.dash === "dashed") {
        targetCtx.setLineDash([8 * dashScale, 4 * dashScale]);
      } else if (_splitBatch.dash === "dotted") {
        targetCtx.setLineDash([2 * dashScale, 3 * dashScale]);
      } else if (_splitBatch.dash === "dash-dot") {
        targetCtx.setLineDash([8 * dashScale, 3 * dashScale, 2 * dashScale, 3 * dashScale]);
      }
    }
    targetCtx.beginPath();
    for (let i = 0; i < _splitBatch.lines.length; i++) {
      const ln = _splitBatch.lines[i];
      targetCtx.moveTo(ln.start.x, ln.start.y);
      targetCtx.lineTo(ln.end.x, ln.end.y);
    }
    targetCtx.stroke();
    targetCtx.restore();
    _splitBatch = null;
  }

  zOrderedElements.forEach((el) => {
    if (el.elementType === "image") {
      const imgData = el;
      if (_vp && !(state.cropMode && state.cropTarget && state.cropTarget.id === imgData.id)) {
        if (visibleSet) {
          if (!visibleSet.has(imgData.id)) return;
        } else if (!isRectInViewport(imgData.x, imgData.y, imgData.w, imgData.h, _vp)) return;
      }

      targetCtx.save();
      targetCtx.globalAlpha = imgData.opacity != null ? imgData.opacity : 1;
      const drawSrc = !isExporting && state.currentFilter !== "none" ? getFilteredImage(imgData) : imgData.img;

      if (!isExporting && state.cropMode && state.cropTarget && state.cropTarget.id === imgData.id) {
        targetCtx.restore();
        return;
      }

      if (imgData.crop) {
        const cropped = getCroppedImage(imgData, drawSrc);
        if (cropped) {
          targetCtx.drawImage(cropped, imgData.x, imgData.y, imgData.w, imgData.h);
        } else {
          // Fallback if cache creation failed (e.g. tiny crop region)
          const c = imgData.crop;
          const natW = drawSrc.naturalWidth || drawSrc.width;
          const natH = drawSrc.naturalHeight || drawSrc.height;
          targetCtx.drawImage(drawSrc, c.x * natW, c.y * natH, c.w * natW, c.h * natH, imgData.x, imgData.y, imgData.w, imgData.h);
        }
      } else {
        targetCtx.drawImage(drawSrc, imgData.x, imgData.y, imgData.w, imgData.h);
      }
      targetCtx.restore();

      if (!isExporting && state.currentTool === "select" && !state.overlaysHidden && !(state.cropMode && state.cropTarget && state.cropTarget.id === imgData.id)) {
        const isSelected = _selectedIdSet && _selectedIdSet.has(imgData.id);
        const isGrouped = !!imgData.groupId;
        targetCtx.save();
        targetCtx.strokeStyle = isSelected ? (isGrouped ? "#28a745" : "#ff4444") : "#007acc";
        targetCtx.lineWidth = (isSelected ? 3 : 1.5) / transform.zoom;
        if (isGrouped && isSelected) {
          targetCtx.setLineDash([6 / transform.zoom, 3 / transform.zoom]);
        }
        targetCtx.strokeRect(imgData.x, imgData.y, imgData.w, imgData.h);

        if (isSelected && state.selectedElements.length === 1) {
          targetCtx.fillStyle = "#ff4444";
          const hSize = CONSTANTS.RESIZE_HANDLE_SIZE / transform.zoom;
          const handles = getElementResizeHandles(imgData);
          handles.forEach((h) => {
            targetCtx.fillRect(h.x - hSize / 2, h.y - hSize / 2, hSize, hSize);
          });
        }
        targetCtx.restore();
      }

      // Draw lock indicator for locked images
      if (!isExporting && imgData.locked && state.currentTool === "select") {
        drawLockIcon(targetCtx, imgData.x, imgData.y, transform.zoom);
      }
    } else {
      // Drawing / vector / text element
      const shape = el;

      // Skip drawings, split lines, and connectors when overlays are hidden
      if (!isExporting && state.overlaysHidden && (shape.isSplitLine || shape.type === "connector" || shape.elementType === "drawing")) return;

      let shapeBounds;
      if (_vp) {
        if (visibleSet) {
          if (!visibleSet.has(shape.id)) return;
        } else {
          shapeBounds = getShapeBounds(shape);
          if (!isRectInViewport(shapeBounds.x, shapeBounds.y, shapeBounds.w, shapeBounds.h, _vp)) return;
        }
      }

      // PERFORMANCE: Batch split lines into a single stroke call.
      // Split lines that don't need individual selection UI are accumulated
      // and drawn together, avoiding per-element save/beginPath/stroke/restore overhead.
      if (shape.isSplitLine && !shape.locked) {
        const isSelected = !isExporting && state.currentTool === "select" && !state.overlaysHidden &&
          _selectedIdSet && _selectedIdSet.has(shape.id);
        if (!isSelected) {
          const lineWidth = isExporting ? shape.width : shape.width / transform.zoom;
          const opacity = shape.opacity != null ? shape.opacity : 1;
          const dash = shape.dash || "solid";
          // Check if current batch matches; if not, flush and start new batch
          if (_splitBatch && (_splitBatch.color !== shape.color || _splitBatch.width !== lineWidth || _splitBatch.opacity !== opacity || _splitBatch.dash !== dash)) {
            _flushSplitBatch();
          }
          if (!_splitBatch) {
            _splitBatch = { color: shape.color, width: lineWidth, opacity, dash, lines: [] };
          }
          _splitBatch.lines.push({ start: shape.start, end: shape.end });
          return;
        }
        // Selected split line — flush batch, then draw individually with selection UI below
        _flushSplitBatch();
      } else if (_splitBatch) {
        // Non-split-line element encountered — flush any pending batch to preserve z-order
        _flushSplitBatch();
      }

      drawShape(targetCtx, shape, isExporting);
      if (!isExporting && state.currentTool === "select" && !state.overlaysHidden) {
        const isSelected = _selectedIdSet && _selectedIdSet.has(shape.id);
        if (isSelected) {
          const b = shapeBounds || getShapeBounds(shape);
          const isGrouped = !!shape.groupId;
          targetCtx.save();
          targetCtx.strokeStyle = isGrouped ? "#28a745" : "#ff4444";
          targetCtx.lineWidth = 1.5 / transform.zoom;
          targetCtx.setLineDash([4 / transform.zoom, 4 / transform.zoom]);

          if (shape.type === "connector" || shape.type === "line" || shape.type === "arrow" || shape.type === "measure") {
            // No bounding rect for line-like elements
          } else {
            targetCtx.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8);
          }

          if (state.selectedElements.length === 1) {
            const handles = getElementResizeHandles(shape);
            if (shape.type === "connector" || shape.type === "line" || shape.type === "arrow" || shape.type === "measure") {
              const radius = 5 / transform.zoom;
              targetCtx.setLineDash([]);
              targetCtx.fillStyle = "#ffffff";
              targetCtx.strokeStyle = "#ff4444";
              targetCtx.lineWidth = 2 / transform.zoom;
              handles.forEach((h) => {
                targetCtx.beginPath();
                targetCtx.arc(h.x, h.y, radius, 0, Math.PI * 2);
                targetCtx.fill();
                targetCtx.stroke();
              });
            } else {
              targetCtx.fillStyle = "#ff4444";
              const hSize = CONSTANTS.RESIZE_HANDLE_SIZE / transform.zoom;
              handles.forEach((h) => {
                targetCtx.fillRect(h.x - hSize / 2, h.y - hSize / 2, hSize, hSize);
              });
            }
          }
          targetCtx.restore();
        }
      }

      // Draw lock indicator for locked drawings
      if (!isExporting && shape.locked && state.currentTool === "select") {
        const lb = shapeBounds || getShapeBounds(shape);
        drawLockIcon(targetCtx, lb.x, lb.y, transform.zoom);
      }
    }
  });
  // Flush any remaining batched split lines
  _flushSplitBatch();

  // 1.5 Render crop mode overlay (always on top of all elements)
  if (!isExporting && state.cropMode && state.cropTarget && state.cropRect) {
    targetCtx.save();
    const el = state.cropTarget;
    const elOpacity = el.opacity != null ? el.opacity : 1;
    const full = getFullImageBounds(el);
    const drawSrc = state.currentFilter !== "none" ? getFilteredImage(el) : el.img;
    const cropRect = state.cropRect;

    targetCtx.globalAlpha = 0.35 * elOpacity;
    targetCtx.drawImage(drawSrc, full.x, full.y, full.w, full.h);
    targetCtx.globalAlpha = elOpacity;

    const natW = el.img.naturalWidth || el.img.width;
    const natH = el.img.naturalHeight || el.img.height;
    const cropFracX = (cropRect.x - full.x) / full.w;
    const cropFracY = (cropRect.y - full.y) / full.h;
    const cropFracW = cropRect.w / full.w;
    const cropFracH = cropRect.h / full.h;
    targetCtx.drawImage(drawSrc, cropFracX * natW, cropFracY * natH, cropFracW * natW, cropFracH * natH, cropRect.x, cropRect.y, cropRect.w, cropRect.h);

    targetCtx.fillStyle = "rgba(0, 0, 0, 0.45)";
    targetCtx.fillRect(full.x, full.y, full.w, cropRect.y - full.y);
    targetCtx.fillRect(full.x, cropRect.y + cropRect.h, full.w, (full.y + full.h) - (cropRect.y + cropRect.h));
    targetCtx.fillRect(full.x, cropRect.y, cropRect.x - full.x, cropRect.h);
    targetCtx.fillRect(cropRect.x + cropRect.w, cropRect.y, (full.x + full.w) - (cropRect.x + cropRect.w), cropRect.h);

    targetCtx.strokeStyle = "rgba(0, 191, 255, 0.4)";
    targetCtx.lineWidth = 1 / transform.zoom;
    targetCtx.setLineDash([6 / transform.zoom, 4 / transform.zoom]);
    targetCtx.strokeRect(full.x, full.y, full.w, full.h);
    targetCtx.setLineDash([]);

    targetCtx.strokeStyle = "rgba(0, 0, 0, 0.6)";
    targetCtx.lineWidth = 3 / transform.zoom;
    targetCtx.strokeRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
    targetCtx.strokeStyle = "#00bfff";
    targetCtx.lineWidth = 1.5 / transform.zoom;
    targetCtx.strokeRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);

    targetCtx.strokeStyle = "rgba(0, 191, 255, 0.5)";
    targetCtx.lineWidth = 1 / transform.zoom;
    for (let i = 1; i <= 2; i++) {
      const vx = cropRect.x + (cropRect.w * i) / 3;
      targetCtx.beginPath(); targetCtx.moveTo(vx, cropRect.y); targetCtx.lineTo(vx, cropRect.y + cropRect.h); targetCtx.stroke();
      const hy = cropRect.y + (cropRect.h * i) / 3;
      targetCtx.beginPath(); targetCtx.moveTo(cropRect.x, hy); targetCtx.lineTo(cropRect.x + cropRect.w, hy); targetCtx.stroke();
    }

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

    const midpoints = [
      { x: cropRect.x + cropRect.w / 2, y: cropRect.y },
      { x: cropRect.x + cropRect.w / 2, y: cropRect.y + cropRect.h },
      { x: cropRect.x, y: cropRect.y + cropRect.h / 2 },
      { x: cropRect.x + cropRect.w, y: cropRect.y + cropRect.h / 2 },
    ];
    targetCtx.fillStyle = "#00bfff";
    const mSize = 4 / transform.zoom;
    midpoints.forEach((m) => {
      targetCtx.fillRect(m.x - mSize / 2, m.y - mSize / 2, mSize, mSize);
    });

    if (state.cropDragEdge && state.isShiftPressed) {
      targetCtx.strokeStyle = "rgba(255, 180, 0, 0.6)";
      targetCtx.lineWidth = 1 / transform.zoom;
      targetCtx.setLineDash([4 / transform.zoom, 4 / transform.zoom]);
      const fracs = [0.25, 0.5, 0.75];
      fracs.forEach((f) => {
        const gx = full.x + f * full.w;
        targetCtx.beginPath(); targetCtx.moveTo(gx, full.y); targetCtx.lineTo(gx, full.y + full.h); targetCtx.stroke();
        const gy = full.y + f * full.h;
        targetCtx.beginPath(); targetCtx.moveTo(full.x, gy); targetCtx.lineTo(full.x + full.w, gy); targetCtx.stroke();
      });
      targetCtx.setLineDash([]);
    }

    targetCtx.restore();
  }

  // Live preview layer
  if (!isExporting && state.activeShape) {
    drawShape(targetCtx, state.activeShape, false);
  }


  // Laser pointer trails (ephemeral, not persisted)
  if (!isExporting && hasLaserVisuals()) {
    renderLaserTrails(targetCtx, transform.zoom);
  }

  // Live preview for connector arrow being drawn
  if (!isExporting && state.activeConnector) {
    drawShape(targetCtx, state.activeConnector, false);
    if (state.connectorHoverTarget) {
      const b = getElementBounds(state.connectorHoverTarget);
      const ports = [
        { x: b.x + b.w / 2, y: b.y },
        { x: b.x + b.w / 2, y: b.y + b.h },
        { x: b.x, y: b.y + b.h / 2 },
        { x: b.x + b.w, y: b.y + b.h / 2 },
      ];
      const portRadius = 5 / transform.zoom;
      targetCtx.save();
      targetCtx.fillStyle = "#007acc";
      targetCtx.globalAlpha = 0.7;
      for (const p of ports) {
        targetCtx.beginPath();
        targetCtx.arc(p.x, p.y, portRadius, 0, Math.PI * 2);
        targetCtx.fill();
      }
      targetCtx.strokeStyle = "#007acc";
      targetCtx.lineWidth = 2 / transform.zoom;
      targetCtx.setLineDash([4 / transform.zoom, 4 / transform.zoom]);
      targetCtx.strokeRect(b.x, b.y, b.w, b.h);
      targetCtx.restore();
    }
  }

  targetCtx.restore();

  // 2.5 Draw group bounding boxes
  if (!isExporting && state.currentTool === "select" && state.selectedElements.length > 1) {
    targetCtx.save();
    targetCtx.translate(transform.x, transform.y);
    targetCtx.scale(transform.zoom, transform.zoom);
    const groupIds = new Set();
    state.selectedElements.forEach((el) => { if (el.groupId) groupIds.add(el.groupId); });
    groupIds.forEach((gid) => {
      const groupEls = state.selectedElements.filter((el) => el.groupId === gid);
      if (groupEls.length < 2) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      groupEls.forEach((el) => {
        const b = el.elementType === "image" ? { x: el.x, y: el.y, w: el.w, h: el.h } : getShapeBounds(el);
        if (b.x < minX) minX = b.x;
        if (b.y < minY) minY = b.y;
        if (b.x + b.w > maxX) maxX = b.x + b.w;
        if (b.y + b.h > maxY) maxY = b.y + b.h;
      });
      const pad = 8;
      targetCtx.strokeStyle = "rgba(40, 167, 69, 0.7)";
      targetCtx.lineWidth = 2 / transform.zoom;
      targetCtx.setLineDash([8 / transform.zoom, 4 / transform.zoom]);
      targetCtx.strokeRect(minX - pad, minY - pad, maxX - minX + pad * 2, maxY - minY + pad * 2);
    });
    targetCtx.restore();
  }

  // 3. Draw Selection Boxes, snap guides, proximity guides, spacing guides
  if (!isExporting) {
    targetCtx.save();
    targetCtx.translate(transform.x, transform.y);
    targetCtx.scale(transform.zoom, transform.zoom);

    if (state.isRegionSelecting) {
      targetCtx.strokeStyle = "rgba(0, 122, 204, 0.8)";
      targetCtx.fillStyle = "rgba(0, 122, 204, 0.1)";
      targetCtx.lineWidth = 1.5 / transform.zoom;
      targetCtx.setLineDash([6 / transform.zoom, 4 / transform.zoom]);
      const rx = Math.min(state.regionStart.x, state.regionEnd.x);
      const ry = Math.min(state.regionStart.y, state.regionEnd.y);
      const rw = Math.abs(state.regionEnd.x - state.regionStart.x);
      const rh = Math.abs(state.regionEnd.y - state.regionStart.y);
      targetCtx.fillRect(rx, ry, rw, rh);
      targetCtx.strokeRect(rx, ry, rw, rh);
    }

    // Marquee selection overlays
    if (state.marqueeMode) {
      renderMarquee(targetCtx, transform);
    } else if (state.marqueeIsSelecting) {
      renderMarqueeSelecting(targetCtx, transform);
    }

    // Accessibility preview selection rectangle
    if (isAccessibilityPreviewSelecting()) {
      renderAccessibilityPreviewSelection(targetCtx, transform);
    }

    // Eyedropper marquee selection rectangle (drag to analyze colors, persists after drag)
    if (state.eyedropperMarqueeRect && (state.eyedropperMarqueeActive || state.currentTool === "eyedropper")) {
      const rect = state.eyedropperMarqueeRect;
      if (rect.w > 1 || rect.h > 1) {
        const zoom = transform.zoom;
        targetCtx.save();
        targetCtx.fillStyle = "rgba(100, 200, 255, 0.12)";
        targetCtx.fillRect(rect.x, rect.y, rect.w, rect.h);
        targetCtx.strokeStyle = "#fff";
        targetCtx.lineWidth = 1.5 / zoom;
        targetCtx.setLineDash([]);
        targetCtx.strokeRect(rect.x, rect.y, rect.w, rect.h);
        targetCtx.strokeStyle = "#4fc3f7";
        targetCtx.lineWidth = 1.5 / zoom;
        const dashLen = 5 / zoom;
        targetCtx.setLineDash([dashLen, dashLen]);
        targetCtx.strokeRect(rect.x, rect.y, rect.w, rect.h);
        targetCtx.setLineDash([]);
        targetCtx.restore();

        // Highlight pixels matching the hovered color
        if (state.eyedropperHighlightColor && state.eyedropperMarqueePixels && !isExporting) {
          renderEyedropperHighlight(targetCtx, rect, state.eyedropperMarqueePixels, state.eyedropperHighlightColor);
        }
      }
    }

    // Stamp tool live hover preview — ghost of the clipboard over the hovered image
    if (!isExporting && state.currentTool === "stamp" && state.stampPreview &&
        state.stampPreview.elements && state.stampPreview.elements.length > 0) {
      const previewTarget = state.images.find((img) => img.id === state.stampPreview.imageId);
      if (previewTarget) {
        targetCtx.save();
        targetCtx.globalAlpha = 0.5;
        for (const el of state.stampPreview.elements) {
          drawShape(targetCtx, el, false);
        }
        targetCtx.restore();
      }
    }

    // Stamp marquee selection rectangle (while dragging to select area)
    if (state.stampMarqueeActive && state.stampMarqueeRect) {
      const rect = state.stampMarqueeRect;
      if (rect.w > 1 || rect.h > 1) {
        const zoom = transform.zoom;
        targetCtx.save();
        // Semi-transparent fill
        targetCtx.fillStyle = "rgba(255, 140, 0, 0.1)";
        targetCtx.fillRect(rect.x, rect.y, rect.w, rect.h);
        // Solid white border
        targetCtx.strokeStyle = "#fff";
        targetCtx.lineWidth = 1.5 / zoom;
        targetCtx.setLineDash([]);
        targetCtx.strokeRect(rect.x, rect.y, rect.w, rect.h);
        // Dashed orange border
        targetCtx.strokeStyle = "#ff8c00";
        targetCtx.lineWidth = 1.5 / zoom;
        const dashLen = 6 / zoom;
        targetCtx.setLineDash([dashLen, dashLen]);
        targetCtx.strokeRect(rect.x, rect.y, rect.w, rect.h);
        targetCtx.setLineDash([]);
        targetCtx.restore();
      }
    }

    // Snap guides
    if (state.activeSnapGuides.length > 0) {
      targetCtx.save();
      targetCtx.strokeStyle = "rgba(255, 0, 200, 0.8)";
      targetCtx.lineWidth = 1 / transform.zoom;
      targetCtx.setLineDash([4 / transform.zoom, 3 / transform.zoom]);
      const viewBounds = { minX: -transform.x / transform.zoom - 5000, maxX: (-transform.x + canvas.width) / transform.zoom + 5000, minY: -transform.y / transform.zoom - 5000, maxY: (-transform.y + canvas.height) / transform.zoom + 5000 };
      const drawn = new Set();
      state.activeSnapGuides.forEach((g) => {
        const key = g.axis + "_" + g.pos.toFixed(1);
        if (drawn.has(key)) return;
        drawn.add(key);
        targetCtx.beginPath();
        if (g.axis === "x") { targetCtx.moveTo(g.pos, viewBounds.minY); targetCtx.lineTo(g.pos, viewBounds.maxY); }
        else { targetCtx.moveTo(viewBounds.minX, g.pos); targetCtx.lineTo(viewBounds.maxX, g.pos); }
        targetCtx.stroke();
      });
      targetCtx.restore();
    }

    // Proximity guides
    if (state.activeProximityGuides.length > 0 && state.activeSnapGuides.length === 0) {
      targetCtx.save();
      const drawn = new Set();
      state.activeProximityGuides.forEach((g) => {
        const key = g.axis + "_" + g.pos.toFixed(1);
        if (drawn.has(key)) return;
        drawn.add(key);
        const maxRange = 150 / transform.zoom;
        const opacity = Math.max(0.15, 0.7 * (1 - g.dist / maxRange));
        targetCtx.strokeStyle = `rgba(0, 180, 255, ${opacity})`;
        targetCtx.lineWidth = 1 / transform.zoom;
        targetCtx.setLineDash([3 / transform.zoom, 3 / transform.zoom]);
        targetCtx.beginPath();
        if (g.axis === "x") { targetCtx.moveTo(g.pos, g.from); targetCtx.lineTo(g.pos, g.to); }
        else { targetCtx.moveTo(g.from, g.pos); targetCtx.lineTo(g.to, g.pos); }
        targetCtx.stroke();
      });
      targetCtx.restore();
    }

    // Spacing guides
    if (state.activeSpacingGuides.length > 0) {
      targetCtx.save();
      state.activeSpacingGuides.forEach((g) => {
        const isEqual = g.isEqual;
        const color = isEqual ? "rgba(40, 200, 80, 0.9)" : "rgba(255, 90, 90, 0.85)";
        const lineWidth = (isEqual ? 1.5 : 1) / transform.zoom;
        targetCtx.strokeStyle = color;
        targetCtx.fillStyle = color;
        targetCtx.lineWidth = lineWidth;
        targetCtx.setLineDash([]);
        const capSize = 4 / transform.zoom;

        if (g.axis === "x") {
          const y = g.pos, x1 = g.from, x2 = g.to;
          targetCtx.beginPath(); targetCtx.moveTo(x1, y); targetCtx.lineTo(x2, y); targetCtx.stroke();
          targetCtx.beginPath(); targetCtx.moveTo(x1, y - capSize); targetCtx.lineTo(x1, y + capSize); targetCtx.stroke();
          targetCtx.beginPath(); targetCtx.moveTo(x2, y - capSize); targetCtx.lineTo(x2, y + capSize); targetCtx.stroke();
          const dist = Math.round(g.dist);
          const fontSize = Math.max(9, 11 / transform.zoom);
          targetCtx.font = `bold ${fontSize}px sans-serif`;
          targetCtx.textAlign = "center"; targetCtx.textBaseline = "bottom";
          const labelText = `${dist}`;
          const labelMetrics = targetCtx.measureText(labelText);
          const labelW = labelMetrics.width + 4 / transform.zoom;
          const labelH = fontSize + 2 / transform.zoom;
          const labelX = (x1 + x2) / 2;
          const labelY = y - capSize - 2 / transform.zoom;
          targetCtx.fillStyle = isEqual ? "rgba(30, 60, 30, 0.85)" : "rgba(60, 20, 20, 0.85)";
          targetCtx.fillRect(labelX - labelW / 2, labelY - labelH, labelW, labelH);
          targetCtx.fillStyle = "#fff";
          targetCtx.fillText(labelText, labelX, labelY - 1 / transform.zoom);
        } else {
          const x = g.pos, y1 = g.from, y2 = g.to;
          targetCtx.beginPath(); targetCtx.moveTo(x, y1); targetCtx.lineTo(x, y2); targetCtx.stroke();
          targetCtx.beginPath(); targetCtx.moveTo(x - capSize, y1); targetCtx.lineTo(x + capSize, y1); targetCtx.stroke();
          targetCtx.beginPath(); targetCtx.moveTo(x - capSize, y2); targetCtx.lineTo(x + capSize, y2); targetCtx.stroke();
          const dist = Math.round(g.dist);
          const fontSize = Math.max(9, 11 / transform.zoom);
          targetCtx.font = `bold ${fontSize}px sans-serif`;
          targetCtx.textAlign = "left"; targetCtx.textBaseline = "middle";
          const labelText = `${dist}`;
          const labelMetrics = targetCtx.measureText(labelText);
          const labelW = labelMetrics.width + 4 / transform.zoom;
          const labelH = fontSize + 2 / transform.zoom;
          const labelX = x + capSize + 2 / transform.zoom;
          const labelY = (y1 + y2) / 2;
          targetCtx.fillStyle = isEqual ? "rgba(30, 60, 30, 0.85)" : "rgba(60, 20, 20, 0.85)";
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
  if (!isExporting && state.currentTool === "select" && state.selectedElements.length >= 2) {
    targetCtx.save();
    targetCtx.translate(transform.x, transform.y);
    targetCtx.scale(transform.zoom, transform.zoom);
    const radius = getSwapHandleRadius();

    if (state.swapHoveredElement && !state.isSwapDragging) {
      const center = getElementCenter(state.swapHoveredElement);
      targetCtx.beginPath(); targetCtx.arc(center.x, center.y, radius, 0, Math.PI * 2);
      targetCtx.fillStyle = "rgba(100, 100, 255, 0.85)"; targetCtx.fill();
      targetCtx.strokeStyle = "#fff"; targetCtx.lineWidth = 2 / transform.zoom; targetCtx.stroke();
      const iconSize = radius * 0.55;
      targetCtx.strokeStyle = "#fff"; targetCtx.lineWidth = 1.8 / transform.zoom; targetCtx.lineCap = "round"; targetCtx.lineJoin = "round";
      targetCtx.beginPath(); targetCtx.moveTo(center.x - iconSize, center.y - iconSize * 0.35); targetCtx.lineTo(center.x + iconSize * 0.5, center.y - iconSize * 0.35); targetCtx.lineTo(center.x + iconSize * 0.1, center.y - iconSize * 0.75); targetCtx.stroke();
      targetCtx.beginPath(); targetCtx.moveTo(center.x + iconSize, center.y + iconSize * 0.35); targetCtx.lineTo(center.x - iconSize * 0.5, center.y + iconSize * 0.35); targetCtx.lineTo(center.x - iconSize * 0.1, center.y + iconSize * 0.75); targetCtx.stroke();
    }

    if (state.isSwapDragging && state.swapSourceElement && state.swapDragWorldPos) {
      const sourceCenter = getElementCenter(state.swapSourceElement);
      targetCtx.beginPath(); targetCtx.arc(sourceCenter.x, sourceCenter.y, radius, 0, Math.PI * 2);
      targetCtx.fillStyle = "rgba(100, 100, 255, 0.9)"; targetCtx.fill();
      targetCtx.strokeStyle = "#fff"; targetCtx.lineWidth = 2 / transform.zoom; targetCtx.stroke();
      targetCtx.beginPath(); targetCtx.moveTo(sourceCenter.x, sourceCenter.y); targetCtx.lineTo(state.swapDragWorldPos.x, state.swapDragWorldPos.y);
      targetCtx.strokeStyle = "rgba(100, 100, 255, 0.6)"; targetCtx.lineWidth = 2.5 / transform.zoom; targetCtx.setLineDash([6 / transform.zoom, 4 / transform.zoom]); targetCtx.stroke(); targetCtx.setLineDash([]);

      if (state.swapTargetElement) {
        const targetBounds = state.swapTargetElement.elementType === "image" ? { x: state.swapTargetElement.x, y: state.swapTargetElement.y, w: state.swapTargetElement.w, h: state.swapTargetElement.h } : getShapeBounds(state.swapTargetElement);
        targetCtx.strokeStyle = "rgba(100, 100, 255, 0.8)"; targetCtx.lineWidth = 3 / transform.zoom; targetCtx.setLineDash([]);
        targetCtx.strokeRect(targetBounds.x - 4, targetBounds.y - 4, targetBounds.w + 8, targetBounds.h + 8);
        const targetCenter = getElementCenter(state.swapTargetElement);
        targetCtx.beginPath(); targetCtx.arc(targetCenter.x, targetCenter.y, radius, 0, Math.PI * 2);
        targetCtx.fillStyle = "rgba(80, 200, 80, 0.85)"; targetCtx.fill();
        targetCtx.strokeStyle = "#fff"; targetCtx.lineWidth = 2 / transform.zoom; targetCtx.stroke();
        const checkSize = radius * 0.5;
        targetCtx.beginPath(); targetCtx.moveTo(targetCenter.x - checkSize * 0.5, targetCenter.y); targetCtx.lineTo(targetCenter.x - checkSize * 0.1, targetCenter.y + checkSize * 0.4); targetCtx.lineTo(targetCenter.x + checkSize * 0.5, targetCenter.y - checkSize * 0.4);
        targetCtx.strokeStyle = "#fff"; targetCtx.lineWidth = 2 / transform.zoom; targetCtx.lineCap = "round"; targetCtx.lineJoin = "round"; targetCtx.stroke();
      }
    }
    targetCtx.restore();
  }

  // 4. Draw measurement tool overlays
  if (!isExporting && state.currentTool === "measure") {
    targetCtx.save();
    targetCtx.translate(transform.x, transform.y);
    targetCtx.scale(transform.zoom, transform.zoom);
    if (state.activeMeasureLine) {
      if (state.isMetaPressed) {
        // Preview as H+V measurement lines
        const start = state.activeMeasureLine.start;
        const end = state.activeMeasureLine.end;
        const corner = { x: end.x, y: start.y };
        drawMeasureLine(targetCtx, start, corner, "#00bcd4", false);
        drawMeasureLine(targetCtx, corner, end, "#00bcd4", false);
      } else {
        drawMeasureLine(targetCtx, state.activeMeasureLine.start, state.activeMeasureLine.end, "#00bcd4", false);
      }
    }
    if (state.measureHoverGuides.length > 0) {
      state.measureHoverGuides.forEach((g) => {
        const zf = transform.zoom;
        const lineWidth = 1 / zf;
        const capSize = 4 / zf;
        const fontSize = Math.max(9, 10 / zf);
        targetCtx.save();
        targetCtx.strokeStyle = "rgba(0, 188, 212, 0.6)";
        targetCtx.fillStyle = "rgba(0, 188, 212, 0.6)";
        targetCtx.lineWidth = lineWidth;
        targetCtx.setLineDash([3 / zf, 2 / zf]);
        targetCtx.beginPath(); targetCtx.moveTo(g.fromX, g.fromY); targetCtx.lineTo(g.toX, g.toY); targetCtx.stroke();
        targetCtx.setLineDash([]);
        const angle = Math.atan2(g.toY - g.fromY, g.toX - g.fromX);
        const perpX = -Math.sin(angle) * capSize;
        const perpY = Math.cos(angle) * capSize;
        targetCtx.beginPath(); targetCtx.moveTo(g.toX + perpX, g.toY + perpY); targetCtx.lineTo(g.toX - perpX, g.toY - perpY); targetCtx.stroke();
        const midX = (g.fromX + g.toX) / 2;
        const midY = (g.fromY + g.toY) / 2;
        const labelText = `${Math.round(g.dist)}`;
        targetCtx.font = `bold ${fontSize}px sans-serif`;
        targetCtx.textAlign = "center"; targetCtx.textBaseline = "bottom";
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

  // 4b. Draw active contrast line preview during drag
  if (!isExporting && state.currentTool === "contrast" && state.activeContrastLine) {
    targetCtx.save();
    targetCtx.translate(transform.x, transform.y);
    targetCtx.scale(transform.zoom, transform.zoom);
    const s = state.activeContrastLine.start;
    const en = state.activeContrastLine.end;
    const zf = transform.zoom;
    const lineWidth = 2 / zf;

    // Dashed preview line
    targetCtx.strokeStyle = "#e040fb";
    targetCtx.lineWidth = lineWidth;
    targetCtx.lineCap = "round";
    targetCtx.setLineDash([6 / zf, 4 / zf]);
    targetCtx.beginPath();
    targetCtx.moveTo(s.x, s.y);
    targetCtx.lineTo(en.x, en.y);
    targetCtx.stroke();
    targetCtx.setLineDash([]);

    // Endpoint markers
    const markerRadius = 6 / zf;
    targetCtx.fillStyle = "rgba(224, 64, 251, 0.3)";
    targetCtx.strokeStyle = "#e040fb";
    targetCtx.lineWidth = 2 / zf;
    targetCtx.beginPath();
    targetCtx.arc(s.x, s.y, markerRadius, 0, Math.PI * 2);
    targetCtx.fill();
    targetCtx.stroke();
    targetCtx.beginPath();
    targetCtx.arc(en.x, en.y, markerRadius, 0, Math.PI * 2);
    targetCtx.fill();
    targetCtx.stroke();

    targetCtx.restore();
  }

  // 5. Draw split-line tool overlay
  if (!isExporting && state.currentTool === "split-line" && state.splitLineIsDragging && state.splitLineDragRect) {
    // Box (marquee) drag preview: outline the rectangle being swept out.
    const r = state.splitLineDragRect;
    targetCtx.save();
    targetCtx.translate(transform.x, transform.y);
    targetCtx.scale(transform.zoom, transform.zoom);
    const dashScale = 1 / transform.zoom;
    targetCtx.globalAlpha = 0.5;
    targetCtx.strokeStyle = state.drawColor;
    targetCtx.lineWidth = (state.currentLineWidth / 4) / transform.zoom;
    if (state.splitLineDash === "dashed") {
      targetCtx.setLineDash([8 * dashScale, 4 * dashScale]);
    } else if (state.splitLineDash === "dotted") {
      targetCtx.setLineDash([2 * dashScale, 3 * dashScale]);
    } else if (state.splitLineDash === "dash-dot") {
      targetCtx.setLineDash([8 * dashScale, 3 * dashScale, 2 * dashScale, 3 * dashScale]);
    } else {
      targetCtx.setLineDash([]);
    }
    if (state.isCtrlPressed || state.isMetaPressed) {
      // Ctrl/Cmd: preview fixed-size corner marks (these are what get committed)
      // plus faint full-length "helper" lines spanning the gap between corner
      // arms on each edge. The corner arm length mirrors SPLIT_LINE_CORNER_ARM
      // in interaction.js; the helper lines are preview-only (not committed).
      const CORNER_ARM = 48;
      const armX = Math.min(CORNER_ARM, r.w / 2);
      const armY = Math.min(CORNER_ARM, r.h / 2);
      const rl = r.x, rt = r.y, rr = r.x + r.w, rb = r.y + r.h;

      // Faint helper lines: fill the remaining span between the corner arms.
      const prevAlpha = targetCtx.globalAlpha;
      targetCtx.globalAlpha = prevAlpha * 0.4;
      targetCtx.beginPath();
      if (rr - armX > rl + armX) {
        // Top & bottom edges
        targetCtx.moveTo(rl + armX, rt); targetCtx.lineTo(rr - armX, rt);
        targetCtx.moveTo(rl + armX, rb); targetCtx.lineTo(rr - armX, rb);
      }
      if (rb - armY > rt + armY) {
        // Left & right edges
        targetCtx.moveTo(rl, rt + armY); targetCtx.lineTo(rl, rb - armY);
        targetCtx.moveTo(rr, rt + armY); targetCtx.lineTo(rr, rb - armY);
      }
      targetCtx.stroke();
      targetCtx.globalAlpha = prevAlpha;

      // Corner marks (the committed geometry).
      targetCtx.beginPath();
      // Top-left
      targetCtx.moveTo(rl + armX, rt); targetCtx.lineTo(rl, rt); targetCtx.lineTo(rl, rt + armY);
      // Top-right
      targetCtx.moveTo(rr - armX, rt); targetCtx.lineTo(rr, rt); targetCtx.lineTo(rr, rt + armY);
      // Bottom-left
      targetCtx.moveTo(rl + armX, rb); targetCtx.lineTo(rl, rb); targetCtx.lineTo(rl, rb - armY);
      // Bottom-right
      targetCtx.moveTo(rr - armX, rb); targetCtx.lineTo(rr, rb); targetCtx.lineTo(rr, rb - armY);
      targetCtx.stroke();
    } else {
      targetCtx.beginPath();
      targetCtx.rect(r.x, r.y, r.w, r.h);
      targetCtx.stroke();
    }

    // Crosshair guide lines through the current cursor point, spanning the whole
    // visible canvas, shown for the duration of the drag to aid alignment.
    if (state.splitLineWorldPos) {
      const canvas = document.getElementById("canvas");
      const worldLeft = -transform.x / transform.zoom;
      const worldTop = -transform.y / transform.zoom;
      const worldRight = (canvas.width - transform.x) / transform.zoom;
      const worldBottom = (canvas.height - transform.y) / transform.zoom;
      const gx = state.splitLineWorldPos.x;
      const gy = state.splitLineWorldPos.y;
      const boxTop = r.y, boxBottom = r.y + r.h;
      const boxLeft = r.x, boxRight = r.x + r.w;
      targetCtx.globalAlpha = 0.35;
      targetCtx.lineWidth = 1 / transform.zoom;
      targetCtx.setLineDash([4 * dashScale, 4 * dashScale]);
      targetCtx.beginPath();
      // Vertical guide: skip the segment that runs through the box.
      targetCtx.moveTo(gx, worldTop);
      targetCtx.lineTo(gx, boxTop);
      targetCtx.moveTo(gx, boxBottom);
      targetCtx.lineTo(gx, worldBottom);
      // Horizontal guide: skip the segment that runs through the box.
      targetCtx.moveTo(worldLeft, gy);
      targetCtx.lineTo(boxLeft, gy);
      targetCtx.moveTo(boxRight, gy);
      targetCtx.lineTo(worldRight, gy);
      targetCtx.stroke();
    }

    targetCtx.setLineDash([]);
    targetCtx.restore();
  } else if (!isExporting && state.currentTool === "split-line" && state.splitLineWorldPos &&
      (state.splitLineHoveredImage || state.splitLineFullWidth)) {
    targetCtx.save();
    targetCtx.translate(transform.x, transform.y);
    targetCtx.scale(transform.zoom, transform.zoom);

    const pos = state.splitLineWorldPos;
    const lineWidth = (state.currentLineWidth / 4) / transform.zoom;

    // Apply dash pattern to preview
    const dashScale = 1 / transform.zoom;
    targetCtx.globalAlpha = 0.5;
    targetCtx.strokeStyle = state.drawColor;
    targetCtx.lineWidth = lineWidth;
    if (state.splitLineDash === "dashed") {
      targetCtx.setLineDash([8 * dashScale, 4 * dashScale]);
    } else if (state.splitLineDash === "dotted") {
      targetCtx.setLineDash([2 * dashScale, 3 * dashScale]);
    } else if (state.splitLineDash === "dash-dot") {
      targetCtx.setLineDash([8 * dashScale, 3 * dashScale, 2 * dashScale, 3 * dashScale]);
    } else {
      targetCtx.setLineDash([]);
    }

    if (state.splitLineFullWidth) {
      // Full-width mode: line extends across entire visible canvas
      const canvas = document.getElementById("canvas");
      const worldLeft = -transform.x / transform.zoom;
      const worldTop = -transform.y / transform.zoom;
      const worldRight = (canvas.width - transform.x) / transform.zoom;
      const worldBottom = (canvas.height - transform.y) / transform.zoom;

      targetCtx.beginPath();
      if (state.isCtrlPressed) {
        // Both orientations
        let lx = pos.x;
        let ly = pos.y;
        if (state.isShiftPressed && state.splitLineHoveredImage) {
          const img = state.splitLineHoveredImage;
          lx = snapSplitLinePreviewPos(lx, "x", img.x, img.w);
          ly = snapSplitLinePreviewPos(ly, "y", img.y, img.h);
        }
        targetCtx.moveTo(lx, worldTop);
        targetCtx.lineTo(lx, worldBottom);
        targetCtx.moveTo(worldLeft, ly);
        targetCtx.lineTo(worldRight, ly);
      } else {
        const effectiveOrientation = state.isMetaPressed
          ? (state.splitLineOrientation === "vertical" ? "horizontal" : "vertical")
          : state.splitLineOrientation;
        if (effectiveOrientation === "vertical") {
          let lx = pos.x;
          if (state.isShiftPressed && state.splitLineHoveredImage) {
            const img = state.splitLineHoveredImage;
            lx = snapSplitLinePreviewPos(lx, "x", img.x, img.w);
          }
          targetCtx.moveTo(lx, worldTop);
          targetCtx.lineTo(lx, worldBottom);
        } else {
          let ly = pos.y;
          if (state.isShiftPressed && state.splitLineHoveredImage) {
            const img = state.splitLineHoveredImage;
            ly = snapSplitLinePreviewPos(ly, "y", img.y, img.h);
          }
          targetCtx.moveTo(worldLeft, ly);
          targetCtx.lineTo(worldRight, ly);
        }
      }
      targetCtx.stroke();
    } else {
      // Normal mode: line constrained to hovered image
      const img = state.splitLineHoveredImage;

      if (state.isCtrlPressed) {
        // Draw both vertical and horizontal lines when ctrl is held
        let lx = Math.max(img.x, Math.min(pos.x, img.x + img.w));
        let ly = Math.max(img.y, Math.min(pos.y, img.y + img.h));
        if (state.isShiftPressed) {
          lx = snapSplitLinePreviewPos(lx, "x", img.x, img.w);
          ly = snapSplitLinePreviewPos(ly, "y", img.y, img.h);
        }
        // Vertical line
        const v = getSplitLineExtent(img.y, img.h, ly);
        targetCtx.beginPath();
        targetCtx.moveTo(lx, v.start);
        targetCtx.lineTo(lx, v.end);
        targetCtx.stroke();
        // Horizontal line
        const h = getSplitLineExtent(img.x, img.w, lx);
        targetCtx.beginPath();
        targetCtx.moveTo(h.start, ly);
        targetCtx.lineTo(h.end, ly);
        targetCtx.stroke();
      } else if (state.isMetaPressed) {
        // Draw line in the opposite orientation when meta is held
        targetCtx.beginPath();
        if (state.splitLineOrientation === "vertical") {
          // Opposite: horizontal
          let ly = Math.max(img.y, Math.min(pos.y, img.y + img.h));
          if (state.isShiftPressed) ly = snapSplitLinePreviewPos(ly, "y", img.y, img.h);
          let h = getSplitLineExtent(img.x, img.w, pos.x);
          if (state.isShiftPressed) h = trimSplitLineExtentAtCrossings("horizontal", ly, pos.x, h);
          targetCtx.moveTo(h.start, ly);
          targetCtx.lineTo(h.end, ly);
        } else {
          // Opposite: vertical
          let lx = Math.max(img.x, Math.min(pos.x, img.x + img.w));
          if (state.isShiftPressed) lx = snapSplitLinePreviewPos(lx, "x", img.x, img.w);
          let v = getSplitLineExtent(img.y, img.h, pos.y);
          if (state.isShiftPressed) v = trimSplitLineExtentAtCrossings("vertical", lx, pos.y, v);
          targetCtx.moveTo(lx, v.start);
          targetCtx.lineTo(lx, v.end);
        }
        targetCtx.stroke();
      } else {
        targetCtx.beginPath();
        if (state.splitLineOrientation === "vertical") {
          let lx = Math.max(img.x, Math.min(pos.x, img.x + img.w));
          if (state.isShiftPressed) lx = snapSplitLinePreviewPos(lx, "x", img.x, img.w);
          let v = getSplitLineExtent(img.y, img.h, pos.y);
          if (state.isShiftPressed) v = trimSplitLineExtentAtCrossings("vertical", lx, pos.y, v);
          targetCtx.moveTo(lx, v.start);
          targetCtx.lineTo(lx, v.end);
        } else {
          let ly = Math.max(img.y, Math.min(pos.y, img.y + img.h));
          if (state.isShiftPressed) ly = snapSplitLinePreviewPos(ly, "y", img.y, img.h);
          let h = getSplitLineExtent(img.x, img.w, pos.x);
          if (state.isShiftPressed) h = trimSplitLineExtentAtCrossings("horizontal", ly, pos.x, h);
          targetCtx.moveTo(h.start, ly);
          targetCtx.lineTo(h.end, ly);
        }
        targetCtx.stroke();
      }
    }

    targetCtx.setLineDash([]);

    targetCtx.restore();
  }



  if (!isExporting && textEditor.style.display === "block" && state.activeTextCoord) {
    const screenPos = worldToScreen(state.activeTextCoord.x, state.activeTextCoord.y);
    textEditor.style.left = `${screenPos.x}px`;
    textEditor.style.top = `${screenPos.y - state.currentFontSize * transform.zoom * 0.2}px`;
    textEditor.style.fontSize = `${state.currentFontSize * transform.zoom}px`;
  }
}

export async function executePNGExport(scaleFactor = 1.0, { download = false, padding } = {}) {
  return executeImageExport(scaleFactor, { download, format: "png", padding });
}

export async function executeJPEGExport(scaleFactor = 1.0, { download = false, quality = 0.92, padding } = {}) {
  return executeImageExport(scaleFactor, { download, format: "jpeg", quality, padding });
}

async function executeImageExport(scaleFactor = 1.0, { download = false, format = "png", quality = 0.92, padding: customPadding } = {}) {
  const { showToast } = await import("./utils.js");
  const exportingSelection = state.selectedElements.length > 0;
  const formatLabel = format === "jpeg" ? "JPEG" : "PNG";
  const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
  const fileExt = format === "jpeg" ? "jpg" : "png";

  if (!exportingSelection && state.images.length === 0 && state.drawings.length === 0 && !hasLaserVisuals()) {
    showToast("Canvas is completely empty!");
    return;
  }

  let bounds;
  let exportElements;

  if (exportingSelection) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    state.selectedElements.forEach((el) => {
      if (el.elementType === "image") {
        if (el.x < minX) minX = el.x;
        if (el.y < minY) minY = el.y;
        if (el.x + el.w > maxX) maxX = el.x + el.w;
        if (el.y + el.h > maxY) maxY = el.y + el.h;
      } else {
        const b = getShapeBounds(el);
        if (b.x < minX) minX = b.x;
        if (b.y < minY) minY = b.y;
        if (b.x + b.w > maxX) maxX = b.x + b.w;
        if (b.y + b.h > maxY) maxY = b.y + b.h;
      }
    });
    // Include laser trails in selection export bounds
    state.laserTrails.forEach((trail) => {
      if (trail.type === "dot") {
        if (trail.x < minX) minX = trail.x;
        if (trail.y < minY) minY = trail.y;
        if (trail.x > maxX) maxX = trail.x;
        if (trail.y > maxY) maxY = trail.y;
      } else if (trail.type === "stroke" && trail.points) {
        trail.points.forEach((p) => {
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        });
      }
    });
    if (state.laserActiveStroke && state.laserActiveStroke.points) {
      state.laserActiveStroke.points.forEach((p) => {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      });
    }
    const padding = customPadding != null ? customPadding : 50;
    bounds = { minX: minX - padding, minY: minY - padding, maxX: maxX + padding, maxY: maxY + padding };
    // Filter z-ordered elements to only those selected
    const selectedIds = new Set(state.selectedElements.map(e => e.id));
    exportElements = getElementsInZOrder().filter(e => selectedIds.has(e.id));
  } else {
    bounds = getCanvasContentBounds(customPadding);
    exportElements = getElementsInZOrder();
  }

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
    showToast(`Canvas too large — exporting at ${Math.round(effectiveScale * 100)}% scale`);
  }

  const finalCanvas = document.createElement("canvas");
  finalCanvas.width = exportW;
  finalCanvas.height = exportH;
  const finalCtx = finalCanvas.getContext("2d");
  finalCtx.fillStyle = state.bgColor;
  finalCtx.fillRect(0, 0, exportW, exportH);
  finalCtx.save();
  finalCtx.scale(effectiveScale, effectiveScale);
  finalCtx.translate(-bounds.minX, -bounds.minY);
  exportElements.forEach((el) => {
    if (el.elementType === "image") {
      finalCtx.save();
      finalCtx.globalAlpha = el.opacity != null ? el.opacity : 1;
      const drawSrc = state.currentFilter !== "none" ? getFilteredImage(el) : el.img;
      if (el.crop) {
        const c = el.crop;
        const natW = el.img.naturalWidth || el.img.width;
        const natH = el.img.naturalHeight || el.img.height;
        finalCtx.drawImage(drawSrc, c.x * natW, c.y * natH, c.w * natW, c.h * natH, el.x, el.y, el.w, el.h);
      } else {
        finalCtx.drawImage(drawSrc, el.x, el.y, el.w, el.h);
      }
      finalCtx.restore();
    } else {
      drawShape(finalCtx, el, true, effectiveScale);
    }
  });

  // Render laser pointer trails into the export
  if (hasLaserVisuals()) {
    renderLaserTrailsForExport(finalCtx);
  }

  finalCtx.restore();

  const blobArgs = format === "jpeg" ? [mimeType, quality] : [mimeType];
  finalCanvas.toBlob(async (blob) => {
    if (!blob) { showToast("Failed to compile image asset"); return; }
    if (download) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const now = new Date(); const dtPrefix = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
      a.href = url; a.download = `${dtPrefix}_canvas_export.${fileExt}`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
      if (exportingSelection) {
        showToast(scaleFactor === 0.5 ? `Selection (${state.selectedElements.length}) downloaded at 50%!` : `Selection (${state.selectedElements.length}) downloaded as ${formatLabel}!`);
      } else {
        showToast(scaleFactor === 0.5 ? `50% scale ${formatLabel} downloaded!` : `Full scale ${formatLabel} downloaded!`);
      }
      return;
    }
    try {
      // Clipboard API requires image/png; for JPEG we convert to PNG for clipboard copy
      const clipBlob = format === "jpeg" ? blob : blob;
      const clipMime = format === "jpeg" ? mimeType : "image/png";
      // Note: Most browsers only support image/png in clipboard. For JPEG, fallback to download.
      if (format === "jpeg") {
        // JPEG cannot be written to clipboard in most browsers, so download instead
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const now2 = new Date(); const dtPrefix2 = `${now2.getFullYear()}-${String(now2.getMonth()+1).padStart(2,'0')}-${String(now2.getDate()).padStart(2,'0')}_${String(now2.getHours()).padStart(2,'0')}${String(now2.getMinutes()).padStart(2,'0')}${String(now2.getSeconds()).padStart(2,'0')}`;
        a.href = url; a.download = `${dtPrefix2}_canvas_export.${fileExt}`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
        showToast(`Downloaded ${formatLabel} file`);
        return;
      }
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      state.internalCopyPerformed = false;
      if (exportingSelection) {
        showToast(scaleFactor === 0.5 ? `Selection (${state.selectedElements.length}) copied at 50%!` : `Selection (${state.selectedElements.length}) copied as ${formatLabel}!`);
      } else {
        showToast(scaleFactor === 0.5 ? `50% scale ${formatLabel} copied!` : `Full scale ${formatLabel} copied!`);
      }
    } catch (err) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const now2 = new Date(); const dtPrefix2 = `${now2.getFullYear()}-${String(now2.getMonth()+1).padStart(2,'0')}-${String(now2.getDate()).padStart(2,'0')}_${String(now2.getHours()).padStart(2,'0')}${String(now2.getMinutes()).padStart(2,'0')}${String(now2.getSeconds()).padStart(2,'0')}`;
      a.href = url; a.download = `${dtPrefix2}_canvas_export.${fileExt}`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
      showToast(`Downloaded ${formatLabel} File`);
    }
  }, ...blobArgs);
}

function getCanvasContentBounds(customPadding) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  function expandBounds(x, y) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  state.images.forEach((img) => {
    expandBounds(img.x, img.y);
    expandBounds(img.x + img.w, img.y + img.h);
  });
  state.drawings.forEach((shape) => {
    const b = getShapeBounds(shape);
    expandBounds(b.x, b.y);
    expandBounds(b.x + b.w, b.y + b.h);
  });
  // Include laser pointer trails in bounds
  state.laserTrails.forEach((trail) => {
    if (trail.type === "dot") {
      expandBounds(trail.x, trail.y);
    } else if (trail.type === "stroke" && trail.points) {
      trail.points.forEach((p) => {
        expandBounds(p.x, p.y);
      });
    }
  });
  if (state.laserActiveStroke && state.laserActiveStroke.points) {
    state.laserActiveStroke.points.forEach((p) => {
      expandBounds(p.x, p.y);
    });
  }
  const padding = customPadding != null ? customPadding : 100;
  return { minX: minX - padding, minY: minY - padding, maxX: maxX + padding, maxY: maxY + padding };
}
