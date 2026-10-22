import type { ItemRef } from '@testpion/shared';
import { ApsError } from '../errors.js';
import { CAPTURE_SESSIONS_DIR, captureSessionFileName } from '../debugger/capture-history.js';
import { moveToTrash, restoreFromTrash, trashSpec } from '../storage/trash.js';
import { fileIn, missing, ok } from './ref-index.js';
import type { KindDefs } from './types.js';

type TestRef = Extract<ItemRef, { kind: 'test' | 'flow' }>;

/** Kinds stored as documents of their own (tests/, specs/, datasets/, debugger/): there when the file is. */
export const fileKinds: KindDefs = {
  test: { resolve: (store, ref) => resolveTestFile(store, ref as TestRef) },
  flow: { resolve: (store, ref) => resolveTestFile(store, ref as TestRef) },
  'test-case': { resolve: (_store, ref) => ok(ref, (ref as Extract<ItemRef, { kind: 'test-case' }>).testId, 'Test') },
  spec: {
    resolve: (store, ref) => {
      const r = ref as Extract<ItemRef, { kind: 'spec' }>;
      return /^specs\//.test(r.path) && fileIn(store, store.root, r.path)
        ? ok(r, r.path.replace(/^.*\//, ''), r.path)
        : missing(r, `${r.path} is no longer there (deleted or renamed).`, { label: 'Search the workspace', view: 'search' });
    },
    ops: { remove: (store, id) => trashSpec(store, id), restore: (store, trashId) => restoreFromTrash(store, trashId) },
  },
  dataset: {
    resolve: (store, ref) => {
      const r = ref as Extract<ItemRef, { kind: 'dataset' }>;
      return fileIn(store, store.path('datasets'), r.name)
        ? ok(r, r.name, `datasets/${r.name}`)
        : missing(r, `datasets/${r.name} is no longer there (deleted or renamed).`, { label: 'Search the workspace', view: 'search' });
    },
    ops: {
      remove: (store, id) => {
        const file = fileIn(store, store.path('datasets'), id);
        const trashId = file && moveToTrash(store, 'dataset', file);
        if (!trashId) throw new ApsError('ValidationError', `No dataset datasets/${id}`, { suggestions: [] });
        return trashId;
      },
      restore: (store, trashId) => restoreFromTrash(store, trashId),
    },
  },
  capture: {
    resolve: (store, ref) => {
      const r = ref as Extract<ItemRef, { kind: 'capture' }>;
      return fileIn(store, store.path(CAPTURE_SESSIONS_DIR), captureSessionFileName(r.name))
        ? ok(r, r.name, `${CAPTURE_SESSIONS_DIR}/${captureSessionFileName(r.name)}`)
        : missing(r, `The capture session ${r.name} is no longer saved (deleted or renamed).`, { label: 'Open the debugger', view: 'debugger' });
    },
  },
};

function resolveTestFile(store: Parameters<NonNullable<NonNullable<KindDefs['test']>['resolve']>>[0], r: TestRef) {
  return fileIn(store, store.path('tests'), r.path)
    ? ok(r, r.path.replace(/^.*\//, ''), `tests/${r.path}`)
    : missing(r, `tests/${r.path} is no longer there (deleted, renamed or moved).`, { label: 'Open tests', view: 'tests' });
}
