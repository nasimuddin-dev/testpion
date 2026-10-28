/**
 * The script engine inside a worker thread (see script-runner-workers.ts). The main thread sends one job at a time; the
 * worker runs it in QuickJS exactly as the in-thread runner does and answers with the result. The two host functions a
 * script may call come back over messages:
 *  - `tp.sendRequest` is asynchronous: a `send` message, answered by a `reply` message (the main thread sends the request
 *    with the call's network configuration, trust gates and limits);
 *  - `tp.require(name)` is synchronous inside the engine: a `pkg` message, answered through a SharedArrayBuffer the worker
 *    waits on (the package source of the workspace, up to the buffer's size).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { ApsError } from '../errors.js';
import { evaluateExpressionInThread, renderTemplateInThread, runMetricScriptInThread, runScriptInThread } from './sandbox.js';

const port = parentPort!;
const shared = (workerData as { pkg: SharedArrayBuffer }).pkg;
// The require bridge: [0] unused, [1] answer byte length, [2] sequence number asked (worker), [3] sequence number answered (host),
// [4] status (0 = source, 1 = no such package, 2 = the host failed: the bytes are the message). The host ignores a request the worker has
// given up on, and the worker ignores an answer for any other number, so a late answer is never taken for the next request's.
const ctl = new Int32Array(shared, 0, 8);
const HEADER = 32;
const replies = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>(); // bounded: the sends of the one job in flight
let reqSeq = 0;
let pkgSeq = 0; // bounded: a counter, one per worker thread
let requireWaitMs = 10_000; // bounded: a number, set by each job of this worker thread

function sendRequest(jobId: number, request: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const reqId = ++reqSeq;
    replies.set(reqId, { resolve, reject });
    port.postMessage({ type: 'send', id: jobId, reqId, request });
  });
}

/** The source of a workspace package: undefined when there is none; an Error when the host failed or did not answer in time (never `undefined` for that). */
function requirePackage(jobId: number, name: string): string | undefined {
  const seq = ++pkgSeq;
  Atomics.store(ctl, 2, seq);
  port.postMessage({ type: 'pkg', id: jobId, name, seq });
  const end = Date.now() + requireWaitMs;
  for (;;) {
    const got = Atomics.load(ctl, 3);
    if (got === seq) break;
    const left = end - Date.now();
    if (left <= 0) throw new Error(`the host did not answer within ${requireWaitMs} ms (it is busy)`);
    Atomics.wait(ctl, 3, got, left);
  }
  const status = Atomics.load(ctl, 4);
  const len = Atomics.load(ctl, 1);
  if (status === 1 || len < 0) return undefined;
  const text = Buffer.from(shared, HEADER, len).toString('utf8');
  if (status === 2) throw new Error(text);
  return text;
}

interface Job {
  type: 'job';
  id: number;
  op: 'script' | 'expression' | 'template' | 'metric';
  args: unknown[];
  hasSend?: boolean;
  hasPackages?: boolean;
  requireWaitMs?: number;
}

async function run(job: Job): Promise<unknown> {
  if (job.requireWaitMs) requireWaitMs = job.requireWaitMs;
  const a = job.args as never[];
  switch (job.op) {
    case 'script': {
      const opts = { ...(a[2] as object), ...(job.hasSend ? { sendRequest: (r: never) => sendRequest(job.id, r) } : {}), ...(job.hasPackages ? { requirePackage: (n: string) => requirePackage(job.id, n) } : {}) };
      return runScriptInThread(a[0], a[1], opts as never);
    }
    case 'expression':
      return evaluateExpressionInThread(a[0], a[1], a[2]);
    case 'template':
      return renderTemplateInThread(a[0], a[1], a[2]);
    case 'metric':
      return runMetricScriptInThread(a[0], a[1], a[2]);
  }
}

port.on('message', (m: Job | { type: 'reply'; reqId: number; response?: unknown; error?: string }) => {
  if (m.type === 'reply') {
    const p = replies.get(m.reqId);
    replies.delete(m.reqId);
    if (m.error !== undefined) p?.reject(new Error(m.error));
    else p?.resolve(m.response);
    return;
  }
  void run(m).then(
    (value) => port.postMessage({ type: 'result', id: m.id, value }),
    (e: unknown) => port.postMessage({ type: 'error', id: m.id, kind: e instanceof ApsError ? e.kind : undefined, message: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }),
  );
});

port.postMessage({ type: 'ready' });
