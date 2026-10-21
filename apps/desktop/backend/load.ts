/** Starting a load test (startLoad): resolves the target, checks the safeguards and runs it in the background. The Backend method is a one-line delegate. */
import { ApsError, reflectServer, parseGrpcTarget, normalizeError, runLoadTest, buildUrl, evaluateThresholds, recordLoadRun, loadRunRecord, type LoadRunRecord, collectionLoadTarget, shortId, type LoadTestConfig } from '@testpion/core';
import type { Backend } from './backend.js';

export async function startLoad(be: Backend, p: { config: LoadTestConfig; environment?: string; collection?: { collectionId: string; selection?: string[]; warmUp?: boolean }; name?: string; savedId?: string; thresholds?: string[] }) {
  const id = shortId('load-');
  const ctrl = new AbortController();
  be.controllers.set(id, ctrl);
  const ctx = be.context({ environment: p.environment, collectionId: p.collection?.collectionId });
  // a collection: its requests in order (after an optional warm-up run with scripts), variables resolved once
  let target = p.config.target;
  let info: { requests: string[]; unresolved: string[]; warmUp?: { passed: number; failed: number } } | undefined;
  // gRPC: without proto files, the server describes itself (reflection)
  if (target.kind === 'grpc') {
    try {
      const r = ctx.vars.resolveDeep(target.request);
      if (!r.protoFiles?.length && !r.descriptorSet) r.descriptorSet = (await reflectServer(parseGrpcTarget(r.target, r.tls), { metadata: r.metadata })).descriptorSet;
      target = { kind: 'grpc', request: r };
    } catch (e) {
      be.controllers.delete(id);
      void ctx.dispose();
      throw e;
    }
  }
  if (p.collection) {
    const col = be.ws.getCollection(p.collection.collectionId);
    if (!col) throw new ApsError('ConfigurationError', 'Collection not found');
    try {
      const t = await collectionLoadTarget({ collection: col, selection: p.collection.selection, services: ctx.services, warmUp: p.collection.warmUp, signal: ctrl.signal });
      target = t.target;
      info = { requests: t.target.requests.map((r) => r.name), unresolved: t.unresolved, warmUp: t.warmUp && { passed: t.warmUp.passed, failed: t.warmUp.failed + t.warmUp.errors } };
    } catch (e) {
      be.controllers.delete(id);
      void ctx.dispose();
      throw e;
    }
  }
  const cfg: LoadTestConfig = {
    ...p.config,
    target: p.collection ? target : ctx.vars.resolveDeep(target),
    environmentIsProduction: ctx.environment?.isProduction, allowProduction: ctx.services.production?.allowed, // the guard's consent (production-guard.ts), never the caller's config
    allowRemoteHosts: p.config.allowRemoteHosts || be.settings.loadTesting.allowRemoteHosts,
    maxVirtualUsers: be.settings.loadTesting.maxVirtualUsers,
  };
  // every check (each host's safeguards, the target ready) before Start answers: a refused test is an error here
  const { prepareLoadTest } = await import('@testpion/core');
  const loadDeps = { providers: ctx.services.providers, services: ctx.services, testsDir: be.ws.path('tests') };
  let prepared;
  try {
    prepared = await prepareLoadTest(cfg, loadDeps);
  } catch (e) {
    be.controllers.delete(id);
    void ctx.dispose();
    throw e;
  }
  // what was tested, for the history (URLs with secrets masked)
  const t = cfg.target;
  const targetText =
    t.kind === 'http'
      ? `${t.request.method} ${ctx.redactor.redactUrl(buildUrl(t.request.url, t.request.params).toString())}`
      : t.kind === 'grpc'
        ? `gRPC ${t.request.target} ${t.request.method}`
        : t.kind === 'llm'
          ? `LLM ${t.model.provider}${t.model.name ? `/${t.model.name}` : ''}`
          : t.kind === 'flow' ? `test file ${t.file}` : `collection ${be.ws.getCollection(p.collection!.collectionId).name}${info ? ` (${info.requests.length} requests)` : ''}`;
  const startedAt = new Date().toISOString();
  const ws = be.ws;
  void runLoadTest(cfg, { ...loadDeps, prepared, pricing: be.settings.pricing, redactor: ctx.redactor, signal: ctrl.signal, onSnapshot: (s) => be.host.emit('load.snapshot', { id, snapshot: s }) })
    .then((snap) => {
      // every finished load test is kept in the workspace history (runs/load/history.jsonl)
      if (!snap.requests) return;
      let thresholds: LoadRunRecord['thresholds'];
      try {
        thresholds = p.thresholds?.length ? evaluateThresholds(p.thresholds, snap).map((r) => ({ expr: r.expr, passed: r.passed, actual: r.actual })) : undefined;
      } catch {
        thresholds = undefined;
      }
      recordLoadRun(ws, loadRunRecord(snap, { id, startedAt, savedId: p.savedId, name: p.name || targetText, target: targetText, environment: p.environment, virtualUsers: cfg.virtualUsers, durationSec: cfg.durationSec, stopped: ctrl.signal.aborted || undefined, thresholds }));
      be.host.emit('load.recorded', { id });
    })
    .catch((e) => be.host.emit('load.error', { id, error: normalizeError(e) }))
    .finally(() => {
      be.controllers.delete(id);
      void ctx.dispose();
    });
  be.logger.info('Load test started', { id, vus: cfg.virtualUsers, duration: cfg.durationSec });
  return { id, ...info };
}
