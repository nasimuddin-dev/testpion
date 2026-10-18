import { KIND_INFO, type KindId } from '@testpion/shared';
import { call } from '../api';
import { toastError, useApp } from '../store';
import { closeTabsFor } from '../components/EditorTabs';
import { focusRow } from '../components/TreeParts';

/** The note of a delete that went to Recently deleted (the one wording, after every such message). */
export const TRASH_NOTE = 'Recently deleted keeps it for 30 days';

/** What the message calls an item of a kind: "the MCP server", "the API definition", "the test file", "the folder". */
export function deletedNoun(kind: KindId): string {
  // the registry's label, lower-cased unless it starts with an acronym (API definition, MCP server, gRPC call, AI provider)
  return `the ${KIND_INFO[kind].label.replace(/^[A-Z](?=[a-z])/, (m) => m.toLowerCase())}`;
}

/**
 * Deletes that can be taken back (lib/undo.ts): no "Are you sure?" first; the item goes at once and the message says
 * so with Undo (8 s, Ctrl/Cmd+Z). Deletes that cannot be undone (git branches, secrets, cookies, history, runs, the
 * workspace, Delete for good) keep their confirmation. One helper, so every list behaves the same: the message is
 * "Deleted the <kind> “name”" from the item kinds registry (lib/node-menu.ts names rows the same way), the Recently
 * deleted note is one constant, and Undo puts the keyboard back on the restored row.
 */
export async function deleteWithUndo(
  o: {
    /** The delete itself (an RPC); it may return the undo (a list's ops know how to put their item back). */
    run(): unknown;
    /** Puts it back the way the delete took it (the same RPC with the snapshot, or Recently deleted's restore). */
    undo?(): unknown;
    /** It went to Recently deleted: the message says so (TRASH_NOTE). */
    trash?: boolean;
    /** Where else it can be found again, or what happened to what it held, after the message. */
    note?: string;
    /** The row's `data-node-id`: after Undo the keyboard is back on it (the row that had it is gone). */
    focus?: string;
  } & (
    | {
        /** What is deleted: its kind (the message's noun comes from the registry) and its name. */
        kind: KindId;
        name: string;
      }
    | {
        /** What is deleted, in words, where it is not an item of a kind ("the example “200 OK”"). */
        what: string;
      }
  ),
): Promise<boolean> {
  let undo = o.undo;
  try {
    const r = await o.run();
    if (!undo && typeof r === 'function') undo = r as () => unknown;
  } catch (e) {
    toastError(e);
    return false;
  }
  const back = undo;
  const what = 'what' in o ? o.what : `${deletedNoun(o.kind)} "${o.name}"`;
  const notes = [o.trash ? TRASH_NOTE : undefined, o.note].filter(Boolean);
  useApp.getState().toast(`Deleted ${what}${notes.map((n) => `. ${n}`).join('')}`, 'info', undefined, {
    undo: back && (o.focus ? async () => (await back(), focusRow(o.focus!)) : back),
    restored: `Restored ${what}`,
  });
  return true;
}

export type TrashedKind = 'collection' | 'environment' | 'dataset' | 'spec' | 'mcp-server';

/** Undo a delete that went to Recently deleted (any kind of the trash): its newest entry comes back. */
export async function restoreDeleted(kind: TrashedKind, itemId: string): Promise<{ id: string; name: string }> {
  const list = await call<Array<{ id: string; kind: string; itemId: string }>>('trash.list');
  const base = (s: string) => s.split(/[\\/]/).pop()!;
  const hit = list.find((t) => t.kind === kind && (t.itemId === itemId || (kind === 'dataset' && base(t.itemId) === base(itemId))));
  if (!hit) throw new Error('It is no longer in Recently deleted (Collections ▸ Recently deleted)');
  return call<{ id: string; name: string }>('trash.restore', { id: hit.id });
}

/** A list with `item` back at `index` (or the end), unless it is there already (an undo used twice, another window). */
export function putBack<T extends { id: string }>(list: T[], item: T, index: number): T[] {
  if (list.some((x) => x.id === item.id)) return list;
  const at = Math.max(0, Math.min(index, list.length));
  return [...list.slice(0, at), item, ...list.slice(at)];
}

/**
 * EX-G6: THE delete of an MCP server, wherever it is asked for (the sidebar's menu, the MCP tab's ⋯ menu): its tabs
 * close, it goes to Recently deleted (disconnected first), and Undo puts it back in its place in the list (the trash
 * keeps its config and position); one that was connected reconnects (a program not yet allowed opens its tab to ask).
 * `after` reloads the caller's list.
 */
export function deleteMcpServerWithUndo(server: { id: string; name: string }, o: { after(): unknown }): Promise<boolean> {
  let gone: { trashId: string; connected: boolean } | undefined;
  return deleteWithUndo({
    kind: 'mcp-server',
    name: server.name,
    trash: true,
    run: async () => {
      gone = await call<{ trashId: string; connected: boolean }>('mcp.deleteServer', { serverId: server.id });
      closeTabsFor([server.id]);
      await o.after();
    },
    undo: async () => {
      if (!gone) return;
      const back = await call<{ id: string }>('trash.restore', { id: gone.trashId });
      await o.after();
      // the keyboard back on its row (by the id the restore answered: a taken id gets a new one)
      focusRow(`mcp:${back.id}`);
      if (!gone.connected) return;
      const app = useApp.getState();
      await call('mcp.connect', { serverId: back.id, environment: app.environment }).then(
        () => o.after(),
        () => app.openIntent('mcp', { serverId: back.id, connect: true }),
      );
    },
  });
}
