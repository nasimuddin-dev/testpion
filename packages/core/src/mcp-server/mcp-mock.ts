import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ApsError } from '../errors.js';
import { dynamicValue } from '../vars/dynamic.js';
import { runScript } from '../scripts/sandbox.js';
import type { McpDiscovery } from '../protocols/mcp/client.js';

/**
 * MCP mock server: a fake MCP server from a definition (tools with canned responses, resources and
 * prompts), to test AI agents and MCP clients without the real server or its side effects.
 * Definitions are YAML/JSON files (`*.mcp-mock.yaml`), written by hand or recorded from a real
 * server with `mockFromDiscovery`.
 */
export interface McpMockResponse {
  /** Use this response when the call's arguments contain these values (deep equal); omit for the default. */
  when?: Record<string, unknown>;
  /** Text content; `{{args.name}}` is replaced by the call's argument. */
  text?: string;
  /** JSON content (sent as text JSON and as structuredContent); `{{args.name}}` works in its strings. */
  json?: unknown;
  /** Raw MCP content items, if you need images or several parts. */
  content?: unknown[];
  /**
   * A script that computes the answer from the call's arguments, run in the test-script sandbox (no network, no
   * files): `(args) => result`, or a body with `return`. A string result is text; anything else is JSON (also sent as
   * structuredContent); `{ content: [...] }` is sent as is. A thrown error is a tool error with its message.
   */
  script?: string;
  isError?: boolean;
}

/** The mock's answer to a tool call: content items, structured content and whether it is a tool error. */
export interface McpMockResult {
  content: unknown[];
  isError?: boolean;
  structuredContent?: unknown;
}

export interface McpMockDefinition {
  schemaVersion?: string;
  name: string;
  version?: string;
  instructions?: string;
  tools?: Array<{ name: string; title?: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown>; responses?: McpMockResponse[] }>;
  resources?: Array<{ uri: string; name: string; description?: string; mimeType?: string; text?: string }>;
  prompts?: Array<{ name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }>; messages?: Array<{ role: 'user' | 'assistant'; text: string }> }>;
}

/** Parse a mock definition (YAML or JSON) and check its shape. */
export function loadMcpMock(text: string): McpMockDefinition {
  const d = parseYaml(text) as McpMockDefinition;
  if (!d || typeof d !== 'object' || !d.name) throw new ApsError('ValidationError', 'An MCP mock needs at least a "name" (and usually "tools")');
  for (const t of d.tools ?? []) if (!t.name) throw new ApsError('ValidationError', 'Every tool in the MCP mock needs a "name"');
  return d;
}

export function dumpMcpMock(d: McpMockDefinition): string {
  return stringifyYaml({ schemaVersion: '1.0', ...d }, { lineWidth: 120 });
}

const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const subset = (args: Record<string, unknown>, when: Record<string, unknown>) => Object.entries(when).every(([k, v]) => deepEqual(args[k], v));
/** `{{args.x}}` from the call, or a dynamic variable (`{{$guid}}`, `{{$randomInt(1,9)}}` …) with a fresh value. */
const lookup = (path: string, vars: Record<string, unknown>): unknown =>
  path.startsWith('$') ? dynamicValue(path) : path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), vars);
const PLACEHOLDER = /\{\{\s*([\w.]+|\$[\w.]+(?:\([^)]*\))?)\s*\}\}/g;
const fill = (s: string, vars: Record<string, unknown>) =>
  s.replace(PLACEHOLDER, (m, path: string) => {
    const v = lookup(path, vars);
    return v === undefined ? m : typeof v === 'string' ? v : JSON.stringify(v);
  });

/** Placeholders in every string of a JSON value; a string that is only a placeholder keeps the value's type. */
const fillDeep = (v: unknown, vars: Record<string, unknown>): unknown => {
  if (typeof v === 'string') {
    const whole = /^\{\{\s*([\w.]+|\$[\w.]+(?:\([^)]*\))?)\s*\}\}$/.exec(v);
    if (whole) {
      const got = lookup(whole[1]!, vars);
      if (got !== undefined) return got;
    }
    return fill(v, vars);
  }
  if (Array.isArray(v)) return v.map((x) => fillDeep(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillDeep(x, vars)]));
  return v;
};

/** `(args) => …`, `args => …` or `function (args) {…}`: a function expression; anything else is a body with `return`. */
const FUNCTION_SOURCE = /^(async\s*)?(\([^)]*\)|[\w$]+)\s*=>|^(async\s+)?function\b/;

