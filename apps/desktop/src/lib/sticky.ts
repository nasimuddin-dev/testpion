import { useCallback, useRef, useState, type SetStateAction } from 'react';

/**
 * Component state that survives unmounting (switching tabs, servers or views) for the rest of the
 * session. Kept in memory only, never written to disk: it may hold responses with secrets.
 */
const memory = new Map<string, unknown>();

const STORE = 'aps.sticky.';
const stored = <T,>(key: string): T | undefined => {
  try {
    const v = localStorage.getItem(STORE + key);
    return v === null ? undefined : (JSON.parse(v) as T);
  } catch {
    return undefined;
  }
};

/** Forget kept values (memory and disk), e.g. those of a tab that was closed. */
export function forgetStickyKeys(keys: string[]): void {
  for (const k of keys) {
    memory.delete(k);
    try {
      localStorage.removeItem(STORE + k);
    } catch {
      /* storage unavailable */
    }
  }
}

/**
 * `persist`: also keep it across restarts (on disk, in the window's storage). Only for small values that hold no
 * secrets, such as which saved item a tab shows, or a tab's own title.
 */
export function useSticky<T>(key: string, initial: T | (() => T), opts: { persist?: boolean } = {}): [T, (v: SetStateAction<T>) => void] {
  if (opts.persist && !memory.has(key)) {
    const v = stored<T>(key);
    if (v !== undefined) memory.set(key, v);
  }
  const [value, setValue] = useState<T>(() => (memory.has(key) ? (memory.get(key) as T) : typeof initial === 'function' ? (initial as () => T)() : initial));
  // a different key (another server or tool) starts from what was kept for it
  const [shownKey, setShownKey] = useState(key);
  let current = value;
  if (shownKey !== key) {
    current = memory.has(key) ? (memory.get(key) as T) : typeof initial === 'function' ? (initial as () => T)() : initial;
    setShownKey(key);
    setValue(current);
  }
  const set = useCallback(
    (v: SetStateAction<T>) =>
      setValue((prev) => {
        const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
        memory.set(key, next);
        if (opts.persist)
          try {
            if (next === undefined) localStorage.removeItem(STORE + key);
            else localStorage.setItem(STORE + key, JSON.stringify(next));
          } catch {
            /* storage unavailable */
          }
        return next;
      }),
    [key, opts.persist],
  );
  return [current, set];
}

/**
 * How a setting is stored under its own localStorage key: JSON by default, or the plain string (`text`), or a custom
 * `parse` (what is stored → the value, or undefined to use the initial one) and `stringify`.
 */
export interface PersistFormat<T> {
  text?: boolean;
  parse?(raw: string): T | undefined;
  stringify?(v: T): string;
}

/** Read a setting kept under its own key (see usePersisted); `initial` when there is none or it cannot be read. */
export function readPersisted<T>(key: string, initial: T | (() => T), fmt: PersistFormat<T> = {}): T {
  const init = () => (typeof initial === 'function' ? (initial as () => T)() : initial);
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return init();
    const v = fmt.parse ? fmt.parse(raw) : fmt.text ? (raw as unknown as T) : (JSON.parse(raw) as T);
    return v === undefined ? init() : v;
  } catch {
    return init();
  }
}

/** Write a setting under its own key (see usePersisted); storage that is unavailable is ignored. */
export function writePersisted<T>(key: string, v: T, fmt: PersistFormat<T> = {}): void {
  try {
    localStorage.setItem(key, fmt.stringify ? fmt.stringify(v) : fmt.text ? String(v) : JSON.stringify(v));
  } catch {
    /* storage unavailable: the choice lasts this session */
  }
}

/**
 * A small UI setting (a pane, a width, what is collapsed) kept under its own localStorage key: read once when the
 * component mounts, written on every change. Never for secrets or responses. Unlike useSticky, the key is used as
 * it is (settings older than useSticky keep their keys and formats).
 */
export function usePersisted<T>(key: string, initial: T | (() => T), fmt: PersistFormat<T> = {}): [T, (v: SetStateAction<T>) => void] {
  const [value, setValue] = useState<T>(() => readPersisted(key, initial, fmt));
  const format = useRef(fmt);
  format.current = fmt;
  const set = useCallback(
    (v: SetStateAction<T>) =>
      setValue((prev) => {
        const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
        writePersisted(key, next, format.current);
        return next;
      }),
    [key],
  );
  return [value, set];
}
