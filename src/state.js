/**
 * Shared Application State & Constants
 *
 * Central mutable state object. All modules import from here.
 * Using a single object avoids issues with ES module live binding semantics.
 */

import { SpatialIndex } from "./spatial-index.js";

export const CONSTANTS = {
  GRID_SIZE: 100,
  CONSTANT_LINE_WIDTH: 4,
  RESIZE_HANDLE_SIZE: 10,
  MAX_HISTORY: 50,
  SNAP_THRESHOLD: 8,
  MAX_GUIDE_NEIGHBORS: 6,
  INTERNAL_COPY_MIME: "text/x-jiiris-canvas",
  RULER_SIZE: 12,
  MIN_DRAW_DISTANCE: 5, // Minimum screen-pixel drag distance before drawing tools activate
  MIN_MOVE_DISTANCE: 4, // Minimum screen-pixel drag distance before moving selected elements
};

export const state = {
  // Canvas & Transform
  transform: { x: 0, y: 0, zoom: 1 },

  // Tool state
  currentTool: "pan",
  preSpaceTool: null,
  drawColor: "#ff4444",
  textDrawColor: "#000000",
  bgColor: "#f0f0f0",
  currentFontSize: 28,
  currentFontFamily: "sans-serif",
  currentTextAlign: "left",
  currentLineWidth: 4,
  currentLineDash: "solid", // "solid", "dashed", "dotted", "dash-dot"
  currentNoteBgColor: "#f5e642", // text-element (note) background color

  // Pending text styles (applied to newly created text when tool is active)
  pendingTextBold: false,
  pendingTextItalic: false,
  pendingTextUnderline: false,
  pendingTextStrikethrough: false,

  // Interaction state
  isInteracting: false,
  startX: 0,
  startY: 0,
  panLockDirection: null,
  isMiddleClick: false,
  isRightClickHand: false,
  lastMousePos: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
  isShiftPressed: false,
  isMetaPressed: false,
  isCtrlPressed: false,
  isSpacePressed: false,

  // Element collections
  images: [],
  drawings: [],
  elementOrder: [],  // Array of element IDs in z-order (bottom to top)
  activeShape: null,
  activeTextCoord: null,

  // Selection state
  selectedElements: [],
  isRegionSelecting: false,
  regionStart: { x: 0, y: 0 },
  regionEnd: { x: 0, y: 0 },
  dragOffsets: [],
  hasDragThresholdBeenMet: false,
  resizingElement: null,
  resizeStartBounds: null,

  // ID counters
  elementIdCounter: 0,
  groupIdCounter: 0,

  // Snap/Guide state
  activeSnapGuides: [],
  activeProximityGuides: [],
  activeSpacingGuides: [],

  // Clipboard
  clipboardElements: [],
  pasteOffset: 0,
  internalCopyPerformed: false,
  internalCopyId: null,

  // Measurement tool
  measureHoverGuides: [],
  activeMeasureLine: null,

  // Swap tool
  swapHoveredElement: null,
  isSwapDragging: false,
  swapSourceElement: null,
  swapDragWorldPos: null,
  swapTargetElement: null,

  // Crop mode
  cropMode: false,
  cropTarget: null,
  cropRect: null,
  cropDragEdge: null,
  cropDragStart: null,
  cropClipboard: null, // Stored crop settings {x, y, w, h} for copy/paste between images

  // Connector arrow
  activeConnector: null,
  connectorHoverTarget: null,

  // Eyedropper insert mode (shift-click behavior without holding shift)
  eyedropperInsertMode: false,

  // Eyedropper marquee (drag-to-select area for color analysis)
  eyedropperMarqueeActive: false,  // true while dragging to define the area
  eyedropperMarqueeStart: null,    // {x, y} world-coords where drag started
  eyedropperMarqueeRect: null,     // {x, y, w, h} world-coords of the selection rectangle
  eyedropperMarqueePixels: null,   // ImageData of the clean selection area (for highlight rendering)
  eyedropperHighlightColor: null,  // hex string of the currently hovered color to highlight

  // Split-line tool
  splitLineOrientation: "vertical", // "vertical" or "horizontal"
  splitLineLength: 100, // percentage of image dimension (10-200), 100 = full span, >100 extends beyond image
  splitLineDash: "solid", // dash pattern: "solid", "dashed", "dotted", "dash-dot"
  splitLineFullWidth: false, // when true, line extends across full canvas (like a ruler guide)
  splitLineHoveredImage: null,
  splitLineWorldPos: null,


  // Contrast checker tool
  contrastColor1: null, // {r, g, b} of first click
  contrastColor2: null, // {r, g, b} of second click
  contrastClickCount: 0, // 0 = waiting for first, 1 = waiting for second
  contrastWorldPos1: null, // {x, y} world position of first click (for shift-click line)
  activeContrastLine: null, // {start, end} during drag to create contrast line

  // Color filter
  currentFilter: "none",
  filteredImageCache: new WeakMap(),
  filteredImageCacheFilter: "none",

  // Crop image cache: pre-rendered cropped sub-images for faster panning
  cropImageCache: new WeakMap(),

  // Rulers & Guides
  guides: [],
  guidesVisible: true,
  rulersVisible: false,
  draggingGuide: null,
  draggingNewGuide: null,

  // Overlay visibility toggle (split lines, drawings/connectors, rulers)
  overlaysHidden: false,

  // File persistence
  fileHandle: null,
  saveTimeout: null,
  isDirty: false,
  isSaving: false,
  pendingSave: false,

  // Marquee (rectangle select) tool — works on any element
  marqueeMode: false,         // true when a marquee selection is active
  marqueeTarget: null,        // (legacy) the image element for pixel-mode marquee
  marqueeRect: null,          // {x, y, w, h} world-coords of the selection rectangle
  marqueePixelCanvas: null,   // OffscreenCanvas with rasterized content of selection
  marqueeOffset: { x: 0, y: 0 }, // offset from original position while dragging
  marqueeIsDragging: false,   // true while moving the selected region
  marqueeDragStart: null,     // {x, y} world-coords where drag started
  marqueeDragMovesContent: false, // true when the current drag moves selected content (Shift-drag); false moves only the selection box
  marqueeIsSelecting: false,  // true while drawing the marquee rectangle
  marqueeStart: null,         // {x, y} world-coords where rectangle drawing started
  marqueeCut: false,          // true if elements have been cut from the canvas
  marqueeElements: [],        // array of element references captured by the marquee
  marqueeIsElementMode: false, // true when operating on elements (not just image pixels)

  // Grid
  gridVisible: false,
  gridSize: 100,

  // Undo/Redo
  undoStack: [],
  redoStack: [],

  // Internal clipboard copy marker
  pendingInternalCopy: false,

  // Stamp clipboard (Shift+W / W): copy non-image elements overlapping a hovered image
  stampClipboard: [],           // cloned non-image elements (positions relative to source image origin)
  stampSourceBounds: null,      // {x, y, w, h} of the source image at copy time

  // Stamp marquee (drag to select area and stamp all images within it)
  stampMarqueeActive: false,    // true while drawing the stamp marquee rectangle
  stampMarqueeStart: null,      // {x, y} world-coords where rectangle drawing started
  stampMarqueeRect: null,       // {x, y, w, h} world-coords of the selection rectangle

  // Bézier pen tool
  bezierPath: null,             // In-progress path: {id, points: [{x,y,cx1,cy1,cx2,cy2}], closed}
  bezierDragging: false,        // True when dragging to create control handles
  bezierHoverPoint: -1,         // Index of hovered anchor point (-1 = none)
  bezierSelectedPoint: -1,      // Index of selected anchor point for editing
  bezierEditingPath: null,      // Reference to a committed path being edited
  bezierFillColor: null,        // Fill color for new bezier paths (null = no fill)

  // Laser pointer tool
  laserTrails: [],              // Array of {type:"stroke"|"dot", points?:[{x,y}], x?,y?, color, width}
  laserActiveStroke: null,      // Current in-progress laser stroke (pen-like drawing)
  laserColor: "#ff0000",       // Laser color (red by default)
  laserWidth: 3,               // Laser stroke width
};

