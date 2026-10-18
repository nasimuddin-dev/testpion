/**
 * Whether an ItemRef (@testpion/shared) still points at something, what it is called, and, when it doesn't, the nearest
 * thing that is still there. Each kind answers for itself (its `resolve` facet in packages/core/src/kinds/): every
 * lookup is by id through an index, so it is as fast in a 9,000-request workspace as in an empty one.
 */
import { toItemRef, type ItemRef, type RefResolution } from '@testpion/shared';
import type { WorkspaceStore } from './workspace.js';
import { kindOfItemRef } from '../kinds/registry.js';
import { ok } from '../kinds/ref-index.js';

export type { ItemRef, RefResolution } from '@testpion/shared';
export { collectionIndex } from '../kinds/ref-index.js';

/**
 * Resolve a ref against a workspace: `ok` with its name (and, for a request, its protocol filled in), or why not with
 * the nearest thing that is still there. Kinds that live outside the workspace files (a Debugger exchange, a docs
 * page) resolve as they are; the host checks those.
 */
export function resolveItemRef(store: WorkspaceStore, value: unknown): RefResolution {
  const ref = toItemRef(value);
  if (!ref) return { ok: false, ref: value as ItemRef, reason: 'invalid', message: 'That is not a link to something in TestPion' };
  const def = kindOfItemRef(ref);
  return def.resolve ? def.resolve(store, ref) : ok(ref, def.info?.label ?? ref.kind);
}
