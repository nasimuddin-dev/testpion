import { KIND_INFO, gitFolderKey, type KindId } from '@testpion/shared';
import { sameValue } from '../storage/stable-files.js';
import type { SemanticChange } from './semantic.js';

/**
 * The libraries that only hold folders: `library/mcp-folders.json`, `library/spec-folders.json`,
 * `library/dataset-folders.json`. The things they sort (MCP servers, API definitions, datasets) live elsewhere, so a
 * change here is a change to a folder of that kind's list (a folder made, removed, a definition moved into it), and it
 * marks that folder and that section like any other change (planning/git-everything.md §4c, B-26b).
 */
export const FOLDER_LIBRARY_KIND: Readonly<Record<string, KindId>> = { 'mcp-folders': 'mcp-server', 'spec-folders': 'spec', 'dataset-folders': 'dataset' };

interface FolderLib {
  folders?: string[];
  items?: Array<{ id: string; folder?: string }>;
}

const parse = (text: string | undefined): FolderLib | undefined => {
  if (text === undefined) return { folders: [], items: [] };
  try {
    const v = JSON.parse(text) as FolderLib;
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
};

/** The folder changes of one folder library, or undefined when a side is not readable (the caller falls back to text). */
export function folderLibraryChanges(file: string, library: string, before: string | undefined, after: string | undefined): SemanticChange[] | undefined {
  const kind = FOLDER_LIBRARY_KIND[library];
  if (!kind) return undefined;
  const [a, b] = [parse(before), parse(after)];
  if (!a || !b) return undefined;
  const info = KIND_INFO[kind];
  const folderOf = (l: FolderLib) => new Map((l.items ?? []).map((i) => [i.id, i.folder ?? '']));
  const [fa, fb] = [new Set(a.folders ?? []), new Set(b.folders ?? [])];
  const out: SemanticChange[] = [];
  const own = (folder: string) => (folder ? [gitFolderKey(kind, folder)] : []);
  const row = (c: Pick<SemanticChange, 'change' | 'title' | 'details' | 'containers'> & Partial<SemanticChange>): SemanticChange => ({ file, kind, kindId: kind, ...c });
  for (const f of fb) if (!fa.has(f)) out.push(row({ change: 'added', title: `${info.label} folder ${f}`, details: [], containers: own(f) }));
  for (const f of fa) if (!fb.has(f)) out.push(row({ change: 'removed', title: `${info.label} folder ${f}`, details: [], containers: own(f) }));
  // an API definition or a dataset moved into / out of a folder: the item and both folders show it
  const [ma, mb] = [folderOf(a), folderOf(b)];
  for (const [id, folder] of mb) {
    const was = ma.get(id) ?? '';
    if (was === folder) continue;
    const ref = kind === 'spec' ? ({ kind: 'spec', path: id } as const) : kind === 'dataset' ? ({ kind: 'dataset', name: id } as const) : undefined;
    out.push(row({ change: 'changed', title: `${info.label} ${id}`, details: [folder ? `moved to folder ${folder}` : `moved out of folder ${was}`], itemId: id, ...(ref ? { ref } : {}), containers: [...own(was), ...own(folder)] }));
  }
  for (const [id, was] of ma) if (!mb.has(id) && was) out.push(row({ change: 'changed', title: `${info.label} ${id}`, details: [`left folder ${was}`], itemId: id, containers: own(was) }));
  if (out.length) return out;
  return sameValue(a, b) ? [] : [row({ change: 'changed', title: info.plural, details: ['order or formatting'], containers: [] })];
}
