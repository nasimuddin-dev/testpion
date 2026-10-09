import type { AuthConfig, Collection, CollectionFolder, CollectionNode, RunSummary, SavedGraphQLRequest, SavedHttpRequest, TestCase, TestResult } from '../model/types.js';
import { ApsError } from '../errors.js';
import { sleep } from '../util/concurrency.js';
import { runTests, type RunEvent, type RunOptions } from './runner.js';
import type { DatasetRecord } from './datasets.js';

/** A runnable request in a collection, with its folder path and effective auth. */
export interface CollectionRequestRef {
  id: string;
  name: string;
  /** Folder names from the collection root to the request. */
  path: string[];
  node: SavedHttpRequest | SavedGraphQLRequest;
  auth?: AuthConfig;
  /** The folders around the request, outermost first. */
  folders: CollectionFolder[];
}

/**
 * Requests in collection order. `selection` holds folder and/or request ids (a folder selects everything
 * inside it); when empty, the whole collection is returned.
 */
export function collectionRequests(collection: Collection, selection?: string[]): CollectionRequestRef[] {
  const wanted = selection?.length ? new Set(selection) : undefined;
  const out: CollectionRequestRef[] = [];
  const walk = (nodes: CollectionNode[], path: string[], folders: CollectionFolder[], auth: AuthConfig | undefined, selected: boolean) => {
    for (const n of nodes) {
      if (n.kind === 'folder') {
        walk(n.items, [...path, n.name], [...folders, n], n.auth && n.auth.type !== 'inherit' ? n.auth : auth, selected || !!wanted?.has(n.id));
      } else if (!wanted || selected || wanted.has(n.id)) {
        const own = n.request.auth;
        out.push({ id: n.id, name: n.name, path, folders, node: n, auth: !own || own.type === 'inherit' ? auth : own });
      }
    }
  };
  walk(collection.items, [], [], collection.auth, false);
  return out;
}

/** The folders around a request, outermost first ([] for a top-level request or an unknown id). */
export function folderChain(collection: Collection, requestId: string): CollectionFolder[] {
  const find = (nodes: CollectionNode[], chain: CollectionFolder[]): CollectionFolder[] | undefined => {
    for (const n of nodes) {
      if (n.kind === 'folder') {
        const r = find(n.items, [...chain, n]);
        if (r) return r;
      } else if (n.id === requestId) return chain;
    }
    return undefined;
  };
  return find(collection.items, []) ?? [];
}

/** Folder variables of a chain as one map (inner folders win). */
export function folderVariables(folders: CollectionFolder[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of folders) for (const v of f.variables ?? []) if (v.key && v.enabled !== false) out[v.key] = v.value ?? '';
  return out;
}

/** Join collection-level, folder-level and request-level scripts; blocks keep their `const`s apart. */
function joinScripts(...scripts: Array<string | undefined>): string | undefined {
  const parts = scripts.filter((s): s is string => !!s?.trim());
  if (!parts.length) return undefined;
  return parts.length === 1 ? parts[0] : parts.map((s) => `{\n${s}\n}`).join('\n');
}

/** Convert a collection request into a test case the runner can execute. */
export function collectionRequestToTest(collection: Collection, ref: CollectionRequestRef, extra: { id?: string; name?: string; data?: DatasetRecord } = {}): TestCase {
  const base = {
    id: extra.id ?? ref.id,
    name: extra.name ?? [...ref.path, ref.name].join(' / '),
    location: [collection.name, ...ref.path, ref.name],
    // folder variables sit under the iteration's data row
    variables: ref.folders.some((f) => f.variables?.length) ? { ...folderVariables(ref.folders), ...(extra.data ?? {}) } : extra.data,
    assertions: ref.node.assertions,
  };
  // collection, folder (outer to inner) and request scripts run for GraphQL requests too, as in Postman
  const scripts = {
    preRequestScript: joinScripts(collection.preRequestScript, ...ref.folders.map((f) => f.preRequestScript), ref.node.preRequestScript),
    testScript: joinScripts(collection.testScript, ...ref.folders.map((f) => f.testScript), ref.node.testScript),
  };
  if (ref.node.kind === 'graphql') {
    const r = ref.node.request;
    return { ...base, ...scripts, type: 'graphql', endpoint: r.endpoint, query: r.query, graphqlVariables: r.variables, operationName: r.operationName, headers: r.headers, auth: ref.auth ?? r.auth };
  }
  return { ...base, ...scripts, type: 'http', request: { ...ref.node.request, auth: ref.auth ?? { type: 'none' } } };
}

