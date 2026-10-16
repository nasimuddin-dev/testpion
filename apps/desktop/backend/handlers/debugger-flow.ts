/**
 * RPC handlers: record a flow from the HTTP Debugger (planning/flow-designer.md, third release, item 3). Selected
 * exchanges, or every exchange captured since "Record a flow…" started, become a flow file under tests/recorded/
 * (core flowFromExchanges: values that flow from a response into a later request become extracts and {{variables}},
 * noise is left out, secrets become variables to set). A dry run previews it for the dialog; nothing is written then.
 */
import { existsSync } from 'node:fs';
import { ApsError, collectionFromExchanges, flowFromExchanges, isSecretRef, recordCaptureSession, recordedFlowPath, secretKeys, type CaptureGrouping, type DebuggerExchange, type FlowFromExchangesResult } from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';

interface CreateFlowParams {
  /** The exchanges, by id (the grid's selection). */
  ids?: string[];
  /** Or every exchange that started at or after this time (a recording's start, ISO). */
  since?: string;
  /** The flow's name; the file is tests/recorded/<name>.yaml. */
  name?: string;
  /** The environment whose variables are offered (an origin or a secret it holds is used by name). */
  environment?: string;
  /** Exchanges to leave out (the dialog's unticked steps). */
  drop?: string[];
  /** Keep static assets, preflights and telemetry. */
  keepNoise?: boolean;
  /** Hosts to leave out besides the usual analytics list. */
  noiseHosts?: string[];
  /** Preview only: what would be written. */
  dryRun?: boolean;
  /** Replace a file of that name (default: a free name next to it). */
  overwrite?: boolean;
}

/** When "Record a flow…" started, per backend (one recording at a time; it survives switching views). */
const recordings = new WeakMap<Backend, string>();

export function debuggerFlowHandlers(be: Backend): Handlers {
  const exchangesOf = (p: CreateFlowParams): DebuggerExchange[] => {
    // the session on screen: the live capture, or a saved session in its tab
    const all = be.debugger?.view?.() ?? be.debugger?.exchanges ?? [];
    if (p.ids?.length) {
      const want = new Set(p.ids);
      const found = all.filter((e) => want.has(e.id));
      if (!found.length) throw new ApsError('ValidationError', 'Those exchanges are no longer in the session');
      return found;
    }
    if (p.since) {
      const t = Date.parse(p.since);
      if (Number.isNaN(t)) throw new ApsError('ValidationError', `since is a time (ISO), not ${JSON.stringify(p.since)}`);
      return all.filter((e) => Date.parse(e.startedAt) >= t);
    }
    throw new ApsError('ValidationError', 'Select the exchanges (ids) or give the time the recording started (since)');
  };
  /** The environment's variables with their values (secrets read from the secret store, never sent to the window). */
  const environmentOf = (ref?: string) => {
    if (!ref) return undefined;
    const env = be.ws.getEnvironment(ref);
    if (!env) throw new ApsError('ValidationError', `No environment "${ref}"`);
    return {
      name: env.name,
      variables: env.variables
        .filter((v) => !isSecretRef(v.value))
        .map((v) => ({ key: v.key, enabled: v.enabled, secret: v.secret, value: v.secret ? (be.secrets.get(secretKeys.envVar(env.id, v.key)) ?? '') : v.value })),
    };
  };
  const freePath = (name: string, overwrite?: boolean) => {
    const base = recordedFlowPath(name);
    const taken = (p: string) => existsSync(be.ws.safePath(p, be.ws.path('tests')));
    if (overwrite || !taken(base)) return { file: base, exists: taken(base) };
    let p = base;
    for (let i = 2; taken(p); i++) p = base.replace(/\.yaml$/, `-${i}.yaml`);
    return { file: p, exists: false, taken: base };
  };

  return {
    /**
     * A flow file from exchanges: their steps, the links found (a value from one response used by a later request),
     * the variables (origins, secrets to set) and what was left out. `dryRun` previews; otherwise it is written.
     */
    'debug.createFlow': (p: CreateFlowParams = {}) => {
      const exchanges = exchangesOf(p);
      const name = p.name?.trim() || `Recorded ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
      const r: FlowFromExchangesResult = flowFromExchanges(exchanges, {
        name,
        environment: environmentOf(p.environment),
        redactor: be.logger.redactor,
        drop: p.drop,
        keepNoise: p.keepNoise,
        extraNoiseHosts: p.noiseHosts,
      });
      const where = freePath(name, p.overwrite);
      const out = { file: `tests/${where.file}`, path: where.file, exists: where.exists, ...r, dropped: r.dropped.map((d) => ({ ...d, url: be.logger.redactor.redactUrl(d.url) })) };
      if (p.dryRun) return { ...out, written: false };
      be.ws.writeTestFile(where.file, r.text);
      be.logger.info(`Recorded flow tests/${where.file}: ${r.steps.length} steps from ${exchanges.length} exchanges`);
      // History: this capture session and the flow it became (opens the flow)
      const entry = recordCaptureSession(be.ws, exchanges, { result: 'flow', ref: { kind: 'flow', path: where.file }, target: `tests/${where.file}`, items: r.steps.length }, be.logger.redactor);
      return { ...out, written: true, historyId: entry.id };
    },
    /**
     * WF-12 Save to collection: the exchanges as saved requests (core collectionFromExchanges, the same reading as a
     * recorded flow), in a new collection or added to one (in a folder `name`), a folder per host or path. Secrets
     * become variables that are listed, never saved.
     */
    'debug.saveToCollection': (p: { ids?: string[]; since?: string; collectionId?: string; name?: string; group?: CaptureGrouping; environment?: string; keepNoise?: boolean } = {}) => {
      const exchanges = exchangesOf(p);
      const r = collectionFromExchanges(exchanges, {
        collection: p.collectionId ? be.ws.getCollection(p.collectionId) : undefined,
        name: p.name?.trim() || undefined,
        group: p.group,
        environment: environmentOf(p.environment),
        redactor: be.logger.redactor,
        keepNoise: p.keepNoise,
      });
      const saved = be.ws.saveCollection(r.collection);
      be.refreshMock(saved.id);
      be.logger.info(`Saved ${r.requests.length} captured requests to collection "${saved.name}"`);
      // History: this capture session and the collection it went to (opens the collection)
      const entry = recordCaptureSession(be.ws, exchanges, { result: 'collection', ref: { kind: 'collection', collectionId: saved.id }, target: saved.name, items: r.requests.length }, be.logger.redactor);
      const { collection: _c, ...rest } = r;
      return { collectionId: saved.id, collection: saved.name, historyId: entry.id, ...rest, dropped: r.dropped.map((d) => ({ ...d, url: be.logger.redactor.redactUrl(d.url) })) };
    },
    /** "Record a flow…": start (remember when), stop (the exchanges since then), or ask. */
    'debug.record': ({ on }: { on?: boolean } = {}) => {
      if (on === true) {
        const since = new Date().toISOString();
        recordings.set(be, since);
        return { recording: true, since, count: 0 };
      }
      const since = recordings.get(be);
      const count = since ? (be.debugger?.exchanges ?? []).filter((e) => Date.parse(e.startedAt) >= Date.parse(since)).length : 0;
      if (on === false) recordings.delete(be);
      return { recording: on === false ? false : !!since, since, count };
    },
  };
}
