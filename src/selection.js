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

  // Serialize elements for cross-tab clipboard transfer
  const serialized = serializeClipboardElements(state.clipboardElements);
  const clipboardPayload = CONSTANTS.INTERNAL_COPY_MIME + "\n" + JSON.stringify(serialized);

  // Use Clipboard API to write serialized data to system clipboard
  navigator.clipboard.writeText(clipboardPayload).then(() => {
    showToast(`Copied ${state.clipboardElements.length} element(s)`);
  }).catch(() => {
    // Fallback to old execCommand approach (same-tab only)
    state.pendingInternalCopy = true;
    document.execCommand("copy");
    state.pendingInternalCopy = false;
    showToast(`Copied ${state.clipboardElements.length} element(s)`);
  });
}

function serializeClipboardElements(elements) {
  return elements.map((el) => {
    if (el.elementType === "image") {
      // Serialize image element with data URL
      const imgSrc = el.img ? el.img.src : null;
      return {
        id: el.id,
        elementType: "image",
        x: el.x,
        y: el.y,
        w: el.w,
        h: el.h,
        imgSrc: imgSrc,
        groupId: el.groupId || null,
        opacity: el.opacity != null ? el.opacity : 1,
        crop: el.crop || null,
        fullBounds: el.fullBounds || null,
      };
    }
    // Drawing/text elements
    const serialized = {
      id: el.id,
      elementType: el.elementType,
      type: el.type,
      color: el.color,
      width: el.width,
      groupId: el.groupId || null,
      opacity: el.opacity != null ? el.opacity : 1,
    };
    if (el.type === "pen") {
      serialized.points = el.points.map((p) => ({ x: p.x, y: p.y }));
    } else if (el.type === "text") {
      serialized.text = el.text;
      serialized.fontSize = el.fontSize;
      serialized.start = { x: el.start.x, y: el.start.y };
      if (el.w) serialized.w = el.w;
      if (el.h) serialized.h = el.h;
      if (el.bgColor) serialized.bgColor = el.bgColor;
    } else {
      serialized.start = { x: el.start.x, y: el.start.y };
      if (el.end) serialized.end = { x: el.end.x, y: el.end.y };
      if (el.type === "connector") {
        serialized.startConn = el.startConn ? { ...el.startConn } : null;
        serialized.endConn = el.endConn ? { ...el.endConn } : null;
      }
    }
    return serialized;
  });
}

export function deserializeClipboardElements(serializedArray) {
  const promises = serializedArray.map((data) => {
    if (data.elementType === "image" && data.imgSrc) {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          resolve({
            id: data.id,
            elementType: "image",
            img: img,
            x: data.x,
            y: data.y,
            w: data.w,
            h: data.h,
            groupId: data.groupId || null,
            opacity: data.opacity != null ? data.opacity : 1,
            crop: data.crop || null,
            fullBounds: data.fullBounds || null,
          });
        };
        img.onerror = () => resolve(null);
        img.src = data.imgSrc;
      });
    }
    // Non-image elements can be reconstructed immediately
    const el = { ...data };
    if (el.type === "pen") {
      el.points = data.points.map((p) => ({ x: p.x, y: p.y }));
    } else if (el.type === "text") {
      el.start = { x: data.start.x, y: data.start.y };
    } else if (data.start) {
      el.start = { x: data.start.x, y: data.start.y };
      if (data.end) el.end = { x: data.end.x, y: data.end.y };
    }
    return Promise.resolve(el);
  });
  return Promise.all(promises).then((results) => results.filter(Boolean));
}

