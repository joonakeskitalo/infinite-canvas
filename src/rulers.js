/**
 * Rulers & Guide Lines
 *
 * Ruler rendering, guide line management, and ruler event handling.
 */

import { state, CONSTANTS, getDom } from "./state.js";
import { showToast } from "./utils.js";
import { getShapeBounds } from "./elements.js";
import { addRenderCallback } from "./rendering.js";

const RULER_SIZE = CONSTANTS.RULER_SIZE;

let rulerTop, rulerLeft, rulerTopCtx, rulerLeftCtx, rulerCorner, toggleRulersBtn;
let guideLastClickTime = 0;
let guideLastClickIdx = -1;

export function initRulers() {
  rulerTop = document.getElementById("ruler-top");
  rulerLeft = document.getElementById("ruler-left");
  rulerTopCtx = rulerTop.getContext("2d");
  rulerLeftCtx = rulerLeft.getContext("2d");
  rulerCorner = document.getElementById("ruler-corner");
  toggleRulersBtn = document.getElementById("toggle-rulers-btn");

  toggleRulersBtn.addEventListener("click", () => {
    setRulersVisible(!state.rulersVisible);
  });

  rulerCorner.style.cursor = "pointer";
  rulerCorner.title = "Click: toggle guides · Shift+Click: remove all";
  rulerCorner.addEventListener("click", (e) => {
    e.stopPropagation();
    if (e.shiftKey) {
      state.guides = [];
      state.guidesVisible = true;
      renderGuides();
      showToast("All guides removed");
    } else {
      state.guidesVisible = !state.guidesVisible;
      renderGuides();
      showToast(state.guidesVisible ? "Guides visible" : "Guides hidden");
    }
  });

  rulerTop.addEventListener("mousedown", (e) => {
    e.preventDefault();
    state.draggingNewGuide = { axis: "y", startScreen: e.clientY };
    document.body.style.cursor = "ns-resize";
  });

  rulerLeft.addEventListener("mousedown", (e) => {
    e.preventDefault();
    state.draggingNewGuide = { axis: "x", startScreen: e.clientX };
    document.body.style.cursor = "ew-resize";
  });

  window.addEventListener("mousemove", handleRulerMouseMove);
  window.addEventListener("mouseup", handleRulerMouseUp);
}

function handleRulerMouseMove(e) {
  if (state.draggingNewGuide) {
    const axis = state.draggingNewGuide.axis;
    let pos = axis === "y" ? e.clientY : e.clientX;

    if (state.isShiftPressed) {
      const worldPos = axis === "y"
        ? (e.clientY - state.transform.y) / state.transform.zoom
        : (e.clientX - state.transform.x) / state.transform.zoom;
      const threshold = 8 / state.transform.zoom;
      const snapPositions = getGuideSnapPositions(axis);
      let bestDist = threshold;
      let snapped = worldPos;
      for (const sp of snapPositions) {
        const dist = Math.abs(worldPos - sp);
        if (dist < bestDist) { bestDist = dist; snapped = sp; }
      }
      if (axis === "y") { pos = snapped * state.transform.zoom + state.transform.y; }
      else { pos = snapped * state.transform.zoom + state.transform.x; }
    }

    let previewEl = document.getElementById("guide-preview");
    if (!previewEl) {
      previewEl = document.createElement("div");
      previewEl.id = "guide-preview";
      previewEl.style.position = "fixed";
      previewEl.style.zIndex = "9";
      previewEl.style.pointerEvents = "none";
      if (axis === "y") {
        previewEl.style.left = RULER_SIZE + "px";
        previewEl.style.width = `calc(100% - ${RULER_SIZE}px)`;
        previewEl.style.height = "1px";
        previewEl.style.background = "rgba(0, 180, 255, 0.5)";
      } else {
        previewEl.style.top = RULER_SIZE + "px";
        previewEl.style.height = `calc(100% - ${RULER_SIZE}px)`;
        previewEl.style.width = "1px";
        previewEl.style.background = "rgba(0, 180, 255, 0.5)";
      }
      document.body.appendChild(previewEl);
    }
    if (axis === "y") { previewEl.style.top = pos + "px"; }
    else { previewEl.style.left = pos + "px"; }
    state.draggingNewGuide.snappedPos = pos;
    return;
  }

  if (state.draggingGuide) {
    const guide = state.draggingGuide.guide;
    if (guide.axis === "x") {
      guide.position = (e.clientX - state.transform.x) / state.transform.zoom;
    } else {
      guide.position = (e.clientY - state.transform.y) / state.transform.zoom;
    }
    renderGuides();
  }
}

