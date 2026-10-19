/**
 * The workspace's RAG targets (`library/rag-targets.json`, the same library mechanism as saved evaluations and prompts):
 * list, find by id or name, save. Reading never changes the file.
 */
import type { RagTarget } from '@testpion/shared';
import { ApsError } from '../../errors.js';
import { shortId } from '../../util/ids.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { targetProblems } from './run-target.js';

export const RAG_TARGETS_LIBRARY = 'rag-targets';

export interface RagTargetInfo {
  id: string;
  name: string;
  folder?: string;
  protocol: RagTarget['protocol'];
  description?: string;
  readOnly: boolean;
  /** What stops it from being called (empty when it can be). */
  problems: string[];
  /** The mapping in one line, for lists: `answer $.answer · 3 context fields`. */
  mapped: string;
}

const mappedLine = (t: RagTarget) => [t.mapping?.answer ? `answer ${t.mapping.answer}` : 'no answer path', t.mapping?.contexts ? `contexts ${t.mapping.contexts}` : 'no contexts'].join(' · ');

export function listRagTargets(store: WorkspaceStore): RagTargetInfo[] {
  return store.getLibrary<RagTarget>(RAG_TARGETS_LIBRARY).items.map((i) => ({
    id: i.id,
    name: i.name,
    ...(i.folder ? { folder: i.folder } : {}),
    protocol: i.data?.protocol,
    ...(i.data?.description ? { description: i.data.description } : {}),
    readOnly: i.data?.readOnly === true,
    problems: targetProblems(i.data),
    mapped: mappedLine(i.data ?? ({} as RagTarget)),
  }));
}

/** A target by id or name (case-insensitive). */
export function findRagTarget(store: WorkspaceStore, ref: string): RagTarget & { id: string; name: string } {
  const items = store.getLibrary<RagTarget>(RAG_TARGETS_LIBRARY).items;
  const r = ref.toLowerCase();
  const it = items.find((i) => i.id === ref) ?? items.find((i) => i.name.toLowerCase() === r);
  if (!it) throw new ApsError('ConfigurationError', `No RAG target "${ref}". Saved: ${items.map((i) => i.name).join(', ') || 'none'}`, { suggestions: ['Connect one in the app: AI Lab ▸ RAG ▸ Connect a RAG system.', 'List them with `testpion rag targets`.'] });
  return { ...it.data, id: it.id, name: it.name };
}

/** Save a target (a new one, or the one with `id`). */
export function saveRagTarget(store: WorkspaceStore, o: { id?: string; name: string; folder?: string; target: RagTarget }): { id: string; name: string } {
  const lib = store.getLibrary<RagTarget>(RAG_TARGETS_LIBRARY);
  const id = o.id ?? shortId('rag-');
  const item = { id, name: o.name, ...(o.folder ? { folder: o.folder } : {}), data: o.target, updatedAt: new Date().toISOString() };
  const exists = lib.items.some((i) => i.id === id);
  store.saveLibrary(RAG_TARGETS_LIBRARY, { folders: lib.folders, items: exists ? lib.items.map((i) => (i.id === id ? item : i)) : [...lib.items, item] });
  return { id, name: o.name };
}
