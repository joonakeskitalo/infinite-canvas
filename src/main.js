/**
 * Main Entry Point
 *
 * Imports all modules, wires up forward dependencies,
 * populates shortcut labels, and initializes the application.
 */

import { state } from "./state.js";
import { formatShortcut, isMacPlatform } from "./utils.js";
import { render, setPostRenderHook } from "./rendering.js";
import { setHistoryDeps } from "./history.js";
import { setCropDeps } from "./crop.js";
import { setPersistenceDeps, scheduleSave } from "./persistence.js";
import { setRenderFn, toggleAlignmentPanelVisibility } from "./toolbar.js";
import { initRulers, renderRulers, renderGuides } from "./rulers.js";
import { initEventHandlers } from "./interaction.js";

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
