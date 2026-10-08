import { useEffect } from 'react';
import { create } from 'zustand';
import { call, on } from '../api';
import type { Environment } from '../types';

/**
 * The workspace's environments, fetched once for the whole app (like lib/collections-store): the Environments
 * view, the dialogs that write into environments and the quick looks share this list, and it is fetched again
 * once after a burst of changes (`data.changed`: a save, a reorder, an import, git, the disk).
 */
const useStore = create<{ list: Environment[]; loaded: boolean }>(() => ({ list: [], loaded: false }));

let pending: Promise<Environment[]> | undefined;

/** Fetch the environments now (callers that just saved one can await the fresh list). */
export function refreshEnvironments(): Promise<Environment[]> {
  pending ??= call<Environment[]>('env.list')
    .then((list) => {
      // an unchanged list is not a new one: views keep their unsaved edits when a refresh brings the same environments
      const same = useStore.getState().loaded && JSON.stringify(list) === JSON.stringify(useStore.getState().list);
      useStore.setState({ list: same ? useStore.getState().list : list, loaded: true });
      return useStore.getState().list;
    })
    .catch(() => useStore.getState().list)
    .finally(() => (pending = undefined));
  return pending;
}

let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  // a burst of changes in one task is one refresh; changes that come while it runs are read once more after it
  let again = false;
  let running = false;
  const run = async () => {
    try {
      do {
        again = false;
        await (pending ? pending.then(() => refreshEnvironments()) : refreshEnvironments());
      } while (again);
    } finally {
      running = false;
    }
  };
  on('data.changed', () => {
    again = true;
    if (running) return;
    running = true;
    setTimeout(() => void run(), 0);
  });
}

/** The environments, kept up to date. */
export function useEnvironments(): Environment[] {
  const list = useStore((s) => s.list);
  useEffect(() => {
    wire();
    if (!useStore.getState().loaded) void refreshEnvironments();
  }, []);
  return list;
}

/** The list as it is now, without subscribing (event handlers). */
export const currentEnvironments = () => useStore.getState().list;
