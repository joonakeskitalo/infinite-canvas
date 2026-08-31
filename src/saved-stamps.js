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

const SAFE_AREA_COLOR = "#ff2d94"; // vivid pink, visible on light and dark backgrounds
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

// Apple Human Interface Guidelines layout metrics (points, portrait).
// Note: statusBar height is device-specific (44pt on notch devices, 54pt on
// Dynamic Island devices, 20pt on Home-button devices) and is passed per preset.
const HIG_METRICS = {
  navBar: 44,          // standard (thin) navigation bar height (below status bar)
  largeTitleNav: 96,   // large-title navigation bar total height (below status bar)
  tabBar: 49,          // tab bar height (above home indicator)
  homeIndicator: 34,   // home indicator height
  sideMargin: 16,      // default layout side margin
};

const HIG_COLOR = SAFE_AREA_COLOR; // same cyan as safe-area stamps

function higLine(x1, y1, x2, y2, groupId) {
  return {
    elementType: "drawing",
    type: "line",
    color: HIG_COLOR,
    width: SAFE_AREA_WIDTH,
    dash: "dashed",
    groupId,
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
  };
}

/**
 * Build a stamp that marks the standard Apple HIG layout zones for a device:
 * full-width horizontal guides at the bottom edge of each top bar (status bar,
 * thin nav bar, large-title nav bar) and the top edge of each bottom element
 * (tab bar, home indicator), plus vertical side-margin guides. All metrics are
 * in points, scaled to the device's native pixel resolution.
 *
 * The status bar height is device-specific, so it's passed in explicitly
 * (44pt notch, 54pt Dynamic Island, 20pt Home button). The nav bar and large
 * title bar are measured relative to the bottom of the status bar.
 *
 * @param {string} name
 * @param {number} w device width in points
 * @param {number} h device height in points
 * @param {number} scale points→pixels scale factor
 * @param {number} statusBar status bar height in points
 */
