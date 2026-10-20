/**
 * Applying a proposal (AIB-4): the items the person (or an agent, after asking) chose, through the workspace's own
 * writers — test files with `writeTestFile`, collections with `saveCollection` — so the folder watcher, git and the
 * other windows see an ordinary save (the app's own-writes reporting included). What each item replaced is kept with
 * the proposal, so `undoProposal` puts it back.
 *
 * Applying writes files only: nothing is sent and nothing runs, so the production guard is not involved; running what
 * was applied stays a separate step under the guard.
 */
import { existsSync, readFileSync } from 'node:fs';
import { atomicWrite } from '../storage/fsutil.js';
import type { CheckConfig, Collection, CollectionNode, SavedHttpRequest } from '../model/types.js';
import { ApsError } from '../errors.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { shortId } from '../util/ids.js';
import { noteProposalOutcome } from '../storage/ai-usage.js';
import { checkedTestFilePath } from '../storage/test-path.js';
import { getProposal, saveProposal, type Proposal, type ProposalItem, type ProposalUndo } from './proposal.js';
import { findEnvironment, setEnvironmentVariables, unsetEnvironmentVariables } from '../storage/env-edit.js';
import { applyTidyOps, type TidyOp } from './tidy-import.js';
import { applyFlowEdit } from '../runner/flow-edit.js';
import { applyPatchOps, isJsonSpec, type PatchOp } from '../openapi/spec-patch.js';
import { stepOfResult } from './run-evidence.js';
import { readMetricFile, removeMetricFile, writeMetricFile } from '../storage/metric-files.js';
import { parseCustomMetric } from '../eval/rag/custom/file.js';

/** The text a fix was made from (`data.fix.base`): a file or script that changed since is not overwritten. */
function assertUnchanged(item: ProposalItem, current: string | null | undefined): void {
  const base = (item.data as { fix?: { base?: string } } | undefined)?.fix?.base;
  if (base !== undefined && (current ?? '').replace(/\r\n/g, '\n') !== base.replace(/\r\n/g, '\n'))
    throw new ApsError('ConfigurationError', `"${item.title}": it changed since the proposal was made`, { suggestions: ['Run the analysis again, so the change is made from what is there now.'] });
}

export interface ApplyResult {
  id: string;
  applied: Array<{ item: string; kind: ProposalItem['kind']; title: string; path?: string; target?: ProposalItem['target'] }>;
  skipped: Array<{ item: string; reason: string }>;
  /** `testpion ai undo <id>` / `ai.undoProposal` puts back what was replaced. */
  undo: boolean;
}

type Located = { node: CollectionNode; list: CollectionNode[]; index: number; parentId?: string };

