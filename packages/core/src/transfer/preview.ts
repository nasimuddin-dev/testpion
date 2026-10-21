/**
 * The import preview: for each item of a bundle, what importing it would do here — create it, skip it because it is
 * already here (identical), or a conflict with the workspace's own item (with the id and name "Keep both" would give it).
 * Nothing is written. The same answer feeds the app's dialog, `testpion import --preview --json` and the MCP tool, and
 * `applyImport` re-reads it, so what was shown is what is done.
 */
import { SecretStripper } from '../storage/bundle-secrets.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { type BundleItem, type BundleKindId, type BundleManifest, type ParsedBundle } from './format.js';
import { fingerprint, type Listed, type Target } from './items.js';
import { cachedReads } from './read-cache.js';
import { adapter } from './registry.js';

export type ImportChoice = 'keep-both' | 'replace' | 'skip';

export interface PreviewItem {
  kind: BundleKindId;
  id: string;
  name: string;
  /** `create`: not here yet · `identical`: already here, byte for byte · `conflict`: something else is here · `invalid`: refused (why) · `reference`: a dataset sent by reference */
  action: 'create' | 'identical' | 'conflict' | 'invalid' | 'reference';
  /** The workspace's own item it clashes with or equals. */
  existing?: Target;
  /** What "Keep both" gives the incoming item. */
  proposed?: Target;
  why?: string;
  size?: number;
  summary?: BundleItem['summary'];
  /** What to look at before running it. */
  review: string[];
}

export interface ImportPreview {
  title: string;
  source: ParsedBundle['source'];
  createdBy: BundleManifest['createdBy'];
  createdAt: string;
  formatVersion: number;
  items: PreviewItem[];
  totals: { create: number; identical: number; conflict: number; invalid: number; reference: number; bytes: number };
  /** Variables the exporter replaced secrets with: fill them in after the import (`defined`: an environment here already has it). */
  requires: { secrets: Array<{ name: string; where: string; defined: boolean }>; osEnv: string[] };
  /** Scripts that will run when you send requests, programs MCP servers start, production environments: nothing runs on import. */
  review: string[];
  warnings: string[];
  notes: string[];
  missing: BundleManifest['missing'];
}

/** The id and name of the counterpart, for display. */
const asTarget = (l: Listed): Target => ({ id: l.id, name: l.name });

export function previewImport(realStore: WorkspaceStore, bundle: ParsedBundle): ImportPreview {
  // a preview only reads: each library, environment list and collection is read once for all the items that ask for it
  const store = cachedReads(realStore);
  const lists = new Map<BundleKindId, Listed[]>();
  const listOf = (k: BundleKindId): Listed[] => {
    let l = lists.get(k);
    if (!l) lists.set(k, (l = adapter(k).list(store)));
    return l;
  };
  const taken = new Map<BundleKindId, { ids: Set<string>; names: Set<string> }>();
  const takenOf = (k: BundleKindId) => {
    let t = taken.get(k);
    if (!t) taken.set(k, (t = { ids: new Set(), names: new Set() }));
    return t;
  };
  const items: PreviewItem[] = [];
  const review = new Set<string>();
  const totals = { create: 0, identical: 0, conflict: 0, invalid: 0, reference: 0, bytes: 0 };
  for (const it of bundle.manifest.items) {
    const a = adapter(it.kind);
    const base = { kind: it.kind, id: it.id, name: it.name, ...(it.size !== undefined ? { size: it.size } : {}), ...(it.summary ? { summary: it.summary } : {}) };
    if (it.mode === 'reference') {
      items.push({ ...base, action: 'reference', review: [], why: 'The file is not in the bundle: copy it to the other workspace by hand.' });
      totals.reference++;
      continue;
    }
    const data = bundle.entries.get(it.entry!)!;
    const problem = a.check(it, data);
    if (problem) {
      items.push({ ...base, action: 'invalid', why: problem, review: [] });
      totals.invalid++;
      continue;
    }
    const rev = a.review(it, data);
    for (const r of rev) review.add(r);
    totals.bytes += data.length;
    const match = a.match(listOf(it.kind), { id: it.id, name: it.name });
    if (!match) {
      items.push({ ...base, action: 'create', review: rev });
      totals.create++;
      continue;
    }
    const mine = a.snapshot(store, match.id, new SecretStripper());
    if (match.id === it.id && fingerprint(mine) === it.sha256) {
      items.push({ ...base, action: 'identical', existing: asTarget(match), review: rev });
      totals.identical++;
      continue;
    }
    // "Replace" over a provider or server at another address would send what the person's setup sends to a new place
    const moves = a.reviewAgainst?.(store, match.id, it, data) ?? [];
    for (const r of moves) review.add(r);
    items.push({ ...base, action: 'conflict', existing: asTarget(match), proposed: a.fresh(listOf(it.kind), { id: it.id, name: it.name }, takenOf(it.kind)), review: [...rev, ...moves] });
    totals.conflict++;
  }
  const defined = new Set<string>([...(store.workspace.variables ?? []).map((v) => v.key), ...store.listEnvironments().flatMap((e) => e.variables.map((v) => v.key))]);
  const m = bundle.manifest;
  for (const p of m.flags.production) review.add(`Environment "${p}" is marked production: data-changing requests to it ask first`);
  return {
    title: m.title,
    source: bundle.source,
    createdBy: m.createdBy,
    createdAt: m.createdAt,
    formatVersion: m.formatVersion,
    items,
    totals,
    requires: { secrets: m.requires.secrets.map((s) => ({ ...s, defined: defined.has(s.name) })), osEnv: m.requires.osEnv },
    review: [...review].slice(0, 100),
    warnings: bundle.warnings,
    notes: m.notes,
    missing: m.missing,
  };
}
