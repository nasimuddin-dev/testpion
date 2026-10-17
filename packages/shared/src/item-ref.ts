/**
 * ItemRef: one way to name a thing in a workspace (a request, a test file, a run, a monitor, a history entry …), the same
 * in the app's window, in MCP tool results, in CLI `--json` output and in `testpion://open` links. It holds ids only (no
 * names, no paths on this computer), so it means the same thing on every host: the desktop app, a server, an agent.
 *
 * The window opens one with `openRef` (apps/desktop/src/lib/open-ref.ts) and names one with `<RefLink>`; the engine says
 * whether one still exists, and what it is called, with `resolveItemRef` (core).
 */

/** The protocol of a request: which editor opens it. */
export type RequestProtocol = 'http' | 'soap' | 'graphql' | 'grpc' | 'websocket';

/** The parts of a collection's settings page a link can go to. */
export type CollectionTab = 'overview' | 'variables' | 'auth' | 'scripts' | 'docs' | 'run' | 'mock';

export type ItemRef =
  /** A request saved in a collection (HTTP, SOAP, GraphQL): `protocol` when known saves a lookup. */
  | { kind: 'request'; collectionId: string; requestId: string; protocol?: RequestProtocol }
  | { kind: 'collection'; collectionId: string; tab?: CollectionTab }
  | { kind: 'folder'; collectionId: string; folderId: string }
  /** An item of a library: gRPC calls (grpc), WebSocket / MQTT / Kafka connections (websocket), prompts (ai-prompts), load tests (load-tests), evaluations (evaluations). */
  | { kind: 'saved'; library: string; itemId: string }
  | { kind: 'monitor'; monitorId: string; runId?: string }
  | { kind: 'environment'; environmentId?: string; scope?: 'globals' | 'workspace' | 'collection'; collectionId?: string }
  | { kind: 'variable'; key: string; environmentId?: string; collectionId?: string }
  /** A file under tests/ (a test or suite file); `step` a test or step id in it, or `line` a line of it (1-based, as text). */
  | { kind: 'test'; path: string; step?: string; line?: string }
  /** A flow file under tests/, opened in the flow designer; `step` a block id. */
  | { kind: 'flow'; path: string; step?: string }
  /** A test by its id across runs (flaky tests): the Tests view. */
  | { kind: 'test-case'; testId: string }
  | { kind: 'run'; runId: string; resultId?: string }
  | { kind: 'history'; historyId: string }
  | { kind: 'trace'; traceId: string }
  /** An exchange the HTTP Debugger captured (only in the session that captured it). */
  | { kind: 'exchange'; exchangeId: string }
  | { kind: 'mcp-server'; serverId: string }
  | { kind: 'provider'; providerId: string }
  /** An API definition: its path in the workspace (specs/…). */
  | { kind: 'spec'; path: string }
  /** A dataset: its name under datasets/. */
  | { kind: 'dataset'; name: string }
  /** A collection's mock server. */
  | { kind: 'mock'; collectionId: string }
  | { kind: 'certificate'; host: string }
  /** A Debugger capture session saved as a HAR file (debugger/sessions/<name>.har): opens in the Debugger. */
  | { kind: 'capture'; name: string }
  /** A changed file in the Git view: its path in the workspace; `line` the line a link pointed at (1-based, as text). */
  | { kind: 'git-file'; path: string; line?: string }
  /** A page of the documentation (https only). */
  | { kind: 'doc'; url: string };

export type ItemKind = ItemRef['kind'];

/** Each kind's id fields: required first, then optional ones (`?`). The order is the order in links. */
export const ITEM_REF_FIELDS: Readonly<Record<ItemKind, readonly string[]>> = {
  request: ['collectionId', 'requestId', 'protocol?'],
  collection: ['collectionId', 'tab?'],
  folder: ['collectionId', 'folderId'],
  saved: ['library', 'itemId'],
  monitor: ['monitorId', 'runId?'],
  environment: ['environmentId?', 'scope?', 'collectionId?'],
  variable: ['key', 'environmentId?', 'collectionId?'],
  test: ['path', 'step?', 'line?'],
  flow: ['path', 'step?'],
  'test-case': ['testId'],
  run: ['runId', 'resultId?'],
  history: ['historyId'],
  trace: ['traceId'],
  exchange: ['exchangeId'],
  'mcp-server': ['serverId'],
  provider: ['providerId'],
  spec: ['path'],
  dataset: ['name'],
  mock: ['collectionId'],
  certificate: ['host'],
  capture: ['name'],
  'git-file': ['path', 'line?'],
  doc: ['url'],
};

