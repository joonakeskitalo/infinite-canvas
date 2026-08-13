/**
 * Welcome Modal — First-time introduction
 *
 * Shows a welcome/onboarding modal on the user's first visit.
 * Uses localStorage to remember if the modal has been dismissed.
 * Can be re-opened from the toolbar menu.
 */

import { isMacPlatform } from "./utils.js";

const STORAGE_KEY = "jiiris-welcomed";

function mod() {
  return isMacPlatform ? "⌘" : "Ctrl";
}

// SVG icons matching the toolbar icons for each tool
const TOOL_ICONS = {
  hand: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>`,
  select: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M7 2l12 11.2-5.3.7 3.5 6.6-2.5 1.3-3.6-6.6-4.1 3.5V2z"/></svg>`,
  pen: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>`,
  line: `<svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24"><path d="M4 20L20 4l1.5 1.5L5.5 21.5z"/></svg>`,
  arrow: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 13V19H13"/><path d="M5 5L19 19"/></svg>`,
  connector: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.464 8.464l9.536 9.536"/><path d="M14 18h4v-4"/><path d="M8.414 8.414a2 2 0 1 0-2.828-2.828a2 2 0 0 0 2.828 2.828"/></svg>`,
  rectBorder: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14z"/></svg>`,
  rectFill: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/></svg>`,
  text: `<svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24"><path d="M5 4v3h5.5v12h3V7H19V4H5z"/></svg>`,
  stickyNote: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2" fill="#f5e642" opacity="0.85"/><text x="12" y="16" text-anchor="middle" font-size="12" font-weight="bold" fill="#333">T</text></svg>`,
  eraser: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>`,
  measure: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2"/><path d="m11.5 9.5 2-2"/><path d="m8.5 6.5 2-2"/><path d="m17.5 15.5 2-2"/></svg>`,
  guideLine: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="22" stroke-dasharray="4 2"/><line x1="6" y1="2" x2="6" y2="22" opacity="0.4" stroke-dasharray="4 2"/><line x1="18" y1="2" x2="18" y2="22" opacity="0.4" stroke-dasharray="4 2"/></svg>`,
  contrast: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 18a6 6 0 0 0 0-12v12z"/></svg>`,
  eyedropper: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 9-8.414 8.414A2 2 0 0 0 3 18.828v1.344a2 2 0 0 1-.586 1.414A2 2 0 0 1 3.828 21h1.344a2 2 0 0 0 1.414-.586L15 12"/><path d="m18 9 .4.4a1 1 0 1 1-3 3l-3.8-3.8a1 1 0 1 1 3-3l.4.4 3.4-3.4a1 1 0 1 1 3 3z"/><path d="m2 22 .414-.414"/></svg>`,
};

function buildToolsContent() {
  const tools = [
    { key: "H", label: "Hand (Pan)", icon: TOOL_ICONS.hand },
    { key: "V", label: "Select", icon: TOOL_ICONS.select },
    { key: "B", label: "Pen (Draw)", icon: TOOL_ICONS.pen },
    { key: "L", label: "Line", icon: TOOL_ICONS.line },
    { key: "A", label: "Arrow", icon: TOOL_ICONS.arrow },
    { key: "C", label: "Connector", icon: TOOL_ICONS.connector },
    { key: "R", label: "Box (Border)", icon: TOOL_ICONS.rectBorder },
    { key: "F", label: "Box (Fill)", icon: TOOL_ICONS.rectFill },
    { key: "T", label: "Text", icon: TOOL_ICONS.text },
    { key: "N", label: "Sticky Note", icon: TOOL_ICONS.stickyNote },
    { key: "E", label: "Eraser", icon: TOOL_ICONS.eraser },
    { key: "Y", label: "Measure", icon: TOOL_ICONS.measure },
    { key: "S", label: "Split Line", icon: TOOL_ICONS.guideLine },
    { key: "K", label: "Contrast Checker", icon: TOOL_ICONS.contrast },
    { key: "I", label: "Color Picker", icon: TOOL_ICONS.eyedropper },
  ];

  const items = tools.map((t) => `
    <div class="welcome-tool-item">
      <span class="welcome-tool-icon">${t.icon}</span>
      <span class="welcome-tool-label">${t.label}</span>
      <span class="welcome-tool-key">${t.key}</span>
    </div>
  `).join("");

  return `<div class="welcome-tools-grid">${items}</div>`;
}