// Spatial index lives outside state object to avoid polluting its hidden class
export const spatialIndex = new SpatialIndex(300);

// --- Spatial Index Helpers ---

/**
 * Compute AABB bounds for an element suitable for the spatial index.
 * Works for both images and drawing shapes.
 * @param {object} el
 * @returns {{minX:number, minY:number, maxX:number, maxY:number}}
 */
export function getElementSpatialBounds(el) {
  if (el.elementType === "image") {
    return { minX: el.x, minY: el.y, maxX: el.x + el.w, maxY: el.y + el.h };
  }
  if (el.type === "pen") {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of el.points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
  }
  if (el.type === "bezier-path") {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of el.points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
      if (p.cx1 < minX) minX = p.cx1;
      if (p.cy1 < minY) minY = p.cy1;
      if (p.cx1 > maxX) maxX = p.cx1;
      if (p.cy1 > maxY) maxY = p.cy1;
      if (p.cx2 < minX) minX = p.cx2;
      if (p.cy2 < minY) minY = p.cy2;
      if (p.cx2 > maxX) maxX = p.cx2;
      if (p.cy2 > maxY) maxY = p.cy2;
    }
    return { minX, minY, maxX, maxY };
  }
  if (el.type === "text") {
    // Text might not have w/h computed yet; use start point + estimated size
    const w = el.w || el.fontSize * 5;
    const h = el.h || el.fontSize * 1.5;
    const padding = el.bgColor ? el.fontSize * 0.4 : 0;
    return {
      minX: el.start.x - padding,
      minY: el.start.y - padding,
      maxX: el.start.x + w + padding,
      maxY: el.start.y + h + padding,
    };
  }
  // Line-like elements (line, arrow, rect, connector, measure)
  if (el.start && el.end) {
    return {
      minX: Math.min(el.start.x, el.end.x),
      minY: Math.min(el.start.y, el.end.y),
      maxX: Math.max(el.start.x, el.end.x),
      maxY: Math.max(el.start.y, el.end.y),
    };
  }
  // Fallback for elements with only a start point
  if (el.start) {
    return { minX: el.start.x, minY: el.start.y, maxX: el.start.x, maxY: el.start.y };
  }
  return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
}

