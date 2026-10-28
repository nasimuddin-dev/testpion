/**
 * What a signed-in user may call (cloud stage 1, security review 2026-10-27): every RPC method belongs to a GROUP, the part of its
 * name before the first dot (`git.commit` is in `git`), and a user holds groups (`CallUser.permissions`, request-context.ts).
 * `Backend.invoke` asks `requireCapability` (request-context.ts), i.e. `ctx.can(group)`, before the handler runs and answers a `Forbidden` error when the answer is no.
 *
 * - The desktop app and the CLI have one user who may do everything (`LOCAL_USER`, permissions `*`): behaviour is unchanged.
 * - A server host (`host.serverMode`) that signs users in passes `serverUser(id, groups)`; a call that arrives without a user on a
 *   server host gets `SERVER_DEFAULT_GROUPS`: everything except the groups that act on the SERVER'S OWN computer.
 * - `tests/unit/capabilities.test.ts` makes every handler's group declared here, so a new group cannot slip in unclassified.
 */
import type { CallUser } from './request-context.js';

/** Every method group, with what it is. A group missing here fails the coverage test. */
export const RPC_GROUPS: Readonly<Record<string, string>> = {
  app: 'application shell: version, open a link or a path on this computer',
  rpc: 'the call machinery itself (cancel a call)',
  settings: 'app settings, export, import, reset, certificates',
  auth: 'OAuth tokens',
  logs: 'the app log',
  console: 'the request console',
  ws: 'workspaces: open, create, list, files',
  env: 'environments',
  ref: 'resolve a reference to an item',
  packages: 'script packages',
  lib: 'the shared script library',
  vars: 'variables',
  trash: 'recently deleted items',
  currentValues: 'local current values of variables',
  cookies: 'the cookie jar',
  col: 'collections',
  mock: 'the mock server (listens on this computer)',
  openapi: 'OpenAPI definitions',
  asyncapi: 'AsyncAPI definitions',
  datasets: 'data files',
  http: 'send HTTP requests',
  grpc: 'gRPC',
  history: 'request history',
  stats: 'statistics',
  certificates: 'certificates of servers',
  storage: 'disk usage and cleaning',
  gql: 'GraphQL',
  wsock: 'WebSocket client',
  sio: 'Socket.IO client',
  mqtt: 'MQTT client',
  kafka: 'Kafka client',
  mcp: 'MCP client (and the MCP servers it starts)',
  ai: 'AI features',
  assistant: 'the AI assistant',
  schema: 'schema validation',
  prompt: 'prompt variables',
  search: 'search',
  tests: 'tests and flows',
  ci: 'CI configuration',
  eval: 'evaluations',
  runs: 'runs and results',
  report: 'reports',
  baselines: 'baselines',
  traces: 'traces',
  load: 'load tests',
  monitor: 'monitors',
  agents: 'AI agent setup files',
  feedback: 'feedback to the makers',
  diagnostics: 'diagnostics of this computer',
  git: 'git',
  debug: 'HTTP Debugger: proxy, system proxy, certificate (acts on this computer)',
  secrets: 'secret references',
  scripts: 'script trust',
  record: 'the recorder (listens on this computer)',
  flows: 'flow webhooks (listen on this computer)',
  terminal: 'terminals: a real shell on this computer',
  output: 'saving and copying outputs',
  kinds: 'item kinds',
  item: 'items (remove, restore)',
  workspace: 'workspace files',
  import: 'imports',
  bundle: 'bundles',
  rag: 'RAG evaluation',
};

/** The group of an RPC method: the part before the first dot. */
export const methodGroup = (method: string): string => String(method).split('.')[0]!;

/**
 * Groups a server host does NOT hand to a user it did not sign in with a policy of its own: they open a shell, a listening port, the
 * system proxy or a path on the server's computer, which a tenant must not reach. `serverUser` can grant any of them explicitly.
 */
export const SERVER_DEFAULT_DENIED: ReadonlySet<string> = new Set(['terminal', 'debug', 'app', 'record', 'mock', 'flows', 'diagnostics', 'scripts', 'agents', 'feedback']);

export const SERVER_DEFAULT_GROUPS: ReadonlySet<string> = new Set(Object.keys(RPC_GROUPS).filter((g) => !SERVER_DEFAULT_DENIED.has(g)));

/** Always allowed, whoever calls: cancelling one's own call, the version handshake and the window reporting its own error. */
export const ALWAYS_METHODS: ReadonlySet<string> = new Set(['rpc.cancel', 'app.info', 'app.clientError']);

/** A user signed in to a server host, holding these groups (`'*'` for all). */
export function serverUser(id: string, groups: Iterable<string> | '*' = SERVER_DEFAULT_GROUPS): CallUser {
  return Object.freeze({ id, permissions: groups === '*' ? ('*' as const) : new Set(groups) });
}

/** A user of the development bridge: one fixed user (the bridge token proves it), who may do everything like the desktop owner. */
export const BRIDGE_USER: CallUser = Object.freeze({ id: 'bridge', permissions: '*' as const });
