/**
 * Filter Kernels
 * Color matrix definitions, pixel-level manipulation functions, and worker source generation.
 * Reusable on both the main thread and inside Web Workers.
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

const applyContrast = (data, factor) => {
  const intercept = CHANNEL_MIDPOINT * (1 - factor);
  for (let i = 0; i < data.length; i += 4) {
    data[i]     = data[i]     * factor + intercept;
    data[i + 1] = data[i + 1] * factor + intercept;
    data[i + 2] = data[i + 2] * factor + intercept;
  }
};

const applySaturation = (data, factor) => {
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    data[i]     = gray + factor * (data[i]     - gray);
    data[i + 1] = gray + factor * (data[i + 1] - gray);
    data[i + 2] = gray + factor * (data[i + 2] - gray);
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

  if (filter === "grayscale") {
    for (let i = 0; i < d.length; i += 4) {
      const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
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
    const matrix = COLOR_MATRICES[filter];
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
      d[i]     = matrix[0]*r  + matrix[1]*g  + matrix[2]*b  + matrix[3]*a  + matrix[4];
      d[i + 1] = matrix[5]*r  + matrix[6]*g  + matrix[7]*b  + matrix[8]*a  + matrix[9];
      d[i + 2] = matrix[10]*r + matrix[11]*g + matrix[12]*b + matrix[13]*a + matrix[14];
    }
  }

  return imageData;
};

/**
 * Generate the source code string for a Web Worker that can apply filters.
 * The worker accepts messages of type "apply" with {imageBitmap, filter, id}
 * and responds with {type: "result", blob, id} or {type: "error", error, id}.
 */
export const generateWorkerSource = () => {
  return `
    const COLOR_MATRICES = ${JSON.stringify(COLOR_MATRICES)};
    const CHANNEL_MIDPOINT = 128;

    const applyContrast = (data, factor) => {
      const intercept = CHANNEL_MIDPOINT * (1 - factor);
      for (let i = 0; i < data.length; i += 4) {
        data[i]     = data[i]     * factor + intercept;
        data[i + 1] = data[i + 1] * factor + intercept;
        data[i + 2] = data[i + 2] * factor + intercept;
      }
    };

    const applySaturation = (data, factor) => {
      for (let i = 0; i < data.length; i += 4) {
        const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        data[i]     = gray + factor * (data[i]     - gray);
        data[i + 1] = gray + factor * (data[i + 1] - gray);
        data[i + 2] = gray + factor * (data[i + 2] - gray);
      }
    };

    const applyFilterToImageData = (imageData, filter) => {
      if (!filter || filter === "none") return imageData;
      const d = imageData.data;

      if (filter === "grayscale") {
        for (let i = 0; i < d.length; i += 4) {
          const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
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
        const matrix = COLOR_MATRICES[filter];
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
          d[i]     = matrix[0]*r  + matrix[1]*g  + matrix[2]*b  + matrix[3]*a  + matrix[4];
          d[i + 1] = matrix[5]*r  + matrix[6]*g  + matrix[7]*b  + matrix[8]*a  + matrix[9];
          d[i + 2] = matrix[10]*r + matrix[11]*g + matrix[12]*b + matrix[13]*a + matrix[14];
        }
      }

      return imageData;
    };

    self.onmessage = async (e) => {
      const { type, imageBitmap, filter, id } = e.data;
      if (type === "apply") {
        try {
          const w = imageBitmap.width;
          const h = imageBitmap.height;
          const canvas = new OffscreenCanvas(w, h);
          const ctx = canvas.getContext("2d");
          ctx.drawImage(imageBitmap, 0, 0);

          if (filter !== "none") {
            const imageData = ctx.getImageData(0, 0, w, h);
            applyFilterToImageData(imageData, filter);
            ctx.putImageData(imageData, 0, 0);
          }

          const blob = await canvas.convertToBlob({ type: "image/png" });
          self.postMessage({ type: "result", blob, id });
        } catch (err) {
          self.postMessage({ type: "error", error: err.message, id });
        } finally {
          imageBitmap.close();
        }
      }
    };
  `;
};
