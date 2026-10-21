import { templatedText, type ItemRef } from '@testpion/shared';
import type { CollectionNode, RunSummary } from '../model/types.js';
import { readRunSummary } from '../runner/run-records.js';
import { requestIdOfResult, testsPathOf } from '../runner/result-source.js';
import { resolveItemRef } from './item-refs.js';
import { parseYaml } from '../util/lazy-yaml.js';
import type { WorkspaceStore } from './workspace.js';

/** What the context panel (WF-20) and agents show about one item: where it is kept, its text for variable lookup, the runs that included it. */
interface ItemInfo {
  ref: ItemRef;
  label: string;
  detail?: string;
  /** The workspace file that holds it (git status, external changes); none for items outside files. */
  file?: string;
  /** The item's own text (a request's definition, a test file), where its {{variables}} are read from; at most 200 kB. */
  text?: string;
  /** The collection whose variables are in scope (a request, a folder, a collection). */
  collectionId?: string;
  /** The latest runs that included it, newest first (at most `runs`). */
  runs: Array<{ runId: string; name: string; startedAt: string; passed: number; failed: number; errors: number; total: number; environment?: string }>;
}

const MAX_TEXT = 200_000;
const findNode = (nodes: CollectionNode[], id: string): CollectionNode | undefined => {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.kind === 'folder') {
      const f = findNode(n.items, id);
      if (f) return f;
    }
  }
  return undefined;
};

/** A test or flow file's templated text, as for a request (`templatedText`: scripts and descriptions left out); unparsable: the file as it is. */
export function templatedFileText(path: string, raw: string): string {
  try {
    return templatedText(path.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw));
  } catch {
    return raw;
  }
}

/**
 * One item's context: its file, its text (for the variables it uses) and the runs that included it — a test file by
 * the files a run kept, a request or collection by a collection run's origin. Reads the newest `scan` runs at most.
 */
export function itemInfo(store: WorkspaceStore, value: ItemRef, opts: { runs?: number; scan?: number } = {}): ItemInfo {
  const r = resolveItemRef(store, value);
  if (!r.ok) return { ref: r.ref, label: r.message, runs: [] };
  const ref = r.ref;
  const out: ItemInfo = { ref, label: r.label, ...(r.detail ? { detail: r.detail } : {}), runs: [] };
  let matches: ((s: RunSummary) => boolean) | undefined;
  if (ref.kind === 'request' || ref.kind === 'folder' || ref.kind === 'collection') {
    out.collectionId = ref.collectionId;
    out.file = store.collectionFileOf(ref.collectionId);
    const c = store.getCollection(ref.collectionId);
    const node = ref.kind === 'collection' ? undefined : findNode(c.items, ref.kind === 'request' ? ref.requestId : ref.folderId);
    // only what is templated when it is sent: a {{name}} in a script (a visualizer's {{#each items}}…) is not a variable used
    out.text = templatedText(node ?? { variables: c.variables, auth: (c as { auth?: unknown }).auth }).slice(0, MAX_TEXT);
    const id = ref.kind === 'request' ? ref.requestId : undefined;
    matches = (s) =>
      s.origin?.kind === 'collection' && s.origin.collectionId === ref.collectionId && (!id || !s.origin.selection?.length || s.origin.selection.some((x) => requestIdOfResult(x) === id));
  } else if (ref.kind === 'test' || ref.kind === 'flow') {
    out.file = `tests/${ref.path}`;
    try {
      out.text = templatedFileText(ref.path, store.readTestFile(ref.path)).slice(0, MAX_TEXT);
    } catch {
      /* unreadable: no variables */
    }
    // a run of the file, of a folder it is in, or of all tests
    const holds = (p: string) => {
      const rel = (testsPathOf(store, p) ?? p).replace(/\/+$/, '');
      return rel === '.' || rel === '' || rel === ref.path || ref.path.startsWith(`${rel}/`);
    };
    matches = (s) => (s.origin?.kind === 'tests' ? s.origin.paths : (s.files ?? [])).some(holds);
  } else if (ref.kind === 'spec') out.file = ref.path;
  else if (ref.kind === 'dataset') out.file = `datasets/${ref.name}`;
  else if (ref.kind === 'environment' && ref.environmentId) {
    try {
      out.file = store.environmentFileOf(ref.environmentId);
    } catch {
      /* gone */
    }
  }
  if (matches) {
    for (const row of store.meta.listRuns({ limit: opts.scan ?? 60 }).items) {
      const s = readRunSummary(store, row.id);
      if (!s || !matches(s)) continue;
      out.runs.push({
        runId: s.runId,
        name: s.name,
        startedAt: s.startedAt,
        passed: s.passed,
        failed: s.failed,
        errors: s.errors,
        total: s.total,
        ...(s.environment ? { environment: s.environment } : {}),
      });
      if (out.runs.length >= (opts.runs ?? 5)) break;
    }
  }
  return out;
}
