/**
 * File Persistence (ZIP format via JSZip)
 *
 * Save/load canvas state to .icv files.
 */

import { state, CONSTANTS, getDom, rebuildSpatialIndex } from "./state.js";
import { serializeElement } from "./elements.js";
import { updateUndoRedoButtons } from "./history.js";
import { showToast } from "./utils.js";

// Forward declarations
let _render = null;
let _toggleAlignmentPanelVisibility = null;

export function setPersistenceDeps({ render, toggleAlignmentPanelVisibility }) {
  _render = render;
  _toggleAlignmentPanelVisibility = toggleAlignmentPanelVisibility;
}

export function scheduleSave() {
  state.isDirty = true;
  if (state.saveTimeout) clearTimeout(state.saveTimeout);
  state.saveTimeout = setTimeout(autoSave, 500);
}

function dataURLToBlob(dataURL) {
  const [header, base64] = dataURL.split(",");
  const mime = header.match(/:(.*?);/)[1];
  const binary = atob(base64);
  const array = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) array[i] = binary.charCodeAt(i);
  return new Blob([array], { type: mime });
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function buildZipBlob() {
  const zip = new JSZip();
  const imgFolder = zip.folder("images");

  const imageEntries = [];
  for (let i = 0; i < state.images.length; i++) {
    const el = state.images[i];
    const src = el.img.src;
    const mime = src.match(/data:(.*?);/);
    const ext = mime ? mime[1].split("/")[1].replace("jpeg", "jpg") : "png";
    const filename = `${el.id}.${ext}`;
    imgFolder.file(filename, dataURLToBlob(src));
    imageEntries.push({
      id: el.id, elementType: "image", file: filename,
      x: el.x, y: el.y, w: el.w, h: el.h,
      groupId: el.groupId || null,
      opacity: el.opacity != null ? el.opacity : 1,
      crop: el.crop || null,
      fullBounds: el.fullBounds || null,
    });
  }

  const manifest = {
    version: 2,
    images: imageEntries,
    drawings: state.drawings.map((el) => serializeElement(el)),
    transform: state.transform,
    bgColor: state.bgColor,
    drawColor: state.drawColor,
    textDrawColor: state.textDrawColor,
    currentFilter: state.currentFilter,
  };

  zip.file("manifest.json", JSON.stringify(manifest));
  return await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

async function autoSave() {
  if (!state.fileHandle) return;
  if (state.isSaving) {
    state.pendingSave = true;
    return;
  }
  state.isSaving = true;
  try {
    const blob = await buildZipBlob();
    const writable = await state.fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    state.isDirty = false;
  } catch (e) {
    console.warn("Autosave failed:", e.message);
    showToast("Save failed – will retry");
    scheduleSave();
  } finally {
    state.isSaving = false;
    if (state.pendingSave) {
      state.pendingSave = false;
      autoSave();
    }
  }
}

export async function saveAs() {
  try {
    state.fileHandle = await window.showSaveFilePicker({
      suggestedName: "canvas.icv",
      types: [{ description: "Infinite Canvas File", accept: { "application/zip": [".icv"] } }],
    });
    await autoSave();
    showToast("Saved to " + state.fileHandle.name);
  } catch (e) {
    if (e.name !== "AbortError") console.warn("Save failed:", e.message);
  }
}

export async function saveFile() {
  if (!state.fileHandle) {
    await saveAs();
  } else {
    await autoSave();
    showToast("Saved");
  }
}

export async function openFile() {
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: "Infinite Canvas File", accept: { "application/zip": [".icv"] } }],
    });
    const file = await handle.getFile();
    const arrayBuf = await file.arrayBuffer();
    await restoreFromZip(arrayBuf);
    state.fileHandle = handle;
    showToast("Loaded " + handle.name);
  } catch (e) {
    if (e.name !== "AbortError") console.warn("Open failed:", e.message);
  }
}

async function restoreFromZip(arrayBuf) {
  const zip = await JSZip.loadAsync(arrayBuf);
  const manifestText = await zip.file("manifest.json").async("string");
  const manifest = JSON.parse(manifestText);

  state.drawings = (manifest.drawings || []).map((el) => {
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

  const imageData = manifest.images || [];
  state.images = [];

  if (imageData.length > 0) {
    const loadPromises = imageData.map(async (data) => {
      const imgFile = zip.file("images/" + data.file);
      if (!imgFile) return null;
      const blob = await imgFile.async("blob");
      const dataURL = await blobToDataURL(blob);
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const restored = {
            id: data.id, elementType: "image", img,
            x: data.x, y: data.y, w: data.w, h: data.h,
            groupId: data.groupId || null,
            opacity: data.opacity != null ? data.opacity : 1,
          };
          if (data.crop) restored.crop = { ...data.crop };
          if (data.fullBounds) restored.fullBounds = { ...data.fullBounds };
          resolve(restored);
        };
        img.onerror = () => resolve(null);
        img.src = dataURL;
      });
    });
    const loaded = await Promise.all(loadPromises);
    state.images = loaded.filter(Boolean);
  }

  restoreViewState(manifest, imageData);
  rebuildSpatialIndex();
  if (_render) _render();
}

function restoreViewState(manifest, imageData) {
  const dom = getDom();
  if (manifest.transform) {
    Object.assign(state.transform, manifest.transform);
    dom.zoomSlider.value = Math.round(state.transform.zoom * 100);
    dom.zoomValDisplay.textContent = Math.round(state.transform.zoom * 100) + "%";
  }
  if (manifest.bgColor) {
    state.bgColor = manifest.bgColor;
    dom.bgColorPicker.value = state.bgColor;
    document.body.style.backgroundColor = state.bgColor;
  }
  if (manifest.drawColor) {
    state.drawColor = manifest.drawColor;
    dom.colorPicker.value = state.drawColor;
  }
  if (manifest.textDrawColor) {
    state.textDrawColor = manifest.textDrawColor;
  }
  if (manifest.currentFilter) {
    state.currentFilter = manifest.currentFilter;
    const filterSel = dom.filterSelect;
    if (filterSel) {
      filterSel.value = state.currentFilter;
      filterSel.classList.toggle("filter-active", state.currentFilter !== "none");
    }
  }

  const allIds = [...state.drawings, ...(imageData || [])].map((el) => {
    const match = el.id && el.id.match(/_(\d+)$/);
    return match ? parseInt(match[1]) : 0;
  });
  if (allIds.length > 0) {
    state.elementIdCounter = Math.max(...allIds) + 1;
  }

  state.selectedElements = [];
  state.undoStack = [];
  state.redoStack = [];
  updateUndoRedoButtons();
  if (_toggleAlignmentPanelVisibility) _toggleAlignmentPanelVisibility();
  state.isDirty = false;
}
