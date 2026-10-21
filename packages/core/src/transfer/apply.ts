/**
 * Apply an import: write the items the preview showed, as the conflict choices say, and keep a journal so one Undo
 * takes it all back. Nothing in a bundle runs: scripts are text, MCP servers that start a program stay untrusted
 * (storage/trust.ts is the user's), mocks are not started and no URL is fetched.
 *
 * Order: collections first (saved calls point at them), then environments, files, MCP servers, providers, saved items.
 * An item that gets a new id or path under "Keep both" is followed by the references to it in the items imported with it
 * (a monitor's collection, a contract check's API definition, a test's MCP server name) — items.ts `rewrite`.
 */
import { ApsError } from '../errors.js';
import type { ItemRef } from '@testpion/shared';
import { openRefOfBundleItem } from '../kinds/transfer-refs.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { itemKey, type BundleKindId, type ParsedBundle } from './format.js';
import { JournalWriter, undoImport } from './journal.js';
import type { CommitWrite, Remap, Target } from './items.js';
import { previewImport, type ImportChoice, type ImportPreview, type PreviewItem } from './preview.js';
import { adapter } from './registry.js';
import { hasVirtualFolders, placeInFolders } from './folders.js';
import { checkInto, commitInto, type ImportInto } from './into.js';
import { applyWorkspaceVariables, type VariableChoice, type WorkspaceVariablesOutcome } from './workspace-section.js';

export interface ApplyOptions {
  /** What to do with an item that clashes with the workspace's own (default Keep both). */
  onConflict?: ImportChoice;
  /** A choice per item (`kind:id`): `skip` leaves an item out whatever it is; `keep-both` / `replace` apply to conflicts. */
  decisions?: Record<string, ImportChoice | 'import'>;
  /** Only these: kinds (`spec`) or `kind:id` keys (`workspace` is the workspace's own variables). Everything else is left out. */
  only?: string[];
  /** Import here…: add the bundle's collection under this collection (or folder of it) instead of making a collection. */
  into?: ImportInto;
  /** The workspace's own variables (Globals) a bundle carries: `merge` adds the new keys (default), `replace` also takes the bundle's values, `skip` leaves them. */
  workspaceVariables?: VariableChoice;
}

export interface ItemOutcome {
  kind: BundleKindId;
  id: string;
  name: string;
  /** Where it is now, when it was written. */
  target?: Target;
  why?: string;
}

export interface ImportOutcome {
  importId: string;
  created: ItemOutcome[];
  replaced: ItemOutcome[];
  skipped: ItemOutcome[];
  title: string;
  requires: ImportPreview['requires'];
  review: string[];
  warnings: string[];
  /** The ref to open first: the bundle's first root that was written. */
  open?: ItemRef;
  /** What happened to the workspace's own variables (Globals), when the bundle carried some. */
  workspaceVariables?: WorkspaceVariablesOutcome;
  /** Files placed in a virtual folder (API definitions, datasets). */
  placedInFolders?: number;
  /** Import here…: the folders and requests added under the target, and the collection variables added with them. */
  addedUnder?: { where: string; nodes: number; variables: number };
}

/** Order the kinds are written in. */
const ORDER: BundleKindId[] = [
  'collection',
  'environment',
  'mcp-mock',
  'spec',
  'dataset',
  'proto',
  'script-package',
  'test',
  'mcp-server',
  'provider',
  'grpc-call',
  'ws-connection',
  'prompt',
  'load-test',
  'evaluation',
  'monitor',
];

const outcome = (i: PreviewItem, target?: Target, why?: string): ItemOutcome => ({ kind: i.kind, id: i.id, name: i.name, ...(target ? { target } : {}), ...(why ? { why } : {}) });

