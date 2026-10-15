/**
 * The flow designer's small helpers: canvas preferences kept per computer, and following the flow file on disk.
 */
import { useEffect, useRef } from 'react';
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