function handleRulerMouseUp(e) {
  if (state.draggingNewGuide) {
    const axis = state.draggingNewGuide.axis;
    const previewEl = document.getElementById("guide-preview");
    if (previewEl) previewEl.remove();

    const screenPos = state.draggingNewGuide.snappedPos != null
      ? state.draggingNewGuide.snappedPos
      : (axis === "y" ? e.clientY : e.clientX);

    if (axis === "y" && screenPos > RULER_SIZE + 5) {
      const worldY = (screenPos - state.transform.y) / state.transform.zoom;
      state.guides.push({ axis: "y", position: worldY });
      renderGuides();
    } else if (axis === "x" && screenPos > RULER_SIZE + 5) {
      const worldX = (screenPos - state.transform.x) / state.transform.zoom;
      state.guides.push({ axis: "x", position: worldX });
      renderGuides();
    }

    state.draggingNewGuide = null;
    document.body.style.cursor = "";
    return;
  }

  if (state.draggingGuide) {
    const guide = state.draggingGuide.guide;
    if (guide.axis === "x" && e.clientX <= RULER_SIZE) {
      const idx = state.guides.indexOf(guide);
      if (idx !== -1) state.guides.splice(idx, 1);
    } else if (guide.axis === "y" && e.clientY <= RULER_SIZE) {
      const idx = state.guides.indexOf(guide);
      if (idx !== -1) state.guides.splice(idx, 1);
    }
    state.draggingGuide = null;
    document.body.style.cursor = "";
    renderGuides();
  }
}

export function setRulersVisible(visible) {
  state.rulersVisible = visible;
  rulerTop.style.display = visible ? "" : "none";
  rulerLeft.style.display = visible ? "" : "none";
  rulerCorner.style.display = visible ? "" : "none";
  toggleRulersBtn.classList.toggle("active", visible);
  if (visible) {
    renderRulers();
    renderGuides();
  } else {
    document.querySelectorAll(".guide-line").forEach((el) => el.remove());
  }
}

export function resizeRulers() {
  if (!rulerTop) return;
  const topW = window.innerWidth - RULER_SIZE;
  const leftH = window.innerHeight - RULER_SIZE;
  rulerTop.width = topW; rulerTop.height = RULER_SIZE;
  rulerTop.style.width = topW + "px"; rulerTop.style.height = RULER_SIZE + "px";
  rulerLeft.width = RULER_SIZE; rulerLeft.height = leftH;
  rulerLeft.style.width = RULER_SIZE + "px"; rulerLeft.style.height = leftH + "px";
}

