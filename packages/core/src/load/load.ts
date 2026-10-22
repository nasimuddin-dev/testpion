import { isIP } from 'node:net';
import type { HttpRequestSpec, LatencyStats, ModelRef, PriceEntry } from '../model/types.js';
import { ApsError, normalizeError } from '../errors.js';
import { buildUrl, executeHttp, timingSummary } from '../protocols/http/client.js';
import { LatencyRecorder, round } from '../util/stats.js';
import { sleep } from '../util/concurrency.js';
import { estimateCost, type ProviderRegistry } from '../ai/index.js';
import type { Redactor } from '../util/redact.js';
import { CookieJar } from '../cookies/cookie-jar.js';
import { parseGrpcTarget, prepareGrpcCall, type GrpcRequestSpec } from '../protocols/grpc/grpc.js';
import type { ExecServices } from '../runner/execute.js';
import { flowLoadFile, flowLoadScenario, type FlowLoadScenario } from './flow-load.js';

export type LoadTarget =
  | { kind: 'http'; request: HttpRequestSpec }
  | { kind: 'llm'; model: ModelRef; prompt: string; stream?: boolean }
  /** Each virtual user runs these requests in order, again and again (a collection or folder; see collectionLoadTarget). */
  | { kind: 'sequence'; name?: string; requests: Array<{ name: string; request: HttpRequestSpec }> }
  /** A unary or server-streaming gRPC method (one client, calls multiplexed over its connection). */
  | { kind: 'grpc'; request: GrpcRequestSpec }
  /** A flow (test file): each virtual user runs the whole flow again and again; per step and per iteration numbers (see flow-load.ts). */
  | { kind: 'flow'; file: string; name?: string };

export interface LoadTestConfig {
  target: LoadTarget;
  virtualUsers: number;
  durationSec: number;
  rampUpSec?: number;
  rampDownSec?: number;
  /** Global cap on request starts per second (0/undefined = unlimited). */
  requestsPerSecond?: number;
  thinkTimeMs?: number;
  /** Safeguards (spec §21): remote hosts and production environments require explicit opt-in. */
  allowRemoteHosts?: boolean;
  allowProduction?: boolean;
  environmentIsProduction?: boolean;
  maxVirtualUsers?: number;
}

export interface LoadSnapshot {
  elapsedSec: number;
  done: boolean;
  activeVUs: number;
  requests: number;
  errors: number;
  connectionFailures: number;
  errorRate: number;
  throughput: number;
  currentRps: number;
  bytes: number;
  latency: LatencyStats;
  statusCodes: Record<string, number>;
  errorKinds: Record<string, number>;
  ai?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    tokensPerSec: number;
    costUsd?: number;
    ttft: LatencyStats;
    interTokenMsAvg?: number;
    generation: LatencyStats;
  };
  series: Array<{ t: number; rps: number; p95: number; errors: number; vus: number }>;
  /** Sequences: each request's numbers, in order. */
  perRequest?: Array<{ name: string; requests: number; errors: number; latency: LatencyStats }>;
  /** Sequences: complete passes through all the requests; flows: runs of the flow. */
  iterations?: number;
  /** Flows: the runs of the whole flow (how many failed, how long one took). */
  iteration?: { count: number; failed: number; latency: LatencyStats };
  /**
   * HTTP: the server's time to first byte, and the connections: how many requests opened a new one (and paid for
   * DNS, TCP and TLS, on average `setupMs`) or reused one from the pool.
   */
  http?: { ttfb: LatencyStats; newConnections: number; reused: number; setupMs?: number };
}

class TokenBucket {
  private tokens: number;
  private last = performance.now();
  constructor(private rate: number) {
    this.tokens = Math.min(rate, 1);
  }
  async take(signal: AbortSignal): Promise<void> {
    for (;;) {
      const now = performance.now();
      this.tokens = Math.min(this.rate, this.tokens + ((now - this.last) / 1000) * this.rate);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.max(1, ((1 - this.tokens) / this.rate) * 1000), signal);
    }
  }
}

const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\.0\.0\.0$/];

/** Hosts considered local/non-production by default. */
export function isLocalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.test') || h.endsWith('.local') || h === '::1') return true;
  if (isIP(h) === 4) return PRIVATE_V4.some((r) => r.test(h));
  if (isIP(h) === 6) return h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
  return false;
}

