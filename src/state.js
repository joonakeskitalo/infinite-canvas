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
  INTERNAL_COPY_MIME: "text/x-infinite-canvas",
  RULER_SIZE: 12,
  MIN_DRAW_DISTANCE: 5, // Minimum screen-pixel drag distance before drawing tools activate
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
  currentFontSize: 48,
  currentFontFamily: "sans-serif",
  currentTextAlign: "left",
  currentLineWidth: 4,

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
  isSpacePressed: false,

  // Element collections
  images: [],
  drawings: [],
  activeShape: null,
  activeTextCoord: null,

  // Selection state
  selectedElements: [],
  isRegionSelecting: false,
  regionStart: { x: 0, y: 0 },
  regionEnd: { x: 0, y: 0 },
  dragOffsets: [],
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

  // Connector arrow
  activeConnector: null,
  connectorHoverTarget: null,

  // Split-line tool
  splitLineOrientation: "vertical", // "vertical" or "horizontal"
  splitLineHoveredImage: null,
  splitLineWorldPos: null,

  // Color filter
  currentFilter: "none",
  filteredImageCache: new WeakMap(),
  filteredImageCacheFilter: "none",

  // Rulers & Guides
  guides: [],
  guidesVisible: true,
  rulersVisible: false,
  draggingGuide: null,
  draggingNewGuide: null,

  // File persistence
  fileHandle: null,
  saveTimeout: null,
  isDirty: false,
  isSaving: false,
  pendingSave: false,

  // Undo/Redo
  undoStack: [],
  redoStack: [],

  // Internal clipboard copy marker
  pendingInternalCopy: false,
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
}

/**
 * Insert an element into the spatial index.
 */
export function spatialInsert(el) {
  spatialIndex.insert(el, getElementSpatialBounds(el));
}

/**
 * Remove an element from the spatial index.
 */
export function spatialRemove(el) {
  spatialIndex.remove(el);
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
      fontSizeSelect: document.getElementById("font-size-select"),
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
    };
  }
  return _domRefs;
}
