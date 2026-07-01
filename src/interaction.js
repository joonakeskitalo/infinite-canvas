/**
 * Interaction — Mouse/Keyboard Event Handlers
 *
 * Sets up all event listeners for the canvas application.
 */

import { state, CONSTANTS, getDom, spatialInsert, spatialRemove, spatialUpdate, spatialIndex, rebuildSpatialIndex } from "./state.js";
import { screenToWorld, worldToScreen, showToast, constraintToAngle } from "./utils.js";
import {
  getShapeBounds, isPointHittingShape, getElementResizeHandles,
  getElementAtWorldPos, isPointOnSwapHandle, translateElement,
  isPointOnMeasureLabel,
} from "./elements.js";
import { pushUndo, undo, redo } from "./history.js";
import { scheduleSave, saveFile, saveAs, openFile } from "./persistence.js";
import { render, executePNGExport, executeJPEGExport } from "./rendering.js";
import {
  getSnapTargets, snapToElements, snapToSpacing, snapResizeEdges,
  getProximityGuides, getSpacingGuides, computeMeasureHoverGuides,
} from "./snap-guides.js";
import {
  getConnectorAnchorPoint, computeAnchorRatio,
  getClosestConnectionPort, updateConnectorsForElements,
} from "./connectors.js";
import { enterCropMode, exitCropMode, getCropEdgeAtPoint, getCropCursor, getFullImageBounds } from "./crop.js";
import {
  expandSelectionToGroups, groupSelection, ungroupSelection, toggleLockSelection,
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
  updateSpacingInputs, updateGroupButtons,
} from "./toolbar.js";
import { setRulersVisible, resizeRulers } from "./rulers.js";
import { FILTER_OPTIONS, FILTER_LABELS } from "./color-filter.js";
import { applyFilterToImageData } from "./filter-kernels.js";

