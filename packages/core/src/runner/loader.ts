import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AuthConfig, BodyConfig, HttpRequestSpec, KeyValue, McpTest, ModelRef, SuiteConfig, TestCase } from '../model/types.js';
import { ApsError } from '../errors.js';
import { slugify } from '../util/ids.js';
import { readDataset, type DatasetSource } from './datasets.js';
import { dbKindOf } from './db-datasets.js';

const TEST_EXT = new Set(['.yaml', '.yml', '.json']);

export function isSuiteFile(p: string): boolean {
  return /\.suite\.(ya?ml|json)$/i.test(p);
}

export async function parseFile(path: string): Promise<unknown> {
  const text = await readFile(path, 'utf8');
  try {
    return extname(path).toLowerCase() === '.json' ? JSON.parse(text) : parseYaml(text);
  } catch (e) {
    throw new ApsError('ConfigurationError', `Could not parse ${path}: ${(e as Error).message}`);
  }
}

/* ------------------------------------------------------------------ normalisation */

function kvList(v: unknown): KeyValue[] | undefined {
  if (!v) return undefined;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' ? { enabled: true, ...(x as KeyValue), value: String((x as KeyValue).value ?? '') } : { key: String(x), value: '' }));
  if (typeof v === 'object') return Object.entries(v as Record<string, unknown>).map(([key, value]) => ({ key, value: String(value ?? '') }));
  return undefined;
}

function bodyOf(v: unknown, contentType?: string): BodyConfig | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'object' && v && 'type' in (v as object) && typeof (v as { type: unknown }).type === 'string' && ['none', 'json', 'xml', 'text', 'html', 'form-urlencoded', 'multipart', 'binary'].includes((v as { type: string }).type))
    return v as BodyConfig;
  if (typeof v === 'string') return { type: /json/.test(contentType ?? '') ? 'json' : /xml/.test(contentType ?? '') ? 'xml' : 'text', content: v };
  return { type: 'json', content: JSON.stringify(v, null, 2) };
}

function authOf(v: unknown): AuthConfig | undefined {
  if (!v || typeof v !== 'object') return undefined;
  return v as AuthConfig;
}

function modelOf(v: unknown): ModelRef {
  if (typeof v === 'string') {
    const i = v.indexOf('/');
    return i > 0 ? { provider: v.slice(0, i), name: v.slice(i + 1) } : { provider: v };
  }
  const m = (v ?? {}) as Record<string, unknown>;
  return {
    provider: String(m.provider ?? 'mock'),
    name: (m.name ?? m.model) as string | undefined,
    temperature: m.temperature as number | undefined,
    topP: (m.topP ?? m.top_p) as number | undefined,
    maxTokens: (m.maxTokens ?? m.max_tokens) as number | undefined,
    seed: m.seed as number | undefined,
  };
}

