/**
 * Filter Preview Mode
 *
 * Full-screen overlay that renders every canvas image with all available
 * color filters applied simultaneously. Navigate between images using
 * left/right arrow keys. Activated from the toolbar button.
 *
 * Flagging: Click a filtered preview to flag it (via the flag button).
 * Flagged images are placed on the canvas when the preview is closed.
 *
 * Drawing: Use the same tools as in the main canvas (pen, line, arrow,
 * rect-border, rect-fill, text, eraser). Drawings are stored per cell
 * and baked into flagged images on exit.
 */

import { state, spatialInsert } from "./state.js";
import { FILTER_OPTIONS, FILTER_LABELS } from "./color-filter.js";
import { applyFilterToImageData } from "./filter-kernels.js";
import { render } from "./rendering.js";
import { pushUndo } from "./history.js";
import { scheduleSave } from "./persistence.js";

// --- Preview state ---
let isActive = false;
let currentIndex = 0;
let keyHandler = null;
let currentTool = "select";
let currentColor = "#ff3333";
let currentLineWidth = 4;

/** The subset of images being previewed (selected or all) */
let previewImages = [];

/** Preview zoom level (controls max-width of cells) */
let previewZoom = 1.0;

/**
 * @typedef {Object} FlaggedItem
 * @property {object} sourceImg
 * @property {string} filter
 * @property {HTMLCanvasElement} baseCanvas
 * @property {string} drawKey
 */
/** @type {FlaggedItem[]} */
let flaggedItems = [];

/**
 * Persistent shape storage per cell.
 * Key: `${sourceImgId}_${filter}` → Array of shape objects
 */
const cellShapes = new Map();

// --- DOM refs ---
let overlay, grid, counter, title, closeBtn, prevBtn, nextBtn, previewToolbar;

function getDomRefs() {
  if (overlay) return;
  overlay = document.getElementById("filter-preview-overlay");
  grid = document.getElementById("filter-preview-grid");
  counter = document.getElementById("filter-preview-counter");
  title = document.getElementById("filter-preview-title");
  closeBtn = document.getElementById("filter-preview-close");
  prevBtn = document.getElementById("filter-preview-prev");
  nextBtn = document.getElementById("filter-preview-next");
  previewToolbar = document.getElementById("filter-preview-toolbar");
}

// --- Helpers ---

function getCellKey(sourceImg, filter) {
  return `${sourceImg.id}_${filter}`;
}

function getShapes(sourceImg, filter) {
  const key = getCellKey(sourceImg, filter);
  if (!cellShapes.has(key)) cellShapes.set(key, []);
  return cellShapes.get(key);
}

// --- Shape rendering (mirrors main canvas rendering.js) ---

function renderShape(ctx, shape) {
  ctx.save();
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;
  ctx.lineWidth = shape.lineWidth || currentLineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (shape.type === "pen") {
    if (!shape.points || shape.points.length < 2) { ctx.restore(); return; }
    ctx.beginPath();
    ctx.moveTo(shape.points[0].x, shape.points[0].y);
    for (let i = 1; i < shape.points.length; i++) {
      ctx.lineTo(shape.points[i].x, shape.points[i].y);
    }
    ctx.stroke();
  } else if (shape.type === "line") {
    ctx.beginPath();
    ctx.moveTo(shape.start.x, shape.start.y);
    ctx.lineTo(shape.end.x, shape.end.y);
    ctx.stroke();
  } else if (shape.type === "arrow") {
    const dx = shape.end.x - shape.start.x;
    const dy = shape.end.y - shape.start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0.1) {
      const ux = dx / len;
      const uy = dy / len;
      const lw = shape.lineWidth || currentLineWidth;
      const headLength = Math.max(16, lw * 3.5);
      const headWidth = Math.max(10, lw * 2.2);
      const cx = shape.end.x - headLength * ux;
      const cy = shape.end.y - headLength * uy;
      const nx = -uy * headWidth;
      const ny = ux * headWidth;

      ctx.beginPath();
      ctx.moveTo(shape.start.x, shape.start.y);
      ctx.lineTo(cx, cy);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(shape.end.x, shape.end.y);
      ctx.lineTo(cx + nx, cy + ny);
      ctx.lineTo(cx - nx, cy - ny);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(shape.start.x, shape.start.y);
      ctx.lineTo(shape.end.x, shape.end.y);
      ctx.stroke();
    }
  } else if (shape.type === "rect-border") {
    ctx.strokeRect(shape.start.x, shape.start.y, shape.end.x - shape.start.x, shape.end.y - shape.start.y);
  } else if (shape.type === "rect-fill") {
    ctx.fillRect(shape.start.x, shape.start.y, shape.end.x - shape.start.x, shape.end.y - shape.start.y);
  } else if (shape.type === "text") {
    const fontSize = shape.fontSize || 24;
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textBaseline = "top";
    const lineHeight = fontSize * 1.2;
    const lines = shape.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], shape.start.x, shape.start.y + i * lineHeight);
    }
  }

  ctx.restore();
}

