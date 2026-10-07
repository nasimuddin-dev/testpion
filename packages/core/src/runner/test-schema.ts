import { LineCounter, isMap, isSeq, isScalar, parseDocument, type Node, type Pair } from 'yaml';
import { checkTypes } from '../eval/checks.js';
import { normalizeTest } from './loader.js';

/**
 * What a test file may say, as the loader reads it (loader.ts): the keys of a test, by type, with a line of help for
 * each. One source for the editor's completion and hover, the lint (lintTestFile), the JSON Schema an agent or a
 * JSON editor gets (testFileJsonSchema), and the docs.
 */
export interface TestKeyDoc {
  key: string;
  description: string;
  /** Allowed values, when there is a fixed set. */
  values?: string[];
  /** What goes under the key: a text, a list, a map, a yes/no, a number. */
  shape?: 'text' | 'list' | 'map' | 'boolean' | 'number';
}

const COMMON: TestKeyDoc[] = [
  { key: 'id', description: 'Its id: what other tests name in dependsOn (default: the file name and the test name).', shape: 'text' },
  { key: 'name', description: 'What the test checks, in words.', shape: 'text' },
  {
    key: 'type',
    description: 'The kind of test; left out, it is guessed: url → http, query → graphql, proto → grpc, tool → mcp, prompt → llm.',
    values: ['http', 'graphql', 'grpc', 'websocket', 'mcp', 'llm', 'rag', 'agent'],
    shape: 'text',
  },
  { key: 'description', description: 'Notes for the reader (Markdown).', shape: 'text' },
  { key: 'tags', description: 'Labels to run a selection with (testpion test -t smoke).', shape: 'list' },
  { key: 'skip', description: 'true: the test is listed but not run.', shape: 'boolean' },
  { key: 'timeout', description: 'Milliseconds before the test gives up (timeoutMs works too).', shape: 'number' },
  { key: 'retries', description: 'How often a failing test is tried again.', shape: 'number' },
  { key: 'dependsOn', description: 'The id (or a list of ids) of tests that run first; this one is skipped when they fail. Values they extract are available here.', shape: 'list' },
  { key: 'vars', description: 'Variables for this test only: { key: value }.', shape: 'map' },
  { key: 'extract', description: 'Values taken from the response into variables for later tests: { token: "$.access_token" }.', shape: 'map' },
  { key: 'assertions', description: 'The checks: a list of { type, … } (see the check types; checks works too).', shape: 'list' },
  { key: 'evaluators', description: 'For AI tests: scorers such as similarity, groundedness, llm-judge: a list of { type, … }.', shape: 'list' },
  { key: 'preRequestScript', description: 'A tp.* script that runs before the request (pre_request_script works too).', shape: 'text' },
  { key: 'testScript', description: 'A tp.* script that runs after the response: tp.test(…), tp.expect(…) (script works too).', shape: 'text' },
];

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const BY_TYPE: Record<string, TestKeyDoc[]> = {
  http: [
    { key: 'method', description: 'The HTTP method.', values: HTTP_METHODS, shape: 'text' },
    { key: 'url', description: 'The URL, with {{variables}}; /:name in the path is a path variable.', shape: 'text' },
    { key: 'params', description: 'Query parameters: { key: value } or a list of { key, value } (query works too).', shape: 'map' },
    { key: 'headers', description: 'Headers: { Name: value } or a list of { key, value }.', shape: 'map' },
    { key: 'cookies', description: 'Cookies sent with the request: { name: value }.', shape: 'map' },
    {
      key: 'auth',
      description: 'Authentication: { type: bearer, token } · { type: basic, username, password } · { type: apiKey, key, value, in: header } · oauth2, digest, awsv4, jwt …',
      shape: 'map',
    },
    { key: 'body', description: 'The body: a text, or { type: json | text | form-urlencoded | multipart | xml, content / fields }.', shape: 'map' },
    { key: 'json', description: 'A JSON body, written as YAML (a shorthand for body: { type: json }).', shape: 'map' },
    { key: 'request', description: 'The request as one map (method, url, headers, body …) instead of the keys at the top.', shape: 'map' },
    { key: 'settings', description: 'followRedirects, timeoutMs, insecure (TLS), http1 … of this request.', shape: 'map' },
  ],
  graphql: [
    { key: 'endpoint', description: 'The GraphQL endpoint (url works too).', shape: 'text' },
    { key: 'query', description: 'The operation (query, mutation or subscription).', shape: 'text' },
    { key: 'variables', description: "The operation's variables: { id: 1 } (graphqlVariables works too).", shape: 'map' },
    { key: 'operationName', description: 'Which operation of the document to run.', shape: 'text' },
    { key: 'headers', description: 'Headers: { Name: value }.', shape: 'map' },
    { key: 'auth', description: 'Authentication, as for http.', shape: 'map' },
    { key: 'events', description: 'A subscription: stop after this many events (default 1). The body is the first event ($.data…), every event is in $.events.', shape: 'number' },
    { key: 'wait', description: 'A subscription: milliseconds to listen at most (default 10000; waitMs works too).', shape: 'number' },
  ],
  grpc: [
    { key: 'target', description: 'host:port of the server (address or url work too).', shape: 'text' },
    { key: 'method', description: 'package.Service/Method.', shape: 'text' },
    { key: 'message', description: 'The request message, as YAML (request works too).', shape: 'map' },
    { key: 'metadata', description: 'gRPC metadata: { key: value }.', shape: 'map' },
    { key: 'protos', description: 'The .proto files (a path or a list); left out, the server is asked through reflection (proto works too).', shape: 'list' },
    { key: 'tls', description: 'true for a TLS connection.', shape: 'boolean' },
  ],
  websocket: [
    { key: 'url', description: 'ws://, wss:// (WebSocket), http(s):// (Socket.IO), mqtt:// (MQTT) or kafka://broker:9092 (Kafka; several brokers separated by commas).', shape: 'text' },
    { key: 'mode', description: 'websocket (default), socketio, mqtt or kafka.', values: ['websocket', 'socketio', 'mqtt', 'kafka'], shape: 'text' },
    { key: 'send', description: 'What to send, in order: texts, or { event, data } (Socket.IO), or { topic, message } (MQTT), or { topic, value, key, headers } (Kafka) (messages, message, publish, produce work too).', shape: 'list' },
    { key: 'subscribe', description: 'MQTT: topics to subscribe to (a text, or { topic, qos }). Kafka: topics to read (a text, or { topic, fromBeginning: true }).', shape: 'list' },
    { key: 'groupId', description: 'Kafka: the consumer group (default: one of its own, so it never takes messages from a real consumer).', shape: 'text' },
    { key: 'mechanism', description: 'Kafka SASL: plain (default), scram-sha-256 or scram-sha-512, with username and password.', values: ['plain', 'scram-sha-256', 'scram-sha-512'], shape: 'text' },
    { key: 'wait', description: 'Milliseconds to listen after sending (waitMs works too).', shape: 'number' },
    { key: 'headers', description: 'Handshake headers.', shape: 'map' },
    { key: 'protocols', description: 'WebSocket sub-protocols.', shape: 'list' },
    { key: 'auth', description: 'Socket.IO handshake auth payload.', shape: 'map' },
    { key: 'path', description: 'Socket.IO path (default /socket.io).', shape: 'text' },
    { key: 'clientId', description: 'MQTT client id; Kafka client id.', shape: 'text' },
    { key: 'username', description: 'MQTT or Kafka (SASL) username.', shape: 'text' },
    { key: 'password', description: 'MQTT or Kafka (SASL) password: use a {{secret variable}}.', shape: 'text' },
  ],
  mcp: [
    { key: 'server', description: 'The MCP server, by name or id from the workspace (mcp-servers.json).', shape: 'text' },
    { key: 'tool', description: 'The tool to call.', shape: 'text' },
    { key: 'arguments', description: "The tool's arguments (args works too).", shape: 'map' },
    { key: 'resource', description: 'A resource URI to read instead of calling a tool.', shape: 'text' },
    { key: 'prompt', description: 'A prompt to get: { name, arguments }.', shape: 'map' },
    { key: 'elicitation', description: 'The answer to give when the server asks the user something.', shape: 'map' },
    { key: 'sampling', description: 'The completion to give when the server asks for one (a text, or { text, model }).', shape: 'map' },
    { key: 'roots', description: 'Folders offered to the server as roots.', shape: 'list' },
  ],
  llm: [
    { key: 'model', description: 'The model: "provider/name", or { provider, name, temperature, maxTokens }.', shape: 'text' },
    { key: 'prompt', description: 'The user prompt (with {{variables}}), or { template, system }.', shape: 'text' },
    { key: 'system', description: 'The system prompt.', shape: 'text' },
    { key: 'input', description: 'Values for the {{placeholders}} of the prompt: { key: value }.', shape: 'map' },
    { key: 'expected', description: 'What a good answer looks like, for similarity and judge evaluators.', shape: 'text' },
    { key: 'responseFormat', description: 'json for a JSON answer, or a JSON Schema the answer must match (response_format works too).', shape: 'map' },
    { key: 'stream', description: 'true to stream the answer.', shape: 'boolean' },
    { key: 'tools', description: 'Tools the model may call (function definitions).', shape: 'list' },
    { key: 'limits', description: 'Caps: { latency_ms, tokens, cost }.', shape: 'map' },
    { key: 'dataset', description: 'One test per record of a data file: { file, inputField, expectedField, idField }.', shape: 'map' },
  ],
  rag: [
    { key: 'question', description: 'The question (query works too).', shape: 'text' },
    { key: 'contexts', description: 'The retrieved documents: a list of texts or { id, text, score } (documents, retrieved work too).', shape: 'list' },
    { key: 'answer', description: 'The answer to judge, when it was produced elsewhere; else the model answers.', shape: 'text' },
    { key: 'expected', description: 'The reference answer.', shape: 'text' },
    { key: 'model', description: 'The model that answers from the documents (when answer is not given).', shape: 'text' },
    { key: 'prompt', description: 'The prompt template for the model.', shape: 'text' },
    { key: 'system', description: 'The system prompt.', shape: 'text' },
  ],
  agent: [
    { key: 'model', description: 'The model that drives the agent.', shape: 'text' },
    { key: 'input', description: 'The task for the agent (prompt works too).', shape: 'text' },
    { key: 'system', description: 'The system prompt.', shape: 'text' },
    { key: 'mcpServers', description: 'MCP servers (by name) whose tools the agent may use (mcp_servers works too).', shape: 'list' },
    { key: 'tools', description: 'Tools defined inline.', shape: 'list' },
    { key: 'maxSteps', description: 'The most tool calls before the run stops (max_steps works too).', shape: 'number' },
    { key: 'expected', description: 'The expected outcome, for the judge.', shape: 'text' },
    { key: 'dataset', description: 'One test per record of a data file: { file, inputField, expectedField, idField }.', shape: 'map' },
  ],
};