function isColorDark(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

function getRulerBackground(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  if (isColorDark(hex)) {
    return `rgba(${Math.min(255, r + 40)}, ${Math.min(255, g + 40)}, ${Math.min(255, b + 40)}, 0.92)`;
  } else {
    return `rgba(${Math.max(0, r - 30)}, ${Math.max(0, g - 30)}, ${Math.max(0, b - 30)}, 0.92)`;
  }
}

export function renderRulers() {
  if (!rulerTop) return;
  const transform = state.transform;
  const rulerBg = getRulerBackground(state.bgColor);
  const isDark = isColorDark(state.bgColor);
  const tickColor = isDark ? "#666" : "#aaa";
  const textColor = isDark ? "#999" : "#555";

  rulerCorner.style.background = rulerBg;

  const topW = rulerTop.width;
  const topH = rulerTop.height;
  rulerTopCtx.clearRect(0, 0, topW, topH);
  rulerTopCtx.fillStyle = rulerBg;
  rulerTopCtx.fillRect(0, 0, topW, topH);

  const baseStep = getTickStep(transform.zoom);
  const startWorldX = (0 - RULER_SIZE - transform.x) / transform.zoom;
  const endWorldX = (topW - transform.x) / transform.zoom;
  const firstTick = Math.floor(startWorldX / baseStep) * baseStep;

  rulerTopCtx.fillStyle = textColor;
  rulerTopCtx.strokeStyle = tickColor;
  rulerTopCtx.lineWidth = 1;
  rulerTopCtx.font = "9px sans-serif";
  rulerTopCtx.textAlign = "center";
  rulerTopCtx.textBaseline = "top";

  for (let wx = firstTick; wx <= endWorldX; wx += baseStep) {
    const sx = wx * transform.zoom + transform.x - RULER_SIZE;
    const isMajor = Math.round(wx / baseStep) % 5 === 0;
    const tickH = isMajor ? topH * 0.6 : topH * 0.3;
    rulerTopCtx.beginPath();
    rulerTopCtx.moveTo(sx, topH);
    rulerTopCtx.lineTo(sx, topH - tickH);
    rulerTopCtx.stroke();
    if (isMajor) rulerTopCtx.fillText(Math.round(wx).toString(), sx, 2);
  }

  const leftW = rulerLeft.width;
  const leftH = rulerLeft.height;
  rulerLeftCtx.clearRect(0, 0, leftW, leftH);
  rulerLeftCtx.fillStyle = rulerBg;
  rulerLeftCtx.fillRect(0, 0, leftW, leftH);

  const startWorldY = (0 - RULER_SIZE - transform.y) / transform.zoom;
  const endWorldY = (leftH - transform.y) / transform.zoom;
  const firstTickY = Math.floor(startWorldY / baseStep) * baseStep;

  rulerLeftCtx.fillStyle = textColor;
  rulerLeftCtx.strokeStyle = tickColor;
  rulerLeftCtx.lineWidth = 1;
  rulerLeftCtx.font = "9px sans-serif";
  rulerLeftCtx.textAlign = "center";
  rulerLeftCtx.textBaseline = "middle";

  for (let wy = firstTickY; wy <= endWorldY; wy += baseStep) {
    const sy = wy * transform.zoom + transform.y - RULER_SIZE;
    const isMajor = Math.round(wy / baseStep) % 5 === 0;
    const tickW = isMajor ? leftW * 0.6 : leftW * 0.3;
    rulerLeftCtx.beginPath();
    rulerLeftCtx.moveTo(leftW, sy);
    rulerLeftCtx.lineTo(leftW - tickW, sy);
    rulerLeftCtx.stroke();
    if (isMajor) {
      rulerLeftCtx.save();
      rulerLeftCtx.translate(8, sy);
      rulerLeftCtx.rotate(-Math.PI / 2);
      rulerLeftCtx.fillText(Math.round(wy).toString(), 0, 0);
      rulerLeftCtx.restore();
    }
  }
}

export function renderGuides() {
  document.querySelectorAll(".guide-line").forEach((el) => el.remove());
  rulerCorner.classList.toggle("guides-hidden", !state.guidesVisible);
  rulerCorner.classList.toggle("has-guides", state.guides.length > 0);
  if (!state.guidesVisible) return;

  state.guides.forEach((guide, idx) => {
    const div = document.createElement("div");
    div.className = `guide-line ${guide.axis === "x" ? "vertical" : "horizontal"}`;
    div.dataset.guideIdx = idx;

    if (guide.axis === "x") {
      const sx = guide.position * state.transform.zoom + state.transform.x;
      div.style.left = sx + "px";
    } else {
      const sy = guide.position * state.transform.zoom + state.transform.y;
      div.style.top = sy + "px";
    }

    div.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      const now = Date.now();
      if (now - guideLastClickTime < 400 && guideLastClickIdx === idx) {
        guideLastClickTime = 0; guideLastClickIdx = -1;
        state.guides.splice(idx, 1);
        renderGuides();
        return;
      }
      guideLastClickTime = now; guideLastClickIdx = idx;
      state.draggingGuide = { guide, startPos: guide.axis === "x" ? e.clientX : e.clientY };
      document.body.style.cursor = guide.axis === "x" ? "ew-resize" : "ns-resize";
    });

    // Allow trackpad panning to pass through guide lines
    div.addEventListener("wheel", (e) => {
      e.preventDefault();
      const { container } = getDom();
      container.dispatchEvent(new WheelEvent(e.type, {
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaZ: e.deltaZ,
        deltaMode: e.deltaMode,
        clientX: e.clientX,
        clientY: e.clientY,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        bubbles: true,
        cancelable: true,
      }));
    }, { passive: false });

    document.body.appendChild(div);
  });
}

export function getTickStep(zoom) {
  const targetScreenPx = 20;
  const worldPx = targetScreenPx / zoom;
  const magnitudes = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
  for (const m of magnitudes) {
    if (m >= worldPx) return m;
  }
  return 5000;
}

export function getGuideSnapPositions(axis) {
  const positions = [];
  const prop = axis === "y" ? "y" : "x";
  const sizeProp = axis === "y" ? "h" : "w";

  state.images.forEach((img) => {
    const pos = img[prop];
    const size = img[sizeProp];
    positions.push(pos, pos + size, pos + size / 2);
  });

  state.drawings.forEach((shape) => {
    const b = getShapeBounds(shape);
    const pos = b[prop];
    const size = b[sizeProp];
    positions.push(pos, pos + size, pos + size / 2);
  });

  return positions;
}

/**
 * Hook rulers into the render cycle. Call this after render to update rulers.
 */
export function hookRulersToRender() {
  if (state.rulersVisible) {
    addRenderCallback(() => {
      renderRulers();
      renderGuides();
    });
  }
}