function renderAllShapes(ctx, shapes) {
  for (const shape of shapes) {
    renderShape(ctx, shape);
  }
}

// --- Filtered image rendering ---

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
 * Composite: filtered base + shapes → single canvas
 */
function compositeCell(img, filter, sourceImg) {
  const baseCanvas = renderFilteredCanvas(img, filter);
  const shapes = getShapes(sourceImg, filter);
  if (shapes.length > 0) {
    const ctx = baseCanvas.getContext("2d");
    renderAllShapes(ctx, shapes);
  }
  return baseCanvas;
}

// --- Flagging ---

function isFlagged(sourceImg, filter) {
  return flaggedItems.some((f) => f.sourceImg === sourceImg && f.filter === filter);
}

function toggleFlag(sourceImg, filter, cell, flagBtn) {
  const idx = flaggedItems.findIndex((f) => f.sourceImg === sourceImg && f.filter === filter);
  if (idx >= 0) {
    flaggedItems.splice(idx, 1);
    cell.classList.remove("filter-preview-cell-flagged");
    flagBtn.textContent = "Flag";
  } else {
    const key = getCellKey(sourceImg, filter);
    flaggedItems.push({ sourceImg, filter, drawKey: key });
    cell.classList.add("filter-preview-cell-flagged");
    flagBtn.textContent = "Unflag";
  }
  updateFlagCount();
}

function updateFlagCount() {
  const badge = document.getElementById("filter-preview-flag-count");
  if (badge) {
    badge.textContent = flaggedItems.length > 0 ? `${flaggedItems.length} flagged` : "";
  }
}

// --- Inline text editor state ---
let activeTextEditor = null; // { el, sourceImg, filter, pos, redraw, ensureFlagged }

function commitTextEditor() {
  if (!activeTextEditor) return;
  const { el, sourceImg, filter, pos, redraw, ensureFlagged } = activeTextEditor;
  const text = el.innerText.trim();
  if (text) {
    const shapes = getShapes(sourceImg, filter);
    const fontSize = Math.max(16, Math.round((sourceImg.img.naturalWidth || sourceImg.img.width) / 40));
    shapes.push({
      type: "text",
      text,
      start: { x: pos.x, y: pos.y },
      color: currentColor,
      fontSize,
      lineWidth: currentLineWidth,
    });
    ensureFlagged();
    redraw();
  }
  el.remove();
  activeTextEditor = null;
}

function dismissTextEditor() {
  if (!activeTextEditor) return;
  activeTextEditor.el.remove();
  activeTextEditor = null;
}