/**
 * Rebuild the spatial index from scratch using current state.images and state.drawings.
 * Call after bulk operations like file load or undo/redo.
 */
export function rebuildSpatialIndex() {
  spatialIndex.clear();
  for (const img of state.images) {
    spatialIndex.insert(img, getElementSpatialBounds(img));
  }
  for (const shape of state.drawings) {
    spatialIndex.insert(shape, getElementSpatialBounds(shape));
  }
  invalidateZOrderCache();
}

/**
 * Rebuild elementOrder from current images and drawings arrays.
 * Preserves existing order for elements already in elementOrder,
 * appends any new elements at the end.
 */
export function rebuildElementOrder() {
  const allIds = new Set([...state.images.map(e => e.id), ...state.drawings.map(e => e.id)]);
  // Keep existing order entries that still exist
  const kept = state.elementOrder.filter(id => allIds.has(id));
  const keptSet = new Set(kept);
  // Append any new elements not yet in the order (images first, then drawings — legacy default)
  for (const el of state.images) {
    if (!keptSet.has(el.id)) kept.push(el.id);
  }
  for (const el of state.drawings) {
    if (!keptSet.has(el.id)) kept.push(el.id);
  }
  state.elementOrder = kept;
  invalidateZOrderCache();
}

/**
 * Get all elements in z-order (bottom to top).
 * Returns a cached array of element references ordered by state.elementOrder.
 * The cache is invalidated when elements are added/removed or order changes.
 */
let _zOrderCache = null;
let _zOrderCacheKey = null;

export function invalidateZOrderCache() {
  _zOrderCache = null;
  _zOrderCacheKey = null;
}

export function getElementsInZOrder() {
  // Use a composite key: element count + order length + first/last IDs
  const key = state.images.length + ":" + state.drawings.length + ":" + state.elementOrder.length +
    ":" + (state.elementOrder[0] || "") + ":" + (state.elementOrder[state.elementOrder.length - 1] || "");
  if (_zOrderCache && _zOrderCacheKey === key) {
    return _zOrderCache;
  }
  const map = new Map();
  for (const el of state.images) map.set(el.id, el);
  for (const el of state.drawings) map.set(el.id, el);
  const result = [];
  for (const id of state.elementOrder) {
    const el = map.get(id);
    if (el) result.push(el);
  }
  _zOrderCache = result;
  _zOrderCacheKey = key;
  return result;
}

/**
 * Insert an element into the spatial index and add to element order (on top).
 */
export function spatialInsert(el) {
  spatialIndex.insert(el, getElementSpatialBounds(el));
  if (!state.elementOrder.includes(el.id)) {
    state.elementOrder.push(el.id);
  }
  invalidateZOrderCache();
}

/**
 * Remove an element from the spatial index and element order.
 */
export function spatialRemove(el) {
  spatialIndex.remove(el);
  const idx = state.elementOrder.indexOf(el.id);
  if (idx !== -1) state.elementOrder.splice(idx, 1);
  invalidateZOrderCache();
}

/**
 * Update an element's position in the spatial index.
 */
export function spatialUpdate(el) {
  spatialIndex.update(el, getElementSpatialBounds(el));
}

// --- DOM element references (lazily cached) ---
let _domRefs = null;

export function getDom() {
  if (!_domRefs) {
    _domRefs = {
      container: document.getElementById("canvas-container"),
      canvas: document.getElementById("canvas"),
      ctx: document.getElementById("canvas").getContext("2d"),
      textEditor: document.getElementById("text-editor-overlay"),
      fontFamilySelect: document.getElementById("font-family-select"),
      zoomSlider: document.getElementById("zoom-slider"),
      zoomValDisplay: document.getElementById("zoom-val"),
      exportBtn: document.getElementById("export-btn"),
      downloadImagesBtn: document.getElementById("download-images-btn"),
      centerCanvasBtn: document.getElementById("center-canvas-btn"),
      alignmentPanel: document.getElementById("alignment-panel"),
      toast: document.getElementById("toast"),
      bgColorPicker: document.getElementById("bg-color-picker"),
      colorPicker: document.getElementById("color-picker"),
      toolbarMenuBtn: document.getElementById("toolbar-menu-btn"),
      toolbarMenu: document.getElementById("toolbar-menu"),
      filterSelect: document.getElementById("filter-select"),
      opacitySlider: document.getElementById("opacity-slider"),
      opacityValDisplay: document.getElementById("opacity-val"),
      opacityGroup: document.getElementById("opacity-group"),
      spacingInputX: document.getElementById("spacing-input-x"),
      spacingInputY: document.getElementById("spacing-input-y"),
      textAlignGroup: document.getElementById("text-align-group"),
      dimensionsGroup: document.getElementById("dimensions-group"),
      dimW: document.getElementById("dim-w"),
      dimH: document.getElementById("dim-h"),
      lengthGroup: document.getElementById("length-group"),
      dimLength: document.getElementById("dim-length"),
    };
  }
  return _domRefs;
}