function makeLayoutGuideStamp(name, w, h, scale, statusBar) {
  const s = scale || 1;
  const pxW = w * s;
  const pxH = h * s;
  const m = HIG_METRICS;
  const sb = statusBar;
  const g = "group_hig_" + name.replace(/\s+/g, "_");
  const lines = [
    // Top-anchored horizontal guides (bottom edge of each top bar)
    higLine(0, sb * s, pxW, sb * s, g),                                    // status bar bottom
    higLine(0, (sb + m.navBar) * s, pxW, (sb + m.navBar) * s, g),          // thin nav bar bottom
    higLine(0, (sb + m.largeTitleNav) * s, pxW, (sb + m.largeTitleNav) * s, g), // large-title nav bar bottom
    // Bottom-anchored horizontal guides (top edge of each bottom element)
    higLine(0, pxH - m.homeIndicator * s, pxW, pxH - m.homeIndicator * s, g),          // home indicator top
    higLine(0, pxH - (m.homeIndicator + m.tabBar) * s, pxW, pxH - (m.homeIndicator + m.tabBar) * s, g), // tab bar top
    // Side layout margins
    higLine(m.sideMargin * s, 0, m.sideMargin * s, pxH, g),                            // left margin
    higLine(pxW - m.sideMargin * s, 0, pxW - m.sideMargin * s, pxH, g),                // right margin
  ];
  return {
    name,
    clipboard: lines,
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
    // iPhone 15 / 16 (15 Pro) — 393×852 pt @3x → 1179×2556 px
    makeSafeAreaStamp("iPhone 15 / 16", 393, 852, { top: 59, right: 0, bottom: 34, left: 0 }, 3),
    // iPhone with notch (13/14) — 390×844 pt @3x → 1170×2532 px
    makeSafeAreaStamp("iPhone (Notch)", 390, 844, { top: 47, right: 0, bottom: 34, left: 0 }, 3),
    // iPhone mini (13 mini / 12 mini) — 375×812 pt, native scale 2.88 → 1080×2340 px
    makeSafeAreaStamp("iPhone mini (13/12 mini)", 375, 812, { top: 50, right: 0, bottom: 34, left: 0 }, 2.88),
    // iPhone with Home button (SE gen 2/3) — 375×667 pt @2x → 750×1334 px
    makeSafeAreaStamp("iPhone SE / Home Button", 375, 667, { top: 20, right: 0, bottom: 0, left: 0 }, 2),
    // Typical Android phone (Pixel-class) — 360×800 dp @3x → 1080×2400 px,
    // status bar 24dp + gesture nav bar 24dp
    makeSafeAreaStamp("Android Phone", 360, 800, { top: 24, right: 0, bottom: 24, left: 0 }, 3),
    // Google Pixel 9 — 1080×2424 px, status bar + gesture nav ~24dp @3x (72 px)
    makeSafeAreaStamp("Pixel 9", 1080, 2424, { top: 72, right: 0, bottom: 72, left: 0 }, 1),
    // Google Pixel 8 — 1080×2400 px
    makeSafeAreaStamp("Pixel 8", 1080, 2400, { top: 72, right: 0, bottom: 72, left: 0 }, 1),
    // Samsung Galaxy S24 — 1080×2340 px
    makeSafeAreaStamp("Samsung Galaxy S24", 1080, 2340, { top: 72, right: 0, bottom: 72, left: 0 }, 1),
    // Samsung Galaxy S24 Ultra — 1440×3120 px (~4x density → ~96 px bars)
    makeSafeAreaStamp("Samsung Galaxy S24 Ultra", 1440, 3120, { top: 96, right: 0, bottom: 96, left: 0 }, 1),
    // TV action-safe area (5% inset) — 1920×1080 px
    makeSafeAreaStamp("TV Action-Safe (1080p)", 1920, 1080, { top: 54, right: 96, bottom: 54, left: 96 }, 1),
    // TV title-safe area (10% inset) — 1920×1080 px
    makeSafeAreaStamp("TV Title-Safe (1080p)", 1920, 1080, { top: 108, right: 192, bottom: 108, left: 192 }, 1),
    // Apple HIG layout guides (status/nav/tab bars, home indicator, side margins).
    // These reflect the classic fixed bar heights (pre-iOS 26). Under iOS 26's
    // Liquid Glass, nav/tab bars float and resize dynamically, so treat these as
    // approximate reserved zones. Dynamic Island devices use a 54pt status bar.
    // iPhone 17 / 17 Pro (16 Pro) — 402×874 pt @3x
    makeLayoutGuideStamp("iPhone HIG Guides (17/17 Pro, classic bars)", 402, 874, 3, 54),
    // iPhone 15 / 16 — 393×852 pt @3x
    makeLayoutGuideStamp("iPhone HIG Guides (15/16, classic bars)", 393, 852, 3, 54),
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
let _restoreInput = null;
let _restoreList = null;
let _deleteBtn = null;
let _modeOptions = null; // NodeList of segmented toggle buttons

/**
 * Reflect the current stamp mode ("copy" / "paste") on the segmented toggle by
 * highlighting the active option.
 */
export function updateStampModeButton() {
  if (!_modeOptions) return;
  _modeOptions.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === state.stampMode);
  });
}

/**
 * Refresh the status label with the current live clipboard size. Called on tool
 * switch and after copy/restore so the panel reflects the current stamp.
 */
/**
 * Clear the restore input so no saved stamp / preset appears selected. Called
 * after copying a fresh (unsaved) stamp, since the live clipboard is no longer
 * the previously restored preset.
 */
export function clearRestoreSelection() {
  if (_restoreInput) _restoreInput.value = "";
  updateStampActionButtons();
}

/**
 * Enable/disable the Save and Delete buttons to reflect what's currently
 * possible:
 *  - Save   is available when there's a stamp in the clipboard AND a non-empty
 *           name is typed that isn't a built-in preset.
 *  - Delete is available when the typed name matches an existing, deletable
 *           (non-built-in) saved stamp.
 * Tooltips are updated to explain why an action is unavailable.
 */