function buildShortcutsContent() {
  const m = mod();
  return `
    <div class="welcome-shortcuts-grid">
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">${m}+Z</span>
        <span class="welcome-shortcut-label">Undo</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">${m}+Shift+Z</span>
        <span class="welcome-shortcut-label">Redo</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">${m}+C / ${m}+V</span>
        <span class="welcome-shortcut-label">Copy / Paste</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">${m}+D</span>
        <span class="welcome-shortcut-label">Duplicate</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">${m}+A</span>
        <span class="welcome-shortcut-label">Select All</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">${m}+G</span>
        <span class="welcome-shortcut-label">Group</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">Space + Drag</span>
        <span class="welcome-shortcut-label">Pan canvas</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">${isMacPlatform ? "⌘" : "Ctrl"}+Scroll</span>
        <span class="welcome-shortcut-label">Zoom in/out</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">+ / −</span>
        <span class="welcome-shortcut-label">Zoom in/out</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">Shift + / −</span>
        <span class="welcome-shortcut-label">Font size up/down</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">Delete / Backspace</span>
        <span class="welcome-shortcut-label">Remove selected</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">Arrow Keys</span>
        <span class="welcome-shortcut-label">Nudge (Shift=10, ${m}=100)</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">${m}+S</span>
        <span class="welcome-shortcut-label">Save file</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">${m}+O</span>
        <span class="welcome-shortcut-label">Open file</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">Shift+R</span>
        <span class="welcome-shortcut-label">Toggle rulers</span>
      </div>
      <div class="welcome-shortcut-item">
        <span class="welcome-shortcut-keys">Alt+P</span>
        <span class="welcome-shortcut-label">Filter preview</span>
      </div>
    </div>
  `;
}

function buildTipsContent() {
  return `
    <ul class="welcome-tips-list">
      <li>Paste images directly from your clipboard onto the canvas</li>
      <li>Drag and drop image files to import them</li>
      <li>Hold <strong>Shift</strong> while drawing lines to snap to angles</li>
      <li>Right-click + drag to pan with any tool active</li>
      <li>Use the color vision filters to check accessibility</li>
    </ul>
  `;
}

/**
 * Show the welcome modal (used both for first-visit and re-open).
 */
function showWelcomeModal() {
  const overlay = document.getElementById("welcome-overlay");
  if (!overlay) return;

  overlay.style.display = "flex";

  // Populate tab content
  const toolsPanel = document.getElementById("welcome-tab-tools");
  const shortcutsPanel = document.getElementById("welcome-tab-shortcuts");
  const tipsPanel = document.getElementById("welcome-tab-tips");

  if (toolsPanel) toolsPanel.innerHTML = buildToolsContent();
  if (shortcutsPanel) shortcutsPanel.innerHTML = buildShortcutsContent();
  if (tipsPanel) tipsPanel.innerHTML = buildTipsContent();

  // Reset to first tab
  const tabBtns = overlay.querySelectorAll(".welcome-tab-btn");
  const tabPanels = overlay.querySelectorAll(".welcome-tab-panel");
  tabBtns.forEach((b) => b.classList.remove("active"));
  tabPanels.forEach((p) => p.classList.remove("active"));
  tabBtns[0]?.classList.add("active");
  tabPanels[0]?.classList.add("active");
}

function setupModalListeners() {
  const overlay = document.getElementById("welcome-overlay");
  if (!overlay) return;

  const closeBtn = overlay.querySelector(".welcome-close-btn");
  const getStartedBtn = overlay.querySelector(".welcome-get-started-btn");
  const tabBtns = overlay.querySelectorAll(".welcome-tab-btn");
  const tabPanels = overlay.querySelectorAll(".welcome-tab-panel");

  // Tab switching
  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabBtns.forEach((b) => b.classList.remove("active"));
      tabPanels.forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      const target = document.getElementById(btn.dataset.tab);
      if (target) target.classList.add("active");
    });
  });

  function dismiss() {
    overlay.style.display = "none";
    localStorage.setItem(STORAGE_KEY, "1");
  }

  closeBtn.addEventListener("click", dismiss);
  getStartedBtn.addEventListener("click", dismiss);

  // Close on Escape
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.style.display === "flex") {
      dismiss();
    }
  });

  // Close when clicking overlay background
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) dismiss();
  });

  // Wire up the "Help" menu item to re-open the modal
  const helpBtn = document.getElementById("show-welcome-btn");
  if (helpBtn) {
    helpBtn.addEventListener("click", () => {
      showWelcomeModal();
      // Close the toolbar menu
      const toolbarMenu = document.getElementById("toolbar-menu");
      if (toolbarMenu) toolbarMenu.classList.remove("open");
      const menuBtn = document.getElementById("toolbar-menu-btn");
      if (menuBtn) menuBtn.classList.remove("menu-open");
    });
  }
}

export function initWelcomeModal() {
  setupModalListeners();

  // Show on first visit
  if (!localStorage.getItem(STORAGE_KEY)) {
    showWelcomeModal();
  }
}
