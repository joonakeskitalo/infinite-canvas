/**
 * Filter Kernels
 * Color matrix definitions, pixel-level manipulation functions, and worker source generation.
 * Reusable on both the main thread and inside Web Workers.
 *
 * Performance notes:
 * - Loops iterate by 4 (RGBA stride) with local variable caching
 * - Matrix elements are destructured before the loop to avoid repeated indexing
 * - Grayscale uses integer math with |0 for fast clamping
 * - Worker uses transferable ArrayBuffer to avoid copying pixel data
 */

export const COLOR_MATRICES = {
  protanopia: [
    0.567, 0.433, 0, 0, 0,
    0.558, 0.442, 0, 0, 0,
    0,     0.242, 0.758, 0, 0,
    0,     0,     0,     1, 0,
  ],
  deuteranopia: [
    0.625, 0.375, 0,   0, 0,
    0.7,   0.3,   0,   0, 0,
    0,     0.3,   0.7, 0, 0,
    0,     0,     0,   1, 0,
  ],
  tritanopia: [
    0.95, 0.05,  0,     0, 0,
    0,    0.433, 0.567, 0, 0,
    0,    0.475, 0.525, 0, 0,
    0,    0,     0,     1, 0,
  ],
  achromatopsia: [
    0.299, 0.587, 0.114, 0, 0,
    0.299, 0.587, 0.114, 0, 0,
    0.299, 0.587, 0.114, 0, 0,
    0,     0,     0,     1, 0,
  ],
};

const CHANNEL_MIDPOINT = 128;

/**
 * Apply contrast adjustment in place.
 * Pre-computes intercept outside the loop.
 */
const applyContrast = (data, factor) => {
  const len = data.length;
  const intercept = CHANNEL_MIDPOINT * (1 - factor);
  for (let i = 0; i < len; i += 4) {
    data[i]     = data[i]     * factor + intercept;
    data[i + 1] = data[i + 1] * factor + intercept;
    data[i + 2] = data[i + 2] * factor + intercept;
  }
};

/**
 * Apply saturation adjustment in place.
 * Uses pre-computed luma coefficients and one-minus-factor optimization.
 */
const applySaturation = (data, factor) => {
  const len = data.length;
  const oneMinusFactor = 1 - factor;
  for (let i = 0; i < len; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    const grayWeighted = gray * oneMinusFactor;
    data[i]     = grayWeighted + factor * r;
    data[i + 1] = grayWeighted + factor * g;
    data[i + 2] = grayWeighted + factor * b;
  }
};

/**
 * Apply a color matrix to pixel data in place.
 * Destructures matrix elements into locals before looping to avoid
 * repeated array indexing inside the hot loop.
 */
const applyColorMatrix = (data, matrix) => {
  const len = data.length;
  // Destructure all 15 relevant matrix values (alpha row is identity, skip row 4)
  const m0 = matrix[0], m1 = matrix[1], m2 = matrix[2], m3 = matrix[3], m4 = matrix[4];
  const m5 = matrix[5], m6 = matrix[6], m7 = matrix[7], m8 = matrix[8], m9 = matrix[9];
  const m10 = matrix[10], m11 = matrix[11], m12 = matrix[12], m13 = matrix[13], m14 = matrix[14];

  for (let i = 0; i < len; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    data[i]     = m0 * r + m1 * g + m2 * b + m3 * a + m4;
    data[i + 1] = m5 * r + m6 * g + m7 * b + m8 * a + m9;
    data[i + 2] = m10 * r + m11 * g + m12 * b + m13 * a + m14;
  }
};

/**
 * Apply a named filter to ImageData in place.
 * @param {ImageData} imageData
 * @param {string} filter - One of the FILTER_OPTIONS keys
 * @returns {ImageData} The mutated imageData (same reference)
 */
