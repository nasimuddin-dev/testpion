/**
 * The flow designer's small helpers: canvas preferences kept per computer, and following the flow file on disk.
 */
import { useEffect, useRef } from 'react';
import type { FlowNode } from '@testpion/shared';
import { call } from '../api';
import { useApp } from '../store';
import { useExternalChange } from '../lib/external-change';

/** A canvas preference kept per computer (the minimap, snap to grid): not about a file, so not per workspace. */
export const pref = (key: string, fallback: boolean): boolean => {
  try {
    const v = localStorage.getItem(`aps.flow.${key}`);
    return v === null ? fallback : v === 'true';
  } catch {
    return fallback;
  }
};
export const savePref = (key: string, v: boolean) => {
  try {
    localStorage.setItem(`aps.flow.${key}`, String(v));
  } catch {
    // storage blocked: the choice lasts while the app runs
  }
};
export const COLOR_LABEL = (c: string) => c[0]!.toUpperCase() + c.slice(1);

/**
 * The flow file as the canvas last knew it (read when the designer opens, then each edit's answer: set `.current`
 * after an edit). The canvas has no unsaved state of its own (every change is saved at once), so a change on disk is
 * always taken: the flow is read again (TestsView follows the file too), and the undo history, made of texts of the
 * old file, is dropped — Undo must never write an old version over what changed on disk.
 */
export function useFlowFileFollow(file: string, history: { undo: string[]; redo: string[] }, rerender: () => void, savedText?: string) {
  const baseText = useRef<string | undefined>(undefined);
  // the Tests view's saved text of the file (its editor saved, or read it again): the app's own version, so the base
  useEffect(() => {
    if (savedText !== undefined) baseText.current = savedText;
  }, [savedText]);
  useEffect(() => {
    let alive = true;
    baseText.current = undefined;
    call<string>('tests.read', { path: file }).then(
      (t) => {
        if (alive && baseText.current === undefined) baseText.current = t;
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [file]);
  useExternalChange<string>({
    kinds: ['tests'],
    items: () => [{ key: file, label: `tests/${file}`, base: baseText.current, dirty: false }],
    read: async (keys) => {
      const out = new Map<string, { snapshot: string; value: string }>();
      for (const k of keys) {
        const text = await call<string>('tests.read', { path: k }).catch(() => undefined);
        if (text !== undefined) out.set(k, { snapshot: text, value: text });
      }
      return out;
    },
    take: (_key, text) => {
      baseText.current = text;
      const had = history.undo.length + history.redo.length;
      history.undo.length = 0;
      history.redo.length = 0;
      rerender();
      if (had) useApp.getState().toast(`tests/${file} changed on disk: the canvas shows the new version (Undo starts again from here)`, 'info', { ref: { kind: 'flow', path: file } });
    },
    keep: (_key, snapshot) => {
      baseText.current = snapshot;
    },
  });
  return baseText;
}

/** A parallel group name no step of the flow uses yet. */
export const newGroup = (steps: Array<{ parallel?: string }>) => {
  const used = new Set(steps.map((s) => s.parallel));
  let n = 1;
  while (used.has(`group-${n}`)) n++;
  return `group-${n}`;
};

/** Copied steps (Ctrl+C on the canvas), pasted into this or another flow with Ctrl+V (kept while the app runs, across flows). */
let copied: { file: string; ids: string[] } | undefined;
export const getCopied = () => copied;
export const setCopied = (c: { file: string; ids: string[] }) => {
  copied = c;
};

/** The distance between a step and the one added after it, in the diagram's units. */
export const GAP_X = 284;

/**
 * Line the selected steps up (left edges, top edges or centres), or space them evenly along the axis they spread most on:
 * their new places (top-left corners, rounded), or what to tell the person when the selection is too small.
 */
export function alignedPositions(nodes: FlowNode[], how: 'left' | 'top' | 'center' | 'distribute'): { positions: Record<string, [number, number]> } | { message: string } {
  if (nodes.length < 2) return { message: 'Select two or more steps to align them (Shift+click adds a step to the selection)' };
  const out: Record<string, [number, number]> = {};
  if (how === 'left') for (const n of nodes) out[n.id] = [Math.min(...nodes.map((x) => x.x)), n.y];
  else if (how === 'top') for (const n of nodes) out[n.id] = [n.x, Math.min(...nodes.map((x) => x.y))];
  else if (how === 'center') {
    const c = nodes.reduce((sum, x) => sum + x.x + x.w / 2, 0) / nodes.length;
    for (const n of nodes) out[n.id] = [c - n.w / 2, n.y];
  } else {
    if (nodes.length < 3) return { message: 'Select three or more steps to space them evenly' };
    const spreadX = Math.max(...nodes.map((n) => n.x)) - Math.min(...nodes.map((n) => n.x));
    const spreadY = Math.max(...nodes.map((n) => n.y)) - Math.min(...nodes.map((n) => n.y));
    const horizontal = spreadX >= spreadY;
    const sorted = [...nodes].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const step = ((horizontal ? last.x - first.x : last.y - first.y) as number) / (sorted.length - 1);
    sorted.forEach((n, i) => (out[n.id] = horizontal ? [first.x + step * i, n.y] : [n.x, first.y + step * i]));
  }
  return { positions: Object.fromEntries(Object.entries(out).map(([id, [x, y]]) => [id, [Math.round(x), Math.round(y)] as [number, number]])) };
}
