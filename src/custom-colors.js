/**
 * Custom Color Palette
 *
 * Manages user-defined colors with labels. Supports add/edit/delete,
 * JSON import/export, and persists to localStorage.
 */

const STORAGE_KEY = "jiiris-custom-colors";

/** @type {Array<{hex: string, label: string}>} */
let customColors = [];

/** Forward-bound render callback set via setCustomColorsDeps */
let _onColorSelect = null;

/**
 * Inject callbacks for color selection. Called from interaction.js or main.js.
 */
export function setCustomColorsDeps({ onColorSelect }) {
  _onColorSelect = onColorSelect;
}

// --- Persistence (localStorage) ---

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        customColors = parsed.filter(
          (c) => c && typeof c.hex === "string" && typeof c.label === "string"
        );
      }
    }
  } catch (e) {
    console.warn("Failed to load custom colors:", e.message);
  }
}

function saveToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(customColors));
  } catch (e) {
    console.warn("Failed to save custom colors:", e.message);
  }
}

// --- Public API ---

export function getCustomColors() {
  return customColors;
}

export function addCustomColor(hex, label) {
  const normalized = normalizeHex(hex);
  if (!normalized) return false;
  customColors.push({ hex: normalized, label: label.trim() || normalized });
  saveToStorage();
  renderCustomColorsList();
  return true;
}

export function updateCustomColor(index, hex, label) {
  if (index < 0 || index >= customColors.length) return false;
  const normalized = normalizeHex(hex);
  if (!normalized) return false;
  customColors[index] = { hex: normalized, label: label.trim() || normalized };
  saveToStorage();
  renderCustomColorsList();
  return true;
}

export function removeCustomColor(index) {
  if (index < 0 || index >= customColors.length) return false;
  customColors.splice(index, 1);
  saveToStorage();
  renderCustomColorsList();
  return true;
}

export function importColorsFromJSON(jsonString) {
  try {
    const data = JSON.parse(jsonString);
    const entries = Array.isArray(data) ? data : [];
    let imported = 0;
    for (const entry of entries) {
      if (entry && typeof entry.hex === "string") {
        const hex = normalizeHex(entry.hex);
        if (hex) {
          customColors.push({ hex, label: (entry.label || hex).trim() });
          imported++;
        }
      }
    }
    if (imported > 0) {
      saveToStorage();
      renderCustomColorsList();
    }
    return imported;
  } catch (e) {
    console.warn("Failed to import colors:", e.message);
    return -1;
  }
}

export function exportColorsToJSON() {
  return JSON.stringify(customColors, null, 2);
}

// --- Helpers ---

function normalizeHex(hex) {
  if (!hex || typeof hex !== "string") return null;
  let h = hex.trim();
  if (!h.startsWith("#")) h = "#" + h;
  // Support 3-char shorthand
  if (/^#[0-9a-fA-F]{3}$/.test(h)) {
    h = "#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  }
  if (/^#[0-9a-fA-F]{6}$/.test(h)) return h.toLowerCase();
  return null;
}

// --- UI Rendering ---

let _listContainer = null;
let _editingIndex = -1;

/**
 * Initialize the custom colors panel. Call once after DOM is ready.
 */
export function initCustomColors() {
  loadFromStorage();

  _listContainer = document.getElementById("custom-colors-list");
  if (!_listContainer) return;

  // Add color button
  const addBtn = document.getElementById("custom-color-add-btn");
  if (addBtn) {
    addBtn.addEventListener("click", () => openAddDialog());
  }

  // Import button
  const importBtn = document.getElementById("custom-color-import-btn");
  if (importBtn) {
    importBtn.addEventListener("click", () => openImportDialog());
  }

  // Export button
  const exportBtn = document.getElementById("custom-color-export-btn");
  if (exportBtn) {
    exportBtn.addEventListener("click", () => doExport());
  }

  renderCustomColorsList();
}

function renderCustomColorsList() {
  if (!_listContainer) return;
  _listContainer.innerHTML = "";

  if (customColors.length === 0) {
    const empty = document.createElement("div");
    empty.className = "custom-colors-empty";
    empty.textContent = "No custom colors yet";
    _listContainer.appendChild(empty);
    return;
  }

  customColors.forEach((color, index) => {
    const item = document.createElement("div");
    item.className = "custom-color-item";
    item.title = `${color.label} (${color.hex}) — Click to select, right-click to edit`;

    const swatch = document.createElement("div");
    swatch.className = "custom-color-swatch";
    swatch.style.background = color.hex;

    const label = document.createElement("span");
    label.className = "custom-color-label";
    label.textContent = color.label;

    const hexSpan = document.createElement("span");
    hexSpan.className = "custom-color-hex";
    hexSpan.textContent = color.hex;

    const editBtn = document.createElement("button");
    editBtn.className = "custom-color-edit-btn";
    editBtn.innerHTML = "&#9998;"; // pencil
    editBtn.title = "Edit";
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openEditDialog(index);
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "custom-color-delete-btn";
    deleteBtn.innerHTML = "&times;";
    deleteBtn.title = "Delete";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeCustomColor(index);
    });

    item.appendChild(swatch);
    item.appendChild(label);
    item.appendChild(hexSpan);
    item.appendChild(editBtn);
    item.appendChild(deleteBtn);

    // Click to select this color
    item.addEventListener("click", () => {
      if (_onColorSelect) _onColorSelect(color.hex, color.label);
    });

    _listContainer.appendChild(item);
  });
}

