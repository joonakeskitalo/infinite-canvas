/**
 * Connector Arrow Helpers
 *
 * Functions for managing connector arrows that attach to elements.
 */

import { state, spatialUpdate } from "./state.js";
import { findElementById, getElementBounds } from "./elements.js";

export function getConnectorAnchorPoint(conn) {
  if (!conn || !conn.elementId) return null;
  const el = findElementById(conn.elementId);
  if (!el) return null;
  const b = getElementBounds(el);
  return {
    x: b.x + b.w * conn.ratioX,
    y: b.y + b.h * conn.ratioY,
  };
}

export function computeAnchorRatio(worldPos, el) {
  const b = getElementBounds(el);
  const rx = b.w > 0 ? (worldPos.x - b.x) / b.w : 0.5;
  const ry = b.h > 0 ? (worldPos.y - b.y) / b.h : 0.5;
  return { ratioX: Math.max(0, Math.min(1, rx)), ratioY: Math.max(0, Math.min(1, ry)) };
}

export function getClosestConnectionPort(worldPos, el) {
  const b = getElementBounds(el);
  const ports = [
    { x: b.x + b.w / 2, y: b.y, ratioX: 0.5, ratioY: 0 },
    { x: b.x + b.w / 2, y: b.y + b.h, ratioX: 0.5, ratioY: 1 },
    { x: b.x, y: b.y + b.h / 2, ratioX: 0, ratioY: 0.5 },
    { x: b.x + b.w, y: b.y + b.h / 2, ratioX: 1, ratioY: 0.5 },
  ];
  let closest = ports[0];
  let minDist = Infinity;
  for (const p of ports) {
    const d = (p.x - worldPos.x) ** 2 + (p.y - worldPos.y) ** 2;
    if (d < minDist) { minDist = d; closest = p; }
  }
  return closest;
}

export function updateConnectorsForElements(elementIds) {
  const idSet = new Set(elementIds);
  for (const shape of state.drawings) {
    if (shape.type !== "connector") continue;
    let changed = false;
    if (shape.startConn && idSet.has(shape.startConn.elementId)) {
      const pt = getConnectorAnchorPoint(shape.startConn);
      if (pt) { shape.start.x = pt.x; shape.start.y = pt.y; changed = true; }
    }
    if (shape.endConn && idSet.has(shape.endConn.elementId)) {
      const pt = getConnectorAnchorPoint(shape.endConn);
      if (pt) { shape.end.x = pt.x; shape.end.y = pt.y; changed = true; }
    }
    if (changed) spatialUpdate(shape);
  }
}