/** Keys the loader also accepts (older names and shorthands), per type, never offered but never flagged either. */
const ALIASES: Record<string, string[]> = {
  '*': ['timeoutMs', 'timeout_ms', 'pre_request_script', 'test_script', 'script', 'variables', 'metadata', 'checks'],
  http: ['query'],
  graphql: ['url', 'graphqlVariables', 'waitMs'],
  grpc: ['address', 'url', 'request', 'proto'],
  websocket: ['messages', 'message', 'publish', 'produce', 'waitMs'],
  mcp: ['args'],
  llm: ['response_format', 'question', 'messages', 'answer'],
  rag: ['query', 'documents', 'retrieved'],
  agent: ['prompt', 'mcp_servers', 'max_steps'],
};

const FILE_KEYS: TestKeyDoc[] = [
  { key: 'name', description: "The file's name in reports.", shape: 'text' },
  { key: 'description', description: 'Notes for the reader.', shape: 'text' },
  { key: 'defaults', description: 'Keys every test of the file starts with (type, dependsOn, headers …).', shape: 'map' },
  { key: 'tests', description: 'The tests, in order.', shape: 'list' },
];

const SUITE_KEYS: TestKeyDoc[] = [
  { key: 'name', description: "The suite's name.", shape: 'text' },
  { key: 'description', description: 'What it covers.', shape: 'text' },
  { key: 'tests', description: 'Test files or folders under tests/, in order.', shape: 'list' },
  { key: 'concurrency', description: 'How many tests run at once.', shape: 'number' },
  { key: 'retries', description: 'Retries per failing test.', shape: 'number' },
  { key: 'environment', description: 'The environment the suite runs with.', shape: 'text' },
  { key: 'tags', description: 'Only tests with these tags.', shape: 'list' },
];

