/**
 * Filter Preview System
 * Web Worker pool for off-main-thread pixel processing, plus utilities
 * for applying filters to images and exporting results.
 *
 * This file handles the worker pool and filter application pipeline.
 * Grid/overlay UI is intentionally NOT included here.
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
      const { id, type, blob, error } = e.data;
      const pending = worker._pending.get(id);
      if (!pending) return;
      worker._pending.delete(id);
      if (type === "result") pending.resolve(blob);
      else pending.reject(new Error(error));
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
 * Apply a filter to an ImageBitmap via the worker pool.
 * The bitmap is transferred (zero-copy) to the worker and cannot be used after this call.
 *
 * @param {ImageBitmap} imageBitmap - Source image (will be closed by the worker)
 * @param {string} filter - Filter name from FILTER_OPTIONS
 * @returns {Promise<Blob>} PNG blob of the filtered image
 */
export const applyFilterViaWorker = (imageBitmap, filter) => {
  initWorkerPool();
  const id = workerIdCounter++;
  const worker = workerPool[workerRoundRobin % workerPool.length];
  workerRoundRobin++;
  return new Promise((resolve, reject) => {
    worker._pending.set(id, { resolve, reject });
    worker.postMessage({ type: "apply", imageBitmap, filter, id }, [imageBitmap]);
  });
};

// --- Bitmap Utilities ---

/**
 * Clone an ImageBitmap without re-decoding the source.
 * @param {ImageBitmap} sourceBitmap
 * @returns {Promise<ImageBitmap>}
 */
export const cloneBitmap = (sourceBitmap) => {
  const canvas = new OffscreenCanvas(sourceBitmap.width, sourceBitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(sourceBitmap, 0, 0);
  return createImageBitmap(canvas);
};

/**
 * Apply all available filters to a single source image in parallel via the worker pool.
 * Returns an array of {filter, blob} results.
 *
 * @param {HTMLImageElement|ImageBitmap} source - The source image
 * @returns {Promise<Array<{filter: string, label: string, blob: Blob}>>}
 */
export const applyAllFilters = async (source) => {
  const sourceBitmap = source instanceof ImageBitmap
    ? source
    : await createImageBitmap(source);

  const results = await Promise.all(
    FILTER_OPTIONS.map(async (filter) => {
      const bitmap = await cloneBitmap(sourceBitmap);
      const blob = await applyFilterViaWorker(bitmap, filter);
      return { filter, label: FILTER_LABELS[filter], blob };
    })
  );

  // Close the source bitmap if we created it
  if (!(source instanceof ImageBitmap)) {
    sourceBitmap.close();
  }

  return results;
};

/**
 * Apply a single filter to an image and return the result as a Blob.
 * Convenience wrapper for one-off filter application.
 *
 * @param {HTMLImageElement|ImageBitmap} source - The source image
 * @param {string} filter - Filter name from FILTER_OPTIONS
 * @returns {Promise<Blob>} PNG blob of the filtered image
 */
export const applySingleFilter = async (source, filter) => {
  const sourceBitmap = source instanceof ImageBitmap
    ? source
    : await createImageBitmap(source);

  const bitmap = await cloneBitmap(sourceBitmap);

  if (!(source instanceof ImageBitmap)) {
    sourceBitmap.close();
  }

  return applyFilterViaWorker(bitmap, filter);
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

// Re-export for convenience
export { FILTER_OPTIONS, FILTER_LABELS };
