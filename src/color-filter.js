/**
 * Color Filter Definitions
 * Single source of truth for available filters consumed by UI and kernels.
 */

export const FILTER_OPTIONS = [
  "none",
  "protanomaly",
  "protanopia",
  "deuteranomaly",
  "deuteranopia",
  "tritanomaly",
  "tritanopia",
  "achromatomaly",
  "achromatopsia",
  "low-contrast",
  "high-contrast",
  "low-quality-display",
];

export const FILTER_LABELS = {
  none: "Original",
  protanomaly: "Protanomaly (Red-Green, weak red)",
  protanopia: "Protanopia (Red-Green, no red)",
  deuteranomaly: "Deuteranomaly (Red-Green, weak green)",
  deuteranopia: "Deuteranopia (Red-Green, no green)",
  tritanomaly: "Tritanomaly (Blue-Yellow, mild)",
  tritanopia: "Tritanopia (Blue-Yellow)",
  achromatomaly: "Achromatomaly (Almost no color)",
  achromatopsia: "Achromatopsia (Grayscale / Total color blindness)",
  "low-contrast": "Low contrast",
  "high-contrast": "High contrast",
  "low-quality-display": "Low quality display",
};
