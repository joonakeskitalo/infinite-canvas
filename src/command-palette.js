/**
 * Command Palette
 *
 * Accessible via Shift+Space. Provides fuzzy-search access to all tools and export features.
 */

import { state } from "./state.js";
import { updateToolbarUI, updateCursor, toggleAlignmentPanelVisibility } from "./toolbar.js";
import { render, executePNGExport, executeJPEGExport } from "./rendering.js";
import { undo, redo } from "./history.js";
import { groupSelection, ungroupSelection, toggleLockSelection, selectAllElements, duplicateSelection } from "./selection.js";
import { saveFile, saveAs, openFile } from "./persistence.js";
import { showToast } from "./utils.js";
import { getCustomColors } from "./custom-colors.js";

let _render = null;
let paletteEl = null;
let inputEl = null;
let listEl = null;
let isOpen = false;
let selectedIndex = 0;
let filteredCommands = [];
let isKeyboardNavigating = false;

export function setCommandPaletteDeps({ render: renderFn }) {
  _render = renderFn;
}

/**
 * All available commands for the palette.
 * Each command has: id, label, shortcut (display), category, action
 */
function getCommands() {
  return [
    // --- Tools ---
    { id: "tool-pan", label: "Hand Tool", shortcut: "H", category: "Tools", action: () => switchTool("pan") },
    { id: "tool-select", label: "Select Tool", shortcut: "V", category: "Tools", action: () => switchTool("select") },
    { id: "tool-marquee", label: "Marquee Select", shortcut: "M", category: "Tools", action: () => switchTool("marquee") },
    { id: "tool-measure", label: "Measure Tool", shortcut: "Y", category: "Tools", action: () => switchTool("measure") },
    { id: "tool-split-line", label: "Split Line Tool", shortcut: "W", category: "Tools", action: () => switchTool("split-line") },
    { id: "tool-pen", label: "Pen Tool", shortcut: "B", category: "Tools", action: () => switchTool("pen") },
    { id: "tool-bezier-pen", label: "Vector Pen Tool", shortcut: "Q", category: "Tools", action: () => switchTool("bezier-pen") },
    { id: "tool-laser", label: "Laser Pointer", shortcut: "P", category: "Tools", action: () => switchTool("laser") },
    { id: "tool-line", label: "Line Tool", shortcut: "L", category: "Tools", action: () => switchTool("line") },
    { id: "tool-arrow", label: "Arrow Tool", shortcut: "A", category: "Tools", action: () => switchTool("arrow") },
    { id: "tool-connector", label: "Connector Arrow", shortcut: "C", category: "Tools", action: () => switchTool("connector") },
    { id: "tool-rect-border", label: "Rectangle Bordered", shortcut: "R", category: "Tools", action: () => switchTool("rect-border") },
    { id: "tool-rect-fill", label: "Rectangle Filled", shortcut: "F", category: "Tools", action: () => switchTool("rect-fill") },
    { id: "tool-text", label: "Text Tool", shortcut: "T", category: "Tools", action: () => switchTool("text") },
    { id: "tool-text-element", label: "Sticky Note Text", shortcut: "N", category: "Tools", action: () => switchTool("text-element") },
    { id: "tool-eraser", label: "Object Eraser", shortcut: "E", category: "Tools", action: () => switchTool("eraser") },
    { id: "tool-stamp", label: "Stamp Tool", shortcut: "S", category: "Tools", action: () => switchTool("stamp") },
    { id: "tool-contrast", label: "Contrast Checker", shortcut: "K", category: "Tools", action: () => switchTool("contrast") },
    { id: "tool-eyedropper", label: "Color Picker / Eyedropper", shortcut: "I", category: "Tools", action: () => switchTool("eyedropper") },
    { id: "tool-accessibility-preview", label: "Accessibility Preview", shortcut: "J", category: "Tools", action: () => switchTool("accessibility-preview") },

    // --- Export ---
    { id: "export-png-clipboard", label: "Export PNG to Clipboard", shortcut: "\u2318E", category: "Export", action: () => executePNGExport(1.0) },
    { id: "export-png-clipboard-half", label: "Export PNG to Clipboard (50%)", shortcut: "\u2325\u2318E", category: "Export", action: () => executePNGExport(0.5) },
    { id: "export-png-download", label: "Download PNG", shortcut: "\u21E7\u2318E", category: "Export", action: () => executePNGExport(1.0, { download: true }) },
    { id: "export-png-download-half", label: "Download PNG (50%)", shortcut: "", category: "Export", action: () => executePNGExport(0.5, { download: true }) },
    { id: "export-png-download-quarter", label: "Download PNG (25%)", shortcut: "", category: "Export", action: () => executePNGExport(0.25, { download: true }) },
    { id: "export-jpeg-download", label: "Download JPEG", shortcut: "\u21E7\u2318J", category: "Export", action: () => executeJPEGExport(1.0, { download: true }) },
    { id: "export-jpeg-download-half", label: "Download JPEG (50%)", shortcut: "", category: "Export", action: () => executeJPEGExport(0.5, { download: true }) },
    { id: "export-jpeg-download-quarter", label: "Download JPEG (25%)", shortcut: "", category: "Export", action: () => executeJPEGExport(0.25, { download: true }) },
    { id: "export-assets-zip", label: "Download Assets as ZIP", shortcut: "", category: "Export", action: () => document.getElementById("download-images-btn")?.click() },
    { id: "import-images", label: "Import Images", shortcut: "", category: "Export", action: () => document.getElementById("import-images-btn")?.click() },

    // --- File ---
    { id: "file-save", label: "Save", shortcut: "\u2318S", category: "File", action: () => saveFile() },
    { id: "file-save-as", label: "Save As", shortcut: "\u21E7\u2318S", category: "File", action: () => saveAs() },
    { id: "file-open", label: "Open", shortcut: "\u2318O", category: "File", action: () => openFile() },

    // --- Edit ---
    { id: "edit-undo", label: "Undo", shortcut: "\u2318Z", category: "Edit", action: () => undo() },
    { id: "edit-redo", label: "Redo", shortcut: "\u21E7\u2318Z", category: "Edit", action: () => redo() },
    { id: "edit-select-all", label: "Select All", shortcut: "\u2318A", category: "Edit", action: () => { selectAllElements(); render(); } },
    { id: "edit-duplicate", label: "Duplicate Selection", shortcut: "\u2318D", category: "Edit", action: () => { duplicateSelection(); } },
    { id: "edit-group", label: "Group", shortcut: "\u2318G", category: "Edit", action: () => { groupSelection(); render(); } },
    { id: "edit-ungroup", label: "Ungroup", shortcut: "\u21E7\u2318G", category: "Edit", action: () => { ungroupSelection(); render(); } },
    { id: "edit-lock", label: "Lock / Unlock Selection", shortcut: "\u2318L", category: "Edit", action: () => { toggleLockSelection(); render(); } },
    { id: "edit-copy-color-labels", label: "Copy Color Labels (Hex, RGB & Name)", shortcut: "", category: "Edit", action: () => copyColorLabels() },

    // --- View ---
    { id: "view-center", label: "Center View", shortcut: "", category: "View", action: () => document.getElementById("center-canvas-btn")?.click() },
    { id: "view-zoom-fit", label: "Zoom to Fit All", shortcut: "\u21E71", category: "View", action: () => zoomToFit() },
    { id: "view-zoom-reset", label: "Reset Zoom (100%)", shortcut: "\u23180", category: "View", action: () => resetZoom() },
    { id: "view-toggle-rulers", label: "Toggle Rulers", shortcut: "\u21E7R", category: "View", action: () => document.getElementById("toggle-rulers-btn")?.click() },
    { id: "view-toggle-grid", label: "Toggle Grid", shortcut: "", category: "View", action: () => document.getElementById("toggle-grid-item")?.click() },

    // --- Alignment ---
    { id: "align-left", label: "Align Left", shortcut: "\u2325A", category: "Alignment", action: () => clickAlignBtn("left") },
    { id: "align-right", label: "Align Right", shortcut: "\u2325D", category: "Alignment", action: () => clickAlignBtn("right") },
    { id: "align-center-h", label: "Align Center Horizontal", shortcut: "\u2325H", category: "Alignment", action: () => clickAlignBtn("centerX") },
    { id: "align-top", label: "Align Top", shortcut: "\u2325W", category: "Alignment", action: () => clickAlignBtn("top") },
    { id: "align-bottom", label: "Align Bottom", shortcut: "\u2325S", category: "Alignment", action: () => clickAlignBtn("bottom") },
    { id: "align-center-v", label: "Align Center Vertical", shortcut: "\u2325V", category: "Alignment", action: () => clickAlignBtn("centerY") },
    { id: "distribute-h", label: "Distribute Horizontally", shortcut: "\u2325\u21E7X", category: "Alignment", action: () => clickAlignBtn("distributeX") },
    { id: "distribute-v", label: "Distribute Vertically", shortcut: "\u2325\u21E7Y", category: "Alignment", action: () => clickAlignBtn("distributeY") },
    { id: "layout-row", label: "Arrange in Row", shortcut: "", category: "Alignment", action: () => clickAlignBtn("rowLayout") },
    { id: "layout-column", label: "Arrange in Column", shortcut: "", category: "Alignment", action: () => clickAlignBtn("columnLayout") },
    { id: "layout-grid", label: "Arrange in Grid", shortcut: "", category: "Alignment", action: () => clickAlignBtn("gridLayout") },
    { id: "layout-by-size", label: "Arrange by Size (Row)", shortcut: "", category: "Alignment", action: () => clickAlignBtn("arrangeBySizeRow") },
    { id: "layout-by-name", label: "Arrange by Name (Row)", shortcut: "", category: "Alignment", action: () => clickAlignBtn("arrangeByNameRow") },

    // --- Color Filters ---
    { id: "filter-none", label: "Filter: None (Original)", shortcut: "", category: "Filters", action: () => setFilter("none") },
    { id: "filter-protanomaly", label: "Filter: Protanomaly (Red-Green, weak red)", shortcut: "", category: "Filters", action: () => setFilter("protanomaly") },
    { id: "filter-protanopia", label: "Filter: Protanopia (Red-Green, no red)", shortcut: "", category: "Filters", action: () => setFilter("protanopia") },
    { id: "filter-deuteranomaly", label: "Filter: Deuteranomaly (Red-Green, weak green)", shortcut: "", category: "Filters", action: () => setFilter("deuteranomaly") },
    { id: "filter-deuteranopia", label: "Filter: Deuteranopia (Red-Green, no green)", shortcut: "", category: "Filters", action: () => setFilter("deuteranopia") },
    { id: "filter-tritanomaly", label: "Filter: Tritanomaly (Blue-Yellow, mild)", shortcut: "", category: "Filters", action: () => setFilter("tritanomaly") },
    { id: "filter-tritanopia", label: "Filter: Tritanopia (Blue-Yellow)", shortcut: "", category: "Filters", action: () => setFilter("tritanopia") },
    { id: "filter-achromatomaly", label: "Filter: Achromatomaly (Almost no color)", shortcut: "", category: "Filters", action: () => setFilter("achromatomaly") },
    { id: "filter-achromatopsia", label: "Filter: Achromatopsia (Grayscale / Total color blindness)", shortcut: "", category: "Filters", action: () => setFilter("achromatopsia") },
    { id: "filter-low-contrast", label: "Filter: Low Contrast", shortcut: "", category: "Filters", action: () => setFilter("low-contrast") },
    { id: "filter-high-contrast", label: "Filter: High Contrast", shortcut: "", category: "Filters", action: () => setFilter("high-contrast") },
    { id: "filter-low-quality", label: "Filter: Low Quality Display", shortcut: "", category: "Filters", action: () => setFilter("low-quality-display") },

    // --- Help ---
    { id: "help-shortcuts", label: "Help & Shortcuts", shortcut: "", category: "Help", action: () => document.getElementById("show-welcome-btn")?.click() },
    { id: "send-feedback", label: "Send Feedback", shortcut: "", category: "Help", action: () => document.getElementById("feedback-btn")?.click() },
  ];
}

