/**
 * Selection, Clipboard, Grouping & Alignment
 *
 * Functions for managing element selection, copy/paste, groups,
 * and layout operations.
 */

import { state, CONSTANTS, getDom } from "./state.js";
import { showToast, screenToWorld } from "./utils.js";
import {
  getShapeBounds, cloneElement, translateElement,
  getElementCenter, isPointOnSwapHandle,
} from "./elements.js";
import { pushUndo } from "./history.js";
import { scheduleSave } from "./persistence.js";
import { render } from "./rendering.js";
import { updateToolbarUI, toggleAlignmentPanelVisibility } from "./toolbar.js";

export function expandSelectionToGroups() {
  const groupIds = new Set();
  state.selectedElements.forEach((el) => {
    if (el.groupId) groupIds.add(el.groupId);
  });
  if (groupIds.size === 0) return;
  const allElements = [...state.images, ...state.drawings];
  allElements.forEach((el) => {
    if (el.groupId && groupIds.has(el.groupId)) {
      if (!state.selectedElements.some((s) => s.id === el.id)) {
        state.selectedElements.push(el);
      }
    }
  });
}

export function groupSelection() {
  if (state.selectedElements.length < 2) return;
  pushUndo();
  const groupId = "group_" + state.groupIdCounter++;
  state.selectedElements.forEach((el) => {
    el.groupId = groupId;
  });
  toggleAlignmentPanelVisibility();
  render();
  showToast(`Grouped ${state.selectedElements.length} elements`);
}

export function ungroupSelection() {
  const groupIds = new Set();
  state.selectedElements.forEach((el) => {
    if (el.groupId) groupIds.add(el.groupId);
  });
  if (groupIds.size === 0) return;
  pushUndo();
  const allElements = [...state.images, ...state.drawings];
  allElements.forEach((el) => {
    if (el.groupId && groupIds.has(el.groupId)) {
      delete el.groupId;
    }
  });
  toggleAlignmentPanelVisibility();
  render();
  showToast("Ungrouped");
}

export function copySelectionToClipboard() {
  if (state.selectedElements.length === 0) return;
  state.clipboardElements = state.selectedElements.map((el) => cloneElement(el));
  state.pasteOffset = 0;
  state.internalCopyPerformed = true;
  state.pendingInternalCopy = true;
  document.execCommand("copy");
  state.pendingInternalCopy = false;
  showToast(`Copied ${state.clipboardElements.length} element(s)`);
}

export function pasteFromClipboard() {
  if (state.clipboardElements.length === 0) return;
  pushUndo();
  state.pasteOffset += 30;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  state.clipboardElements.forEach((el) => {
    let bounds;
    if (el.elementType === "image") {
      bounds = { x: el.x, y: el.y, w: el.w, h: el.h };
    } else {
      bounds = getShapeBounds(el);
    }
    if (bounds.x < minX) minX = bounds.x;
    if (bounds.y < minY) minY = bounds.y;
    if (bounds.x + bounds.w > maxX) maxX = bounds.x + bounds.w;
    if (bounds.y + bounds.h > maxY) maxY = bounds.y + bounds.h;
  });
  const clipCenterX = (minX + maxX) / 2;
  const clipCenterY = (minY + maxY) / 2;

  const cursorWorld = screenToWorld(state.lastMousePos.x, state.lastMousePos.y);
  const deltaX = cursorWorld.x - clipCenterX + state.pasteOffset;
  const deltaY = cursorWorld.y - clipCenterY + state.pasteOffset;

  const newElements = [];
  const groupIdMap = new Map();
  state.clipboardElements.forEach((el) => {
    const clone = cloneElement(el);
    clone.id = (clone.elementType === "image" ? "img_" : "draw_") + state.elementIdCounter++;
    if (clone.groupId) {
      if (!groupIdMap.has(clone.groupId)) {
        groupIdMap.set(clone.groupId, "group_" + state.groupIdCounter++);
      }
      clone.groupId = groupIdMap.get(clone.groupId);
    }
    if (clone.elementType === "image") {
      clone.x += deltaX;
      clone.y += deltaY;
      if (clone.fullBounds) {
        clone.fullBounds = { x: clone.fullBounds.x + deltaX, y: clone.fullBounds.y + deltaY, w: clone.fullBounds.w, h: clone.fullBounds.h };
      }
    } else if (clone.type === "pen") {
      clone.points = clone.points.map((p) => ({ x: p.x + deltaX, y: p.y + deltaY }));
    } else {
      clone.start = { x: clone.start.x + deltaX, y: clone.start.y + deltaY };
      if (clone.end) {
        clone.end = { x: clone.end.x + deltaX, y: clone.end.y + deltaY };
      }
    }
    if (clone.elementType === "image") {
      state.images.push(clone);
    } else {
      state.drawings.push(clone);
    }
    newElements.push(clone);
  });
  state.selectedElements = newElements;
  state.currentTool = "select";
  updateToolbarUI();
  toggleAlignmentPanelVisibility();
  render();
  showToast(`Pasted ${newElements.length} element(s)`);
}

