import type React from 'react';
import { itemRefKey, toItemRef, type ItemRef } from '@testpion/shared';

/**
 * Dragging items between parts of the app: every draggable item (a request in the explorer, a folder, a saved gRPC
 * call, a History entry, a Debugger exchange, a test file) carries its ItemRef under one type, so a drop target (the
 * flow canvas, a collection) needs to know nothing about where the drag started. Sources keep their own private
 * types too (moving inside the explorer); this one is added beside them.
 */
export const REF_MIME = 'application/x-testpion-refs';
/** A block from the flow canvas palette (a new step of that kind), not an existing item. */
export const BLOCK_MIME = 'application/x-testpion-block';

/** Mark a drag as carrying these items (the first one names the drag). Allows copy as well as the source's move. */
export function setDragRefs(e: React.DragEvent | DragEvent, refs: ItemRef[], label?: string): void {
  const dt = e.dataTransfer;
  if (!dt || !refs.length) return;
  dt.setData(REF_MIME, JSON.stringify(refs));
  if (label && !dt.types.includes('text/plain')) dt.setData('text/plain', label);
  // a move inside the explorer stays a move; a drop elsewhere (the canvas) copies
  dt.effectAllowed = dt.effectAllowed === 'move' || dt.effectAllowed === 'copyMove' ? 'copyMove' : 'copy';
}

/** Whether a drag carries items (readable during dragover: only the types are, not the data). */
export const hasDragRefs = (e: React.DragEvent | DragEvent): boolean => !!e.dataTransfer?.types.includes(REF_MIME);

/** The items of a drop, validated (anything that is not a well-formed ref is left out, duplicates once). */
export function readDragRefs(e: React.DragEvent | DragEvent): ItemRef[] {
  try {
    const raw = JSON.parse(e.dataTransfer?.getData(REF_MIME) || '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: ItemRef[] = [];
    for (const v of raw.slice(0, 500)) {
      const ref = toItemRef(v);
      if (!ref) continue;
      const k = itemRefKey(ref);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(ref);
    }
    return out;
  } catch {
    return [];
  }
}

/** Mark a drag as a palette block of this kind (http, condition, delay …). */
export function setDragBlock(e: React.DragEvent | DragEvent, kind: string, label: string): void {
  const dt = e.dataTransfer;
  if (!dt) return;
  dt.setData(BLOCK_MIME, kind);
  dt.setData('text/plain', label);
  dt.effectAllowed = 'copy';
}

export const hasDragBlock = (e: React.DragEvent | DragEvent): boolean => !!e.dataTransfer?.types.includes(BLOCK_MIME);
export const readDragBlock = (e: React.DragEvent | DragEvent): string | undefined => e.dataTransfer?.getData(BLOCK_MIME) || undefined;
