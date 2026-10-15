import { stringifyYaml as stringify } from '../util/lazy-yaml.js';
import type { AuthConfig, BodyConfig, CheckConfig, KeyValue } from '../model/types.js';
import { slugify } from '../util/ids.js';

/**
 * "Save as test": a request from the REST, GraphQL, gRPC or WebSocket view as a YAML test file for the
 * test runner, with its checks (or a sensible first check). Secrets stay {{variables}}: nothing is resolved.
 */
export type TestSource =
  | { kind: 'http'; request: { method: string; url: string; params?: KeyValue[]; headers?: KeyValue[]; body?: BodyConfig; auth?: AuthConfig }; preRequestScript?: string; testScript?: string; status?: number }
  | { kind: 'graphql'; endpoint: string; query: string; variables?: Record<string, unknown>; operationName?: string; headers?: KeyValue[]; auth?: AuthConfig }
  | { kind: 'grpc'; target: string; method: string; message?: unknown; metadata?: KeyValue[]; tls?: boolean }
  | { kind: 'websocket'; mode?: 'websocket' | 'socketio' | 'mqtt' | 'kafka'; url: string; send?: unknown[]; subscribe?: Array<string | { topic: string; fromBeginning?: boolean }>; headers?: KeyValue[]; waitMs?: number; username?: string; password?: string }
  /** An MCP tool call: the server by its name in the workspace. */
  | { kind: 'mcp'; server: string; tool: string; arguments?: Record<string, unknown> }
  /** A prompt (the AI Playground): the model, the prompt and its inputs, what is expected, the evaluators. */
  | { kind: 'llm'; model: { provider: string; name?: string; temperature?: number; topP?: number; maxTokens?: number; seed?: number }; system?: string; prompt: string; input?: Record<string, unknown>; responseFormat?: unknown; expected?: unknown };

const kv = (list?: KeyValue[]) => {
  const on = (list ?? []).filter((h) => h.key && h.enabled !== false);
  return on.length ? Object.fromEntries(on.map((h) => [h.key, h.value])) : undefined;
};
const clean = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))) as T;

export function testFromRequest(name: string, src: TestSource, assertions?: CheckConfig[]): { path: string; yaml: string } {
  const { test, folder } = testObjectFromRequest(name, src, assertions);
  const header = '# Saved from TestPion. Run it with: testpion test <this file>\n';
  return { path: `${folder}/${slugify(name) || 'test'}.yaml`, yaml: header + stringify(test, { lineWidth: 0 }) };
}

/** The test as an object (what testFromRequest writes as YAML; the flow designer adds it as a step) and the tests/ folder it belongs in. */
export function testObjectFromRequest(name: string, src: TestSource, assertions?: CheckConfig[]): { test: Record<string, unknown>; folder: string } {
  let test: Record<string, unknown>;
  let folder: string;
  switch (src.kind) {
    case 'http': {
      const r = src.request;
      const body = r.body && r.body.type !== 'none' ? r.body : undefined;
      test = clean({
        name,
        type: 'http',
        request: clean({
          method: r.method,
          url: r.url,
          params: kv(r.params),
          headers: kv(r.headers),
          auth: r.auth && r.auth.type !== 'none' && r.auth.type !== 'inherit' ? r.auth : undefined,
          body: body && 'content' in body && (body.type === 'json' || body.type === 'text' || body.type === 'xml') ? { type: body.type, content: body.content } : body,
        }),
        preRequestScript: src.preRequestScript?.trim() || undefined,
        testScript: src.testScript?.trim() || undefined,
        assertions: assertions?.length ? assertions : [{ type: 'status', expected: src.status && src.status < 400 ? src.status : 200 }],
      });
      folder = 'rest';
      break;
    }
    case 'graphql':
      test = clean({
        name,
        type: 'graphql',
        endpoint: src.endpoint,
        query: src.query,
        variables: src.variables && Object.keys(src.variables).length ? src.variables : undefined,
        operationName: src.operationName,
        headers: kv(src.headers),
        auth: src.auth && src.auth.type !== 'none' && src.auth.type !== 'inherit' ? src.auth : undefined,
        assertions: assertions?.length ? assertions : [{ type: 'graphql-no-errors' }],
      });
      folder = 'graphql';
      break;
    case 'grpc':
      test = clean({
        name,
        type: 'grpc',
        target: src.target,
        method: src.method,
        message: src.message,
        metadata: kv(src.metadata),
        tls: src.tls || undefined,
        protos: [],
        assertions: assertions?.length ? assertions : [{ type: 'grpc-status', expected: 'OK' }],
      });
      // protos: [] asks the server (reflection)
      test.protos = [];
      folder = 'grpc';
      break;
    case 'mcp':
      test = clean({ name, type: 'mcp', server: src.server, tool: src.tool, arguments: src.arguments ?? {}, assertions: assertions?.length ? assertions : [{ type: 'status', expected: 'success' }] });
      folder = 'mcp';
      break;
    case 'llm':
      test = clean({
        name,
        type: 'llm',
        model: clean({ ...src.model }),
        system: src.system || undefined,
        prompt: src.prompt,
        input: src.input && Object.keys(src.input).length ? src.input : undefined,
        responseFormat: src.responseFormat,
        expected: src.expected,
        // an LLM test's checks are its evaluators
        evaluators: assertions?.length ? assertions : undefined,
      });
      folder = 'ai';
      break;
    default:
      test = clean({
        name,
        type: src.mode === 'mqtt' ? 'mqtt' : src.mode === 'kafka' ? 'kafka' : 'websocket',
        ...(src.mode === 'socketio' ? { mode: 'socketio' } : {}),
        url: src.url,
        subscribe: src.subscribe,
        send: src.send,
        headers: kv(src.headers),
        username: src.username,
        password: src.password && /^\s*\{\{[^}]+\}\}\s*$/.test(src.password) ? src.password : undefined,
        waitMs: src.waitMs ?? 1500,
        assertions: assertions?.length ? assertions : [{ type: 'length', path: '$.received', min: 1 }],
      });
      folder = 'websocket';
  }
  return { test, folder };
}
