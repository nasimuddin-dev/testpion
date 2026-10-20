/**
 * What to export: the selectors a person, a script or an agent gives (`collection:clinic`, `spec:specs/pets.yaml`,
 * `dataset:users.csv`, an ItemRef or a testpion://open link, a collection's name), a whole section of a kind, or the
 * whole workspace. Each becomes a `{ kind, id }` of the bundle; an item that is not in the workspace is an error that
 * says what is, never an empty bundle.
 */
import { kindByName } from '@testpion/shared';
import { ApsError } from '../errors.js';
import { itemRefOf } from '../kinds/ops.js';
import { bundleRefOfItemRef } from '../kinds/transfer-refs.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { ALL_BUNDLE_KINDS, adapter, bundleKindOf, normalizeId } from './registry.js';
import { itemKey } from './format.js';
import type { BundleRef } from './types.js';

export type { BundleRef };
export { bundleRefOfItemRef };

/** One selector as a bundle ref. A bare word is a collection (by id or name), as `testpion export <collection>` always took. */
export function parseSelector(store: WorkspaceStore, selector: unknown): BundleRef {
  if (selector && typeof selector === 'object') {
    const r = bundleRefOfItemRef(itemRefOf(selector));
    if (!r) throw new ApsError('ValidationError', `That item cannot be exported on its own: ${JSON.stringify(selector).slice(0, 120)}`);
    return r;
  }
  const text = String(selector ?? '').trim();
  if (!text) throw new ApsError('ValidationError', 'Name what to export: kind:id (collection:<id>, spec:specs/<path>, dataset:<name>, mcp-server:<id> …)');
  const colon = text.indexOf(':');
  const info = colon > 0 && !/^[a-z]+:\/\//i.test(text) ? kindByName(text.slice(0, colon)) : undefined;
  if (info) {
    const k = bundleKindOf(info.id);
    if (!k) throw new ApsError('ValidationError', `${info.plural} are not exported in bundles (use \`testpion kinds ${info.id}\` to see what each kind can do)`);
    return { kind: k, id: normalizeId(k, text.slice(colon + 1)) };
  }
  if (/^testpion:\/\//i.test(text) || text.startsWith('{')) {
    const r = bundleRefOfItemRef(itemRefOf(text));
    if (r) return r;
  }
  const c = store.listCollections().find((x) => !x.problem && (x.id === text || x.name.toLowerCase() === text.toLowerCase()));
  if (c) return { kind: 'collection', id: c.id };
  throw new ApsError('ValidationError', `Nothing to export for "${text.slice(0, 80)}"`, {
    suggestions: ['Use kind:id, e.g. collection:<id>, spec:specs/<path>, dataset:<name>, mcp-server:<id>', 'A bare word is a collection name or id'],
  });
}

/** Every item of one section (a kind, by id or alias: `datasets`, `mcp`, `specs`, `collection` …). */
export function sectionRefs(store: WorkspaceStore, section: string): BundleRef[] {
  const k = bundleKindOf(section);
  if (!k) {
    throw new ApsError('ValidationError', `"${section}" is not a section a bundle can hold`, { suggestions: [`Sections: ${ALL_BUNDLE_KINDS.join(', ')}`] });
  }
  return adapter(k)
    .list(store)
    .map((i) => ({ kind: k, id: i.id }));
}

/** The whole workspace: every item of every kind (AI providers only when asked: they are a person's setup, not a project's). */
export function everythingRefs(store: WorkspaceStore, o: { providers?: boolean } = {}): BundleRef[] {
  return ALL_BUNDLE_KINDS.filter((k) => k !== 'provider' || o.providers).flatMap((k) => sectionRefs(store, k));
}

/** Refs without repeats, in the order given. */
export function uniqueRefs(refs: readonly BundleRef[]): BundleRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => !seen.has(itemKey(r.kind, r.id)) && !!seen.add(itemKey(r.kind, r.id)));
}
