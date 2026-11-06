import { useEffect, useSyncExternalStore } from 'react';
import { itemRefIdentity, type ItemRef } from '@testpion/shared';
import { call, on } from '../api';
import { useApp } from '../store';

/**
 * How many open comments each item has (storage/comments.ts), shared by every row that shows a comment mark: read once
 * while a row is on screen, refreshed when a comment changes in this window (`comments.changed`) or on disk (a pull, the
 * CLI: `workspace.changedOnDisk`). One read for the whole tree, not one per row.
 */
let counts: Record<string, number> = {};
let users = 0;
let offs: Array<() => void> = [];
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

async function refresh(): Promise<void> {
  try {
    const next = await call<Record<string, number>>('comments.counts');
    const same = Object.keys(next).length === Object.keys(counts).length && Object.entries(next).every(([k, v]) => counts[k] === v);
    if (same) return;
    counts = next;
    listeners.forEach((l) => l());
  } catch {
    /* no workspace open: nothing to count */
  }
}

function start(): () => void {
  if (users++ === 0) {
    void refresh();
    offs = [
      on('comments.changed', () => void refresh()),
      on('workspace.changedOnDisk', () => void refresh()),
      // a pull made in the app
      on('git.changed', () => void refresh()),
      // another workspace: its own counts
      useApp.subscribe((s, prev) => void (s.workspace?.id !== prev.workspace?.id && refresh())),
    ];
  }
  return () => {
    if (--users === 0) offs.forEach((o) => o());
  };
}

/** The open comments on an item, for its row's mark (0 when none). */
export function useOpenCommentCount(ref: ItemRef): number {
  useEffect(() => start(), []);
  const key = itemRefIdentity(ref);
  return useSyncExternalStore(subscribe, () => counts[key] ?? 0);
}
