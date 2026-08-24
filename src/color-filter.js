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
  protanopia: "Protanopia (Red-Green, no red)",
  deuteranopia: "Deuteranopia (Red-Green, no green)",
  tritanopia: "Tritanopia (Blue-Yellow)",
  achromatopsia: "Achromatopsia (Total color blindness)",
  "low-contrast": "Low contrast",
  "high-contrast": "High contrast",
  "low-quality-display": "Low quality display",
};
