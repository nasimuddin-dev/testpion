/**
 * Applying a proposal (AIB-4): the items the person (or an agent, after asking) chose, through the workspace's own
 * writers — test files with `writeTestFile`, collections with `saveCollection` — so the folder watcher, git and the
 * other windows see an ordinary save (the app's own-writes reporting included). What each item replaced is kept with
 * the proposal, so `undoProposal` puts it back.
 *
 * Applying writes files only: nothing is sent and nothing runs, so the production guard is not involved; running what
 * was applied stays a separate step under the guard.
 */
import { existsSync } from 'node:fs';
import type { CheckConfig, Collection, CollectionNode, SavedHttpRequest } from '../model/types.js';
import { ApsError } from '../errors.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { shortId } from '../util/ids.js';
import { noteProposalOutcome } from '../storage/ai-usage.js';
import { checkedTestFilePath } from '../storage/test-path.js';
import { getProposal, saveProposal, type Proposal, type ProposalItem, type ProposalUndo } from './proposal.js';
import { findEnvironment, setEnvironmentVariables, unsetEnvironmentVariables } from '../storage/env-edit.js';

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

/** Apply one item; returns what to put back. */
function applyItem(store: WorkspaceStore, item: ProposalItem): ProposalUndo {
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
    if (u.variable) {
      if (u.variable.before === null) unsetEnvironmentVariables(store, u.variable.environment, [u.variable.key]);
      else setEnvironmentVariables(store, u.variable.environment, { [u.variable.key]: u.variable.before });
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
