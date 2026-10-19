/**
 * WF-06: the production guard at the backend boundary. Every RPC method that sends to an API or runs requests is
 * listed here with what it would do; `Backend.invoke` passes every call through `guardProduction`, so no window, web
 * bridge or future cloud client can send to an environment marked as production without consent:
 *
 * - a single send that changes data (POST …, a GraphQL mutation, a gRPC call that is not a read, a message on an open
 *   connection, an MCP tool call that is not read-only) and every run (tests, flows, collections, monitors, load,
 *   data runs, matrices) is refused with a production refusal (core net/production-guard.ts) unless the call carries
 *   `allowProduction: true`;
 * - the window's one shared confirm (src/lib/production-guard.ts) answers the refusal and calls again with it;
 * - the consent travels with the call (`allowProductionFor`), so the engine contexts the handler creates may change
 *   the production environment, and only those (the engine refuses data-changing steps everywhere else).
 *
 * Connections (WebSocket, Socket.IO, MQTT, Kafka, MCP) remember the environment they were opened with: a message sent
 * later goes to that server, whichever environment is active by then.
 */
import {
  allowProductionFor,
  attemptFixTarget,
  collectionRequests,
  detectOperation,
  findMonitor,
  folderChain,
  readRunSummary,
  isDataChangingMethod,
  isGraphQLMutation,
  isGrpcReadMethod,
  productionRefusal,
  type ProductionAsk,
} from '@testpion/core';
import type { Backend } from './backend.js';

type Ask = Omit<ProductionAsk, 'environment'> & { environment?: string };
type Params = Record<string, any>;
interface Session {
  environment?: string;
  /** MCP: the tools the server marks read-only (annotations.readOnlyHint). */
  readOnlyTools?: Set<string>;
}
type Sessions = Map<string, Session>;

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const message = (environment: string | undefined, what: string): Ask => ({ environment, action: what, changesData: true });
const run = (environment: string | undefined, action: string, extra: Partial<Ask> = {}): Ask => ({ environment, action, changesData: false, run: true, ...extra });

/** A collection run's requests and how many of them change data (in memory: the collection is already read). */
function collectionRun(be: Backend, p: Params, action: (name: string) => string): Ask {
  try {
    const c = be.ws.getCollection(String(p.collectionId));
    const refs = collectionRequests(c, Array.isArray(p.selection) ? p.selection : undefined);
    const changing = refs.filter((r) =>
      r.node.kind === 'graphql' ? isGraphQLMutation(detectOperation(r.node.request.query ?? '').type, r.node.request.query ?? '') : isDataChangingMethod(r.node.request.method),
    ).length;
    return run(str(p.environment), action(c.name), { requests: refs.length, changing, changesData: changing > 0 });
  } catch {
    return run(str(p.environment), action('a collection')); // the handler says what is wrong with it
  }
}

/**
 * Whether the scripts that run with a send (its own, its folders', its collection's) call tp.sendRequest / pm.sendRequest:
 * they may change data whatever the request's method, so the send asks (the engine refuses them otherwise).
 */
function scriptsSend(be: Backend, p: Params): boolean {
  const uses = (s: unknown) => typeof s === 'string' && /\b(tp|pm)\.sendRequest\b/.test(s);
  if (uses(p.preRequestScript) || uses(p.testScript)) return true;
  if (!p.collectionId) return false;
  try {
    const c = be.ws.getCollection(String(p.collectionId));
    if (uses(c.preRequestScript) || uses(c.testScript)) return true;
    const folders = p.requestId ? folderChain(c, String(p.requestId)) : [];
    return folders.some((f) => uses(f.preRequestScript) || uses(f.testScript));
  } catch {
    return false;
  }
}

