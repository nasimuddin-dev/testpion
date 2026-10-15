import { useEffect, useRef } from 'react';
import { on } from '../api';
import { ask } from '../store';
import { followChanges, type ChangeKind, type ExternalChangeOptions } from './follow-changes';

/**
 * WF-15: open editors follow their item's file. When a pull, a branch switch or another editor changes files of the
 * workspace (the backend's watcher sends `workspace.changedOnDisk`), every editor that has one of those items open
 * reads its saved version again: an editor without unsaved edits takes it silently; one with unsaved edits asks the one
 * question — Keep mine (saving later replaces the new version) or Take the new version — once per item and change.
 * REST, GraphQL, gRPC, WebSocket, MCP servers and monitors use it; nothing else re-implements it.
 */

export type { ChangeKind, ExternalChangeOptions, FollowedItem } from './follow-changes';

/** The one question (exported for the tests of its wording): resolves to the choice. */
export async function askKeepOrTake(label: string): Promise<'mine' | 'theirs'> {
  const choice = await ask({
    title: `"${label}" changed on disk`,
    message: 'A pull, a branch switch or another editor changed it while you were editing it.',
    detail: 'Keep mine: your edits stay, and saving replaces the new version with them. Take the new version: your unsaved edits are dropped.',
    tone: 'warning',
    buttons: [
      { id: 'mine', label: 'Keep mine' },
      { id: 'theirs', label: 'Take the new version', variant: 'primary' },
    ],
    cancelId: 'mine',
  });
  return choice === 'theirs' ? 'theirs' : 'mine';
}

/**
 * Follow the open items of an editor (see the module comment). The options are read through a ref, so the newest
 * callbacks are used without re-subscribing; the listener goes away with the editor.
 */
export function useExternalChange<T>(opts: ExternalChangeOptions<T>): void {
  const latest = useRef(opts);
  latest.current = opts;
  useEffect(
    () =>
      on<{ kinds: string[] }>('workspace.changedOnDisk', (p) => {
        if (!p?.kinds?.some((k) => latest.current.kinds.includes(k as ChangeKind))) return;
        const o = latest.current;
        void followChanges({ items: () => latest.current.items(), read: (k) => o.read(k), take: (...a) => latest.current.take(...a), keep: (...a) => latest.current.keep(...a) }, askKeepOrTake).catch(
          () => undefined,
        );
      }),
    [],
  );
}
