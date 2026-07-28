/**
 * Contrast Checker Tool
 *
 * Allows users to click two spots on the canvas and calculates
 * the contrast ratio between the two sampled colors, showing
 * WCAG AA and AAA pass/fail results.
 */

import { state, getDom } from "./state.js";

/**
 * Convert an sRGB component (0–255) to linear RGB.
 */
function sRGBtoLinear(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/**
 * Calculate relative luminance per WCAG 2.1 definition.
 * @param {number} r - Red (0–255)
 * @param {number} g - Green (0–255)
 * @param {number} b - Blue (0–255)
 * @returns {number} Relative luminance (0–1)
 */
export function relativeLuminance(r, g, b) {
  const rLin = sRGBtoLinear(r);
  const gLin = sRGBtoLinear(g);
  const bLin = sRGBtoLinear(b);
  return 0.2126 * rLin + 0.7152 * gLin + 0.0722 * bLin;
}

/**
 * Calculate contrast ratio between two colors.
 * @param {{r:number,g:number,b:number}} color1
 * @param {{r:number,g:number,b:number}} color2
 * @returns {number} Contrast ratio (1–21)
 */
export function contrastRatio(color1, color2) {
  const l1 = relativeLuminance(color1.r, color1.g, color1.b);
  const l2 = relativeLuminance(color2.r, color2.g, color2.b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Evaluate WCAG 2.1 conformance levels for a given contrast ratio.
 * @param {number} ratio
 * @returns {{normalAA: boolean, normalAAA: boolean, largeAA: boolean, largeAAA: boolean}}
 */
export function evaluateWCAG(ratio) {
  return {
    normalAA: ratio >= 4.5,
    normalAAA: ratio >= 7,
    largeAA: ratio >= 3,
    largeAAA: ratio >= 4.5,
  };
}

/**
 * Convert RGB values to a hex string.
 */
export function rgbToHex(r, g, b) {
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
}

/**
 * Show the contrast checker results panel with the two colors and their contrast.
 */
export function showContrastResult() {
  const panel = document.getElementById("contrast-checker-panel");
  if (!panel) return;

  const c1 = state.contrastColor1;
  const c2 = state.contrastColor2;
  if (!c1 || !c2) return;

  const ratio = contrastRatio(c1, c2);
  const wcag = evaluateWCAG(ratio);
  const hex1 = rgbToHex(c1.r, c1.g, c1.b);
  const hex2 = rgbToHex(c2.r, c2.g, c2.b);

  const ratioStr = ratio.toFixed(2) + ":1";

  panel.innerHTML = `
    <div class="contrast-header">
      <span class="contrast-title">Contrast Checker</span>
      <button class="contrast-close-btn" id="contrast-close-btn" title="Close">&times;</button>
    </div>
    <div class="contrast-colors">
      <div class="contrast-color-item">
        <div class="contrast-color-swatch" style="background: ${hex1};"></div>
        <span class="contrast-color-hex">${hex1}</span>
      </div>
      <span class="contrast-vs">vs</span>
      <div class="contrast-color-item">
        <div class="contrast-color-swatch" style="background: ${hex2};"></div>
        <span class="contrast-color-hex">${hex2}</span>
      </div>
    </div>
    <div class="contrast-ratio-display">${ratioStr}</div>
    <div class="contrast-wcag-results">
      <div class="wcag-row">
        <span class="wcag-label">Normal text AA (4.5:1)</span>
        <span class="wcag-badge ${wcag.normalAA ? "pass" : "fail"}">${wcag.normalAA ? "PASS" : "FAIL"}</span>
      </div>
      <div class="wcag-row">
        <span class="wcag-label">Normal text AAA (7:1)</span>
        <span class="wcag-badge ${wcag.normalAAA ? "pass" : "fail"}">${wcag.normalAAA ? "PASS" : "FAIL"}</span>
      </div>
      <div class="wcag-row">
        <span class="wcag-label">Large text AA (3:1)</span>
        <span class="wcag-badge ${wcag.largeAA ? "pass" : "fail"}">${wcag.largeAA ? "PASS" : "FAIL"}</span>
      </div>
      <div class="wcag-row">
        <span class="wcag-label">Large text AAA (4.5:1)</span>
        <span class="wcag-badge ${wcag.largeAAA ? "pass" : "fail"}">${wcag.largeAAA ? "PASS" : "FAIL"}</span>
      </div>
    </div>
    <div class="contrast-hint">Click two spots on the canvas to compare again</div>
  `;

  panel.style.display = "block";

  // Close button handler
  document.getElementById("contrast-close-btn").addEventListener("click", () => {
    hideContrastPanel();
  });
}

/**
 * Hide the contrast checker panel and reset state.
 */
export function hideContrastPanel() {
  const panel = document.getElementById("contrast-checker-panel");
  if (panel) panel.style.display = "none";
  state.contrastColor1 = null;
  state.contrastColor2 = null;
  state.contrastClickCount = 0;
}

/**
 * Update the panel to show which click we're waiting for.
 */
export function showContrastWaiting(clickNum) {
  const panel = document.getElementById("contrast-checker-panel");
  if (!panel) return;

  if (clickNum === 1) {
    panel.innerHTML = `
      <div class="contrast-header">
        <span class="contrast-title">Contrast Checker</span>
        <button class="contrast-close-btn" id="contrast-close-btn" title="Close">&times;</button>
      </div>
      <div class="contrast-waiting">Click the <strong>first</strong> color on the canvas</div>
    `;
  } else {
    const c1 = state.contrastColor1;
    const hex1 = c1 ? rgbToHex(c1.r, c1.g, c1.b) : "";
    panel.innerHTML = `
      <div class="contrast-header">
        <span class="contrast-title">Contrast Checker</span>
        <button class="contrast-close-btn" id="contrast-close-btn" title="Close">&times;</button>
      </div>
      <div class="contrast-colors">
        <div class="contrast-color-item">
          <div class="contrast-color-swatch" style="background: ${hex1};"></div>
          <span class="contrast-color-hex">${hex1}</span>
        </div>
        <span class="contrast-vs">vs</span>
        <div class="contrast-color-item waiting">
          <div class="contrast-color-swatch" style="background: repeating-conic-gradient(#ccc 0% 25%, #fff 0% 50%) 50%/8px 8px;"></div>
          <span class="contrast-color-hex">?</span>
        </div>
      </div>
      <div class="contrast-waiting">Click the <strong>second</strong> color on the canvas</div>
    `;
  }

  panel.style.display = "block";

  // Close button handler
  const closeBtn = document.getElementById("contrast-close-btn");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      hideContrastPanel();
    });
  }
}