function locate(items: CollectionNode[], id: string, parentId?: string): Located | undefined {
  for (let i = 0; i < items.length; i++) {
    const n = items[i]!;
    if (n.id === id) return { node: n, list: items, index: i, parentId };
    if (n.kind === 'folder') {
      const r = locate(n.items, id, n.id);
      if (r) return r;
    }
  }
  return undefined;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function requestTarget(store: WorkspaceStore, item: ProposalItem): { c: Collection; at: Located } {
  const t = item.target;
  if (!t || t.kind !== 'request') throw new ApsError('ValidationError', `"${item.title}" names no saved request to change`);
  const c = store.getCollection(t.collectionId);
  const at = locate(c.items, t.requestId);
  if (!at || at.node.kind === 'folder') throw new ApsError('ConfigurationError', `The request of "${item.title}" is no longer in ${c.name}`);
  return { c, at };
}

/** Checks added to one step of a test file (a result's "Generate checks from this response"): the file is rewritten through the flow editor, comments kept. */
function applyStepChecks(store: WorkspaceStore, item: ProposalItem): ProposalUndo {
  const { rel: path } = checkedTestFilePath(store.path('tests'), item.path ?? '');
  let before: string;
  try {
    before = store.readTestFile(path);
  } catch {
    throw new ApsError('ConfigurationError', `tests/${path} is no longer in the workspace`);
  }
  const found = stepOfResult(before, path, { id: item.step!, name: item.step! });
  if (!found) throw new ApsError('ConfigurationError', `"${item.title}": the step "${item.step}" is no longer in tests/${path}`, { suggestions: ['Generate the checks again from a fresh result.'] });
  const checks = (Array.isArray(item.data) ? item.data : [item.data]) as CheckConfig[];
  if (!checks.every((x) => x && typeof x === 'object' && typeof x.type === 'string')) throw new ApsError('ValidationError', `"${item.title}" holds no check`);
  const key = !Array.isArray(found.step.assertions) && Array.isArray(found.step.checks) ? 'checks' : 'assertions';
  const existing = (Array.isArray(found.step[key]) ? found.step[key] : []) as CheckConfig[];
  const text = applyFlowEdit(before, { op: 'updateStep', id: found.ref, set: { [key]: [...existing, ...checks] } }).text;
  store.writeTestFile(path, text);
  return { item: item.id, file: { path, before } };
}

/** Apply one item; returns what to put back. */
function applyItem(store: WorkspaceStore, item: ProposalItem): ProposalUndo {
  if (item.kind === 'assertion' && item.step) return applyStepChecks(store, item);
  switch (item.kind) {
    case 'file':
    case 'flow': {
      const asked = item.path ?? (item.target && 'path' in item.target ? String(item.target.path) : '');
      if (!asked) throw new ApsError('ValidationError', `"${item.title}" has no test file path (tests/….yaml)`);
      // a proposal file can be hand-edited: its path is checked again, as named and really (a link under tests/)
      const { rel: path } = checkedTestFilePath(store.path('tests'), asked);
      let before: string | null = null;
      try {
        before = store.readTestFile(path);
      } catch {
        before = null;
      }
      assertUnchanged(item, before);
      store.writeTestFile(path, item.after.endsWith('\n') ? item.after : `${item.after}\n`);
      return { item: item.id, file: { path, before } };
    }
    case 'assertion':
    case 'script':
    case 'patch': {
      const { c, at } = requestTarget(store, item);
      const before = clone(at.node);
      const node = at.node as SavedHttpRequest;
      const replace = (item.data as { replace?: { index: number; was: CheckConfig }; check?: CheckConfig } | undefined)?.replace;
      if (item.kind === 'assertion' && replace) {
        // one check replaced (a fix): the one it was made from, where it was, or the same check elsewhere in the list
        const to = (item.data as { check?: CheckConfig }).check;
        if (!to || typeof to.type !== 'string') throw new ApsError('ValidationError', `"${item.title}" holds no check`);
        const list = [...(node.assertions ?? [])];
        const same = (c: unknown) => JSON.stringify(c) === JSON.stringify(replace.was);
        const at = same(list[replace.index]) ? replace.index : list.findIndex(same);
        if (at < 0) throw new ApsError('ConfigurationError', `"${item.title}": the check it replaces is no longer there`, { suggestions: ['Run the analysis again, so the change is made from what is there now.'] });
        list[at] = to;
        node.assertions = list;
      } else if (item.kind === 'assertion') {
        const checks = (Array.isArray(item.data) ? item.data : [item.data]) as CheckConfig[];
        if (!checks.every((x) => x && typeof x === 'object' && typeof x.type === 'string')) throw new ApsError('ValidationError', `"${item.title}" holds no check`);
        node.assertions = [...(node.assertions ?? []), ...checks];
      } else if (item.kind === 'script') {
        const d = item.data as { phase?: string; mode?: string } | undefined;
        const phase = d?.phase === 'pre' ? 'preRequestScript' : 'testScript';
        assertUnchanged(item, node[phase]);
        const current = node[phase]?.trimEnd() ?? '';
        // one test per item: added after the script's own tests (once); a whole script replaces it
        node[phase] = d?.mode === 'append' && current ? (current.includes(item.after.trim()) ? current : `${current}\n\n${item.after.trim()}\n`) : item.after;
      } else {
        if (node.kind !== 'http') throw new ApsError('ValidationError', `"${item.title}": only HTTP requests take a request patch`);
        node.request = { ...node.request, ...(item.data as Partial<SavedHttpRequest['request']>) };
      }
      store.saveCollection(c);
      return { item: item.id, node: { collectionId: c.id, nodeId: at.node.id, parentId: at.parentId, before } };
    }
    case 'request': {
      const t = item.target;
      if (!t || (t.kind !== 'collection' && t.kind !== 'folder')) throw new ApsError('ValidationError', `"${item.title}" names no collection to add the request to`);
      const c = store.getCollection(t.collectionId);
      const folder = t.kind === 'folder' ? locate(c.items, t.folderId) : undefined;
      if (t.kind === 'folder' && folder?.node.kind !== 'folder') throw new ApsError('ConfigurationError', `The folder of "${item.title}" is no longer in ${c.name}`);
      const data = item.data as Partial<SavedHttpRequest>;
      const node: SavedHttpRequest = {
        kind: 'http',
        id: shortId('req-'),
        name: data.name || item.title,
        request: { method: 'GET', url: '', ...(data.request ?? {}) },
        ...(data.assertions ? { assertions: data.assertions } : {}),
      };
      (folder?.node.kind === 'folder' ? folder.node.items : c.items).push(node);
      store.saveCollection(c);
      return { item: item.id, node: { collectionId: c.id, nodeId: node.id, parentId: folder?.node.id, before: null } };
    }
    case 'variable': {
      // a non-secret value of the run's environment (a secret variable is refused by setEnvironmentVariables)
      const d = item.data as { environment?: string; key?: string; value?: string } | undefined;
      if (!d?.environment || !d.key || typeof d.value !== 'string') throw new ApsError('ValidationError', `"${item.title}" names no environment variable`);
      const env = findEnvironment(store, d.environment);
      if (!env) throw new ApsError('ConfigurationError', `"${item.title}": there is no environment "${d.environment}" any more`);
      const was = env.variables.find((v) => v.key === d.key);
      setEnvironmentVariables(store, d.environment, { [d.key]: d.value });
      return { item: item.id, variable: { environment: d.environment, key: d.key, before: was ? String(was.value ?? '') : null } };
    }
    case 'spec': {
      // an API definition under specs/ (a contract-drift patch): the file as it is now must be the one the patch was made from
      const rel = String(item.path ?? '').replace(/\\/g, '/');
      if (!/^specs\/[^/].*\.(json|ya?ml)$/i.test(rel) || rel.split('/').includes('..')) throw new ApsError('ValidationError', `"${item.title}" names no API definition under specs/ (${rel || 'no path'})`);
      const file = store.safePath(rel);
      let before: string;
      try {
        before = readFileSync(file, 'utf8');
      } catch {
        throw new ApsError('ConfigurationError', `${rel} is no longer in the workspace`);
      }
      // a patch is applied to the document as it is NOW (its operations are independent and idempotent), so several items of one
      // proposal compose, and a document that changed elsewhere keeps its changes; an item without operations writes its text
      const ops = (item.data as { spec?: { ops?: PatchOp[] } } | undefined)?.spec?.ops;
      let text = item.after;
      if (Array.isArray(ops)) text = applyPatchOps(before, isJsonSpec(rel), ops);
      else assertUnchanged(item, before);
      atomicWrite(file, text.endsWith('\n') ? text : `${text}\n`);
      return { item: item.id, spec: { path: rel, before } };
    }
    case 'metric': {
      // a custom metric file under metrics/: the draft must still be a valid file (its text can be edited in the review), and it replaces one of the same id only if that is what was there
      const id = /^metrics\/([a-z0-9][a-z0-9-]*)\.yaml$/.exec(String(item.path ?? '').replace(/\\/g, '/'))?.[1];
      if (!id) throw new ApsError('ValidationError', `"${item.title}" names no metric file (metrics/<id>.yaml)`);
      const parsed = parseCustomMetric(item.after, { fileId: id });
      if (!parsed.metric) throw new ApsError('ValidationError', `"${item.title}" is not a valid metric: ${parsed.problems.filter((p) => p.level === 'error').map((p) => p.message).join('; ')}`);
      const before = readMetricFile(store, id)?.text ?? null;
      assertUnchanged(item, before);
      writeMetricFile(store, id, item.after);
      return { item: item.id, metric: { id, before } };
    }
    case 'collection': {
      // a tidy: its operations on the collection as it is now (renames, moves, variables, chains, drops)
      const d = item.data as { collectionId?: string; ops?: TidyOp[] } | undefined;
      if (!d?.collectionId || !Array.isArray(d.ops)) throw new ApsError('ValidationError', `"${item.title}" names no collection to change`);
      const c = store.getCollection(d.collectionId);
      const before = clone(c);
      store.saveCollection(applyTidyOps(c, d.ops));
      return { item: item.id, collection: { collectionId: c.id, before } };
    }
    default:
      throw new ApsError('ValidationError', `"${item.title}" is text to read or copy; there is nothing to apply`);
  }
}

/**
 * Apply the chosen items of an open proposal (all selected ones when `items` is not given). An item that cannot be
 * applied is skipped with the reason; the others still apply. The proposal becomes `applied` with its undo.
 * `recordOnly`: the editor that asked applied the items itself (its own undo): only the outcome is recorded.
 */
export function applyProposal(store: WorkspaceStore, id: string, o: { items?: string[]; recordOnly?: boolean } = {}): ApplyResult {
  const p = getProposal(store, id);
  if (p.status !== 'open') throw new ApsError('ConfigurationError', `The AI proposal "${id}" is ${p.status} already`, { suggestions: ['Run the task again for a new proposal.'] });
  const wanted = o.items?.length ? new Set(o.items) : new Set(p.items.filter((i) => i.selected && i.kind !== 'text').map((i) => i.id));
  const unknown = [...wanted].filter((w) => !p.items.some((i) => i.id === w));
  if (unknown.length) throw new ApsError('ValidationError', `Not items of ${id}: ${unknown.join(', ')}`, { suggestions: [`Its items: ${p.items.map((i) => i.id).join(', ')}`] });
  const applied: ApplyResult['applied'] = [];
  const skipped: ApplyResult['skipped'] = [];
  const undo: ProposalUndo[] = [];
  for (const item of p.items) {
    if (!wanted.has(item.id)) continue;
    // an editor applied it itself (a tab's unsaved checks, the flow designer's one-undo-step replace): recorded, not written
    if (o.recordOnly) {
      applied.push({ item: item.id, kind: item.kind, title: item.title, ...(item.path ? { path: item.path } : {}), ...(item.target ? { target: item.target } : {}) });
      continue;
    }
    try {
      undo.push(applyItem(store, item));
      applied.push({ item: item.id, kind: item.kind, title: item.title, ...(item.path ? { path: item.path } : {}), ...(item.target ? { target: item.target } : {}) });
    } catch (e) {
      skipped.push({ item: item.id, reason: (e as Error).message });
    }
  }
  if (!applied.length && skipped.length) throw new ApsError('ValidationError', `Nothing of ${id} could be applied: ${skipped.map((s) => s.reason).join('; ')}`);
  noteProposalOutcome(store, p.id, p.createdAt, 'accepted');
  saveProposal(store, { ...p, status: 'applied', applied: { at: new Date().toISOString(), items: applied.map((a) => a.item), undo } });
  return { id, applied, skipped, undo: undo.length > 0 };
}

/** Put back what an applied proposal replaced (files and request nodes), newest change first. */
export function undoProposal(store: WorkspaceStore, id: string): { id: string; restored: number } {
  const p: Proposal = getProposal(store, id);
  if (p.status !== 'applied' || !p.applied || p.applied.undone) throw new ApsError('ConfigurationError', `The AI proposal "${id}" has nothing to undo`);
  // every path first: a hand-edited undo that names a place outside tests/ restores nothing at all
  for (const u of p.applied.undo) if (u.file) checkedTestFilePath(store.path('tests'), u.file.path);
  let restored = 0;
  for (const u of [...p.applied.undo].reverse()) {
    if (u.collection) {
      store.saveCollection(u.collection.before as Collection);
      restored++;
    } else if (u.variable) {
      if (u.variable.before === null) unsetEnvironmentVariables(store, u.variable.environment, [u.variable.key]);
      else setEnvironmentVariables(store, u.variable.environment, { [u.variable.key]: u.variable.before });
      restored++;
    } else if (u.metric) {
      if (u.metric.before === null) removeMetricFile(store, u.metric.id);
      else writeMetricFile(store, u.metric.id, u.metric.before);
      restored++;
    } else if (u.spec) {
      if (!/^specs\/[^/].*\.(json|ya?ml)$/i.test(u.spec.path) || u.spec.path.split('/').includes('..')) continue;
      atomicWrite(store.safePath(u.spec.path), u.spec.before);
      restored++;
    } else if (u.file) {
      const { rel, abs } = checkedTestFilePath(store.path('tests'), u.file.path);
      if (u.file.before === null) {
        if (existsSync(abs)) store.deleteTestFile(rel);
      } else store.writeTestFile(rel, u.file.before);
      restored++;
    } else if (u.node) {
      const c = store.getCollection(u.node.collectionId);
      const at = locate(c.items, u.node.nodeId);
      if (u.node.before === null) {
        if (at) at.list.splice(at.index, 1);
      } else if (at) at.list[at.index] = u.node.before as CollectionNode;
      else {
        const parent = u.node.parentId ? locate(c.items, u.node.parentId) : undefined;
        (parent?.node.kind === 'folder' ? parent.node.items : c.items).push(u.node.before as CollectionNode);
      }
      store.saveCollection(c);
      restored++;
    }
  }
  saveProposal(store, { ...p, applied: { ...p.applied, undone: new Date().toISOString() } });
  return { id, restored };
}