const ASSERTION_KEYS: TestKeyDoc[] = [
  { key: 'type', description: 'The check type.', values: checkTypes(), shape: 'text' },
  { key: 'name', description: 'What the check is called in reports.', shape: 'text' },
  { key: 'path', description: 'A JSONPath into the body ($.items[0].id) for value checks.', shape: 'text' },
  { key: 'expected', description: 'The value, status, pattern or schema the check compares with.', shape: 'text' },
  { key: 'header', description: 'For header checks: the header name.', shape: 'text' },
  { key: 'max', description: 'For latency / length checks: the most allowed.', shape: 'number' },
  { key: 'min', description: 'For length / threshold checks: the least allowed.', shape: 'number' },
  { key: 'schema', description: 'For json-schema: the schema (or a path to it).', shape: 'map' },
  { key: 'threshold', description: 'For scored checks: the score to pass (0–1).', shape: 'number' },
];

export type TestKeyContext = 'file' | 'suite' | 'test' | 'assertion';

/** The keys the editor offers at a place: a test (of a type, when known), the file, a suite, a check. */
export function testKeys(context: TestKeyContext, type?: string): TestKeyDoc[] {
  if (context === 'file') return FILE_KEYS;
  if (context === 'suite') return SUITE_KEYS;
  if (context === 'assertion') return ASSERTION_KEYS;
  const t = type && BY_TYPE[type] ? type : undefined;
  return [
    ...COMMON,
    ...(t
      ? BY_TYPE[t]!
      : Object.values(BY_TYPE)
          .flat()
          .filter((k, i, all) => all.findIndex((x) => x.key === k.key) === i)),
  ];
}