export const ITEM_KINDS = Object.keys(ITEM_REF_FIELDS) as ItemKind[];

/** What each kind is called, for people ("Request", "Test file" …). */
export const ITEM_KIND_LABEL: Readonly<Record<ItemKind, string>> = {
  request: 'Request',
  collection: 'Collection',
  folder: 'Folder',
  saved: 'Saved item',
  monitor: 'Monitor',
  environment: 'Environment',
  variable: 'Variable',
  test: 'Test file',
  flow: 'Flow',
  'test-case': 'Test',
  run: 'Run',
  history: 'History entry',
  trace: 'Trace',
  exchange: 'Captured exchange',
  'mcp-server': 'MCP server',
  provider: 'AI provider',
  spec: 'API definition',
  dataset: 'Dataset',
  mock: 'Mock server',
  certificate: 'Certificate',
  capture: 'Capture session',
  'git-file': 'Changed file',
  doc: 'Documentation',
};

/** Library kinds and what one of their items is. */
export const LIBRARY_LABEL: Readonly<Record<string, string>> = {
  grpc: 'gRPC call',
  websocket: 'Connection',
  'ai-prompts': 'Prompt',
  'load-tests': 'Load test',
  evaluations: 'Evaluation',
  monitors: 'Monitor',
};

/** What one item of a ref's kind is called inside a sentence: "run", "test file", "gRPC call", "MCP server". */
export function refNoun(ref: Pick<ItemRef, 'kind'> & { library?: string }): string {
  const label = ref.kind === 'saved' && ref.library ? (LIBRARY_LABEL[ref.library] ?? ITEM_KIND_LABEL.saved) : ITEM_KIND_LABEL[ref.kind];
  // an acronym keeps its case (MCP server, API definition, gRPC call)
  return /^[A-Z]{2}|^g[A-Z]/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);
}

/**
 * The item a workspace file is (a path from the workspace root, `/` or `\` separated): a test file under tests/, a
 * dataset, an API definition; undefined for anything else. "Saved tests/rest/x.yaml" toasts open what they saved.
 */
