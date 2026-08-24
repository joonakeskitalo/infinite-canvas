/**
 * Interaction — Mouse/Keyboard Event Handlers
 *
 * Sets up all event listeners for the canvas application.
 */

import { state, CONSTANTS, getDom, spatialInsert, spatialRemove, spatialUpdate, spatialIndex, rebuildSpatialIndex } from "./state.js";
import { screenToWorld, worldToScreen, showToast, showColorToast, constraintToAngle } from "./utils.js";
import {
  getShapeBounds, isPointHittingShape, getElementResizeHandles,
  getElementAtWorldPos, isPointOnSwapHandle, translateElement,
  isPointOnMeasureLabel,
} from "./elements.js";
import { pushUndo, undo, redo } from "./history.js";
import { scheduleSave, saveFile, saveAs, openFile } from "./persistence.js";
import { render, renderSync, executePNGExport, executeJPEGExport } from "./rendering.js";
import {
  getSnapTargets, snapToElements, snapToSpacing, snapResizeEdges,
  getProximityGuides, getSpacingGuides, computeMeasureHoverGuides,
} from "./snap-guides.js";
import {
  getConnectorAnchorPoint, computeAnchorRatio,
  getClosestConnectionPort, updateConnectorsForElements,
} from "./connectors.js";
import { enterCropMode, exitCropMode, getCropEdgeAtPoint, getCropCursor, getFullImageBounds, copyCropSettings, pasteCropSettings } from "./crop.js";
import {
  expandSelectionToGroups, groupSelection, ungroupSelection, toggleLockSelection,
  bringToFront, sendToBack, bringForward, sendBackward,
  copySelectionToClipboard, pasteFromClipboard, pasteFromSerializedClipboard,
  pasteTextToCanvas,
  duplicateSelection, selectAllElements, swapElementPositions,
  buildAlignmentUnits, translateUnit,
  applyRowLayout, applyColumnLayout, applyGridLayout, applyArrangeBySizeRow, applyArrangeByNameRow,
} from "./selection.js";
import {
  updateToolbarUI, toggleAlignmentPanelVisibility,
  updateCursor, applyZoom, updateZoomSliderValue,
  syncFontSizeFromSelection, syncOpacityFromSelection,
  updateSpacingInputs, updateGroupButtons, updateColorInfo, initHexLabelClick, updateColorNameLabel,
} from "./toolbar.js";
import { setRulersVisible, resizeRulers } from "./rulers.js";
import { FILTER_OPTIONS, FILTER_LABELS } from "./color-filter.js";
import { openFilterPreview, isFilterPreviewActive } from "./filter-preview-mode.js";
import { applyFilterToImageData } from "./filter-kernels.js";
import { setCustomColorsDeps, getCustomColors } from "./custom-colors.js";
import { initColorHistory, setColorHistoryDeps, pushColorToHistory } from "./color-history.js";
import { showContrastResult, showContrastWaiting, hideContrastPanel, contrastRatio, rgbToHex } from "./contrast-checker.js";
import {
  marqueeStartSelection, marqueeUpdateSelection, marqueeEndSelection,
  marqueeCut, marqueeCopy, marqueeDuplicate, marqueeCommit, exitMarqueeMode,
  marqueeExportPNG,
} from "./marquee-select.js";
import {
  addLaserDot, startLaserStroke, extendLaserStroke, finishLaserStroke, clearLaserTrails, commitLaserTrails,
} from "./laser-pointer.js";
import {
  accessibilityPreviewStart, accessibilityPreviewMove, accessibilityPreviewEnd,
  renderAccessibilityPreviewSelection, isAccessibilityPreviewSelecting,
  isAccessibilityPreviewInteracting, isAccessibilityPreviewModalOpen,
  activateAccessibilityPreview, deactivateAccessibilityPreview,
  handleAccessibilityPreviewDrop, getAccessibilityPreviewCursor,
} from "./accessibility-preview.js";
import {
  bezierPenMouseDown, bezierPenMouseMove, bezierPenMouseUp,
  bezierPenDoubleClick, bezierPenKeyDown, finalizeBezierPenIfNeeded,
  enterBezierEdit,
} from "./bezier-pen.js";
import { analyzeMarqueeColors, hideMarqueeColors } from "./marquee-colors.js";
import { toggle as toggleCommandPalette } from "./command-palette.js";

// --- PERFORMANCE: Throttle proximity/spacing guide computation during drag ---
const GUIDE_COMPUTE_INTERVAL_MS = 60; // ms between expensive guide recalculations
let _lastGuideComputeTime = 0;
// --- PERFORMANCE: Map for O(1) drag offset lookup ---
let _dragOffsetMap = null;
// --- PERFORMANCE: Cached selected element IDs for the current drag ---
let _dragExcludeIds = null; // Array of selected element IDs (stable during a drag)
let _dragExcludeIdSet = null; // Set version for O(1) lookups

/**
 * Snap a split-line position to the nearest fraction (halves, thirds, quarters)
 * of the image dimension. Returns the snapped position if close enough, otherwise
 * the original position.
 */
function snapSplitLinePos(pos, origin, size) {
  const threshold = size * 0.02; // 2% of dimension
  const fractions = [1/4, 1/3, 1/2, 2/3, 3/4];
  for (const f of fractions) {
    const snapTarget = origin + size * f;
    if (Math.abs(pos - snapTarget) < threshold) {
      return snapTarget;
    }
  }
  return pos;
}

/**
 * Eyedropper: single-click color pick behavior.
 */
function eyedropperPickColor(e, worldPos) {
  const dom = getDom();
  const { canvas, ctx } = dom;
  hideMarqueeColors();
  const pixelData = ctx.getImageData(e.clientX - canvas.getBoundingClientRect().left, e.clientY - canvas.getBoundingClientRect().top, 1, 1).data;
  const hex = "#" + ((1 << 24) + (pixelData[0] << 16) + (pixelData[1] << 8) + pixelData[2]).toString(16).slice(1);
  const hexUpper = hex.toUpperCase();

  // Always set as current draw color
  state.drawColor = hex;
  dom.colorPicker.value = hex;
  document.getElementById("color-swatch-inner").style.background = hex;
  const hexLbl = document.getElementById("color-hex-label");
  if (hexLbl) hexLbl.textContent = hex.toUpperCase();
  updateColorNameLabel();
  updateColorInfo();

  if (e.shiftKey || state.eyedropperInsertMode) {
    // Shift+click: insert the hex code (and label if custom color) as a text element on the canvas
    const customMatch = getCustomColors().find((c) => c.hex === hex.toLowerCase());
    const insertText = customMatch ? `${hexUpper} ${customMatch.label}` : hexUpper;

    // Determine contrasting text color based on luminance
    const luminance = (pixelData[0] * 299 + pixelData[1] * 587 + pixelData[2] * 114) / 1000;
    const textColor = luminance > 128 ? "#000000" : "#FFFFFF";

    const size = 16;

    pushUndo();
    const bgPadding = size * 0.41;
    const tipSize = bgPadding * 0.6;
    const textEl = {
      id: "text_" + state.elementIdCounter++,
      elementType: "text",
      type: "text",
      text: insertText,
      color: textColor,
      bgColor: hex,
      bgBorder: textColor,
      fontSize: size,
      fontFamily: state.currentFontFamily,
      start: { x: worldPos.x + bgPadding + tipSize, y: worldPos.y + bgPadding + tipSize },
    };
    state.drawings.push(textEl);
    spatialInsert(textEl);
    scheduleSave();
    render();
    showToast(`Inserted ${insertText} as text`);
  } else {
    // Normal click: pick color and apply to selected elements if any have changeable colors
    const customMatchPick = getCustomColors().find((c) => c.hex === hex.toLowerCase());
    showColorToast(hexUpper, customMatchPick ? customMatchPick.label : null);
    pushColorToHistory(hex);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(hexUpper).catch(() => {});
    }
    // Apply picked color to selected elements that support color changes
    if (state.selectedElements.length > 0) {
      let changed = false;
      state.selectedElements.forEach((el) => {
        if (el.elementType === "text" || el.elementType === "drawing") {
          el.color = hex;
          changed = true;
        }
      });
      if (changed) {
        render();
        scheduleSave();
      }
    }
  }
}

/**
 * Eyedropper: drag-area color analysis.
 * Rasterizes the selected world-rect from the main canvas and analyzes colors.
 */
function eyedropperAnalyzeArea(rect) {
  const dom = getDom();
  const { canvas, ctx } = dom;

  // Convert world-space rect to screen-space pixels
  const topLeft = worldToScreen(rect.x, rect.y);
  const bottomRight = worldToScreen(rect.x + rect.w, rect.y + rect.h);
  const sx = Math.round(topLeft.x);
  const sy = Math.round(topLeft.y);
  const sw = Math.round(bottomRight.x - topLeft.x);
  const sh = Math.round(bottomRight.y - topLeft.y);

  if (sw < 1 || sh < 1) return;

  // Temporarily hide the marquee rect so it doesn't get included in the pixel read
  const savedRect = state.eyedropperMarqueeRect;
  state.eyedropperMarqueeRect = null;
  renderSync();
  state.eyedropperMarqueeRect = savedRect;

  // Read pixel data from the rendered canvas
  const canvasRect = canvas.getBoundingClientRect();
  const readX = Math.max(0, sx - canvasRect.left);
  const readY = Math.max(0, sy - canvasRect.top);
  const readW = Math.min(sw, canvas.width - readX);
  const readH = Math.min(sh, canvas.height - readY);

  if (readW < 1 || readH < 1) return;

  // Create an offscreen canvas with the selection area pixels
  let offscreen, offCtx;
  if (typeof OffscreenCanvas !== "undefined") {
    offscreen = new OffscreenCanvas(readW, readH);
    offCtx = offscreen.getContext("2d");
  } else {
    offscreen = document.createElement("canvas");
    offscreen.width = readW;
    offscreen.height = readH;
    offCtx = offscreen.getContext("2d");
  }

  const imageData = ctx.getImageData(readX, readY, readW, readH);
  offCtx.putImageData(imageData, 0, 0);

  // Store pixel data for highlight rendering and color analysis
  state.eyedropperMarqueePixels = imageData;
  state.eyedropperHighlightColor = null;
  state.marqueePixelCanvas = offscreen;
  analyzeMarqueeColors();
}