/** Convert a loosely-written YAML/JSON test into a canonical TestCase. */
export function normalizeTest(raw: Record<string, unknown>, file?: string, index = 0): TestCase {
  if (!raw || typeof raw !== 'object') throw new ApsError('ConfigurationError', `Invalid test definition in ${file}`);
  const type = String(raw.type ?? (raw.request || raw.url ? 'http' : raw.query ? 'graphql' : raw.protos || raw.proto ? 'grpc' : raw.tool ? 'mcp' : raw.prompt ? 'llm' : ''));
  const name = String(raw.name ?? `${file ? basename(file) : 'test'} #${index + 1}`);
  const base = {
    id: String(raw.id ?? `${file ? slugify(basename(file).replace(/\.[^.]+$/, '')) + ':' : ''}${slugify(name)}`),
    name,
    description: raw.description as string | undefined,
    tags: raw.tags as string[] | undefined,
    skip: raw.skip as boolean | undefined,
    timeoutMs: (raw.timeoutMs ?? raw.timeout_ms ?? raw.timeout) as number | undefined,
    retries: raw.retries as number | undefined,
    dependsOn: (typeof raw.dependsOn === 'string' ? [raw.dependsOn] : raw.dependsOn) as string[] | undefined,
    preRequestScript: (raw.preRequestScript ?? raw.pre_request_script) as string | undefined,
    testScript: (raw.testScript ?? raw.test_script ?? raw.script) as string | undefined,
    extract: raw.extract as Record<string, string> | undefined,
    // the app calls them checks; both spellings are read
    assertions: (raw.assertions ?? raw.checks) as TestCase['assertions'],
    evaluators: raw.evaluators as TestCase['evaluators'],
    file,
  };
  const vars = (raw.vars ?? (type === 'graphql' ? undefined : type === 'llm' ? undefined : raw.variables)) as Record<string, unknown> | undefined;

  switch (type) {
    case 'http':
    case 'rest': {
      const r = (raw.request ?? raw) as Record<string, unknown>;
      const headers = kvList(r.headers);
      const ct = headers?.find((h) => h.key.toLowerCase() === 'content-type')?.value;
      const request: HttpRequestSpec = {
        method: String(r.method ?? 'GET').toUpperCase(),
        url: String(r.url ?? ''),
        params: kvList(r.params ?? r.query),
        headers,
        cookies: kvList(r.cookies),
        auth: authOf(r.auth),
        body: bodyOf(r.body ?? (r.json !== undefined ? { type: 'json', content: JSON.stringify(r.json, null, 2) } : undefined), ct),
        settings: r.settings as HttpRequestSpec['settings'],
      };
      return { ...base, type: 'http', request, variables: vars };
    }
    case 'graphql':
      return {
        ...base,
        type: 'graphql',
        endpoint: String(raw.endpoint ?? raw.url ?? ''),
        query: String(raw.query ?? ''),
        graphqlVariables: (raw.graphqlVariables ?? raw.variables) as Record<string, unknown> | undefined,
        operationName: raw.operationName as string | undefined,
        headers: kvList(raw.headers),
        auth: authOf(raw.auth),
        events: raw.events === undefined ? undefined : Number(raw.events),
        waitMs: (raw.waitMs ?? raw.wait) === undefined ? undefined : Number(raw.waitMs ?? raw.wait),
        variables: raw.vars as Record<string, unknown> | undefined,
      };
    case 'grpc': {
      const protos = raw.protos ?? raw.proto;
      return {
        ...base,
        type: 'grpc',
        target: String(raw.target ?? raw.address ?? raw.url ?? ''),
        method: String(raw.method ?? ''),
        message: raw.message ?? raw.request,
        metadata: kvList(raw.metadata),
        protos: (Array.isArray(protos) ? protos : protos ? [protos] : []).map(String),
        ...(raw.tls !== undefined ? { tls: !!raw.tls } : {}),
        variables: vars,
      };
    }
    case 'websocket':
    case 'ws':
    case 'socketio':
    case 'mqtt':
    case 'kafka': {
      const send = raw.send ?? raw.messages ?? raw.message ?? raw.publish ?? raw.produce;
      const subscribe = raw.subscribe;
      return {
        ...base,
        type: 'websocket',
        url: String(raw.url ?? ''),
        ...(raw.mode || type === 'socketio' || type === 'mqtt' || type === 'kafka' ? { mode: (raw.mode ?? type) as 'websocket' | 'socketio' | 'mqtt' | 'kafka' } : {}),
        send: (Array.isArray(send) ? send : send !== undefined ? [send] : []) as Array<string | Record<string, unknown>>,
        ...(raw.waitMs ?? raw.wait ? { waitMs: Number(raw.waitMs ?? raw.wait) } : {}),
        headers: kvList(raw.headers),
        ...(raw.protocols ? { protocols: (Array.isArray(raw.protocols) ? raw.protocols : String(raw.protocols).split(',')).map((p) => String(p).trim()).filter(Boolean) } : {}),
        ...(raw.auth ? { auth: raw.auth as Record<string, unknown> } : {}),
        ...(raw.path ? { path: String(raw.path) } : {}),
        ...(subscribe !== undefined ? { subscribe: (Array.isArray(subscribe) ? subscribe : [subscribe]) as Array<string | { topic: string; qos?: 0 | 1 | 2; fromBeginning?: boolean }> } : {}),
        ...(raw.groupId ? { groupId: String(raw.groupId) } : {}),
        ...(raw.mechanism ? { mechanism: String(raw.mechanism) as 'plain' | 'scram-sha-256' | 'scram-sha-512' } : {}),
        ...(raw.clientId ? { clientId: String(raw.clientId) } : {}),
        ...(raw.username ? { username: String(raw.username) } : {}),
        ...(raw.password ? { password: String(raw.password) } : {}),
        variables: vars,
      };
    }
    case 'mcp': {
      const server = raw.server as string | { name?: string; id?: string } | undefined;
      const tool = raw.tool as string | { name: string } | undefined;
      return {
        ...base,
        type: 'mcp',
        server: typeof server === 'object' && server && !('transport' in server) ? String(server.name ?? server.id) : (server as string),
        tool: typeof tool === 'object' && tool ? tool.name : tool,
        arguments: (raw.arguments ?? raw.args) as Record<string, unknown> | undefined,
        resource: raw.resource as string | undefined,
        prompt: raw.prompt as { name: string; arguments?: Record<string, string> } | undefined,
        ...(raw.elicitation ? { elicitation: raw.elicitation as McpTest['elicitation'] } : {}),
        ...(raw.sampling ? { sampling: (typeof raw.sampling === 'string' ? { text: raw.sampling } : raw.sampling) as McpTest['sampling'] } : {}),
        ...(raw.roots ? { roots: (Array.isArray(raw.roots) ? raw.roots : [raw.roots]).map(String) } : {}),
        variables: vars,
      } as TestCase;
    }
    case 'llm':
    case 'prompt':
      return {
        ...base,
        type: 'llm',
        model: modelOf(raw.model),
        system: raw.system as string | undefined,
        prompt: raw.prompt as string | { template: string; system?: string },
        input: (raw.input ?? raw.variables) as Record<string, unknown> | undefined,
        expected: raw.expected,
        responseFormat: (raw.responseFormat ?? raw.response_format) as TestCase extends { responseFormat?: infer R } ? R : never,
        limits: raw.limits as { latency_ms?: number },
        variables: raw.vars as Record<string, unknown> | undefined,
        ...(raw.stream ? { stream: true } : {}),
      } as TestCase;
    case 'rag':
      return {
        ...base,
        type: 'rag',
        question: String(raw.question ?? raw.query ?? ''),
        contexts: ((raw.contexts ?? raw.retrieved ?? raw.documents ?? []) as Array<Record<string, unknown> | string>).map((d, i) =>
          typeof d === 'string' ? { id: `doc-${i + 1}`, text: d } : { id: String(d.id ?? `doc-${i + 1}`), text: String(d.text ?? d.content ?? ''), score: d.score as number | undefined, source: d.source as string | undefined },
        ),
        expected: raw.expected as string | undefined,
        answer: raw.answer as string | undefined,
        model: raw.model ? modelOf(raw.model) : undefined,
        prompt: raw.prompt as string | undefined,
        variables: vars,
      };
    case 'agent':
      return {
        ...base,
        type: 'agent',
        model: modelOf(raw.model),
        system: raw.system as string | undefined,
        input: String(raw.input ?? raw.prompt ?? ''),
        tools: raw.tools as TestCase extends { tools?: infer T } ? T : never,
        mcpServers: (raw.mcpServers ?? raw.mcp_servers) as string[] | undefined,
        maxSteps: (raw.maxSteps ?? raw.max_steps) as number | undefined,
        variables: vars,
      } as TestCase;
    default:
      throw new ApsError('ConfigurationError', `Unknown or missing test type "${type}" in ${file ?? 'test'} (${name})`, {
        suggestions: ['Set `type:` to one of http, graphql, grpc, mcp, llm, rag, agent.'],
      });
  }
}