function updateStampActionButtons() {
  const name = _restoreInput ? _restoreInput.value.trim() : "";
  const hasClipboard = !!(state.stampClipboard && state.stampClipboard.length > 0);
  const match = name ? savedStamps.find((s) => s.name.toLowerCase() === name.toLowerCase()) : null;

  if (_saveBtn) {
    const canSave = hasClipboard && !!name && !(match && match.isDefault);
    _saveBtn.disabled = !canSave;
    _saveBtn.title = !hasClipboard
      ? "Copy a stamp first, then type a name to save it"
      : !name
      ? "Type a name in the field to save the current stamp"
      : match && match.isDefault
      ? "That name is a built-in stamp — choose a different name"
      : match
      ? `Overwrite saved stamp "${match.name}" with the current stamp`
      : `Save the current stamp as "${name}"`;
  }

  if (_deleteBtn) {
    const canDelete = !!match && !match.isDefault;
    _deleteBtn.disabled = !canDelete;
    _deleteBtn.title = !name
      ? "Pick or type a saved stamp name to delete it"
      : !match
      ? `No saved stamp named "${name}"`
      : match.isDefault
      ? "Built-in stamps can't be deleted"
      : `Delete saved stamp "${match.name}"`;
  }
}

export function updateStampPanel() {
  updateStampModeButton();
  updateStampActionButtons();
  if (!_statusLabel) return;
  const count = state.stampClipboard ? state.stampClipboard.length : 0;
  _statusLabel.textContent = count > 0
    ? `${count} element${count > 1 ? "s" : ""} ready`
    : "Empty — copy a stamp first";
}

function refreshRestoreOptions() {
  if (!_restoreList) return;
  _restoreList.innerHTML = "";
  savedStamps.forEach((s) => {
    const opt = document.createElement("option");
    // Only set the value (the stamp name). Setting a differing label makes
    // browsers render a secondary line, which we don't want.
    opt.value = s.name;
    _restoreList.appendChild(opt);
  });
}

/**
 * Restore a stamp by name (case-insensitive). Returns true if a matching stamp
 * was found and applied.
 */
function restoreStampByName(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return false;
  const match = savedStamps.find((s) => s.name.toLowerCase() === trimmed.toLowerCase());
  if (!match) return false;
  const preset = getStampPreset(match.name);
  if (!preset) return false;
  state.stampClipboard = preset.clipboard;
  state.stampSourceBounds = preset.sourceBounds;
  state.stampPreview = null;
  showToast(`Restored stamp "${match.name}"`);
  updateStampPanel();
  if (_onRestore) _onRestore();
  return true;
}

// --- Save current stamp under the name typed in the restore/name input ---

function saveCurrentStamp() {
  if (!state.stampClipboard || state.stampClipboard.length === 0 || !state.stampSourceBounds) {
    showToast("No stamp to save — copy a stamp first");
    return;
  }
  const name = _restoreInput ? _restoreInput.value.trim() : "";
  if (!name) {
    showToast("Type a name in the field, then Save");
    if (_restoreInput) _restoreInput.focus();
    return;
  }
  const existing = savedStamps.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (existing && existing.isDefault) {
    showToast("That name is a built-in stamp — choose a different name");
    return;
  }
  if (saveStamp(name, state.stampClipboard, state.stampSourceBounds)) {
    showToast(`Saved stamp "${name}"`);
    refreshRestoreOptions();
    if (_restoreInput) _restoreInput.value = name;
    updateStampActionButtons();
  }
}

// --- Init & wiring ---

