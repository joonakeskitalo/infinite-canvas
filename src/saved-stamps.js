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

/** @type {Array<{name: string, clipboard: Array<Object>, sourceBounds: {x:number,y:number,w:number,h:number}, isDefault?: boolean}>} */
let savedStamps = [];

// --- Built-in device safe-area presets ---

const SAFE_AREA_COLOR = "#00e5ff";
const SAFE_AREA_WIDTH = 0.5;

/**
 * Build a stamp preset that outlines a device's safe area as a rectangle inset
 * from the image edges. Because stamps are applied as absolute pixel offsets
 * with no rescaling, the preset is sized to the device's NATIVE pixel resolution
 * so the outline lines up when stamped onto a full-size screenshot of that
 * device (screenshots are captured at native pixel resolution, not points).
 *
 * Dimensions and insets are given in logical points (or dp); `scale` converts
 * them to native pixels (e.g. @3x → scale 3). TV presets already use pixels, so
 * pass scale 1.
 *
 * @param {string} name
 * @param {number} w device width in points/dp
 * @param {number} h device height in points/dp
 * @param {{top:number,right:number,bottom:number,left:number}} insets safe-area insets in points/dp
 * @param {number} scale points→pixels scale factor
 */
function makeSafeAreaStamp(name, w, h, insets, scale) {
  const s = scale || 1;
  const pxW = w * s;
  const pxH = h * s;
  const rect = {
    elementType: "drawing",
    type: "rect-border",
    color: SAFE_AREA_COLOR,
    width: SAFE_AREA_WIDTH,
    dash: "solid",
    // Coordinates are pixel offsets from the image's displayed top-left corner.
    start: { x: insets.left * s, y: insets.top * s },
    end: { x: pxW - insets.right * s, y: pxH - insets.bottom * s },
  };
  return {
    name,
    clipboard: [rect],
    sourceBounds: { x: 0, y: 0, w: pxW, h: pxH },
    isDefault: true,
  };
}

/**
 * Common device safe areas at native pixel resolution. iOS insets are given in
 * points and scaled by the device scale factor; TV presets are already in px.
 * Values reflect widely used portrait safe-area insets for representative
 * devices.
 */
function buildDefaultStamps() {
  return [
    // iPhone 17 / 17 Pro (also 16 Pro) — 402×874 pt @3x → 1206×2622 px
    makeSafeAreaStamp("iPhone 17 / 17 Pro", 402, 874, { top: 62, right: 0, bottom: 34, left: 0 }, 3),
    // iPhone with Dynamic Island (15/16/15 Pro) — 393×852 pt @3x → 1179×2556 px
    makeSafeAreaStamp("iPhone (Dynamic Island)", 393, 852, { top: 59, right: 0, bottom: 34, left: 0 }, 3),
    // iPhone with notch (13/14) — 390×844 pt @3x → 1170×2532 px
    makeSafeAreaStamp("iPhone (Notch)", 390, 844, { top: 47, right: 0, bottom: 34, left: 0 }, 3),
    // iPhone with Home button (SE gen 2/3) — 375×667 pt @2x → 750×1334 px
    makeSafeAreaStamp("iPhone SE / Home Button", 375, 667, { top: 20, right: 0, bottom: 0, left: 0 }, 2),
    // Typical Android phone (Pixel-class) — 360×800 dp @3x → 1080×2400 px,
    // status bar 24dp + gesture nav bar 24dp
    makeSafeAreaStamp("Android Phone", 360, 800, { top: 24, right: 0, bottom: 24, left: 0 }, 3),
    // TV action-safe area (5% inset) — 1920×1080 px
    makeSafeAreaStamp("TV Action-Safe (1080p)", 1920, 1080, { top: 54, right: 96, bottom: 54, left: 96 }, 1),
    // TV title-safe area (10% inset) — 1920×1080 px
    makeSafeAreaStamp("TV Title-Safe (1080p)", 1920, 1080, { top: 108, right: 192, bottom: 108, left: 192 }, 1),
  ];
}

// Callback invoked after the live clipboard changes (e.g. on restore) so the
// caller can re-render. Set via setSavedStampsDeps.
let _onRestore = null;

export function setSavedStampsDeps({ onRestore }) {
  _onRestore = onRestore || null;
}

// --- Persistence (localStorage) ---

function loadFromStorage() {
  let userStamps = [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        userStamps = parsed.filter(
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

  // Seed built-in device safe-area presets. A user stamp of the same name takes
  // precedence, so users can override a default by saving over its name.
  const userNames = new Set(userStamps.map((s) => s.name.toLowerCase()));
  const defaults = buildDefaultStamps().filter((d) => !userNames.has(d.name.toLowerCase()));
  savedStamps = [...defaults, ...userStamps];
}

function saveToStorage() {
  try {
    // Never persist built-in defaults; they're re-seeded on load.
    const persistable = savedStamps.filter((s) => !s.isDefault);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistable));
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
  if (savedStamps[idx].isDefault) return false; // built-in defaults can't be deleted
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
      const entry = savedStamps.find((s) => s.name === name);
      if (entry && entry.isDefault) {
        showToast("Built-in safe-area stamps can't be deleted");
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
