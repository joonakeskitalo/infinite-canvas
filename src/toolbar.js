/**
 * Toolbar & UI Management
 *
 * Toolbar state, alignment panel visibility, cursor management, zoom.
 */

import { state, CONSTANTS, getDom } from "./state.js";
import { buildAlignmentUnits } from "./selection.js";
import { getShapeBounds } from "./elements.js";
import { showToast } from "./utils.js";

export function updateToolbarUI() {
  const buttons = document.querySelectorAll(".tool-btn");
  buttons.forEach((b) => {
    if (!b.dataset.tool) return;
    if (b.dataset.tool === state.currentTool) b.classList.add("active");
    else b.classList.remove("active");
  });
  // Hide contrast checker panel when not in contrast tool
  if (state.currentTool !== "contrast") {
    const contrastPanel = document.getElementById("contrast-checker-panel");
    if (contrastPanel) contrastPanel.style.display = "none";
  }
  // Show/hide bezier fill control
  const bezierFillGroup = document.getElementById("bezier-fill-group");
  if (bezierFillGroup) {
    const show = state.currentTool === "bezier-pen" ||
      (state.currentTool === "select" && state.selectedElements.some((el) => el.type === "bezier-path"));
    bezierFillGroup.style.display = show ? "" : "none";
  }
  // Show/hide split-line length control
  const splitLineLengthGroup = document.getElementById("split-line-length-group");
  if (splitLineLengthGroup) {
    splitLineLengthGroup.style.display = state.currentTool === "split-line" ? "flex" : "none";
  }
  // Show/hide split-line dash pattern control
  const splitLineDashGroup = document.getElementById("split-line-dash-group");
  if (splitLineDashGroup) {
    splitLineDashGroup.style.display = state.currentTool === "split-line" ? "flex" : "none";
  }
  toggleAlignmentPanelVisibility();
}

