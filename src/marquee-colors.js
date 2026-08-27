/**
 * Marquee Color Analysis
 *
 * Analyzes pixel data from the marquee selection and extracts
 * the dominant/unique colors found in the selected area.
 * Displays results in a floating panel with clickable swatches.
 */

import { state } from "./state.js";
import { showToast } from "./utils.js";
import { pushColorToHistory } from "./color-history.js";
import { getCustomColors } from "./custom-colors.js";
import { render } from "./rendering.js";

const MAX_COLORS = 24;
const MIN_PIXEL_COUNT_RATIO = 0.003; // Minimum 0.3% of pixels to be considered a real color (filters out antialiasing artifacts)
const QUANTIZE_BITS = 0; // No quantization — rely on MIN_PIXEL_COUNT_RATIO to filter noise

let _panel = null;
let _swatchContainer = null;
let _countLabel = null;
let _onColorSelect = null;

/**
 * Inject dependency for color selection callback.
 */
export function setMarqueeColorsDeps({ onColorSelect }) {
  _onColorSelect = onColorSelect;
}

/**
 * Initialize the panel DOM references. Call once after DOM is ready.
 */
export function initMarqueeColors() {
  _panel = document.getElementById("marquee-colors-panel");
  _swatchContainer = document.getElementById("marquee-colors-swatches");
  _countLabel = document.getElementById("marquee-colors-count");

  // Prevent mousedown on the panel from propagating to the canvas container
  if (_panel) {
    _panel.addEventListener("mousedown", (e) => {
      e.stopPropagation();
    });
  }
}

/**
 * Analyze the current marquee selection and display colors.
 * Reads pixel data from state.marqueePixelCanvas.
 */
export function analyzeMarqueeColors() {
  if (!_panel) return;

  const canvas = state.marqueePixelCanvas;
  if (!canvas) {
    hideMarqueeColors();
    return;
  }

  // Get pixel data from the rasterized marquee canvas
  const w = canvas.width;
  const h = canvas.height;
  if (w === 0 || h === 0) {
    hideMarqueeColors();
    return;
  }

  const ctx = canvas.getContext("2d");
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;
  const totalPixels = w * h;

  // Count quantized colors (group similar colors together)
  const colorCounts = new Map();
  const shift = QUANTIZE_BITS;

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    // Skip fully transparent pixels
    if (a < 10) continue;

    // Quantize: reduce precision to group similar colors
    const r = (data[i] >> shift) << shift;
    const g = (data[i + 1] >> shift) << shift;
    const b = (data[i + 2] >> shift) << shift;

    const key = (r << 16) | (g << 8) | b;
    colorCounts.set(key, (colorCounts.get(key) || 0) + 1);
  }

  if (colorCounts.size === 0) {
    hideMarqueeColors();
    return;
  }

  // Sort by frequency (most common first)
  const sorted = [...colorCounts.entries()]
    .sort((a, b) => b[1] - a[1]);

  // Filter out colors below minimum threshold
  const minCount = totalPixels * MIN_PIXEL_COUNT_RATIO;
  const filtered = sorted.filter(([, count]) => count >= minCount);

  // Merge very similar colors (within 8 per channel) into the most frequent representative
  const MERGE_DIST = 8;
  const merged = [];
  const used = new Set();
  const source = filtered.length > 0 ? filtered : sorted;
  for (const [key, count] of source) {
    if (used.has(key)) continue;
    const r1 = (key >> 16) & 0xff;
    const g1 = (key >> 8) & 0xff;
    const b1 = key & 0xff;
    let totalCount = count;
    // Absorb nearby colors
    for (const [key2, count2] of source) {
      if (key2 === key || used.has(key2)) continue;
      const r2 = (key2 >> 16) & 0xff;
      const g2 = (key2 >> 8) & 0xff;
      const b2 = key2 & 0xff;
      if (Math.abs(r1 - r2) <= MERGE_DIST && Math.abs(g1 - g2) <= MERGE_DIST && Math.abs(b1 - b2) <= MERGE_DIST) {
        totalCount += count2;
        used.add(key2);
      }
    }
    used.add(key);
    merged.push([key, totalCount]);
  }

  // Take top colors
  const topColors = merged.slice(0, MAX_COLORS);

  // Convert to hex and calculate percentages
  const totalCounted = topColors.reduce((sum, [, count]) => sum + count, 0);
  const colors = topColors.map(([key, count]) => {
    const r = (key >> 16) & 0xff;
    const g = (key >> 8) & 0xff;
    const b = key & 0xff;
    const hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
    const percentage = ((count / totalCounted) * 100).toFixed(1);
    return { hex, percentage, count };
  });

  renderPanel(colors);
}