export function initEventHandlers() {
  const dom = getDom();
  const { container, canvas, ctx, textEditor, fontSizeSelect, zoomSlider,
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
      // Toggle split-line orientation when clicking the tool icon while already active
      if (targetBtn.dataset.tool === "split-line" && state.currentTool === "split-line") {
        state.splitLineOrientation = state.splitLineOrientation === "vertical" ? "horizontal" : "vertical";
        render();
        return;
      }
      state.currentTool = targetBtn.dataset.tool;
      if (state.currentTool !== "select") state.selectedElements = [];
      if (state.currentTool !== "select") { state.swapHoveredElement = null; state.isSwapDragging = false; state.swapSourceElement = null; state.swapDragWorldPos = null; state.swapTargetElement = null; }
      if (state.currentTool !== "measure") { state.measureHoverGuides = []; state.activeMeasureLine = null; }
      if (state.currentTool !== "split-line") { state.splitLineHoveredImage = null; state.splitLineWorldPos = null; }
      if (state.currentTool === "text") { colorPicker.value = state.textDrawColor; }
      else { colorPicker.value = state.drawColor; }
      updateToolbarUI();
      updateCursor();
      render();
      // Update swatch color when switching tools
      const swatchInner = document.getElementById("color-swatch-inner");
      if (swatchInner) {
        swatchInner.style.background = state.currentTool === "text" ? state.textDrawColor : state.drawColor;
      }
    });
  });

  // --- Color picker ---
  colorPicker.addEventListener("input", (e) => {
    if (state.currentTool === "text") { state.textDrawColor = e.target.value; }
    else { state.drawColor = e.target.value; }
    applyColorToSelectedElements(e.target.value);
    updateColorSwatch();
  });

  // --- Color swatch popup ---
  const colorSwatchBtn = document.getElementById("color-swatch-btn");
  const colorPopup = document.getElementById("color-popup");

  colorSwatchBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = colorPopup.classList.toggle("open");
    if (isOpen) {
      const rect = colorSwatchBtn.getBoundingClientRect();
      colorPopup.style.top = (rect.bottom + 6) + "px";
      colorPopup.style.left = (rect.left + rect.width / 2 - colorPopup.offsetWidth / 2) + "px";
    }
  });

  document.addEventListener("click", (e) => {
    if (!colorPopup.contains(e.target) && !colorSwatchBtn.contains(e.target)) {
      colorPopup.classList.remove("open");
    }
  });

  function updateColorSwatch() {
    const swatch = document.getElementById("color-swatch-inner");
    const color = state.currentTool === "text" ? state.textDrawColor : state.drawColor;
    swatch.style.background = color;
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

  bgColorPicker.addEventListener("input", (e) => {
    state.bgColor = e.target.value;
    document.body.style.backgroundColor = state.bgColor;
    render();
    scheduleSave();
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

  // --- Filter select ---
  filterSelect.addEventListener("change", (e) => {
    state.currentFilter = e.target.value;
    state.filteredImageCache = new WeakMap();
    filterSelect.classList.toggle("filter-active", state.currentFilter !== "none");
    render();
    if (state.currentFilter !== "none") {
      showToast(`Filter: ${e.target.options[e.target.selectedIndex].text}`);
    }
  });

  // --- Font size ---
  fontSizeSelect.addEventListener("change", (e) => {
    state.currentFontSize = parseInt(e.target.value);
    if (textEditor.style.display === "block") {
      textEditor.style.fontSize = `${state.currentFontSize * state.transform.zoom}px`;
    }
    applyFontSizeToSelectedText(state.currentFontSize);
  });

  function applyFontSizeToSelectedText(size) {
    if (state.selectedElements.length === 0) return;
    let changed = false;
    state.selectedElements.forEach((el) => {
      if (el.elementType === "text") {
        if (el.textWidth) {
          const scale = size / el.fontSize;
          el.textWidth = el.textWidth * scale;
        }
        el.fontSize = size;
        el.w = null;
        el.h = null;
        changed = true;
      }
    });
    if (changed) render();
  }

  function setFontSizeAndSync(size) {
    size = Math.max(4, size);
    state.currentFontSize = size;
    let option = fontSizeSelect.querySelector(`option[value="${size}"]`);
    if (!option) {
      option = document.createElement("option");
      option.value = size; option.textContent = size + "px";
      const options = Array.from(fontSizeSelect.options);
      let inserted = false;
      for (let i = 0; i < options.length; i++) {
        if (parseInt(options[i].value) > size) { fontSizeSelect.insertBefore(option, options[i]); inserted = true; break; }
      }
      if (!inserted) fontSizeSelect.appendChild(option);
    }
    fontSizeSelect.value = size;
    if (textEditor.style.display === "block") { textEditor.style.fontSize = `${state.currentFontSize * state.transform.zoom}px`; }
    applyFontSizeToSelectedText(size);
  }

  document.getElementById("font-size-minus").addEventListener("click", (e) => { e.stopPropagation(); setFontSizeAndSync(state.currentFontSize - 16); });
  document.getElementById("font-size-plus").addEventListener("click", (e) => { e.stopPropagation(); setFontSizeAndSync(state.currentFontSize + 16); });

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
  document.querySelectorAll(".scale-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const scale = parseFloat(e.target.dataset.scale);
      if (!scale || state.selectedElements.length === 0) return;
      pushUndo();
      state.selectedElements.forEach((el) => {
        if (el.elementType === "image") {
          const fullNatW = el.img.naturalWidth || el.w;
          const fullNatH = el.img.naturalHeight || el.h;
          // Use cropped region's natural dimensions if the image is cropped
          const naturalW = el.crop ? fullNatW * el.crop.w : fullNatW;
          const naturalH = el.crop ? fullNatH * el.crop.h : fullNatH;
          const newW = naturalW * scale, newH = naturalH * scale;
          const centerX = el.x + el.w / 2, centerY = el.y + el.h / 2;
          el.w = newW; el.h = newH; el.x = centerX - newW / 2; el.y = centerY - newH / 2;
          // Update fullBounds so crop mode can reconstruct the full image position
          if (el.crop && el.fullBounds) {
            const fullW = el.w / el.crop.w;
            const fullH = el.h / el.crop.h;
            el.fullBounds = { x: el.x - el.crop.x * fullW, y: el.y - el.crop.y * fullH, w: fullW, h: fullH };
          }
        }
      });
      state.selectedElements.forEach((el) => spatialUpdate(el));
      render();
      showToast(`Scaled to ${scale * 100}%`);
    });
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
  document.getElementById("open-file-btn").addEventListener("click", openFile);
  document.getElementById("save-file-btn").addEventListener("click", saveFile);

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

        console.log(`🟣106 🟣 interaction:415 AA`, {  });
        
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
  exportBtn.addEventListener("click", (e) => executePNGExport(e.shiftKey ? 0.5 : 1.0));
  document.getElementById("download-png-btn").addEventListener("click", (e) => executePNGExport(e.shiftKey ? 0.5 : 1.0, { download: true }));
  document.getElementById("download-jpeg-btn").addEventListener("click", (e) => executeJPEGExport(e.shiftKey ? 0.5 : 1.0, { download: true }));
  downloadImagesBtn.addEventListener("click", () => {
    if (state.images.length === 0) { showToast("No pasted images found to download!"); return; }
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
      const a = document.createElement("a");
      a.href = tempCanvas.toDataURL("image/png");
      const now = new Date(); const dtPrefix = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
      a.download = `${dtPrefix}_pasted_asset_${index + 1}.png`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    });
    showToast(`Downloading ${state.images.length} asset files${state.currentFilter !== "none" ? ` (${state.currentFilter})` : ""}...`);
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
  container.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const zoomFactor = 1 - e.deltaY * 0.01;
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

  // --- Text formatting bar ---
  const formatBar = document.getElementById("text-format-bar");
  const fmtBoldBtn = document.getElementById("fmt-bold");
  const fmtItalicBtn = document.getElementById("fmt-italic");
  const fmtUnderlineBtn = document.getElementById("fmt-underline");
  const fmtStrikethroughBtn = document.getElementById("fmt-strikethrough");
  const fmtFontSizeInput = document.getElementById("fmt-font-size");
  const fmtSizeDownBtn = document.getElementById("fmt-size-down");
  const fmtSizeUpBtn = document.getElementById("fmt-size-up");

  fmtBoldBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.execCommand("bold");
    updateFormatBarState();
  });
  fmtItalicBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.execCommand("italic");
    updateFormatBarState();
  });
  fmtUnderlineBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.execCommand("underline");
    updateFormatBarState();
  });
  fmtStrikethroughBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.execCommand("strikeThrough");
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

  fmtSizeDownBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const currentSize = parseInt(fmtFontSizeInput.value) || state.currentFontSize;
    const newSize = Math.max(8, currentSize - 4);
    applyFontSizeToSelection(newSize);
  });

  fmtSizeUpBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const currentSize = parseInt(fmtFontSizeInput.value) || state.currentFontSize;
    const newSize = Math.min(999, currentSize + 4);
    applyFontSizeToSelection(newSize);
  });

  fmtFontSizeInput.addEventListener("change", (e) => {
    const size = Math.max(8, Math.min(999, parseInt(e.target.value) || state.currentFontSize));
    e.target.value = size;
    applyFontSizeToSelection(size);
    textEditor.focus();
  });

  fmtFontSizeInput.addEventListener("mousedown", (e) => {
    e.stopPropagation();
  });

  // Update format bar button active states based on current selection
  function updateFormatBarState() {
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
  }

  textEditor.addEventListener("keyup", () => updateFormatBarState());
  textEditor.addEventListener("mouseup", () => setTimeout(updateFormatBarState, 10));

  // Show/position format bar when text editor is visible
  function showFormatBar() {
    formatBar.style.display = "flex";
    fmtFontSizeInput.value = state.currentFontSize;
    positionFormatBar();
  }

  function hideFormatBar() {
    formatBar.style.display = "none";
  }

  function positionFormatBar() {
    if (textEditor.style.display !== "block") return;
    const editorRect = textEditor.getBoundingClientRect();
    formatBar.style.left = `${editorRect.left}px`;
    formatBar.style.top = `${editorRect.top - 34}px`;
  }

  // Expose showFormatBar/hideFormatBar for use in text tool activation
  window._textFormatBar = { show: showFormatBar, hide: hideFormatBar, position: positionFormatBar };

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
  const screenFontSize = parseFloat(textEditor.style.fontSize) || 48;

  // Find the largest inline font size in the editor for proper sizing
  let maxInlineFontSize = screenFontSize;
  textEditor.querySelectorAll("[style*='font-size']").forEach((el) => {
    const fs = parseFloat(el.style.fontSize);
    if (fs > maxInlineFontSize) maxInlineFontSize = fs;
  });

  ctx.save();
  ctx.font = `bold ${maxInlineFontSize}px ${state.currentFontFamily || "sans-serif"}`;
  const text = getTextEditorContent();
  const lines = text.split("\n");
  let maxWidth = 0;
  lines.forEach((line) => {
    const w = ctx.measureText(line || " ").width;
    if (w > maxWidth) maxWidth = w;
  });
  ctx.restore();
  // Width: fit content + cursor padding
  const minWidth = maxInlineFontSize * 1.5;
  textEditor.style.width = Math.max(minWidth, maxWidth + maxInlineFontSize * 0.5) + "px";
  // Height: auto-fit based on line count using the largest font size for line height
  const lineHeight = maxInlineFontSize * 1.2;
  const minHeight = lineHeight;
  textEditor.style.height = Math.max(minHeight, lines.length * lineHeight + 4) + "px";
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
      erasedIds.push(state.drawings[i].id);
      spatialRemove(state.drawings[i]);
      state.drawings.splice(i, 1);
      erasedSomething = true;
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
    // Same-tab paste: if we already have clipboard elements in memory, use them directly
    if (state.internalCopyPerformed && state.clipboardElements.length > 0) {
      e.preventDefault();
      pasteFromClipboard();
      return;
    }
    // Cross-tab paste: deserialize from clipboard text
    try {
      const jsonStr = text.slice(CONSTANTS.INTERNAL_COPY_MIME.length + 1);
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
    if (e.key === "Meta" || e.key === "Control") {
      state.isMetaPressed = true;
      if (state.currentTool === "split-line") render();
      if (state.currentTool === "measure" && state.activeMeasureLine) render();
    }
    if (e.key === "Shift") {
      state.isShiftPressed = true;
      if (state.currentTool === "split-line") render();
    }
    if (e.key === " " || e.code === "Space") {
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
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
    if (e.key === "Meta" || e.key === "Control") {
      state.isMetaPressed = false;
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

    // Escape
    if (e.key === "Escape") {
      e.preventDefault();
      if (state.selectedElements.length > 0) {
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
    const isPlusMinusCode = e.code === "Equal" || e.code === "Minus" || e.code === "Slash" ||
      e.code === "NumpadAdd" || e.code === "NumpadSubtract" || e.code === "BracketRight";
    const isPlusMinusKey = e.key === "+" || e.key === "-" || e.key === "=" || e.key === "_";
    if (e.shiftKey && (isPlusMinusKey || isPlusMinusCode)) {
      // Determine direction: check unshifted key identity via code
      // NumpadAdd / Equal (US +) / BracketRight → increase
      // NumpadSubtract / Minus (but on Nordic this is +!) / Slash (Nordic -) → context-dependent
      // Safest: if the key WITHOUT shift would produce + or =, increase; if - or _, decrease
      // Since shift is held and may change e.key, we rely on code:
      // Codes that are "plus" keys: Equal (US), Minus (Nordic +), BracketRight (alt Nordic +), NumpadAdd
      // Codes that are "minus" keys: Minus (US), Slash (Nordic -), NumpadSubtract
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
        isIncrease = e.code === "Equal" || e.code === "NumpadAdd" || e.code === "Minus" || e.code === "BracketRight";
      }
      e.preventDefault();
      const fontSizeSelect = dom.fontSizeSelect || document.getElementById("font-size-select");
      const step = 16;
      const newSize = Math.max(4, state.currentFontSize + (isIncrease ? step : -step));
      state.currentFontSize = newSize;
      let option = fontSizeSelect.querySelector(`option[value="${newSize}"]`);
      if (!option) {
        option = document.createElement("option");
        option.value = newSize; option.textContent = newSize + "px";
        const options = Array.from(fontSizeSelect.options);
        let inserted = false;
        for (let i = 0; i < options.length; i++) {
          if (parseInt(options[i].value) > newSize) { fontSizeSelect.insertBefore(option, options[i]); inserted = true; break; }
        }
        if (!inserted) fontSizeSelect.appendChild(option);
      }
      fontSizeSelect.value = newSize;
      if (textEditor.style.display === "block") { textEditor.style.fontSize = `${newSize * state.transform.zoom}px`; }
      // Apply to selected text elements
      if (state.selectedElements.length > 0) {
        state.selectedElements.forEach((el) => {
          if (el.elementType === "text") {
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

    let targetTool = null;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (key === "r" && e.shiftKey) { setRulersVisible(!state.rulersVisible); return; }
    if (key === "h") targetTool = "pan";
    if (key === "v") targetTool = "select";
    if (key === "b") targetTool = "pen";
    if (key === "l") targetTool = "line";
    if (key === "a") targetTool = "arrow";
    if (key === "c") targetTool = "connector";
    if (key === "r") targetTool = "rect-border";
    if (key === "f") targetTool = "rect-fill";
    if (key === "t") targetTool = "text";
    if (key === "n") targetTool = "text-element";
    if (key === "e") targetTool = "eraser";
    if (key === "m") targetTool = "measure";
    if (key === "s") {
      if (state.currentTool === "split-line") {
        state.splitLineOrientation = state.splitLineOrientation === "vertical" ? "horizontal" : "vertical";
        render();
        return;
      }
      targetTool = "split-line";
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
    if (key === "p") {
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
    if (key === "d") {
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
      if (state.selectedElements.length > 0) {
        state.selectedElements.forEach((el) => {
          if (el.elementType === "text" || el.elementType === "drawing") { el.color = newColor; }
        });
      }
      render();
      showToast(`Color: ${newColor}`);
      return;
    }

    // I key — EyeDropper
    if (key === "i" && !e.shiftKey) {
      if (window.EyeDropper) {
        const toolBeforeDropper = state.preSpaceTool || state.currentTool;
        const dropper = new EyeDropper();
        dropper.open().then((result) => {
          const hex = result.sRGBHex;
          if (toolBeforeDropper === "text") { state.textDrawColor = hex; }
          else { state.drawColor = hex; }
          colorPicker.value = hex;
          applyColorToSelectedElements(hex);
          const hexAllCaps = hex.toUpperCase();
          navigator.clipboard.writeText(hexAllCaps).then(() => showToast(`Copied ${hexAllCaps} to clipboard`)).catch(() => showToast(`Picked ${hexAllCaps}`));
        }).catch(() => {}).finally(() => {
          state.isShiftPressed = false; state.isSpacePressed = false; state.panLockDirection = null; state.preSpaceTool = null;
          state.currentTool = toolBeforeDropper;
          updateToolbarUI(); updateCursor(); render();
        });
      } else {
        showToast("EyeDropper not supported in this browser");
      }
      return;
    }

    // Shift+1/2/3 set drawing line thickness
    if (e.shiftKey && (e.code === "Digit1" || e.code === "Digit2" || e.code === "Digit3")) {
      e.preventDefault();
      const widthMap = { "Digit1": 2, "Digit2": 4, "Digit3": 10 };
      const newWidth = widthMap[e.code];
      state.currentLineWidth = newWidth;
      const lineWidthBtns = document.querySelectorAll(".line-width-btn");
      lineWidthBtns.forEach((b) => {
        if (parseInt(b.dataset.width, 10) === newWidth) b.classList.add("active");
        else b.classList.remove("active");
      });
      // Apply to selected drawing elements if any
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
      showToast(`Line width: ${newWidth}px`);
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
    if (e.key.toLowerCase() === "c") {
      if (state.selectedElements.length > 0) { e.preventDefault(); copySelectionToClipboard(); }
      return;
    }
    if (e.key.toLowerCase() === "x") {
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
      if (state.selectedElements.length > 0) { e.preventDefault(); duplicateSelection(); }
      return;
    }
    if (e.key.toLowerCase() === "v") { return; } // Let native paste fire
    if (e.key.toLowerCase() === "a") { e.preventDefault(); selectAllElements(); return; }
    if (e.key.toLowerCase() === "e" && !e.shiftKey && !e.altKey) { e.preventDefault(); executePNGExport(1.0); return; }
    if (e.altKey && e.code === "KeyE") { e.preventDefault(); executePNGExport(0.5); return; }
    if (e.key.toLowerCase() === "e" && e.shiftKey) { e.preventDefault(); executePNGExport(1.0, { download: true }); return; }
    if (e.key.toLowerCase() === "j" && e.shiftKey) { e.preventDefault(); executeJPEGExport(1.0, { download: true }); return; }
    if (e.key.toLowerCase() === "p" && !e.shiftKey) { e.preventDefault(); executePNGExport(1.0); return; }
    if (e.key.toLowerCase() === "p" && e.shiftKey) { e.preventDefault(); executePNGExport(0.5); return; }
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
  const { container, canvas, textEditor } = dom;

  // Global mousemove for swap detection and measure hover
  window.addEventListener("mousemove", (e) => {
    state.lastMousePos.x = e.clientX;
    state.lastMousePos.y = e.clientY;

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

    if (state.currentTool === "measure") {
      state.activeMeasureLine = { start: { ...worldPos }, end: { ...worldPos } };
      state.measureHoverGuides = [];
      return;
    }

    if (state.currentTool === "split-line") {
      if (state.splitLineHoveredImage && state.splitLineWorldPos) {
        const img = state.splitLineHoveredImage;
        const pos = state.splitLineWorldPos;

        pushUndo();

        if (state.isMetaPressed) {
          // Create both vertical and horizontal lines when meta is held
          const lx = Math.max(img.x, Math.min(pos.x, img.x + img.w));
          const ly = Math.max(img.y, Math.min(pos.y, img.y + img.h));
          const vLine = {
            id: "draw_" + state.elementIdCounter++,
            elementType: "drawing",
            type: "line",
            isSplitLine: true,
            color: state.drawColor,
            width: state.currentLineWidth / 4,
            opacity: 0.7,
            start: { x: lx, y: img.y },
            end: { x: lx, y: img.y + img.h },
          };
          const hLine = {
            id: "draw_" + state.elementIdCounter++,
            elementType: "drawing",
            type: "line",
            isSplitLine: true,
            color: state.drawColor,
            width: state.currentLineWidth / 4,
            opacity: 0.7,
            start: { x: img.x, y: ly },
            end: { x: img.x + img.w, y: ly },
          };
          state.drawings.push(vLine);
          spatialInsert(vLine);
          state.drawings.push(hLine);
          spatialInsert(hLine);
        } else {
          // Create a single line based on effective orientation
          const effectiveOrientation = e.shiftKey
            ? (state.splitLineOrientation === "vertical" ? "horizontal" : "vertical")
            : state.splitLineOrientation;
          let start, end;
          if (effectiveOrientation === "vertical") {
            const lx = Math.max(img.x, Math.min(pos.x, img.x + img.w));
            start = { x: lx, y: img.y };
            end = { x: lx, y: img.y + img.h };
          } else {
            const ly = Math.max(img.y, Math.min(pos.y, img.y + img.h));
            start = { x: img.x, y: ly };
            end = { x: img.x + img.w, y: ly };
          }
          const lineEl = {
            id: "draw_" + state.elementIdCounter++,
            elementType: "drawing",
            type: "line",
            isSplitLine: true,
            color: state.drawColor,
            width: state.currentLineWidth / 4,
            opacity: 0.7,
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
      setTimeout(() => { textEditor.focus(); autoResizeTextEditor(); if (window._textFormatBar) { window._textFormatBar.show(); } }, 20);
      return;
    }

    if (state.currentTool === "text-element") {
      state.isInteracting = false;
      state.activeTextCoord = worldPos;
      setTextEditorContent("");
      textEditor.style.display = "block";
      textEditor.style.color = "#333333";
      textEditor.dataset.bgColor = "#f5e642";
      const screenPos = worldToScreen(worldPos.x, worldPos.y);
      textEditor.style.left = `${screenPos.x}px`;
      textEditor.style.top = `${screenPos.y - state.currentFontSize * state.transform.zoom * 0.2}px`;
      textEditor.style.fontSize = `${state.currentFontSize * state.transform.zoom}px`;
      textEditor.style.fontFamily = state.currentFontFamily;
      textEditor.style.lineHeight = "1.2";
      textEditor.style.background = "#f5e642";
      textEditor.style.border = "1px dashed #c4b800";
      setTimeout(() => { textEditor.focus(); autoResizeTextEditor(); if (window._textFormatBar) { window._textFormatBar.show(); } }, 20);
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

      for (let i = state.drawings.length - 1; i >= 0; i--) {
        if (state.drawings[i].locked) continue;
        if (isPointHittingShape(worldPos, state.drawings[i]) || isPointOnMeasureLabel(worldPos, state.drawings[i])) {
          clickedElement = state.drawings[i];
          if (clickedElement.type !== "text") clickedElement.elementType = "drawing";
          break;
        }
      }

      if (!clickedElement) {
        for (let i = state.images.length - 1; i >= 0; i--) {
          const img = state.images[i];
          if (img.locked) continue;
          if (worldPos.x >= img.x && worldPos.x <= img.x + img.w && worldPos.y >= img.y && worldPos.y <= img.y + img.h) {
            clickedElement = img;
            clickedElement.elementType = "image";
            if (!isModifierActive) state.images.push(state.images.splice(i, 1)[0]);
            break;
          }
        }
      }

      if (clickedElement) {
        state.isRegionSelecting = false;
        if (isModifierActive) {
          const idx = state.selectedElements.findIndex((el) => el.id === clickedElement.id);
          if (idx !== -1) state.selectedElements.splice(idx, 1);
          else state.selectedElements.push(clickedElement);
        } else {
          const isAlreadyInSelection = state.selectedElements.some((el) => el.id === clickedElement.id);
          if (!isAlreadyInSelection) state.selectedElements = [clickedElement];
        }
        expandSelectionToGroups();
        pushUndo();
        state.dragOffsets = state.selectedElements.map((el) => {
          if (el.elementType === "image") {
            return { id: el.id, type: "image", x: el.x, y: el.y, startMouse: { ...worldPos } };
          } else if (el.type === "pen") {
            return { id: el.id, type: "points", points: el.points.map((p) => ({ ...p })), startMouse: { ...worldPos } };
          } else {
            return { id: el.id, type: "shape", start: { ...el.start }, end: el.end ? { ...el.end } : null, startMouse: { ...worldPos } };
          }
        });
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

    // Drawing tools
    if (state.currentTool === "pen") {
      state.activeShape = {
        id: "draw_" + state.elementIdCounter++,
        elementType: "drawing",
        type: "pen",
        color: state.drawColor,
        width: state.currentLineWidth,
        points: [worldPos],
      };
    } else {
      state.activeShape = {
        id: "draw_" + state.elementIdCounter++,
        elementType: "drawing",
        type: state.currentTool,
        color: state.drawColor,
        width: state.currentLineWidth,
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

    if (!state.isInteracting) return;
    state.isShiftPressed = e.shiftKey;

    let dx = e.clientX - state.startX;
    let dy = e.clientY - state.startY;
    let worldPos = screenToWorld(e.clientX, e.clientY);

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
        const excludeIds = state.selectedElements.map((el) => el.id);
        state.selectedElements.forEach((el) => {
          const offset = state.dragOffsets.find((o) => o.id === el.id);
          if (!offset) return;
          const curDx = worldPos.x - offset.startMouse.x;
          const curDy = worldPos.y - offset.startMouse.y;
          if (offset.type === "image") { el.x = offset.x + curDx; el.y = offset.y + curDy; }
          else if (offset.type === "points") { el.points = offset.points.map((p) => ({ x: p.x + curDx, y: p.y + curDy })); }
          else { el.start = { x: offset.start.x + curDx, y: offset.start.y + curDy }; if (el.end && offset.end) el.end = { x: offset.end.x + curDx, y: offset.end.y + curDy }; }
        });

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        state.selectedElements.forEach((el) => {
          let b = el.elementType === "image" ? { x: el.x, y: el.y, w: el.w, h: el.h } : getShapeBounds(el);
          if (b.x < minX) minX = b.x; if (b.y < minY) minY = b.y;
          if (b.x + b.w > maxX) maxX = b.x + b.w; if (b.y + b.h > maxY) maxY = b.y + b.h;
        });
        let groupBounds = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };

        if (e.shiftKey) {
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
            let b = el.elementType === "image" ? { x: el.x, y: el.y, w: el.w, h: el.h } : getShapeBounds(el);
            if (b.x < minX) minX = b.x; if (b.y < minY) minY = b.y;
            if (b.x + b.w > maxX) maxX = b.x + b.w; if (b.y + b.h > maxY) maxY = b.y + b.h;
          });
          groupBounds = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
          state.activeSnapGuides = snap.guides;
          state.activeProximityGuides = [];
          state.activeSpacingGuides = getSpacingGuides(groupBounds, excludeIds);
        } else {
          state.activeSnapGuides = [];
          state.activeProximityGuides = getProximityGuides(groupBounds, excludeIds);
          state.activeSpacingGuides = getSpacingGuides(groupBounds, excludeIds);
        }
        updateConnectorsForElements(state.selectedElements.map((el) => el.id));
        const draggedIds = new Set(state.selectedElements.map((el) => el.id));
        for (const el of state.selectedElements) {
          if (el.type === "connector") {
            if (el.startConn && !draggedIds.has(el.startConn.elementId)) el.startConn = null;
            if (el.endConn && !draggedIds.has(el.endConn.elementId)) el.endConn = null;
          }
        }
        render();
      }
    } else if (state.activeMeasureLine) {
      // Don't update measure line until user has dragged beyond minimum distance
      const screenDx = e.clientX - state.startX;
      const screenDy = e.clientY - state.startY;
      if (Math.sqrt(screenDx * screenDx + screenDy * screenDy) < CONSTANTS.MIN_DRAW_DISTANCE) return;

      if (e.shiftKey) worldPos = constraintToAngle(state.activeMeasureLine.start, worldPos);
      state.activeMeasureLine.end = { ...worldPos };
      render();
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

    if (state.activeShape) {
      const screenDx = e.clientX - state.startX;
      const screenDy = e.clientY - state.startY;
      const screenDist = Math.sqrt(screenDx * screenDx + screenDy * screenDy);
      if (screenDist >= CONSTANTS.MIN_DRAW_DISTANCE) {
        pushUndo();
        state.drawings.push(state.activeShape);
        spatialInsert(state.activeShape);
      }
      state.activeShape = null;
    }

    // Update spatial index for any elements that were dragged/moved during this interaction
    if (state.selectedElements.length > 0) {
      for (const el of state.selectedElements) spatialUpdate(el);
    }

    toggleAlignmentPanelVisibility();
    render();
    state.isMiddleClick = false;
    state.isRightClickHand = false;
    updateCursor();
    scheduleSave();
  });

  // Double-click for text editing
  container.addEventListener("dblclick", (e) => {
    if (state.currentTool !== "select") return;
    const worldPos = screenToWorld(e.clientX, e.clientY);

    // Double-click on a locked element to unlock it
    for (let i = state.drawings.length - 1; i >= 0; i--) {
      if (!state.drawings[i].locked) continue;
      if (isPointHittingShape(worldPos, state.drawings[i])) {
        pushUndo();
        state.drawings[i].locked = false;
        state.selectedElements = [state.drawings[i]];
        if (state.drawings[i].type !== "text") state.drawings[i].elementType = "drawing";
        toggleAlignmentPanelVisibility();
        render();
        showToast("Unlocked element");
        scheduleSave();
        return;
      }
    }
    for (let i = state.images.length - 1; i >= 0; i--) {
      const img = state.images[i];
      if (!img.locked) continue;
      if (worldPos.x >= img.x && worldPos.x <= img.x + img.w && worldPos.y >= img.y && worldPos.y <= img.y + img.h) {
        pushUndo();
        img.locked = false;
        img.elementType = "image";
        state.selectedElements = [img];
        toggleAlignmentPanelVisibility();
        render();
        showToast("Unlocked element");
        scheduleSave();
        return;
      }
    }

    // Check if double-clicking on an image to enter crop mode
    for (let i = state.images.length - 1; i >= 0; i--) {
      const img = state.images[i];
      if (worldPos.x >= img.x && worldPos.x <= img.x + img.w && worldPos.y >= img.y && worldPos.y <= img.y + img.h) {
        enterCropMode(img);
        return;
      }
    }

    // Check if double-clicking on a text element to edit it
    for (let i = state.drawings.length - 1; i >= 0; i--) {
      const shape = state.drawings[i];
      if (shape.type !== "text") continue;
      if (!isPointHittingShape(worldPos, shape)) continue;

      const editingText = shape;
      state.activeTextCoord = { x: editingText.start.x, y: editingText.start.y };
      state.currentFontSize = editingText.fontSize;
      setTextEditorContent(editingText.text, editingText.segments);
      textEditor.style.display = "block";
      textEditor.style.color = editingText.color;
      if (editingText.bgColor) {
        textEditor.dataset.bgColor = editingText.bgColor;
        textEditor.style.background = editingText.bgColor;
        textEditor.style.border = "1px dashed #c4b800";
      } else {
        textEditor.dataset.bgColor = "";
        textEditor.style.background = "transparent";
        textEditor.style.border = "1px dashed #007acc";
      }
      const screenPos = worldToScreen(state.activeTextCoord.x, state.activeTextCoord.y);
      textEditor.style.left = `${screenPos.x}px`;
      textEditor.style.top = `${screenPos.y - state.currentFontSize * state.transform.zoom * 0.2}px`;
      textEditor.style.fontSize = `${state.currentFontSize * state.transform.zoom}px`;
      textEditor.style.fontFamily = editingText.fontFamily || state.currentFontFamily;
      textEditor.style.lineHeight = "1.2";

      // Remove the original text element so it can be re-baked
      pushUndo();
      spatialRemove(state.drawings[i]);
      state.drawings.splice(i, 1);
      state.selectedElements = [];

      setTimeout(() => {
        textEditor.focus();
        // Select all text for easy replacement
        const range = document.createRange();
        range.selectNodeContents(textEditor);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        autoResizeTextEditor();
        if (window._textFormatBar) { window._textFormatBar.show(); }
      }, 20);
      render();
      break;
    }
  });
}