export function pasteTextToCanvas(text) {
  pushUndo();
  const cursorWorld = screenToWorld(state.lastMousePos.x, state.lastMousePos.y);
  const lines = text.split("\n");
  const pastedElements = [];
  let yOffset = 0;

  lines.forEach((line) => {
    if (line.trim().length === 0) {
      yOffset += state.currentFontSize * 0.5;
      return;
    }
    const textEl = {
      id: "text_" + state.elementIdCounter++,
      elementType: "text",
      type: "text",
      text: line,
      color: state.textDrawColor,
      fontSize: state.currentFontSize,
      start: { x: cursorWorld.x, y: cursorWorld.y + yOffset },
    };
    state.drawings.push(textEl);
    pastedElements.push(textEl);
    yOffset += state.currentFontSize * 1.2;
  });

  if (pastedElements.length > 0) {
    state.selectedElements = pastedElements;
    state.currentTool = "select";
    updateToolbarUI();
    toggleAlignmentPanelVisibility();
    render();
    showToast(`Pasted ${pastedElements.length} text line(s)`);
  }
}

export function duplicateSelection() {
  if (state.selectedElements.length === 0) return;
  pushUndo();
  const DUPLICATE_OFFSET = 30;
  const newElements = [];
  const groupIdMap = new Map();

  state.selectedElements.forEach((el) => {
    const clone = cloneElement(el);
    clone.id = (clone.elementType === "image" ? "img_" : "draw_") + state.elementIdCounter++;
    if (clone.groupId) {
      if (!groupIdMap.has(clone.groupId)) {
        groupIdMap.set(clone.groupId, "group_" + state.groupIdCounter++);
      }
      clone.groupId = groupIdMap.get(clone.groupId);
    }
    if (clone.elementType === "image") {
      clone.x += DUPLICATE_OFFSET;
      clone.y += DUPLICATE_OFFSET;
      if (clone.fullBounds) {
        clone.fullBounds = { x: clone.fullBounds.x + DUPLICATE_OFFSET, y: clone.fullBounds.y + DUPLICATE_OFFSET, w: clone.fullBounds.w, h: clone.fullBounds.h };
      }
    } else if (clone.type === "pen") {
      clone.points = clone.points.map((p) => ({ x: p.x + DUPLICATE_OFFSET, y: p.y + DUPLICATE_OFFSET }));
    } else {
      clone.start = { x: clone.start.x + DUPLICATE_OFFSET, y: clone.start.y + DUPLICATE_OFFSET };
      if (clone.end) {
        clone.end = { x: clone.end.x + DUPLICATE_OFFSET, y: clone.end.y + DUPLICATE_OFFSET };
      }
    }
    if (clone.elementType === "image") {
      state.images.push(clone);
    } else {
      state.drawings.push(clone);
    }
    newElements.push(clone);
  });

  state.selectedElements = newElements;
  state.currentTool = "select";
  updateToolbarUI();
  toggleAlignmentPanelVisibility();
  render();
  showToast(`Duplicated ${newElements.length} element(s)`);
}

export function selectAllElements() {
  state.currentTool = "select";
  state.selectedElements = [];
  state.images.forEach((img) => { img.elementType = "image"; state.selectedElements.push(img); });
  state.drawings.forEach((shape) => {
    if (shape.type !== "text") shape.elementType = "drawing";
    state.selectedElements.push(shape);
  });
  updateToolbarUI();
  toggleAlignmentPanelVisibility();
  render();
  showToast(`Selected all ${state.selectedElements.length} element(s)`);
}

export function swapElementPositions(elA, elB) {
  pushUndo();
  const boundsA = elA.elementType === "image" ? { x: elA.x, y: elA.y, w: elA.w, h: elA.h } : getShapeBounds(elA);
  const boundsB = elB.elementType === "image" ? { x: elB.x, y: elB.y, w: elB.w, h: elB.h } : getShapeBounds(elB);
  const centerA = { x: boundsA.x + boundsA.w / 2, y: boundsA.y + boundsA.h / 2 };
  const centerB = { x: boundsB.x + boundsB.w / 2, y: boundsB.y + boundsB.h / 2 };
  const shiftAtoB = { x: centerB.x - centerA.x, y: centerB.y - centerA.y };
  const shiftBtoA = { x: centerA.x - centerB.x, y: centerA.y - centerB.y };
  translateElement(elA, shiftAtoB.x, shiftAtoB.y);
  translateElement(elB, shiftBtoA.x, shiftBtoA.y);
  render();
  scheduleSave();
  showToast("Swapped positions");
}

