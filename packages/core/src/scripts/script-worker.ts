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
import { evaluateExpressionInThread, renderTemplateInThread, runMetricScriptInThread, runScriptInThread } from './sandbox.js';

const port = parentPort!;
const shared = (workerData as { pkg: SharedArrayBuffer }).pkg;
const ctl = new Int32Array(shared, 0, 2); // [0] 0 = waiting, 1 = answered; [1] byte length, -1 = none
const HEADER = 8;
const replies = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>(); // bounded: the sends of the one job in flight
let reqSeq = 0;

function sendRequest(jobId: number, request: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const reqId = ++reqSeq;
    replies.set(reqId, { resolve, reject });
    port.postMessage({ type: 'send', id: jobId, reqId, request });
  });
}

function requirePackage(jobId: number, name: string): string | undefined {
  Atomics.store(ctl, 0, 0);
  port.postMessage({ type: 'pkg', id: jobId, name });
  Atomics.wait(ctl, 0, 0, 5000);
  const len = Atomics.load(ctl, 1);
  if (Atomics.load(ctl, 0) !== 1 || len < 0) return undefined;
  return Buffer.from(shared, HEADER, len).toString('utf8');
}

interface Job {
  type: 'job';
  id: number;
  op: 'script' | 'expression' | 'template' | 'metric';
  args: unknown[];
  hasSend?: boolean;
  hasPackages?: boolean;
}

async function run(job: Job): Promise<unknown> {
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
    (e: unknown) => port.postMessage({ type: 'error', id: m.id, message: e instanceof Error ? e.message : String(e) }),
  );
});

port.postMessage({ type: 'ready' });
