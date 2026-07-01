/**
 * Filter Preview System
 * Web Worker pool for off-main-thread pixel processing, plus utilities
 * for applying filters to images and exporting results.
 *
 * Performance optimizations:
 * - Workers receive/return raw ArrayBuffers via transferable objects (zero-copy)
 * - No PNG encode/decode round-trip inside workers
 * - Pixel data extracted once on main thread and shared across filter variants
 * - Results returned as ImageData ready for direct putImageData or bitmap creation
 */

import { FILTER_OPTIONS, FILTER_LABELS } from "./color-filter.js";
import { generateWorkerSource, applyFilterToImageData } from "./filter-kernels.js";

// --- Worker Pool ---

const WORKER_POOL_SIZE = navigator.hardwareConcurrency || 4;
const workerPool = [];
let workerRoundRobin = 0;
let workerIdCounter = 0;
let workerBlobUrl = null;

const getWorkerBlobUrl = () => {
  if (workerBlobUrl) return workerBlobUrl;
  const blob = new Blob([generateWorkerSource()], { type: "application/javascript" });
  workerBlobUrl = URL.createObjectURL(blob);
  return workerBlobUrl;
};

const initWorkerPool = () => {
  if (workerPool.length > 0) return;
  const url = getWorkerBlobUrl();
  for (let i = 0; i < WORKER_POOL_SIZE; i++) {
    const worker = new Worker(url);
    worker._pending = new Map();
    worker.onmessage = (e) => {
      const { id, type, buffer, width, height, error } = e.data;
      const pending = worker._pending.get(id);
      if (!pending) return;
      worker._pending.delete(id);
      if (type === "result") {
        const imageData = new ImageData(new Uint8ClampedArray(buffer), width, height);
        pending.resolve(imageData);
      } else {
        pending.reject(new Error(error));
      }
    };
    worker.onerror = (e) => {
      console.error("[FilterWorker] Error:", e.message);
    };
    workerPool.push(worker);
  }
};

/**
 * Terminate all workers and release the blob URL.
 * Call this when the feature is no longer needed to free resources.
 */
export const destroyWorkerPool = () => {
  for (const worker of workerPool) {
    worker.terminate();
  }
  workerPool.length = 0;
  workerRoundRobin = 0;
  if (workerBlobUrl) {
    URL.revokeObjectURL(workerBlobUrl);
    workerBlobUrl = null;
  }
};

/**
 * Extract pixel data from a source into a transferable ArrayBuffer.
 * Uses OffscreenCanvas when available for better performance.
 *
 * @param {HTMLImageElement|HTMLCanvasElement|ImageBitmap} source
 * @returns {{buffer: ArrayBuffer, width: number, height: number}}
 */
const extractPixelData = (source) => {
  const w = source.naturalWidth || source.width;
  const h = source.naturalHeight || source.height;

  let ctx;
  if (typeof OffscreenCanvas !== "undefined") {
    const offscreen = new OffscreenCanvas(w, h);
    ctx = offscreen.getContext("2d");
  } else {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    ctx = canvas.getContext("2d");
  }

  ctx.drawImage(source, 0, 0);
  const imageData = ctx.getImageData(0, 0, w, h);
  return { buffer: imageData.data.buffer, width: w, height: h };
};

/**
 * Apply a filter via the worker pool using transferable ArrayBuffer.
 * The buffer is transferred (zero-copy) to the worker.
 *
 * @param {ArrayBuffer} buffer - Raw RGBA pixel data (will be neutered after transfer)
 * @param {number} width
 * @param {number} height
 * @param {string} filter - Filter name from FILTER_OPTIONS
 * @returns {Promise<ImageData>} Filtered ImageData
 */
export const applyFilterViaWorker = (buffer, width, height, filter) => {
  initWorkerPool();
  const id = workerIdCounter++;
  const worker = workerPool[workerRoundRobin % workerPool.length];
  workerRoundRobin++;
  return new Promise((resolve, reject) => {
    worker._pending.set(id, { resolve, reject });
    worker.postMessage({ type: "apply", buffer, width, height, filter, id }, [buffer]);
  });
};