export function initEventHandlers() {
  const dom = getDom();
  const { container, canvas, ctx, textEditor, zoomSlider,
    exportBtn, downloadImagesBtn, centerCanvasBtn, bgColorPicker, colorPicker,
    toolbarMenuBtn, toolbarMenu, filterSelect, opacitySlider, opacityValDisplay } = dom;

  // --- Toolbar Menu ---
  function positionToolbarMenu() {
    const toolbarRect = document.getElementById("toolbar").getBoundingClientRect();
    toolbarMenu.style.top = (toolbarRect.bottom + 6) + "px";
    toolbarMenu.style.left = toolbarRect.left + "px";
  }

  toolbarMenuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = toolbarMenu.classList.toggle("open");
    toolbarMenuBtn.classList.toggle("menu-open", isOpen);
    if (isOpen) positionToolbarMenu();
  });

  document.addEventListener("click", (e) => {
    if (!toolbarMenu.contains(e.target) && !toolbarMenuBtn.contains(e.target)) {
      toolbarMenu.classList.remove("open");
      toolbarMenuBtn.classList.remove("menu-open");
    }
  });

  // --- Tool buttons ---
  const buttons = document.querySelectorAll(".tool-btn");
  buttons.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const targetBtn = e.target.closest(".tool-btn");
      if (!targetBtn.dataset.tool) return;
      if (textEditor.style.display === "block") bakeText();
      if (state.cropMode) exitCropMode(false);
      finalizeBezierPenIfNeeded();
      // Toggle split-line orientation when clicking the tool icon while already active
      if (targetBtn.dataset.tool === "split-line" && state.currentTool === "split-line") {
        state.splitLineOrientation = state.splitLineOrientation === "vertical" ? "horizontal" : "vertical";
        render();
        return;
      }
      state.currentTool = targetBtn.dataset.tool;
      // If overlays are hidden and user selects a non-pan tool, restore UI visibility
      if (state.overlaysHidden && state.currentTool !== "pan") {
        state.overlaysHidden = false;
        state._preOverlayTool = null;
        const toolbar = document.getElementById("toolbar");
        const zoomOverlay = document.getElementById("zoom-overlay");
        if (state._rulersWereVisible) { state._rulersWereVisible = false; setRulersVisible(true); }
        toolbar.style.display = "";
        zoomOverlay.style.display = "";
      }
      if (state.currentTool !== "select") state.selectedElements = [];
      if (state.currentTool !== "select") { state.swapHoveredElement = null; state.isSwapDragging = false; state.swapSourceElement = null; state.swapDragWorldPos = null; state.swapTargetElement = null; }
      if (state.currentTool !== "measure") { state.measureHoverGuides = []; state.activeMeasureLine = null; }
      if (state.currentTool !== "marquee" && state.marqueeMode) { marqueeCommit(); }
      if (state.currentTool !== "split-line") { state.splitLineHoveredImage = null; state.splitLineWorldPos = null; }
      if (state.currentTool === "accessibility-preview") { activateAccessibilityPreview(); }
      else { deactivateAccessibilityPreview(); }
      if (state.currentTool === "contrast") { state.contrastClickCount = 0; state.contrastColor1 = null; state.contrastColor2 = null; state.contrastWorldPos1 = null; state.activeContrastLine = null; showContrastWaiting(1); }
      else { hideContrastPanel(); }
      if (state.currentTool === "text") { colorPicker.value = state.textDrawColor; }
      else { colorPicker.value = state.drawColor; }
      updateToolbarUI();
      updateCursor();
      render();
      // Update swatch color when switching tools
      const swatchInner = document.getElementById("color-swatch-inner");
      if (swatchInner) {
        const swatchColor = state.currentTool === "text" ? state.textDrawColor : state.drawColor;
        swatchInner.style.background = swatchColor;
        const hexLbl = document.getElementById("color-hex-label");
        if (hexLbl) hexLbl.textContent = swatchColor.toUpperCase();
        updateColorNameLabel();
      }
    });
  });

  // --- Color picker ---
  colorPicker.addEventListener("input", (e) => {
    if (state.currentTool === "text") { state.textDrawColor = e.target.value; }
    else { state.drawColor = e.target.value; }
    applyColorToSelectedElements(e.target.value);
    updateColorSwatch();
    pushColorToHistory(e.target.value);
    if (state.currentTool === "laser") updateCursor();
  });

  // --- Color swatch popup ---
  const colorSwatchBtn = document.getElementById("color-swatch-btn");
  const colorPopup = document.getElementById("color-popup");

  colorSwatchBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = colorPopup.classList.toggle("open");
    if (isOpen) {
      const rect = colorSwatchBtn.getBoundingClientRect();
      const popupW = colorPopup.offsetWidth;
      const popupH = colorPopup.offsetHeight;
      const margin = 8;

      let left = rect.left + rect.width / 2 - popupW / 2;
      left = Math.max(margin, Math.min(left, window.innerWidth - popupW - margin));

      let top = rect.bottom + 6;
      if (top + popupH > window.innerHeight - margin) {
        top = rect.top - popupH - 6;
      }

      colorPopup.style.top = top + "px";
      colorPopup.style.left = left + "px";
    }
  });

  colorSwatchBtn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    colorPopup.classList.remove("open");
    colorPicker.click();
  });

  document.addEventListener("click", (e) => {
    if (!colorPopup.contains(e.target) && !colorSwatchBtn.contains(e.target)) {
      colorPopup.classList.remove("open");
    }
  });

  initHexLabelClick();

  function updateColorSwatch() {
    const swatch = document.getElementById("color-swatch-inner");
    const color = state.currentTool === "text" ? state.textDrawColor : state.drawColor;
    swatch.style.background = color;
    const hexLabel = document.getElementById("color-hex-label");
    if (hexLabel) hexLabel.textContent = color.toUpperCase();
    updateColorNameLabel();
    updateColorInfo();
  }

  const presetBtns = document.querySelectorAll(".preset-btn");
  presetBtns.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const color = e.target.dataset.color;
      if (e.shiftKey) {
        state.bgColor = color; bgColorPicker.value = color; render();
      } else {
        if (state.currentTool === "text") { state.textDrawColor = color; }
        else { state.drawColor = color; }
        colorPicker.value = color;
        applyColorToSelectedElements(color);
        updateColorSwatch();
        pushColorToHistory(color);
        if (state.currentTool === "laser") updateCursor();
        colorPopup.classList.remove("open");
      }
    });
  });

  function applyColorToSelectedElements(color) {
    if (state.selectedElements.length === 0) return;
    let changed = false;
    state.selectedElements.forEach((el) => {
      if (el.elementType === "text" || el.elementType === "drawing") { el.color = color; changed = true; }
    });
    if (changed) render();
  }

  // --- Wire custom colors selection callback ---
  setCustomColorsDeps({
    onColorSelect(hex, label) {
      if (state.currentTool === "text") { state.textDrawColor = hex; }
      else { state.drawColor = hex; }
      colorPicker.value = hex;
      applyColorToSelectedElements(hex);
      updateColorSwatch();
      pushColorToHistory(hex);
      colorPopup.classList.remove("open");
      showColorToast(hex);
    },
  });

  // --- Wire color history selection callback ---
  setColorHistoryDeps({
    onColorSelect(hex) {
      if (state.currentTool === "text") { state.textDrawColor = hex; }
      else { state.drawColor = hex; }
      colorPicker.value = hex;
      applyColorToSelectedElements(hex);
      updateColorSwatch();
      if (state.currentTool === "laser") updateCursor();
    },
  });

  bgColorPicker.addEventListener("input", (e) => {
    state.bgColor = e.target.value;
    document.body.style.backgroundColor = state.bgColor;
    render();
    scheduleSave();
  });

  // --- Bézier fill color control ---
  const bezierFillGroup = document.getElementById("bezier-fill-group");
  const bezierFillSwatchBtn = document.getElementById("bezier-fill-swatch-btn");
  const bezierFillSwatchInner = document.getElementById("bezier-fill-swatch-inner");
  const bezierFillPicker = document.getElementById("bezier-fill-picker");

  function updateBezierFillSwatch() {
    if (state.bezierFillColor) {
      bezierFillSwatchInner.style.background = state.bezierFillColor;
      bezierFillSwatchInner.style.border = "none";
    } else {
      bezierFillSwatchInner.style.background = "transparent";
      bezierFillSwatchInner.style.border = "2px dashed #999";
    }
  }

  function updateBezierFillVisibility() {
    const show = state.currentTool === "bezier-pen" ||
      (state.currentTool === "select" && state.selectedElements.some((el) => el.type === "bezier-path"));
    bezierFillGroup.style.display = show ? "" : "none";
  }

  bezierFillSwatchBtn.addEventListener("click", () => {
    // Toggle fill on/off
    if (state.bezierFillColor) {
      state.bezierFillColor = null;
    } else {
      state.bezierFillColor = bezierFillPicker.value;
    }
    updateBezierFillSwatch();
    // Apply to selected bezier paths
    if (state.selectedElements.length > 0) {
      let changed = false;
      state.selectedElements.forEach((el) => {
        if (el.type === "bezier-path") { changed = true; }
      });
      if (changed) {
        pushUndo();
        state.selectedElements.forEach((el) => {
          if (el.type === "bezier-path") { el.fillColor = state.bezierFillColor; }
        });
        render(); scheduleSave();
      }
    }
    // Apply to in-progress path
    if (state.bezierPath) {
      state.bezierPath.fillColor = state.bezierFillColor;
      render();
    }
  });

  bezierFillSwatchBtn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    bezierFillPicker.click();
  });

  bezierFillPicker.addEventListener("input", (e) => {
    state.bezierFillColor = e.target.value;
    updateBezierFillSwatch();
    // Apply to selected bezier paths
    if (state.selectedElements.length > 0) {
      let changed = false;
      state.selectedElements.forEach((el) => {
        if (el.type === "bezier-path") { el.fillColor = state.bezierFillColor; changed = true; }
      });
      if (changed) { render(); scheduleSave(); }
    }
    if (state.bezierPath) {
      state.bezierPath.fillColor = state.bezierFillColor;
      render();
    }
  });

  // --- Line width buttons ---
  const lineWidthBtns = document.querySelectorAll(".line-width-btn");
  lineWidthBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const newWidth = parseInt(btn.dataset.width, 10);
      state.currentLineWidth = newWidth;
      lineWidthBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      if (state.selectedElements.length > 0) {
        let changed = false;
        state.selectedElements.forEach((el) => {
          if (el.elementType === "drawing" && el.type !== "text") {
            el.width = newWidth;
            changed = true;
          }
        });
        if (changed) render();
      }
    });
  });

  // --- Line dash/style select ---
  const lineDashSelect = document.getElementById("line-dash-select");
  if (lineDashSelect) {
    lineDashSelect.value = state.currentLineDash;
    lineDashSelect.addEventListener("change", (e) => {
      state.currentLineDash = e.target.value;
      if (state.selectedElements.length > 0) {
        let changed = false;
        state.selectedElements.forEach((el) => {
          if (el.elementType === "drawing" && el.type !== "text") {
            el.dash = state.currentLineDash;
            changed = true;
          }
        });
        if (changed) render();
      }
      lineDashSelect.blur();
    });
  }

  // --- Note background color ---
  const noteBgSwatchBtn = document.getElementById("note-bg-swatch-btn");
  const noteBgPicker = document.getElementById("note-bg-picker");
  if (noteBgSwatchBtn && noteBgPicker) {
    noteBgSwatchBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      noteBgPicker.click();
    });
    noteBgSwatchBtn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      noteBgPicker.click();
    });
    noteBgPicker.addEventListener("input", (e) => {
      const color = e.target.value;
      state.currentNoteBgColor = color;
      const swatch = document.getElementById("note-bg-swatch-inner");
      if (swatch) swatch.style.background = color;
      // Update selected note elements
      if (state.selectedElements.length > 0) {
        let changed = false;
        state.selectedElements.forEach((el) => {
          if ((el.elementType === "text" || el.type === "text") && el.bgColor) {
            el.bgColor = color;
            changed = true;
          }
        });
        if (changed) render();
      }
      // Update active text editor if open
      const te = dom.textEditor;
      if (te && te.style.display === "block" && te.dataset.bgColor) {
        te.dataset.bgColor = color;
        te.style.background = color;
      }
    });
  }

  // --- Filter select ---
  filterSelect.addEventListener("change", (e) => {
    state.currentFilter = e.target.value;
    state.filteredImageCache = new WeakMap();
    filterSelect.classList.toggle("filter-active", state.currentFilter !== "none");
    render();
    if (state.currentFilter !== "none") {
      showToast(`Filter: ${e.target.options[e.target.selectedIndex].text}`);
    }
    filterSelect.blur();
  });

  // --- Font family ---
  dom.fontFamilySelect.addEventListener("change", (e) => {
    state.currentFontFamily = e.target.value;
    if (textEditor.style.display === "block") {
      textEditor.style.fontFamily = state.currentFontFamily;
    }
    applyFontFamilyToSelectedText(state.currentFontFamily);
    e.target.blur();
  });

  function applyFontFamilyToSelectedText(family) {
    if (state.selectedElements.length === 0) return;
    let changed = false;
    state.selectedElements.forEach((el) => {
      if (el.elementType === "text" || el.type === "text") {
        el.fontFamily = family;
        el.w = null;
        el.h = null;
        changed = true;
      }
    });
    if (changed) render();
  }

  // --- Spacing inputs ---
  const spacingInputX = dom.spacingInputX;
  const spacingInputY = dom.spacingInputY;
  [spacingInputX, spacingInputY].forEach((input) => {
    input.addEventListener("mousedown", (e) => e.stopPropagation());
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("focus", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => e.stopPropagation());
    input.addEventListener("input", () => {
      if (input === spacingInputX) applyExactSpacing("x");
      else applyExactSpacing("y");
    });
  });

  function applyExactSpacing(axis) {
    if (state.selectedElements.length < 2) return;
    const gap = Math.max(0, parseInt(axis === "x" ? spacingInputX.value : spacingInputY.value) || 10);
    const units = buildAlignmentUnits(state.selectedElements);
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
    rebuildSpatialIndex();
    render();
    showToast(`${axis === "x" ? "Horizontal" : "Vertical"} spacing set to ${gap}px`);
  }

  // --- Scale buttons ---
  // --- Crop copy/paste buttons ---
  document.getElementById("crop-copy-btn").addEventListener("click", () => {
    copyCropSettings();
  });
  document.getElementById("crop-paste-btn").addEventListener("click", () => {
    pasteCropSettings();
  });

  // --- Opacity slider ---
  let opacityUndoPushed = false;
  opacitySlider.addEventListener("input", (e) => {
    const val = parseInt(e.target.value);
    opacityValDisplay.textContent = val + "%";
    if (state.selectedElements.length === 0) return;
    if (!opacityUndoPushed) { pushUndo(); opacityUndoPushed = true; }
    state.selectedElements.forEach((el) => { el.opacity = val / 100; });
    render();
  });
  opacitySlider.addEventListener("mousedown", (e) => { e.stopPropagation(); opacityUndoPushed = false; });
  opacitySlider.addEventListener("change", () => { opacityUndoPushed = false; });

  // --- Split line length slider ---
  const splitLineLengthSlider = document.getElementById("split-line-length-slider");
  const splitLineLengthVal = document.getElementById("split-line-length-val");
  if (splitLineLengthSlider) {
    splitLineLengthSlider.addEventListener("input", (e) => {
      const val = parseInt(e.target.value);
      state.splitLineLength = val;
      splitLineLengthVal.textContent = val + "%";
      render();
    });
    splitLineLengthSlider.addEventListener("change", () => { splitLineLengthSlider.blur(); });
    splitLineLengthSlider.addEventListener("mousedown", (e) => { e.stopPropagation(); });
  }

  // --- Split line dash pattern select ---
  const splitLineDashSelect = document.getElementById("split-line-dash-select");
  if (splitLineDashSelect) {
    splitLineDashSelect.addEventListener("change", (e) => {
      state.splitLineDash = e.target.value;
      render();
      splitLineDashSelect.blur();
    });
    splitLineDashSelect.addEventListener("mousedown", (e) => { e.stopPropagation(); });
  }

  // --- Grid spacing input ---
  // --- Dimension inputs ---
  const dimW = document.getElementById("dim-w");
  const dimH = document.getElementById("dim-h");
  const dimLength = document.getElementById("dim-length");

  function handleDimStep(input, e) {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      if (e.shiftKey) {
        e.preventDefault();
        const step = e.key === "ArrowUp" ? 10 : -10;
        input.value = Math.max(1, parseInt(input.value || 0) + step);
        input.dispatchEvent(new Event("change"));
      }
    }
  }

  function applyDimensions() {
    if (state.selectedElements.length !== 1) return;
    const el = state.selectedElements[0];
    if (el.elementType === "image") return; // Images are non-editable
    const newW = parseFloat(dimW.value);
    const newH = parseFloat(dimH.value);
    if (isNaN(newW) || isNaN(newH) || newW <= 0 || newH <= 0) return;
    const b = getShapeBounds(el);
    if (Math.round(b.w) === Math.round(newW) && Math.round(b.h) === Math.round(newH)) return;
    pushUndo();
    if (el.type === "rect-border" || el.type === "rect-fill") {
      el.end = { x: el.start.x + newW, y: el.start.y + newH };
    } else if (el.type === "pen" && el.points && el.points.length > 1) {
      const scaleX = b.w > 0 ? newW / b.w : 1;
      const scaleY = b.h > 0 ? newH / b.h : 1;
      el.points = el.points.map((p) => ({ x: b.x + (p.x - b.x) * scaleX, y: b.y + (p.y - b.y) * scaleY }));
    }
    spatialUpdate(el);
    render();
    scheduleSave();
  }

  function applyLength() {
    if (state.selectedElements.length !== 1) return;
    const el = state.selectedElements[0];
    const isLineType = el.type === "line" || el.type === "arrow" || el.type === "measure" || el.type === "connector";
    if (!isLineType) return;
    const newLen = parseFloat(dimLength.value);
    if (isNaN(newLen) || newLen <= 0) return;
    const dx = el.end.x - el.start.x;
    const dy = el.end.y - el.start.y;
    const currentLen = Math.sqrt(dx * dx + dy * dy);
    if (Math.round(currentLen) === Math.round(newLen)) return;
    pushUndo();
    const angle = Math.atan2(dy, dx);
    el.end = { x: el.start.x + Math.cos(angle) * newLen, y: el.start.y + Math.sin(angle) * newLen };
    spatialUpdate(el);
    render();
    scheduleSave();
  }

  dimW.addEventListener("change", applyDimensions);
  dimH.addEventListener("change", applyDimensions);
  dimW.addEventListener("keydown", (e) => { handleDimStep(dimW, e); if (e.key === "Enter") { applyDimensions(); dimW.blur(); } e.stopPropagation(); });
  dimH.addEventListener("keydown", (e) => { handleDimStep(dimH, e); if (e.key === "Enter") { applyDimensions(); dimH.blur(); } e.stopPropagation(); });
  dimW.addEventListener("mousedown", (e) => e.stopPropagation());
  dimH.addEventListener("mousedown", (e) => e.stopPropagation());

  dimLength.addEventListener("change", applyLength);
  dimLength.addEventListener("keydown", (e) => { handleDimStep(dimLength, e); if (e.key === "Enter") { applyLength(); dimLength.blur(); } e.stopPropagation(); });
  dimLength.addEventListener("mousedown", (e) => e.stopPropagation());

  // --- Undo/Redo/Group buttons ---
  document.getElementById("undo-btn").addEventListener("click", undo);
  document.getElementById("redo-btn").addEventListener("click", redo);
  document.getElementById("group-btn").addEventListener("click", groupSelection);
  document.getElementById("ungroup-btn").addEventListener("click", ungroupSelection);
  document.getElementById("lock-btn").addEventListener("click", toggleLockSelection);
  document.getElementById("bring-to-front-btn").addEventListener("click", bringToFront);
  document.getElementById("bring-forward-btn").addEventListener("click", bringForward);
  document.getElementById("send-backward-btn").addEventListener("click", sendBackward);
  document.getElementById("send-to-back-btn").addEventListener("click", sendToBack);
  document.getElementById("open-file-btn").addEventListener("click", openFile);
  document.getElementById("save-file-btn").addEventListener("click", saveFile);

  // --- Grid toggle & size ---
  const gridItem = document.getElementById("toggle-grid-item");
  const gridSizeInput = document.getElementById("grid-size-input");

  gridItem.addEventListener("click", (e) => {
    // Don't toggle when clicking the input itself
    if (e.target === gridSizeInput) return;
    state.gridVisible = !state.gridVisible;
    gridItem.classList.toggle("active", state.gridVisible);
    render();
  });

  gridSizeInput.addEventListener("click", (e) => e.stopPropagation());
  gridSizeInput.addEventListener("change", (e) => {
    const val = Math.max(10, Math.min(500, parseInt(e.target.value) || 50));
    e.target.value = val;
    state.gridSize = val;
    if (state.gridVisible) render();
  });
  gridSizeInput.addEventListener("mousedown", (e) => e.stopPropagation());

  // --- Text alignment buttons ---
  document.querySelectorAll(".text-align-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const alignVal = e.target.closest(".text-align-btn").dataset.textAlign;
      if (!alignVal) return;
      state.currentTextAlign = alignVal;
      // Apply to selected text elements
      if (state.selectedElements.length > 0) {
        let changed = false;
        state.selectedElements.forEach((el) => {
          if (el.elementType === "text" || el.type === "text") {
            if (!changed) pushUndo();
            el.textAlign = alignVal;
            el.w = null;
            el.h = null;
            changed = true;
          }
        });
        if (changed) render();
      }
      // Update button active states
      document.querySelectorAll(".text-align-btn").forEach((b) => {
        if (b.dataset.textAlign === alignVal) b.classList.add("active");
        else b.classList.remove("active");
      });
    });
  });

  // --- Alignment buttons ---
  const alignButtons = document.querySelectorAll(".align-btn");
  alignButtons.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const targetBtn = e.target.closest(".align-btn");
      if (!targetBtn) return;
      const alignType = targetBtn.dataset.align;
      if (!alignType) return;
      if (state.selectedElements.length < 2) return;
      pushUndo();
      const units = buildAlignmentUnits(state.selectedElements);
      let groupMinX = Infinity, groupMinY = Infinity, groupMaxX = -Infinity, groupMaxY = -Infinity;
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
        if (units.length < 3) { showToast("Requires at least 3 units to distribute spacing"); return; }
        if (alignType === "distributeX") {
          units.sort((a, b) => a.b.x + a.b.w / 2 - (b.b.x + b.b.w / 2));
          const totalWidth = units.reduce((sum, u) => sum + u.b.w, 0);
          const gap = (groupMaxX - groupMinX - totalWidth) / (units.length - 1);
          let currentX = groupMinX;
          units.forEach((unit, i) => { if (i > 0 && i < units.length - 1) translateUnit(unit, currentX - unit.b.x, 0); currentX += unit.b.w + gap; });
        } else {
          units.sort((a, b) => a.b.y + a.b.h / 2 - (b.b.y + b.b.h / 2));
          const totalHeight = units.reduce((sum, u) => sum + u.b.h, 0);
          const gap = (groupMaxY - groupMinY - totalHeight) / (units.length - 1);
          let currentY = groupMinY;
          units.forEach((unit, i) => { if (i > 0 && i < units.length - 1) translateUnit(unit, 0, currentY - unit.b.y); currentY += unit.b.h + gap; });
        }
      } else if (alignType === "gridLayout") { applyGridLayout(units); }
      else if (alignType === "rowLayout") { applyRowLayout(units); }
      else if (alignType === "columnLayout") { applyColumnLayout(units); }
      else if (alignType === "arrangeBySizeRow") { applyArrangeBySizeRow(units); }
      else if (alignType === "arrangeByNameRow") { applyArrangeByNameRow(units); }
      else {
        units.forEach((unit) => {
          const b = unit.b;
          let shiftX = 0, shiftY = 0;
          if (alignType === "left") shiftX = groupMinX - b.x;
          else if (alignType === "centerX") shiftX = groupCenterX - (b.x + b.w / 2);
          else if (alignType === "right") shiftX = groupMaxX - b.maxX;
          else if (alignType === "top") shiftY = groupMinY - b.y;
          else if (alignType === "centerY") shiftY = groupCenterY - (b.y + b.h / 2);
          else if (alignType === "bottom") shiftY = groupMaxY - b.maxY;
          translateUnit(unit, shiftX, shiftY);
        });
      }
      rebuildSpatialIndex();
      render();
      updateSpacingInputs();
      showToast(`Executed selection ${alignType}`);
    });
  });

  // --- Context menu ---
  container.addEventListener("contextmenu", (e) => e.preventDefault());

  // --- Resize ---
  function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; render(); }
  window.addEventListener("resize", () => { resizeRulers(); resize(); });

  // --- beforeunload ---
  window.addEventListener("beforeunload", (e) => { if (state.isDirty) { e.preventDefault(); e.returnValue = ""; } });

  // --- Export and download buttons ---
  exportBtn.addEventListener("click", (e) => {
    const scale = e.shiftKey ? 0.5 : 1.0;
    if (state.marqueeMode) { marqueeExportPNG(scale); return; }
    executePNGExport(scale);
  });
  document.getElementById("download-png-btn").addEventListener("click", (e) => {
    const scale = e.shiftKey ? 0.5 : 1.0;
    if (state.marqueeMode) { marqueeExportPNG(scale, { download: true }); return; }
    executePNGExport(scale, { download: true });
  });
  document.getElementById("download-jpeg-btn").addEventListener("click", (e) => executeJPEGExport(e.shiftKey ? 0.5 : 1.0, { download: true }));
  downloadImagesBtn.addEventListener("click", async () => {
    if (state.images.length === 0) { showToast("No pasted images found to download!"); return; }
    showToast(`Packing ${state.images.length} asset${state.images.length > 1 ? "s" : ""} into ZIP...`);
    const zip = new JSZip();
    state.images.forEach((imgData, index) => {
      const tempCanvas = document.createElement("canvas");
      tempCanvas.width = imgData.img.naturalWidth || imgData.w;
      tempCanvas.height = imgData.img.naturalHeight || imgData.h;
      tempCanvas.getContext("2d").drawImage(imgData.img, 0, 0);
      if (state.currentFilter !== "none") {
        const tempCtx = tempCanvas.getContext("2d");
        const imgDataPixels = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
        applyFilterToImageData(imgDataPixels, state.currentFilter);
        tempCtx.putImageData(imgDataPixels, 0, 0);
      }
      const dataURL = tempCanvas.toDataURL("image/png");
      const base64 = dataURL.split(",")[1];
      zip.file(`asset_${index + 1}.png`, base64, { base64: true });
    });
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
    const a = document.createElement("a");
    const now = new Date();
    const dtPrefix = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
    a.href = URL.createObjectURL(blob);
    a.download = `${dtPrefix}_assets.zip`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(a.href);
    showToast(`Downloaded ${state.images.length} assets as ZIP${state.currentFilter !== "none" ? ` (${state.currentFilter})` : ""}`);
  });

  // --- Import images button (supports HEIF/HEIC) ---
  document.getElementById("import-images-btn").addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = "image/*,.heif,.heic";
    input.addEventListener("change", () => {
      if (!input.files || input.files.length === 0) return;
      const cursorWorld = screenToWorld(state.lastMousePos.x, state.lastMousePos.y);
      const STAGGER = 80;
      for (let i = 0; i < input.files.length; i++) {
        const file = input.files[i];
        if (isImageFile(file)) {
          handleImageFile(file, cursorWorld.x + i * STAGGER, cursorWorld.y + i * STAGGER);
        }
      }
    });
    input.click();
  });

  // --- Center canvas button ---
  centerCanvasBtn.addEventListener("click", () => {
    if (state.selectedElements.length > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      state.selectedElements.forEach((el) => {
        let b = el.elementType === "image" ? { x: el.x, y: el.y, w: el.w, h: el.h } : getShapeBounds(el);
        if (b.x < minX) minX = b.x; if (b.y < minY) minY = b.y;
        if (b.x + b.w > maxX) maxX = b.x + b.w; if (b.y + b.h > maxY) maxY = b.y + b.h;
      });
      const centerX = (minX + maxX) / 2, centerY = (minY + maxY) / 2;
      state.transform.x = -centerX * state.transform.zoom + canvas.width / 2;
      state.transform.y = -centerY * state.transform.zoom + canvas.height / 2;
      render();
      showToast("Centered view on selected item" + (state.selectedElements.length > 1 ? "s" : ""));
    } else {
      state.transform.x = 0; state.transform.y = 0; render();
      showToast("Centered camera view to coordinate (0,0)");
    }
  });

  // --- Zoom slider ---
  zoomSlider.addEventListener("input", (e) => {
    const targetZoom = parseFloat(e.target.value) / 100;
    applyZoom(targetZoom, window.innerWidth / 2, window.innerHeight / 2);
    scheduleSave();
  });
  zoomSlider.addEventListener("change", () => zoomSlider.blur());

  // --- Wheel ---
  // Prevent browser zoom (pinch/ctrl+scroll) over UI elements while allowing normal scroll
  const uiPanels = document.querySelectorAll("#toolbar, #toolbar-menu, #color-popup, #alignment-panel, #filter-preview-overlay");
  uiPanels.forEach((panel) => {
    panel.addEventListener("wheel", (e) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    }, { passive: false });
  });

  container.addEventListener("wheel", (e) => {
    // Don't zoom/pan when cursor is over app UI elements (toolbar, menus, panels)
    const uiRoot = e.target.closest("#toolbar, #toolbar-menu, #color-popup, #alignment-panel, #filter-preview-overlay, #accessibility-preview-panel, .toast");
    if (uiRoot) return;

    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // Normalize deltaY: trackpad pinch (Mac) sends small values (~1-5),
      // but Ctrl+scroll wheel (Windows) sends large values (~100-120 per notch).
      // Clamp the zoom factor to avoid extreme jumps or negative values.
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const zoomFactor = Math.max(0.5, Math.min(2.0, 1 - delta * 0.01));
      applyZoom(state.transform.zoom * zoomFactor, e.clientX, e.clientY);
    } else {
      state.transform.x -= e.deltaX; state.transform.y -= e.deltaY;
      updateZoomSliderValue(); render();
    }
    scheduleSave();
  }, { passive: false });

  // --- Paste/Drop ---
  window.addEventListener("paste", handlePaste);
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    // Check if this is a drag from the accessibility preview panel
    if (e.dataTransfer && e.dataTransfer.types.includes("application/x-a11y-preview")) {
      handleAccessibilityPreviewDrop(e);
      return;
    }
    if (e.dataTransfer && e.dataTransfer.files.length > 0) {
      const dropWorldPos = screenToWorld(e.clientX, e.clientY);
      for (let file of e.dataTransfer.files) {
        if (isImageFile(file)) handleImageFile(file, dropWorldPos.x, dropWorldPos.y);
      }
    }
  });

  // Copy event to write internal marker
  document.addEventListener("copy", (e) => {
    if (state.pendingInternalCopy) { e.preventDefault(); e.clipboardData.setData("text/plain", CONSTANTS.INTERNAL_COPY_MIME); }
  });

  // --- Keyboard shortcuts ---
  setupKeyboardHandlers();

  // --- Mouse events ---
  setupMouseHandlers();

  // --- Text editor overlay ---
  textEditor.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); bakeText(); container.focus(); }
    else if (e.key === "Escape") { dismissTextEditor(); container.focus(); render(); }
  });
  textEditor.addEventListener("input", () => autoResizeTextEditor());
  textEditor.addEventListener("mousedown", (e) => e.stopPropagation());
  textEditor.addEventListener("mouseup", (e) => e.stopPropagation());
  textEditor.addEventListener("click", (e) => e.stopPropagation());
  textEditor.addEventListener("paste", (e) => {
    e.preventDefault();
    const html = e.clipboardData.getData("text/html");
    if (html) {
      // Insert rich text preserving formatting (bold, italic, underline, strikethrough, font size)
      // Clean the HTML to only allow safe formatting tags/styles
      const temp = document.createElement("div");
      temp.innerHTML = html;
      // Remove scripts, styles, and other non-content elements
      temp.querySelectorAll("script, style, meta, link, head, title").forEach((el) => el.remove());
      // Insert the sanitized HTML
      document.execCommand("insertHTML", false, temp.innerHTML);
    } else {
      const text = e.clipboardData.getData("text/plain");
      document.execCommand("insertText", false, text);
    }
  });

  // --- Text formatting controls (in secondary toolbar) ---
  const fmtBoldBtn = document.getElementById("fmt-bold");
  const fmtItalicBtn = document.getElementById("fmt-italic");
  const fmtUnderlineBtn = document.getElementById("fmt-underline");
  const fmtStrikethroughBtn = document.getElementById("fmt-strikethrough");
  const fmtFontSizeInput = document.getElementById("fmt-font-size");
  const fmtSizeDownBtn = document.getElementById("fmt-size-down");
  const fmtSizeUpBtn = document.getElementById("fmt-size-up");

  // Helper: ensure a text element has segments (creates one segment per line from plain text)
  function ensureSegments(el) {
    if (!el.segments || el.segments.length === 0) {
      const lines = el.text.split("\n");
      el.segments = lines.map((text, line) => ({ text, line, bold: false, italic: false, underline: false, strikethrough: false, fontSize: el.fontSize }));
    }
  }

  // Helper: toggle a style property on all segments of selected text elements (when not editing inline)
  function toggleStyleOnSelectedElements(prop) {
    const textEls = state.selectedElements.filter((el) => el.elementType === "text");
    if (textEls.length === 0) return false;
    pushUndo();
    textEls.forEach((el) => {
      ensureSegments(el);
      // Determine current state: if ALL segments have the property, toggle it off; otherwise on
      const allHave = el.segments.every((s) => s[prop]);
      el.segments.forEach((s) => { s[prop] = !allHave; });
      el.w = null;
      el.h = null;
    });
    render();
    updateFormatBarState();
    return true;
  }

  fmtBoldBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (textEditor.style.display === "block") {
      document.execCommand("bold");
    } else {
      toggleStyleOnSelectedElements("bold");
    }
    updateFormatBarState();
  });
  fmtItalicBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (textEditor.style.display === "block") {
      document.execCommand("italic");
    } else {
      toggleStyleOnSelectedElements("italic");
    }
    updateFormatBarState();
  });
  fmtUnderlineBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (textEditor.style.display === "block") {
      document.execCommand("underline");
    } else {
      toggleStyleOnSelectedElements("underline");
    }
    updateFormatBarState();
  });
  fmtStrikethroughBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (textEditor.style.display === "block") {
      document.execCommand("strikeThrough");
    } else {
      toggleStyleOnSelectedElements("strikethrough");
    }
    updateFormatBarState();
  });

  // Font size adjustment via format bar
  function applyFontSizeToSelection(size) {
    // Save the current selection
    const sel = window.getSelection();
    const savedRange = sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;

    // Use fontSize command with a placeholder, then replace with inline style
    document.execCommand("fontSize", false, "7");
    const fontElements = textEditor.querySelectorAll('font[size="7"]');
    fontElements.forEach((el) => {
      const span = document.createElement("span");
      // Store world-unit size as data attribute for extraction, display at zoom-scaled size
      span.dataset.worldFontSize = size;
      span.style.fontSize = (size * state.transform.zoom) + "px";
      span.innerHTML = el.innerHTML;
      el.parentNode.replaceChild(span, el);
      // Update selection to point inside the new span
      if (sel.rangeCount > 0) {
        const range = document.createRange();
        range.selectNodeContents(span);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });
    fmtFontSizeInput.value = size;
    autoResizeTextEditor();
  }

  // Helper: apply font size to selected text elements (when not editing inline)
  function applyFontSizeToSelectedElements(size) {
    const textEls = state.selectedElements.filter((el) => el.elementType === "text");
    if (textEls.length === 0) return;
    pushUndo();
    textEls.forEach((el) => {
      if (el.segments && el.segments.length > 0) {
        el.segments.forEach((s) => { s.fontSize = size; });
      }
      if (el.textWidth) {
        const scale = size / el.fontSize;
        el.textWidth = el.textWidth * scale;
      }
      el.fontSize = size;
      el.w = null;
      el.h = null;
    });
    fmtFontSizeInput.value = size;
    render();
  }

  fmtSizeDownBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const currentSize = parseInt(fmtFontSizeInput.value) || state.currentFontSize;
    const newSize = Math.max(8, currentSize - 4);
    if (textEditor.style.display === "block") {
      applyFontSizeToSelection(newSize);
    } else {
      const textEls = state.selectedElements.filter((el) => el.elementType === "text");
      if (textEls.length > 0) {
        applyFontSizeToSelectedElements(newSize);
      } else {
        state.currentFontSize = newSize;
        fmtFontSizeInput.value = newSize;
      }
    }
  });

  fmtSizeUpBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const currentSize = parseInt(fmtFontSizeInput.value) || state.currentFontSize;
    const newSize = Math.min(999, currentSize + 4);
    if (textEditor.style.display === "block") {
      applyFontSizeToSelection(newSize);
    } else {
      const textEls = state.selectedElements.filter((el) => el.elementType === "text");
      if (textEls.length > 0) {
        applyFontSizeToSelectedElements(newSize);
      } else {
        state.currentFontSize = newSize;
        fmtFontSizeInput.value = newSize;
      }
    }
  });

  fmtFontSizeInput.addEventListener("change", (e) => {
    const size = Math.max(8, Math.min(999, parseInt(e.target.value) || state.currentFontSize));
    e.target.value = size;
    if (textEditor.style.display === "block") {
      applyFontSizeToSelection(size);
      textEditor.focus();
    } else {
      const textEls = state.selectedElements.filter((el) => el.elementType === "text");
      if (textEls.length > 0) {
        applyFontSizeToSelectedElements(size);
      } else {
        state.currentFontSize = size;
      }
    }
  });

  fmtFontSizeInput.addEventListener("mousedown", (e) => {
    e.stopPropagation();
  });

  // Update format bar button active states based on current selection
  function updateFormatBarState() {
    if (textEditor.style.display === "block") {
      // Inline editing mode: use execCommand state
      fmtBoldBtn.classList.toggle("active", document.queryCommandState("bold"));
      fmtItalicBtn.classList.toggle("active", document.queryCommandState("italic"));
      fmtUnderlineBtn.classList.toggle("active", document.queryCommandState("underline"));
      fmtStrikethroughBtn.classList.toggle("active", document.queryCommandState("strikeThrough"));
      // Update font size input from selection
      const sel = window.getSelection();
      if (sel.rangeCount > 0 && textEditor.contains(sel.anchorNode)) {
        let node = sel.anchorNode;
        if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
        let fontSize = null;
        let el = node;
        while (el && el !== textEditor) {
          if (el.dataset && el.dataset.worldFontSize) {
            fontSize = parseInt(el.dataset.worldFontSize);
            break;
          } else if (el.style && el.style.fontSize) {
            fontSize = Math.round(parseInt(el.style.fontSize) / state.transform.zoom);
            break;
          }
          el = el.parentElement;
        }
        if (fontSize) {
          fmtFontSizeInput.value = fontSize;
        } else {
          fmtFontSizeInput.value = state.currentFontSize;
        }
      }
    } else {
      // Selection mode: reflect state of selected text elements
      const textEls = state.selectedElements.filter((el) => el.elementType === "text");
      if (textEls.length > 0) {
        const allSegs = textEls.flatMap((el) => el.segments || []);
        if (allSegs.length > 0) {
          fmtBoldBtn.classList.toggle("active", allSegs.every((s) => s.bold));
          fmtItalicBtn.classList.toggle("active", allSegs.every((s) => s.italic));
          fmtUnderlineBtn.classList.toggle("active", allSegs.every((s) => s.underline));
          fmtStrikethroughBtn.classList.toggle("active", allSegs.every((s) => s.strikethrough));
        } else {
          fmtBoldBtn.classList.remove("active");
          fmtItalicBtn.classList.remove("active");
          fmtUnderlineBtn.classList.remove("active");
          fmtStrikethroughBtn.classList.remove("active");
        }
        fmtFontSizeInput.value = textEls[0].fontSize;
      } else {
        fmtBoldBtn.classList.remove("active");
        fmtItalicBtn.classList.remove("active");
        fmtUnderlineBtn.classList.remove("active");
        fmtStrikethroughBtn.classList.remove("active");
        fmtFontSizeInput.value = state.currentFontSize;
      }
    }
  }

  textEditor.addEventListener("keyup", () => updateFormatBarState());
  textEditor.addEventListener("mouseup", () => setTimeout(updateFormatBarState, 10));

  // No-op: format bar is now always visible in the secondary toolbar when text tool is active
  window._textFormatBar = { show() { updateFormatBarState(); }, hide() {}, position() {}, updateState: updateFormatBarState };

  // --- Initial setup ---
  updateCursor();
  resizeRulers();
  setRulersVisible(false);
  resize();
}