function showTextEditor(displayCanvas, sourceImg, filter, pos, redraw, ensureFlagged) {
  // Commit any existing editor first
  commitTextEditor();

  const cell = displayCanvas.closest(".filter-preview-cell");
  const rect = displayCanvas.getBoundingClientRect();
  const imgW = displayCanvas.width;
  const imgH = displayCanvas.height;
  const scaleX = rect.width / imgW;
  const scaleY = rect.height / imgH;

  const el = document.createElement("div");
  el.contentEditable = "true";
  el.className = "filter-preview-text-editor";
  el.style.position = "absolute";
  el.style.left = `${rect.left + pos.x * scaleX}px`;
  el.style.top = `${rect.top + pos.y * scaleY}px`;
  const fontSize = Math.max(16, Math.round(imgW / 40));
  el.style.fontSize = `${fontSize * scaleY}px`;
  el.style.color = currentColor;
  el.style.lineHeight = "1.2";
  el.dataset.placeholder = "Type here...";

  // Commit on blur or Escape; keep typing on Enter
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismissTextEditor();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      commitTextEditor();
    }
    // Don't let tool hotkeys fire while typing
    e.stopPropagation();
  });

  el.addEventListener("blur", () => {
    // Small delay so clicking away works
    setTimeout(() => {
      if (activeTextEditor && activeTextEditor.el === el) {
        commitTextEditor();
      }
    }, 100);
  });

  overlay.appendChild(el);
  activeTextEditor = { el, sourceImg, filter, pos, redraw, ensureFlagged };
  setTimeout(() => el.focus(), 20);
}

// --- Cell interaction (drawing tools + move + eraser) ---

function setupCellInteraction(displayCanvas, sourceImg, filter, redraw) {
  const imgW = displayCanvas.width;
  const imgH = displayCanvas.height;
  let activeShape = null;
  let movingShape = null;
  let moveOffset = { x: 0, y: 0 };

  function getPos(e) {
    const rect = displayCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (imgW / rect.width),
      y: (e.clientY - rect.top) * (imgH / rect.height),
    };
  }

  /** Auto-flag this cell if not already flagged */
  function ensureFlagged() {
    if (!isFlagged(sourceImg, filter)) {
      const cell = displayCanvas.closest(".filter-preview-cell");
      const flagBtn = cell ? cell.querySelector(".filter-preview-flag-btn") : null;
      if (cell && flagBtn) {
        toggleFlag(sourceImg, filter, cell, flagBtn);
      }
    }
  }

  displayCanvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    displayCanvas.setPointerCapture(e.pointerId);

    const pos = getPos(e);
    const shapes = getShapes(sourceImg, filter);

    // --- Select/Move tool ---
    if (currentTool === "select") {
      // Find topmost shape under cursor
      for (let i = shapes.length - 1; i >= 0; i--) {
        if (hitTestShape(shapes[i], pos)) {
          movingShape = shapes[i];
          moveOffset = getShapeOrigin(movingShape);
          moveOffset = { x: pos.x - moveOffset.x, y: pos.y - moveOffset.y };
          return;
        }
      }
      // No shape hit — toggle flag on click
      const cell = displayCanvas.closest(".filter-preview-cell");
      const flagBtn = cell ? cell.querySelector(".filter-preview-flag-btn") : null;
      if (cell && flagBtn) {
        toggleFlag(sourceImg, filter, cell, flagBtn);
      }
      return;
    }

    // --- Eraser tool ---
    if (currentTool === "eraser") {
      for (let i = shapes.length - 1; i >= 0; i--) {
        if (hitTestShape(shapes[i], pos)) {
          shapes.splice(i, 1);
          redraw();
          return;
        }
      }
      return;
    }

    // --- Text tool ---
    if (currentTool === "text") {
      showTextEditor(displayCanvas, sourceImg, filter, pos, redraw, ensureFlagged);
      return;
    }

    // --- Drawing tools ---
    if (currentTool === "pen") {
      activeShape = {
        type: "pen",
        points: [{ x: pos.x, y: pos.y }],
        color: currentColor,
        lineWidth: currentLineWidth,
      };
    } else {
      activeShape = {
        type: currentTool,
        start: { x: pos.x, y: pos.y },
        end: { x: pos.x, y: pos.y },
        color: currentColor,
        lineWidth: currentLineWidth,
      };
    }

    shapes.push(activeShape);
    ensureFlagged();
  });

  displayCanvas.addEventListener("pointermove", (e) => {
    const pos = getPos(e);

    // Moving a shape
    if (movingShape) {
      e.stopPropagation();
      e.preventDefault();
      moveShapeTo(movingShape, pos.x - moveOffset.x, pos.y - moveOffset.y);
      redraw();
      return;
    }

    // Drawing
    if (!activeShape) return;
    e.stopPropagation();
    e.preventDefault();

    if (activeShape.type === "pen") {
      activeShape.points.push({ x: pos.x, y: pos.y });
    } else {
      activeShape.end = { x: pos.x, y: pos.y };
    }
    redraw();
  });

  const endInteraction = (e) => {
    if (movingShape) {
      e.stopPropagation();
      movingShape = null;
      redraw();
      return;
    }
    if (!activeShape) return;
    e.stopPropagation();
    activeShape = null;
    redraw();
  };

  displayCanvas.addEventListener("pointerup", endInteraction);
  displayCanvas.addEventListener("pointercancel", endInteraction);
}