/** Everything the editor needs, in one object (the app fetches it once over RPC). */
export function testEditorGuide(): {
  file: TestKeyDoc[];
  suite: TestKeyDoc[];
  common: TestKeyDoc[];
  byType: Record<string, TestKeyDoc[]>;
  assertion: TestKeyDoc[];
  checkTypes: string[];
  httpMethods: string[];
} {
  return { file: FILE_KEYS, suite: SUITE_KEYS, common: COMMON, byType: BY_TYPE, assertion: ASSERTION_KEYS, checkTypes: checkTypes(), httpMethods: HTTP_METHODS };
}

/** A JSON Schema (draft-07) of a test file: for JSON test files, agents and validation elsewhere. */
export function testFileJsonSchema(): Record<string, unknown> {
  const prop = (k: TestKeyDoc) => ({
    description: k.description,
    ...(k.values
      ? { enum: k.values }
      : k.shape === 'list'
        ? { type: 'array' }
        : k.shape === 'map'
          ? { type: ['object', 'array', 'string'] }
          : k.shape === 'boolean'
            ? { type: 'boolean' }
            : k.shape === 'number'
              ? { type: 'number' }
              : { type: ['string', 'number', 'boolean', 'object', 'array'] }),
  });
  const test = {
    type: 'object',
    properties: Object.fromEntries([...COMMON, ...Object.values(BY_TYPE).flat()].filter((k, i, all) => all.findIndex((x) => x.key === k.key) === i).map((k) => [k.key, prop(k)])),
    additionalProperties: true,
  };
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'TestPion test file',
    description: 'A test file: either one test, or { name, defaults, tests: [...] }.',
    oneOf: [
      { type: 'object', properties: { ...Object.fromEntries(FILE_KEYS.map((k) => [k.key, prop(k)])), tests: { type: 'array', items: test }, defaults: test }, required: ['tests'] },
      { ...test, required: ['name'] },
    ],
    definitions: { assertion: { type: 'object', properties: Object.fromEntries(ASSERTION_KEYS.map((k) => [k.key, prop(k)])), required: ['type'] } },
  };
}