export function applyImport(store: WorkspaceStore, bundle: ParsedBundle, opts: ApplyOptions = {}): ImportOutcome {
  const preview = previewImport(store, bundle);
  const onConflict = opts.onConflict ?? 'keep-both';
  const only = opts.only?.length ? new Set(opts.only) : undefined;
  const entryOf = new Map(bundle.manifest.items.map((i) => [itemKey(i.kind, i.id), i]));

  const created: ItemOutcome[] = [];
  const replaced: ItemOutcome[] = [];
  const skipped: ItemOutcome[] = [];
  const remap: Remap = { collection: new Map(), path: new Map(), serverName: new Map(), serverId: new Map() };
  const plan: Array<{ p: PreviewItem; target: Target; op: 'created' | 'replaced' }> = [];
  // the target of Import here… must be there before anything is written
  const intoLabel = opts.into ? checkInto(store, opts.into).label : '';

  const note = (p: PreviewItem, target: Target) => {
    // references from the items imported with it follow it to where it is now
    if (p.kind === 'collection') remap.collection.set(p.id, target.id);
    else if (p.kind === 'mcp-server') {
      remap.serverId.set(p.id, target.id);
      remap.serverName.set(p.name, target.name);
    } else if (p.id !== target.id) remap.path.set(p.id, target.id);
  };

  for (const p of preview.items) {
    const key = itemKey(p.kind, p.id);
    if (p.action === 'invalid') {
      skipped.push(outcome(p, undefined, `refused: ${p.why}`));
      continue;
    }
    if (p.action === 'reference') {
      skipped.push(outcome(p, undefined, p.why));
      continue;
    }
    if (only && !only.has(p.kind) && !only.has(key)) {
      skipped.push(outcome(p, undefined, 'not selected'));
      if (p.existing) note(p, p.existing);
      continue;
    }
    const decided = opts.decisions?.[key];
    // Import here…: the bundle's collection is added under the target, whatever else is in the workspace
    if (opts.into && p.kind === 'collection' && decided !== 'skip') {
      plan.push({ p, target: { id: opts.into.collectionId, name: intoLabel }, op: 'created' });
      continue;
    }
    if (p.action === 'identical') {
      skipped.push(outcome(p, p.existing, 'already here, identical'));
      continue;
    }
    if (decided === 'skip' || (p.action === 'conflict' && !decided && onConflict === 'skip')) {
      skipped.push(outcome(p, p.existing, p.action === 'conflict' ? 'kept yours' : 'left out'));
      if (p.existing) note(p, p.existing);
      continue;
    }
    if (p.action === 'create') {
      plan.push({ p, target: { id: p.id, name: p.name }, op: 'created' });
      continue;
    }
    const choice = decided && decided !== 'import' ? decided : onConflict;
    if (choice === 'replace') {
      const ex = p.existing!;
      plan.push({ p, target: { id: ex.id, name: p.name }, op: 'replaced' });
      note(p, { id: ex.id, name: p.name });
    } else {
      plan.push({ p, target: p.proposed!, op: 'created' });
      note(p, p.proposed!);
    }
  }

  const journal = new JournalWriter(store, bundle.manifest.title);
  let variables: WorkspaceVariablesOutcome | undefined;
  let placedInFolders = 0;
  let into: { nodes: number; variables: number } | undefined;
  try {
    for (const kind of ORDER) {
      const rows = plan.filter((x) => x.p.kind === kind);
      if (!rows.length) continue;
      const a = adapter(kind);
      const writes: CommitWrite[] = rows.map(({ p, target, op }) => {
        const item = entryOf.get(itemKey(p.kind, p.id))!;
        return { incoming: item, data: a.rewrite(item, bundle.entries.get(item.entry!)!, remap), target, op };
      });
      if (kind === 'collection' && opts.into) into = commitInto(store, opts.into, writes, journal);
      else a.commit(store, writes, journal);
      // API definitions and datasets keep their folder outside the file: put them where the bundle had them
      if (hasVirtualFolders(kind)) placedInFolders += placeInFolders(store, writes.map((w) => ({ kind, id: w.target.id, folder: w.incoming.folder })), journal);
    }
    if (!only || only.has('workspace')) variables = applyWorkspaceVariables(store, bundle.manifest.workspace, opts.workspaceVariables ?? 'merge', (before) => journal.workspaceVariables(before));
    journal.save();
  } catch (e) {
    // a failure part-way leaves the workspace as it was
    try {
      undoImport(store, journal.journal.importId, journal.journal);
    } catch {
      /* the error below says what failed first */
    }
    throw e instanceof ApsError ? e : new ApsError('ValidationError', `The import stopped and was taken back: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const { p, target, op } of plan) (op === 'created' ? created : replaced).push(outcome(p, target));

  const rootKeys = new Set(bundle.manifest.root.map((r) => itemKey(r.kind, r.id)));
  const first = plan.find((x) => rootKeys.has(itemKey(x.p.kind, x.p.id))) ?? plan[0];
  const open = first ? openRefOfBundleItem(first.p.kind, first.target.id) : undefined;
  return {
    importId: journal.journal.importId,
    created,
    replaced,
    skipped,
    title: bundle.manifest.title,
    requires: preview.requires,
    review: preview.review,
    warnings: preview.warnings,
    ...(open ? { open } : {}),
    ...(variables ? { workspaceVariables: variables } : {}),
    ...(placedInFolders ? { placedInFolders } : {}),
    ...(into ? { addedUnder: { where: intoLabel, ...into } } : {}),
  };
}
