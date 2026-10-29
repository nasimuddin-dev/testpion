/**
 * RPC handlers: the HTTP Debugger's reverse-proxy capture mode ("Reverse proxy for one API", the Record dialog). The
 * reverse proxy stands on 127.0.0.1 in front of one API; what it forwards goes into the Debugger's one exchange store
 * (the same grid as the forward proxy, `source: 'reverse'`), so filters, selection, Create flow, Save to collection,
 * HAR export, sessions and History work the same. The dialog keeps its own list of this recording and its Save
 * (a collection with the responses as examples), read from that store.
 */
import { ApsError, debuggerExchangeFromRecorded, recordCaptureSession, recordedFromDebuggerExchange, recordingToCollection, startRecorder, type RecordedExchange } from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';
import { debuggerScriptHandlers } from './debugger-scripts.js';
import { newDebuggerState } from './debugger.js';

/** The recording the dialog shows: the exchanges it captured (ids in the Debugger's store), and where it forwards. */
interface Recording {
  target: string;
  ids: string[];
}
const recordings = new WeakMap<Backend, Recording>();

export function debuggerReverseHandlers(be: Backend): Handlers {
  const state = () => (be.debugger ??= newDebuggerState());
  /** This recording's exchanges that the session still has (the Debugger's Clear or its limits may have dropped some). */
  const captured = () => {
    const rec = recordings.get(be);
    if (!rec) return [];
    const want = new Set(rec.ids);
    return state().exchanges.filter((e) => want.has(e.id));
  };
  return {
    ...debuggerScriptHandlers(be),
    /** Start the reverse proxy in front of `target`; each exchange joins the Debugger's session and is sent as `record.exchange`. */
    'record.start': async ({ target, port }: { target: string; port?: number }) => {
      await be.recorder?.close();
      const summary = (e: RecordedExchange) => ({
        id: e.id,
        time: e.time,
        method: e.method,
        path: be.logger.redactor.redactUrl(`http://x${e.path}`).slice(8),
        status: e.status,
        durationMs: e.durationMs,
        error: e.error,
      });
      const rec: Recording = { target, ids: [] };
      be.recorder = await startRecorder({
        target,
        port,
        keep: false, // one store: the Debugger's
        onExchange: (e) => {
          const s = state();
          s.capture?.(debuggerExchangeFromRecorded(e, be.recorder?.target ?? rec.target));
          rec.ids.push(e.id);
          if (rec.ids.length > 10_000) rec.ids.splice(0, rec.ids.length - 5000);
          be.host.emit('record.exchange', summary(e));
        },
      });
      rec.target = be.recorder.target;
      recordings.set(be, rec);
      be.logger.info(`Reverse proxy ${be.recorder.url} → ${be.recorder.target}: captures go to the HTTP Debugger`);
      return { url: be.recorder.url, target: be.recorder.target };
    },
    'record.stop': async () => {
      await be.recorder?.close();
      be.recorder = undefined;
      return { exchanges: captured().length };
    },
    'record.status': () => (be.recorder ? { url: be.recorder.url, target: be.recorder.target, exchanges: captured().length } : null),
    /** Save this recording as a collection (secrets become {{variables}}; responses become examples); History keeps the capture session. */
    'record.save': async ({ name }: { name: string }) => {
      const rec = recordings.get(be);
      const exchanges = captured();
      if (!rec || !exchanges.length) throw new ApsError('ValidationError', 'Nothing recorded yet');
      const r = recordingToCollection(
        exchanges.map((e) => recordedFromDebuggerExchange(e, rec.target)),
        { name: name.trim() || 'Recorded', target: rec.target, redactor: be.logger.redactor },
      );
      const saved = await be.ws.saveCollectionAsync(r.collection);
      const entry = recordCaptureSession(be.ws, exchanges, { result: 'collection', ref: { kind: 'collection', collectionId: saved.id }, target: saved.name, items: r.requests }, be.logger.redactor);
      return { collectionId: saved.id, name: saved.name, requests: r.requests, placeholders: r.placeholders.map((p) => p.variable), historyId: entry.id };
    },
    /** Start the dialog's list again (the exchanges stay in the Debugger, where its Clear removes them). */
    'record.clear': () => {
      const rec = recordings.get(be);
      if (rec) rec.ids = [];
    },
  };
}