// --- ALIGNMENT UNITS ---
export function buildAlignmentUnits(elements) {
  const groupMap = new Map();
  const ungrouped = [];
  elements.forEach((el) => {
    if (el.groupId) {
      if (!groupMap.has(el.groupId)) groupMap.set(el.groupId, []);
      groupMap.get(el.groupId).push(el);
    } else {
      ungrouped.push(el);
    }
  });

  const units = [];
  groupMap.forEach((groupEls, gid) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    groupEls.forEach((el) => {
      const b = el.elementType === "image" ? { x: el.x, y: el.y, w: el.w, h: el.h, maxX: el.x + el.w, maxY: el.y + el.h } : getShapeBounds(el);
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if ((b.maxX || b.x + b.w) > maxX) maxX = b.maxX || b.x + b.w;
      if ((b.maxY || b.y + b.h) > maxY) maxY = b.maxY || b.y + b.h;
    });
    units.push({ elements: groupEls, b: { x: minX, y: minY, w: maxX - minX, h: maxY - minY, maxX, maxY }, isGroup: true, groupId: gid });
  });

  ungrouped.forEach((el) => {
    const b = el.elementType === "image" ? { x: el.x, y: el.y, w: el.w, h: el.h, maxX: el.x + el.w, maxY: el.y + el.h } : getShapeBounds(el);
    units.push({ elements: [el], b, isGroup: false });
  });

  return units;
}

export function translateUnit(unit, shiftX, shiftY) {
  unit.elements.forEach((el) => translateElement(el, shiftX, shiftY));
}

// --- LAYOUT FUNCTIONS ---
export function applyRowLayout(units) {
  const n = units.length;
  if (n < 2) return;
  const gap = 100;
  units.sort((a, b) => a.b.x - b.b.x);
  const anchorX = units[0].b.x;
  const anchorY = units[0].b.y;
  let currentX = anchorX;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const shiftX = currentX - unit.b.x;
    const shiftY = anchorY - unit.b.y;
    if (shiftX !== 0 || shiftY !== 0) translateUnit(unit, shiftX, shiftY);
    currentX += unit.b.w + gap;
  }
  showToast(`Row: ${n} items laid out horizontally`);
}

export function applyColumnLayout(units) {
  const n = units.length;
  if (n < 2) return;
  const gap = 100;
  units.sort((a, b) => a.b.y - b.b.y);
  const anchorX = units[0].b.x;
  const anchorY = units[0].b.y;
  let currentY = anchorY;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const shiftX = anchorX - unit.b.x;
    const shiftY = currentY - unit.b.y;
    if (shiftX !== 0 || shiftY !== 0) translateUnit(unit, shiftX, shiftY);
    currentY += unit.b.h + gap;
  }
  showToast(`Column: ${n} items laid out vertically`);
}