export interface CollectionRunOptions extends Omit<RunOptions, 'tests' | 'concurrency' | 'setup' | 'teardown' | 'resume'> {
  collection: Collection;
  /** Folder and/or request ids; empty runs the whole collection. */
  selection?: string[];
  /** Defaults to the number of data rows, or 1. */
  iterations?: number;
  /** One row per iteration (`tp.iterationData`, and `{{column}}` in requests). Rows repeat when there are more iterations. */
  data?: DatasetRecord[];
  /** Pause between requests. */
  delayMs?: number;
  /** Safety limit on requests per iteration, so a `setNextRequest` loop can't run forever. Default 1000. */
  maxRequestsPerIteration?: number;
  /**
   * The collection's gRPC calls and WebSocket / MQTT connections (see `collectionRealtimeTests`): they run
   * after its requests in every iteration, with the iteration's data row as variables.
   */
  realtime?: TestCase[];
}

/**
 * Run a collection like Postman's Collection Runner: requests run one at a time in order, variables set by
 * scripts carry over to later requests, `tp.execution.setNextRequest(name|id|null)` changes the order, and
 * each iteration gets one data row.
 */
export async function runCollection(opts: CollectionRunOptions): Promise<RunSummary> {
  const { collection, selection, data, delayMs = 0 } = opts;
  const refs = collectionRequests(collection, selection);
  const realtime = opts.realtime ?? [];
  if (!refs.length && !realtime.length) throw new ApsError('ValidationError', 'Nothing to run: the selection has no requests');
  const iterations = Math.max(1, opts.iterations ?? (data?.length || 1));
  const maxSteps = opts.maxRequestsPerIteration ?? 1000;

  // the generator waits for each result before choosing the next request
  const waiters = new Map<string, (r: TestResult | undefined) => void>();
  const onEvent = (e: RunEvent) => {
    if (e.type === 'test-end') {
      waiters.get(e.result.id)?.(e.result);
      waiters.delete(e.result.id);
    }
    opts.onEvent?.(e);
  };
  const onAbort = () => {
    for (const w of waiters.values()) w(undefined);
    waiters.clear();
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const waitFor = (id: string) => new Promise<TestResult | undefined>((resolve) => (opts.signal?.aborted ? resolve(undefined) : waiters.set(id, resolve)));
  // setNextRequest takes a request id or name
  const find = (target: string) => {
    const byId = refs.findIndex((r) => r.id === target);
    return byId >= 0 ? byId : refs.findIndex((r) => r.name === target);
  };

  const tests = async function* (): AsyncGenerator<TestCase> {
    let first = true;
    for (let it = 0; it < iterations; it++) {
      const row = data?.length ? data[it % data.length] : undefined;
      const seen = new Map<string, number>();
      let i = 0;
      let steps = 0;
      while (i < refs.length) {
        if (opts.signal?.aborted) return;
        if (++steps > maxSteps) throw new ApsError('ValidationError', `Stopped iteration ${it + 1}: more than ${maxSteps} requests — check for a setNextRequest loop`);
        if (!first && delayMs > 0) await sleep(delayMs, opts.signal).catch(() => undefined);
        first = false;
        const ref = refs[i]!;
        const n = (seen.get(ref.id) ?? 0) + 1;
        seen.set(ref.id, n);
        const id = `${ref.id}@${it + 1}${n > 1 ? `#${n}` : ''}`;
        const label = [...ref.path, ref.name].join(' / ');
        const done = waitFor(id);
        yield collectionRequestToTest(collection, ref, { id, name: iterations > 1 ? `#${it + 1} ${label}` : label, data: row });
        const result = await done;
        if (!result) return;
        const next = result.metadata?.nextRequest;
        if (next === null) break; // setNextRequest(null): end this iteration
        if (typeof next === 'string') {
          const j = find(next);
          i = j >= 0 ? j : refs.length; // unknown name ends the iteration, like Postman
        } else i++;
      }
      // then the collection's gRPC calls and connections, in order
      for (const t of realtime) {
        if (opts.signal?.aborted) return;
        if (!first && delayMs > 0) await sleep(delayMs, opts.signal).catch(() => undefined);
        first = false;
        const id = `${t.id}@${it + 1}`;
        const done = waitFor(id);
        yield { ...t, id, name: iterations > 1 ? `#${it + 1} ${t.name}` : t.name, variables: row ? { ...(t.variables ?? {}), ...row } : t.variables };
        if (!(await done)) return;
      }
    }
  };

  try {
    return await runTests({ ...opts, name: opts.name, tests: tests(), concurrency: 1, onEvent });
  } finally {
    // the caller's signal (the app's AbortController) must not keep a finished run reachable
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