// --- Shape origin / move helpers ---

function getShapeOrigin(shape) {
  if (shape.type === "pen") {
    return { x: shape.points[0].x, y: shape.points[0].y };
  }
  return { x: shape.start.x, y: shape.start.y };
}

function moveShapeTo(shape, x, y) {
  if (shape.type === "pen") {
    const origin = shape.points[0];
    const dx = x - origin.x;
    const dy = y - origin.y;
    for (const p of shape.points) {
      p.x += dx;
      p.y += dy;
    }
  } else {
    const dx = x - shape.start.x;
    const dy = y - shape.start.y;
    shape.start.x += dx;
    shape.start.y += dy;
    if (shape.end) {
      shape.end.x += dx;
      shape.end.y += dy;
    }
  }
}

// --- Hit testing (used by eraser and move tool) ---

function hitTestShape(shape, pos) {
  const threshold = 14;

  if (shape.type === "pen") {
    // Check distance to each segment
    for (let i = 1; i < shape.points.length; i++) {
      if (distToSegment(pos, shape.points[i - 1], shape.points[i]) < threshold) return true;
    }
    // Also check single-point pens
    if (shape.points.length === 1) {
      const p = shape.points[0];
      return Math.abs(p.x - pos.x) < threshold && Math.abs(p.y - pos.y) < threshold;
    }
    return false;
  }

  if (shape.type === "text") {
    const fontSize = shape.fontSize || 24;
    const estW = shape.text.length * fontSize * 0.6;
    return pos.x >= shape.start.x - 4 && pos.x <= shape.start.x + estW + 4 &&
           pos.y >= shape.start.y - 4 && pos.y <= shape.start.y + fontSize + 4;
  }

  if (shape.type === "line" || shape.type === "arrow") {
    return distToSegment(pos, shape.start, shape.end) < threshold;
  }

  if (shape.type === "rect-border" || shape.type === "rect-fill") {
    const minX = Math.min(shape.start.x, shape.end.x);
    const maxX = Math.max(shape.start.x, shape.end.x);
    const minY = Math.min(shape.start.y, shape.end.y);
    const maxY = Math.max(shape.start.y, shape.end.y);

    if (shape.type === "rect-fill") {
      // Point inside filled rect
      return pos.x >= minX - 4 && pos.x <= maxX + 4 && pos.y >= minY - 4 && pos.y <= maxY + 4;
    }
    // For border rect, check proximity to edges
    const nearTop = distToSegment(pos, { x: minX, y: minY }, { x: maxX, y: minY }) < threshold;
    const nearBottom = distToSegment(pos, { x: minX, y: maxY }, { x: maxX, y: maxY }) < threshold;
    const nearLeft = distToSegment(pos, { x: minX, y: minY }, { x: minX, y: maxY }) < threshold;
    const nearRight = distToSegment(pos, { x: maxX, y: minY }, { x: maxX, y: maxY }) < threshold;
    return nearTop || nearBottom || nearLeft || nearRight;
  }

  return false;
}

/**
 * Distance from point p to line segment (a, b).
 */
function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.sqrt((p.x - a.x) ** 2 + (p.y - a.y) ** 2);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.sqrt((p.x - projX) ** 2 + (p.y - projY) ** 2);
}

// --- Grid rendering ---

