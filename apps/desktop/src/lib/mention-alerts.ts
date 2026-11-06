/**
 * A comment that @mentions you arrives (a pull, a teammate's change on disk): a message says who asked and on what, with
 * the item one click away (and a system notification while the window is hidden). The comments already there when the
 * workspace opens are only noted, never announced; what was announced is kept per workspace on this computer.
 */
import type { ItemRef } from '@testpion/shared';
import { call, on } from '../api';
import { notifySystem, useApp } from '../store';

interface ForYou {
  id: string;
  by: string;
  text: string;
  /** A reply (to a comment of yours, when it has no mention of you). */
  replyTo?: string;
  mentions?: string[];
  ref: ItemRef;
}

const key = (ws: string) => `tp.mentions.seen.${ws}`;
const readSeen = (ws: string): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(key(ws)) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
};
const writeSeen = (ws: string, seen: Set<string>) => {
  try {
    localStorage.setItem(key(ws), JSON.stringify([...seen].slice(-500)));
  } catch {
    /* no storage (a private window): announced again next time */
  }
};

export function watchMentions(): () => void {
  let checking = false;
  const check = async (announce: boolean) => {
    const ws = useApp.getState().workspace?.id;
    if (!ws || checking) return;
    checking = true;
    try {
      const mine = await call<ForYou[]>('comments.open', { forMe: true });
      const seen = readSeen(ws);
      const fresh = mine.filter((c) => !seen.has(c.id));
      if (announce)
        for (const c of fresh.slice(0, 3)) {
          const text = `${c.by} ${c.replyTo && !c.mentions?.length ? 'answered your comment' : 'mentioned you'}: ${c.text.length > 90 ? `${c.text.slice(0, 90)}…` : c.text}`;
          useApp.getState().toast(text, 'info', { ref: c.ref });
          if (document.hidden) notifySystem('TestPion', text, { ref: c.ref, tag: `mention-${c.id}` });
        }
      if (fresh.length) writeSeen(ws, new Set([...seen, ...fresh.map((c) => c.id)]));
    } catch {
      /* no workspace yet, or not a git one: nothing to say */
    } finally {
      checking = false;
    }
  };
  // what is there when the workspace opens: noted, not announced
  void check(false);
  const offOpen = useApp.subscribe((s, prev) => {
    if (s.workspace?.id && s.workspace.id !== prev.workspace?.id) void check(false);
  });
  // a change from disk (a pull, another editor): the new ones are announced
  const offDisk = on('workspace.changedOnDisk', () => void check(true));
  // a pull, a merge or a switch made in the app (the watcher leaves those to git): the same
  const offGit = on('git.changed', () => void check(true));
  // a comment written in this app (by you): noted, never announced later
  const offOwn = on('comments.changed', () => void check(false));
  return () => {
    offOpen();
    offDisk();
    offGit();
    offOwn();
  };
}
