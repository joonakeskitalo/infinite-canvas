/**
 * Color Filter Definitions
 * Single source of truth for available filters consumed by UI and kernels.
 */

export const FILTER_OPTIONS = [
  "none",
  "grayscale",
  "protanopia",
  "protanomaly",
  "deuteranopia",
  "deuteranomaly",
  "tritanopia",
  "tritanomaly",
  "achromatopsia",
  "achromatomaly",
  "low-contrast",
  "high-contrast",
  "low-quality-display",
];

export const FILTER_LABELS = {
  none: "Original",
  grayscale: "Grayscale",
  protanopia: "Protanopia (Red-Green, no red)",
  protanomaly: "Protanomaly (Red-Green, weak red)",
  deuteranopia: "Deuteranopia (Red-Green, no green)",
  deuteranomaly: "Deuteranomaly (Red-Green, weak green)",
  tritanopia: "Tritanopia (Blue-Yellow)",
  tritanomaly: "Tritanomaly (Blue-Yellow, mild)",
  achromatopsia: "Achromatopsia (Total color blindness)",
  achromatomaly: "Achromatomaly (Almost no color)",
  "low-contrast": "Low contrast",
  "high-contrast": "High contrast",
  "low-quality-display": "Low quality display",
};