export function toggleAlignmentPanelVisibility() {
  const dom = getDom();
  const scaleGroup = document.getElementById("scale-group");
  const alignmentGroup = document.getElementById("alignment-group");

  // Update bezier fill control visibility on selection changes
  const bezierFillGroupEl = document.getElementById("bezier-fill-group");
  if (bezierFillGroupEl) {
    const show = state.currentTool === "bezier-pen" ||
      (state.currentTool === "select" && state.selectedElements.some((el) => el.type === "bezier-path"));
    bezierFillGroupEl.style.display = show ? "" : "none";
    // Sync fill swatch with selected element's fill
    if (show && state.selectedElements.length > 0) {
      const bezEl = state.selectedElements.find((el) => el.type === "bezier-path");
      if (bezEl) {
        const inner = document.getElementById("bezier-fill-swatch-inner");
        if (bezEl.fillColor) {
          state.bezierFillColor = bezEl.fillColor;
          if (inner) { inner.style.background = bezEl.fillColor; inner.style.border = "none"; }
        } else {
          state.bezierFillColor = null;
          if (inner) { inner.style.background = "transparent"; inner.style.border = "2px dashed #999"; }
        }
      }
    }
  }

  // When overlays are hidden, never show the secondary toolbar
  if (state.overlaysHidden) {
    dom.alignmentPanel.style.display = "none";
    alignmentGroup.style.display = "none";
    scaleGroup.style.display = "none";
    dom.textAlignGroup.style.display = "none";
    const zOrderGroup = document.getElementById("z-order-group");
    if (zOrderGroup) zOrderGroup.style.display = "none";
    const textFormatGroup = document.getElementById("text-format-group");
    if (textFormatGroup) textFormatGroup.style.display = "none";
    const cropCopyGroupHidden = document.getElementById("crop-copy-group");
    if (cropCopyGroupHidden) cropCopyGroupHidden.style.display = "none";
    const colorInfoGroupHidden = document.getElementById("color-info-group");
    if (colorInfoGroupHidden) colorInfoGroupHidden.style.display = "none";
    return;
  }

  const hasImages = state.selectedElements.some((el) => el.elementType === "image");
  const hasText = state.selectedElements.some((el) => el.elementType === "text" || el.type === "text");

  if (state.currentTool === "select" && state.selectedElements.length > 1) {
    dom.alignmentPanel.style.display = "flex";
    alignmentGroup.style.display = "flex";
    updateSpacingInputs();
  } else if (state.currentTool === "select" && state.selectedElements.length === 1 && hasImages) {
    dom.alignmentPanel.style.display = "flex";
    alignmentGroup.style.display = "none";
  } else if (state.currentTool === "select" && state.selectedElements.length === 1) {
    dom.alignmentPanel.style.display = "flex";
    alignmentGroup.style.display = "none";
  } else if (state.currentTool === "text") {
    dom.alignmentPanel.style.display = "flex";
    alignmentGroup.style.display = "none";
  } else if (state.currentTool === "split-line") {
    dom.alignmentPanel.style.display = "flex";
    alignmentGroup.style.display = "none";
  } else if (state.currentTool === "eyedropper") {
    dom.alignmentPanel.style.display = "flex";
    alignmentGroup.style.display = "none";
  } else {
    dom.alignmentPanel.style.display = "none";
    alignmentGroup.style.display = "none";
  }

  if (state.currentTool === "select" && state.selectedElements.length > 0 && hasImages) {
    scaleGroup.style.display = "flex";
    const scaleSep = scaleGroup.querySelector(".scale-separator");
    if (scaleSep) scaleSep.style.display = alignmentGroup.style.display === "flex" ? "block" : "none";
  } else {
    scaleGroup.style.display = "none";
  }

  // Show crop copy/paste controls when images are selected
  const cropCopyGroup = document.getElementById("crop-copy-group");
  if (cropCopyGroup) {
    const hasCroppedImage = state.selectedElements.some((el) => el.elementType === "image" && el.crop);
    const hasCropClipboard = !!state.cropClipboard;
    if (state.currentTool === "select" && state.selectedElements.length > 0 && hasImages && (hasCroppedImage || hasCropClipboard)) {
      cropCopyGroup.style.display = "flex";
      const copyBtn = document.getElementById("crop-copy-btn");
      const pasteBtn = document.getElementById("crop-paste-btn");
      if (copyBtn) copyBtn.disabled = !hasCroppedImage;
      if (pasteBtn) pasteBtn.disabled = !hasCropClipboard;
    } else {
      cropCopyGroup.style.display = "none";
    }
  }

  // Show text alignment controls when text tool is active or a text element is selected
  if (state.currentTool === "text" || (state.currentTool === "select" && state.selectedElements.length >= 1 && hasText)) {
    dom.textAlignGroup.style.display = "flex";
    if (hasText) syncTextAlignFromSelection();
  } else {
    dom.textAlignGroup.style.display = "none";
  }

  // Show z-order controls when any element is selected
  const zOrderGroup = document.getElementById("z-order-group");
  if (state.currentTool === "select" && state.selectedElements.length >= 1) {
    zOrderGroup.style.display = "flex";
  } else {
    zOrderGroup.style.display = "none";
  }

  syncFontSizeFromSelection();
  syncFontFamilyFromSelection();
  syncOpacityFromSelection();
  syncLineWidthFromSelection();
  syncDimensionsFromSelection();
  updateGroupButtons();

  // Show text format controls when text tool is active or a text element is selected
  const textFormatGroup = document.getElementById("text-format-group");
  const showTextControls = state.currentTool === "text" || state.selectedElements.some((el) => el.elementType === "text" || el.type === "text");
  if (textFormatGroup) textFormatGroup.style.display = showTextControls ? "flex" : "none";
  // Sync format button active states with selected text elements
  if (showTextControls && window._textFormatBar) window._textFormatBar.updateState();

  // Show color info display when eyedropper/color picker tool is active
  const colorInfoGroup = document.getElementById("color-info-group");
  if (colorInfoGroup) {
    if (state.currentTool === "eyedropper") {
      colorInfoGroup.style.display = "flex";
      updateColorInfo();
    } else {
      colorInfoGroup.style.display = "none";
    }
  }
}

/**
 * Update the color info display (hex, RGB, HSL) in the secondary toolbar.
 * Called whenever the active draw color changes or tool switches.
 */
let _colorInfoClickBound = false;

function initColorInfoClick() {
  if (_colorInfoClickBound) return;
  _colorInfoClickBound = true;
  const ids = ["color-info-hex", "color-info-rgb", "color-info-hsl"];
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.style.cursor = "pointer";
      el.addEventListener("click", () => {
        const text = el.textContent;
        navigator.clipboard.writeText(text).then(() => {
          showToast(`Copied: ${text}`);
        });
      });
    }
  });
}

