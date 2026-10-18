import { join } from 'node:path';
import type { ItemRef } from '@testpion/shared';
import { ApsError } from '../errors.js';
import { moveToTrash, restoreFromTrash } from '../storage/trash.js';
import { environmentIndex, missing, ok } from './ref-index.js';
import type { KindDefs } from './types.js';

type EnvRef = Extract<ItemRef, { kind: 'environment' }>;
type VarRef = Extract<ItemRef, { kind: 'variable' }>;

/** Environments, the workspace's own variables, and one variable of an environment (by id through the environment's own file, never a scan). */
export const environmentKinds: KindDefs = {
  environment: {
    resolve: (store, ref) => {
      const r = ref as EnvRef;
      if (!r.environmentId) return ok(r, r.scope === 'globals' ? 'Globals' : r.scope === 'workspace' ? 'Workspace variables' : r.scope === 'collection' ? 'Collection variables' : 'Environments');
      const e = environmentIndex(store, r.environmentId);
      return e ? ok(r, e.name, 'Environment') : missing(r, 'That environment no longer exists (deleted or renamed in another workspace).', { label: 'Open Environments', view: 'environments' });
    },
    ops: {
      remove: (store, id) => {
        const trashId = moveToTrash(store, 'environment', join(store.root, store.environmentFileOf(id)));
        if (!trashId) throw new ApsError('ConfigurationError', `No environment ${id}`, { suggestions: [] });
        return trashId;
      },
      restore: (store, trashId) => restoreFromTrash(store, trashId),
    },
  },
  workspace: { resolve: (_store, ref) => ok(ref, 'Workspace variables') },
  variable: {
    resolve: (store, ref) => {
      const r = ref as VarRef;
      if (!r.environmentId) return ok(r, r.key, 'Variable');
      const e = environmentIndex(store, r.environmentId);
      if (!e) return missing(r, 'The environment of that variable no longer exists.', { label: 'Open Environments', view: 'environments' });
      return e.byId.has(`var:${r.key}`)
        ? ok(r, r.key, `Variable in ${e.name}`)
        : missing(r, `"${r.key}" is no longer a variable of ${e.name}.`, { label: `Open ${e.name}`, ref: { kind: 'environment', environmentId: r.environmentId } });
    },
  },
};