function switchTool(toolId) {
  state.currentTool = toolId;
  if (toolId !== "select") state.selectedElements = [];
  updateToolbarUI();
  updateCursor();
  render();
}

function copyColorLabels() {
  // Find all text elements with bgColor (color picker labels inserted via shift-click)
  const colorLabels = state.drawings.filter((el) => el.type === "text" && el.bgColor);
  if (colorLabels.length === 0) {
    showToast("No color labels found on canvas");
    return;
  }
  const customColors = getCustomColors();
  const lines = colorLabels.map((el) => {
    const hex = el.bgColor.toUpperCase();
    // Parse hex to RGB
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const rgb = `rgb(${r}, ${g}, ${b})`;
    // Look up custom color label
    const match = customColors.find((c) => c.hex.toLowerCase() === hex.toLowerCase());
    const label = (match && match.label && match.label.toLowerCase() !== match.hex.toLowerCase())
      ? match.label : null;
    return label ? `${hex}  ${rgb}  ${label}` : `${hex}  ${rgb}`;
  });
  // Deduplicate
  const unique = [...new Set(lines)];
  const text = unique.join("\n");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast(`Copied ${unique.length} color label(s)`);
    }).catch(() => {});
  }
}

function clickAlignBtn(alignType) {
  const btn = document.querySelector(`.align-btn[data-align="${alignType}"]`);
  if (btn) {
    btn.click();
  } else {
    showToast("Select 2+ elements to align");
  }
}