/**
 * Render the color analysis panel with swatches.
 */
function renderPanel(colors) {
  if (!_panel || !_swatchContainer || !_countLabel) return;

  _swatchContainer.innerHTML = "";
  _countLabel.textContent = `${colors.length} color${colors.length !== 1 ? "s" : ""} found`;

  for (const color of colors) {
    const swatch = document.createElement("div");
    swatch.className = "marquee-color-swatch";

    // Look up custom color label (fuzzy match to account for color quantization)
    const customColors = getCustomColors();
    const cr = parseInt(color.hex.slice(1, 3), 16);
    const cg = parseInt(color.hex.slice(3, 5), 16);
    const cb = parseInt(color.hex.slice(5, 7), 16);
    const MATCH_THRESHOLD = 8; // max channel distance to consider a label match
    let colorLabel = null;
    let bestDist = Infinity;
    for (const cc of customColors) {
      if (!cc.label || cc.label.toLowerCase() === cc.hex.toLowerCase()) continue;
      const hr = parseInt(cc.hex.slice(1, 3), 16);
      const hg = parseInt(cc.hex.slice(3, 5), 16);
      const hb = parseInt(cc.hex.slice(5, 7), 16);
      const dist = Math.abs(cr - hr) + Math.abs(cg - hg) + Math.abs(cb - hb);
      if (dist < bestDist && dist <= MATCH_THRESHOLD) {
        bestDist = dist;
        colorLabel = cc.label;
      }
    }

    swatch.title = `${color.hex.toUpperCase()}${colorLabel ? " — " + colorLabel : ""} (${color.percentage}%)`;

    const colorBlock = document.createElement("div");
    colorBlock.className = "marquee-color-block";
    colorBlock.style.background = color.hex;
    colorBlock.title = "Click to select color";
    colorBlock.addEventListener("click", (e) => {
      e.stopPropagation();
      pushColorToHistory(color.hex);
      if (_onColorSelect) _onColorSelect(color.hex);
      showToast(`Color: ${color.hex.toUpperCase()}`);
    });

    const hexSpan = document.createElement("span");
    hexSpan.className = "marquee-color-hex";
    hexSpan.textContent = color.hex.toUpperCase();
    hexSpan.title = "Click to copy hex";
    hexSpan.addEventListener("click", (e) => {
      e.stopPropagation();
      const upper = color.hex.toUpperCase();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(upper).then(() => {
          showToast(`Copied: ${upper}`);
        }).catch(() => {});
      }
    });

    const pct = document.createElement("span");
    pct.className = "marquee-color-pct";
    pct.textContent = `${color.percentage}%`;

    swatch.appendChild(colorBlock);
    swatch.appendChild(hexSpan);

    if (colorLabel) {
      const nameSpan = document.createElement("span");
      nameSpan.className = "marquee-color-name";
      nameSpan.textContent = colorLabel;
      nameSpan.title = "Click to copy name";
      nameSpan.addEventListener("click", (e) => {
        e.stopPropagation();
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(colorLabel).then(() => {
            showToast(`Copied: ${colorLabel}`);
          }).catch(() => {});
        }
      });
      swatch.appendChild(nameSpan);
    }

    swatch.appendChild(pct);

    swatch.addEventListener("mouseenter", () => {
      state.eyedropperHighlightColor = color.hex;
      render();
    });

    swatch.addEventListener("mouseleave", () => {
      state.eyedropperHighlightColor = null;
      render();
    });

    _swatchContainer.appendChild(swatch);
  }

  _panel.style.display = "flex";
}

/**
 * Hide the marquee colors panel.
 */
export function hideMarqueeColors() {
  if (_panel) {
    _panel.style.display = "none";
  }
  state.eyedropperHighlightColor = null;
}