export function applyGridLayout(units) {
  const n = units.length;
  if (n < 2) return;
  const gapX = 100, gapY = 100;

  let centroidX = 0, centroidY = 0;
  units.forEach((unit) => { centroidX += unit.b.x + unit.b.w / 2; centroidY += unit.b.y + unit.b.h / 2; });
  centroidX /= n; centroidY /= n;

  function packWithMaxRects(items, containerW) {
    const freeRects = [{ x: 0, y: 0, w: containerW, h: Infinity }];
    const placements = [];
    let usedW = 0, usedH = 0;

    for (const item of items) {
      let bestIdx = -1, bestShortSide = Infinity, bestLongSide = Infinity;
      for (let i = 0; i < freeRects.length; i++) {
        const r = freeRects[i];
        if (item.w <= r.w && item.h <= r.h) {
          const leftoverX = r.w - item.w, leftoverY = r.h - item.h;
          const shortSide = Math.min(leftoverX, leftoverY);
          const longSide = Math.max(leftoverX, leftoverY);
          if (shortSide < bestShortSide || (shortSide === bestShortSide && longSide < bestLongSide)) {
            bestIdx = i; bestShortSide = shortSide; bestLongSide = longSide;
          }
        }
      }
      if (bestIdx === -1) return null;
      const rect = freeRects[bestIdx];
      const px = rect.x, py = rect.y;
      placements.push({ idx: item.idx, x: px, y: py });
      usedW = Math.max(usedW, px + item.w); usedH = Math.max(usedH, py + item.h);
      if (rect.w - item.w > 0) freeRects.push({ x: px + item.w, y: py, w: rect.w - item.w, h: item.h });
      if (rect.h - item.h > 0) freeRects.push({ x: px, y: py + item.h, w: rect.w, h: rect.h - item.h });
      freeRects.splice(bestIdx, 1);
      const placed = { x: px, y: py, w: item.w, h: item.h };
      for (let i = freeRects.length - 1; i >= 0; i--) {
        const fr = freeRects[i];
        if (fr.x < placed.x + placed.w && fr.x + fr.w > placed.x && fr.y < placed.y + placed.h && fr.y + fr.h > placed.y) {
          const newRects = [];
          if (fr.x < placed.x) newRects.push({ x: fr.x, y: fr.y, w: placed.x - fr.x, h: fr.h });
          if (fr.x + fr.w > placed.x + placed.w) newRects.push({ x: placed.x + placed.w, y: fr.y, w: fr.x + fr.w - (placed.x + placed.w), h: fr.h });
          if (fr.y < placed.y) newRects.push({ x: fr.x, y: fr.y, w: fr.w, h: placed.y - fr.y });
          if (fr.y + fr.h > placed.y + placed.h) newRects.push({ x: fr.x, y: placed.y + placed.h, w: fr.w, h: fr.y + fr.h - (placed.y + placed.h) });
          freeRects.splice(i, 1, ...newRects);
        }
      }
      for (let i = freeRects.length - 1; i >= 0; i--) {
        for (let j = freeRects.length - 1; j >= 0; j--) {
          if (i === j) continue;
          const a = freeRects[i], b = freeRects[j];
          if (a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h) { freeRects.splice(i, 1); break; }
        }
      }
    }
    return { placements, usedW, usedH };
  }

  const items = units.map((unit, idx) => ({ idx, w: unit.b.w + gapX, h: unit.b.h + gapY, origW: unit.b.w, origH: unit.b.h }));
  const sortedItems = [...items].sort((a, b) => {
    const ay = units[a.idx].b.y, by = units[b.idx].b.y;
    const ax = units[a.idx].b.x, bx = units[b.idx].b.x;
    const rowThreshold = Math.max(a.h, b.h) * 0.5;
    if (Math.abs(ay - by) < rowThreshold) return ax - bx;
    return ay - by;
  });

  const maxItemW = Math.max(...items.map((i) => i.w));
  const totalW = items.reduce((s, i) => s + i.w, 0);
  const totalArea = items.reduce((s, i) => s + i.w * i.h, 0);
  const sqrtArea = Math.sqrt(totalArea);

  const candidates = new Set();
  candidates.add(maxItemW); candidates.add(totalW);
  candidates.add(sqrtArea * 0.8); candidates.add(sqrtArea); candidates.add(sqrtArea * 1.2); candidates.add(sqrtArea * 1.5); candidates.add(sqrtArea * 2.0);
  let cumW = 0;
  for (const item of sortedItems) { cumW += item.w; if (cumW >= maxItemW) candidates.add(cumW); }

  let bestResult = null, bestArea = Infinity, bestAspectRatio = Infinity;
  for (const candidateW of candidates) {
    if (candidateW < maxItemW) continue;
    const result = packWithMaxRects(sortedItems, candidateW);
    if (result) {
      const area = result.usedW * result.usedH;
      const aspectRatio = Math.max(result.usedW, result.usedH) / Math.min(result.usedW, result.usedH);
      if (area < bestArea || (area === bestArea && aspectRatio < bestAspectRatio)) { bestArea = area; bestAspectRatio = aspectRatio; bestResult = result; }
    }
  }

  if (!bestResult) {
    let y = 0;
    const placements = [];
    for (const item of sortedItems) { placements.push({ idx: item.idx, x: 0, y }); y += item.h; }
    bestResult = { placements, usedW: maxItemW, usedH: y };
  }

  const layoutW = bestResult.usedW - gapX;
  const layoutH = bestResult.usedH - gapY;
  const offsetX = centroidX - layoutW / 2;
  const offsetY = centroidY - layoutH / 2;

  for (const { idx, x, y } of bestResult.placements) {
    const unit = units[idx];
    const targetX = x + offsetX;
    const targetY = y + offsetY;
    const shiftX = targetX - unit.b.x;
    const shiftY = targetY - unit.b.y;
    if (shiftX !== 0 || shiftY !== 0) translateUnit(unit, shiftX, shiftY);
  }

  showToast(`Mosaic: ${n} items packed (${Math.round(layoutW)}×${Math.round(layoutH)})`);
}
