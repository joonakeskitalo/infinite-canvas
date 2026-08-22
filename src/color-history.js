/**
 * Color History
 *
 * Tracks the last 10 selected colors. Persists to localStorage.
 * Renders as small squares in the secondary toolbar next to the color picker.
 */

import { showToast } from "./utils.js";

const STORAGE_KEY = "jiiris-color-history";
const MAX_HISTORY = 10;

/** @type {string[]} Array of hex color strings, most recent first */
let colorHistory = [];

/** Callback to apply a color from history */
let _onHistoryColorSelect = null;

/**
 * Inject the callback for when a history color is clicked.
 */
export function setColorHistoryDeps({ onColorSelect }) {
  _onHistoryColorSelect = onColorSelect;
}

// --- Persistence ---

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        colorHistory = parsed.filter((c) => typeof c === "string").slice(0, MAX_HISTORY);
      }
    }
  } catch (e) {
    console.warn("Failed to load color history:", e.message);
  }
}

function saveToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(colorHistory));
  } catch (e) {
    console.warn("Failed to save color history:", e.message);
  }
}

// --- Public API ---

/**
 * Push a color to the history. Deduplicates and keeps max 10 entries.
 */
export function pushColorToHistory(hex) {
  if (!hex || typeof hex !== "string") return;
  const normalized = hex.toLowerCase();
  // Remove duplicate if already in history
  colorHistory = colorHistory.filter((c) => c !== normalized);
  // Add to front
  colorHistory.unshift(normalized);
  // Trim to max
  if (colorHistory.length > MAX_HISTORY) {
    colorHistory = colorHistory.slice(0, MAX_HISTORY);
  }
  saveToStorage();
  renderColorHistory();
}

export function getColorHistory() {
  return colorHistory;
}

// --- UI ---

let _container = null;

/**
 * Initialize the color history UI. Call once after DOM is ready.
 */
export function initColorHistory() {
  loadFromStorage();
  _container = document.getElementById("color-history-list");
  if (!_container) return;
  renderColorHistory();
}

function renderColorHistory() {
  if (!_container) return;
  _container.innerHTML = "";

  colorHistory.forEach((hex) => {
    const swatch = document.createElement("div");
    swatch.className = "color-history-swatch";
    swatch.style.background = hex;
    swatch.title = hex.toUpperCase() + " — Click to select, Shift+click to copy hex";
    swatch.addEventListener("click", (e) => {
      if (e.shiftKey) {
        // Shift+click: copy hex to clipboard
        const upper = hex.toUpperCase();
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(upper).then(() => {
            showToast(`Copied: ${upper}`);
          }).catch(() => {});
        }
      } else {
        // Regular click: select color
        if (_onHistoryColorSelect) _onHistoryColorSelect(hex);
      }
    });
    _container.appendChild(swatch);
  });
}
