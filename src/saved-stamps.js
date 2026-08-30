/**
 * Saved Stamps
 *
 * Persists named stamp-tool presets to localStorage and drives the stamp
 * toolbar panel (Save / Restore / Delete). Each preset stores the cloned stamp
 * clipboard (non-image elements positioned relative to the source image origin)
 * together with the source image bounds used when copying.
 *
 * Restoring a preset repopulates state.stampClipboard / state.stampSourceBounds
 * so it can be stamped onto images exactly like a freshly copied stamp.
 */

import { state } from "./state.js";
import { showToast } from "./utils.js";

const STORAGE_KEY = "jiiris-saved-stamps";

/** @type {Array<{name: string, clipboard: Array<Object>, sourceBounds: {x:number,y:number,w:number,h:number}}>} */
let savedStamps = [];

// Callback invoked after the live clipboard changes (e.g. on restore) so the
// caller can re-render. Set via setSavedStampsDeps.
let _onRestore = null;

export function setSavedStampsDeps({ onRestore }) {
  _onRestore = onRestore || null;
}

// --- Persistence (localStorage) ---

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        savedStamps = parsed.filter(
          (s) =>
            s &&
            typeof s.name === "string" &&
            Array.isArray(s.clipboard) &&
            s.sourceBounds &&
            typeof s.sourceBounds.w === "number" &&
            typeof s.sourceBounds.h === "number"
        );
      }
    }
  } catch (e) {
    console.warn("Failed to load saved stamps:", e.message);
  }
}

function saveToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedStamps));
  } catch (e) {
    console.warn("Failed to save stamps:", e.message);
  }
}

// --- Preset management ---

function saveStamp(name, clipboard, sourceBounds) {
  const trimmed = (name || "").trim();
  if (!trimmed) return false;
  if (!Array.isArray(clipboard) || clipboard.length === 0 || !sourceBounds) return false;

  // Deep-clone so later mutations of the live clipboard don't affect the preset.
  const preset = {
    name: trimmed,
    clipboard: JSON.parse(JSON.stringify(clipboard)),
    sourceBounds: { ...sourceBounds },
  };

  const existingIdx = savedStamps.findIndex(
    (s) => s.name.toLowerCase() === trimmed.toLowerCase()
  );
  if (existingIdx >= 0) savedStamps[existingIdx] = preset;
  else savedStamps.push(preset);

  saveToStorage();
  return true;
}

function removeStampByName(name) {
  const idx = savedStamps.findIndex((s) => s.name === name);
  if (idx < 0) return false;
  savedStamps.splice(idx, 1);
  saveToStorage();
  return true;
}

function getStampPreset(name) {
  const preset = savedStamps.find((s) => s.name === name);
  if (!preset) return null;
  return {
    clipboard: JSON.parse(JSON.stringify(preset.clipboard)),
    sourceBounds: { ...preset.sourceBounds },
  };
}

// --- DOM elements ---

let _statusLabel = null;
let _saveBtn = null;
let _restoreSelect = null;
let _deleteBtn = null;

/**
 * Refresh the status label with the current live clipboard size. Called on tool
 * switch and after copy/restore so the panel reflects the current stamp.
 */
export function updateStampPanel() {
  if (!_statusLabel) return;
  const count = state.stampClipboard ? state.stampClipboard.length : 0;
  _statusLabel.textContent = count > 0
    ? `${count} element${count > 1 ? "s" : ""} ready`
    : "Empty — Shift+Click an image";
}

function refreshRestoreOptions() {
  if (!_restoreSelect) return;
  const prev = _restoreSelect.value;
  _restoreSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = savedStamps.length ? "Restore saved…" : "No saved stamps";
  _restoreSelect.appendChild(placeholder);
  savedStamps.forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s.name;
    opt.textContent = `${s.name} (${s.clipboard.length})`;
    _restoreSelect.appendChild(opt);
  });
  // Keep the previous selection if it still exists, else reset to placeholder.
  if (savedStamps.some((s) => s.name === prev)) _restoreSelect.value = prev;
  else _restoreSelect.value = "";
}

// --- Save dialog (prompt for a name) ---

function openSaveDialog() {
  if (!state.stampClipboard || state.stampClipboard.length === 0 || !state.stampSourceBounds) {
    showToast("No stamp to save — Shift+Click an image to copy a stamp first");
    return;
  }

  const existing = document.getElementById("saved-stamp-dialog");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "saved-stamp-dialog";
  overlay.className = "custom-color-dialog-overlay";
  const count = state.stampClipboard.length;
  overlay.innerHTML = `
    <div class="custom-color-dialog">
      <h3 class="custom-color-dialog-title">Save Stamp</h3>
      <div class="custom-color-dialog-row">
        <label>Name</label>
        <input type="text" class="custom-color-dialog-label saved-stamp-name" placeholder="e.g. Rule of Thirds" spellcheck="false" />
      </div>
      <p class="custom-color-dialog-hint">${count} element${count > 1 ? "s" : ""} will be saved.</p>
      <div class="custom-color-dialog-actions">
        <button class="custom-color-dialog-cancel">Cancel</button>
        <button class="custom-color-dialog-confirm">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const nameInput = overlay.querySelector(".saved-stamp-name");
  const cancelBtn = overlay.querySelector(".custom-color-dialog-cancel");
  const confirmBtn = overlay.querySelector(".custom-color-dialog-confirm");

  const close = () => overlay.remove();
  const confirm = () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.style.borderColor = "#ff4444";
      return;
    }
    if (saveStamp(name, state.stampClipboard, state.stampSourceBounds)) {
      showToast(`Saved stamp "${name}"`);
      refreshRestoreOptions();
      if (_restoreSelect) _restoreSelect.value = name;
      close();
    }
  };

  cancelBtn.addEventListener("click", close);
  confirmBtn.addEventListener("click", confirm);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") confirm();
    else if (e.key === "Escape") close();
  });

  setTimeout(() => nameInput.focus(), 50);
}

// --- Init & wiring ---

export function initSavedStamps() {
  loadFromStorage();

  _statusLabel = document.getElementById("stamp-status-label");
  _saveBtn = document.getElementById("stamp-save-btn");
  _restoreSelect = document.getElementById("stamp-restore-select");
  _deleteBtn = document.getElementById("stamp-delete-btn");

  if (_saveBtn) {
    _saveBtn.addEventListener("click", openSaveDialog);
  }

  if (_restoreSelect) {
    _restoreSelect.addEventListener("change", () => {
      const name = _restoreSelect.value;
      // Release focus from the <select> so canvas keyboard shortcuts work again
      // immediately after picking a stamp (keydown handlers ignore events whose
      // target is a SELECT element).
      _restoreSelect.blur();
      if (!name) return;
      const preset = getStampPreset(name);
      if (preset) {
        state.stampClipboard = preset.clipboard;
        state.stampSourceBounds = preset.sourceBounds;
        state.stampPreview = null;
        showToast(`Restored stamp "${name}"`);
        updateStampPanel();
        if (_onRestore) _onRestore();
      }
    });
  }

  if (_deleteBtn) {
    _deleteBtn.addEventListener("click", () => {
      const name = _restoreSelect ? _restoreSelect.value : "";
      if (!name) {
        showToast("Select a saved stamp to delete");
        return;
      }
      if (removeStampByName(name)) {
        showToast(`Deleted stamp "${name}"`);
        refreshRestoreOptions();
      }
    });
  }

  refreshRestoreOptions();
  updateStampPanel();
}
