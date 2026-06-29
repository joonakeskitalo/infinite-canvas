/**
 * Toolbar & UI Management
 *
 * Toolbar state, alignment panel visibility, cursor management, zoom.
 */

import { state, CONSTANTS, getDom } from "./state.js";
import { buildAlignmentUnits } from "./selection.js";

export function updateToolbarUI() {
  const buttons = document.querySelectorAll(".tool-btn");
  buttons.forEach((b) => {
    if (!b.dataset.tool) return;
    if (b.dataset.tool === state.currentTool) b.classList.add("active");
    else b.classList.remove("active");
  });
  const colorLabel = document.getElementById("color-label");
  if (state.currentTool === "text") {
    colorLabel.textContent = "Text";
  } else {
    colorLabel.textContent = "Color";
  }
  toggleAlignmentPanelVisibility();
}

export function toggleAlignmentPanelVisibility() {
  const dom = getDom();
  const scaleGroup = document.getElementById("scale-group");
  const alignmentGroup = document.getElementById("alignment-group");
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

  // Show text alignment controls when a text element is selected
  if (state.currentTool === "select" && state.selectedElements.length >= 1 && hasText) {
    dom.textAlignGroup.style.display = "flex";
    syncTextAlignFromSelection();
  } else {
    dom.textAlignGroup.style.display = "none";
  }

  syncFontSizeFromSelection();
  syncFontFamilyFromSelection();
  syncOpacityFromSelection();
  updateGroupButtons();
}

export function syncFontSizeFromSelection() {
  const dom = getDom();
  if (state.selectedElements.length === 1 && state.selectedElements[0].elementType === "text") {
    const size = state.selectedElements[0].fontSize;
    state.currentFontSize = size;
    let option = dom.fontSizeSelect.querySelector(`option[value="${size}"]`);
    if (!option) {
      option = document.createElement("option");
      option.value = size;
      option.textContent = size + "px";
      const options = Array.from(dom.fontSizeSelect.options);
      let inserted = false;
      for (let i = 0; i < options.length; i++) {
        if (parseInt(options[i].value) > size) {
          dom.fontSizeSelect.insertBefore(option, options[i]);
          inserted = true;
          break;
        }
      }
      if (!inserted) dom.fontSizeSelect.appendChild(option);
    }
    dom.fontSizeSelect.value = size;
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
  else if (state.currentTool === "measure") container.style.cursor = "crosshair";
  else container.style.cursor = "crosshair";
}

export function applyZoom(newZoom, centerX, centerY) {
  if (newZoom < 0.05 || newZoom > 2.0) return;
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