export function checkLoadSafeguards(cfg: LoadTestConfig, resolvedUrl?: string): void {
  if (cfg.maxVirtualUsers && cfg.virtualUsers > cfg.maxVirtualUsers)
    throw new ApsError('ConfigurationError', `Virtual users (${cfg.virtualUsers}) exceed the configured maximum (${cfg.maxVirtualUsers})`, {
      suggestions: ['Raise the limit in Settings → Load testing if this is intentional.'],
    });
  if (cfg.environmentIsProduction && !cfg.allowProduction)
    throw new ApsError('ConfigurationError', 'A load test against an environment marked as production needs confirmation', {
      why: 'Load tests can degrade or take down live systems.',
      suggestions: ['Run against a staging environment.', 'If you are authorised to load-test production, confirm it: the app asks; from the terminal add --allow-production.'],
    });
  // an unset variable would otherwise surface as a strange "remote host {{baseurl}}" error
  const unresolved = resolvedUrl?.match(/\{\{\s*([^}]+?)\s*\}\}/);
  if (unresolved)
    throw new ApsError('ConfigurationError', `The URL uses {{${unresolved[1]}}}, which is not set`, {
      why: 'Variables in the target URL are resolved from the active environment, the collection and globals before the load test starts.',
      suggestions: [`Choose an environment that defines ${unresolved[1]}, or set it in the active one.`, 'Or type the full URL.'],
    });
  if (resolvedUrl && !cfg.allowRemoteHosts) {
    const host = new URL(resolvedUrl).hostname;
    if (!isLocalHost(host))
      throw new ApsError('ConfigurationError', `Load testing remote host "${host}" requires explicit opt-in`, {
        why: 'By default load tests may only target local or private-network hosts.',
        suggestions: ['Only load-test systems you own or are authorised to test.', 'Enable "Allow remote hosts" for this run (or --allow-remote in the CLI).'],
      });
  }
}

export interface LoadTestDeps {
  providers?: ProviderRegistry;
  pricing?: PriceEntry[];
  redactor?: Redactor;
  signal?: AbortSignal;
  onSnapshot?: (s: LoadSnapshot) => void;
  /** A flow target: the engine services its runs start from, and the tests/ folder its file is in. */
  services?: ExecServices;
  testsDir?: string;
  /** A flow target already prepared (tests). */
  flow?: FlowLoadScenario;
  /** From prepareLoadTest: the checks already passed (a host awaits it so Start fails at once). */
  prepared?: PreparedLoadTest;
}

/** A load test that passed every check, with what its target needs ready (a gRPC caller, a flow's steps, a model). */
export interface PreparedLoadTest {
  url?: string;
  grpcCaller?: Awaited<ReturnType<typeof prepareGrpcCall>>;
  flow?: FlowLoadScenario;
  llm?: ReturnType<ProviderRegistry['resolveModel']>;
}

/**
 * Every check a load test makes before it sends anything (safeguards for each host it would reach, the target
 * ready to run). A host awaits this before it reports the test as started, so a refused test is an error on Start
 * rather than an event after it; runLoadTest calls it when it isn't given the result.
 */