/** The value a response script computes for these arguments; a script error throws. */
export async function runMockScript(script: string, args: Record<string, unknown>): Promise<unknown> {
  const src = script.trim();
  const fn = FUNCTION_SOURCE.test(src) ? `(${src})` : `((args) => {\n${src}\n})`;
  const code = `const args = __in.data.args;\n__out.result = await ${fn}(args);`;
  const out = (await runScript(code, { variables: {}, data: { args } })) as { error?: string; result?: unknown };
  if (out.error) throw new ApsError('ScriptError', out.error.split('\n')[0] ?? out.error);
  return out.result;
}

/** A script's value as an MCP result: text for a string, JSON (with structuredContent) for the rest, `{ content }` as is. */
function resultOfValue(v: unknown, isError?: boolean): McpMockResult {
  const flag = isError ? { isError: true } : {};
  if (typeof v === 'string') return { content: [{ type: 'text', text: v }], ...flag };
  if (v && typeof v === 'object' && Array.isArray((v as { content?: unknown }).content)) {
    const r = v as { content: unknown[]; structuredContent?: unknown; isError?: boolean };
    return { content: r.content, ...(r.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}), ...(r.isError || isError ? { isError: true } : {}) };
  }
  const json = v === undefined ? null : v;
  return { content: [{ type: 'text', text: JSON.stringify(json) }], structuredContent: json, ...flag };
}

/** The MCP result for a tool call against the mock (a `script` response runs in the sandbox). */
export async function mockToolResult(d: McpMockDefinition, name: string, args: Record<string, unknown> = {}): Promise<McpMockResult> {
  const tool = d.tools?.find((t) => t.name === name);
  if (!tool) return { content: [{ type: 'text', text: `Unknown tool "${name}" (mock)` }], isError: true };
  const rs = tool.responses ?? [];
  const r = rs.find((x) => x.when && subset(args, x.when)) ?? rs.find((x) => !x.when);
  if (!r) return { content: [{ type: 'text', text: `Mock response for ${name}: ${JSON.stringify(args)}` }] };
  if (r.script) {
    try {
      return resultOfValue(await runMockScript(r.script, args), r.isError);
    } catch (e) {
      return { content: [{ type: 'text', text: `Script error in the mock response of ${name}: ${(e as Error).message}` }], isError: true };
    }
  }
  if (r.content) return { content: r.content, ...(r.isError ? { isError: true } : {}) };
  if (r.json !== undefined) {
    const json = fillDeep(r.json, { args });
    return { content: [{ type: 'text', text: JSON.stringify(json) }], structuredContent: json, ...(r.isError ? { isError: true } : {}) };
  }
  return { content: [{ type: 'text', text: fill(r.text ?? '', { args }) }], ...(r.isError ? { isError: true } : {}) };
}

/** One tool of a mock as a list shows it: its arguments (from the input schema) and how it answers. */
export interface McpMockToolSummary {
  name: string;
  title?: string;
  description?: string;
  /** `name` of each argument, with `*` after the required ones. */
  arguments: string[];
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  /** How many responses, and of which kinds (`text`, `json`, `content`, `script`); `when` counts the conditional ones. */
  responses: { count: number; kinds: string[]; when: number };
}

/** The tools of a mock definition, summarised for a list (the CLI's --list, the mock_tools MCP tool, the app). */
export function mockToolsList(d: McpMockDefinition): McpMockToolSummary[] {
  return (d.tools ?? []).map((t) => {
    const schema = { type: 'object', properties: {}, ...(t.inputSchema ?? {}) } as { properties: Record<string, unknown>; required?: string[] };
    const required = new Set(schema.required ?? []);
    const rs = t.responses ?? [];
    const kinds = [...new Set(rs.map((r) => (r.script ? 'script' : r.content ? 'content' : r.json !== undefined ? 'json' : 'text')))];
    return {
      name: t.name,
      ...(t.title ? { title: t.title } : {}),
      ...(t.description ? { description: t.description } : {}),
      arguments: Object.keys(schema.properties ?? {}).map((k) => (required.has(k) ? `${k}*` : k)),
      inputSchema: schema,
      ...(t.annotations ? { annotations: t.annotations } : {}),
      responses: { count: rs.length, kinds, when: rs.filter((r) => r.when).length },
    };
  });
}