export function updateColorInfo() {
  const hex = state.currentTool === "text" ? state.textDrawColor : state.drawColor;
  const colorInfoGroup = document.getElementById("color-info-group");
  if (!colorInfoGroup || colorInfoGroup.style.display === "none") return;

  initColorInfoClick();

  const swatch = document.getElementById("color-info-swatch");
  const hexEl = document.getElementById("color-info-hex");
  const rgbEl = document.getElementById("color-info-rgb");
  const hslEl = document.getElementById("color-info-hsl");

  if (swatch) swatch.style.background = hex;
  if (hexEl) hexEl.textContent = hex.toUpperCase();

  // Parse hex to RGB
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  if (rgbEl) rgbEl.textContent = `rgb(${r}, ${g}, ${b})`;

  // Convert RGB to HSL
  const rNorm = r / 255;
  const gNorm = g / 255;
  const bNorm = b / 255;
  const max = Math.max(rNorm, gNorm, bNorm);
  const min = Math.min(rNorm, gNorm, bNorm);
  const l = (max + min) / 2;
  let h = 0, s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rNorm) h = ((gNorm - bNorm) / d + (gNorm < bNorm ? 6 : 0)) / 6;
    else if (max === gNorm) h = ((bNorm - rNorm) / d + 2) / 6;
    else h = ((rNorm - gNorm) / d + 4) / 6;
  }

  const hDeg = Math.round(h * 360);
  const sPct = Math.round(s * 100);
  const lPct = Math.round(l * 100);
  if (hslEl) hslEl.textContent = `hsl(${hDeg}, ${sPct}%, ${lPct}%)`;
}

export function syncFontSizeFromSelection() {
  if (state.selectedElements.length === 1 && state.selectedElements[0].elementType === "text") {
    state.currentFontSize = state.selectedElements[0].fontSize;
  }
}

export function syncFontFamilyFromSelection() {
  const dom = getDom();
  if (state.selectedElements.length === 1 && (state.selectedElements[0].elementType === "text" || state.selectedElements[0].type === "text")) {
    const family = state.selectedElements[0].fontFamily || "sans-serif";
    state.currentFontFamily = family;
    dom.fontFamilySelect.value = family;
  } else {
    dom.fontFamilySelect.value = state.currentFontFamily;
  }
}

export function syncTextAlignFromSelection() {
  const textEl = state.selectedElements.find((el) => el.elementType === "text" || el.type === "text");
  const currentAlign = textEl ? (textEl.textAlign || "left") : state.currentTextAlign;
  document.querySelectorAll(".text-align-btn").forEach((btn) => {
    if (btn.dataset.textAlign === currentAlign) btn.classList.add("active");
    else btn.classList.remove("active");
  });
}

export function syncOpacityFromSelection() {
  const dom = getDom();
  if (state.selectedElements.length === 0) {
    dom.opacityGroup.style.display = "none";
    return;
  }
  dom.opacityGroup.style.display = "flex";
  const opacity = state.selectedElements[0].opacity != null ? state.selectedElements[0].opacity : 1;
  const val = Math.round(opacity * 100);
  dom.opacitySlider.value = val;
  dom.opacityValDisplay.textContent = val + "%";
}

export function syncLineWidthFromSelection() {
  if (state.selectedElements.length === 1 && state.selectedElements[0].elementType === "drawing" && state.selectedElements[0].type !== "text") {
    const width = state.selectedElements[0].width;
    state.currentLineWidth = width;
    const btns = document.querySelectorAll(".line-width-btn");
    btns.forEach((b) => {
      if (parseInt(b.dataset.width, 10) === width) b.classList.add("active");
      else b.classList.remove("active");
    });
  }
}

export function syncDimensionsFromSelection() {
  const dom = getDom();
  if (state.selectedElements.length !== 1) {
    dom.dimensionsGroup.style.display = "none";
    dom.lengthGroup.style.display = "none";
    return;
  }
  const el = state.selectedElements[0];
  const isLineType = el.type === "line" || el.type === "arrow" || el.type === "measure" || el.type === "connector";
  const isText = el.type === "text" || el.elementType === "text";

  if (isText) {
    dom.dimensionsGroup.style.display = "none";
    dom.lengthGroup.style.display = "none";
    return;
  }

  if (isLineType) {
    // Show length input for line-type elements
    dom.dimensionsGroup.style.display = "none";
    dom.lengthGroup.style.display = "flex";
    const dx = el.end.x - el.start.x;
    const dy = el.end.y - el.start.y;
    const len = Math.round(Math.sqrt(dx * dx + dy * dy));
    dom.dimLength.value = len;
  } else {
    // Show W/H for other elements
    dom.lengthGroup.style.display = "none";
    dom.dimensionsGroup.style.display = "flex";
    let w, h;
    if (el.elementType === "image") {
      w = Math.round(el.w);
      h = Math.round(el.h);
    } else {
      const b = getShapeBounds(el);
      w = Math.round(b.w);
      h = Math.round(b.h);
    }
    dom.dimW.value = w;
    dom.dimH.value = h;
    // Images are not editable via dimension inputs
    const isImage = el.elementType === "image";
    dom.dimW.disabled = isImage;
    dom.dimH.disabled = isImage;
    dom.dimW.style.opacity = isImage ? "0.5" : "1";
    dom.dimH.style.opacity = isImage ? "0.5" : "1";
  }
}

