import { existsSync } from 'node:fs';
import { ITEM_KIND_LABEL, type ItemRef } from '@testpion/shared';
import { missing, ok } from './ref-index.js';
import type { KindDefs } from './types.js';

/**
 * Records (runs, history, traces, Debugger exchanges) and the ref-only kinds (a certificate, a changed file, a docs
 * page): looked up by id in the metadata database, or resolved as they are (the host checks those).
 */
export const recordKinds: KindDefs = {
  run: {
    resolve: (store, ref) => {
      const r = ref as Extract<ItemRef, { kind: 'run' }>;
      let dir: string | undefined;
      try {
        dir = store.runDir(r.runId);
      } catch {
        dir = undefined;
      }
      return dir && existsSync(dir) ? ok(r, r.runId, 'Run') : missing(r, 'That run is no longer kept (deleted, cleaned up, or from another workspace).', { label: 'Open the runs', view: 'tests' });
    },
  },
  history: {
    resolve: (store, ref) => {
      const r = ref as Extract<ItemRef, { kind: 'history' }>;
      const h = store.meta.getHistory(r.historyId);
      return h ? ok(r, h.name, `${h.kind} · ${h.timestamp}`) : missing(r, 'That history entry is gone (cleared, or from another workspace).', { label: 'Open history', view: 'history' });
    },
  },
  trace: {
    resolve: (store, ref) => {
      const r = ref as Extract<ItemRef, { kind: 'trace' }>;
      const t = store.meta.getTrace(r.traceId);
      return t ? ok(r, t.name, 'Trace') : missing(r, 'That trace is gone (cleared, or from another workspace).', { label: 'Open traces', view: 'traces' });
    },
  },
  exchange: { resolve: (_store, ref) => ok(ref, (ref as Extract<ItemRef, { kind: 'exchange' }>).exchangeId, ITEM_KIND_LABEL.exchange) },
  'git-file': { resolve: (_store, ref) => ok(ref, (ref as Extract<ItemRef, { kind: 'git-file' }>).path, 'Changed file') },
  certificate: { resolve: (_store, ref) => ok(ref, (ref as Extract<ItemRef, { kind: 'certificate' }>).host, 'Certificate') },
  doc: { resolve: (_store, ref) => ok(ref, (ref as Extract<ItemRef, { kind: 'doc' }>).url, ITEM_KIND_LABEL.doc) },
};