export const applyFilterToImageData = (imageData, filter) => {
  if (!filter || filter === "none") return imageData;
  const d = imageData.data;
  const len = d.length;

  if (filter === "grayscale") {
    for (let i = 0; i < len; i += 4) {
      // Integer luma approximation: (r*77 + g*150 + b*29) >> 8
      // Avoids floating point and matches perceived luminance closely
      const gray = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29 + 128) >> 8;
      d[i] = d[i + 1] = d[i + 2] = gray;
    }
  } else if (filter === "low-contrast") {
    applyContrast(d, 0.85);
  } else if (filter === "high-contrast") {
    applyContrast(d, 1.25);
  } else if (filter === "low-quality-display") {
    applyContrast(d, 0.95);
    applySaturation(d, 0.6);
  } else if (COLOR_MATRICES[filter]) {
    applyColorMatrix(d, COLOR_MATRICES[filter]);
  }

  return imageData;
};

/**
 * Generate the source code string for a Web Worker that can apply filters.
 * The worker accepts messages of type "apply" with {imageData, width, height, filter, id}
 * and responds with {type: "result", buffer, width, height, id} transferring the ArrayBuffer.
 *
 * Performance: uses transferable ArrayBuffer both ways to avoid copying pixel data.
 */
export const generateWorkerSource = () => {
  return `
    const COLOR_MATRICES = ${JSON.stringify(COLOR_MATRICES)};
    const CHANNEL_MIDPOINT = 128;

    const applyContrast = (data, factor) => {
      const len = data.length;
      const intercept = CHANNEL_MIDPOINT * (1 - factor);
      for (let i = 0; i < len; i += 4) {
        data[i]     = data[i]     * factor + intercept;
        data[i + 1] = data[i + 1] * factor + intercept;
        data[i + 2] = data[i + 2] * factor + intercept;
      }
    };

    const applySaturation = (data, factor) => {
      const len = data.length;
      const oneMinusFactor = 1 - factor;
      for (let i = 0; i < len; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        const grayWeighted = gray * oneMinusFactor;
        data[i]     = grayWeighted + factor * r;
        data[i + 1] = grayWeighted + factor * g;
        data[i + 2] = grayWeighted + factor * b;
      }
    };

    const applyColorMatrix = (data, matrix) => {
      const len = data.length;
      const m0 = matrix[0], m1 = matrix[1], m2 = matrix[2], m3 = matrix[3], m4 = matrix[4];
      const m5 = matrix[5], m6 = matrix[6], m7 = matrix[7], m8 = matrix[8], m9 = matrix[9];
      const m10 = matrix[10], m11 = matrix[11], m12 = matrix[12], m13 = matrix[13], m14 = matrix[14];

      for (let i = 0; i < len; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        data[i]     = m0 * r + m1 * g + m2 * b + m3 * a + m4;
        data[i + 1] = m5 * r + m6 * g + m7 * b + m8 * a + m9;
        data[i + 2] = m10 * r + m11 * g + m12 * b + m13 * a + m14;
      }
    };

    const applyFilterToImageData = (data, filter) => {
      const len = data.length;

      if (filter === "grayscale") {
        for (let i = 0; i < len; i += 4) {
          const gray = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29 + 128) >> 8;
          data[i] = data[i + 1] = data[i + 2] = gray;
        }
      } else if (filter === "low-contrast") {
        applyContrast(data, 0.85);
      } else if (filter === "high-contrast") {
        applyContrast(data, 1.25);
      } else if (filter === "low-quality-display") {
        applyContrast(data, 0.95);
        applySaturation(data, 0.6);
      } else if (COLOR_MATRICES[filter]) {
        applyColorMatrix(data, COLOR_MATRICES[filter]);
      }
    };

    self.onmessage = (e) => {
      const { type, buffer, width, height, filter, id } = e.data;
      if (type !== "apply") return;

      try {
        const data = new Uint8ClampedArray(buffer);
        applyFilterToImageData(data, filter);
        // Transfer the buffer back (zero-copy)
        self.postMessage({ type: "result", buffer: data.buffer, width, height, id }, [data.buffer]);
      } catch (err) {
        self.postMessage({ type: "error", error: err.message, id });
      }
    };
  `;
};