function setFilter(value) {
  state.currentFilter = value;
  state.filteredImageCache = new WeakMap();
  const filterSelect = document.getElementById("filter-select");
  if (filterSelect) {
    filterSelect.value = value;
    filterSelect.classList.toggle("filter-active", value !== "none");
  }
  render();
  if (value !== "none") {
    const labels = { none: "Original", protanomaly: "Protanomaly (Red-Green, weak red)", protanopia: "Protanopia (Red-Green, no red)", deuteranomaly: "Deuteranomaly (Red-Green, weak green)", deuteranopia: "Deuteranopia (Red-Green, no green)", tritanomaly: "Tritanomaly (Blue-Yellow, mild)", tritanopia: "Tritanopia (Blue-Yellow)", achromatomaly: "Achromatomaly (Almost no color)", achromatopsia: "Achromatopsia (Grayscale)", "low-contrast": "Low contrast", "high-contrast": "High contrast", "low-quality-display": "Low quality display" };
    showToast(`Filter: ${labels[value] || value}`);
  } else {
    showToast("Filter removed");
  }
}

function zoomToFit() {
  const allElements = [...state.images, ...state.drawings];
  if (allElements.length === 0) { showToast("No elements on canvas"); return; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  allElements.forEach((el) => {
    const b = el.elementType === "image"
      ? { x: el.x, y: el.y, w: el.w, h: el.h }
      : { x: el.start?.x ?? el.x ?? 0, y: el.start?.y ?? el.y ?? 0, w: el.w ?? 0, h: el.h ?? 0 };
    if (el.elementType === "drawing") {
      // Use a rough bounds from start/end for drawings
      const sx = el.start?.x ?? 0, sy = el.start?.y ?? 0;
      const ex = el.end?.x ?? sx, ey = el.end?.y ?? sy;
      const lx = Math.min(sx, ex), ly = Math.min(sy, ey);
      const hx = Math.max(sx, ex), hy = Math.max(sy, ey);
      if (lx < minX) minX = lx; if (ly < minY) minY = ly;
      if (hx > maxX) maxX = hx; if (hy > maxY) maxY = hy;
    } else {
      if (b.x < minX) minX = b.x; if (b.y < minY) minY = b.y;
      if (b.x + b.w > maxX) maxX = b.x + b.w; if (b.y + b.h > maxY) maxY = b.y + b.h;
    }
  });
  const boundsW = maxX - minX;
  const boundsH = maxY - minY;
  if (boundsW <= 0 || boundsH <= 0) return;
  const canvas = document.getElementById("canvas");
  const padding = 60;
  const availW = canvas.width - padding * 2;
  const availH = canvas.height - padding * 2;
  const newZoom = Math.min(availW / boundsW, availH / boundsH, 12.0);
  state.transform.zoom = Math.max(0.05, Math.min(12.0, newZoom));
  state.transform.x = canvas.width / 2 - ((minX + maxX) / 2) * state.transform.zoom;
  state.transform.y = canvas.height / 2 - ((minY + maxY) / 2) * state.transform.zoom;
  render();
  showToast("Zoom to fit");
}

function resetZoom() {
  const canvas = document.getElementById("canvas");
  const centerWorldX = (canvas.width / 2 - state.transform.x) / state.transform.zoom;
  const centerWorldY = (canvas.height / 2 - state.transform.y) / state.transform.zoom;
  state.transform.zoom = 1.0;
  state.transform.x = canvas.width / 2 - centerWorldX;
  state.transform.y = canvas.height / 2 - centerWorldY;
  render();
  showToast("Zoom: 100%");
}

/**
 * Simple fuzzy match: checks if all characters of the query appear in order in the target.
 * Returns a score (lower is better) or -1 if no match.
 */
function fuzzyMatch(query, target) {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q.length === 0) return 0;

  let qi = 0;
  let score = 0;
  let lastMatchIdx = -1;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      // Bonus for consecutive matches
      score += (ti === lastMatchIdx + 1) ? 0 : (ti - (lastMatchIdx + 1));
      lastMatchIdx = ti;
      qi++;
    }
  }

  if (qi < q.length) return -1; // Not all characters matched
  return score;
}

