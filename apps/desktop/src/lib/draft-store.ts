/**
 * Editor drafts in localStorage (`aps.draft.ws:<workspace>:<key>`, one set per workspace), written a moment after the last change instead of
 * on every keystroke: serialising every open tab (bodies, scripts) and writing it synchronously on each
 * key press made typing slower as tabs grew. Pending drafts are written when the window is hidden or
 * closed, so nothing typed is lost.
 */
import { beforeScopeChange, scopedKey } from './ws-scope';

const PREFIX = 'aps.draft.';
const DELAY_MS = 400;
// by storage key (workspace scope included): a pending write lands in the workspace it was made in
const pending = new Map<string, unknown>();
let timer: ReturnType<typeof setTimeout> | undefined;

/** The storage key of a draft in the open workspace, or undefined while no workspace is open. */
const storageKey = (key: string): string | undefined => {
  const k = scopedKey(key);
  return k && PREFIX + k;
};

function write(full: string, value: unknown): void {
  try {
    localStorage.setItem(full, JSON.stringify(value));
  } catch {
    /* quota or storage unavailable */
  }
}

/** Write every pending draft now. */
export function flushDrafts(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  for (const [full, value] of pending) write(full, value);
  pending.clear();
}

// switching workspace: what was typed in the old one is written under the old one
beforeScopeChange(flushDrafts);

export function saveDraft(key: string, value: unknown): void {
  const full = storageKey(key);
  if (!full) return; // no workspace open yet: nothing to save it under
  pending.set(full, value);
  timer ??= setTimeout(flushDrafts, DELAY_MS);
}

/**
 * The draft as last saved (a pending one included), or undefined. Drafts saved before they were kept per workspace
 * (one set for the whole window) move into the first workspace that asks for them: the one the window last had open.
 */
export function loadDraft<T>(key: string): T | undefined {
  const full = storageKey(key);
  if (!full) return undefined;
  if (pending.has(full)) return pending.get(full) as T;
  try {
    let s = localStorage.getItem(full);
    if (s === null) {
      const legacy = localStorage.getItem(PREFIX + key);
      if (legacy !== null) {
        localStorage.setItem(full, legacy);
        localStorage.removeItem(PREFIX + key);
        s = legacy;
      }
    }
    return s ? (JSON.parse(s) as T) : undefined;
  } catch {
    return undefined;
  }
}

/** Forget a draft of the open workspace (a closed tab, a reset editor): a pending write must not bring it back. */
export function dropDraft(key: string): void {
  const full = storageKey(key);
  if (!full) return;
  pending.delete(full);
  try {
    localStorage.removeItem(full);
  } catch {
    /* storage unavailable */
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushDrafts);
  window.addEventListener('beforeunload', flushDrafts);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushDrafts());
}