export function pasteFromSerializedClipboard(serializedArray) {
  deserializeClipboardElements(serializedArray).then((elements) => {
    if (elements.length === 0) return;

    // Store as local clipboard for repeated paste
    state.clipboardElements = elements.map((el) => cloneElement(el));
    state.pasteOffset = 0;
    state.internalCopyPerformed = true;

    // Now paste them
    pasteFromClipboard();
  });
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
      // Try both BSSF and bottom-left placement, pick the one with smaller bounding box
      let bestIdx = -1, bestShortSide = Infinity, bestLongSide = Infinity;
      let blIdx = -1, blBestY = Infinity, blBestX = Infinity;
      for (let i = 0; i < freeRects.length; i++) {
        const r = freeRects[i];
        if (item.w <= r.w && item.h <= r.h) {
          // BSSF heuristic
          const leftoverX = r.w - item.w, leftoverY = r.h - item.h;
          const shortSide = Math.min(leftoverX, leftoverY);
          const longSide = Math.max(leftoverX, leftoverY);
          if (shortSide < bestShortSide || (shortSide === bestShortSide && longSide < bestLongSide)) {
            bestIdx = i; bestShortSide = shortSide; bestLongSide = longSide;
          }
          // Bottom-left heuristic (minimize y, then x)
          if (r.y < blBestY || (r.y === blBestY && r.x < blBestX)) {
            blIdx = i; blBestY = r.y; blBestX = r.x;
          }
        }
      }
      // Choose the placement that results in smaller bounding area
      let chosenIdx = bestIdx;
      if (blIdx !== -1 && bestIdx !== -1 && blIdx !== bestIdx) {
        const rBssf = freeRects[bestIdx];
        const rBl = freeRects[blIdx];
        const areaBssf = Math.max(usedW, rBssf.x + item.w) * Math.max(usedH, rBssf.y + item.h);
        const areaBl = Math.max(usedW, rBl.x + item.w) * Math.max(usedH, rBl.y + item.h);
        if (areaBl < areaBssf) chosenIdx = blIdx;
      }
      if (chosenIdx === -1) return null;
      const rect = freeRects[chosenIdx];
      const px = rect.x, py = rect.y;
      placements.push({ idx: item.idx, x: px, y: py });
      usedW = Math.max(usedW, px + item.w); usedH = Math.max(usedH, py + item.h);
      // Split: guillotine split along shorter leftover axis
      const leftoverRight = rect.w - item.w;
      const leftoverBelow = rect.h - item.h;
      if (leftoverRight > 0 && leftoverBelow > 0) {
        // Split along the shorter axis for tighter packing
        if (leftoverRight < leftoverBelow) {
          freeRects.push({ x: px + item.w, y: py, w: leftoverRight, h: item.h });
          freeRects.push({ x: px, y: py + item.h, w: rect.w, h: leftoverBelow });
        } else {
          freeRects.push({ x: px + item.w, y: py, w: leftoverRight, h: rect.h });
          freeRects.push({ x: px, y: py + item.h, w: item.w, h: leftoverBelow });
        }
      } else if (leftoverRight > 0) {
        freeRects.push({ x: px + item.w, y: py, w: leftoverRight, h: rect.h });
      } else if (leftoverBelow > 0) {
        freeRects.push({ x: px, y: py + item.h, w: rect.w, h: leftoverBelow });
      }
      freeRects.splice(chosenIdx, 1);
      // Clip all free rects against the placed item
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
      // Remove redundant (contained) free rects
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

  // Multiple sort orders to find the best packing
  const sortOrders = [
    // Height descending (classic bin packing heuristic)
    [...items].sort((a, b) => b.h - a.h || b.w - a.w),
    // Area descending
    [...items].sort((a, b) => (b.w * b.h) - (a.w * a.h)),
    // Width descending
    [...items].sort((a, b) => b.w - a.w || b.h - a.h),
    // Max side descending
    [...items].sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h)),
    // Perimeter descending
    [...items].sort((a, b) => (b.w + b.h) - (a.w + a.h)),
  ];

  const maxItemW = Math.max(...items.map((i) => i.w));
  const totalArea = items.reduce((s, i) => s + i.w * i.h, 0);
  const sqrtArea = Math.sqrt(totalArea);

  // Target aspect ratio: 16:10 landscape (1.6:1) or square (1:1)
  // Score combines area, fill efficiency, and aspect ratio to prefer compact, void-free layouts
  const TARGET_RATIO = 1.6; // 16:10
  function scoreResult(result, itemsList) {
    const area = result.usedW * result.usedH;
    const ratio = result.usedW / result.usedH;
    // Strongly prefer 16:10 landscape, accept square as fallback
    const distToWide = Math.abs(Math.log(ratio) - Math.log(TARGET_RATIO));
    const distToSquare = Math.abs(Math.log(ratio) - Math.log(1.0));
    const ratioPenalty = Math.min(distToWide, distToSquare * 0.33 + distToWide * 0.67);

    // Void detection: classify empty space as edge waste vs interior holes
    // Use a grid-based flood fill to find interior voids
    const W = result.usedW, H = result.usedH;
    // Resolution: divide bounding box into cells (cap at 50×50 for performance)
    const cellsX = Math.min(50, Math.max(10, Math.ceil(W / 50)));
    const cellsY = Math.min(50, Math.max(10, Math.ceil(H / 50)));
    const cellW = W / cellsX, cellH = H / cellsY;

    // Mark cells as occupied if an item covers their center
    const grid = new Uint8Array(cellsX * cellsY); // 0=empty, 1=occupied, 2=edge-reachable
    for (const p of result.placements) {
      const item = itemsList.find(it => it.idx === p.idx) || items[p.idx];
      const x0 = Math.floor(p.x / cellW);
      const y0 = Math.floor(p.y / cellH);
      const x1 = Math.min(cellsX - 1, Math.floor((p.x + item.w - 1) / cellW));
      const y1 = Math.min(cellsY - 1, Math.floor((p.y + item.h - 1) / cellH));
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          grid[cy * cellsX + cx] = 1;
        }
      }
    }

    // Flood fill from all border empty cells to find edge-reachable empty space
    const queue = [];
    for (let cx = 0; cx < cellsX; cx++) {
      if (grid[cx] === 0) { grid[cx] = 2; queue.push(cx); } // top row
      const bot = (cellsY - 1) * cellsX + cx;
      if (grid[bot] === 0) { grid[bot] = 2; queue.push(bot); } // bottom row
    }
    for (let cy = 0; cy < cellsY; cy++) {
      const left = cy * cellsX;
      if (grid[left] === 0) { grid[left] = 2; queue.push(left); } // left col
      const right = cy * cellsX + (cellsX - 1);
      if (grid[right] === 0) { grid[right] = 2; queue.push(right); } // right col
    }
    // BFS flood fill
    let qi = 0;
    while (qi < queue.length) {
      const idx = queue[qi++];
      const cx = idx % cellsX, cy = (idx - cx) / cellsX;
      const neighbors = [];
      if (cx > 0) neighbors.push(idx - 1);
      if (cx < cellsX - 1) neighbors.push(idx + 1);
      if (cy > 0) neighbors.push(idx - cellsX);
      if (cy < cellsY - 1) neighbors.push(idx + cellsX);
      for (const ni of neighbors) {
        if (grid[ni] === 0) { grid[ni] = 2; queue.push(ni); }
      }
    }

    // Count interior holes (empty cells NOT reachable from edges)
    let interiorHoleCells = 0, edgeWasteCells = 0, totalCells = cellsX * cellsY;
    for (let i = 0; i < totalCells; i++) {
      if (grid[i] === 0) interiorHoleCells++;
      else if (grid[i] === 2) edgeWasteCells++;
    }

    const holeFraction = interiorHoleCells / totalCells;
    const edgeWasteFraction = edgeWasteCells / totalCells;

    // Interior holes are very bad (weight 3.0), edge waste is mildly bad (weight 0.5)
    const voidPenalty = holeFraction * 3.0 + edgeWasteFraction * 0.5;

    // Combined score
    return area * (1 + ratioPenalty * 1.5 + voidPenalty);
  }

  // Generate candidate widths heavily biased toward 16:10 target
  const candidateWidths = new Set();
  candidateWidths.add(maxItemW);
  // Ideal width for 16:10 given the total area
  const idealWidthWide = Math.sqrt(totalArea * TARGET_RATIO);
  const idealWidthSquare = Math.sqrt(totalArea);
  candidateWidths.add(idealWidthWide);
  candidateWidths.add(idealWidthSquare);
  // Dense steps around the 16:10 ideal width (primary target)
  for (let m = 0.75; m <= 1.35; m += 0.025) {
    candidateWidths.add(idealWidthWide * m);
  }
  // Sparser steps around square ideal (fallback)
  for (let m = 0.8; m <= 1.3; m += 0.1) {
    candidateWidths.add(idealWidthSquare * m);
  }
  // Linear steps from maxItemW to beyond the wider ideal
  const searchMax = Math.max(idealWidthWide * 1.5, maxItemW * 2);
  const steps = Math.min(50, Math.max(25, n));
  const stepSize = (searchMax - maxItemW) / steps;
  for (let i = 0; i <= steps; i++) {
    candidateWidths.add(maxItemW + stepSize * i);
  }
  // Add cumulative widths from each sort order (often matches natural row breaks)
  for (const sorted of sortOrders) {
    let cumW = 0;
    for (const item of sorted) {
      cumW += item.w;
      if (cumW >= maxItemW) candidateWidths.add(cumW);
    }
  }

  let bestResult = null, bestScore = Infinity;

  // Try each sort order × each candidate width
  for (const sortedItems of sortOrders) {
    for (const candidateW of candidateWidths) {
      if (candidateW < maxItemW) continue;
      const result = packWithMaxRects(sortedItems, candidateW);
      if (result) {
        const score = scoreResult(result, sortedItems);
        if (score < bestScore) { bestScore = score; bestResult = result; }
      }
    }
  }

  // Refine: ternary search around the best width for each sort order
  if (bestResult) {
    const refineRadius = stepSize * 2;
    const bestW = bestResult.usedW;
    for (const sortedItems of sortOrders) {
      let lo = Math.max(maxItemW, bestW - refineRadius);
      let hi = bestW + refineRadius;
      for (let iter = 0; iter < 12; iter++) {
        const mid1 = lo + (hi - lo) / 3;
        const mid2 = hi - (hi - lo) / 3;
        const r1 = packWithMaxRects(sortedItems, mid1);
        const r2 = packWithMaxRects(sortedItems, mid2);
        const s1 = r1 ? scoreResult(r1, sortedItems) : Infinity;
        const s2 = r2 ? scoreResult(r2, sortedItems) : Infinity;
        if (s1 < bestScore) { bestScore = s1; bestResult = r1; }
        if (s2 < bestScore) { bestScore = s2; bestResult = r2; }
        if (s1 < s2) hi = mid2; else lo = mid1;
      }
    }
  }

  if (!bestResult) {
    let y = 0;
    const placements = [];
    const fallbackItems = [...items].sort((a, b) => b.h - a.h || b.w - a.w);
    for (const item of fallbackItems) { placements.push({ idx: item.idx, x: 0, y }); y += item.h; }
    bestResult = { placements, usedW: maxItemW, usedH: y };
  }

  // Post-packing: compact items to eliminate voids while preserving the target aspect ratio.
  // The key insight: horizontal compaction destroys the chosen width. Instead, we only
  // compact vertically (close gaps upward) and fill holes by moving items into gaps
  // at the same or smaller x, never collapsing the width.
  const placed = bestResult.placements.map(p => {
    const item = items[p.idx];
    return { idx: p.idx, x: p.x, y: p.y, w: item.w, h: item.h };
  });
  const targetW = bestResult.usedW; // Preserve the width the packer chose

  function noOverlap(rect, others, skipIdx) {
    for (const o of others) {
      if (o.idx === skipIdx) continue;
      if (rect.x < o.x + o.w && rect.x + rect.w > o.x &&
          rect.y < o.y + o.h && rect.y + rect.h > o.y) return false;
    }
    return true;
  }

  // Phase 1: Vertical compaction only — slide items up to close vertical gaps
  let changed = true;
  for (let pass = 0; pass < 30 && changed; pass++) {
    changed = false;
    placed.sort((a, b) => a.y - b.y || a.x - b.x);
    for (const p of placed) {
      let bestY = 0;
      for (const other of placed) {
        if (other.idx === p.idx) continue;
        if (p.x < other.x + other.w && p.x + p.w > other.x && other.y + other.h <= p.y) {
          bestY = Math.max(bestY, other.y + other.h);
        }
      }
      if (bestY < p.y && noOverlap({ ...p, y: bestY }, placed, p.idx)) {
        p.y = bestY;
        changed = true;
      }
    }
  }

  // Phase 2: Fill interior holes — move items from the bottom into interior gaps
  // while staying within the target width
  for (let pass = 0; pass < 10; pass++) {
    let movedAny = false;
    let bH = 0;
    for (const p of placed) { bH = Math.max(bH, p.y + p.h); }

    // Items sorted by bottom edge descending — try to relocate the lowest items first
    const byBottom = [...placed].sort((a, b) => (b.y + b.h) - (a.y + a.h));

    for (const p of byBottom) {
      // Only try to move items that are in the bottom third
      if (p.y + p.h < bH * 0.6) continue;

      // Generate candidate positions: anchor to existing items' corners
      const anchors = [];
      for (const other of placed) {
        if (other.idx === p.idx) continue;
        anchors.push({ x: other.x + other.w, y: other.y });
        anchors.push({ x: other.x, y: other.y + other.h });
        anchors.push({ x: other.x + other.w, y: other.y + other.h });
        anchors.push({ x: other.x, y: other.y });
      }
      anchors.push({ x: 0, y: 0 });

      let bestPos = null, bestBottom = p.y + p.h;
      for (const anchor of anchors) {
        if (anchor.x < 0 || anchor.y < 0) continue;
        if (anchor.x + p.w > targetW) continue; // Respect target width
        if (anchor.y + p.h >= bestBottom) continue; // Must improve vertical position
        if (anchor.x === p.x && anchor.y === p.y) continue;
        const candidate = { idx: p.idx, x: anchor.x, y: anchor.y, w: p.w, h: p.h };
        if (!noOverlap(candidate, placed, p.idx)) continue;
        if (anchor.y + p.h < bestBottom) {
          bestBottom = anchor.y + p.h;
          bestPos = anchor;
        }
      }
      if (bestPos) {
        p.x = bestPos.x;
        p.y = bestPos.y;
        movedAny = true;
      }
    }
    if (!movedAny) break;

    // Re-run vertical compaction after moving items
    let vc = true;
    for (let vp = 0; vp < 20 && vc; vp++) {
      vc = false;
      placed.sort((a, b) => a.y - b.y || a.x - b.x);
      for (const p of placed) {
        let bestY = 0;
        for (const other of placed) {
          if (other.idx === p.idx) continue;
          if (p.x < other.x + other.w && p.x + p.w > other.x && other.y + other.h <= p.y) {
            bestY = Math.max(bestY, other.y + other.h);
          }
        }
        if (bestY < p.y && noOverlap({ ...p, y: bestY }, placed, p.idx)) {
          p.y = bestY; vc = true;
        }
      }
    }
  }

  // Phase 3: Gentle horizontal tightening — only slide items left to close
  // horizontal gaps, but never enough to change the overall aspect ratio significantly
  placed.sort((a, b) => a.x - b.x || a.y - b.y);
  for (const p of placed) {
    let bestX = 0;
    for (const other of placed) {
      if (other.idx === p.idx) continue;
      if (p.y < other.y + other.h && p.y + p.h > other.y && other.x + other.w <= p.x) {
        bestX = Math.max(bestX, other.x + other.w);
      }
    }
    if (bestX < p.x && noOverlap({ ...p, x: bestX }, placed, p.idx)) {
      p.x = bestX;
    }
  }

  // Final bounding box
  let finalW = 0, finalH = 0;
  for (const p of placed) {
    finalW = Math.max(finalW, p.x + p.w);
    finalH = Math.max(finalH, p.y + p.h);
  }
  bestResult = { placements: placed, usedW: finalW, usedH: finalH };

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