export function refOfWorkspacePath(path: string): ItemRef | undefined {
  const p = String(path ?? '').replace(/\\/g, '/').replace(/^\.?\//, '');
  const m = /^(tests|datasets|specs)\/(.+)$/.exec(p);
  if (!m) return undefined;
  if (m[1] === 'tests') return /\.(ya?ml|json)$/i.test(m[2]!) ? { kind: 'test', path: m[2]! } : undefined;
  if (m[1] === 'datasets') return { kind: 'dataset', name: m[2]! };
  return { kind: 'spec', path: p };
}

/** The one label of an action that opens a ref elsewhere (WF-13): "Open run", "Open monitor", "Open test file". */
export function refOpenLabel(ref: Pick<ItemRef, 'kind'> & { library?: string }): string {
  return `Open ${refNoun(ref)}`;
}


const PROTOCOLS: readonly string[] = ['http', 'soap', 'graphql', 'grpc', 'websocket'];

/**
 * A value as an ItemRef, or undefined when it isn't one: a known kind, every required id a non-empty string, optional
 * ones strings when present. Fields that aren't the kind's are dropped (a ref from a search hit or an MCP result may
 * carry more), and a library item of `monitors` becomes a monitor ref.
 */
export function toItemRef(value: unknown): ItemRef | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const kind = v.kind as ItemKind;
  const fields = typeof kind === 'string' ? ITEM_REF_FIELDS[kind] : undefined;
  if (!fields) return undefined;
  const out: Record<string, string> = { kind };
  for (const f of fields) {
    const optional = f.endsWith('?');
    const name = optional ? f.slice(0, -1) : f;
    const x = v[name];
    if (x === undefined || x === null || x === '') {
      if (optional) continue;
      return undefined;
    }
    if (typeof x !== 'string' || x.length > 2048) return undefined;
    out[name] = x;
  }
  if (kind === 'request' && out.protocol && !PROTOCOLS.includes(out.protocol)) delete out.protocol;
  if (kind === 'doc' && !/^https:\/\//i.test(out.url!)) return undefined;
  if (kind === 'saved' && out.library === 'monitors') return { kind: 'monitor', monitorId: out.itemId! };
  return out as unknown as ItemRef;
}

/** A stable text for a ref (the same ref, the same key): for maps, React keys and comparing. */
export function itemRefKey(ref: ItemRef): string {
  const r = ref as unknown as Record<string, string | undefined>;
  return [ref.kind, ...ITEM_REF_FIELDS[ref.kind].map((f) => r[f.replace(/\?$/, '')] ?? '')].join('|');
}

/** The deep link that opens a ref in the desktop app: `testpion://open?kind=request&collectionId=…&requestId=…`. */
export function itemRefUrl(ref: ItemRef): string {
  const r = ref as unknown as Record<string, string | undefined>;
  const parts = [`kind=${encodeURIComponent(ref.kind)}`];
  for (const f of ITEM_REF_FIELDS[ref.kind]) {
    const name = f.replace(/\?$/, '');
    if (r[name] !== undefined) parts.push(`${name}=${encodeURIComponent(r[name]!)}`);
  }
  return `testpion://open?${parts.join('&')}`;
}

/**
 * The ref of a `testpion://open` link: `?kind=…&<ids>` (what itemRefUrl makes) or `?ref=<JSON>`; undefined for anything
 * else (another scheme or action, an unknown kind, a missing id).
 */
export function parseItemRefUrl(url: string): ItemRef | undefined {
  const m = /^testpion:\/\/open\/?\?(.*)$/i.exec(String(url ?? '').trim());
  if (!m) return undefined;
  const params: Record<string, string> = {};
  for (const pair of m[1]!.split('&')) {
    if (!pair) continue;
    const at = pair.indexOf('=');
    try {
      const key = decodeURIComponent(at < 0 ? pair : pair.slice(0, at));
      params[key] = decodeURIComponent(at < 0 ? '' : pair.slice(at + 1).replace(/\+/g, ' '));
    } catch {
      return undefined;
    }
  }
  if (params.ref !== undefined) {
    try {
      return toItemRef(JSON.parse(params.ref));
    } catch {
      return undefined;
    }
  }
  return toItemRef(params);
}

/**
 * A ref as people and agents write it on a command line: a `testpion://open` link, a JSON object, or the short form
 * `kind:id[:id…]` with the kind's required ids in order (`request:<collectionId>:<requestId>`, `run:<runId>`,
 * `test:smoke/login.yaml`).
 */
export function parseItemRef(text: string): ItemRef | undefined {
  const t = String(text ?? '').trim();
  if (!t) return undefined;
  if (/^testpion:/i.test(t)) return parseItemRefUrl(t);
  if (t.startsWith('{')) {
    try {
      return toItemRef(JSON.parse(t));
    } catch {
      return undefined;
    }
  }
  const at = t.indexOf(':');
  if (at < 0) return undefined;
  const kind = t.slice(0, at) as ItemKind;
  const fields = ITEM_REF_FIELDS[kind];
  if (!fields) return undefined;
  const required = fields.filter((f) => !f.endsWith('?'));
  const rest = t.slice(at + 1);
  // the last required id takes the rest (a path or a URL may hold ':')
  const values: string[] = [];
  let tail = rest;
  for (let i = 0; i < required.length - 1; i++) {
    const c = tail.indexOf(':');
    if (c < 0) return undefined;
    values.push(tail.slice(0, c));
    tail = tail.slice(c + 1);
  }
  // a run id (TestPion makes it: never a ':') may be followed by its result: run:<runId>:<resultId>, run:last:<resultId>
  if (kind === 'run' && tail.includes(':')) {
    const c = tail.indexOf(':');
    return toItemRef({ kind, runId: tail.slice(0, c), resultId: tail.slice(c + 1) });
  }
  values.push(tail);
  return toItemRef(Object.fromEntries([['kind', kind], ...required.map((f, i) => [f, values[i]])]));
}

/** The ref of a library item (a monitor's is a monitor ref). */
export const savedItemRef = (library: string, itemId: string): ItemRef => (library === 'monitors' ? { kind: 'monitor', monitorId: itemId } : { kind: 'saved', library, itemId });

/** A history entry's kind as the protocol of the editor that sends it again. */
export const historyProtocol = (kind: string): RequestProtocol | 'mcp' | 'llm' | undefined =>
  kind === 'http' || kind === 'graphql' || kind === 'grpc' || kind === 'websocket' || kind === 'mcp' || kind === 'llm' ? kind : undefined;

/**
 * Why a ref could not be opened, and what to do instead: the answer of `resolveItemRef` (core) and the `ref.resolve`
 * RPC. `next` is the nearest thing that is still there (the collection of a deleted request, the Tests view …).
 */
export type RefResolution =
  | { ok: true; ref: ItemRef; label: string; detail?: string }
  | { ok: false; ref: ItemRef; reason: 'missing' | 'invalid' | 'unavailable'; message: string; next?: { label: string; ref?: ItemRef; view?: string } };