function filterCommands(query) {
  const commands = getCommands();
  if (!query) return commands;

  const results = [];
  for (const cmd of commands) {
    const labelScore = fuzzyMatch(query, cmd.label);
    const catScore = fuzzyMatch(query, cmd.category);
    const score = labelScore >= 0 ? labelScore : (catScore >= 0 ? catScore + 100 : -1);
    if (score >= 0) {
      results.push({ ...cmd, _score: score });
    }
  }
  results.sort((a, b) => a._score - b._score);
  return results;
}

function highlightMatch(text, query) {
  if (!query) return escapeHtml(text);
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let result = "";
  for (let i = 0; i < text.length; i++) {
    if (qi < q.length && t[i] === q[qi]) {
      result += `<mark>${escapeHtml(text[i])}</mark>`;
      qi++;
    } else {
      result += escapeHtml(text[i]);
    }
  }
  return result;
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function updateSelection() {
  if (!listEl) return;
  const items = listEl.querySelectorAll(".cmd-palette-item");
  items.forEach((item, i) => {
    item.classList.toggle("selected", i === selectedIndex);
  });
  const selectedEl = listEl.querySelector(".cmd-palette-item.selected");
  if (selectedEl) selectedEl.scrollIntoView({ block: "nearest" });
}

function renderList() {
  if (!listEl) return;
  listEl.innerHTML = "";

  let currentCategory = "";
  filteredCommands.forEach((cmd, idx) => {
    // Category header
    if (cmd.category !== currentCategory) {
      currentCategory = cmd.category;
      const header = document.createElement("div");
      header.className = "cmd-palette-category";
      header.textContent = currentCategory;
      listEl.appendChild(header);
    }

    const item = document.createElement("div");
    item.className = "cmd-palette-item" + (idx === selectedIndex ? " selected" : "");
    item.dataset.index = idx;

    const labelSpan = document.createElement("span");
    labelSpan.className = "cmd-palette-item-label";
    labelSpan.innerHTML = highlightMatch(cmd.label, inputEl?.value || "");

    item.appendChild(labelSpan);

    if (cmd.shortcut) {
      const kbdSpan = document.createElement("span");
      kbdSpan.className = "cmd-palette-item-shortcut";
      kbdSpan.textContent = cmd.shortcut;
      item.appendChild(kbdSpan);
    }

    item.addEventListener("mouseenter", () => {
      if (isKeyboardNavigating) return;
      selectedIndex = idx;
      updateSelection();
    });

    item.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectedIndex = idx;
      executeSelected();
    });

    listEl.appendChild(item);
  });

  // Scroll selected into view
  const selectedEl = listEl.querySelector(".cmd-palette-item.selected");
  if (selectedEl) {
    selectedEl.scrollIntoView({ block: "nearest" });
  }
}