export function applyArrangeBySizeRow(units) {
  const n = units.length;
  if (n < 2) return;
  const gap = 100;

  // Sort by area (w * h) ascending — smallest first; tiebreak by element id (name proxy)
  units.sort((a, b) => {
    const areaA = a.b.w * a.b.h;
    const areaB = b.b.w * b.b.h;
    if (areaA !== areaB) return areaA - areaB;
    // Tiebreaker: compare by first element's id (alphabetical/numeric natural sort)
    const idA = (a.elements[0] && a.elements[0].id) || "";
    const idB = (b.elements[0] && b.elements[0].id) || "";
    return idA.localeCompare(idB, undefined, { numeric: true });
  });

  // Place in a row starting at the top-left of the original bounding box
  let groupMinX = Infinity, groupMinY = Infinity;
  units.forEach((unit) => {
    if (unit.b.x < groupMinX) groupMinX = unit.b.x;
    if (unit.b.y < groupMinY) groupMinY = unit.b.y;
  });

  let currentX = groupMinX;
  const anchorY = groupMinY;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const shiftX = currentX - unit.b.x;
    const shiftY = anchorY - unit.b.y;
    if (shiftX !== 0 || shiftY !== 0) translateUnit(unit, shiftX, shiftY);
    currentX += unit.b.w + gap;
  }

  showToast(`Arranged ${n} items by size in a row`);
}

export function applyArrangeByNameRow(units) {
  const n = units.length;
  if (n < 2) return;
  const gap = 100;

  // Sort by element id (natural alphanumeric order)
  units.sort((a, b) => {
    const idA = (a.elements[0] && a.elements[0].id) || "";
    const idB = (b.elements[0] && b.elements[0].id) || "";
    return idA.localeCompare(idB, undefined, { numeric: true });
  });

  // Place in a row starting at the top-left of the original bounding box
  let groupMinX = Infinity, groupMinY = Infinity;
  units.forEach((unit) => {
    if (unit.b.x < groupMinX) groupMinX = unit.b.x;
    if (unit.b.y < groupMinY) groupMinY = unit.b.y;
  });

  let currentX = groupMinX;
  const anchorY = groupMinY;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const shiftX = currentX - unit.b.x;
    const shiftY = anchorY - unit.b.y;
    if (shiftX !== 0 || shiftY !== 0) translateUnit(unit, shiftX, shiftY);
    currentX += unit.b.w + gap;
  }

  showToast(`Arranged ${n} items by name in a row`);
}