/**
 * Apply all available filters to a single source image in parallel via the worker pool.
 * Extracts pixel data once, then copies the buffer for each filter variant.
 * Returns an array of {filter, label, imageData} results.
 *
 * @param {HTMLImageElement|HTMLCanvasElement|ImageBitmap} source - The source image
 * @returns {Promise<Array<{filter: string, label: string, imageData: ImageData}>>}
 */
export const applyAllFilters = async (source) => {
  const { buffer: sourceBuffer, width, height } = extractPixelData(source);

  const results = await Promise.all(
    FILTER_OPTIONS.map(async (filter) => {
      if (filter === "none") {
        // No processing needed for "none" — just copy the source data
        const copy = new Uint8ClampedArray(sourceBuffer.byteLength);
        copy.set(new Uint8ClampedArray(sourceBuffer));
        const imageData = new ImageData(copy, width, height);
        return { filter, label: FILTER_LABELS[filter], imageData };
      }
      // Copy buffer for each filter (source stays valid for all variants)
      const copy = sourceBuffer.slice(0);
      const imageData = await applyFilterViaWorker(copy, width, height, filter);
      return { filter, label: FILTER_LABELS[filter], imageData };
    })
  );

  return results;
};

/**
 * Apply a single filter to an image via the worker pool.
 * Convenience wrapper for one-off filter application.
 *
 * @param {HTMLImageElement|HTMLCanvasElement|ImageBitmap} source - The source image
 * @param {string} filter - Filter name from FILTER_OPTIONS
 * @returns {Promise<ImageData>} Filtered ImageData
 */
export const applySingleFilter = async (source, filter) => {
  if (!filter || filter === "none") {
    const { buffer, width, height } = extractPixelData(source);
    return new ImageData(new Uint8ClampedArray(buffer), width, height);
  }
  const { buffer, width, height } = extractPixelData(source);
  return applyFilterViaWorker(buffer, width, height, filter);
};

/**
 * Apply a filter on the main thread (synchronous, for small images or fallback).
 * Returns a new canvas with the filtered result.
 *
 * @param {HTMLImageElement|HTMLCanvasElement} source
 * @param {string} filter
 * @returns {HTMLCanvasElement}
 */
export const applyFilterSync = (source, filter) => {
  const w = source.naturalWidth || source.width;
  const h = source.naturalHeight || source.height;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(source, 0, 0);

  if (filter && filter !== "none") {
    const imageData = ctx.getImageData(0, 0, w, h);
    applyFilterToImageData(imageData, filter);
    ctx.putImageData(imageData, 0, 0);
  }

  return canvas;
};

// --- Blob URL Management ---

let managedBlobUrls = [];

/**
 * Create an object URL from a blob and track it for later cleanup.
 * @param {Blob} blob
 * @returns {string} Object URL
 */
export const createTrackedBlobUrl = (blob) => {
  const url = URL.createObjectURL(blob);
  managedBlobUrls.push(url);
  return url;
};

/**
 * Revoke all tracked blob URLs to prevent memory leaks.
 */
export const revokeAllBlobUrls = () => {
  for (const url of managedBlobUrls) {
    URL.revokeObjectURL(url);
  }
  managedBlobUrls = [];
};

/**
 * Convert ImageData to a Blob (useful for download/export).
 * @param {ImageData} imageData
 * @param {string} mimeType - e.g. "image/png"
 * @returns {Promise<Blob>}
 */
export const imageDataToBlob = (imageData, mimeType = "image/png") => {
  let canvas;
  if (typeof OffscreenCanvas !== "undefined") {
    canvas = new OffscreenCanvas(imageData.width, imageData.height);
  } else {
    canvas = document.createElement("canvas");
    canvas.width = imageData.width;
    canvas.height = imageData.height;
  }
  const ctx = canvas.getContext("2d");
  ctx.putImageData(imageData, 0, 0);

  if (canvas.convertToBlob) {
    return canvas.convertToBlob({ type: mimeType });
  }
  // Fallback for regular canvas
  return new Promise((resolve) => canvas.toBlob(resolve, mimeType));
};

// Re-export for convenience
export { FILTER_OPTIONS, FILTER_LABELS };
