/**
 * Main Entry Point
 *
 * Imports all modules, wires up forward dependencies,
 * populates shortcut labels, and initializes the application.
 */

import { state, rebuildSpatialIndex, rebuildElementOrder } from "./state.js";
import { formatShortcut, isMacPlatform, showToast } from "./utils.js";
import { render, setPostRenderHook } from "./rendering.js";
import { setHistoryDeps } from "./history.js";
import { setCropDeps } from "./crop.js";
import { setPersistenceDeps, scheduleSave } from "./persistence.js";
import { setRenderFn, toggleAlignmentPanelVisibility } from "./toolbar.js";
import { initRulers, renderRulers, renderGuides } from "./rulers.js";
import { initEventHandlers } from "./interaction.js";
import { initFilterPreviewMode } from "./filter-preview-mode.js";
import { initWelcomeModal } from "./welcome.js";
import { initCustomColors, setCustomColorsToast } from "./custom-colors.js";
import { initColorHistory } from "./color-history.js";
import { initSavedStamps, setSavedStampsDeps } from "./saved-stamps.js";
import { setLaserRenderFn } from "./laser-pointer.js";
import { setBezierPenDeps } from "./bezier-pen.js";
import { initMarqueeColors, setMarqueeColorsDeps } from "./marquee-colors.js";
import { initCommandPalette } from "./command-palette.js";

// --- Wire up forward dependencies to break circular imports ---
setHistoryDeps({
  render,
  toggleAlignmentPanelVisibility,
  scheduleSave,
});

setCropDeps({
  render,
  toggleAlignmentPanelVisibility,
  scheduleSave,
});

setPersistenceDeps({
  render,
  toggleAlignmentPanelVisibility,
});

setRenderFn(render);
setLaserRenderFn(render);
setBezierPenDeps({ render, scheduleSave, toggleAlignmentPanelVisibility });

// --- Hook rulers into the render cycle ---
setPostRenderHook(() => {
  if (state.rulersVisible) {
    renderRulers();
    renderGuides();
  }
});

// --- Populate platform-aware shortcut labels ---
document.querySelectorAll("kbd[data-shortcut]").forEach((kbd) => {
  kbd.textContent = formatShortcut(kbd.dataset.shortcut);
});

document.querySelectorAll("[data-title-template]").forEach((el) => {
  el.title = el.dataset.titleTemplate
    .replace(/\{mod\}/g, isMacPlatform ? "⌘" : "Ctrl+")
    .replace(/\{shift\}/g, isMacPlatform ? "⇧" : "Shift+")
    .replace(/\{alt\}/g, isMacPlatform ? "⌥" : "Alt+");
});

// --- Initialize rulers ---
initRulers();

// --- Initialize all event handlers ---
initEventHandlers();

// --- Initialize filter preview mode ---
initFilterPreviewMode();

// --- Build spatial index from any pre-existing elements ---
rebuildSpatialIndex();
rebuildElementOrder();

// --- Show welcome modal on first visit ---
initWelcomeModal();

// --- Initialize custom color palette ---
setCustomColorsToast(showToast);
initCustomColors();
initColorHistory();
setSavedStampsDeps({ onRestore: render });
initSavedStamps();
initMarqueeColors();
setMarqueeColorsDeps({
  onColorSelect: (hex) => {
    state.drawColor = hex;
    const picker = document.getElementById("color-picker");
    if (picker) picker.value = hex;
    const inner = document.getElementById("color-swatch-inner");
    if (inner) inner.style.background = hex;
    const hexLbl = document.getElementById("color-hex-label");
    if (hexLbl) hexLbl.textContent = hex.toUpperCase();
  },
});

// --- Initialize command palette ---
initCommandPalette();