/** The command lines that serve a mock file to an agent: stdio (what an agent's MCP configuration starts) and HTTP. */
export function mockServeCommands(file: string, port = 3333): { stdio: string; http: string; url: string; agentConfig: string } {
  const quoted = /[\s"]/.test(file) ? JSON.stringify(file) : file;
  return {
    stdio: `testpion mock-mcp ${quoted}`,
    http: `testpion mock-mcp ${quoted} --http -p ${port}`,
    url: `http://127.0.0.1:${port}/mcp`,
    agentConfig: JSON.stringify({ mcpServers: { [file.replace(/^.*[\\/]/, '').replace(/\.mcp-mock\.(ya?ml|json)$/, '') || 'mock']: { command: 'testpion', args: ['mock-mcp', file] } } }, null, 2),
  };
}

/** An MCP server (not yet connected) that answers from the definition. */
export function createMcpMockServer(d: McpMockDefinition): Server {
  const caps: Record<string, object> = { tools: {} };
  if (d.resources?.length) caps.resources = {};
  if (d.prompts?.length) caps.prompts = {};
  const server = new Server({ name: d.name, version: d.version ?? '1.0.0-mock' }, { capabilities: caps, instructions: d.instructions });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (d.tools ?? []).map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: { type: 'object', properties: {}, ...(t.inputSchema ?? {}) }, annotations: t.annotations })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => (await mockToolResult(d, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>)) as never);
  if (d.resources?.length) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: d.resources!.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType })) }));
    server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
      const r = d.resources!.find((x) => x.uri === req.params.uri);
      if (!r) throw new McpError(ErrorCode.InvalidParams, `Unknown resource ${req.params.uri}`);
      return { contents: [{ uri: r.uri, mimeType: r.mimeType ?? 'text/plain', text: r.text ?? '' }] };
    });
  }
  if (d.prompts?.length) {
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: d.prompts!.map(({ name, description, arguments: a }) => ({ name, description, arguments: a })) }));
    server.setRequestHandler(GetPromptRequestSchema, async (req) => {
      const p = d.prompts!.find((x) => x.name === req.params.name);
      if (!p) throw new McpError(ErrorCode.InvalidParams, `Unknown prompt ${req.params.name}`);
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      return { description: p.description, messages: (p.messages ?? []).map((m) => ({ role: m.role, content: { type: 'text', text: fill(m.text, args) } })) };
    });
  }
  return server;
}

/** Serve the mock over stdio (for AI agents that start MCP servers as commands). */
export async function serveMcpMockStdio(d: McpMockDefinition): Promise<void> {
  await createMcpMockServer(d).connect(new StdioServerTransport());
}

export interface McpMockHttpServer {
  url: string;
  close(): Promise<void>;
}

/** Serve the mock over Streamable HTTP on localhost (stateless: every request gets a fresh server). */
export async function startMcpMockHttp(d: McpMockDefinition, opts: { port?: number } = {}): Promise<McpMockHttpServer> {
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
    const server = createMcpMockServer(d);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
  const http = createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: (e as Error).message }, id: null }));
    });
  });
  await new Promise<void>((ok, fail) => {
    http.once('error', fail);
    http.listen(opts.port ?? 0, '127.0.0.1', () => ok());
  });
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`, close: () => new Promise((ok) => http.close(() => ok())) };
}

/**
 * A mock definition recorded from a real server: its tools, resources and prompts, plus the results
 * of calls made so far (each becomes a response matched on its arguments).
 */
export function mockFromDiscovery(
  name: string,
  discovery: McpDiscovery,
  calls: Array<{ tool: string; args: Record<string, unknown>; result: { content?: unknown[]; isError?: boolean } }> = [],
  resourceTexts: Record<string, string> = {},
): McpMockDefinition {
  return {
    name,
    version: discovery.serverInfo?.version,
    instructions: discovery.instructions,
    tools: discovery.tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
      responses: calls.filter((c) => c.tool === t.name).map((c) => ({ when: Object.keys(c.args).length ? c.args : undefined, content: c.result.content ?? [], ...(c.result.isError ? { isError: true } : {}) })),
    })),
    resources: discovery.resources.map((r) => ({ ...r, text: resourceTexts[r.uri] })),
    prompts: discovery.prompts.map((p) => ({ ...p, messages: [] })),
  };
}
