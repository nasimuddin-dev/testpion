/**
 * RPC handlers of the capture of a RAG dataset from real traffic (AI Lab ▸ RAG ▸ Create dataset from captured calls, History,
 * the Debugger): what can be a source, a preview (the report and the first records, nothing written) and the creation of the
 * dataset. The window reads and masks nothing: the engine does, the same as `testpion rag capture` and the MCP tool.
 */
import { ApsError, callOfExchange, captureDataset, listCaptureSources, listRagTargets, type CaptureOptions, type CaptureSourceSpec } from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';

interface CaptureParams extends Omit<CaptureOptions, 'source' | 'dryRun'> {
  from: 'history' | 'debugger' | 'run' | 'har' | 'exchanges' | 'messages';
  /** messages: a WebSocket message log of the workspace, and the socket's address when the target's must match it. */
  messages?: string;
  messagesUrl?: string;
  /** history: entry ids (none: the recent HTTP entries). */
  history?: string[];
  /** debugger: a saved session, or the History id that saved it. */
  session?: string;
  run?: string;
  har?: string;
  /** exchanges: the live Debugger exchanges on screen, by id. */
  exchanges?: string[];
}

export function ragCaptureHandlers(be: Backend): Handlers {
  const sourceOf = (p: CaptureParams): CaptureSourceSpec => {
    if (p.from === 'exchanges') {
      const all = be.debugger?.view?.() ?? be.debugger?.exchanges ?? [];
      const want = p.exchanges?.length ? new Set(p.exchanges) : undefined;
      const calls = all.filter((e) => e.kind === 'http' && (!want || want.has(e.id))).map(callOfExchange);
      if (!calls.length) throw new ApsError('ValidationError', 'Those exchanges are no longer in the session');
      return { kind: 'calls', calls };
    }
    if (p.from === 'debugger') return { kind: 'debugger', session: p.session ?? '' };
    if (p.from === 'run') return { kind: 'run', run: p.run ?? '' };
    if (p.from === 'har') return { kind: 'har', file: p.har ?? '' };
    if (p.from === 'messages') return { kind: 'messages', file: p.messages ?? '', ...(p.messagesUrl ? { url: p.messagesUrl } : {}) };
    return { kind: 'history', ...(p.history?.length ? { ids: p.history } : {}) };
  };
  const run = async (p: CaptureParams, dryRun: boolean) => {
    const { from: _f, history: _h, session: _s, run: _r, har: _har, exchanges: _x, messages: _m, messagesUrl: _mu, ...options } = p;
    return captureDataset(be.ws, { ...options, source: sourceOf(p), dryRun }, { redactor: be.logger.redactor });
  };
  return {
    /** What can be a source: the targets that can be read from HTTP calls, the saved sessions, the HAR files, the recent runs, the live Debugger exchanges. */
    'rag.capture.sources': () => ({
      targets: listRagTargets(be.ws).map((t) => ({ id: t.id, name: t.name, protocol: t.protocol, mapped: t.mapped, problems: t.problems })),
      ...listCaptureSources(be.ws),
      runs: be.ws.meta.listRuns({ limit: 30 }).items.map((r) => ({ id: r.id, name: r.name, startedAt: r.startedAt, total: r.total })),
      debuggerExchanges: (be.debugger?.view?.() ?? be.debugger?.exchanges ?? []).filter((e) => e.kind === 'http').length,
    }),
    /** The report and the first records of a capture; nothing is written. */
    'rag.capture.preview': (p: CaptureParams) => run(p, true),
    /** Writes datasets/<name>.jsonl and reports. */
    'rag.capture.create': (p: CaptureParams) => run(p, false),
  };
}
