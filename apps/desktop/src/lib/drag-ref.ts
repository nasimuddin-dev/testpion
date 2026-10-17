import type React from 'react';
import { useEffect, useRef } from 'react';
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

/**
 * Mark a drag as carrying these items (the first one names the drag). Allows copy as well as the source's move. Every
 * source looks the same while dragged: a small chip with the item's name ("3 items" for several), never a snapshot of
 * the row (on Windows the OS keeps a row snapshot on screen when the row goes away mid-drag: the "ghost row" of
 * menus-uniform P0-1). Starts the drag session that ends every tree's drag state (`useDragSession`).
 */
export function setDragRefs(e: React.DragEvent | DragEvent, refs: ItemRef[], label?: string): void {
  const dt = e.dataTransfer;
  if (!dt || !refs.length) return;
  dt.setData(REF_MIME, JSON.stringify(refs));
  if (label && !dt.types.includes('text/plain')) dt.setData('text/plain', label);
  // a move inside the explorer stays a move; a drop elsewhere (the canvas) copies
  dt.effectAllowed = dt.effectAllowed === 'move' || dt.effectAllowed === 'copyMove' ? 'copyMove' : 'copy';
  setDragChip(dt, refs.length > 1 ? `${refs.length} items` : (label ?? '1 item'));
  beginDragSession();
}

/** The one drag image element (off screen, removed a frame after the drag starts: the browser has copied it by then). */
let chip: HTMLElement | undefined;
const nextFrame = (fn: () => void) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => fn()) : setTimeout(fn, 0));

function setDragChip(dt: DataTransfer, text: string): void {
  if (typeof document === 'undefined' || typeof dt.setDragImage !== 'function') return;
  chip?.remove();
  const el = document.createElement('div');
  el.textContent = text.length > 60 ? `${text.slice(0, 59)}…` : text;
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('data-drag-chip', '');
  Object.assign(el.style, {
    position: 'fixed',
    top: '-1000px',
    left: '-1000px',
    padding: '3px 10px',
    borderRadius: '6px',
    font: '12px system-ui, sans-serif',
    whiteSpace: 'nowrap',
    background: 'var(--panel2, #333)',
    color: 'var(--fg, #fff)',
    border: '1px solid var(--line, #555)',
    pointerEvents: 'none',
  });
  document.body.appendChild(el);
  chip = el;
  dt.setDragImage(el, 8, 8);
  nextFrame(() => {
    el.remove();
    if (chip === el) chip = undefined;
  });
}

/*
 * The drag session: while a drag is on, the window listens for its end in every form (a drop anywhere, a dragend, a
 * pointerdown or Esc after a drag that never ended, the window losing focus) and calls every tree's clear, so no tree
 * keeps a stale drag or drop highlight when the row that started it is gone.
 */
const clears = new Set<() => void>();
const END_EVENTS = ['dragend', 'drop', 'pointerdown', 'blur', 'keydown'] as const;
let listening = false;
const CAPTURE = { capture: true };

function endDragSession(e?: Event): void {
  if (e?.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape') return;
  // (capturing, the window also sees every element's blur: only its own counts)
  if (e?.type === 'blur' && e.target !== window) return;
  stopListening();
  for (const clear of [...clears]) clear();
}

function stopListening(): void {
  if (!listening || typeof window === 'undefined') return;
  listening = false;
  for (const t of END_EVENTS) window.removeEventListener(t, endDragSession, CAPTURE);
}

/** Start listening for the end of the drag (setDragRefs does; a source with its own data can call it too). */
export function beginDragSession(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  // capture phase: a drop target that stops the event (the trees do) cannot hide the end from the window; the
  // target's handler still runs after it with the drag state of its render
  for (const t of END_EVENTS) window.addEventListener(t, endDragSession, CAPTURE);
}

/** Call `clear` whenever a drag session ends. Returns the unsubscribe. */
export function onDragSessionEnd(clear: () => void): () => void {
  clears.add(clear);
  return () => void clears.delete(clear);
}

/** A component's drag state (`drag`, `dropAt`, a drop ring) is cleared whenever a drag session ends. */
export function useDragSession(clear: () => void): void {
  const ref = useRef(clear);
  ref.current = clear;
  useEffect(() => onDragSessionEnd(() => ref.current()), []);
}

/**
 * Run a drop's action after the drop event: the OS drag loop has ended by then, so a dialog, an editor that opens or
 * a tree that re-renders never runs inside it (the same pattern as running a menu item after the menu closed).
 */
export const deferDrop = (action: () => void): void => void setTimeout(action, 0);

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