// --- Helper functions used within initEventHandlers ---

function bakeText() {
  const dom = getDom();
  const { textEditor } = dom;
  const richContent = extractRichContent();
  const val = richContent.text.trim();
  if (val && state.activeTextCoord) {
    pushUndo();
    const textEl = {
      id: "text_" + state.elementIdCounter++,
      elementType: "text",
      type: "text",
      text: val,
      color: textEditor.style.color || state.textDrawColor,
      fontSize: state.currentFontSize,
      fontFamily: state.currentFontFamily,
      start: { x: state.activeTextCoord.x, y: state.activeTextCoord.y },
    };
    // Store rich segments if any formatting exists
    if (richContent.segments && richContent.segments.some((s) => s.bold || s.italic || s.underline || s.strikethrough || s.fontSize)) {
      // Adjust segments for any leading lines removed by trim
      const leadingNewlines = richContent.text.length - richContent.text.trimStart().length;
      let leadingLinesTrimmed = 0;
      if (leadingNewlines > 0) {
        leadingLinesTrimmed = (richContent.text.slice(0, leadingNewlines).match(/\n/g) || []).length;
      }
      const trimmedLineCount = val.split("\n").length;
      const maxLine = trimmedLineCount - 1;
      const adjusted = richContent.segments
        .map((s) => ({ ...s, line: s.line - leadingLinesTrimmed }))
        .filter((s) => s.line >= 0 && s.line <= maxLine);
      if (adjusted.length > 0) {
        textEl.segments = adjusted;
        // Update element fontSize to the max segment fontSize so that
        // lineHeight, bounds, and layout calculations reflect the actual
        // rendered size on canvas.
        let maxSegFontSize = 0;
        adjusted.forEach((s) => {
          if (s.fontSize && s.fontSize > maxSegFontSize) maxSegFontSize = s.fontSize;
        });
        if (maxSegFontSize > 0) {
          textEl.fontSize = maxSegFontSize;
        }
      }
    }
    if (textEditor.dataset.bgColor) {
      textEl.bgColor = textEditor.dataset.bgColor;
    }
    if (state.currentTextAlign && state.currentTextAlign !== "left") {
      textEl.textAlign = state.currentTextAlign;
    }
    state.drawings.push(textEl);
    spatialInsert(textEl);
  }
  dismissTextEditor();
  render();
}

function dismissTextEditor() {
  const { textEditor } = getDom();
  textEditor.style.display = "none";
  textEditor.style.background = "transparent";
  textEditor.style.border = "1px dashed #007acc";
  textEditor.style.outline = "none";
  textEditor.style.padding = "2px";
  textEditor.style.boxSizing = "content-box";
  textEditor.style.whiteSpace = "pre-wrap";
  textEditor.style.wordBreak = "break-word";
  textEditor.dataset.bgColor = "";
  textEditor.textContent = "";
  state.activeTextCoord = null;
  if (window._textFormatBar) window._textFormatBar.hide();
}

/**
 * Extract rich text content from the contenteditable editor.
 * Returns { text: string, segments: Array<{text, bold, italic, line}> }
 * Each segment represents a styled run within a line.
 *
 * Strategy: First get the plain text (using innerText which respects line breaks),
 * then walk the DOM collecting styled character ranges that map to that text.
 */
function extractRichContent() {
  const { textEditor } = getDom();

  // innerText gives us the user-visible text with \n for line breaks
  const fullText = textEditor.innerText || "";
  const lines = fullText.split("\n");

  // Walk the DOM tree, collecting a flat list of {char, bold, italic} entries
  const chars = [];

  function getStyle(node) {
    let bold = false, italic = false, underline = false, strikethrough = false, fontSize = null;
    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (el && el !== textEditor) {
      const tag = el.nodeName;
      if (tag === "B" || tag === "STRONG") bold = true;
      if (tag === "I" || tag === "EM") italic = true;
      if (tag === "U") underline = true;
      if (tag === "S" || tag === "STRIKE" || tag === "DEL") strikethrough = true;
      if (el.style) {
        if (el.style.fontWeight === "bold" || parseInt(el.style.fontWeight) >= 700) bold = true;
        if (el.style.fontStyle === "italic") italic = true;
        if (el.style.textDecoration) {
          if (el.style.textDecoration.includes("underline")) underline = true;
          if (el.style.textDecoration.includes("line-through")) strikethrough = true;
        }
        if (el.style.textDecorationLine) {
          if (el.style.textDecorationLine.includes("underline")) underline = true;
          if (el.style.textDecorationLine.includes("line-through")) strikethrough = true;
        }
        if (!fontSize) {
          // Prefer world-unit size stored in data attribute (set by format bar)
          if (el.dataset && el.dataset.worldFontSize) {
            fontSize = parseInt(el.dataset.worldFontSize);
          } else if (el.style.fontSize) {
            fontSize = Math.round(parseInt(el.style.fontSize) / state.transform.zoom);
          }
        }
      }
      el = el.parentElement;
    }
    return { bold, italic, underline, strikethrough, fontSize };
  }

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const { bold, italic, underline, strikethrough, fontSize } = getStyle(node);
      for (const ch of node.textContent) {
        chars.push({ ch, bold, italic, underline, strikethrough, fontSize });
      }
    } else if (node.nodeName === "BR") {
      chars.push({ ch: "\n", bold: false, italic: false, underline: false, strikethrough: false, fontSize: null });
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const isBlock = node.nodeName === "DIV" || node.nodeName === "P";
      // Block elements imply a newline before them (unless at start)
      if (isBlock && chars.length > 0 && chars[chars.length - 1].ch !== "\n") {
        chars.push({ ch: "\n", bold: false, italic: false, underline: false, strikethrough: false, fontSize: null });
      }
      node.childNodes.forEach((child) => walk(child));
    }
  }

  textEditor.childNodes.forEach((child) => walk(child));

  // Now build segments from the chars array, grouped by line
  const segments = [];
  let lineIndex = 0;
  let currentSeg = null;

  for (const { ch, bold, italic, underline, strikethrough, fontSize } of chars) {
    if (ch === "\n") {
      if (currentSeg) {
        segments.push(currentSeg);
        currentSeg = null;
      }
      lineIndex++;
      continue;
    }
    if (currentSeg && currentSeg.bold === bold && currentSeg.italic === italic && currentSeg.underline === underline && currentSeg.strikethrough === strikethrough && currentSeg.fontSize === fontSize && currentSeg.line === lineIndex) {
      currentSeg.text += ch;
    } else {
      if (currentSeg) segments.push(currentSeg);
      currentSeg = { text: ch, bold, italic, underline, strikethrough, fontSize, line: lineIndex };
    }
  }
  if (currentSeg) segments.push(currentSeg);

  // Use innerText as the canonical plain text
  return { text: fullText, segments };
}

function getTextEditorContent() {
  return extractRichContent().text;
}

function setTextEditorContent(text, segments) {
  const { textEditor } = getDom();
  textEditor.textContent = "";
  if (!text) return;

  if (segments && segments.length > 0) {
    // Restore rich content from segments
    let currentLine = 0;
    segments.forEach((seg) => {
      while (currentLine < seg.line) {
        textEditor.appendChild(document.createElement("br"));
        currentLine++;
      }
      if (seg.bold || seg.italic || seg.underline || seg.strikethrough || seg.fontSize) {
        const span = document.createElement("span");
        let fontStyle = "";
        if (seg.bold) fontStyle += "font-weight:bold;";
        if (seg.italic) fontStyle += "font-style:italic;";
        const decorations = [];
        if (seg.underline) decorations.push("underline");
        if (seg.strikethrough) decorations.push("line-through");
        if (decorations.length > 0) fontStyle += `text-decoration:${decorations.join(" ")};`;
        if (seg.fontSize) {
          fontStyle += `font-size:${seg.fontSize * state.transform.zoom}px;`;
          span.dataset.worldFontSize = seg.fontSize;
        }
        span.style.cssText = fontStyle;
        span.textContent = seg.text;
        textEditor.appendChild(span);
      } else {
        textEditor.appendChild(document.createTextNode(seg.text));
      }
    });
  } else {
    // Plain text fallback
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (i > 0) textEditor.appendChild(document.createElement("br"));
      if (line) textEditor.appendChild(document.createTextNode(line));
    });
  }
}

function autoResizeTextEditor() {
  const { textEditor, ctx } = getDom();
  const screenFontSize = parseFloat(textEditor.style.fontSize) || 28;

  // Find the largest inline font size in the editor for proper sizing
  let maxInlineFontSize = screenFontSize;
  textEditor.querySelectorAll("[style*='font-size']").forEach((el) => {
    const fs = parseFloat(el.style.fontSize);
    if (fs > maxInlineFontSize) maxInlineFontSize = fs;
  });

  ctx.save();
  ctx.font = `${maxInlineFontSize}px ${state.currentFontFamily || "sans-serif"}`;
  const text = getTextEditorContent();
  const lines = text.split("\n");
  let maxWidth = 0;
  lines.forEach((line) => {
    const w = ctx.measureText(line || " ").width;
    if (w > maxWidth) maxWidth = w;
  });
  ctx.restore();

  const isNote = !!textEditor.dataset.bgColor;
  const borderWidth = 1; // 1px border on each side

  // Width: fit content + cursor padding; add extra buffer to prevent premature
  // line wrapping at low zoom where sub-pixel rounding causes measureText to
  // underestimate the space the browser needs for the contenteditable text.
  const minWidth = maxInlineFontSize * 1.5;
  if (isNote) {
    // Use border-box so that width/height include padding, matching the canvas note background size.
    // Note uses outline instead of border so border doesn't affect box size.
    const notePadding = parseFloat(textEditor.style.padding) || 0;
    textEditor.style.boxSizing = "border-box";
    // Total width matches canvas: textWidth + 2*padding
    const totalWidth = maxWidth + notePadding * 2;
    textEditor.style.width = Math.max(minWidth + notePadding * 2, totalWidth) + "px";
    // Total height matches canvas: textHeight + 2*padding
    // Keep one trailing empty line (user pressed Enter) but strip extra browser
    // placeholder lines. This makes the background grow on Enter.
    let effectiveLineCount = lines.length;
    // Strip at most one extra trailing empty line (browser cursor placeholder)
    if (effectiveLineCount > 1 && lines[effectiveLineCount - 1] === "" && lines[effectiveLineCount - 2] === "") {
      effectiveLineCount--;
    }
    const lineHeight = maxInlineFontSize * 1.2;
    const textHeight = lineHeight * (effectiveLineCount - 1) + maxInlineFontSize;
    const totalHeight = textHeight + notePadding * 2;
    textEditor.style.height = Math.max(lineHeight + notePadding * 2, totalHeight) + "px";
  } else {
    textEditor.style.boxSizing = "content-box";
    const widthBuffer = maxInlineFontSize * 0.8;
    textEditor.style.width = Math.max(minWidth, maxWidth + widthBuffer) + "px";
    // Height: auto-fit based on line count.
    const lineHeight = maxInlineFontSize * 1.2;
    const minHeight = lineHeight;
    const verticalChrome = 6; // padding + border vertical space
    const buffer = Math.max(4, lineHeight * 0.3);
    textEditor.style.height = Math.max(minHeight, lines.length * lineHeight + verticalChrome + buffer) + "px";
  }
}

// HEIF/HEIC file extensions that may not have a recognized MIME type
const HEIF_EXTENSIONS = [".heif", ".heic"];
const HEIF_MIME_TYPES = ["image/heif", "image/heic", "image/heif-sequence", "image/heic-sequence"];

