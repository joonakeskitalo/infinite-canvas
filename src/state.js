/**
 * Shared Application State & Constants
 *
 * Central mutable state object. All modules import from here.
 * Using a single object avoids issues with ES module live binding semantics.
 */

export const CONSTANTS = {
  GRID_SIZE: 100,
  CONSTANT_LINE_WIDTH: 4,
  RESIZE_HANDLE_SIZE: 10,
  MAX_HISTORY: 50,
  SNAP_THRESHOLD: 8,
  MAX_GUIDE_NEIGHBORS: 6,
  INTERNAL_COPY_MIME: "text/x-infinite-canvas",
  RULER_SIZE: 12,
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

  // Interaction state
  isInteracting: false,
  startX: 0,
  startY: 0,
  panLockDirection: null,
  isMiddleClick: false,
  isRightClickHand: false,
  lastMousePos: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
  isShiftPressed: false,
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

// --- DOM element references (lazily cached) ---
let _domRefs = null;

export function getDom() {
  if (!_domRefs) {
    _domRefs = {
      container: document.getElementById("canvas-container"),
      canvas: document.getElementById("canvas"),
      ctx: document.getElementById("canvas").getContext("2d"),
      ghostInput: document.getElementById("text-ghost-input"),
      fontSizeSelect: document.getElementById("font-size-select"),
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
    };
  }
  return _domRefs;
}
