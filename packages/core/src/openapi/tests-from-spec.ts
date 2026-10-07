import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { stringify } from 'yaml';
import type { WorkspaceStore } from '../storage/workspace.js';
import { slugify } from '../util/ids.js';
import { fuzzCases, type FuzzCase } from './fuzz.js';
import { openApiOutline } from './outline.js';

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
      const success = op.responses.map((r) => r.code).find((c) => /^2\d\d$/.test(c)) ?? op.responses.map((r) => r.code).find((c) => /^2/i.test(c));
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