/** Every method that sends or runs: what it would do, against which environment. */
type Rule = (be: Backend, p: Params, sessions: Sessions) => Ask | Ask[] | undefined | Promise<Ask | undefined>;
const RULES: Record<string, Rule> = {
  'http.send': (be, p) => {
    const method = String(p.request?.method ?? 'GET').toUpperCase();
    const scripted = scriptsSend(be, p);
    return { environment: str(p.environment), action: `Send ${method} ${p.name ?? p.request?.url ?? ''}${scripted ? ' (its scripts send requests too)' : ''}`.trim(), changesData: isDataChangingMethod(method) || scripted };
  },
  'http.compareEnvironments': (_be, p) => {
    const method = String(p.request?.method ?? 'GET').toUpperCase();
    return [str(p.left), str(p.right)].map((environment) => ({ environment, action: `Send ${method} ${p.name ?? p.request?.url ?? ''}`.trim(), changesData: isDataChangingMethod(method) }));
  },
  'gql.send': (be, p) => {
    const query = String(p.request?.query ?? '');
    const scripted = scriptsSend(be, p);
    const mutation = isGraphQLMutation(detectOperation(query, p.operationName).type, query);
    return {
      environment: str(p.environment),
      action: `Send ${mutation ? 'the GraphQL mutation' : 'the GraphQL query'} ${p.operationName ?? p.name ?? ''}${scripted ? ' (its scripts send requests too)' : ''}`.trim(),
      changesData: mutation || scripted,
    };
  },
  'grpc.send': (_be, p) => ({ environment: str(p.environment), action: `Call ${p.method ?? 'the gRPC method'}`, changesData: !isGrpcReadMethod(p.method) }),
  'wsock.send': (_be, p, s) => message(s.get(String(p.id))?.environment ?? str(p.environment), 'Send a WebSocket message'),
  'sio.emit': (_be, p, s) => message(s.get(String(p.id))?.environment ?? str(p.environment), `Emit "${p.event ?? ''}" over Socket.IO`),
  'mqtt.publish': (_be, p, s) => message(s.get(String(p.id))?.environment ?? str(p.environment), `Publish to ${p.topic ?? 'an MQTT topic'}`),
  'kafka.produce': (_be, p, s) => message(s.get(String(p.id))?.environment ?? str(p.environment), `Produce to ${p.topic ?? 'a Kafka topic'}`),
  'mcp.call': (_be, p, s) => {
    const session = s.get(String(p.serverId));
    return { environment: session?.environment, action: `Call the MCP tool ${p.tool ?? ''}`.trim(), changesData: !session?.readOnlyTools?.has(String(p.tool)) };
  },
  'col.run': (be, p) => collectionRun(be, p, (name) => `Run ${name}`),
  'col.rerunFailed': (be, p) => collectionRun(be, { ...p, selection: failedIds(be, p.runId) }, (name) => `Run the failed requests of ${name}`),
  'tests.run': (_be, p) => run(str(p.environment), `Run ${Array.isArray(p.paths) && p.paths.length ? p.paths.join(', ') : 'all tests'}`),
  'tests.rerunFailed': (_be, p) => run(str(p.environment), 'Run the failed tests again'),
  'runs.runAgain': (be, p) => run(str(p.environment) ?? runEnvironment(be, p.runId), `Run ${p.resultIds?.length ? 'results of ' : ''}${p.runId === 'last' ? 'the last run' : `run ${p.runId}`} again`),
  'tests.flowRun': (_be, p) => run(str(p.environment), `Run the flow ${p.file ?? ''}`.trim()),
  'tests.dataRun': (_be, p) => run(str(p.environment), `Run ${p.file ?? 'the flow'} once per data row`),
  'tests.matrixRun': (_be, p) => (Array.isArray(p.environments) ? p.environments : []).map((e: unknown) => run(str(e), `Run ${p.file ?? 'the flow'} in several environments`)),
  'eval.run': (_be, p) => run(str(p.environment), `Run the evaluation ${p.name ?? ''}`.trim()),
  'eval.runDraft': (_be, p) => run(str(p.environment), `Run the evaluation ${p.draft?.name ?? ''}`.trim()),
  // a question to a RAG system is a POST unless the target says it only answers
  'rag.probe': (_be, p) => (p.target?.readOnly ? undefined : message(str(p.environment), 'Ask the RAG system a question')),
  'load.start': (_be, p) => run(str(p.environment), `Start the load test ${p.name ?? ''}`.trim(), { changesData: true }),
  'flows.webhooks.start': (_be, p) => run(str(p.environment), 'Serve the flows behind their webhooks'),
  'monitor.run': (be, p) => {
    const m = findMonitorSafe(be, p.id);
    // saved with consent: Run now asks nothing more
    return m && !m.allowProduction ? run(m.environment, `Run the monitor ${m.name}`) : undefined;
  },
  'monitor.save': (be, p) => {
    const m = p.monitor as { id?: string; name?: string; environment?: string } | undefined;
    const before = m?.id ? findMonitorSafe(be, m.id) : undefined;
    // the consent stays while the environment does
    if (before?.allowProduction && before.environment === m?.environment) return undefined;
    return run(str(m?.environment), `Run the monitor${m?.name ? ` ${m.name}` : ''} on its schedule`);
  },
  // AI-5 Attempt to fix: applies a flaky test's fix, then runs the test again in the environment of its runs
  'ai.attemptFix': async (be, p) => {
    const t = await attemptFixTarget(be.ws, String(p.id)).catch(() => undefined); // the handler says what is wrong with it
    const times = Math.min(Math.max(Math.round(Number(p.times) || 5), 1), 20);
    return t && run(t.rerun.environment, `Attempt to fix ${t.name}: run it ${times} times`);
  },
};

