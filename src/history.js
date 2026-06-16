/**
 * Undo / Redo System
 */

import { state, CONSTANTS, getDom } from "./state.js";
import { serializeElement } from "./elements.js";
import { showToast } from "./utils.js";

// Forward declarations — set by main.js to break circular deps
let _render = null;
let _toggleAlignmentPanelVisibility = null;
let _scheduleSave = null;

export function setHistoryDeps({ render, toggleAlignmentPanelVisibility, scheduleSave }) {
  _render = render;
  _toggleAlignmentPanelVisibility = toggleAlignmentPanelVisibility;
  _scheduleSave = scheduleSave;
}

function captureState() {
  return {
    images: state.images.map((el) => serializeElement(el)),
    drawings: state.drawings.map((el) => serializeElement(el)),
  };
}

function restoreState(snapshot) {
  state.images = snapshot.images.map((el) => ({ ...el }));
  state.drawings = snapshot.drawings.map((el) => {
    const d = { ...el };
    if (d.type === "pen") d.points = el.points.map((p) => ({ ...p }));
    else if (d.start) d.start = { ...el.start };
    if (d.end) d.end = { ...el.end };
    if (d.type === "connector") {
      d.startConn = el.startConn ? { ...el.startConn } : null;
      d.endConn = el.endConn ? { ...el.endConn } : null;
    }
    return d;
  });
  state.selectedElements = [];
  if (_toggleAlignmentPanelVisibility) _toggleAlignmentPanelVisibility();
  if (_render) _render();
}

export function pushUndo() {
  state.undoStack.push(captureState());
  if (state.undoStack.length > CONSTANTS.MAX_HISTORY) state.undoStack.shift();
  state.redoStack = [];
  updateUndoRedoButtons();
  if (_scheduleSave) _scheduleSave();
}

export function undo() {
  if (state.undoStack.length === 0) return;
  if (state.cropMode) {
    state.cropMode = false;
    state.cropTarget = null;
    state.cropRect = null;
    state.cropDragEdge = null;
    state.cropDragStart = null;
  }
  state.redoStack.push(captureState());
  const snapshot = state.undoStack.pop();
  restoreState(snapshot);
  updateUndoRedoButtons();
  if (_scheduleSave) _scheduleSave();
  showToast("Undo");
}

export function redo() {
  if (state.redoStack.length === 0) return;
  if (state.cropMode) {
    state.cropMode = false;
    state.cropTarget = null;
    state.cropRect = null;
    state.cropDragEdge = null;
    state.cropDragStart = null;
  }
  state.undoStack.push(captureState());
  const snapshot = state.redoStack.pop();
  restoreState(snapshot);
  updateUndoRedoButtons();
  if (_scheduleSave) _scheduleSave();
  showToast("Redo");
}

export function updateUndoRedoButtons() {
  const undoBtn = document.getElementById("undo-btn");
  const redoBtn = document.getElementById("redo-btn");
  if (undoBtn) undoBtn.classList.toggle("disabled", state.undoStack.length === 0);
  if (redoBtn) redoBtn.classList.toggle("disabled", state.redoStack.length === 0);
}
