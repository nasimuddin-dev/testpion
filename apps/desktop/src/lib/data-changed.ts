import type { WatchKind } from '@testpion/shared';

/**
 * What a `data.changed` event says changed, for views that list workspace files. Every change to the workspace's files
 * says which kinds of file it touched (`kinds`, as the backend's folder watcher sorts them): an RPC that wrote files
 * (own-writes.ts: `{ method, kinds, paths }`), the app's background writes (`method: 'write'`) and changes made outside
 * the app (`method: 'disk'`) alike. Events without `kinds` wrote no file the watcher would report (a run's results, a
 * connection) — except the ones that replace everything at once (opening a workspace, git).
 */
export type FileKind = WatchKind;

export interface DataChangedEvent {
  method?: string;
  kind?: string;
  kinds?: string[];
  paths?: string[];
  collectionId?: string;
  collectionIds?: string[];
}

/** Changes that replace the whole workspace view: every list reads again. */
const EVERYTHING = /^(ws\.(open|import\w*|openExamples)|git)$/;

/** Did this change touch files of one of these kinds? (`workspace.json` changes count for every kind.) */
export function touchesFiles(e: DataChangedEvent | undefined, kinds: FileKind[]): boolean {
  if (!e) return true;
  if (e.kinds) return e.kinds.some((k) => k === 'workspace' || kinds.includes(k as FileKind));
  return !!e.method && EVERYTHING.test(e.method);
}