// --- Dialogs ---

function openAddDialog() {
  showColorDialog("Add Custom Color", "#ff0000", "", (hex, label) => {
    addCustomColor(hex, label);
  });
}

function openEditDialog(index) {
  const color = customColors[index];
  if (!color) return;
  showColorDialog("Edit Color", color.hex, color.label, (hex, label) => {
    updateCustomColor(index, hex, label);
  });
}

function showColorDialog(title, initialHex, initialLabel, onConfirm) {
  // Remove any existing dialog
  const existing = document.getElementById("custom-color-dialog");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "custom-color-dialog";
  overlay.className = "custom-color-dialog-overlay";

  overlay.innerHTML = `
    <div class="custom-color-dialog">
      <h3 class="custom-color-dialog-title">${title}</h3>
      <div class="custom-color-dialog-row">
        <label>Color</label>
        <input type="color" class="custom-color-dialog-picker" value="${initialHex}" />
        <input type="text" class="custom-color-dialog-hex" value="${initialHex}" placeholder="#000000" spellcheck="false" />
      </div>
      <div class="custom-color-dialog-row">
        <label>Label</label>
        <input type="text" class="custom-color-dialog-label" value="${initialLabel}" placeholder="e.g. Brand Primary" spellcheck="false" />
      </div>
      <div class="custom-color-dialog-actions">
        <button class="custom-color-dialog-cancel">Cancel</button>
        <button class="custom-color-dialog-confirm">Save</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const pickerInput = overlay.querySelector(".custom-color-dialog-picker");
  const hexInput = overlay.querySelector(".custom-color-dialog-hex");
  const labelInput = overlay.querySelector(".custom-color-dialog-label");
  const cancelBtn = overlay.querySelector(".custom-color-dialog-cancel");
  const confirmBtn = overlay.querySelector(".custom-color-dialog-confirm");

  // Sync picker <-> hex
  pickerInput.addEventListener("input", () => {
    hexInput.value = pickerInput.value;
  });
  hexInput.addEventListener("input", () => {
    const n = normalizeHex(hexInput.value);
    if (n) pickerInput.value = n;
  });

  cancelBtn.addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  confirmBtn.addEventListener("click", () => {
    const hex = hexInput.value.trim() || pickerInput.value;
    const label = labelInput.value.trim();
    if (normalizeHex(hex)) {
      onConfirm(hex, label);
      overlay.remove();
    } else {
      hexInput.style.borderColor = "#ff4444";
    }
  });

  // Focus label input
  setTimeout(() => labelInput.focus(), 50);
}

function openImportDialog() {
  const existing = document.getElementById("custom-color-dialog");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "custom-color-dialog";
  overlay.className = "custom-color-dialog-overlay";

  overlay.innerHTML = `
    <div class="custom-color-dialog">
      <h3 class="custom-color-dialog-title">Import Colors from JSON</h3>
      <p class="custom-color-dialog-hint">Paste a JSON array of objects with <code>hex</code> and <code>label</code> fields, or choose a .json file.</p>
      <textarea class="custom-color-dialog-textarea" rows="8" placeholder='[{"hex": "#ff0000", "label": "Red"}, ...]' spellcheck="false"></textarea>
      <div class="custom-color-dialog-row" style="justify-content:center;">
        <button class="custom-color-dialog-file-btn">Choose File</button>
        <input type="file" accept=".json,application/json" style="display:none" />
      </div>
      <div class="custom-color-dialog-actions">
        <button class="custom-color-dialog-cancel">Cancel</button>
        <button class="custom-color-dialog-confirm">Import</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const textarea = overlay.querySelector(".custom-color-dialog-textarea");
  const fileInput = overlay.querySelector('input[type="file"]');
  const fileBtn = overlay.querySelector(".custom-color-dialog-file-btn");
  const cancelBtn = overlay.querySelector(".custom-color-dialog-cancel");
  const confirmBtn = overlay.querySelector(".custom-color-dialog-confirm");

  fileBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      textarea.value = reader.result;
    };
    reader.readAsText(file);
  });

  cancelBtn.addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  confirmBtn.addEventListener("click", () => {
    const json = textarea.value.trim();
    if (!json) {
      textarea.style.borderColor = "#ff4444";
      return;
    }
    const count = importColorsFromJSON(json);
    if (count > 0) {
      overlay.remove();
      // Show success toast
      const { showToast } = _toastFn;
      if (showToast) showToast(`Imported ${count} color${count > 1 ? "s" : ""}`);
    } else if (count === 0) {
      textarea.style.borderColor = "#ff8800";
      textarea.placeholder = "No valid colors found in the JSON data";
    } else {
      textarea.style.borderColor = "#ff4444";
      textarea.placeholder = "Invalid JSON — must be an array of {hex, label} objects";
    }
  });
}

function doExport() {
  if (customColors.length === 0) {
    if (_toastFn.showToast) _toastFn.showToast("No custom colors to export");
    return;
  }
  const json = exportColorsToJSON();
  navigator.clipboard.writeText(json).then(() => {
    if (_toastFn.showToast) _toastFn.showToast("Custom colors JSON copied to clipboard");
  }).catch(() => {
    // Fallback: download as file
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "custom-colors.json";
    a.click();
    URL.revokeObjectURL(url);
  });
}

// Toast reference (set lazily to avoid circular deps)
const _toastFn = { showToast: null };

export function setCustomColorsToast(fn) {
  _toastFn.showToast = fn;
}