function executeSelected() {
  if (filteredCommands[selectedIndex]) {
    const cmd = filteredCommands[selectedIndex];
    close();
    cmd.action();
  }
}

export function open() {
  if (isOpen) return;
  isOpen = true;

  paletteEl = document.getElementById("command-palette");
  inputEl = document.getElementById("command-palette-input");
  listEl = document.getElementById("command-palette-list");

  if (!paletteEl || !inputEl || !listEl) return;

  paletteEl.style.display = "flex";
  inputEl.value = "";
  selectedIndex = 0;
  filteredCommands = filterCommands("");
  renderList();

  // Focus input after display
  requestAnimationFrame(() => inputEl.focus());
}

export function close() {
  if (!isOpen) return;
  isOpen = false;
  if (paletteEl) paletteEl.style.display = "none";
  if (inputEl) inputEl.value = "";
}

export function toggle() {
  if (isOpen) close();
  else open();
}

export function isCommandPaletteOpen() {
  return isOpen;
}

export function initCommandPalette() {
  paletteEl = document.getElementById("command-palette");
  inputEl = document.getElementById("command-palette-input");
  listEl = document.getElementById("command-palette-list");

  if (!paletteEl || !inputEl || !listEl) return;

  // Input filtering
  inputEl.addEventListener("input", () => {
    isKeyboardNavigating = true;
    selectedIndex = 0;
    filteredCommands = filterCommands(inputEl.value);
    renderList();
  });

  // Keyboard navigation within palette
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      isKeyboardNavigating = true;
      selectedIndex = selectedIndex >= filteredCommands.length - 1 ? 0 : selectedIndex + 1;
      updateSelection();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      isKeyboardNavigating = true;
      selectedIndex = selectedIndex <= 0 ? filteredCommands.length - 1 : selectedIndex - 1;
      updateSelection();
    } else if (e.key === "Enter") {
      e.preventDefault();
      executeSelected();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });

  // Reset keyboard navigation flag on actual mouse movement
  listEl.addEventListener("mousemove", () => {
    isKeyboardNavigating = false;
  });

  // Click outside to close
  paletteEl.addEventListener("mousedown", (e) => {
    if (e.target === paletteEl) {
      e.preventDefault();
      close();
    }
  });

  // Menu button to open palette
  const openBtn = document.getElementById("open-command-palette-btn");
  if (openBtn) {
    openBtn.addEventListener("click", () => {
      // Close the toolbar menu
      const toolbarMenu = document.getElementById("toolbar-menu");
      const toolbarMenuBtn = document.getElementById("toolbar-menu-btn");
      if (toolbarMenu) toolbarMenu.classList.remove("open");
      if (toolbarMenuBtn) toolbarMenuBtn.classList.remove("menu-open");
      open();
    });
  }
}