/** The known key a misspelt one most likely meant (one or two letters off, or a different case), if any. */
function nearest(key: string, known: string[]): string | undefined {
  const k = key.toLowerCase();
  const exact = known.find((x) => x.toLowerCase() === k);
  if (exact) return exact;
  const dist = (a: string, b: string): number => {
    const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0]![j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length]![b.length]!;
  };
  let best: { key: string; d: number } | undefined;
  for (const x of known) {
    const d = dist(k, x.toLowerCase());
    if (d <= 2 && (!best || d < best.d)) best = { key: x, d };
  }
  return best?.key;
}

export interface TestLintProblem {
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** 1-based. */
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

/**
 * What is wrong or doubtful in a test file, with positions: an unknown type or check type, a key the loader does
 * not read (a typo), a dependsOn nobody defines in the file, a method that is not one, a test the loader refuses.
 */
export function lintTestFile(text: string, opts: { file?: string; suite?: boolean } = {}): TestLintProblem[] {
  const out: TestLintProblem[] = [];
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, keepSourceTokens: true });
  const pos = (node: Node | Pair | undefined | null, fallback = 0): [number, number, number, number] => {
    const own = node && 'range' in node ? (node.range as [number, number, number] | null | undefined) : undefined;
    const key = !own && node && 'key' in node ? ((node as Pair).key as Node | null)?.range : undefined;
    const r: [number, number] = own ? [own[0], own[1]] : key ? [key[0], key[1]] : [fallback, fallback + 1];
    const a = lc.linePos(r[0]);
    const b = lc.linePos(r[1]);
    return [a.line, a.col, b.line, b.col];
  };
  const add = (severity: TestLintProblem['severity'], message: string, node?: Node | Pair | null, fallback = 0) => {
    const [line, column, endLine, endColumn] = pos(node, fallback);
    out.push({ severity, message, line, column, endLine, endColumn });
  };
  for (const e of doc.errors) add('error', e.message.split('\n')[0] ?? e.message, undefined, e.pos?.[0] ?? 0);
  if (doc.errors.length) return out;
  const root = doc.contents;
  if (!root) return out;
  if (!isMap(root)) {
    add('error', 'A test file is a map: name, tests: … (or one test with its keys at the top)', root);
    return out;
  }
  const keyOf = (p: Pair) => (isScalar(p.key) ? String(p.key.value) : String(p.key));
  const known = (docs: TestKeyDoc[], extra: string[] = []) => new Set([...docs.map((k) => k.key), ...extra]);

  if (opts.suite) {
    const ok = known(SUITE_KEYS);
    for (const p of root.items) if (!ok.has(keyOf(p))) add('warning', `"${keyOf(p)}" is not a suite key (name, description, tests, concurrency, retries, environment, tags)`, p);
    return out;
  }

  const testsPair = root.items.find((p) => keyOf(p) === 'tests');
  const defaultsPair = root.items.find((p) => keyOf(p) === 'defaults');
  const defaults = defaultsPair && isMap(defaultsPair.value) ? (defaultsPair.value.toJSON() as Record<string, unknown>) : {};
  const ids = new Set<string>();
  const items: Array<{ node: Node; raw: Record<string, unknown> }> = [];
  if (testsPair) {
    const ok = known(FILE_KEYS);
    for (const p of root.items) if (!ok.has(keyOf(p))) add('warning', `"${keyOf(p)}" is not read at the top of a test file (name, description, defaults, tests)`, p);
    if (!isSeq(testsPair.value)) add('error', 'tests: must be a list of tests', testsPair);
    else
      for (const n of testsPair.value.items)
        if (isMap(n)) items.push({ node: n, raw: n.toJSON() as Record<string, unknown> });
        else add('error', 'Each test is a map with name, type, … keys', n as Node);
  } else items.push({ node: root, raw: root.toJSON() as Record<string, unknown> });

  for (const it of items) if (typeof it.raw.id === 'string') ids.add(it.raw.id);
  const typeOf = (raw: Record<string, unknown>): string | undefined => {
    const t = raw.type ?? defaults.type;
    if (typeof t === 'string') return t === 'rest' ? 'http' : t === 'prompt' ? 'llm' : ['ws', 'socketio', 'mqtt', 'kafka'].includes(t) ? 'websocket' : t;
    return raw.request || raw.url ? 'http' : raw.query ? 'graphql' : raw.protos || raw.proto ? 'grpc' : raw.tool ? 'mcp' : raw.prompt ? 'llm' : undefined;
  };
  const types = new Set(COMMON.find((k) => k.key === 'type')!.values!);
  const checks = new Set(checkTypes());
  items.forEach((it, index) => {
    const node = it.node as unknown as { items: Pair[] };
    const pairs = isMap(it.node) ? node.items : [];
    const pairOf = (k: string) => pairs.find((p) => keyOf(p) === k);
    const typePair = pairOf('type');
    const typeKnown = !typePair || types.has(typeOf(it.raw) ?? '');
    // an unknown type is one problem, not one per key: the keys are then checked against every type
    const type = typeKnown ? typeOf({ ...defaults, ...it.raw }) : undefined;
    if (!typeKnown) add('error', `Unknown test type "${String(it.raw.type)}": ${[...types].join(', ')}`, typePair);
    else if (!type) add('warning', 'Which kind of test is this? Add type: http | graphql | grpc | websocket | mcp | llm | rag | agent (or a url, query, proto, tool or prompt)', it.node);
    const ok = known([...COMMON, ...(type ? (BY_TYPE[type] ?? []) : Object.values(BY_TYPE).flat())], [...ALIASES['*']!, ...(type ? (ALIASES[type] ?? []) : Object.values(ALIASES).flat())]);
    for (const p of pairs) {
      const k = keyOf(p);
      if (!ok.has(k)) {
        const near = nearest(k, [...ok]);
        add('warning', near ? `"${k}" is not read: did you mean "${near}"?` : `"${k}" is not a key of a${type ? ` ${type}` : ''} test, so it is ignored`, p);
      }
    }
    const method = pairOf('method');
    if (type === 'http' && method && isScalar(method.value) && !HTTP_METHODS.includes(String(method.value.value).toUpperCase()))
      add('warning', `"${String(method.value.value)}" is not an HTTP method`, method);
    const deps = pairOf('dependsOn');
    if (deps) {
      const list = isSeq(deps.value) ? deps.value.items : [deps.value];
      for (const d of list)
        if (isScalar(d) && d.value !== undefined && !ids.has(String(d.value))) add('info', `No test with id "${String(d.value)}" in this file (fine when it is in another file of the run)`, d as Node);
    }
    const assertions = pairOf('assertions') ?? pairOf('checks');
    if (pairOf('assertions') && pairOf('checks')) add('warning', 'Both assertions: and checks: — only assertions: is read; put every check in one list', pairOf('checks'));
    if (assertions) {
      if (!isSeq(assertions.value)) add('error', `${keyOf(assertions)}: must be a list of { type, … }`, assertions);
      else
        for (const a of assertions.value.items) {
          if (!isMap(a)) {
            add('error', 'Each check is a map: { type: status, expected: 200 }', a as Node);
            continue;
          }
          const tp = (a as unknown as { items: Pair[] }).items.find((p) => keyOf(p) === 'type');
          if (!tp) add('error', 'A check needs a type', a);
          else if (isScalar(tp.value) && !checks.has(String(tp.value.value))) add('error', `Unknown check type "${String(tp.value.value)}": ${[...checks].join(', ')}`, tp);
        }
    }
    // what the loader itself refuses (a missing URL, a bad body …); an unknown type was reported already
    if (typeKnown && type)
      try {
        normalizeTest({ ...defaults, ...it.raw }, opts.file, index);
      } catch (e) {
        add('error', (e as Error).message, it.node);
      }
  });
  return out.sort((a, b) => a.line - b.line || a.column - b.column);
}
