import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { stringify } from 'yaml';
import type { WorkspaceStore } from '../storage/workspace.js';
import { slugify } from '../util/ids.js';
import { fuzzCases, fuzzFindingsToTests, type FuzzCase, type FuzzReport } from './fuzz.js';
import { openApiOutline, successCode } from './outline.js';
import { parse as parseYaml } from 'yaml';
import { importAsyncApi } from '../import/asyncapi.js';

/**
 * A first test suite from an API definition (`testpion tests-from-spec`, the Preview tab's Generate tests,
 * `generate_tests` for agents): a test file per tag with, per operation, its valid example checked against the
 * documented success status and the OpenAPI contract, and one request that breaks a rule of its body that must get a
 * 4xx. Example values (ids, tokens) come from the document and need a look before the suite is trusted.
 */
export interface GeneratedTestFile {
  /** Workspace-relative: tests/<api>/<tag>.yaml, or tests/<api>.suite.yaml. */
  path: string;
  yaml: string;
  tests: number;
}

const NEGATIVE_ORDER = ['missing-required', 'wrong-type', 'enum', 'not-json', 'bad-path', 'missing-query'];

function testOf(c: FuzzCase, o: { id: string; name: string; status?: string; specPath?: string; negative?: boolean }): Record<string, unknown> {
  const r = c.request;
  let body: unknown;
  const content = r.body && 'content' in r.body ? r.body.content : undefined;
  if (content !== undefined) {
    try {
      body = JSON.parse(content);
    } catch {
      body = content;
    }
  }
  const headers = (r.headers ?? []).filter((h) => h.key.toLowerCase() !== 'content-type' || typeof body === 'string');
  const params = (r.params ?? []).filter((p) => p.enabled !== false);
  const t: Record<string, unknown> = {
    id: o.id,
    name: o.name,
    method: r.method,
    url: r.url,
    ...(params.length ? { params: Object.fromEntries(params.map((p) => [p.key, p.value])) } : {}),
    ...(headers.length ? { headers: Object.fromEntries(headers.map((h) => [h.key, h.value])) } : {}),
    ...(r.auth && r.auth.type !== 'inherit' && r.auth.type !== 'none' ? { auth: r.auth } : {}),
    ...(body !== undefined ? (typeof body === 'string' ? { body: { type: 'json', content: body } } : { body }) : {}),
  };
  t.assertions = o.negative
    ? [{ type: 'status', expected: '4xx' }]
    : [{ type: 'status', expected: o.status ? Number(o.status) || o.status : '2xx' }, ...(o.specPath ? [{ type: 'openapi', spec: o.specPath }] : []), { type: 'latency', max: 2000 }];
  return t;
}

