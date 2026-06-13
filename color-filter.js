/**
 * Color Filter Definitions
 * Single source of truth for available filters consumed by UI and kernels.
 */

export const FILTER_OPTIONS = [
  "none",
  "grayscale",
  "protanopia",
  "deuteranopia",
  "tritanopia",
  "achromatopsia",
  "low-contrast",
  "high-contrast",
  "low-quality-display",
];

export const FILTER_LABELS = {
  none: "Original",
  grayscale: "Grayscale",
  protanopia: "Protanopia",
  deuteranopia: "Deuteranopia",
  tritanopia: "Tritanopia",
  achromatopsia: "Achromatopsia",
  "low-contrast": "Low contrast",
  "high-contrast": "High contrast",
  "low-quality-display": "Low quality display",
};