export function initSavedStamps() {
  loadFromStorage();

  _statusLabel = document.getElementById("stamp-status-label");
  _saveBtn = document.getElementById("stamp-save-btn");
  _restoreInput = document.getElementById("stamp-restore-input");
  _restoreList = document.getElementById("stamp-restore-list");
  _deleteBtn = document.getElementById("stamp-delete-btn");
  _modeOptions = document.querySelectorAll("#stamp-mode-toggle .stamp-mode-option");

  if (_saveBtn) {
    _saveBtn.addEventListener("click", saveCurrentStamp);
  }

  if (_modeOptions && _modeOptions.length) {
    _modeOptions.forEach((btn) => {
      btn.addEventListener("click", () => {
        state.stampMode = btn.dataset.mode === "copy" ? "copy" : "paste";
        state.stampPreview = null;
        updateStampModeButton();
        btn.blur();
        if (_onRestore) _onRestore();
      });
    });
  }

  if (_restoreInput) {
    // Text shown before focusing, temporarily cleared on focus so the full
    // datalist (not just the single matching entry) is shown. Restored on blur
    // if the user didn't pick anything. null means "nothing stashed".
    let _stashedValue = null;

    // Restore when a datalist option is chosen. Picking from a datalist fires an
    // "input" event with the option's value; typing then pressing Enter should
    // also restore. We resolve the typed/selected text to a stamp by name.
    const tryRestore = () => {
      const name = _restoreInput.value.trim();
      const match = savedStamps.find((s) => s.name.toLowerCase() === name.toLowerCase());
      if (match && restoreStampByName(match.name)) {
        // A selection was made — drop the stashed value so blur won't override
        // it, and keep the selected stamp's name (normalized) in the field.
        _stashedValue = null;
        _restoreInput.value = match.name;
        // Release focus so canvas keyboard shortcuts work again immediately
        // (keydown handlers ignore events whose target is an INPUT element).
        _restoreInput.blur();
      }
    };

    _restoreInput.addEventListener("focus", () => {
      // Temporarily clear so the browser shows the full list of options.
      _stashedValue = _restoreInput.value;
      _restoreInput.value = "";
      updateStampActionButtons();
    });
    _restoreInput.addEventListener("blur", () => {
      // If the user left without selecting, put the original text back.
      if (_stashedValue !== null) {
        if (_restoreInput.value.trim() === "") _restoreInput.value = _stashedValue;
        _stashedValue = null;
      }
      updateStampActionButtons();
    });

    _restoreInput.addEventListener("input", (e) => {
      // Keep Save/Delete availability in sync as the name changes.
      updateStampActionButtons();
      // Only auto-restore when the value was set by picking a datalist option,
      // NOT while the user is typing (which would clobber a name they're
      // entering to save). Datalist selections fire an input event with
      // inputType "insertReplacementText" (Chromium) or a null/empty inputType
      // (Safari); ordinary typing/deleting uses inputType like "insertText".
      const it = e.inputType;
      const isDatalistPick = it === "insertReplacementText" || it == null || it === "";
      if (!isDatalistPick) return;
      const name = _restoreInput.value.trim();
      if (savedStamps.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
        tryRestore();
      }
    });
    _restoreInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        tryRestore();
      } else if (e.key === "Escape") {
        e.preventDefault();
        // Blur the field; the blur handler restores the stashed value if empty
        // and releases focus so canvas keyboard shortcuts work again.
        _restoreInput.blur();
      }
    });
  }

  if (_deleteBtn) {
    _deleteBtn.addEventListener("click", () => {
      const name = _restoreInput ? _restoreInput.value.trim() : "";
      if (!name) {
        showToast("Type or pick a saved stamp to delete");
        return;
      }
      const entry = savedStamps.find((s) => s.name.toLowerCase() === name.toLowerCase());
      if (!entry) {
        showToast(`No saved stamp named "${name}"`);
        return;
      }
      if (entry.isDefault) {
        showToast("Built-in safe-area stamps can't be deleted");
        return;
      }
      if (removeStampByName(entry.name)) {
        _restoreInput.value = "";
        showToast(`Deleted stamp "${entry.name}"`);
        refreshRestoreOptions();
        updateStampActionButtons();
      }
    });
  }

  refreshRestoreOptions();
  updateStampPanel();
}
