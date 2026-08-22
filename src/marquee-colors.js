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

const MAX_COLORS = 24;
const MIN_PIXEL_COUNT_RATIO = 0.001; // Minimum 0.1% of pixels to be considered a real color
const QUANTIZE_BITS = 4; // Reduce color precision to group similar colors (shift right by this)

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

  // Take top colors
  const topColors = (filtered.length > 0 ? filtered : sorted).slice(0, MAX_COLORS);

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
    swatch.title = `${color.hex.toUpperCase()} (${color.percentage}%)\nClick to select, Shift+click to copy`;

    const colorBlock = document.createElement("div");
    colorBlock.className = "marquee-color-block";
    colorBlock.style.background = color.hex;

    const label = document.createElement("span");
    label.className = "marquee-color-label";
    label.textContent = color.hex.toUpperCase();

    const pct = document.createElement("span");
    pct.className = "marquee-color-pct";
    pct.textContent = `${color.percentage}%`;

    swatch.appendChild(colorBlock);
    swatch.appendChild(label);
    swatch.appendChild(pct);

    swatch.addEventListener("click", (e) => {
      if (e.shiftKey) {
        // Copy hex to clipboard
        const upper = color.hex.toUpperCase();
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(upper).then(() => {
            showToast(`Copied: ${upper}`);
          }).catch(() => {});
        }
      } else {
        // Select color and push to history
        pushColorToHistory(color.hex);
        if (_onColorSelect) _onColorSelect(color.hex);
        showToast(`Color: ${color.hex.toUpperCase()}`);
      }
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
}
