/**
 * Checking a proposal again (AIB-4/AIB-5), after the person edited an item in the review, switched a check to its
 * safer form, asked for "Try on mock", or sent the request again ("Run now": the new response, and the one before it,
 * show which checks hold): the item's verifiers run again and the stored proposal is updated, so the app, the CLI and
 * an agent apply exactly what was checked.
 */
import { checkLabel } from '@testpion/shared';
import { ApsError } from '../errors.js';
import type { Collection } from '../model/types.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { getProposal, saveProposal, type Proposal } from './proposal.js';
import { aiTask } from './tasks/registry.js';
import { verifyItems, type StoredResponse, type VerifyContext } from './verify.js';

export interface ReverifyOptions {
  /** One item (default: every item). */
  item?: string;
  /** The item's new text (an edit in the review). */
  after?: string;
  /** The item's new structured payload (a check switched to its safer form). */
  data?: unknown;
  /** Only these verifiers (default: the task's). `flow-mock` alone is "Try on mock". */
  verifiers?: string[];
  /** The response to check against now (Run now), and the one before it. */
  response?: StoredResponse;
  previous?: StoredResponse;
}

/** The collection an item's flow is verified against: the one it was made from. */
function collectionOf(store: WorkspaceStore, p: Proposal, data: unknown): Collection | undefined {
  const ref = ((data as { source?: { collectionId?: string } } | undefined)?.source ?? p.request?.item) as { collectionId?: string } | undefined;
  if (!ref?.collectionId) return undefined;
  try {
    return store.getCollection(ref.collectionId);
  } catch {
    return undefined;
  }
}

/** Run an open proposal's verifiers again (see the module comment); returns the updated proposal. */
export async function reverifyProposal(store: WorkspaceStore, id: string, o: ReverifyOptions, ctx: Omit<VerifyContext, 'response' | 'previous' | 'collection'> = {}): Promise<Proposal> {
  const p = getProposal(store, id);
  if (p.status !== 'open') throw new ApsError('ConfigurationError', `The AI proposal "${id}" is ${p.status}: it can no longer change`, { suggestions: ['Run the task again for a new proposal.'] });
  const items = o.item ? p.items.filter((i) => i.id === o.item) : p.items;
  if (o.item && !items.length) throw new ApsError('ValidationError', `No item "${o.item}" in ${id}`, { suggestions: [`Its items: ${p.items.map((i) => i.id).join(', ')}`] });
  if ((o.after !== undefined || o.data !== undefined) && items.length !== 1) throw new ApsError('ValidationError', 'Name the item to change (item)');
  const names = o.verifiers?.length ? o.verifiers : (aiTask(p.task)?.verifiers ?? []);
  for (const it of items) {
    if (o.after !== undefined) {
      if (typeof o.after !== 'string' || !o.after.trim()) throw new ApsError('ValidationError', 'The new text is empty');
      it.after = o.after;
    }
    if (o.data !== undefined) {
      it.data = o.data;
      // a check switched to its safer form: its title says the new check
      const c = o.data as { type?: unknown; [k: string]: unknown } | undefined;
      if (it.kind === 'assertion' && c && typeof c.type === 'string') it.title = checkLabel({ ...c, type: c.type });
    }
    // the badges of the verifiers that run again are replaced; the others stay
    it.verification = it.verification.filter((b) => !names.includes(b.verifier));
    // ticked again unless a verifier fails it (the review keeps the person's own ticks)
    it.selected = true;
    await verifyItems([it], names, { store, ...ctx, response: o.response, previous: o.previous, collection: collectionOf(store, p, it.data) });
  }
  return saveProposal(store, p);
}