export async function prepareLoadTest(cfg: LoadTestConfig, deps: Pick<LoadTestDeps, 'providers' | 'services' | 'testsDir' | 'flow'> = {}): Promise<PreparedLoadTest> {
  const url = cfg.target.kind === 'http' ? buildUrl(cfg.target.request.url, cfg.target.request.params, cfg.target.request.pathVariables).toString() : undefined;
  checkLoadSafeguards(cfg, url);
  // a sequence: every host must pass the safeguards
  if (cfg.target.kind === 'sequence') {
    if (!cfg.target.requests.length) throw new ApsError('ConfigurationError', 'The collection has no HTTP or GraphQL requests to load-test');
    for (const r of cfg.target.requests) checkLoadSafeguards(cfg, buildUrl(r.request.url, r.request.params, r.request.pathVariables).toString());
  }
  if (cfg.virtualUsers < 1 || cfg.durationSec <= 0) throw new ApsError('ConfigurationError', 'virtualUsers and durationSec must be positive');
  // gRPC: the same host safeguards, then one prepared caller for the whole test
  const grpcCaller = cfg.target.kind === 'grpc' ? await (async (t) => {
    const { address, tls } = parseGrpcTarget(t.request.target, t.request.tls);
    checkLoadSafeguards(cfg, `${tls ? 'https' : 'http'}://${address}`);
    return prepareGrpcCall(t.request);
  })(cfg.target) : undefined;
  // a flow: its steps read once; every host it sends to must pass the safeguards
  let flow: FlowLoadScenario | undefined;
  if (cfg.target.kind === 'flow') {
    if (!deps.flow && !deps.services) throw new ApsError('ConfigurationError', 'A flow load test needs the engine services (variables, providers)');
    flow = deps.flow ?? (await flowLoadScenario({ file: flowLoadFile(cfg.target.file, deps.testsDir ?? process.cwd()), services: deps.services! }));
    for (const u of flow.urls) {
      if (!/\{\{/.test(u)) {
        try {
          new URL(u);
        } catch {
          continue; // not a URL (a gRPC target, an MCP server …)
        }
      }
      checkLoadSafeguards(cfg, u);
    }
  }
  const llm = cfg.target.kind === 'llm' ? deps.providers?.resolveModel(cfg.target.model) : undefined;
  if (cfg.target.kind === 'llm' && !llm) throw new ApsError('ConfigurationError', 'No provider registry for LLM load test');
  return { url, grpcCaller, flow, llm };
}

/** Live load-test recorders stay exact for 20,000 samples, then become histograms (a 30-minute run never sorts millions of samples per tick). */
const LIVE_RECORDER = { exactUpTo: 20_000 };

/** Run a load test. The target must already have variables resolved. */
export async function runLoadTest(cfg: LoadTestConfig, deps: LoadTestDeps): Promise<LoadSnapshot> {
  const { grpcCaller, flow, llm } = deps.prepared ?? (await prepareLoadTest(cfg, deps));

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  deps.signal?.addEventListener('abort', onAbort, { once: true });
  const signal = ctrl.signal;

  const latency = new LatencyRecorder(LIVE_RECORDER);
  const ttft = new LatencyRecorder(LIVE_RECORDER);
  const gen = new LatencyRecorder(LIVE_RECORDER);
  const status: Record<string, number> = {};
  const errKinds: Record<string, number> = {};
  const series: LoadSnapshot['series'] = [];
  let requests = 0;
  let errors = 0;
  let connFail = 0;
  // HTTP: server time and connection reuse
  const ttfbRec = new LatencyRecorder(LIVE_RECORDER);
  let newConns = 0;
  let reusedConns = 0;
  let setupSum = 0;
  const recordHttp = (r: Parameters<typeof timingSummary>[0]) => {
    const t = timingSummary(r);
    if (t.ttfbMs !== undefined) ttfbRec.record(t.ttfbMs);
    if (t.reusedConnection === true) reusedConns++;
    else if (t.reusedConnection === false) {
      newConns++;
      setupSum += (t.dnsMs ?? 0) + (t.tcpMs ?? 0) + (t.tlsMs ?? 0);
    }
  };
  let bytes = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let cost = 0;
  let costKnown = false;
  let interSum = 0;
  let interN = 0;
  let secReq = 0;
  let secErr = 0;
  let secLat = new LatencyRecorder(LIVE_RECORDER);

  const start = performance.now();
  const endAt = start + cfg.durationSec * 1000;
  const up = (cfg.rampUpSec ?? 0) * 1000;
  const down = (cfg.rampDownSec ?? 0) * 1000;
  const targetVUs = (now: number) => {
    const t = now - start;
    const remaining = endAt - now;
    let f = 1;
    if (up > 0 && t < up) f = t / up;
    if (down > 0 && remaining < down) f = Math.min(f, remaining / down);
    return Math.max(1, Math.ceil(cfg.virtualUsers * Math.max(0, f)));
  };
  let active = 0;
  const bucket = cfg.requestsPerSecond ? new TokenBucket(cfg.requestsPerSecond) : undefined;

  const per = cfg.target.kind === 'sequence' ? cfg.target.requests.map((r) => ({ name: r.name, requests: 0, errors: 0, latency: new LatencyRecorder(LIVE_RECORDER) })) : (flow?.steps ?? []).map((name) => ({ name, requests: 0, errors: 0, latency: new LatencyRecorder(LIVE_RECORDER) }));
  const stepRow = new Map<string, number>();
  per.forEach((p, i) => !stepRow.has(p.name) && stepRow.set(p.name, i));
  let iterations = 0;
  let iterFailed = 0;
  const iterLatency = new LatencyRecorder(LIVE_RECORDER);
  /** One request of a sequence: counted like a single-request test, and in its own row. */
  const step = async (i: number, request: HttpRequestSpec, cookieJar?: CookieJar) => {
    const t0 = performance.now();
    const row = per[i]!;
    try {
      const { response } = await executeHttp(request, { signal, discardBody: true, redactor: deps.redactor, cookieJar });
      const ms = performance.now() - t0;
      recordHttp(response);
      bytes += response.size;
      status[response.status] = (status[response.status] ?? 0) + 1;
      latency.record(ms);
      secLat.record(ms);
      row.latency.record(ms);
      if (response.status >= 400) {
        errors++;
        secErr++;
        row.errors++;
      }
    } catch (e) {
      if (signal.aborted) return;
      const err = normalizeError(e);
      errors++;
      secErr++;
      row.errors++;
      errKinds[err.kind] = (errKinds[err.kind] ?? 0) + 1;
      if (err.kind === 'NetworkError' || err.kind === 'TimeoutError') connFail++;
      status[err.kind] = (status[err.kind] ?? 0) + 1;
    } finally {
      if (!signal.aborted) {
        requests++;
        secReq++;
        row.requests++;
      }
    }
  };

  const once = async (jar: CookieJar | undefined, vuIndex: number) => {
    if (flow) {
      try {
        const r = await flow.iterate(vuIndex, signal);
        if (signal.aborted) return;
        for (const s of r.steps) {
          if (s.status === 'skipped') continue;
          const row = per[stepRow.get(s.name) ?? -1];
          const bad = s.status === 'failed' || s.status === 'error';
          requests++;
          secReq++;
          latency.record(s.ms);
          secLat.record(s.ms);
          const code = s.httpStatus !== undefined ? String(s.httpStatus) : s.status;
          status[code] = (status[code] ?? 0) + 1;
          if (bad) {
            errors++;
            secErr++;
          }
          if (row) {
            row.requests++;
            row.latency.record(s.ms);
            if (bad) row.errors++;
          }
        }
        iterations++;
        iterLatency.record(r.ms);
        if (!r.ok) iterFailed++;
      } catch (e) {
        if (signal.aborted) return;
        const err = normalizeError(e);
        errors++;
        secErr++;
        iterFailed++;
        errKinds[err.kind] = (errKinds[err.kind] ?? 0) + 1;
      }
      return;
    }
    if (cfg.target.kind === 'sequence') {
      const reqs = cfg.target.requests;
      for (let i = 0; i < reqs.length; i++) {
        if (signal.aborted || performance.now() >= endAt) return;
        if (i > 0 && bucket) await bucket.take(signal).catch(() => undefined);
        await step(i, reqs[i]!.request, jar);
      }
      iterations++;
      return;
    }
    const t0 = performance.now();
    try {
      if (grpcCaller) {
        const r = await grpcCaller.call(signal);
        const ms = performance.now() - t0;
        latency.record(ms);
        secLat.record(ms);
        status[r.codeName] = (status[r.codeName] ?? 0) + 1;
        if (r.code !== 0) {
          errors++;
          secErr++;
          if (r.codeName === 'UNAVAILABLE' || r.codeName === 'DEADLINE_EXCEEDED') connFail++;
        }
      } else if (cfg.target.kind === 'http') {
        const { response } = await executeHttp(cfg.target.request, { signal, discardBody: true, redactor: deps.redactor });
        const ms = performance.now() - t0;
        recordHttp(response);
        bytes += response.size;
        status[response.status] = (status[response.status] ?? 0) + 1;
        latency.record(ms);
        secLat.record(ms);
        if (response.status >= 400) {
          errors++;
          secErr++;
        }
      } else {
        const tgt = cfg.target as Extract<LoadTarget, { kind: 'llm' }>;
        const r = await llm!.provider.chat({ model: llm!.model, messages: [{ role: 'user', content: tgt.prompt }], stream: tgt.stream ?? true, temperature: tgt.model.temperature, maxTokens: tgt.model.maxTokens, signal });
        const ms = performance.now() - t0;
        latency.record(ms);
        secLat.record(ms);
        gen.record(r.timing.totalMs);
        if (r.timing.firstTokenMs !== undefined) ttft.record(r.timing.firstTokenMs);
        if (r.timing.interTokenMsAvg !== undefined) {
          interSum += r.timing.interTokenMsAvg;
          interN++;
        }
        tokensIn += r.usage.inputTokens;
        tokensOut += r.usage.outputTokens;
        const c = estimateCost(deps.pricing ?? [], llm!.provider.config, r.model || llm!.model, r.usage);
        if (c.cost !== undefined) {
          cost += c.cost;
          costKnown = true;
        }
        status['200'] = (status['200'] ?? 0) + 1;
      }
    } catch (e) {
      if (signal.aborted) return;
      const err = normalizeError(e);
      errors++;
      secErr++;
      errKinds[err.kind] = (errKinds[err.kind] ?? 0) + 1;
      if (err.kind === 'NetworkError' || err.kind === 'TimeoutError') connFail++;
      const st = (err.details?.status as number | undefined) ?? err.kind;
      status[st] = (status[st] ?? 0) + 1;
    } finally {
      requests++;
      secReq++;
    }
  };

  const vu = async (i: number) => {
    // a collection: every virtual user keeps its own cookies, like a real session (log in, then use it)
    const jar = cfg.target.kind === 'sequence' ? new CookieJar() : undefined;
    while (!signal.aborted && performance.now() < endAt) {
      if (i >= targetVUs(performance.now())) {
        await sleep(100, signal).catch(() => undefined);
        continue;
      }
      if (bucket) await bucket.take(signal).catch(() => undefined);
      if (signal.aborted || performance.now() >= endAt) break;
      active++;
      await once(jar, i);
      active--;
      if (cfg.thinkTimeMs) await sleep(cfg.thinkTimeMs, signal).catch(() => undefined);
    }
  };

  const snapshot = (done: boolean): LoadSnapshot => {
    const elapsed = (performance.now() - start) / 1000;
    const snap: LoadSnapshot = {
      elapsedSec: round(elapsed, 1),
      done,
      activeVUs: done ? 0 : targetVUs(performance.now()),
      requests,
      errors,
      connectionFailures: connFail,
      errorRate: requests ? round(errors / requests, 4) : 0,
      throughput: elapsed ? round(requests / elapsed, 2) : 0,
      currentRps: series.length ? series[series.length - 1]!.rps : 0,
      bytes,
      latency: latency.stats(),
      statusCodes: { ...status },
      errorKinds: { ...errKinds },
      series: series.slice(-600),
      ...(cfg.target.kind === 'sequence' || flow ? { iterations, perRequest: per.map((p) => ({ name: p.name, requests: p.requests, errors: p.errors, latency: p.latency.stats() })) } : {}),
      ...(flow ? { iteration: { count: iterations, failed: iterFailed, latency: iterLatency.stats() } } : {}),
      ...(newConns + reusedConns ? { http: { ttfb: ttfbRec.stats(), newConnections: newConns, reused: reusedConns, setupMs: newConns ? round(setupSum / newConns, 1) : undefined } } : {}),
    };
    if (cfg.target.kind === 'llm')
      snap.ai = {
        inputTokens: tokensIn,
        outputTokens: tokensOut,
        totalTokens: tokensIn + tokensOut,
        tokensPerSec: elapsed ? round(tokensOut / elapsed, 1) : 0,
        costUsd: costKnown ? round(cost, 6) : undefined,
        ttft: ttft.stats(),
        interTokenMsAvg: interN ? round(interSum / interN, 2) : undefined,
        generation: gen.stats(),
      };
    return snap;
  };

  const ticker = setInterval(() => {
    const p95 = secLat.stats().p95;
    series.push({ t: round((performance.now() - start) / 1000, 0), rps: secReq, p95, errors: secErr, vus: targetVUs(performance.now()) });
    secReq = 0;
    secErr = 0;
    secLat = new LatencyRecorder(LIVE_RECORDER);
    deps.onSnapshot?.(snapshot(false));
  }, 1000);

  try {
    await Promise.all(Array.from({ length: cfg.virtualUsers }, (_, i) => vu(i)));
  } finally {
    clearInterval(ticker);
    deps.signal?.removeEventListener('abort', onAbort);
    grpcCaller?.close();
  }
  void active;
  const final = snapshot(true);
  deps.onSnapshot?.(final);
  return final;
}