/** The environment a recorded run used (Run again uses it unless told otherwise). */
function runEnvironment(be: Backend, runId: unknown): string | undefined {
  try {
    const id = runId === 'last' ? be.ws.meta.listRuns({ limit: 1 }).items[0]?.id : String(runId);
    return id ? readRunSummary(be.ws, id)?.environment : undefined;
  } catch {
    return undefined;
  }
}

function failedIds(be: Backend, runId: unknown): string[] | undefined {
  try {
    return be.ws.failedTestIds(String(runId)).ids;
  } catch {
    return undefined;
  }
}

function findMonitorSafe(be: Backend, id: unknown) {
  try {
    return findMonitor(be.ws, String(id));
  } catch {
    return undefined;
  }
}

/** Connections remember their environment (and MCP servers their read-only tools) from the answer to the connect. */
const OPENED: Record<string, (p: Params, r: any) => [string, Session] | undefined> = {
  'wsock.connect': (p, r) => r?.id && [String(r.id), { environment: str(p.environment) }],
  'sio.connect': (p, r) => r?.id && [String(r.id), { environment: str(p.environment) }],
  'mqtt.connect': (p, r) => r?.id && [String(r.id), { environment: str(p.environment) }],
  'kafka.connect': (p, r) => r?.id && [String(r.id), { environment: str(p.environment) }],
  'mcp.connect': (p, r) => [
    String(p.serverId),
    {
      environment: str(p.environment),
      readOnlyTools: new Set(
        ((r?.tools ?? r?.discovery?.tools ?? []) as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>).filter((t) => t?.annotations?.readOnlyHint === true).map((t) => t.name),
      ),
    },
  ],
};
const CLOSED: Record<string, (p: Params) => string> = {
  'wsock.close': (p) => String(p.id),
  'sio.close': (p) => String(p.id),
  'mqtt.close': (p) => String(p.id),
  'kafka.close': (p) => String(p.id),
  'mcp.disconnect': (p) => String(p.serverId),
};

const sessionsOf = new WeakMap<Backend, Sessions>();
/** Connections are few (one per open tab); a workspace switch closes them all, so the list never outgrows this. */
const MAX_SESSIONS = 500;

/** Which methods are guarded (tests enumerate them: every send and run path is covered). */
export const GUARDED_METHODS = Object.keys(RULES);

/**
 * Run one RPC call through the guard: refused when it would change (or run against) a production environment without
 * `allowProduction: true`, else run with the consent it has, so the engine contexts it creates know.
 */
export async function guardProduction<T>(be: Backend, method: string, params: unknown, call: () => Promise<T>): Promise<T> {
  const p = (params && typeof params === 'object' ? params : {}) as Params;
  let sessions = sessionsOf.get(be);
  if (!sessions) sessionsOf.set(be, (sessions = new Map()));
  const rule = Object.hasOwn(RULES, method) ? RULES[method] : undefined;
  let allowed: boolean | undefined;
  if (rule && be.store) {
    for (const ask of [(await rule(be, p, sessions)) ?? []].flat()) {
      const env = ask.environment ? be.ws.getEnvironment(ask.environment) : undefined;
      if (!env?.isProduction) continue;
      if (p.allowProduction === true) allowed = true;
      else if (ask.changesData || ask.run) throw productionRefusal({ ...ask, environment: env.name }, 'Confirm it in the app (it asks before sending), or pass allowProduction: true.');
      else allowed ??= false;
    }
  }
  const r = allowed === undefined ? await call() : await allowProductionFor(allowed, call);
  const opened = Object.hasOwn(OPENED, method) ? OPENED[method]!(p, r) : undefined;
  if (opened) {
    sessions.delete(opened[0]);
    sessions.set(opened[0], opened[1]);
    if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
  }
  if (Object.hasOwn(CLOSED, method)) sessions.delete(CLOSED[method]!(p));
  return r;
}

/** A workspace switch closes every connection: forget their environments. */
export function forgetProductionSessions(be: Backend): void {
  sessionsOf.get(be)?.clear();
}