function isImageFile(file) {
  if (file.type.indexOf("image/") === 0) return true;
  // Check for HEIF/HEIC by extension when MIME type is empty or unrecognized
  const name = (file.name || "").toLowerCase();
  return HEIF_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function handleImageFile(file, worldX, worldY) {
  const name = (file.name || "").toLowerCase();
  const isHeif = HEIF_MIME_TYPES.includes(file.type) || HEIF_EXTENSIONS.some((ext) => name.endsWith(ext));

  const reader = new FileReader();
  reader.onload = (event) => {
    const img = new Image();
    img.onload = () => {
      pushUndo();
      const newImg = {
        id: "img_" + state.elementIdCounter++,
        elementType: "image",
        img: img,
        x: worldX - img.width / 2,
        y: worldY - img.height / 2,
        w: img.width,
        h: img.height,
      };
      state.images.push(newImg);
      spatialInsert(newImg);
      render();
      if (isHeif) showToast("Imported HEIF/HEIC image");
    };
    img.onerror = () => {
      if (isHeif) {
        showToast("HEIF/HEIC not supported by this browser — try Safari or convert to PNG/JPEG first");
      }
    };
    img.src = event.target.result;
  };
  reader.readAsDataURL(file);
}

function checkAndEraseAtPosition(worldPos) {
  let erasedSomething = false;
  const erasedIds = [];
  for (let i = state.drawings.length - 1; i >= 0; i--) {
    if (state.drawings[i].locked) continue;
    if (isPointHittingShape(worldPos, state.drawings[i])) {
      if (!erasedSomething) pushUndo();
      const hit = state.drawings[i];
      // If the hit element belongs to a group, remove all group members
      if (hit.groupId) {
        for (let j = state.drawings.length - 1; j >= 0; j--) {
          if (state.drawings[j].groupId === hit.groupId) {
            erasedIds.push(state.drawings[j].id);
            spatialRemove(state.drawings[j]);
            state.drawings.splice(j, 1);
          }
        }
      } else {
        erasedIds.push(hit.id);
        spatialRemove(hit);
        state.drawings.splice(i, 1);
      }
      erasedSomething = true;
      break;
    }
  }
  if (erasedSomething) {
    for (const shape of state.drawings) {
      if (shape.type !== "connector") continue;
      if (shape.startConn && erasedIds.includes(shape.startConn.elementId)) {
        shape.startConn = null;
      }
      if (shape.endConn && erasedIds.includes(shape.endConn.elementId)) {
        shape.endConn = null;
      }
    }
    render();
  }
}

function handlePaste(e) {
  const dom = getDom();
  const { textEditor } = dom;
  if (textEditor.style.display === "block" && textEditor.contains(document.activeElement)) return;

  // Allow paste in custom color dialogs and other standard inputs/textareas
  const activeEl = document.activeElement;
  if (activeEl && (activeEl.tagName === "TEXTAREA" || (activeEl.tagName === "INPUT" && activeEl.type === "text"))) {
    return;
  }

  const clipboardData = e.clipboardData || e.originalEvent.clipboardData;
  const items = clipboardData.items;
  const imageBlobs = [];
  for (let item of items) {
    if (item.type.indexOf("image") === 0) {
      imageBlobs.push(item.getAsFile());
    }
  }

  // Check for cross-tab serialized element data
  const text = clipboardData.getData("text/plain");
  if (text && text.startsWith(CONSTANTS.INTERNAL_COPY_MIME + "\n")) {
    // Parse the copy ID and JSON from the payload (format: MIME\ncopyId\nJSON)
    const afterMime = text.slice(CONSTANTS.INTERNAL_COPY_MIME.length + 1);
    const newlineIdx = afterMime.indexOf("\n");
    const payloadCopyId = newlineIdx !== -1 ? afterMime.slice(0, newlineIdx) : null;
    const jsonStr = newlineIdx !== -1 ? afterMime.slice(newlineIdx + 1) : afterMime;

    // Same-tab paste: only use local clipboard if the copy ID matches this tab's last copy
    if (state.internalCopyPerformed && state.clipboardElements.length > 0 && payloadCopyId && payloadCopyId === state.internalCopyId) {
      e.preventDefault();
      pasteFromClipboard();
      return;
    }
    // Cross-tab paste (or copy ID mismatch): deserialize from clipboard text
    try {
      const serialized = JSON.parse(jsonStr);
      if (Array.isArray(serialized) && serialized.length > 0) {
        e.preventDefault();
        pasteFromSerializedClipboard(serialized);
        return;
      }
    } catch (err) {
      // JSON parse failed, fall through to other paste handling
    }
  }

  // Legacy same-tab fallback: check old marker format
  if (state.internalCopyPerformed && state.clipboardElements.length > 0) {
    const isStillInternal = !imageBlobs.length && text === CONSTANTS.INTERNAL_COPY_MIME;
    if (isStillInternal) {
      e.preventDefault();
      pasteFromClipboard();
      return;
    }
    state.internalCopyPerformed = false;
    state.clipboardElements = [];
  }

  if (imageBlobs.length > 0) {
    e.preventDefault();
    pushUndo();
    const cursorWorld = screenToWorld(state.lastMousePos.x, state.lastMousePos.y);
    const sortedBlobs = [...imageBlobs].sort((a, b) => {
      const nameA = (a.name || "").toLowerCase();
      const nameB = (b.name || "").toLowerCase();
      return nameA.localeCompare(nameB, undefined, { numeric: true });
    });
    const pastedElements = new Array(sortedBlobs.length);
    let loadedCount = 0;
    const STAGGER_X = 150, STAGGER_Y = 80;
    sortedBlobs.forEach((blob, index) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          const offsetX = index * STAGGER_X;
          const offsetY = index * STAGGER_Y;
          const element = {
            id: "img_" + state.elementIdCounter++,
            elementType: "image",
            img: img,
            x: cursorWorld.x - img.width / 2 + offsetX,
            y: cursorWorld.y - img.height / 2 + offsetY,
            w: img.width,
            h: img.height,
          };
          pastedElements[index] = element;
          loadedCount++;
          if (loadedCount === sortedBlobs.length) {
            for (const el of pastedElements) {
              state.images.push(el);
              spatialInsert(el);
            }
            state.selectedElements = pastedElements;
            state.currentTool = "select";
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
  } else if (state.clipboardElements.length > 0) {
    e.preventDefault();
    pasteFromClipboard();
  } else {
    if (text && text.trim().length > 0) {
      e.preventDefault();
      pasteTextToCanvas(text.trim());
    }
  }
}

function setupKeyboardHandlers() {
  const dom = getDom();
  const { container, textEditor, colorPicker } = dom;

  window.addEventListener("keydown", (e) => {
    if (e.key === "Meta") {
      state.isMetaPressed = true;
      if (state.currentTool === "split-line") render();
      if (state.currentTool === "measure" && state.activeMeasureLine) render();
    }
    if (e.key === "Control") {
      state.isCtrlPressed = true;
      if (state.currentTool === "split-line") render();
      if (state.currentTool === "measure" && state.activeMeasureLine) render();
    }
    if (e.key === "Shift") {
      state.isShiftPressed = true;
      if (state.currentTool === "split-line") render();
    }
    if (e.key === " " || e.code === "Space") {
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
      // Shift+Space: open command palette
      if (e.shiftKey) {
        e.preventDefault();
        toggleCommandPalette();
        return;
      }
      e.preventDefault();
      if (!state.isSpacePressed) {
        state.isSpacePressed = true;
        if (state.currentTool !== "pan") {
          state.preSpaceTool = state.currentTool;
          state.currentTool = "pan";
          updateToolbarUI();
          updateCursor();
        }
      }
    }
  });

  window.addEventListener("keyup", (e) => {
    if (e.key === "Meta") {
      state.isMetaPressed = false;
      if (state.currentTool === "split-line") render();
      if (state.currentTool === "measure" && state.activeMeasureLine) render();
    }
    if (e.key === "Control") {
      state.isCtrlPressed = false;
      if (state.currentTool === "split-line") render();
      if (state.currentTool === "measure" && state.activeMeasureLine) render();
    }
    if (e.key === "Shift") {
      state.isShiftPressed = false;
      if (state.currentTool === "split-line") render();
      state.panLockDirection = null;
      if (state.activeSnapGuides.length > 0) {
        state.activeSnapGuides = [];
        state.activeProximityGuides = [];
        state.activeSpacingGuides = [];
        render();
      }
    }
    if (e.key === " " || e.code === "Space") {
      if (state.isSpacePressed) {
        state.isSpacePressed = false;
        if (state.preSpaceTool !== null) {
          state.currentTool = state.preSpaceTool;
          state.preSpaceTool = null;
          updateToolbarUI();
          updateCursor();
          render();
        }
      }
    }
  });

  window.addEventListener("blur", () => {
    state.isShiftPressed = false;
    state.isMetaPressed = false;
    state.isCtrlPressed = false;
    state.isSpacePressed = false;
    state.panLockDirection = null;
    if (state.preSpaceTool !== null) {
      state.currentTool = state.preSpaceTool;
      state.preSpaceTool = null;
      updateToolbarUI();
      updateCursor();
    }
    render();
  });

  // Reset modifier state when window regains focus (e.g. after macOS screenshot Cmd+Shift+4
  // which steals focus without triggering blur, leaving shift/meta stuck)
  window.addEventListener("focus", () => {
    state.isShiftPressed = false;
    state.isMetaPressed = false;
    state.isCtrlPressed = false;
    state.panLockDirection = null;
  });

  // Intercept Cmd/Ctrl+O
  window.addEventListener("keydown", (e) => {
    const isMod = e.metaKey || e.ctrlKey;
    if (isMod && e.key.toLowerCase() === "o") {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;

    // Crop mode keyboard shortcuts
    if (state.cropMode) {
      if (e.key === "Enter") { e.preventDefault(); exitCropMode(true); return; }
      if (e.key === "Escape") { e.preventDefault(); exitCropMode(false); return; }
      return;
    }

    // Marquee mode keyboard shortcuts
    if (state.marqueeMode) {
      if (e.key === "Enter") { e.preventDefault(); marqueeCommit(); return; }
      if (e.key === "Escape") { e.preventDefault(); exitMarqueeMode(); return; }
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); marqueeCut(); return; }
      // Don't intercept other keys in marquee mode so Cmd+C/X still work from the meta handler
    }

    // Enter — finish bézier path
    if (e.key === "Enter" && state.currentTool === "bezier-pen") {
      if (bezierPenKeyDown(e)) {
        e.preventDefault();
        return;
      }
    }

    // Enter — commit laser trails as permanent drawings
    if (e.key === "Enter" && state.currentTool === "laser") {
      e.preventDefault();
      const elements = commitLaserTrails();
      if (elements.length > 0) {
        pushUndo();
        for (const el of elements) {
          state.drawings.push(el);
          spatialInsert(el);
        }
        scheduleSave();
      }
      render();
      return;
    }

    // Escape
    if (e.key === "Escape") {
      e.preventDefault();
      // Bézier pen tool handles Escape/Enter/Backspace
      if (state.currentTool === "bezier-pen" && bezierPenKeyDown(e)) {
        return;
      }
      if (state.currentTool === "laser") {
        clearLaserTrails();
        render();
        return;
      }
      if (isAccessibilityPreviewModalOpen()) {
        deactivateAccessibilityPreview();
        state.currentTool = "select";
        updateToolbarUI();
        updateCursor();
        render();
      } else if (state.selectedElements.length > 0) {
        state.selectedElements = [];
        toggleAlignmentPanelVisibility();
        render();
      } else if (state.currentTool !== "select") {
        state.currentTool = "select";
        updateToolbarUI();
        updateCursor();
        render();
      }
      if (document.activeElement && document.activeElement !== document.body) {
        document.activeElement.blur();
      }
      return;
    }

    const key = e.key.toLowerCase();

    // Shift+Plus / Shift+Minus adjust font size; plain +/- adjust zoom
    // When shift is held, match the physical key codes for +/- across layouts
    // US: Equal(+/=), Minus(-/_)  Nordic: Minus(+), Slash(-)  Also support numpad
    // Note: BracketRight is NOT included here to avoid conflicting with Cmd+]/[ z-index shortcuts
    const isPlusMinusCode = e.code === "Equal" || e.code === "Minus" || e.code === "Slash" ||
      e.code === "NumpadAdd" || e.code === "NumpadSubtract";
    const isPlusMinusKey = e.key === "+" || e.key === "-" || e.key === "=" || e.key === "_";
    if (e.shiftKey && !e.metaKey && !e.ctrlKey && (isPlusMinusKey || isPlusMinusCode)) {
      // Determine direction: check unshifted key identity via code
      // NumpadAdd / Equal (US +) → increase
      // NumpadSubtract / Slash (Nordic -) → decrease
      // Safest: if the key WITHOUT shift would produce + or =, increase; if - or _, decrease
      // Since shift is held and may change e.key, we rely on code:
      // Codes that are "plus" keys: Equal (US), Minus (Nordic +), NumpadAdd
      // Codes that are "minus" keys: Slash (Nordic -), NumpadSubtract
      // Problem: "Minus" code is + on Nordic but - on US. We need to disambiguate.
      // Solution: check e.key first (if it's recognizable), fall back to code-based heuristic
      let isIncrease;
      if (e.key === "+" || e.key === "=") {
        isIncrease = true;
      } else if (e.key === "-" || e.key === "_") {
        isIncrease = false;
      } else {
        // Shift changed e.key to something unrecognizable; use code heuristic
        // On Nordic: the + physical key has code "Minus", shifted produces "?"
        // On Nordic: the - physical key has code "Slash", shifted produces "_"
        isIncrease = e.code === "Equal" || e.code === "NumpadAdd" || e.code === "Minus";
      }
      e.preventDefault();
      const step = 16;
      // Use the selected text element's font size as base if available
      const selectedTextEl = state.selectedElements.find((el) => el.elementType === "text");
      const baseSize = selectedTextEl ? selectedTextEl.fontSize : state.currentFontSize;
      const newSize = Math.max(4, baseSize + (isIncrease ? step : -step));
      state.currentFontSize = newSize;
      const fmtFontSizeEl = document.getElementById("fmt-font-size");
      if (fmtFontSizeEl) fmtFontSizeEl.value = newSize;
      if (textEditor.style.display === "block") { textEditor.style.fontSize = `${newSize * state.transform.zoom}px`; }
      // Apply to selected text elements
      if (state.selectedElements.length > 0) {
        const hasTextEls = state.selectedElements.some((el) => el.elementType === "text");
        if (hasTextEls) pushUndo();
        state.selectedElements.forEach((el) => {
          if (el.elementType === "text") {
            if (el.segments && el.segments.length > 0) {
              el.segments.forEach((s) => { s.fontSize = newSize; });
            }
            if (el.textWidth) { const scale = newSize / el.fontSize; el.textWidth = el.textWidth * scale; }
            el.fontSize = newSize; el.w = null; el.h = null;
          }
        });
        render();
      }
      showToast(`Font size: ${newSize}px`);
      return;
    }
    if (e.key === "+" || e.key === "=" || e.key === "-" || e.key === "_") { e.preventDefault(); const zoomIn = e.key === "+" || e.key === "="; applyZoom(state.transform.zoom * (zoomIn ? 1.1 : 1/1.1), state.lastMousePos.x, state.lastMousePos.y); return; }

    if (e.key === "Delete" || e.key === "Backspace") {
      // Bézier pen tool handles Delete/Backspace for point deletion
      if (state.currentTool === "bezier-pen" && bezierPenKeyDown(e)) {
        e.preventDefault();
        return;
      }
      if (state.currentTool === "select" && state.selectedElements.length > 0) {
        const unlocked = state.selectedElements.filter((el) => !el.locked);
        if (unlocked.length === 0) { showToast("Cannot delete locked element(s)"); return; }
        pushUndo();
        const idsToRemove = unlocked.map((el) => el.id);
        for (const shape of state.drawings) {
          if (shape.type !== "connector") continue;
          if (shape.startConn && idsToRemove.includes(shape.startConn.elementId)) shape.startConn = null;
          if (shape.endConn && idsToRemove.includes(shape.endConn.elementId)) shape.endConn = null;
        }
        state.images = state.images.filter((img) => !idsToRemove.includes(img.id));
        state.drawings = state.drawings.filter((d) => !idsToRemove.includes(d.id));
        for (const id of idsToRemove) {
          const el = spatialIndex.elements.get(id);
          if (el) spatialRemove(el);
        }
        showToast(`Removed ${unlocked.length} selected asset(s)`);
        state.selectedElements = state.selectedElements.filter((el) => el.locked);
        toggleAlignmentPanelVisibility();
        render();
      }
      return;
    }

    // Cmd+Arrow in pan mode: navigate to nearest image in that direction
    if ((e.metaKey || e.ctrlKey) && !e.altKey &&
        (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") &&
        (state.currentTool === "pan" || state.currentTool === "select" || state.currentTool === "marquee" || state.currentTool === "accessibility-preview")) {
      e.preventDefault();
      if (state.images.length === 0) { showToast("No images on canvas"); return; }
      // Determine current reference point (center of selected image, or viewport center)
      let refX, refY;
      if (state.selectedElements.length === 1 && state.selectedElements[0].elementType === "image") {
        const cur = state.selectedElements[0];
        refX = cur.x + cur.w / 2;
        refY = cur.y + cur.h / 2;
      } else {
        const canvas = document.getElementById("canvas");
        refX = (canvas.width / 2 - state.transform.x) / state.transform.zoom;
        refY = (canvas.height / 2 - state.transform.y) / state.transform.zoom;
      }
      const currentId = state.selectedElements.length === 1 ? state.selectedElements[0].id : null;
      // Find the nearest image in the pressed direction
      let best = null;
      let bestScore = Infinity;
      for (const img of state.images) {
        if (img.id === currentId) continue;
        const cx = img.x + img.w / 2;
        const cy = img.y + img.h / 2;
        const dx = cx - refX;
        const dy = cy - refY;
        let inDirection = false;
        let primaryDist = 0;
        let crossDist = 0;
        if (e.key === "ArrowRight") { inDirection = dx > 1; primaryDist = dx; crossDist = Math.abs(dy); }
        else if (e.key === "ArrowLeft") { inDirection = dx < -1; primaryDist = -dx; crossDist = Math.abs(dy); }
        else if (e.key === "ArrowDown") { inDirection = dy > 1; primaryDist = dy; crossDist = Math.abs(dx); }
        else if (e.key === "ArrowUp") { inDirection = dy < -1; primaryDist = -dy; crossDist = Math.abs(dx); }
        if (!inDirection) continue;
        // Score: prefer small primary distance, penalize cross-axis offset
        const score = primaryDist + crossDist * 0.5;
        if (score < bestScore) { bestScore = score; best = img; }
      }
      if (!best) {
        // Wrap: use reading-order sort to find first/last in direction
        const sorted = [...state.images].sort((a, b) => {
          const aCy = a.y + a.h / 2;
          const bCy = b.y + b.h / 2;
          const rowThreshold = Math.min(a.h, b.h) * 0.5;
          if (Math.abs(aCy - bCy) < rowThreshold) return a.x - b.x;
          return aCy - bCy;
        });
        if (e.key === "ArrowRight" || e.key === "ArrowDown") best = sorted[0];
        else best = sorted[sorted.length - 1];
        if (best && best.id === currentId) {
          // Only one image or already at boundary
          showToast("No more images in that direction");
          return;
        }
      }
      if (best) {
        best.elementType = "image";
        state.selectedElements = [best];
        const centerX = best.x + best.w / 2;
        const centerY = best.y + best.h / 2;
        const canvas = document.getElementById("canvas");
        state.transform.x = -centerX * state.transform.zoom + canvas.width / 2;
        state.transform.y = -centerY * state.transform.zoom + canvas.height / 2;
        updateToolbarUI();
        toggleAlignmentPanelVisibility();
        updateZoomSliderValue();
        render();
      }
      return;
    }

    // Alt+Arrow alignment (with 2+ elements selected)
    if (e.altKey && !e.metaKey && !e.ctrlKey &&
        (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") &&
        state.currentTool === "select" && state.selectedElements.length >= 2) {
      e.preventDefault();
      let alignType = null;
      if (e.key === "ArrowLeft") alignType = "left";
      else if (e.key === "ArrowRight") alignType = "right";
      else if (e.key === "ArrowUp") alignType = "top";
      else if (e.key === "ArrowDown") alignType = "bottom";
      if (alignType) {
        const alignBtn = document.querySelector(`[data-align="${alignType}"]`);
        if (alignBtn) alignBtn.click();
      }
      return;
    }

    // Arrow keys (nudge)
    if ((e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") &&
        state.currentTool === "select" && state.selectedElements.length > 0) {
      e.preventDefault();
      const movable = state.selectedElements.filter((el) => !el.locked);
      if (movable.length === 0) return;
      const step = e.metaKey || e.ctrlKey ? 100 : e.shiftKey ? 10 : 1;
      let dx = 0, dy = 0;
      if (e.key === "ArrowUp") dy = -step;
      if (e.key === "ArrowDown") dy = step;
      if (e.key === "ArrowLeft") dx = -step;
      if (e.key === "ArrowRight") dx = step;
      pushUndo();
      movable.forEach((el) => translateElement(el, dx, dy));
      updateConnectorsForElements(movable.map((el) => el.id));
      for (const el of movable) spatialUpdate(el);
      render();
      return;
    }

    // Arrow keys (pan canvas when nothing is selected)
    if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const panStep = e.shiftKey ? 200 : 50;
      if (e.key === "ArrowUp") state.transform.y += panStep;
      if (e.key === "ArrowDown") state.transform.y -= panStep;
      if (e.key === "ArrowLeft") state.transform.x += panStep;
      if (e.key === "ArrowRight") state.transform.x -= panStep;
      render();
      return;
    }

    // Alignment & Distribution hotkeys (Alt/Option+key, like Figma)
    // Alt+A = Align Left, Alt+D = Align Right, Alt+H = Center Horizontal
    // Alt+W = Align Top, Alt+S = Align Bottom, Alt+V = Center Vertical
    // Alt+Shift+X = Distribute Horizontally, Alt+Shift+Y = Distribute Vertically
    // Note: uses e.code because macOS Option key produces special characters in e.key
    if (e.altKey && !e.metaKey && !e.ctrlKey && state.currentTool === "select" && state.selectedElements.length >= 2) {
      let alignType = null;
      const code = e.code;
      if (code === "KeyA" && !e.shiftKey) alignType = "left";
      else if (code === "KeyD" && !e.shiftKey) alignType = "right";
      else if (code === "KeyH" && !e.shiftKey) alignType = "centerX";
      else if (code === "KeyW" && !e.shiftKey) alignType = "top";
      else if (code === "KeyS" && !e.shiftKey) alignType = "bottom";
      else if (code === "KeyV" && !e.shiftKey) alignType = "centerY";
      else if (code === "KeyX" && e.shiftKey) alignType = "distributeX";
      else if (code === "KeyY" && e.shiftKey) alignType = "distributeY";

      if (alignType) {
        e.preventDefault();
        const alignBtn = document.querySelector(`[data-align="${alignType}"]`);
        if (alignBtn) alignBtn.click();
        return;
      }
    }

    // Alt+P to open filter preview mode (uses e.code for macOS compatibility)
    if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === "KeyP") {
      e.preventDefault();
      if (!isFilterPreviewActive()) openFilterPreview();
      return;
    }

    // Tab / Shift+Tab: navigate to next/previous image in reading order (left-to-right, top-to-bottom)
    if (e.key === "Tab") {
      // When accessibility preview panel is open, it handles its own Tab navigation
      if (isAccessibilityPreviewModalOpen()) return;
      e.preventDefault();
      if (state.images.length === 0) { showToast("No images on canvas"); return; }
      // Sort images in reading order: top-to-bottom first, then left-to-right for same row
      // Two images are considered on the same "row" if their vertical centers are within
      // half the average height of each other.
      const sorted = [...state.images].sort((a, b) => {
        const aCy = a.y + a.h / 2;
        const bCy = b.y + b.h / 2;
        const rowThreshold = Math.min(a.h, b.h) * 0.5;
        if (Math.abs(aCy - bCy) < rowThreshold) {
          // Same row — sort left to right
          return a.x - b.x;
        }
        return aCy - bCy;
      });
      // Find current image in sorted list
      const currentId = state.selectedElements.length === 1 && state.selectedElements[0].elementType === "image"
        ? state.selectedElements[0].id : null;
      let currentIdx = currentId ? sorted.findIndex((img) => img.id === currentId) : -1;
      // Navigate forward (Tab) or backward (Shift+Tab)
      let nextIdx;
      if (e.shiftKey) {
        nextIdx = currentIdx <= 0 ? sorted.length - 1 : currentIdx - 1;
      } else {
        nextIdx = currentIdx >= sorted.length - 1 ? 0 : currentIdx + 1;
      }
      const nextImg = sorted[nextIdx];
      // Select the image
      nextImg.elementType = "image";
      state.selectedElements = [nextImg];
      state.currentTool = "select";
      // Center viewport on the image
      const centerX = nextImg.x + nextImg.w / 2;
      const centerY = nextImg.y + nextImg.h / 2;
      const canvas = document.getElementById("canvas");
      state.transform.x = -centerX * state.transform.zoom + canvas.width / 2;
      state.transform.y = -centerY * state.transform.zoom + canvas.height / 2;
      updateToolbarUI();
      toggleAlignmentPanelVisibility();
      updateZoomSliderValue();
      render();
      return;
    }

    // Shift+C: export selection as PNG to clipboard (no padding)
    if (e.code === "KeyC" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (state.marqueeMode) {
        marqueeExportPNG(1.0, { padding: 0 });
      } else if (state.selectedElements.length > 0) {
        executePNGExport(1.0, { padding: 0 });
      }
      return;
    }

    let targetTool = null;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (key === "r" && e.shiftKey) { setRulersVisible(!state.rulersVisible); return; }
    if (key === "§" && !e.shiftKey) {
      state.overlaysHidden = !state.overlaysHidden;
      const toolbar = document.getElementById("toolbar");
      const alignmentPanel = document.getElementById("alignment-panel");
      const zoomOverlay = document.getElementById("zoom-overlay");
      if (state.overlaysHidden) {
        if (state.rulersVisible) { state._rulersWereVisible = true; setRulersVisible(false); }
        toolbar.style.display = "none";
        alignmentPanel.style.display = "none";
        zoomOverlay.style.display = "none";
        // Auto-switch to hand tool so the user can only pan while overlays are hidden
        state._preOverlayTool = state.currentTool;
        state.currentTool = "pan";
        state.selectedElements = [];
        updateToolbarUI();
        updateCursor();
      } else {
        if (state._rulersWereVisible) { state._rulersWereVisible = false; setRulersVisible(true); }
        toolbar.style.display = "";
        zoomOverlay.style.display = "";
        // Restore previous tool if one was saved
        if (state._preOverlayTool) {
          state.currentTool = state._preOverlayTool;
          state._preOverlayTool = null;
          updateToolbarUI();
          updateCursor();
        }
        toggleAlignmentPanelVisibility();
      }
      showToast(state.overlaysHidden ? "Overlays & drawings hidden" : "Overlays & drawings visible");
      render();
      return;
    }
    if (key === "h") targetTool = "pan";
    if (key === "v") targetTool = "select";
    if (key === "b") targetTool = "pen";
    if (key === "q") targetTool = "bezier-pen";
    if (key === "p") targetTool = "laser";
    if (key === "l") targetTool = "line";
    if (key === "a" && !e.shiftKey) targetTool = "arrow";
    if (key === "c" && !e.shiftKey) targetTool = "connector";
    if (key === "r") targetTool = "rect-border";
    if (key === "f") targetTool = "rect-fill";
    if (key === "t") targetTool = "text";
    if (key === "n") targetTool = "text-element";
    if (key === "e") targetTool = "eraser";
    if (key === "m") targetTool = "marquee";
    if (key === "y") targetTool = "measure";
    if (key === "k") targetTool = "contrast";
    if (key === "j") targetTool = "accessibility-preview";
    // Bracket keys: adjust z-index (no modifier required)
    if ((key === "[" || key === "]") && state.currentTool === "select" && state.selectedElements.length > 0) {
      e.preventDefault();
      if (key === "]" && !e.shiftKey) { bringForward(); return; }
      if (key === "]" && e.shiftKey) { bringToFront(); return; }
      if (key === "[" && !e.shiftKey) { sendBackward(); return; }
      if (key === "[" && e.shiftKey) { sendToBack(); return; }
    }
    if (key === "s") {
      if (state.currentTool === "stamp") {
        // Already in stamp mode — no toggle behavior needed
      }
      targetTool = "stamp";
    }

    // W: activate split-line tool
    if (key === "w" && !e.shiftKey) {
      if (state.currentTool === "split-line") {
        state.splitLineOrientation = state.splitLineOrientation === "vertical" ? "horizontal" : "vertical";
        render();
        return;
      }
      targetTool = "split-line";
    }
    if (key === "w" && e.shiftKey) targetTool = "split-line";

    // [ / ] keys: adjust split line length when split-line tool is active
    if ((key === "[" || key === "]") && state.currentTool === "split-line") {
      e.preventDefault();
      const step = e.shiftKey ? 5 : 10;
      if (key === "[") {
        state.splitLineLength = Math.max(10, state.splitLineLength - step);
      } else {
        state.splitLineLength = Math.min(200, state.splitLineLength + step);
      }
      // Sync the slider UI
      const slider = document.getElementById("split-line-length-slider");
      const valDisplay = document.getElementById("split-line-length-val");
      if (slider) slider.value = state.splitLineLength;
      if (valDisplay) valDisplay.textContent = state.splitLineLength + "%";
      render();
      return;
    }

    // , key: cycle split line dash pattern when split-line tool is active
    if (key === "," && state.currentTool === "split-line") {
      e.preventDefault();
      const patterns = ["solid", "dashed", "dotted", "dash-dot"];
      const idx = patterns.indexOf(state.splitLineDash);
      state.splitLineDash = patterns[(idx + 1) % patterns.length];
      const dashSelect = document.getElementById("split-line-dash-select");
      if (dashSelect) dashSelect.value = state.splitLineDash;
      render();
      return;
    }

    // , key: toggle dashed/solid line for general drawing tools
    if (key === ",") {
      e.preventDefault();
      const dashOptions = ["solid", "dashed", "dotted", "dash-dot"];
      const idx = dashOptions.indexOf(state.currentLineDash);
      state.currentLineDash = dashOptions[(idx + 1) % dashOptions.length];
      const labels = { solid: "Solid line", dashed: "Dashed line", dotted: "Dotted line", "dash-dot": "Dash-dot line" };
      showToast(labels[state.currentLineDash]);
      updateToolbarUI();
      return;
    }

    // Z key: insert 4x4 grid + diagonal lines + edge inset lines on hovered image
    // Shift+Z: insert 8x8 grid lines on hovered image
    if (key === "z") {
      const cursorWorld = screenToWorld(state.lastMousePos.x, state.lastMousePos.y);
      let hoveredImg = null;
      for (let i = state.images.length - 1; i >= 0; i--) {
        const img = state.images[i];
        if (cursorWorld.x >= img.x && cursorWorld.x <= img.x + img.w &&
            cursorWorld.y >= img.y && cursorWorld.y <= img.y + img.h) {
          hoveredImg = img;
          break;
        }
      }
      if (hoveredImg) {
        e.preventDefault();
        pushUndo();
        const img = hoveredImg;
        const lineWidth = 0.5;
        const color = state.drawColor;
        const opacity = 0.7;
        const lines = [];

        if (e.shiftKey) {
          // 40x40px grid lines (grouped as a single unit)
          const gridSize = 40;
          const gridLineWidth = 0.3;
          const gridGroupId = "group_" + state.groupIdCounter++;
          // Vertical lines
          for (let x = img.x + gridSize; x < img.x + img.w; x += gridSize) {
            lines.push({
              id: "draw_" + state.elementIdCounter++,
              elementType: "drawing",
              type: "line",
              isSplitLine: true,
              color,
              width: gridLineWidth,
              opacity,
              groupId: gridGroupId,
              start: { x, y: img.y },
              end: { x, y: img.y + img.h },
            });
          }
          // Horizontal lines
          for (let y = img.y + gridSize; y < img.y + img.h; y += gridSize) {
            lines.push({
              id: "draw_" + state.elementIdCounter++,
              elementType: "drawing",
              type: "line",
              isSplitLine: true,
              color,
              width: gridLineWidth,
              opacity,
              groupId: gridGroupId,
              start: { x: img.x, y },
              end: { x: img.x + img.w, y },
            });
          }
        } else {
          // 4x4 grid: 3 vertical + 3 horizontal interior lines
          const zGroupId = "group_" + state.groupIdCounter++;
          for (let i = 1; i <= 3; i++) {
            const vx = img.x + (img.w * i) / 4;
            lines.push({
              id: "draw_" + state.elementIdCounter++,
              elementType: "drawing",
              type: "line",
              isSplitLine: true,
              color,
              width: lineWidth,
              opacity,
              groupId: zGroupId,
              start: { x: vx, y: img.y },
              end: { x: vx, y: img.y + img.h },
            });
            const hy = img.y + (img.h * i) / 4;
            lines.push({
              id: "draw_" + state.elementIdCounter++,
              elementType: "drawing",
              type: "line",
              isSplitLine: true,
              color,
              width: lineWidth,
              opacity,
              groupId: zGroupId,
              start: { x: img.x, y: hy },
              end: { x: img.x + img.w, y: hy },
            });
          }

          // Diagonal lines (corner to corner)
          lines.push({
            id: "draw_" + state.elementIdCounter++,
            elementType: "drawing",
            type: "line",
            isSplitLine: true,
            color,
            width: lineWidth,
            opacity,
            groupId: zGroupId,
            start: { x: img.x, y: img.y },
            end: { x: img.x + img.w, y: img.y + img.h },
          });
          lines.push({
            id: "draw_" + state.elementIdCounter++,
            elementType: "drawing",
            type: "line",
            isSplitLine: true,
            color,
            width: lineWidth,
            opacity,
            groupId: zGroupId,
            start: { x: img.x + img.w, y: img.y },
            end: { x: img.x, y: img.y + img.h },
          });

          // 40px inset lines from each edge
          const inset = 40;
          // Left inset
          lines.push({
            id: "draw_" + state.elementIdCounter++,
            elementType: "drawing",
            type: "line",
            isSplitLine: true,
            color,
            width: lineWidth,
            opacity,
            groupId: zGroupId,
            start: { x: img.x + inset, y: img.y },
            end: { x: img.x + inset, y: img.y + img.h },
          });
          // Right inset
          lines.push({
            id: "draw_" + state.elementIdCounter++,
            elementType: "drawing",
            type: "line",
            isSplitLine: true,
            color,
            width: lineWidth,
            opacity,
            groupId: zGroupId,
            start: { x: img.x + img.w - inset, y: img.y },
            end: { x: img.x + img.w - inset, y: img.y + img.h },
          });
          // Top inset
          lines.push({
            id: "draw_" + state.elementIdCounter++,
            elementType: "drawing",
            type: "line",
            isSplitLine: true,
            color,
            width: lineWidth,
            opacity,
            groupId: zGroupId,
            start: { x: img.x, y: img.y + inset },
            end: { x: img.x + img.w, y: img.y + inset },
          });
          // Bottom inset
          lines.push({
            id: "draw_" + state.elementIdCounter++,
            elementType: "drawing",
            type: "line",
            isSplitLine: true,
            color,
            width: lineWidth,
            opacity,
            groupId: zGroupId,
            start: { x: img.x, y: img.y + img.h - inset },
            end: { x: img.x + img.w, y: img.y + img.h - inset },
          });
        }

        for (const line of lines) {
          state.drawings.push(line);
          spatialInsert(line);
        }
        scheduleSave();
        render();
        return;
      }
    }

    if (key === "g" && !e.shiftKey && state.currentTool === "select" && state.selectedElements.length >= 2) {
      const gridBtn = document.querySelector('[data-align="gridLayout"]');
      if (gridBtn) gridBtn.click();
      return;
    }
    if (key === "g" && e.shiftKey && state.currentTool === "select" && state.selectedElements.length >= 2) {
      const rowBtn = document.querySelector('[data-align="rowLayout"]');
      if (rowBtn) rowBtn.click();
      return;
    }

    if (targetTool) {
      state.preSpaceTool = null;
      const btn = document.querySelector(`[data-tool="${targetTool}"]`);
      if (btn) btn.click();
      return;
    }

    // P / Shift+P to cycle color filters
    if (key === "p" && !e.metaKey && !e.ctrlKey) {
      const idx = FILTER_OPTIONS.indexOf(state.currentFilter);
      let newIdx;
      if (e.shiftKey) { newIdx = (idx - 1 + FILTER_OPTIONS.length) % FILTER_OPTIONS.length; }
      else { newIdx = (idx + 1) % FILTER_OPTIONS.length; }
      state.currentFilter = FILTER_OPTIONS[newIdx];
      state.filteredImageCache = new WeakMap();
      const filterSel = document.getElementById("filter-select");
      if (filterSel) { filterSel.value = state.currentFilter; filterSel.classList.toggle("filter-active", state.currentFilter !== "none"); }
      render();
      showToast(`Filter: ${FILTER_LABELS[state.currentFilter]}`);
      return;
    }

    // D / Shift+D to cycle tool colors through presets
    if (key === "d" && !e.metaKey && !e.ctrlKey) {
      const presetColors = Array.from(document.querySelectorAll(".preset-btn")).map((btn) => btn.dataset.color).filter(x => x !== "#1e1e1e" && x !== "#f0f0f0")
      if (presetColors.length === 0) return;
      const currentColor = state.currentTool === "text" ? state.textDrawColor : state.drawColor;
      let idx = presetColors.indexOf(currentColor);
      if (e.shiftKey) { idx = (idx - 1 + presetColors.length) % presetColors.length; }
      else { idx = (idx + 1) % presetColors.length; }
      const newColor = presetColors[idx];
      if (state.currentTool === "text") { state.textDrawColor = newColor; }
      else { state.drawColor = newColor; }
      colorPicker.value = newColor;
      const swatchEl = document.getElementById("color-swatch-inner");
      if (swatchEl) swatchEl.style.background = newColor;
      const hexLbl1 = document.getElementById("color-hex-label");
      if (hexLbl1) hexLbl1.textContent = newColor.toUpperCase();
      updateColorNameLabel();
      if (state.selectedElements.length > 0) {
        state.selectedElements.forEach((el) => {
          if (el.elementType === "text" || el.elementType === "drawing") { el.color = newColor; }
        });
      }
      if (state.currentTool === "laser") updateCursor();
      render();
      showToast(`Color: ${newColor}`);
      return;
    }

    // X key — toggle tool color between dark and light
    if (key === "x" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      const currentColor = state.currentTool === "text" ? state.textDrawColor : state.drawColor;
      const newColor = currentColor === "#1e1e1e" ? "#f0f0f0" : "#1e1e1e";
      if (state.currentTool === "text") { state.textDrawColor = newColor; }
      else { state.drawColor = newColor; }
      colorPicker.value = newColor;
      const swatchEl = document.getElementById("color-swatch-inner");
      if (swatchEl) swatchEl.style.background = newColor;
      const hexLbl2 = document.getElementById("color-hex-label");
      if (hexLbl2) hexLbl2.textContent = newColor.toUpperCase();
      updateColorNameLabel();
      if (state.selectedElements.length > 0) {
        state.selectedElements.forEach((el) => {
          if (el.elementType === "text" || el.elementType === "drawing") { el.color = newColor; }
        });
        render();
      }
      if (state.currentTool === "laser") updateCursor();
      showToast(`Color: ${newColor}`);
      return;
    }

    // I key or Shift+A — Eyedropper tool mode; Shift+I toggles insert mode lock
    if (key === "i" && e.shiftKey && state.currentTool === "eyedropper") {
      // Shift+I while in eyedropper mode — toggle insert mode lock
      state.eyedropperInsertMode = !state.eyedropperInsertMode;
      showToast(state.eyedropperInsertMode
        ? "Eyedropper insert mode ON — click to insert hex as text"
        : "Eyedropper insert mode OFF — click to pick color");
      return;
    }
    if (key === "i" || (key === "a" && e.shiftKey)) {
      state.currentTool = "eyedropper";
      state.selectedElements = [];
      updateToolbarUI();
      updateCursor();
      render();
      showToast(state.eyedropperInsertMode
        ? "Eyedropper (insert mode): click to insert hex as text, Shift+I to toggle"
        : "Eyedropper: click to pick color, Shift+click to insert hex as text, Shift+I to toggle insert mode");
      return;
    }

    // Shift+1: Zoom to fit all elements
    if (e.shiftKey && e.code === "Digit1") {
      e.preventDefault();
      const allElements = [...state.images, ...state.drawings];
      if (allElements.length === 0) { showToast("No elements on canvas"); return; }
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      allElements.forEach((el) => {
        const b = el.elementType === "image" ? { x: el.x, y: el.y, w: el.w, h: el.h } : getShapeBounds(el);
        if (b.x < minX) minX = b.x;
        if (b.y < minY) minY = b.y;
        if (b.x + b.w > maxX) maxX = b.x + b.w;
        if (b.y + b.h > maxY) maxY = b.y + b.h;
      });
      const boundsW = maxX - minX;
      const boundsH = maxY - minY;
      if (boundsW <= 0 || boundsH <= 0) { showToast("No elements on canvas"); return; }
      const canvas = document.getElementById("canvas");
      const padding = 60;
      const availW = canvas.width - padding * 2;
      const availH = canvas.height - padding * 2;
      const newZoom = Math.min(availW / boundsW, availH / boundsH, 12.0);
      const clampedZoom = Math.max(0.05, Math.min(12.0, newZoom));
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      state.transform.zoom = clampedZoom;
      state.transform.x = canvas.width / 2 - centerX * clampedZoom;
      state.transform.y = canvas.height / 2 - centerY * clampedZoom;
      updateZoomSliderValue();
      render();
      showToast("Zoom to fit");
      return;
    }

    // Shift+2: Zoom to selection
    if (e.shiftKey && e.code === "Digit2") {
      e.preventDefault();
      if (state.selectedElements.length === 0) { showToast("No elements selected"); return; }
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      state.selectedElements.forEach((el) => {
        const b = el.elementType === "image" ? { x: el.x, y: el.y, w: el.w, h: el.h } : getShapeBounds(el);
        if (b.x < minX) minX = b.x;
        if (b.y < minY) minY = b.y;
        if (b.x + b.w > maxX) maxX = b.x + b.w;
        if (b.y + b.h > maxY) maxY = b.y + b.h;
      });
      const boundsW = maxX - minX;
      const boundsH = maxY - minY;
      if (boundsW <= 0 || boundsH <= 0) { showToast("Selection has no area"); return; }
      const canvas = document.getElementById("canvas");
      const padding = 60;
      const availW = canvas.width - padding * 2;
      const availH = canvas.height - padding * 2;
      const newZoom = Math.min(availW / boundsW, availH / boundsH, 12.0);
      const clampedZoom = Math.max(0.05, Math.min(12.0, newZoom));
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      state.transform.zoom = clampedZoom;
      state.transform.x = canvas.width / 2 - centerX * clampedZoom;
      state.transform.y = canvas.height / 2 - centerY * clampedZoom;
      updateZoomSliderValue();
      render();
      showToast("Zoom to selection");
      return;
    }


    // Number keys 1-3 set stroke width on selected drawing elements or when a drawing tool is active
    const isDrawingTool = state.currentTool === "pen" || state.currentTool === "laser" || state.currentTool === "line" || state.currentTool === "arrow" || state.currentTool === "rect-border" || state.currentTool === "rect-fill" || state.currentTool === "measure" || state.currentTool === "split-line";
    if ((key === "1" || key === "2" || key === "3") && (isDrawingTool || (state.currentTool === "select" && state.selectedElements.length > 0 && state.selectedElements.some((el) => el.elementType === "drawing" && el.type !== "text")))) {
      e.preventDefault();
      const widthMap = { "1": 2, "2": 4, "3": 10 };
      const newWidth = widthMap[key];
      pushUndo();
      state.currentLineWidth = newWidth;
      const lineWidthBtns = document.querySelectorAll(".line-width-btn");
      lineWidthBtns.forEach((b) => {
        if (parseInt(b.dataset.width, 10) === newWidth) b.classList.add("active");
        else b.classList.remove("active");
      });
      if (state.selectedElements.length > 0) {
        state.selectedElements.forEach((el) => {
          if (el.elementType === "drawing" && el.type !== "text") {
            el.width = newWidth;
          }
        });
        render();
      }
      showToast(`Stroke width: ${newWidth}px`);
      return;
    }

    // Number keys 0-9 set opacity
    if (key >= "0" && key <= "9" && state.currentTool === "select" && state.selectedElements.length > 0) {
      const opacity = key === "0" ? 1 : parseInt(key) / 10;
      pushUndo();
      state.selectedElements.forEach((el) => { el.opacity = opacity; });
      syncOpacityFromSelection();
      render();
      showToast(`Opacity ${Math.round(opacity * 100)}%`);
      return;
    }
  });

  // Cmd/Ctrl modifier shortcuts
  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
    const isMod = e.metaKey || e.ctrlKey;
    if (!isMod) return;

    if (e.key.toLowerCase() === "s" && !e.shiftKey) { e.preventDefault(); saveFile(); return; }
    if (e.key.toLowerCase() === "s" && e.shiftKey) { e.preventDefault(); saveAs(); return; }
    if (e.key.toLowerCase() === "o") { e.preventDefault(); openFile(); return; }
    if (e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (e.key.toLowerCase() === "z" && e.shiftKey) { e.preventDefault(); redo(); return; }
    if (e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
    if (e.key.toLowerCase() === "g" && !e.shiftKey) { e.preventDefault(); groupSelection(); return; }
    if (e.key.toLowerCase() === "g" && e.shiftKey) { e.preventDefault(); ungroupSelection(); return; }
    if (e.key.toLowerCase() === "l" && !e.shiftKey) { e.preventDefault(); toggleLockSelection(); return; }

    // Text style shortcuts (Cmd/Ctrl+B, I, U) — apply to selected text elements
    if (e.key.toLowerCase() === "b" && !e.shiftKey) {
      const textEls = state.selectedElements.filter((el) => el.elementType === "text");
      if (textEls.length > 0) {
        e.preventDefault();
        document.getElementById("fmt-bold").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        return;
      }
    }
    if (e.key.toLowerCase() === "i" && !e.shiftKey) {
      const textEls = state.selectedElements.filter((el) => el.elementType === "text");
      if (textEls.length > 0) {
        e.preventDefault();
        document.getElementById("fmt-italic").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        return;
      }
    }
    if (e.key.toLowerCase() === "u" && !e.shiftKey) {
      const textEls = state.selectedElements.filter((el) => el.elementType === "text");
      if (textEls.length > 0) {
        e.preventDefault();
        document.getElementById("fmt-underline").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        return;
      }
    }

    // Crop copy/paste: Cmd/Ctrl+Alt+C to copy crop, Cmd/Ctrl+Alt+V to paste crop
    if (e.altKey && e.code === "KeyC") {
      e.preventDefault();
      copyCropSettings();
      return;
    }
    if (e.altKey && e.code === "KeyV") {
      e.preventDefault();
      pasteCropSettings();
      return;
    }

    if (e.key.toLowerCase() === "c" && e.shiftKey) {
      e.preventDefault();
      if (state.marqueeMode) {
        marqueeExportPNG(0.5, { padding: 0 });
      } else if (state.selectedElements.length > 0) {
        executePNGExport(0.5, { padding: 0 });
      }
      return;
    }
    if (e.key.toLowerCase() === "c") {
      if (state.marqueeMode) { e.preventDefault(); marqueeCopy(); return; }
      if (state.selectedElements.length > 0) { e.preventDefault(); copySelectionToClipboard(); }
      return;
    }
    if (e.key.toLowerCase() === "x") {
      if (state.marqueeMode) { e.preventDefault(); marqueeCut(); return; }
      if (state.selectedElements.length > 0) {
        e.preventDefault();
        pushUndo();
        copySelectionToClipboard();
        const idsToRemove = state.selectedElements.map((el) => el.id);
        state.images = state.images.filter((img) => !idsToRemove.includes(img.id));
        state.drawings = state.drawings.filter((d) => !idsToRemove.includes(d.id));
        for (const id of idsToRemove) {
          const el = spatialIndex.elements.get(id);
          if (el) spatialRemove(el);
        }
        showToast(`Cut ${state.selectedElements.length} element(s)`);
        state.selectedElements = [];
        toggleAlignmentPanelVisibility();
        render();
      }
      return;
    }
    if (e.key.toLowerCase() === "d") {
      if (state.marqueeMode) { e.preventDefault(); marqueeDuplicate(); return; }
      if (state.selectedElements.length > 0) { e.preventDefault(); duplicateSelection(); }
      return;
    }
    if (e.key.toLowerCase() === "v") { return; } // Let native paste fire
    if (e.key.toLowerCase() === "a") { e.preventDefault(); selectAllElements(); return; }
    if (e.key.toLowerCase() === "e" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (state.marqueeMode) { marqueeExportPNG(1.0); return; }
      executePNGExport(1.0); return;
    }
    if (e.altKey && e.code === "KeyE") {
      e.preventDefault();
      if (state.marqueeMode) { marqueeExportPNG(0.5); return; }
      executePNGExport(0.5); return;
    }
    if (e.key.toLowerCase() === "e" && e.shiftKey) {
      e.preventDefault();
      if (state.marqueeMode) { marqueeExportPNG(1.0, { download: true }); return; }
      executePNGExport(1.0, { download: true }); return;
    }
    if (e.key.toLowerCase() === "j" && e.shiftKey) { e.preventDefault(); executeJPEGExport(1.0, { download: true }); return; }
    if (e.key.toLowerCase() === "p" && !e.shiftKey) {
      e.preventDefault();
      if (state.marqueeMode) { marqueeExportPNG(1.0); return; }
      executePNGExport(1.0); return;
    }
    if (e.key.toLowerCase() === "p" && e.shiftKey) {
      e.preventDefault();
      if (state.marqueeMode) { marqueeExportPNG(0.5); return; }
      executePNGExport(0.5); return;
    }
    // Cmd+0: reset zoom to 100%
    if (e.key === "0" || e.code === "Digit0") {
      e.preventDefault();
      applyZoom(1.0, window.innerWidth / 2, window.innerHeight / 2);
      showToast("Zoom: 100%");
      return;
    }
  });

  function applyColorToSelectedElements(color) {
    if (state.selectedElements.length === 0) return;
    let changed = false;
    state.selectedElements.forEach((el) => {
      if (el.elementType === "text" || el.elementType === "drawing") { el.color = color; changed = true; }
    });
    if (changed) render();
  }
}

function setupMouseHandlers() {
  const dom = getDom();
  const { container, canvas, ctx, textEditor } = dom;

  // Global mousemove for swap detection and measure hover
  window.addEventListener("mousemove", (e) => {
    state.lastMousePos.x = e.clientX;
    state.lastMousePos.y = e.clientY;

    // Sync modifier state from actual event to recover from stuck keys
    // (e.g. after macOS Cmd+Shift+4 screenshot steals keyup events)
    if (state.isShiftPressed !== e.shiftKey) {
      state.isShiftPressed = e.shiftKey;
      if (!e.shiftKey) state.panLockDirection = null;
    }
    if (state.isMetaPressed !== e.metaKey) {
      state.isMetaPressed = e.metaKey;
    }
    if (state.isCtrlPressed !== e.ctrlKey) {
      state.isCtrlPressed = e.ctrlKey;
    }

    // Handle swap drag in progress
    if (state.isSwapDragging) {
      const mouseWorld = screenToWorld(e.clientX, e.clientY);
      state.swapDragWorldPos = mouseWorld;
      state.swapTargetElement = getElementAtWorldPos(mouseWorld, state.swapSourceElement);
      if (state.swapTargetElement && !state.selectedElements.some((el) => el.id === state.swapTargetElement.id)) {
        state.swapTargetElement = null;
      }
      container.style.cursor = "grabbing";
      render();
      return;
    }

    // Measure tool hover
    if (state.currentTool === "measure" && !state.isInteracting) {
      const mouseWorld = screenToWorld(e.clientX, e.clientY);
      state.measureHoverGuides = computeMeasureHoverGuides(mouseWorld);
      render();
    }

    // Split-line tool hover — detect image under cursor
    if (state.currentTool === "split-line" && !state.isInteracting) {
      const mouseWorld = screenToWorld(e.clientX, e.clientY);
      let hoveredImage = null;
      for (let i = state.images.length - 1; i >= 0; i--) {
        const img = state.images[i];
        if (mouseWorld.x >= img.x && mouseWorld.x <= img.x + img.w &&
            mouseWorld.y >= img.y && mouseWorld.y <= img.y + img.h) {
          hoveredImage = img;
          break;
        }
      }
      const changed = hoveredImage !== state.splitLineHoveredImage ||
        (hoveredImage && (state.splitLineWorldPos === null ||
          state.splitLineWorldPos.x !== mouseWorld.x || state.splitLineWorldPos.y !== mouseWorld.y));
      state.splitLineHoveredImage = hoveredImage;
      state.splitLineWorldPos = hoveredImage ? { x: mouseWorld.x, y: mouseWorld.y } : null;
      if (changed) render();
    }

    // Accessibility preview cursor (move/resize handles)
    if (state.currentTool === "accessibility-preview" && !state.isInteracting) {
      const mouseWorld = screenToWorld(e.clientX, e.clientY);
      container.style.cursor = getAccessibilityPreviewCursor(mouseWorld);
    }

    // Resize handle cursor
    if (state.currentTool === "select" && !state.isInteracting && !state.cropMode && state.selectedElements.length === 1) {
      const el = state.selectedElements[0];
      const mouseWorld = screenToWorld(e.clientX, e.clientY);
      const threshold = CONSTANTS.RESIZE_HANDLE_SIZE / state.transform.zoom;
      let handleHit = false;
      const handles = getElementResizeHandles(el);
      for (const h of handles) {
        if (Math.abs(mouseWorld.x - h.x) <= threshold && Math.abs(mouseWorld.y - h.y) <= threshold) {
          container.style.cursor = h.cursor;
          handleHit = true;
          break;
        }
      }
      if (!handleHit) container.style.cursor = "default";
      if (handleHit) return;
    }

    // Swap handle hover detection
    if (state.currentTool === "select" && !state.isInteracting && !state.isSwapDragging && state.selectedElements.length >= 2) {
      const mouseWorld = screenToWorld(e.clientX, e.clientY);
      let newHovered = null;
      for (let i = state.selectedElements.length - 1; i >= 0; i--) {
        const el = state.selectedElements[i];
        let isOver = false;
        if (el.elementType === "image") {
          isOver = mouseWorld.x >= el.x && mouseWorld.x <= el.x + el.w && mouseWorld.y >= el.y && mouseWorld.y <= el.y + el.h;
        } else {
          isOver = isPointHittingShape(mouseWorld, el);
        }
        if (isOver) { newHovered = el; break; }
      }
      if (newHovered !== state.swapHoveredElement) { state.swapHoveredElement = newHovered; render(); }
      if (state.swapHoveredElement && isPointOnSwapHandle(mouseWorld, state.swapHoveredElement)) {
        container.style.cursor = "grab";
        return;
      }
    } else if (!state.isSwapDragging && state.swapHoveredElement) {
      state.swapHoveredElement = null;
      render();
    }
  });

  // Global mouseup for swap completion
  window.addEventListener("mouseup", (e) => {
    if (state.isSwapDragging) {
      if (state.swapTargetElement && state.swapSourceElement && state.swapTargetElement.id !== state.swapSourceElement.id) {
        swapElementPositions(state.swapSourceElement, state.swapTargetElement);
      }
      state.isSwapDragging = false;
      state.swapSourceElement = null;
      state.swapDragWorldPos = null;
      state.swapTargetElement = null;
      state.swapHoveredElement = null;
      container.style.cursor = "default";
      render();
      return;
    }
  });

  // Container mousedown
  container.addEventListener("mousedown", (e) => {
    if (textEditor.style.display === "block") {
      if (textEditor.contains(e.target)) return;
      bakeText();
    }

    state.isInteracting = true;
    state.startX = e.clientX;
    state.startY = e.clientY;
    state.panLockDirection = null;
    state.resizingElement = null;

    state.isMiddleClick = e.button === 1;
    state.isRightClickHand = e.button === 2;

    let worldPos = screenToWorld(e.clientX, e.clientY);

    // Crop mode interaction
    if (state.cropMode && state.cropTarget && state.cropRect) {
      const full = getFullImageBounds(state.cropTarget);
      if (worldPos.x < full.x - 20 / state.transform.zoom || worldPos.x > full.x + full.w + 20 / state.transform.zoom ||
          worldPos.y < full.y - 20 / state.transform.zoom || worldPos.y > full.y + full.h + 20 / state.transform.zoom) {
        exitCropMode(false);
        state.isInteracting = false;
        return;
      }
      const edge = getCropEdgeAtPoint(worldPos);
      if (edge) {
        state.cropDragEdge = edge;
        state.cropDragStart = { ...worldPos, rect: { ...state.cropRect } };
        state.isInteracting = true;
        return;
      }
      state.isInteracting = false;
      return;
    }

    if (state.isMiddleClick || state.isRightClickHand || state.currentTool === "pan") {
      updateCursor();
      return;
    }

    if (state.currentTool === "eraser") { checkAndEraseAtPosition(worldPos); return; }

    // Stamp tool: Shift+Click copies elements from hovered image, Click pastes onto hovered image
    // Drag (no shift, with clipboard): start marquee area select to stamp multiple images
    if (state.currentTool === "stamp") {
      let hoveredImg = null;
      for (let i = state.images.length - 1; i >= 0; i--) {
        const img = state.images[i];
        if (worldPos.x >= img.x && worldPos.x <= img.x + img.w &&
            worldPos.y >= img.y && worldPos.y <= img.y + img.h) {
          hoveredImg = img;
          break;
        }
      }
      if (e.shiftKey) {
        // Shift+Click: copy overlapping non-image elements from hovered image
        if (!hoveredImg) {
          showToast("Hover over an image to copy stamp");
          return;
        }
        const imgBounds = { minX: hoveredImg.x, minY: hoveredImg.y, maxX: hoveredImg.x + hoveredImg.w, maxY: hoveredImg.y + hoveredImg.h };
        const candidates = spatialIndex.queryRect(imgBounds);
        const overlapping = candidates.filter(el => el.elementType !== "image");
        if (overlapping.length === 0) {
          showToast("No overlapping elements found");
          return;
        }
        state.stampClipboard = overlapping.map(el => {
          const clone = JSON.parse(JSON.stringify(el, (key, value) => {
            if (key === "img" && value instanceof HTMLImageElement) return undefined;
            return value;
          }));
          if (clone.type === "pen" && clone.points) {
            clone.points = clone.points.map(p => ({ x: p.x - hoveredImg.x, y: p.y - hoveredImg.y }));
          } else if (clone.start) {
            clone.start = { x: clone.start.x - hoveredImg.x, y: clone.start.y - hoveredImg.y };
            if (clone.end) clone.end = { x: clone.end.x - hoveredImg.x, y: clone.end.y - hoveredImg.y };
          }
          return clone;
        });
        state.stampSourceBounds = { x: hoveredImg.x, y: hoveredImg.y, w: hoveredImg.w, h: hoveredImg.h };
        showToast(`Stamp-copied ${overlapping.length} element(s)`);
      } else if (hoveredImg) {
        // Click on a single image: paste stamp clipboard onto it (existing behavior)
        if (!state.stampClipboard || state.stampClipboard.length === 0) {
          showToast("No stamp clipboard — use Shift+Click first");
          return;
        }
        pushUndo();
        const srcW = state.stampSourceBounds.w;
        const srcH = state.stampSourceBounds.h;
        const scaleX = hoveredImg.w / srcW;
        const scaleY = hoveredImg.h / srcH;
        const newElements = [];
        const groupIdMap = new Map();
        state.stampClipboard.forEach(srcEl => {
          const clone = JSON.parse(JSON.stringify(srcEl));
          clone.id = "draw_" + state.elementIdCounter++;
          if (clone.groupId) {
            if (!groupIdMap.has(clone.groupId)) {
              groupIdMap.set(clone.groupId, "group_" + state.groupIdCounter++);
            }
            clone.groupId = groupIdMap.get(clone.groupId);
          }
          if (clone.type === "pen" && clone.points) {
            clone.points = clone.points.map(p => ({
              x: p.x * scaleX + hoveredImg.x,
              y: p.y * scaleY + hoveredImg.y,
            }));
          } else if (clone.start) {
            clone.start = { x: clone.start.x * scaleX + hoveredImg.x, y: clone.start.y * scaleY + hoveredImg.y };
            if (clone.end) clone.end = { x: clone.end.x * scaleX + hoveredImg.x, y: clone.end.y * scaleY + hoveredImg.y };
          }
          state.drawings.push(clone);
          spatialInsert(clone);
          newElements.push(clone);
        });
        render();
        scheduleSave();
        showToast(`Stamped ${newElements.length} element(s) onto image`);
      } else {
        // Click/drag on empty space: start stamp marquee area select
        // Cmd/Ctrl+drag removes drawings, normal drag stamps (needs clipboard)
        if (!(e.metaKey || e.ctrlKey) && (!state.stampClipboard || state.stampClipboard.length === 0)) {
          showToast("No stamp clipboard — use Shift+Click on an image first");
          return;
        }
        state.stampMarqueeActive = true;
        state.stampMarqueeStart = { x: worldPos.x, y: worldPos.y };
        state.stampMarqueeRect = { x: worldPos.x, y: worldPos.y, w: 0, h: 0 };
      }
      return;
    }

    if (state.currentTool === "marquee") {
      marqueeStartSelection(worldPos);
      return;
    }

    if (state.currentTool === "accessibility-preview") {
      accessibilityPreviewStart(worldPos);
      return;
    }

    if (state.currentTool === "measure") {
      state.activeMeasureLine = { start: { ...worldPos }, end: { ...worldPos } };
      state.measureHoverGuides = [];
      return;
    }

    if (state.currentTool === "contrast") {
      state.activeContrastLine = { start: { ...worldPos }, end: { ...worldPos } };
      // Sample start color immediately at mousedown
      const pixelData = ctx.getImageData(e.clientX - canvas.getBoundingClientRect().left, e.clientY - canvas.getBoundingClientRect().top, 1, 1).data;
      state.activeContrastLine.startColor = { r: pixelData[0], g: pixelData[1], b: pixelData[2] };
      return;
    }

    if (state.currentTool === "split-line") {
      if (state.splitLineHoveredImage && state.splitLineWorldPos) {
        const img = state.splitLineHoveredImage;
        const pos = state.splitLineWorldPos;
        const lengthPct = state.splitLineLength / 100; // 0.1..2.0
        const dashPattern = state.splitLineDash;

        pushUndo();

        if (state.isCtrlPressed) {
          // Create both vertical and horizontal lines when ctrl is held
          let lx = Math.max(img.x, Math.min(pos.x, img.x + img.w));
          let ly = Math.max(img.y, Math.min(pos.y, img.y + img.h));
          if (e.shiftKey) {
            lx = snapSplitLinePos(lx, img.x, img.w);
            ly = snapSplitLinePos(ly, img.y, img.h);
          }
          // Vertical line: spans along Y axis
          const cursorY = Math.max(img.y, Math.min(pos.y, img.y + img.h));
          const vSpan = img.h * lengthPct;
          let vStartY, vEndY;
          if (lengthPct > 1) {
            // Extend symmetrically from image edges
            const ext = (vSpan - img.h) / 2;
            vStartY = img.y - ext;
            vEndY = img.y + img.h + ext;
          } else {
            vStartY = cursorY - vSpan / 2;
            vEndY = cursorY + vSpan / 2;
            if (vStartY < img.y) { vStartY = img.y; vEndY = img.y + vSpan; }
            if (vEndY > img.y + img.h) { vEndY = img.y + img.h; vStartY = img.y + img.h - vSpan; }
          }

          // Horizontal line: spans along X axis
          const cursorX = Math.max(img.x, Math.min(pos.x, img.x + img.w));
          const hSpan = img.w * lengthPct;
          let hStartX, hEndX;
          if (lengthPct > 1) {
            // Extend symmetrically from image edges
            const ext = (hSpan - img.w) / 2;
            hStartX = img.x - ext;
            hEndX = img.x + img.w + ext;
          } else {
            hStartX = cursorX - hSpan / 2;
            hEndX = cursorX + hSpan / 2;
            if (hStartX < img.x) { hStartX = img.x; hEndX = img.x + hSpan; }
            if (hEndX > img.x + img.w) { hEndX = img.x + img.w; hStartX = img.x + img.w - hSpan; }
          }

          const vLine = {
            id: "draw_" + state.elementIdCounter++,
            elementType: "drawing",
            type: "line",
            isSplitLine: true,
            color: state.drawColor,
            width: state.currentLineWidth / 4,
            opacity: 0.7,
            dash: dashPattern,
            start: { x: lx, y: vStartY },
            end: { x: lx, y: vEndY },
          };
          const hLine = {
            id: "draw_" + state.elementIdCounter++,
            elementType: "drawing",
            type: "line",
            isSplitLine: true,
            color: state.drawColor,
            width: state.currentLineWidth / 4,
            opacity: 0.7,
            dash: dashPattern,
            start: { x: hStartX, y: ly },
            end: { x: hEndX, y: ly },
          };
          state.drawings.push(vLine);
          spatialInsert(vLine);
          state.drawings.push(hLine);
          spatialInsert(hLine);
        } else {
          // Create a single line based on effective orientation
          const effectiveOrientation = e.metaKey
            ? (state.splitLineOrientation === "vertical" ? "horizontal" : "vertical")
            : state.splitLineOrientation;
          let start, end;
          if (effectiveOrientation === "vertical") {
            let lx = Math.max(img.x, Math.min(pos.x, img.x + img.w));
            if (e.shiftKey) lx = snapSplitLinePos(lx, img.x, img.w);
            const span = img.h * lengthPct;
            let sY, eY;
            if (lengthPct > 1) {
              const ext = (span - img.h) / 2;
              sY = img.y - ext;
              eY = img.y + img.h + ext;
            } else {
              sY = pos.y - span / 2;
              eY = pos.y + span / 2;
              if (sY < img.y) { sY = img.y; eY = img.y + span; }
              if (eY > img.y + img.h) { eY = img.y + img.h; sY = img.y + img.h - span; }
            }
            start = { x: lx, y: sY };
            end = { x: lx, y: eY };
          } else {
            let ly = Math.max(img.y, Math.min(pos.y, img.y + img.h));
            if (e.shiftKey) ly = snapSplitLinePos(ly, img.y, img.h);
            const span = img.w * lengthPct;
            let sX, eX;
            if (lengthPct > 1) {
              const ext = (span - img.w) / 2;
              sX = img.x - ext;
              eX = img.x + img.w + ext;
            } else {
              sX = pos.x - span / 2;
              eX = pos.x + span / 2;
              if (sX < img.x) { sX = img.x; eX = img.x + span; }
              if (eX > img.x + img.w) { eX = img.x + img.w; sX = img.x + img.w - span; }
            }
            start = { x: sX, y: ly };
            end = { x: eX, y: ly };
          }
          const lineEl = {
            id: "draw_" + state.elementIdCounter++,
            elementType: "drawing",
            type: "line",
            isSplitLine: true,
            color: state.drawColor,
            width: state.currentLineWidth / 4,
            opacity: 0.7,
            dash: dashPattern,
            start,
            end,
          };
          state.drawings.push(lineEl);
          spatialInsert(lineEl);
        }

        scheduleSave();
        render();
      }
      state.isInteracting = false;
      return;
    }

    if (state.currentTool === "eyedropper") {
      // Start tracking for potential drag (marquee color analysis)
      // Actual color pick happens on mouseup if no drag occurred
      state.eyedropperMarqueeActive = true;
      state.eyedropperMarqueeStart = { x: worldPos.x, y: worldPos.y };
      state.eyedropperMarqueeRect = { x: worldPos.x, y: worldPos.y, w: 0, h: 0 };
      return;
    }

    if (state.currentTool === "text") {
      state.isInteracting = false;
      state.activeTextCoord = worldPos;
      setTextEditorContent("");
      textEditor.style.display = "block";
      textEditor.style.color = state.textDrawColor;
      textEditor.dataset.bgColor = "";
      const screenPos = worldToScreen(worldPos.x, worldPos.y);
      textEditor.style.left = `${screenPos.x}px`;
      textEditor.style.top = `${screenPos.y - state.currentFontSize * state.transform.zoom * 0.2}px`;
      textEditor.style.fontSize = `${state.currentFontSize * state.transform.zoom}px`;
      textEditor.style.fontFamily = state.currentFontFamily;
      textEditor.style.lineHeight = "1.2";
      textEditor.style.background = "transparent";
      autoResizeTextEditor();
      setTimeout(() => { textEditor.focus(); if (window._textFormatBar) { window._textFormatBar.show(); } }, 20);
      return;
    }

    if (state.currentTool === "text-element") {
      state.isInteracting = false;
      state.activeTextCoord = worldPos;
      setTextEditorContent("");
      textEditor.style.display = "block";
      textEditor.style.color = "#333333";
      textEditor.dataset.bgColor = state.currentNoteBgColor;
      const screenPos = worldToScreen(worldPos.x, worldPos.y);
      const screenFontSize = state.currentFontSize * state.transform.zoom;
      const notePadding = state.currentFontSize * 0.4 * state.transform.zoom;
      textEditor.style.left = `${screenPos.x - notePadding}px`;
      textEditor.style.top = `${screenPos.y - notePadding}px`;
      textEditor.style.fontSize = `${screenFontSize}px`;
      textEditor.style.fontFamily = state.currentFontFamily;
      textEditor.style.lineHeight = "1.2";
      textEditor.style.padding = `${notePadding}px`;
      textEditor.style.whiteSpace = "pre";
      textEditor.style.wordBreak = "normal";
      textEditor.style.background = state.currentNoteBgColor;
      textEditor.style.border = "none";
      textEditor.style.outline = "1px dashed #c4b800";
      autoResizeTextEditor();
      setTimeout(() => { textEditor.focus(); if (window._textFormatBar) { window._textFormatBar.show(); } }, 20);
      return;
    }

    if (state.currentTool === "select") {
      // Swap handle hit
      if (state.selectedElements.length >= 2 && state.swapHoveredElement && isPointOnSwapHandle(worldPos, state.swapHoveredElement)) {
        state.isSwapDragging = true;
        state.swapSourceElement = state.swapHoveredElement;
        state.swapDragWorldPos = { ...worldPos };
        state.swapTargetElement = null;
        container.style.cursor = "grabbing";
        state.isInteracting = false;
        return;
      }

      // Resize handle hits
      if (state.selectedElements.length === 1) {
        const el = state.selectedElements[0];
        const threshold = CONSTANTS.RESIZE_HANDLE_SIZE / state.transform.zoom;
        const handles = getElementResizeHandles(el);
        for (const h of handles) {
          if (Math.abs(worldPos.x - h.x) <= threshold && Math.abs(worldPos.y - h.y) <= threshold) {
            if (!el.originalBounds) {
              if (el.elementType === "image") el.originalBounds = { w: el.w, h: el.h };
              else if (el.type === "text") el.originalBounds = { fontSize: el.fontSize };
              else if (el.type === "pen") el.originalBounds = { points: el.points.map((p) => ({ ...p })) };
              else el.originalBounds = { start: { ...el.start }, end: el.end ? { ...el.end } : null };
            }
            pushUndo();
            state.resizingElement = el;
            const b = el.elementType === "image" ? { x: el.x, y: el.y, w: el.w, h: el.h } : getShapeBounds(el);
            state.resizeStartBounds = {
              x: b.x, y: b.y, w: b.w, h: b.h, ratio: b.w / b.h || 1,
              handlePosition: h.position, startMouse: { ...worldPos },
              origStart: el.start ? { ...el.start } : null,
              origEnd: el.end ? { ...el.end } : null,
              origPoints: el.points ? el.points.map((p) => ({ ...p })) : null,
              origFontSize: el.fontSize || null,
              origTextWidth: el.textWidth || null,
              origW: el.w || null, origH: el.h || null,
              origX: el.x !== undefined ? el.x : null, origY: el.y !== undefined ? el.y : null,
            };
            return;
          }
        }
      }

      // Normal element selection
      let clickedElement = null;
      const isModifierActive = e.metaKey || e.shiftKey || e.ctrlKey;

      // Use unified z-order hit testing
      const hitEl = getElementAtWorldPos(worldPos, null);
      if (hitEl && !hitEl.locked) {
        clickedElement = hitEl;
        if (clickedElement.elementType === "image") {
          // already has elementType
        } else if (clickedElement.type !== "text") {
          clickedElement.elementType = "drawing";
        }
      }

      if (clickedElement) {
        state.isRegionSelecting = false;
        if (e.metaKey && !e.shiftKey && !e.ctrlKey) {
          // Cmd-click: select the clicked element plus all elements overlapping its bounds
          const clickedBounds = clickedElement.elementType === "image"
            ? { x: clickedElement.x, y: clickedElement.y, w: clickedElement.w, h: clickedElement.h }
            : getShapeBounds(clickedElement);
          const queryRect = {
            minX: clickedBounds.x, minY: clickedBounds.y,
            maxX: clickedBounds.x + clickedBounds.w, maxY: clickedBounds.y + clickedBounds.h,
          };
          const candidates = spatialIndex.queryRect(queryRect);
          const overlapping = [];
          for (const el of candidates) {
            if (el.locked) continue;
            // Verify actual bounding box overlap (spatial index may return false positives)
            const elBounds = el.elementType === "image"
              ? { x: el.x, y: el.y, w: el.w, h: el.h }
              : getShapeBounds(el);
            const overlaps = elBounds.x < clickedBounds.x + clickedBounds.w &&
                             elBounds.x + elBounds.w > clickedBounds.x &&
                             elBounds.y < clickedBounds.y + clickedBounds.h &&
                             elBounds.y + elBounds.h > clickedBounds.y;
            if (overlaps) {
              if (el.elementType !== "image" && el.type !== "text") el.elementType = "drawing";
              overlapping.push(el);
            }
          }
          state.selectedElements = overlapping;
        } else if (isModifierActive) {
          const idx = state.selectedElements.findIndex((el) => el.id === clickedElement.id);
          if (idx !== -1) state.selectedElements.splice(idx, 1);
          else state.selectedElements.push(clickedElement);
        } else {
          const isAlreadyInSelection = state.selectedElements.some((el) => el.id === clickedElement.id);
          if (!isAlreadyInSelection) state.selectedElements = [clickedElement];
        }
        expandSelectionToGroups();
        pushUndo();
        state.hasDragThresholdBeenMet = false;
        _lastGuideComputeTime = 0; // ensure guides are computed on first drag frame
        state.dragOffsets = state.selectedElements.map((el) => {
          if (el.elementType === "image") {
            return { id: el.id, type: "image", x: el.x, y: el.y, startMouse: { ...worldPos } };
          } else if (el.type === "pen") {
            return { id: el.id, type: "points", points: el.points.map((p) => ({ ...p })), startMouse: { ...worldPos } };
          } else if (el.type === "bezier-path") {
            return { id: el.id, type: "bezier-points", points: el.points.map((p) => ({ x: p.x, y: p.y, cx1: p.cx1, cy1: p.cy1, cx2: p.cx2, cy2: p.cy2 })), startMouse: { ...worldPos } };
          } else {
            return { id: el.id, type: "shape", start: { ...el.start }, end: el.end ? { ...el.end } : null, startMouse: { ...worldPos } };
          }
        });
        // PERFORMANCE: Build a Map for O(1) offset lookups during drag (avoids O(n²) with .find())
        _dragOffsetMap = new Map(state.dragOffsets.map((o) => [o.id, o]));
        // PERFORMANCE: Cache selected IDs for the entire drag duration
        _dragExcludeIds = state.selectedElements.map((el) => el.id);
        _dragExcludeIdSet = new Set(_dragExcludeIds);
        toggleAlignmentPanelVisibility();
      } else {
        // Start region selection
        if (!isModifierActive) state.selectedElements = [];
        state.isRegionSelecting = true;
        state.regionStart = { ...worldPos };
        state.regionEnd = { ...worldPos };
        toggleAlignmentPanelVisibility();
      }
      return;
    }

    // Connector tool
    if (state.currentTool === "connector") {
      const snapThreshold = 30 / state.transform.zoom;
      const hitEl = getElementAtWorldPos(worldPos, null);
      let startConn = null;
      let startPos = { ...worldPos };
      if (hitEl && hitEl.type !== "connector") {
        const port = getClosestConnectionPort(worldPos, hitEl);
        const dist = Math.sqrt((port.x - worldPos.x) ** 2 + (port.y - worldPos.y) ** 2);
        if (dist < snapThreshold) {
          startPos = { x: port.x, y: port.y };
          startConn = { elementId: hitEl.id, ratioX: port.ratioX, ratioY: port.ratioY };
        } else {
          const ratio = computeAnchorRatio(worldPos, hitEl);
          startConn = { elementId: hitEl.id, ratioX: ratio.ratioX, ratioY: ratio.ratioY };
        }
      }
      state.activeConnector = {
        id: "draw_" + state.elementIdCounter++,
        elementType: "drawing",
        type: "connector",
        color: state.drawColor,
        width: state.currentLineWidth,
        start: startPos,
        end: { ...startPos },
        startConn,
        endConn: null,
      };
      return;
    }

    // Laser pointer tool
    if (state.currentTool === "laser") {
      startLaserStroke(worldPos);
      render();
      return;
    }

    // Bézier pen tool
    if (state.currentTool === "bezier-pen") {
      bezierPenMouseDown(e, worldPos);
      return;
    }

    // Drawing tools
    if (state.currentTool === "pen") {
      state.activeShape = {
        id: "draw_" + state.elementIdCounter++,
        elementType: "drawing",
        type: "pen",
        color: state.drawColor,
        width: state.currentLineWidth,
        dash: state.currentLineDash,
        points: [worldPos],
      };
    } else {
      state.activeShape = {
        id: "draw_" + state.elementIdCounter++,
        elementType: "drawing",
        type: state.currentTool,
        color: state.drawColor,
        width: state.currentLineWidth,
        dash: state.currentLineDash,
        start: worldPos,
        end: worldPos,
      };
    }
  });

  // Container mousemove
  container.addEventListener("mousemove", (e) => {
    // Crop mode cursor
    if (state.cropMode && state.cropTarget && state.cropRect && !state.isInteracting) {
      const worldPos = screenToWorld(e.clientX, e.clientY);
      const edge = getCropEdgeAtPoint(worldPos);
      container.style.cursor = edge ? getCropCursor(edge) : "default";
      return;
    }

    // Bézier pen tool needs mousemove even when not interacting (hover feedback)
    if (state.currentTool === "bezier-pen" && !state.isInteracting) {
      const worldPos = screenToWorld(e.clientX, e.clientY);
      bezierPenMouseMove(e, worldPos);
      return;
    }

    if (!state.isInteracting) return;
    state.isShiftPressed = e.shiftKey;

    let dx = e.clientX - state.startX;
    let dy = e.clientY - state.startY;
    let worldPos = screenToWorld(e.clientX, e.clientY);

    // Eyedropper marquee drag (color analysis area selection)
    if (state.eyedropperMarqueeActive && state.eyedropperMarqueeStart) {
      const screenDx = e.clientX - state.startX;
      const screenDy = e.clientY - state.startY;
      if (Math.sqrt(screenDx * screenDx + screenDy * screenDy) < CONSTANTS.MIN_DRAW_DISTANCE) return;

      const startX = state.eyedropperMarqueeStart.x;
      const startY = state.eyedropperMarqueeStart.y;
      state.eyedropperMarqueeRect = {
        x: Math.min(startX, worldPos.x),
        y: Math.min(startY, worldPos.y),
        w: Math.abs(worldPos.x - startX),
        h: Math.abs(worldPos.y - startY),
      };
      render();
      return;
    }

    // Crop drag handling
    if (state.cropMode && state.cropDragEdge && state.cropDragStart && state.cropTarget) {
      const r = state.cropDragStart.rect;
      const mdx = worldPos.x - state.cropDragStart.x;
      const mdy = worldPos.y - state.cropDragStart.y;
      const minSize = 20 / state.transform.zoom;
      const full = getFullImageBounds(state.cropTarget);

      // Move entire crop rect
      if (state.cropDragEdge === "move") {
        let newX = r.x + mdx;
        let newY = r.y + mdy;
        // Clamp to image bounds
        const imgLeft = full.x, imgTop = full.y, imgRight = full.x + full.w, imgBottom = full.y + full.h;
        if (newX < imgLeft) newX = imgLeft;
        if (newY < imgTop) newY = imgTop;
        if (newX + r.w > imgRight) newX = imgRight - r.w;
        if (newY + r.h > imgBottom) newY = imgBottom - r.h;
        state.cropRect = { x: newX, y: newY, w: r.w, h: r.h };
        state.activeSnapGuides = [];
        render();
        return;
      }
      const imgLeft = full.x, imgTop = full.y, imgRight = full.x + full.w, imgBottom = full.y + full.h;
      let newX = r.x, newY = r.y, newW = r.w, newH = r.h;

      if (e.altKey) {
        // Alt/Option: crop symmetrically from center — opposite edge moves equally
        if (state.cropDragEdge.includes("w")) {
          const moved = Math.max(-(r.x - imgLeft), Math.min(mdx, (r.w - minSize) / 2));
          newX = r.x + moved; newW = r.w - moved * 2;
          // Clamp right side to image bounds
          if (newX + newW > imgRight) { newW = imgRight - newX; }
        }
        if (state.cropDragEdge.includes("e")) {
          const moved = Math.max(-(r.w - minSize) / 2, Math.min(mdx, imgRight - (r.x + r.w)));
          newW = r.w + moved * 2; newX = r.x - moved;
          // Clamp left side to image bounds
          if (newX < imgLeft) { const adj = imgLeft - newX; newX = imgLeft; newW -= adj; }
        }
        if (state.cropDragEdge.includes("n")) {
          const moved = Math.max(-(r.y - imgTop), Math.min(mdy, (r.h - minSize) / 2));
          newY = r.y + moved; newH = r.h - moved * 2;
          // Clamp bottom side to image bounds
          if (newY + newH > imgBottom) { newH = imgBottom - newY; }
        }
        if (state.cropDragEdge.includes("s")) {
          const moved = Math.max(-(r.h - minSize) / 2, Math.min(mdy, imgBottom - (r.y + r.h)));
          newH = r.h + moved * 2; newY = r.y - moved;
          // Clamp top side to image bounds
          if (newY < imgTop) { const adj = imgTop - newY; newY = imgTop; newH -= adj; }
        }
      } else {
        if (state.cropDragEdge.includes("w")) { const moved = Math.max(-(r.x - imgLeft), Math.min(mdx, r.w - minSize)); newX = r.x + moved; newW = r.w - moved; }
        if (state.cropDragEdge.includes("e")) { const moved = Math.max(-(r.w - minSize), Math.min(mdx, imgRight - (r.x + r.w))); newW = r.w + moved; }
        if (state.cropDragEdge.includes("n")) { const moved = Math.max(-(r.y - imgTop), Math.min(mdy, r.h - minSize)); newY = r.y + moved; newH = r.h - moved; }
        if (state.cropDragEdge.includes("s")) { const moved = Math.max(-(r.h - minSize), Math.min(mdy, imgBottom - (r.y + r.h))); newH = r.h + moved; }
      }

      // Shift: snap crop edges to guide lines from other elements, ruler guides, and proportional grid
      if (e.shiftKey) {
        const snapThreshold = (CONSTANTS.SNAP_THRESHOLD * 2) / state.transform.zoom;
        const cropBounds = { x: newX, y: newY, w: newW, h: newH };
        const targets = getSnapTargets([state.cropTarget.id], cropBounds);

        // Snap moving edges based on which crop edge is being dragged
        const edge = state.cropDragEdge;
        let snapDx = 0, snapDy = 0;
        let bestDistX = snapThreshold, bestDistY = snapThreshold;

        if (edge.includes("w")) {
          for (const tX of targets.x) {
            const dist = Math.abs(newX - tX);
            if (dist < bestDistX) { bestDistX = dist; snapDx = tX - newX; }
          }
        }
        if (edge.includes("e")) {
          const rightEdge = newX + newW;
          for (const tX of targets.x) {
            const dist = Math.abs(rightEdge - tX);
            if (dist < bestDistX) { bestDistX = dist; snapDx = tX - rightEdge; }
          }
        }
        if (edge.includes("n")) {
          for (const tY of targets.y) {
            const dist = Math.abs(newY - tY);
            if (dist < bestDistY) { bestDistY = dist; snapDy = tY - newY; }
          }
        }
        if (edge.includes("s")) {
          const bottomEdge = newY + newH;
          for (const tY of targets.y) {
            const dist = Math.abs(bottomEdge - tY);
            if (dist < bestDistY) { bestDistY = dist; snapDy = tY - bottomEdge; }
          }
        }

        // Apply snaps while respecting image bounds
        if (snapDx !== 0) {
          if (edge.includes("w")) {
            const snappedX = newX + snapDx;
            if (snappedX >= imgLeft && (newW - snapDx) >= minSize) { newX = snappedX; newW -= snapDx; }
          } else if (edge.includes("e")) {
            const snappedRight = newX + newW + snapDx;
            if (snappedRight <= imgRight && (newW + snapDx) >= minSize) { newW += snapDx; }
          }
        }
        if (snapDy !== 0) {
          if (edge.includes("n")) {
            const snappedY = newY + snapDy;
            if (snappedY >= imgTop && (newH - snapDy) >= minSize) { newY = snappedY; newH -= snapDy; }
          } else if (edge.includes("s")) {
            const snappedBottom = newY + newH + snapDy;
            if (snappedBottom <= imgBottom && (newH + snapDy) >= minSize) { newH += snapDy; }
          }
        }

        // Build visual snap guides for rendering
        const guides = [];
        if (snapDx !== 0 && bestDistX < snapThreshold) {
          const snappedX = edge.includes("w") ? newX : newX + newW;
          guides.push({ axis: "x", pos: snappedX });
        }
        if (snapDy !== 0 && bestDistY < snapThreshold) {
          const snappedY = edge.includes("n") ? newY : newY + newH;
          guides.push({ axis: "y", pos: snappedY });
        }
        state.activeSnapGuides = guides;

        // Also snap to image proportional grid (quarters)
        const propThreshold = 10 / state.transform.zoom;
        const xSnaps = [0, 0.25, 0.5, 0.75, 1].map(f => full.x + f * full.w);
        const ySnaps = [0, 0.25, 0.5, 0.75, 1].map(f => full.y + f * full.h);
        if (state.cropDragEdge.includes("w")) { for (const sx of xSnaps) { if (Math.abs(newX - sx) < propThreshold) { newW += newX - sx; newX = sx; break; } } }
        if (state.cropDragEdge.includes("e")) { for (const sx of xSnaps) { if (Math.abs((newX + newW) - sx) < propThreshold) { newW = sx - newX; break; } } }
        if (state.cropDragEdge.includes("n")) { for (const sy of ySnaps) { if (Math.abs(newY - sy) < propThreshold) { newH += newY - sy; newY = sy; break; } } }
        if (state.cropDragEdge.includes("s")) { for (const sy of ySnaps) { if (Math.abs((newY + newH) - sy) < propThreshold) { newH = sy - newY; break; } } }
      } else {
        state.activeSnapGuides = [];
      }

      state.cropRect = { x: newX, y: newY, w: newW, h: newH };
      render();
      return;
    }

    if (state.isMiddleClick || state.isRightClickHand || state.currentTool === "pan") {
      if (e.shiftKey) {
        if (!state.panLockDirection) {
          if (Math.abs(dx) > 4 || Math.abs(dy) > 4) state.panLockDirection = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
        }
        if (state.panLockDirection === "x") dy = 0;
        else if (state.panLockDirection === "y") dx = 0;
      } else { state.panLockDirection = null; }
      state.transform.x += dx; state.transform.y += dy;
      state.startX = e.clientX; state.startY = e.clientY;
      updateZoomSliderValue(); render();
      return;
    }

    if (state.currentTool === "eraser") { checkAndEraseAtPosition(worldPos); return; }

    if (state.currentTool === "select") {
      if (state.resizingElement) {
        const el = state.resizingElement;
        const sb = state.resizeStartBounds;
        const hp = sb.handlePosition;
        const mouseDx = worldPos.x - sb.startMouse.x;
        const mouseDy = worldPos.y - sb.startMouse.y;

        if ((el.type === "connector" || el.type === "line" || el.type === "arrow" || el.type === "measure") && (hp === "start" || hp === "end")) {
          let targetPos = { ...worldPos };
          if (e.shiftKey) { const anchor = hp === "start" ? el.end : el.start; targetPos = constraintToAngle(anchor, worldPos); }
          if (hp === "start") {
            el.start = targetPos;
            if (el.type === "connector") {
              const snapTh = 30 / state.transform.zoom;
              const hitEl = getElementAtWorldPos(targetPos, el);
              if (hitEl && hitEl.type !== "connector") {
                const port = getClosestConnectionPort(targetPos, hitEl);
                const dist = Math.sqrt((port.x - targetPos.x) ** 2 + (port.y - targetPos.y) ** 2);
                if (dist < snapTh) { el.start = { x: port.x, y: port.y }; el.startConn = { elementId: hitEl.id, ratioX: port.ratioX, ratioY: port.ratioY }; }
                else { const ratio = computeAnchorRatio(targetPos, hitEl); el.startConn = { elementId: hitEl.id, ratioX: ratio.ratioX, ratioY: ratio.ratioY }; }
              } else { el.startConn = null; }
            }
          } else {
            el.end = targetPos;
            if (el.type === "connector") {
              const snapTh = 30 / state.transform.zoom;
              const hitEl = getElementAtWorldPos(targetPos, el);
              if (hitEl && hitEl.type !== "connector") {
                const port = getClosestConnectionPort(targetPos, hitEl);
                const dist = Math.sqrt((port.x - targetPos.x) ** 2 + (port.y - targetPos.y) ** 2);
                if (dist < snapTh) { el.end = { x: port.x, y: port.y }; el.endConn = { elementId: hitEl.id, ratioX: port.ratioX, ratioY: port.ratioY }; }
                else { const ratio = computeAnchorRatio(targetPos, hitEl); el.endConn = { elementId: hitEl.id, ratioX: ratio.ratioX, ratioY: ratio.ratioY }; }
              } else { el.endConn = null; }
            }
          }
          render(); return;
        }

        if (el.elementType === "image") {
          let newW, newH, newX, newY;
          if (e.altKey) {
            // Alt/Option: resize symmetrically from center
            const centerX = sb.x + sb.w / 2;
            const centerY = sb.y + sb.h / 2;
            if (hp === "br" || hp === "tr") { newW = Math.max(20, sb.w + mouseDx * 2); }
            else { newW = Math.max(20, sb.w - mouseDx * 2); }
            newH = newW / sb.ratio;
            newX = centerX - newW / 2;
            newY = centerY - newH / 2;
          } else {
            if (hp === "br") { newW = Math.max(20, sb.w + mouseDx); newH = newW / sb.ratio; newX = sb.x; newY = sb.y; }
            else if (hp === "bl") { newW = Math.max(20, sb.w - mouseDx); newH = newW / sb.ratio; newX = sb.x + sb.w - newW; newY = sb.y; }
            else if (hp === "tr") { newW = Math.max(20, sb.w + mouseDx); newH = newW / sb.ratio; newX = sb.x; newY = sb.y + sb.h - newH; }
            else { newW = Math.max(20, sb.w - mouseDx); newH = newW / sb.ratio; newX = sb.x + sb.w - newW; newY = sb.y + sb.h - newH; }
          }
          if (e.shiftKey) {
            const fullNatW = el.img.naturalWidth || sb.w;
            const fullNatH = el.img.naturalHeight || sb.h;
            // Use cropped region's natural dimensions for step snapping
            const naturalW = el.crop ? fullNatW * el.crop.w : fullNatW;
            const naturalH = el.crop ? fullNatH * el.crop.h : fullNatH;
            const stepW = naturalW * 0.25, stepH = naturalH * 0.25;
            newW = Math.max(stepW, Math.round(newW / stepW) * stepW);
            newH = Math.max(stepH, Math.round(newH / stepH) * stepH);
            if (e.altKey) { const cx = sb.x + sb.w / 2; const cy = sb.y + sb.h / 2; newX = cx - newW / 2; newY = cy - newH / 2; }
            else { if (hp === "bl" || hp === "tl") newX = sb.x + sb.w - newW; if (hp === "tr" || hp === "tl") newY = sb.y + sb.h - newH; }
            state.activeSnapGuides = [];
          } else {
            // Snap moving edges to guides/other elements
            const resizeBounds = { x: newX, y: newY, w: newW, h: newH };
            const snapThreshold = (CONSTANTS.SNAP_THRESHOLD * 2) / state.transform.zoom;
            const targets = getSnapTargets([el.id], resizeBounds);
            if (targets.x.length === 0 && targets.y.length === 0) {
              console.warn("[resize-snap] No snap targets found for element", el.id);
            }
            const snap = snapResizeEdges(resizeBounds, hp, targets, snapThreshold);
            if (snap.dx !== 0 || snap.dy !== 0) {
              // For aspect-ratio-locked images, pick the axis with the smaller correction
              if (snap.dy !== 0 && (snap.dx === 0 || Math.abs(snap.dy) <= Math.abs(snap.dx))) {
                // Snap via Y axis: adjust height, recalc width for aspect ratio
                if (e.altKey) { newH += snap.dy * 2; newW = newH * sb.ratio; const cx = sb.x + sb.w / 2; const cy = sb.y + sb.h / 2; newX = cx - newW / 2; newY = cy - newH / 2; }
                else { if (hp === "br" || hp === "bl") { newH += snap.dy; } else { newH -= snap.dy; newY += snap.dy; } newW = newH * sb.ratio; if (hp === "bl" || hp === "tl") newX = sb.x + sb.w - newW; if (hp === "tr" || hp === "tl") newY = sb.y + sb.h - newH; }
              } else if (snap.dx !== 0) {
                // Snap via X axis: adjust width, recalc height for aspect ratio
                if (e.altKey) { newW += snap.dx * 2; newH = newW / sb.ratio; const cx = sb.x + sb.w / 2; const cy = sb.y + sb.h / 2; newX = cx - newW / 2; newY = cy - newH / 2; }
                else { if (hp === "br" || hp === "tr") { newW += snap.dx; } else { newW -= snap.dx; newX += snap.dx; } newH = newW / sb.ratio; if (hp === "tr" || hp === "tl") newY = sb.y + sb.h - newH; if (hp === "bl" || hp === "tl") newX = sb.x + sb.w - newW; }
              }
            }
            state.activeSnapGuides = snap.guides;
          }
          el.x = newX; el.y = newY; el.w = newW; el.h = newH;
          // Keep fullBounds in sync for cropped images
          if (el.crop && el.fullBounds) {
            const fullW = el.w / el.crop.w;
            const fullH = el.h / el.crop.h;
            el.fullBounds = { x: el.x - el.crop.x * fullW, y: el.y - el.crop.y * fullH, w: fullW, h: fullH };
          }
        } else if (el.type === "text") {
          if (e.metaKey) {
            // Cmd+drag: resize text area width (reflow mode)
            let newTextWidth;
            const initialW = sb.w || 50;
            if (hp === "br" || hp === "tr") newTextWidth = Math.max(30, initialW + mouseDx);
            else newTextWidth = Math.max(30, initialW - mouseDx);
            el.textWidth = newTextWidth;
            // Invalidate cached measurements so rendering recalculates wrapped lines
            el.w = null;
            el.h = null;
            state.activeSnapGuides = [];
          } else {
            let scaleFactor;
            const initialW = sb.w || 50;
            if (e.altKey) {
              // Alt/Option: resize text symmetrically from center (double the delta)
              if (hp === "br" || hp === "tr") scaleFactor = (initialW + mouseDx * 2) / initialW;
              else scaleFactor = (initialW - mouseDx * 2) / initialW;
            } else {
              if (hp === "br" || hp === "tr") scaleFactor = (initialW + mouseDx) / initialW;
              else scaleFactor = (initialW - mouseDx) / initialW;
            }
            scaleFactor = Math.max(0.2, scaleFactor);
            if (!e.shiftKey) {
              // Snap text resize edges to guides
              const newW = initialW * scaleFactor;
              const newH = (sb.h || 50) * scaleFactor;
              let newX, newY;
              if (e.altKey) { newX = sb.x + sb.w / 2 - newW / 2; newY = sb.y + sb.h / 2 - newH / 2; }
              else { newX = (hp === "bl" || hp === "tl") ? sb.x + sb.w - newW : sb.x; newY = (hp === "tr" || hp === "tl") ? sb.y + sb.h - newH : sb.y; }
              const resizeBounds = { x: newX, y: newY, w: newW, h: newH };
              const snapThreshold = (CONSTANTS.SNAP_THRESHOLD * 2) / state.transform.zoom;
              const targets = getSnapTargets([el.id], resizeBounds);
              const snap = snapResizeEdges(resizeBounds, hp, targets, snapThreshold);
              if (snap.dx !== 0) {
                if (hp === "br" || hp === "tr") scaleFactor = (newW + snap.dx) / initialW;
                else scaleFactor = (newW - snap.dx) / initialW;
                scaleFactor = Math.max(0.2, scaleFactor);
              }
              state.activeSnapGuides = snap.guides;
            } else {
              state.activeSnapGuides = [];
            }
            el.fontSize = Math.max(8, Math.round(sb.origFontSize * scaleFactor));
            // When alt is held, reposition text to keep it centered
            if (e.altKey) {
              const newW = initialW * scaleFactor;
              const newH = (sb.h || 50) * scaleFactor;
              el.start = { x: sb.x + sb.w / 2 - newW / 2, y: sb.y + sb.h / 2 - newH / 2 };
            }
          }
        } else if (el.type === "pen") {
          const origBounds = { x: sb.x, y: sb.y, w: sb.w, h: sb.h };
          let scaleX = 1, scaleY = 1, anchorX, anchorY;
          if (e.altKey) {
            // Alt/Option: resize pen from center
            anchorX = origBounds.x + origBounds.w / 2;
            anchorY = origBounds.y + origBounds.h / 2;
            if (hp === "br" || hp === "tr") { scaleX = origBounds.w > 0 ? (origBounds.w + mouseDx * 2) / origBounds.w : 1; }
            else { scaleX = origBounds.w > 0 ? (origBounds.w - mouseDx * 2) / origBounds.w : 1; }
            if (hp === "br" || hp === "bl") { scaleY = origBounds.h > 0 ? (origBounds.h + mouseDy * 2) / origBounds.h : 1; }
            else { scaleY = origBounds.h > 0 ? (origBounds.h - mouseDy * 2) / origBounds.h : 1; }
          } else {
            if (hp === "br") { anchorX = origBounds.x; anchorY = origBounds.y; scaleX = origBounds.w > 0 ? (origBounds.w + mouseDx) / origBounds.w : 1; scaleY = origBounds.h > 0 ? (origBounds.h + mouseDy) / origBounds.h : 1; }
            else if (hp === "bl") { anchorX = origBounds.x + origBounds.w; anchorY = origBounds.y; scaleX = origBounds.w > 0 ? (origBounds.w - mouseDx) / origBounds.w : 1; scaleY = origBounds.h > 0 ? (origBounds.h + mouseDy) / origBounds.h : 1; }
            else if (hp === "tr") { anchorX = origBounds.x; anchorY = origBounds.y + origBounds.h; scaleX = origBounds.w > 0 ? (origBounds.w + mouseDx) / origBounds.w : 1; scaleY = origBounds.h > 0 ? (origBounds.h - mouseDy) / origBounds.h : 1; }
            else { anchorX = origBounds.x + origBounds.w; anchorY = origBounds.y + origBounds.h; scaleX = origBounds.w > 0 ? (origBounds.w - mouseDx) / origBounds.w : 1; scaleY = origBounds.h > 0 ? (origBounds.h - mouseDy) / origBounds.h : 1; }
          }
          if (e.shiftKey) { const u = Math.max(scaleX, scaleY); scaleX = u; scaleY = u; }
          scaleX = Math.max(0.1, scaleX); scaleY = Math.max(0.1, scaleY);
          if (!e.shiftKey) {
            // Snap resize edges to guides
            const newW = origBounds.w * scaleX;
            const newH = origBounds.h * scaleY;
            let newX, newY;
            if (e.altKey) { newX = anchorX - newW / 2; newY = anchorY - newH / 2; }
            else { newX = hp === "bl" || hp === "tl" ? anchorX - newW : anchorX; newY = hp === "tr" || hp === "tl" ? anchorY - newH : anchorY; }
            const resizeBounds = { x: newX, y: newY, w: newW, h: newH };
            const snapThreshold = (CONSTANTS.SNAP_THRESHOLD * 2) / state.transform.zoom;
            const targets = getSnapTargets([el.id], resizeBounds);
            const snap = snapResizeEdges(resizeBounds, hp, targets, snapThreshold);
            if (snap.dx !== 0 && origBounds.w > 0) {
              if (hp === "br" || hp === "tr") scaleX = (newW + snap.dx) / origBounds.w;
              else scaleX = (newW - snap.dx) / origBounds.w;
            }
            if (snap.dy !== 0 && origBounds.h > 0) {
              if (hp === "br" || hp === "bl") scaleY = (newH + snap.dy) / origBounds.h;
              else scaleY = (newH - snap.dy) / origBounds.h;
            }
            scaleX = Math.max(0.1, scaleX); scaleY = Math.max(0.1, scaleY);
            state.activeSnapGuides = snap.guides;
          } else {
            state.activeSnapGuides = [];
          }
          el.points = sb.origPoints.map((p) => ({ x: anchorX + (p.x - anchorX) * scaleX, y: anchorY + (p.y - anchorY) * scaleY }));
        } else {
          const origStart = sb.origStart, origEnd = sb.origEnd;
          const origBounds = { x: sb.x, y: sb.y, w: sb.w, h: sb.h };
          let scaleX = 1, scaleY = 1, anchorX, anchorY;
          if (e.altKey) {
            // Alt/Option: resize shape from center
            anchorX = origBounds.x + origBounds.w / 2;
            anchorY = origBounds.y + origBounds.h / 2;
            if (hp === "br" || hp === "tr") { scaleX = origBounds.w > 0 ? (origBounds.w + mouseDx * 2) / origBounds.w : 1; }
            else { scaleX = origBounds.w > 0 ? (origBounds.w - mouseDx * 2) / origBounds.w : 1; }
            if (hp === "br" || hp === "bl") { scaleY = origBounds.h > 0 ? (origBounds.h + mouseDy * 2) / origBounds.h : 1; }
            else { scaleY = origBounds.h > 0 ? (origBounds.h - mouseDy * 2) / origBounds.h : 1; }
          } else {
            if (hp === "br") { anchorX = origBounds.x; anchorY = origBounds.y; scaleX = origBounds.w > 0 ? (origBounds.w + mouseDx) / origBounds.w : 1; scaleY = origBounds.h > 0 ? (origBounds.h + mouseDy) / origBounds.h : 1; }
            else if (hp === "bl") { anchorX = origBounds.x + origBounds.w; anchorY = origBounds.y; scaleX = origBounds.w > 0 ? (origBounds.w - mouseDx) / origBounds.w : 1; scaleY = origBounds.h > 0 ? (origBounds.h + mouseDy) / origBounds.h : 1; }
            else if (hp === "tr") { anchorX = origBounds.x; anchorY = origBounds.y + origBounds.h; scaleX = origBounds.w > 0 ? (origBounds.w + mouseDx) / origBounds.w : 1; scaleY = origBounds.h > 0 ? (origBounds.h - mouseDy) / origBounds.h : 1; }
            else { anchorX = origBounds.x + origBounds.w; anchorY = origBounds.y + origBounds.h; scaleX = origBounds.w > 0 ? (origBounds.w - mouseDx) / origBounds.w : 1; scaleY = origBounds.h > 0 ? (origBounds.h - mouseDy) / origBounds.h : 1; }
          }
          if (e.shiftKey) { const u = Math.max(scaleX, scaleY); scaleX = u; scaleY = u; }
          scaleX = Math.max(0.1, scaleX); scaleY = Math.max(0.1, scaleY);
          if (!e.shiftKey) {
            // Snap resize edges to guides
            const newW = origBounds.w * scaleX;
            const newH = origBounds.h * scaleY;
            let newX, newY;
            if (e.altKey) { newX = anchorX - newW / 2; newY = anchorY - newH / 2; }
            else { newX = hp === "bl" || hp === "tl" ? anchorX - newW : anchorX; newY = hp === "tr" || hp === "tl" ? anchorY - newH : anchorY; }
            const resizeBounds = { x: newX, y: newY, w: newW, h: newH };
            const snapThreshold = (CONSTANTS.SNAP_THRESHOLD * 2) / state.transform.zoom;
            const targets = getSnapTargets([el.id], resizeBounds);
            const snap = snapResizeEdges(resizeBounds, hp, targets, snapThreshold);
            if (snap.dx !== 0 && origBounds.w > 0) {
              if (hp === "br" || hp === "tr") scaleX = (newW + snap.dx) / origBounds.w;
              else scaleX = (newW - snap.dx) / origBounds.w;
            }
            if (snap.dy !== 0 && origBounds.h > 0) {
              if (hp === "br" || hp === "bl") scaleY = (newH + snap.dy) / origBounds.h;
              else scaleY = (newH - snap.dy) / origBounds.h;
            }
            scaleX = Math.max(0.1, scaleX); scaleY = Math.max(0.1, scaleY);
            state.activeSnapGuides = snap.guides;
          } else {
            state.activeSnapGuides = [];
          }
          el.start = { x: anchorX + (origStart.x - anchorX) * scaleX, y: anchorY + (origStart.y - anchorY) * scaleY };
          if (origEnd) el.end = { x: anchorX + (origEnd.x - anchorX) * scaleX, y: anchorY + (origEnd.y - anchorY) * scaleY };
        }
        updateConnectorsForElements([el.id]);
        render(); return;
      }

      if (state.isRegionSelecting) { state.regionEnd = { ...worldPos }; render(); }
      else if (state.selectedElements.length > 0) {
        // Don't move elements until the drag distance exceeds the minimum threshold
        if (!state.hasDragThresholdBeenMet) {
          const screenDx = e.clientX - state.startX;
          const screenDy = e.clientY - state.startY;
          if (Math.sqrt(screenDx * screenDx + screenDy * screenDy) < CONSTANTS.MIN_MOVE_DISTANCE) return;
          state.hasDragThresholdBeenMet = true;
        }
        const excludeIds = _dragExcludeIds || state.selectedElements.map((el) => el.id);
        state.selectedElements.forEach((el) => {
          const offset = _dragOffsetMap ? _dragOffsetMap.get(el.id) : state.dragOffsets.find((o) => o.id === el.id);
          if (!offset) return;
          const curDx = worldPos.x - offset.startMouse.x;
          const curDy = worldPos.y - offset.startMouse.y;
          if (offset.type === "image") { el.x = offset.x + curDx; el.y = offset.y + curDy; }
          else if (offset.type === "points") { el.points = offset.points.map((p) => ({ x: p.x + curDx, y: p.y + curDy })); }
          else if (offset.type === "bezier-points") { el.points = offset.points.map((p) => ({ x: p.x + curDx, y: p.y + curDy, cx1: p.cx1 + curDx, cy1: p.cy1 + curDy, cx2: p.cx2 + curDx, cy2: p.cy2 + curDy })); }
          else { el.start = { x: offset.start.x + curDx, y: offset.start.y + curDy }; if (el.end && offset.end) el.end = { x: offset.end.x + curDx, y: offset.end.y + curDy }; }
        });

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        state.selectedElements.forEach((el) => {
          let bx, by, bw, bh;
          if (el.elementType === "image") {
            bx = el.x; by = el.y; bw = el.w; bh = el.h;
          } else if (el.start && el.end) {
            // Fast path for line-type elements (line, arrow, split lines, connectors)
            bx = Math.min(el.start.x, el.end.x);
            by = Math.min(el.start.y, el.end.y);
            bw = Math.max(el.start.x, el.end.x) - bx;
            bh = Math.max(el.start.y, el.end.y) - by;
          } else {
            const b = getShapeBounds(el);
            bx = b.x; by = b.y; bw = b.w; bh = b.h;
          }
          if (bx < minX) minX = bx; if (by < minY) minY = by;
          if (bx + bw > maxX) maxX = bx + bw; if (by + bh > maxY) maxY = by + bh;
        });
        let groupBounds = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };

        if (e.shiftKey) {
          // Grid snapping takes priority when grid is visible
          if (state.gridVisible && state.gridSize > 0) {
            const gridSize = state.gridSize;
            // Find the corner of groupBounds closest to the cursor
            const corners = [
              { x: groupBounds.x, y: groupBounds.y },
              { x: groupBounds.x + groupBounds.w, y: groupBounds.y },
              { x: groupBounds.x, y: groupBounds.y + groupBounds.h },
              { x: groupBounds.x + groupBounds.w, y: groupBounds.y + groupBounds.h },
            ];
            let closest = corners[0];
            let closestDist = Infinity;
            for (const c of corners) {
              const d = (c.x - worldPos.x) ** 2 + (c.y - worldPos.y) ** 2;
              if (d < closestDist) { closestDist = d; closest = c; }
            }
            // Snap that corner to the nearest grid point
            const snappedX = Math.round(closest.x / gridSize) * gridSize;
            const snappedY = Math.round(closest.y / gridSize) * gridSize;
            const gridDx = snappedX - closest.x;
            const gridDy = snappedY - closest.y;
            if (gridDx !== 0 || gridDy !== 0) {
              state.selectedElements.forEach((el) => {
                if (el.elementType === "image") { el.x += gridDx; el.y += gridDy; }
                else if (el.type === "pen") { el.points = el.points.map((p) => ({ x: p.x + gridDx, y: p.y + gridDy })); }
                else { el.start.x += gridDx; el.start.y += gridDy; if (el.end) { el.end.x += gridDx; el.end.y += gridDy; } }
              });
            }
            // Recompute
            minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
            state.selectedElements.forEach((el) => {
              if (el.elementType === "image") { if (el.x < minX) minX = el.x; if (el.y < minY) minY = el.y; if (el.x + el.w > maxX) maxX = el.x + el.w; if (el.y + el.h > maxY) maxY = el.y + el.h; }
              else if (el.start && el.end) { const x0 = Math.min(el.start.x, el.end.x), y0 = Math.min(el.start.y, el.end.y), x1 = Math.max(el.start.x, el.end.x), y1 = Math.max(el.start.y, el.end.y); if (x0 < minX) minX = x0; if (y0 < minY) minY = y0; if (x1 > maxX) maxX = x1; if (y1 > maxY) maxY = y1; }
              else { const b = getShapeBounds(el); if (b.x < minX) minX = b.x; if (b.y < minY) minY = b.y; if (b.x + b.w > maxX) maxX = b.x + b.w; if (b.y + b.h > maxY) maxY = b.y + b.h; }
            });
            groupBounds = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
            state.activeSnapGuides = [];
            state.activeProximityGuides = [];
            state.activeSpacingGuides = [];
          } else {
            const targets = getSnapTargets(excludeIds, groupBounds);
            const threshold = CONSTANTS.SNAP_THRESHOLD / state.transform.zoom;
            const snap = snapToElements(groupBounds, targets, threshold);
            const spacingSnap = snapToSpacing(groupBounds, excludeIds, threshold);
            let finalDx = snap.dx, finalDy = snap.dy;
            if (Math.abs(spacingSnap.dx) > 0 && (Math.abs(snap.dx) === 0 || Math.abs(spacingSnap.dx) < Math.abs(snap.dx))) finalDx = spacingSnap.dx;
            if (Math.abs(spacingSnap.dy) > 0 && (Math.abs(snap.dy) === 0 || Math.abs(spacingSnap.dy) < Math.abs(snap.dy))) finalDy = spacingSnap.dy;
            if (finalDx !== 0 || finalDy !== 0) {
              state.selectedElements.forEach((el) => {
                if (el.elementType === "image") { el.x += finalDx; el.y += finalDy; }
                else if (el.type === "pen") { el.points = el.points.map((p) => ({ x: p.x + finalDx, y: p.y + finalDy })); }
                else { el.start.x += finalDx; el.start.y += finalDy; if (el.end) { el.end.x += finalDx; el.end.y += finalDy; } }
              });
            }
            // Recompute
            minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
            state.selectedElements.forEach((el) => {
              if (el.elementType === "image") { if (el.x < minX) minX = el.x; if (el.y < minY) minY = el.y; if (el.x + el.w > maxX) maxX = el.x + el.w; if (el.y + el.h > maxY) maxY = el.y + el.h; }
              else if (el.start && el.end) { const x0 = Math.min(el.start.x, el.end.x), y0 = Math.min(el.start.y, el.end.y), x1 = Math.max(el.start.x, el.end.x), y1 = Math.max(el.start.y, el.end.y); if (x0 < minX) minX = x0; if (y0 < minY) minY = y0; if (x1 > maxX) maxX = x1; if (y1 > maxY) maxY = y1; }
              else { const b = getShapeBounds(el); if (b.x < minX) minX = b.x; if (b.y < minY) minY = b.y; if (b.x + b.w > maxX) maxX = b.x + b.w; if (b.y + b.h > maxY) maxY = b.y + b.h; }
            });
            groupBounds = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
            state.activeSnapGuides = snap.guides;
            state.activeProximityGuides = [];
            state.activeSpacingGuides = getSpacingGuides(groupBounds, excludeIds);
          }
        } else {
          // No guides unless Shift is held — improves performance during drag
          state.activeSnapGuides = [];
          state.activeProximityGuides = [];
          state.activeSpacingGuides = [];
        }
        updateConnectorsForElements(_dragExcludeIds || state.selectedElements.map((el) => el.id));
        const draggedIds = _dragExcludeIdSet || new Set(state.selectedElements.map((el) => el.id));
        for (const el of state.selectedElements) {
          if (el.type === "connector") {
            if (el.startConn && !draggedIds.has(el.startConn.elementId)) el.startConn = null;
            if (el.endConn && !draggedIds.has(el.endConn.elementId)) el.endConn = null;
          }
        }
        render();
      }
    } else if (state.stampMarqueeActive) {
      // Update stamp marquee rectangle while dragging
      const screenDx = e.clientX - state.startX;
      const screenDy = e.clientY - state.startY;
      if (Math.sqrt(screenDx * screenDx + screenDy * screenDy) < CONSTANTS.MIN_DRAW_DISTANCE) return;
      const startX = state.stampMarqueeStart.x;
      const startY = state.stampMarqueeStart.y;
      state.stampMarqueeRect = {
        x: Math.min(startX, worldPos.x),
        y: Math.min(startY, worldPos.y),
        w: Math.abs(worldPos.x - startX),
        h: Math.abs(worldPos.y - startY),
      };
      render();
    } else if (state.marqueeIsSelecting || state.marqueeIsDragging) {
      marqueeUpdateSelection(worldPos, e.shiftKey);
    } else if (isAccessibilityPreviewInteracting()) {
      accessibilityPreviewMove(worldPos, e.shiftKey);
    } else if (state.activeMeasureLine) {
      // Don't update measure line until user has dragged beyond minimum distance
      const screenDx = e.clientX - state.startX;
      const screenDy = e.clientY - state.startY;
      if (Math.sqrt(screenDx * screenDx + screenDy * screenDy) < CONSTANTS.MIN_DRAW_DISTANCE) return;

      if (e.shiftKey) worldPos = constraintToAngle(state.activeMeasureLine.start, worldPos);
      state.activeMeasureLine.end = { ...worldPos };
      render();
    } else if (state.activeContrastLine) {
      // Don't update contrast line until user has dragged beyond minimum distance
      const screenDx = e.clientX - state.startX;
      const screenDy = e.clientY - state.startY;
      if (Math.sqrt(screenDx * screenDx + screenDy * screenDy) < CONSTANTS.MIN_DRAW_DISTANCE) return;

      state.activeContrastLine.end = { ...worldPos };
      render();
    } else if (state.laserActiveStroke) {
      extendLaserStroke(worldPos);
      render();
    } else if (state.currentTool === "bezier-pen" && (state.bezierDragging || state.bezierPath)) {
      bezierPenMouseMove(e, worldPos);
    } else if (state.activeConnector) {
      // Don't update connector until user has dragged beyond minimum distance
      const screenDx = e.clientX - state.startX;
      const screenDy = e.clientY - state.startY;
      if (Math.sqrt(screenDx * screenDx + screenDy * screenDy) < CONSTANTS.MIN_DRAW_DISTANCE) return;

      const snapThreshold = 30 / state.transform.zoom;
      const hitEl = getElementAtWorldPos(worldPos, null);
      state.connectorHoverTarget = null;
      if (hitEl && hitEl.type !== "connector" && (!state.activeConnector.startConn || hitEl.id !== state.activeConnector.startConn.elementId)) {
        state.connectorHoverTarget = hitEl;
        const port = getClosestConnectionPort(worldPos, hitEl);
        const dist = Math.sqrt((port.x - worldPos.x) ** 2 + (port.y - worldPos.y) ** 2);
        if (dist < snapThreshold) state.activeConnector.end = { x: port.x, y: port.y };
        else state.activeConnector.end = { ...worldPos };
      } else {
        if (e.shiftKey) worldPos = constraintToAngle(state.activeConnector.start, worldPos);
        state.activeConnector.end = { ...worldPos };
      }
      render();
    } else if (state.activeShape) {
      // Don't update shape until user has dragged beyond minimum distance
      const screenDx = e.clientX - state.startX;
      const screenDy = e.clientY - state.startY;
      if (Math.sqrt(screenDx * screenDx + screenDy * screenDy) < CONSTANTS.MIN_DRAW_DISTANCE) return;

      if (state.activeShape.type === "pen") {
        if (e.shiftKey && state.activeShape.points.length > 0) worldPos = constraintToAngle(state.activeShape.points[0], worldPos);
        state.activeShape.points.push(worldPos);
      } else {
        if (e.shiftKey) worldPos = constraintToAngle(state.activeShape.start, worldPos);
        state.activeShape.end = worldPos;
      }
      render();
    }
  });

  // Container mouseup
  container.addEventListener("mouseup", (e) => {
    if (!state.isInteracting) return;
    state.isInteracting = false;
    state.panLockDirection = null;
    state.resizingElement = null;
    state.activeSnapGuides = [];
    state.activeProximityGuides = [];
    state.activeSpacingGuides = [];

    if (state.cropMode && state.cropDragEdge) {
      state.cropDragEdge = null;
      state.cropDragStart = null;
      render(); return;
    }

    // Bézier pen tool mouseup
    if (state.currentTool === "bezier-pen") {
      const worldPos = screenToWorld(e.clientX, e.clientY);
      bezierPenMouseUp(e, worldPos);
      // Don't fall through to the drawing tools commit logic
      render();
      return;
    }

    // Eyedropper tool mouseup: either single-click pick or drag-select color analysis
    if (state.currentTool === "eyedropper" && state.eyedropperMarqueeActive) {
      state.eyedropperMarqueeActive = false;
      const rect = state.eyedropperMarqueeRect;
      const worldPos = screenToWorld(e.clientX, e.clientY);

      // Check if this was a drag or just a click
      const screenDx = e.clientX - state.startX;
      const screenDy = e.clientY - state.startY;
      const wasDrag = Math.sqrt(screenDx * screenDx + screenDy * screenDy) >= CONSTANTS.MIN_DRAW_DISTANCE;

      if (wasDrag && rect && rect.w > 2 && rect.h > 2) {
        // Drag completed — analyze colors in the selected area, keep rect visible
        eyedropperAnalyzeArea(rect, e);
        state.eyedropperMarqueeStart = null;
      } else {
        // Single click — normal color pick behavior, clear any previous rect
        state.eyedropperMarqueeRect = null;
        state.eyedropperMarqueeStart = null;
        eyedropperPickColor(e, worldPos);
      }

      render();
      return;
    }

    if (state.currentTool === "stamp" && state.stampMarqueeActive) {
      // Finalize stamp marquee: stamp onto all images intersecting the rectangle
      // or remove all drawings in the area if Alt/Option is held
      state.stampMarqueeActive = false;
      const rect = state.stampMarqueeRect;
      if (!rect || rect.w < 2 || rect.h < 2) {
        state.stampMarqueeRect = null;
        state.stampMarqueeStart = null;
        render();
        return;
      }

      // Cmd/Ctrl+release: remove all non-image drawings within the marquee area
      if (e.metaKey || e.ctrlKey) {
        const toRemove = [];
        for (let i = state.drawings.length - 1; i >= 0; i--) {
          const shape = state.drawings[i];
          if (shape.locked) continue;
          const b = getShapeBounds(shape);
          // Check if drawing's bounding box intersects the marquee rect
          if (b.x < rect.x + rect.w && b.x + b.w > rect.x &&
              b.y < rect.y + rect.h && b.y + b.h > rect.y) {
            toRemove.push(i);
          }
        }
        if (toRemove.length === 0) {
          showToast("No drawings in selection area");
          state.stampMarqueeRect = null;
          state.stampMarqueeStart = null;
          render();
          return;
        }
        pushUndo();
        const removedIds = [];
        // Remove in reverse order to preserve indices
        for (const idx of toRemove) {
          const el = state.drawings[idx];
          removedIds.push(el.id);
          spatialRemove(el);
          state.drawings.splice(idx, 1);
        }
        // Clean up connector references pointing to removed elements
        for (const shape of state.drawings) {
          if (shape.type !== "connector") continue;
          if (shape.startConn && removedIds.includes(shape.startConn.elementId)) {
            shape.startConn = null;
          }
          if (shape.endConn && removedIds.includes(shape.endConn.elementId)) {
            shape.endConn = null;
          }
        }
        state.stampMarqueeRect = null;
        state.stampMarqueeStart = null;
        render();
        scheduleSave();
        showToast(`Removed ${toRemove.length} drawing(s) from area`);
        return;
      }

      // Normal release: stamp onto all images intersecting the rectangle
      const hitImages = state.images.filter(img => {
        return img.x < rect.x + rect.w && img.x + img.w > rect.x &&
               img.y < rect.y + rect.h && img.y + img.h > rect.y;
      });
      if (hitImages.length === 0) {
        showToast("No images in selection area");
        state.stampMarqueeRect = null;
        state.stampMarqueeStart = null;
        render();
        return;
      }
      if (!state.stampClipboard || state.stampClipboard.length === 0) {
        showToast("No stamp clipboard — use Shift+Click first");
        state.stampMarqueeRect = null;
        state.stampMarqueeStart = null;
        render();
        return;
      }
      pushUndo();
      const srcW = state.stampSourceBounds.w;
      const srcH = state.stampSourceBounds.h;
      let totalStamped = 0;
      hitImages.forEach(targetImg => {
        const scaleX = targetImg.w / srcW;
        const scaleY = targetImg.h / srcH;
        const groupIdMap = new Map();
        state.stampClipboard.forEach(srcEl => {
          const clone = JSON.parse(JSON.stringify(srcEl));
          clone.id = "draw_" + state.elementIdCounter++;
          if (clone.groupId) {
            if (!groupIdMap.has(clone.groupId)) {
              groupIdMap.set(clone.groupId, "group_" + state.groupIdCounter++);
            }
            clone.groupId = groupIdMap.get(clone.groupId);
          }
          if (clone.type === "pen" && clone.points) {
            clone.points = clone.points.map(p => ({
              x: p.x * scaleX + targetImg.x,
              y: p.y * scaleY + targetImg.y,
            }));
          } else if (clone.start) {
            clone.start = { x: clone.start.x * scaleX + targetImg.x, y: clone.start.y * scaleY + targetImg.y };
            if (clone.end) clone.end = { x: clone.end.x * scaleX + targetImg.x, y: clone.end.y * scaleY + targetImg.y };
          }
          state.drawings.push(clone);
          spatialInsert(clone);
          totalStamped++;
        });
      });
      state.stampMarqueeRect = null;
      state.stampMarqueeStart = null;
      render();
      scheduleSave();
      showToast(`Stamped onto ${hitImages.length} image(s) (${totalStamped} elements)`);
      return;
    }

    if (state.currentTool === "marquee" && (state.marqueeIsSelecting || state.marqueeIsDragging)) {
      marqueeEndSelection();
      render();
      return;
    }

    if (state.currentTool === "accessibility-preview" && isAccessibilityPreviewInteracting()) {
      accessibilityPreviewEnd();
      return;
    }

    if (state.currentTool === "measure" && state.activeMeasureLine) {
      const dx2 = state.activeMeasureLine.end.x - state.activeMeasureLine.start.x;
      const dy2 = state.activeMeasureLine.end.y - state.activeMeasureLine.start.y;
      if (Math.sqrt(dx2 * dx2 + dy2 * dy2) > 5 / state.transform.zoom) {
        pushUndo();
        if (e.metaKey || e.ctrlKey) {
          // Insert both horizontal and vertical measurement lines
          const start = state.activeMeasureLine.start;
          const end = state.activeMeasureLine.end;
          const hMeasure = {
            id: "draw_" + state.elementIdCounter++,
            elementType: "drawing", type: "measure",
            color: "#00bcd4", width: CONSTANTS.CONSTANT_LINE_WIDTH,
            start: { x: start.x, y: start.y }, end: { x: end.x, y: start.y },
          };
          const vMeasure = {
            id: "draw_" + state.elementIdCounter++,
            elementType: "drawing", type: "measure",
            color: "#00bcd4", width: CONSTANTS.CONSTANT_LINE_WIDTH,
            start: { x: end.x, y: start.y }, end: { x: end.x, y: end.y },
          };
          // Only insert if the line has meaningful length
          if (Math.abs(dx2) > 5 / state.transform.zoom) {
            state.drawings.push(hMeasure);
            spatialInsert(hMeasure);
          }
          if (Math.abs(dy2) > 5 / state.transform.zoom) {
            state.drawings.push(vMeasure);
            spatialInsert(vMeasure);
          }
        } else {
          const measureEl = {
            id: "draw_" + state.elementIdCounter++,
            elementType: "drawing", type: "measure",
            color: "#00bcd4", width: CONSTANTS.CONSTANT_LINE_WIDTH,
            start: { ...state.activeMeasureLine.start }, end: { ...state.activeMeasureLine.end },
          };
          state.drawings.push(measureEl);
          spatialInsert(measureEl);
        }
      }
      state.activeMeasureLine = null;
      render(); scheduleSave();
      state.isMiddleClick = false; state.isRightClickHand = false; updateCursor();
      return;
    }

    if (state.currentTool === "contrast" && state.activeContrastLine) {
      const dx2 = state.activeContrastLine.end.x - state.activeContrastLine.start.x;
      const dy2 = state.activeContrastLine.end.y - state.activeContrastLine.start.y;
      if (Math.sqrt(dx2 * dx2 + dy2 * dy2) > 5 / state.transform.zoom) {
        // Drag completed — store line data before clearing preview
        const c1 = state.activeContrastLine.startColor;
        const lineStart = { ...state.activeContrastLine.start };
        const lineEnd = { ...state.activeContrastLine.end };

        // Clear preview and re-render cleanly so we can sample the end color
        // without picking up the preview line's purple color
        state.activeContrastLine = null;
        renderSync();

        // Sample end color at current mouse position (now unobstructed)
        const canvasRect = canvas.getBoundingClientRect();
        const px2 = ctx.getImageData(
          e.clientX - canvasRect.left,
          e.clientY - canvasRect.top, 1, 1
        ).data;
        const c2 = { r: px2[0], g: px2[1], b: px2[2] };

        const ratio = contrastRatio(c1, c2);
        pushUndo();
        const contrastEl = {
          id: "draw_" + state.elementIdCounter++,
          elementType: "drawing",
          type: "contrast-line",
          color: "#e040fb",
          width: CONSTANTS.CONSTANT_LINE_WIDTH,
          start: lineStart,
          end: lineEnd,
          color1: c1,
          color2: c2,
          hex1: rgbToHex(c1.r, c1.g, c1.b),
          hex2: rgbToHex(c2.r, c2.g, c2.b),
          ratio: ratio,
        };
        state.drawings.push(contrastEl);
        spatialInsert(contrastEl);

        // Also show the panel result
        state.contrastColor1 = c1;
        state.contrastColor2 = c2;
        state.contrastClickCount = 0;
        showContrastResult();
      } else {
        // Drag too short — treat as click for click-click mode
        const color = state.activeContrastLine.startColor;
        const worldPos = state.activeContrastLine.start;

        if (state.contrastClickCount === 0) {
          state.contrastColor1 = color;
          state.contrastColor2 = null;
          state.contrastWorldPos1 = { ...worldPos };
          state.contrastClickCount = 1;
          showContrastWaiting(2);
        } else {
          state.contrastColor2 = color;
          state.contrastClickCount = 0;

          if (e.shiftKey) {
            // Shift-click: store a persistent contrast line on the canvas
            const ratio = contrastRatio(state.contrastColor1, color);
            pushUndo();
            const contrastEl = {
              id: "draw_" + state.elementIdCounter++,
              elementType: "drawing",
              type: "contrast-line",
              color: "#e040fb",
              width: CONSTANTS.CONSTANT_LINE_WIDTH,
              start: { ...state.contrastWorldPos1 },
              end: { ...worldPos },
              color1: { ...state.contrastColor1 },
              color2: { ...color },
              hex1: rgbToHex(state.contrastColor1.r, state.contrastColor1.g, state.contrastColor1.b),
              hex2: rgbToHex(color.r, color.g, color.b),
              ratio: ratio,
            };
            state.drawings.push(contrastEl);
            spatialInsert(contrastEl);
          }

          showContrastResult();
        }
      }
      state.activeContrastLine = null;
      render(); scheduleSave();
      state.isMiddleClick = false; state.isRightClickHand = false; updateCursor();
      return;
    }

    if (state.currentTool === "select" && state.isRegionSelecting) {
      state.isRegionSelecting = false;
      const rx = Math.min(state.regionStart.x, state.regionEnd.x);
      const ry = Math.min(state.regionStart.y, state.regionEnd.y);
      const rw = Math.abs(state.regionEnd.x - state.regionStart.x);
      const rh = Math.abs(state.regionEnd.y - state.regionStart.y);
      const isModifierActive = e.metaKey || e.ctrlKey;
      if (!isModifierActive) state.selectedElements = [];
      state.images.forEach((img) => {
        if (img.x >= rx && img.x + img.w <= rx + rw && img.y >= ry && img.y + img.h <= ry + rh) {
          if (!state.selectedElements.some((el) => el.id === img.id)) state.selectedElements.push(img);
        }
      });
      state.drawings.forEach((shape) => {
        const b = getShapeBounds(shape);
        if (b.x >= rx && b.x + b.w <= rx + rw && b.y >= ry && b.y + b.h <= ry + rh) {
          if (shape.type !== "text") shape.elementType = "drawing";
          if (!state.selectedElements.some((el) => el.id === shape.id)) state.selectedElements.push(shape);
        }
      });
      expandSelectionToGroups();
      if (state.selectedElements.length > 0) showToast(`Selected group of ${state.selectedElements.length} assets`);
    }

    if (state.activeConnector) {
      const snapThreshold = 30 / state.transform.zoom;
      const worldPos = screenToWorld(e.clientX, e.clientY);
      const hitEl = getElementAtWorldPos(worldPos, null);
      if (hitEl && hitEl.type !== "connector" && (!state.activeConnector.startConn || hitEl.id !== state.activeConnector.startConn.elementId)) {
        const port = getClosestConnectionPort(worldPos, hitEl);
        const dist = Math.sqrt((port.x - worldPos.x) ** 2 + (port.y - worldPos.y) ** 2);
        if (dist < snapThreshold) { state.activeConnector.end = { x: port.x, y: port.y }; state.activeConnector.endConn = { elementId: hitEl.id, ratioX: port.ratioX, ratioY: port.ratioY }; }
        else { const ratio = computeAnchorRatio(worldPos, hitEl); state.activeConnector.end = { ...worldPos }; state.activeConnector.endConn = { elementId: hitEl.id, ratioX: ratio.ratioX, ratioY: ratio.ratioY }; }
      }
      const cdx = state.activeConnector.end.x - state.activeConnector.start.x;
      const cdy = state.activeConnector.end.y - state.activeConnector.start.y;
      if (Math.sqrt(cdx * cdx + cdy * cdy) > 5 / state.transform.zoom) {
        pushUndo();
        state.drawings.push(state.activeConnector);
        spatialInsert(state.activeConnector);
        scheduleSave();
      }
      state.activeConnector = null;
      state.connectorHoverTarget = null;
      render();
    }

    if (state.laserActiveStroke) {
      finishLaserStroke();
      render();
    }

    if (state.activeShape) {
      const screenDx = e.clientX - state.startX;
      const screenDy = e.clientY - state.startY;
      const screenDist = Math.sqrt(screenDx * screenDx + screenDy * screenDy);
      if (screenDist >= CONSTANTS.MIN_DRAW_DISTANCE) {
        pushUndo();
        state.drawings.push(state.activeShape);
        spatialInsert(state.activeShape);
      } else if (state.activeShape.type === "pen" && state.activeShape.points.length === 1) {
        // Single click with pen tool — commit as a dot
        pushUndo();
        state.drawings.push(state.activeShape);
        spatialInsert(state.activeShape);
      }
      state.activeShape = null;
    }

    // Update spatial index for any elements that were dragged/moved during this interaction
    if (state.selectedElements.length > 0) {
      // If the drag threshold was never met, the elements weren't actually moved — remove the premature undo entry
      if (!state.hasDragThresholdBeenMet && state.dragOffsets.length > 0) {
        state.undoStack.pop();
      }
      for (const el of state.selectedElements) spatialUpdate(el);
    }
    _dragOffsetMap = null;
    _dragExcludeIds = null;
    _dragExcludeIdSet = null;

    toggleAlignmentPanelVisibility();
    render();
    state.isMiddleClick = false;
    state.isRightClickHand = false;
    updateCursor();
    scheduleSave();
  });

  // Double-click for text editing
  container.addEventListener("dblclick", (e) => {
    // Bézier pen tool: double-click finishes path
    if (state.currentTool === "bezier-pen") {
      const worldPos = screenToWorld(e.clientX, e.clientY);
      bezierPenDoubleClick(e, worldPos);
      return;
    }

    if (state.currentTool !== "select") return;
    const worldPos = screenToWorld(e.clientX, e.clientY);

    // Double-click on a locked element to unlock it (only if it's the topmost element at this point)
    // Use z-order to find the topmost element — only unlock if that element is locked
    const topmostEl = getElementAtWorldPos(worldPos, null);
    if (topmostEl && topmostEl.locked) {
      pushUndo();
      topmostEl.locked = false;
      if (topmostEl.elementType === "image") {
        state.selectedElements = [topmostEl];
      } else {
        state.selectedElements = [topmostEl];
        if (topmostEl.type !== "text") topmostEl.elementType = "drawing";
      }
      toggleAlignmentPanelVisibility();
      render();
      showToast("Unlocked element");
      scheduleSave();
      return;
    }

    // Use unified z-order hit testing for double-click actions (reuse topmostEl from above)
    if (topmostEl && !topmostEl.locked) {
      const hitEl = topmostEl;
      // Bezier-path: enter edit mode
      if (hitEl.type === "bezier-path") {
        enterBezierEdit(hitEl);
        state.currentTool = "bezier-pen";
        updateToolbarUI();
        updateCursor();
        return;
      }

      // Image: enter crop mode
      if (hitEl.elementType === "image") {
        enterCropMode(hitEl);
        return;
      }

      // Text: enter text editing mode
      if (hitEl.type === "text") {
        const editingText = hitEl;
        state.activeTextCoord = { x: editingText.start.x, y: editingText.start.y };
        state.currentFontSize = editingText.fontSize;
        setTextEditorContent(editingText.text, editingText.segments);
        textEditor.style.display = "block";
        textEditor.style.color = editingText.color;
        const screenPos = worldToScreen(state.activeTextCoord.x, state.activeTextCoord.y);
        const screenFontSize = state.currentFontSize * state.transform.zoom;
        if (editingText.bgColor) {
          textEditor.dataset.bgColor = editingText.bgColor;
          textEditor.style.background = editingText.bgColor;
          textEditor.style.border = "none";
          textEditor.style.outline = "1px dashed #c4b800";
          const notePadding = state.currentFontSize * 0.4 * state.transform.zoom;
          textEditor.style.padding = `${notePadding}px`;
          textEditor.style.whiteSpace = "pre";
          textEditor.style.wordBreak = "normal";
          textEditor.style.left = `${screenPos.x - notePadding}px`;
          textEditor.style.top = `${screenPos.y - notePadding}px`;
        } else {
          textEditor.dataset.bgColor = "";
          textEditor.style.background = "transparent";
          textEditor.style.border = "1px dashed #007acc";
          textEditor.style.outline = "none";
          textEditor.style.padding = "2px";
          textEditor.style.whiteSpace = "pre-wrap";
          textEditor.style.wordBreak = "break-word";
          textEditor.style.left = `${screenPos.x}px`;
          textEditor.style.top = `${screenPos.y - screenFontSize * 0.2}px`;
        }
        textEditor.style.fontSize = `${screenFontSize}px`;
        textEditor.style.fontFamily = editingText.fontFamily || state.currentFontFamily;
        textEditor.style.lineHeight = "1.2";

        // Remove the original text element so it can be re-baked
        const idx = state.drawings.indexOf(editingText);
        pushUndo();
        spatialRemove(editingText);
        if (idx !== -1) state.drawings.splice(idx, 1);
        state.selectedElements = [];

        autoResizeTextEditor();
        setTimeout(() => {
          textEditor.focus();
          // Select all text for easy replacement
          const range = document.createRange();
          range.selectNodeContents(textEditor);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          if (window._textFormatBar) { window._textFormatBar.show(); }
        }, 20);
        render();
        return;
      }
    }
  });
}