function renderGrid(index) {
  if (previewImages.length === 0) return;

  currentIndex = Math.max(0, Math.min(index, previewImages.length - 1));
  const imgEl = previewImages[currentIndex];

  const name = imgEl.fileName || imgEl.name || `Image ${currentIndex + 1}`;
  title.textContent = name;
  counter.textContent = `${currentIndex + 1} / ${previewImages.length}`;

  grid.innerHTML = "";

  const imgW = imgEl.img.naturalWidth || imgEl.img.width;
  const imgH = imgEl.img.naturalHeight || imgEl.img.height;

  for (const filter of FILTER_OPTIONS) {
    const cell = document.createElement("div");
    cell.className = "filter-preview-cell";
    if (isFlagged(imgEl, filter)) cell.classList.add("filter-preview-cell-flagged");

    // Display canvas
    const displayCanvas = document.createElement("canvas");
    displayCanvas.width = imgW;
    displayCanvas.height = imgH;
    displayCanvas.style.cursor = getCursorForTool();
    cell.appendChild(displayCanvas);

    // Redraw function for this cell
    const redraw = () => {
      const ctx = displayCanvas.getContext("2d");
      ctx.clearRect(0, 0, imgW, imgH);
      // Draw filtered base
      const base = renderFilteredCanvas(imgEl.img, filter);
      ctx.drawImage(base, 0, 0);
      // Draw shapes
      renderAllShapes(ctx, getShapes(imgEl, filter));
    };

    // Initial draw
    redraw();

    // Setup interaction
    setupCellInteraction(displayCanvas, imgEl, filter, redraw);

    // Footer with label + flag button
    const footer = document.createElement("div");
    footer.className = "filter-preview-cell-footer";

    const label = document.createElement("span");
    label.className = "filter-preview-cell-label";
    label.textContent = FILTER_LABELS[filter] || filter;
    footer.appendChild(label);

    const flagBtn = document.createElement("button");
    flagBtn.className = "filter-preview-flag-btn";
    flagBtn.textContent = isFlagged(imgEl, filter) ? "Unflag" : "Flag";
    flagBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFlag(imgEl, filter, cell, flagBtn);
    });
    footer.appendChild(flagBtn);

    cell.appendChild(footer);
    grid.appendChild(cell);
  }

  applyPreviewZoom();
}

// --- Navigation ---

function goNext() {
  if (previewImages.length === 0) return;
  commitTextEditor();
  renderGrid((currentIndex + 1) % previewImages.length);
}

function goPrev() {
  if (previewImages.length === 0) return;
  commitTextEditor();
  renderGrid((currentIndex - 1 + previewImages.length) % previewImages.length);
}

// --- Place flagged images on canvas ---