/** The test files for a document: one per tag, and a suite that runs them. */
export function testsFromSpec(text: string, opts: { specPath?: string; negative?: boolean; includeDelete?: boolean } = {}): GeneratedTestFile[] {
  // an AsyncAPI document gets realtime tests: a round trip per channel, checked against the document
  let parsed: unknown;
  try {
    parsed = text.trim().startsWith('{') ? JSON.parse(text) : parseYaml(text);
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === 'object' && typeof (parsed as { asyncapi?: unknown }).asyncapi === 'string') return testsFromAsyncApi(text, opts.specPath);
  const outline = openApiOutline(text);
  const { cases } = fuzzCases(text, { baseUrl: '{{baseUrl}}', includeDelete: opts.includeDelete, maxPerOperation: 60 });
  const api = slugify(opts.specPath?.replace(/^specs\//, '').replace(/\.(openapi|swagger)?\.?(ya?ml|json)$/i, '') || outline.title) || 'api';
  const files: GeneratedTestFile[] = [];
  const used = new Set<string>();
  const idOf = (s: string) => {
    let id = slugify(s) || 'test';
    for (let i = 2; used.has(id); i++) id = `${slugify(s)}-${i}`;
    used.add(id);
    return id;
  };
  for (const tag of outline.tags) {
    const tests: Array<Record<string, unknown>> = [];
    for (const op of tag.operations) {
      const label = `${op.method} ${op.path}`;
      const mine = cases.filter((c) => c.operation === label);
      const valid = mine.find((c) => c.mutation === 'valid');
      if (!valid) continue; // DELETE without includeDelete
      const success = successCode(op.responses.map((r) => r.code));
      const title = op.summary ?? op.operationId ?? label;
      tests.push(testOf(valid, { id: idOf(op.operationId ?? label), name: title, status: success, specPath: opts.specPath }));
      if (opts.negative !== false) {
        const bad = NEGATIVE_ORDER.map((m) => mine.find((c) => c.mutation === m)).find(Boolean);
        if (bad) tests.push(testOf(bad, { id: idOf(`${op.operationId ?? label} rejects`), name: `${title} rejects ${bad.name}`, negative: true }));
      }
    }
    if (!tests.length) continue;
    const head = `# Generated from ${opts.specPath ?? outline.title} by TestPion. Review the example values (ids, tokens, bodies) before trusting the results.\n`;
    files.push({ path: `tests/${api}/${slugify(tag.name) || 'default'}.yaml`, yaml: head + stringify({ defaults: { type: 'http' }, tests }, { lineWidth: 0 }), tests: tests.length });
  }
  if (files.length)
    files.push({
      path: `tests/${api}.suite.yaml`,
      yaml: stringify(
        { name: outline.title, description: `Generated from ${opts.specPath ?? 'the API definition'}: each operation's example and one invalid request.`, tests: [api] },
        { lineWidth: 0 },
      ),
      tests: files.reduce((n, f) => n + f.tests, 0),
    });
  return files;
}

/** Write them into the workspace; files that exist are kept unless `overwrite`. */
export function writeTestsFromSpec(
  store: Pick<WorkspaceStore, 'safePath'>,
  spec: string,
  opts: { negative?: boolean; includeDelete?: boolean; overwrite?: boolean } = {},
): { written: GeneratedTestFile[]; skipped: string[] } {
  const files = testsFromSpec(readFileSync(store.safePath(spec), 'utf8'), { specPath: spec, negative: opts.negative, includeDelete: opts.includeDelete });
  const written: GeneratedTestFile[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    const file = store.safePath(f.path);
    if (existsSync(file) && !opts.overwrite) {
      skipped.push(f.path);
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, f.yaml);
    written.push(f);
  }
  return { written, skipped };
}

const parseMsg = (m: unknown) => {
  if (typeof m !== 'string' || !m.trim()) return m;
  try {
    return JSON.parse(m);
  } catch {
    return m;
  }
};

/**
 * Realtime tests from an AsyncAPI document: per channel, send its example message and read the channel, then check what
 * came back against the document (the asyncapi check). Brokers come from the "<API> servers" environment its import
 * makes ({{productionUrl}} …).
 */
function testsFromAsyncApi(text: string, specPath?: string): GeneratedTestFile[] {
  const imp = importAsyncApi(text);
  const items = imp.savedItems?.websocket ?? [];
  const api = slugify(specPath?.split('/').pop()?.replace(/\.(asyncapi\.)?(ya?ml|json)$/i, '') || imp.collection.name) || 'events';
  const tests: Array<Record<string, unknown>> = [];
  const used = new Set<string>();
  for (const it of items) {
    const d = it.data as { url: string; mode: string; topic?: string; event?: string; message?: string; key?: string; kafkaHeaders?: Array<{ key: string; value: string }>; qos?: number; reads?: unknown[]; subscriptions?: unknown[] };
    let id = slugify(it.name) || 'channel';
    for (let i = 2; used.has(id); i++) id = `${slugify(it.name)}-${i}`;
    used.add(id);
    const check = { type: 'asyncapi', ...(specPath ? { spec: specPath } : {}) };
    const message = parseMsg(d.message);
    const base = { id, name: `${it.name}: a message goes through and matches the document`, url: d.url, waitMs: 2000 };
    if (d.mode === 'kafka' && d.topic) {
      const headers = d.kafkaHeaders?.length ? Object.fromEntries(d.kafkaHeaders.map((h) => [h.key, h.value])) : undefined;
      tests.push({ ...base, type: 'kafka', subscribe: [d.topic], send: [{ topic: d.topic, ...(d.key ? { key: d.key } : {}), ...(headers ? { headers } : {}), value: message }], assertions: [{ type: 'length', path: '$.received', min: 1 }, check] });
    } else if (d.mode === 'mqtt' && d.topic) {
      tests.push({ ...base, type: 'mqtt', subscribe: [d.topic], send: [{ topic: d.topic, payload: message, qos: d.qos ?? 0 }], assertions: [{ type: 'length', path: '$.received', min: 1 }, check] });
    } else if (d.mode === 'socketio') {
      tests.push({ ...base, type: 'socketio', send: [{ event: d.event ?? 'message', args: [message] }], assertions: [{ type: 'status', expected: 200 }] });
    } else if (d.mode === 'websocket') {
      const channel = d.url.replace(/^\{\{[^}]+\}\}/, '') || '/';
      tests.push({ ...base, type: 'websocket', send: message === undefined ? [] : [message], assertions: [{ type: 'status', expected: 101 }, { ...check, channel }] });
    }
  }
  if (!tests.length) return [];
  const env = `${imp.collection.name} servers`;
  const head = `# Generated from ${specPath ?? imp.collection.name} by TestPion. Run with the "${env}" environment (its import makes it); review the example messages first.
`;
  return [
    { path: `tests/${api}/channels.yaml`, yaml: head + stringify({ tests }, { lineWidth: 0 }), tests: tests.length },
    { path: `tests/${api}.suite.yaml`, yaml: stringify({ name: imp.collection.name, description: `Generated from ${specPath ?? 'the AsyncAPI document'}: a message through each channel.`, tests: [api], environment: env }, { lineWidth: 0 }), tests: tests.length },
  ];
}

/** Write a fuzzing run's findings as regression tests: tests/<api>/fuzz-findings.yaml (-2, -3 … when it exists). */
export function writeFuzzFindingTests(store: Pick<WorkspaceStore, 'safePath'>, spec: string, report: FuzzReport, opts: { baseUrl?: string } = {}): { path: string; tests: number } | undefined {
  const { yaml, tests } = fuzzFindingsToTests(report, { baseUrl: opts.baseUrl, specPath: spec });
  if (!tests) return undefined;
  const api = slugify(spec.replace(/^specs\//, '').replace(/\.(openapi|swagger)?\.?(ya?ml|json)$/i, '')) || 'api';
  let rel = `tests/${api}/fuzz-findings.yaml`;
  for (let i = 2; existsSync(store.safePath(rel)); i++) rel = `tests/${api}/fuzz-findings-${i}.yaml`;
  const file = store.safePath(rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, yaml);
  return { path: rel, tests };
}