export function updateSpacingInputs() {
  if (state.selectedElements.length < 2) return;
  const units = buildAlignmentUnits(state.selectedElements);
  if (units.length < 2) return;

  const sortedX = [...units].sort((a, b) => a.b.x - b.b.x);
  let totalGapX = 0, gapCountX = 0;
  for (let i = 1; i < sortedX.length; i++) {
    const gap = sortedX[i].b.x - (sortedX[i - 1].b.x + sortedX[i - 1].b.w);
    totalGapX += gap; gapCountX++;
  }
  const avgGapX = gapCountX > 0 ? Math.round(totalGapX / gapCountX) : 0;

  const sortedY = [...units].sort((a, b) => a.b.y - b.b.y);
  let totalGapY = 0, gapCountY = 0;
  for (let i = 1; i < sortedY.length; i++) {
    const gap = sortedY[i].b.y - (sortedY[i - 1].b.y + sortedY[i - 1].b.h);
    totalGapY += gap; gapCountY++;
  }
  const avgGapY = gapCountY > 0 ? Math.round(totalGapY / gapCountY) : 0;

  const dom = getDom();
  dom.spacingInputX.value = avgGapX;
  dom.spacingInputY.value = avgGapY;
}

export function updateGroupButtons() {
  const groupBtn = document.getElementById("group-btn");
  const ungroupBtn = document.getElementById("ungroup-btn");
  const canGroup = state.currentTool === "select" && state.selectedElements.length >= 2;
  const hasGroup = state.selectedElements.some((el) => el.groupId);
  groupBtn.classList.toggle("disabled", !canGroup);
  ungroupBtn.classList.toggle("disabled", !hasGroup);
}

export function updateCursor() {
  const { container } = getDom();
  if (state.currentTool === "pan" || state.isRightClickHand)
    container.style.cursor = state.isInteracting ? "grabbing" : "grab";
  else if (state.currentTool === "select") container.style.cursor = "default";
  else if (state.currentTool === "eraser") container.style.cursor = "pointer";
  else if (state.currentTool === "text") container.style.cursor = "text";
  else if (state.currentTool === "text-element") container.style.cursor = "text";
  else if (state.currentTool === "laser") {
    const c = encodeURIComponent(state.drawColor);
    container.style.cursor = `url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5" fill="${c}" opacity="0.9"/><circle cx="12" cy="12" r="2" fill="white" opacity="0.8"/></svg>') 12 12, crosshair`;
  }
  else if (state.currentTool === "eyedropper") container.style.cursor = "crosshair";
  else if (state.currentTool === "marquee") container.style.cursor = "crosshair";
  else if (state.currentTool === "contrast") container.style.cursor = "crosshair";
  else if (state.currentTool === "measure") container.style.cursor = "crosshair";
  else if (state.currentTool === "bezier-pen") container.style.cursor = "crosshair";
  else if (state.currentTool === "split-line") container.style.cursor = "crosshair";
  else if (state.currentTool === "stamp") container.style.cursor = "copy";
  else if (state.currentTool === "accessibility-preview") container.style.cursor = "crosshair";
  else container.style.cursor = "crosshair";
}

export function applyZoom(newZoom, centerX, centerY) {
  if (newZoom < 0.05 || newZoom > 12.0) return;
  const oldZoom = state.transform.zoom;
  state.transform.x = centerX - (centerX - state.transform.x) * (newZoom / oldZoom);
  state.transform.y = centerY - (centerY - state.transform.y) * (newZoom / oldZoom);
  state.transform.zoom = newZoom;
  updateZoomSliderValue();
  // Render is called by the caller or via scheduleRender
  _renderFn();
}

export function updateZoomSliderValue() {
  const dom = getDom();
  const percent = Math.round(state.transform.zoom * 100);
  dom.zoomSlider.value = percent;
  dom.zoomValDisplay.textContent = `${percent}%`;
}

// Late-bound render function to break circular dependency
let _renderFn = () => {};
export function setRenderFn(fn) {
  _renderFn = fn;
}