function placeFlaggedImages() {
  if (flaggedItems.length === 0) return;

  pushUndo();

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
  startY += 60;

  let offsetX = 0;
  const gap = 40;

  for (const item of flaggedItems) {
    const finalCanvas = compositeCell(item.sourceImg.img, item.filter, item.sourceImg);
    const w = finalCanvas.width;
    const h = finalCanvas.height;

    const img = new Image();
    img.width = w;
    img.height = h;
    img.src = finalCanvas.toDataURL("image/png");

    const newImg = {
      id: "img_" + state.elementIdCounter++,
      elementType: "image",
      img,
      x: offsetX,
      y: startY,
      w,
      h,
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

// --- Toolbar ---

function updateToolbarActiveState() {
  if (!previewToolbar) return;
  previewToolbar.querySelectorAll(".filter-preview-tool-btn:not(.filter-preview-width-btn)").forEach((btn) => {
    if (btn.dataset.tool === currentTool) btn.classList.add("active");
    else btn.classList.remove("active");
  });
}

function getCursorForTool() {
  if (currentTool === "select") return "default";
  if (currentTool === "eraser") return "pointer";
  if (currentTool === "text") return "text";
  return "crosshair";
}

function updateCellCursors() {
  if (!grid) return;
  const cursor = getCursorForTool();
  grid.querySelectorAll("canvas").forEach((c) => { c.style.cursor = cursor; });
}

const TOOL_ICONS = {
  select: `<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M7 2l12 11.2-5.3.7 3.5 6.6-2.5 1.3-3.6-6.6-4.1 3.5V2z"/></svg>`,
  pen: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg>`,
  line: `<svg fill="currentColor" viewBox="0 0 24 24" width="20" height="20"><path d="M4 20L20 4l1.5 1.5L5.5 21.5z"/></svg>`,
  arrow: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 13V19H13"/><path d="M5 5L19 19"/></svg>`,
  "rect-border": `<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14z"/></svg>`,
  "rect-fill": `<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/></svg>`,
  text: `<svg fill="currentColor" viewBox="0 0 24 24" width="20" height="20"><path d="M5 4v3h5.5v12h3V7H19V4H5z"/></svg>`,
  eraser: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21"/><path d="m5.082 11.09 8.828 8.828"/></svg>`,
};

function buildPreviewToolbar() {
  getDomRefs();
  if (!previewToolbar) return;

  previewToolbar.innerHTML = "";

  const tools = [
    { id: "select", label: "Select/Move [V]" },
    { id: "pen", label: "Pen [B]" },
    { id: "line", label: "Line [L]" },
    { id: "arrow", label: "Arrow [A]" },
    { id: "rect-border", label: "Box Border [R]" },
    { id: "rect-fill", label: "Box Fill [F]" },
    { id: "text", label: "Text [T]" },
    { id: "eraser", label: "Eraser [E]" },
  ];

  for (const tool of tools) {
    const btn = document.createElement("button");
    btn.className = "filter-preview-tool-btn";
    btn.dataset.tool = tool.id;
    if (tool.id === currentTool) btn.classList.add("active");
    btn.innerHTML = TOOL_ICONS[tool.id];
    btn.title = tool.label;
    btn.addEventListener("click", () => {
      commitTextEditor();
      currentTool = tool.id;
      updateToolbarActiveState();
      updateCellCursors();
    });
    previewToolbar.appendChild(btn);
  }

  // Separator
  const sep = document.createElement("span");
  sep.className = "filter-preview-tool-sep";
  previewToolbar.appendChild(sep);

  // Color picker
  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.value = currentColor;
  colorInput.className = "filter-preview-color-input";
  colorInput.title = "Draw color";
  colorInput.addEventListener("input", (e) => {
    currentColor = e.target.value;
  });
  previewToolbar.appendChild(colorInput);

  // Line width buttons
  const widths = [2, 4, 8];
  for (const w of widths) {
    const btn = document.createElement("button");
    btn.className = "filter-preview-tool-btn filter-preview-width-btn";
    if (w === currentLineWidth) btn.classList.add("active-width");
    btn.title = `${w}px`;
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16"><line x1="4" y1="12" x2="20" y2="12" stroke="currentColor" stroke-width="${w * 0.8}" stroke-linecap="round"/></svg>`;
    btn.addEventListener("click", () => {
      currentLineWidth = w;
      previewToolbar.querySelectorAll(".filter-preview-width-btn").forEach((b) => b.classList.remove("active-width"));
      btn.classList.add("active-width");
    });
    previewToolbar.appendChild(btn);
  }

  // Separator before zoom
  const sep2 = document.createElement("span");
  sep2.className = "filter-preview-tool-sep";
  previewToolbar.appendChild(sep2);

  // Zoom slider
  const zoomLabel = document.createElement("span");
  zoomLabel.className = "filter-preview-zoom-label";
  zoomLabel.id = "filter-preview-zoom-val";
  zoomLabel.textContent = `${Math.round(previewZoom * 100)}%`;
  const zoomSlider = document.createElement("input");
  zoomSlider.type = "range";
  zoomSlider.min = "25";
  zoomSlider.max = "200";
  zoomSlider.step = "1";
  zoomSlider.value = Math.round(previewZoom * 100);
  zoomSlider.className = "filter-preview-zoom-slider";
  zoomSlider.title = "Preview size";
  zoomSlider.addEventListener("input", () => {
    previewZoom = parseInt(zoomSlider.value) / 100;
    zoomLabel.textContent = `${Math.round(previewZoom * 100)}%`;
    applyPreviewZoom();
  });
  zoomSlider.addEventListener("change", () => {
    zoomSlider.blur();
  });
  previewToolbar.appendChild(zoomSlider);
  previewToolbar.appendChild(zoomLabel);
}

function applyPreviewZoom() {
  if (!grid) return;
  const maxW = Math.round(400 * previewZoom);
  grid.querySelectorAll(".filter-preview-cell canvas").forEach((c) => {
    c.style.maxWidth = `${maxW}px`;
  });
}

/**
 * Calculate default zoom so all filter cells fit on screen without scrolling.
 */
function calculateFitZoom(imgEl) {
  const filterCount = FILTER_OPTIONS.length;
  // Available width: viewport minus grid padding (left 16 + right 16) and gaps
  const availableWidth = window.innerWidth - 32 - (filterCount - 1) * 10;
  // Available height: viewport minus top padding (80) and bottom padding (56) and footer (~28) and cell padding (12)
  const availableHeight = window.innerHeight - 80 - 56 - 28 - 12;

  const imgW = imgEl.img.naturalWidth || imgEl.img.width;
  const imgH = imgEl.img.naturalHeight || imgEl.img.height;
  const aspect = imgW / imgH;

  // Each cell has 6px padding on each side = 12px total, plus border 6px
  const cellPaddingX = 18;
  const maxCellWidth = (availableWidth / filterCount) - cellPaddingX;

  // Also constrain by height
  const maxCellByHeight = availableHeight * aspect;

  const fittingMaxW = Math.min(maxCellWidth, maxCellByHeight);
  // previewZoom is relative to 400px base
  const zoom = Math.max(0.25, Math.min(2.0, fittingMaxW / 400));
  return zoom;
}

// --- Background click to close ---

function onOverlayBackgroundClick(e) {
  // Only close if clicking directly on the overlay or the grid container (not on cells/toolbar/nav)
  if (e.target === overlay || e.target === grid) {
    closeFilterPreview();
  }
}

// --- Open / Close ---

export function openFilterPreview() {
  getDomRefs();
  if (state.images.length === 0) return;

  // Use selected images if any are selected, otherwise all images
  const selectedImages = state.selectedElements.filter((el) => el.elementType === "image");
  previewImages = selectedImages.length > 0 ? selectedImages : [...state.images];

  if (previewImages.length === 0) return;

  isActive = true;
  currentIndex = 0;
  flaggedItems = [];
  cellShapes.clear();
  previewZoom = calculateFitZoom(previewImages[0]);
  overlay.style.display = "flex";
  buildPreviewToolbar();
  renderGrid(0);
  updateFlagCount();

  keyHandler = (e) => {
    if (!isActive) return;
    // Don't intercept keys while the text editor is active
    if (activeTextEditor) return;
    if (e.key === "ArrowRight") { e.preventDefault(); goNext(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); goPrev(); }
    else if (e.key === "Escape") { e.preventDefault(); closeFilterPreview(); }
    else {
      // Tool hotkeys (same as main canvas)
      const key = e.key.toLowerCase();
      let newTool = null;
      if (key === "v") newTool = "select";
      else if (key === "b") newTool = "pen";
      else if (key === "l") newTool = "line";
      else if (key === "a") newTool = "arrow";
      else if (key === "r") newTool = "rect-border";
      else if (key === "f") newTool = "rect-fill";
      else if (key === "t") newTool = "text";
      else if (key === "e") newTool = "eraser";

      if (newTool) {
        e.preventDefault();
        commitTextEditor();
        currentTool = newTool;
        updateToolbarActiveState();
        updateCellCursors();
      }
    }
  };
  document.addEventListener("keydown", keyHandler, true);

  closeBtn.addEventListener("click", closeFilterPreview);
  prevBtn.addEventListener("click", goPrev);
  nextBtn.addEventListener("click", goNext);

  // Close on background click (only if clicking directly on overlay or grid background)
  overlay.addEventListener("mousedown", onOverlayBackgroundClick);
}

export function closeFilterPreview() {
  getDomRefs();
  commitTextEditor();
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
  overlay.removeEventListener("mousedown", onOverlayBackgroundClick);

  placeFlaggedImages();
  cellShapes.clear();
  previewImages = [];
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
      if (isActive) closeFilterPreview();
      else openFilterPreview();
    });
  }
}