/* ------------------------------------------------------------------ discovery */

function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/' || glob[i + 1] === '\\') i++;
      } else re += '[^/\\\\]*';
    } else if (c === '?') re += '[^/\\\\]';
    else if (c === '/' || c === '\\') re += '[/\\\\]';
    else re += c.replace(/[.+^${}()|[\]]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (TEST_EXT.has(extname(e.name).toLowerCase())) yield p;
  }
}

/** Resolve a path/glob into test files (lazily). */
export async function* discoverFiles(pattern: string, cwd = process.cwd()): AsyncGenerator<string> {
  const abs = isAbsolute(pattern) ? pattern : resolve(cwd, pattern);
  if (!/[*?]/.test(pattern)) {
    const st = await stat(abs).catch(() => undefined);
    if (!st) throw new ApsError('ConfigurationError', `Test path not found: ${abs}`);
    if (st.isFile()) {
      yield abs;
      return;
    }
    for await (const f of walk(abs)) if (!isSuiteFile(f)) yield f;
    return;
  }
  // glob: walk the static prefix
  const parts = abs.split(/[/\\]/);
  const firstGlob = parts.findIndex((p) => /[*?]/.test(p));
  const root = parts.slice(0, firstGlob).join(sep) || sep;
  const re = globToRegex(abs.slice(root.length + 1));
  for await (const f of walk(root)) if (re.test(relative(root, f)) && !isSuiteFile(f)) yield f;
}

/** Load all tests defined in one file (single test, `tests:` list, or dataset-expanded template). */
export async function* loadTestsFromFile(path: string): AsyncGenerator<TestCase> {
  const data = (await parseFile(path)) as Record<string, unknown> | unknown[];
  if (!data) return;
  const rel = path;
  if (Array.isArray(data)) {
    let i = 0;
    for (const t of data) yield normalizeTest(t as Record<string, unknown>, rel, i++);
    return;
  }
  if (Array.isArray(data.tests) && !isSuiteFile(path)) {
    const defaults = (data.defaults ?? {}) as Record<string, unknown>;
    let i = 0;
    for (const t of data.tests as Array<Record<string, unknown>>) yield normalizeTest({ ...defaults, ...t }, rel, i++);
    return;
  }
  if (data.dataset) {
    yield* expandDataset(data, path);
    return;
  }
  if (data.type || data.request || data.url || data.query || data.prompt) yield normalizeTest(data, rel, 0);
}

/**
 * A test with a `dataset` becomes one test per record. Records are streamed, so datasets
 * with millions of rows never need to be held in memory.
 */
export async function* expandDataset(template: Record<string, unknown>, file: string): AsyncGenerator<TestCase> {
  const ds = template.dataset as DatasetSource & { expectedField?: string; inputField?: string; idField?: string };
  // a file is relative to the test file; a database URL (postgres://, mysql://) stays as it is
  const src: DatasetSource = { ...ds, path: ds.path ? (dbKindOf(ds.path) ? ds.path : resolve(dirname(file), ds.path)) : undefined };
  const expectedField = ds.expectedField ?? 'expected';
  const { dataset: _ignored, ...tpl } = template;
  let i = 0;
  for await (const rec of readDataset(src)) {
    const id = String(rec[ds.idField ?? 'id'] ?? i + 1);
    const t: Record<string, unknown> = { ...tpl, name: `${tpl.name ?? basename(file)} [${id}]`, id: `${slugify(String(tpl.name ?? basename(file)))}:${id}` };
    const vars = { ...rec };
    if (t.type === 'llm' || !t.type) {
      t.input = { ...((tpl.input as object) ?? {}), ...vars };
      if (rec[expectedField] !== undefined) t.expected = rec[expectedField];
    } else if (t.type === 'rag') {
      t.question = rec.question ?? rec.query ?? rec.input ?? tpl.question;
      if (rec.contexts) t.contexts = rec.contexts;
      if (rec.answer) t.answer = rec.answer;
      if (rec[expectedField] !== undefined) t.expected = rec[expectedField];
      t.vars = vars;
    } else if (t.type === 'agent') {
      t.input = rec[ds.inputField ?? 'input'] ?? tpl.input;
      t.vars = vars;
    } else t.vars = { ...((tpl.vars as object) ?? {}), ...vars };
    // allow evaluators to reference record fields: expected: "{{expected}}"
    t.vars = { ...((t.vars as object) ?? {}), ...vars };
    yield normalizeTest(t, file, i);
    i++;
  }
}

export async function loadSuite(path: string): Promise<SuiteConfig> {
  const d = (await parseFile(path)) as Record<string, unknown>;
  if (!d || !Array.isArray(d.tests)) throw new ApsError('ConfigurationError', `Suite ${path} must contain a \`tests\` list of paths`);
  return {
    name: String(d.name ?? basename(path).replace(/\.suite\.(ya?ml|json)$/i, '')),
    description: d.description as string | undefined,
    tests: d.tests as string[],
    setup: d.setup as string[] | undefined,
    teardown: d.teardown as string[] | undefined,
    concurrency: d.concurrency as number | undefined,
    retries: d.retries as number | undefined,
    timeoutMs: (d.timeoutMs ?? d.timeout_ms) as number | undefined,
    environment: d.environment as string | undefined,
    tags: d.tags as string[] | undefined,
    file: path,
  };
}

/** Stream every test for a list of path/glob patterns. */
export async function* streamTests(patterns: string[], cwd: string, filter?: { tags?: string[]; grep?: string; ids?: string[] }): AsyncGenerator<TestCase> {
  const seen = new Set<string>();
  const grep = filter?.grep ? new RegExp(filter.grep, 'i') : undefined;
  const ids = filter?.ids ? new Set(filter.ids) : undefined;
  for (const p of patterns) {
    for await (const f of discoverFiles(p, cwd)) {
      if (seen.has(f)) continue;
      seen.add(f);
      for await (const t of loadTestsFromFile(f)) {
        if (filter?.tags?.length && !filter.tags.some((tag) => t.tags?.includes(tag))) continue;
        if (grep && !grep.test(t.name) && !grep.test(t.id ?? '')) continue;
        if (ids && !ids.has(t.id ?? '')) continue;
        yield t;
      }
    }
  }
}
