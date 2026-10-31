import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildAiContext,
  checkTypes,
  lintOpenApi,
  matchSecretKey,
  openApiOutline,
  Redactor,
  registerCheck,
  secretKeyFields,
  shortId,
  spanId,
  stringifyYaml,
  testHistory,
  testsFromSpec,
  traceId,
  unregisterCheck,
  type WorkspaceStore,
} from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

// Characterisation tests of the hot paths the core refactor sped up: each one pins what the code answered BEFORE the
// change (golden hashes, or a reference implementation written out here), so a faster algorithm has to answer the same.

const tmp = tempDir('tp-hot-paths-');
afterAll(() => tmp.cleanup());

/* ------------------------------------------------------------------ the AI context */

const contextInput = (n: number) => ({
  results: Array.from({ length: n }, (_, i) => ({
    id: 'r' + i,
    name: 'Result ' + i,
    status: i % 40 ? 'passed' : 'failed',
    message: 'detail text '.repeat(10),
    url: 'https://x.test/a?b=' + i + '&token=abcdef123456',
    headers: [
      ['content-type', 'application/json'],
      ['authorization', 'Bearer abcdefghijklmnop123'],
    ],
    body: { a: i, b: 'v' + i, email: 'user' + i + '@example.com' },
  })),
  collection: {
    name: 'C',
    requests: Array.from({ length: Math.ceil(n / 2) }, (_, i) => ({
      id: 'q' + i,
      name: 'Req ' + i,
      method: 'GET',
      url: 'https://x.test/items/' + i,
      headers: [
        { key: 'accept', value: 'application/json' },
        { key: 'x-api-key', value: 'topsecretvalue' },
      ],
    })),
  },
  question: 'why does it fail?',
  note: 'x'.repeat(5000),
  json: JSON.stringify({ list: Array.from({ length: 300 }, (_, i) => ({ k: i, v: 'val' + i })) }),
});

const CONTEXT_GOLDEN: Record<string, string> = {
  'small/full/default': 'f78a99302fef18bc',
  'small/full/1500': 'b82b347d91fc6e83',
  'small/full/400': '050cec05642a87a5',
  'small/metadata/default': '30c046d326b2712d',
  'small/metadata/1500': '71c13d7c5df41b3f',
  'small/metadata/400': '7ea6c690adc0b5ec',
  'small/names/default': '71f4e6e276a75254',
  'small/names/1500': '5de4169e75fc6720',
  'small/names/400': 'd0ca32184cc556b9',
  'medium/full/default': 'afda26173ee4d11d',
  'medium/full/1500': 'af1ee54a1b27296e',
  'medium/full/400': '6ef8916150b8c33f',
  'medium/metadata/default': '6b25d4aa49db1dda',
  'medium/metadata/1500': 'd535fa91d745c102',
  'medium/metadata/400': '547ee4365488a195',
  'medium/names/default': '790a84c125078664',
  'medium/names/1500': '51aa9093cc43b7ad',
  'medium/names/400': '16dec1769e770a90',
  'large/full/default': 'b71bb586755e71cc',
  'large/full/1500': '12584086d981a90d',
  'large/full/400': 'd3bf08a8ed913a36',
  'large/metadata/default': 'c331f24b27b634ad',
  'large/metadata/1500': '2adb73aa1833c363',
  'large/metadata/400': 'f1d77b0511024b4f',
  'large/names/default': '294ebc5cdf6b12cb',
  'large/names/1500': 'ce252ab5e9f12a19',
  'large/names/400': '3668c9c99d946270',
};

describe('the AI context builder answers as it always did', () => {
  const redactor = new Redactor();
  redactor.addSecret('topsecretvalue');
  const inputs = { small: contextInput(5), medium: contextInput(120), large: contextInput(1500) };
  for (const [name, input] of Object.entries(inputs))
    for (const privacy of ['full', 'metadata', 'names'] as const)
      for (const budgetTokens of [undefined, 1500, 400])
        it(`${name} / ${privacy} / ${budgetTokens ?? 'default'} tokens`, () => {
          const c = buildAiContext(input, { privacy, redactor, budgetTokens });
          expect(createHash('sha256').update(JSON.stringify(c)).digest('hex').slice(0, 16)).toBe(CONTEXT_GOLDEN[`${name}/${privacy}/${budgetTokens ?? 'default'}`]);
        });
});

/* ------------------------------------------------------------------ redaction */

describe('the redactor', () => {
  it('masks the longest secret first, whatever the order they were added in, and picks up secrets added later', () => {
    const r = new Redactor();
    r.addSecret('abcd1234');
    expect(r.redactString('x abcd1234 y')).toBe('x [REDACTED] y');
    r.addSecret('abcd1234-longer');
    expect(r.redactString('x abcd1234-longer y abcd1234')).toBe('x [REDACTED] y [REDACTED]');
    r.addSecret('a.c+d?[x]');
    expect(r.redactString('p a.c+d?[x] q a-c+d?[x]')).toBe('p [REDACTED] q a-c+d?[x]');
    r.addSecret('abc'); // too short: ignored
    r.addSecret('');
    r.addSecret(undefined);
    r.addSecret('abcd1234'); // a repeat changes nothing
    expect(r.redactString('abc stays')).toBe('abc stays');
    expect(r.redactString('')).toBe('');
  });
  it('registering a thousand secrets, then masking, finds every one', () => {
    const r = new Redactor();
    for (let i = 0; i < 1000; i++) r.addSecret(`secret-value-${i}-xyz`);
    expect(r.redactString('a secret-value-0-xyz b secret-value-999-xyz c secret-value-500-xyz d')).toBe('a [REDACTED] b [REDACTED] c [REDACTED] d');
    expect(r.redactString('secret-value-1000-xyz')).toBe('secret-value-1000-xyz');
  });
  it('masks the same keys as the reference rule (exact, suffix, allow-listed) for every spelling', () => {
    const norm = (s: string) => s.toLowerCase().replace(/[-_\s.]/g, '');
    const referenceFields = (fields: readonly string[]) => ({ raw: new Set(fields.map((f) => f.toLowerCase())), norm: new Set(fields.map(norm)) });
    const keys = [
      'password', 'Password', 'PASSWORD', 'pass_word', 'x-api-key', 'X-API-KEY', 'apiKey', 'api_key', 'accessToken', 'access_token', 'totalTokens', 'maxTokens', 'client_secret', 'clientSecret', 'authorization', 'Authorization', 'cookie',
      'Set-Cookie', 'Content-Type', 'content_type', 'CONTENT-TYPE', 'accept', 'user-agent', 'ssn', 'refreshToken', 'idToken', 'token', 'tokens', 'secretary', 'name', 'id', '', 'x', 'private.key', 'privateKey', 'sessionId', 'session_id', 'jwt', 'bearer', 'x-auth-token',
    ];
    for (const fields of [undefined, ['password', 'token', 'ssn'], ['Secret-Thing', 'pin']]) {
      const mine = secretKeyFields(fields);
      const ref = referenceFields(fields ?? ['password']);
      for (const k of keys) {
        const a = matchSecretKey(k, mine);
        const b = matchSecretKey(k, mine); // the second answer (from a cache, when there is one) is the first
        expect(b).toBe(a);
        if (fields) {
          // an allow-listed name is never a secret; otherwise exact beats suffix
          const kn = norm(k);
          const allow = ['contenttype', 'accept', 'useragent'].includes(kn);
          const exact = !allow && !!k && (ref.raw.has(k.toLowerCase()) || ref.norm.has(kn));
          if (exact) expect(a).toBe('exact');
          if (allow) expect(a).toBe('none');
        }
      }
    }
  });
  it('redact() masks the keys and values it masked before', () => {
    const r = new Redactor();
    r.addSecret('hunter2-secret');
    const input = {
      password: 'p',
      user: { name: 'n', token: 't', nested: [{ authorization: 'Bearer abc', note: 'has hunter2-secret inside' }] },
      headers: [
        ['Authorization', 'Bearer abc'],
        ['Accept', 'text/plain'],
      ],
      list: [{ key: 'x-api-key', value: 'k' }, { key: 'accept', value: 'a' }],
      totalTokens: 12,
      ssn: 123456789,
    };
    expect(r.redact(input)).toEqual({
      password: '[REDACTED]',
      user: { name: 'n', token: '[REDACTED]', nested: [{ authorization: '[REDACTED]', note: 'has [REDACTED] inside' }] },
      headers: [
        ['Authorization', '[REDACTED]'],
        ['Accept', 'text/plain'],
      ],
      list: [{ key: 'x-api-key', value: '[REDACTED]' }, { key: 'accept', value: 'a' }],
      totalTokens: 12,
      ssn: '[REDACTED]',
    });
  });
});

/* ------------------------------------------------------------------ the check registry */

describe('the check type list', () => {
  it('is sorted and follows registrations and removals', () => {
    const before = checkTypes();
    expect([...before].sort()).toEqual(before);
    expect(before).not.toContain('zz-hot-path-check');
    registerCheck('zz-hot-path-check', () => ({ type: 'zz-hot-path-check', name: 'x', passed: true, source: 'deterministic', message: 'ok' }));
    const during = checkTypes();
    expect(during).toContain('zz-hot-path-check');
    expect(during.length).toBe(before.length + 1);
    unregisterCheck('zz-hot-path-check');
    expect(checkTypes()).toEqual(before);
    // a caller that changes the list it got does not change the next answer
    checkTypes().length = 0;
    expect(checkTypes()).toEqual(before);
  });
});

/* ------------------------------------------------------------------ the history of one test */

describe('the history of a test across runs', () => {
  // runs whose results hold ids and names with quotes, slashes, accents and look-alikes, in files written the way the runner writes them
  const tricky = ['plain', 'with "quotes"', 'back\\slash', 'a/b/c', 'café ünï', 'tab\tname', 'emoji 😀', 'plain-2', 'x'.repeat(40), 'plain.dot', 'Plain'];
  const runs = Array.from({ length: 4 }, (_, r) => ({ id: `run-${r}`, name: `Run ${r}`, startedAt: new Date(Date.UTC(2026, 0, 10 - r)).toISOString(), environment: r % 2 ? 'prod' : 'dev' }));
  for (const run of runs) {
    mkdirSync(join(tmp.dir, run.id), { recursive: true });
    const lines: string[] = [];
    tricky.forEach((name, i) => {
      // the id and the name are the same text, so a look-alike in another line must not match
      lines.push(JSON.stringify({ id: name, name, type: 'http', status: (i + Number(run.id.slice(4))) % 3 ? 'passed' : 'failed', startedAt: run.startedAt, durationMs: 5, attempts: 1, checks: [{ type: 'status', name: 'status', passed: false, source: 'deterministic', message: 'm' }], latencyMs: 7 }));
      lines.push(JSON.stringify({ id: name + '-other', name: name + ' other', type: 'http', status: 'passed', startedAt: run.startedAt, durationMs: 5, attempts: 1, checks: [] }));
    });
    lines.splice(3, 0, 'not json', '', '{"torn":');
    writeFileSync(join(tmp.dir, run.id, 'results.jsonl'), lines.join('\n') + '\n');
  }
  const store = { runDir: (id: string) => join(tmp.dir, id), meta: { listRuns: () => ({ items: runs, total: runs.length }) } } as unknown as WorkspaceStore;

  for (const name of tricky) {
    it(`finds ${JSON.stringify(name)} by id and by name, once per run, in run order`, async () => {
      const byId = await testHistory(store, { id: name });
      const byName = await testHistory(store, { name });
      expect(byId.map((p) => p.runId)).toEqual(runs.map((r) => r.id));
      expect(byName.map((p) => p.runId)).toEqual(runs.map((r) => r.id));
      const idx = tricky.indexOf(name);
      expect(byId.map((p) => p.status)).toEqual(runs.map((r) => ((idx + Number(r.id.slice(4))) % 3 ? 'passed' : 'failed')));
      expect(byId[0]!.failures).toEqual(['status']);
      expect(byId[1]!.environment).toBe('prod');
    });
  }
  it('finds nothing for a test no run has, and for look-alikes', async () => {
    expect(await testHistory(store, { id: 'plain-' })).toEqual([]);
    expect(await testHistory(store, { id: 'plai' })).toEqual([]);
    expect(await testHistory(store, { name: 'Plain other2' })).toEqual([]);
    expect(await testHistory(store, {})).toEqual([]);
  });
});

/* ------------------------------------------------------------------ the OpenAPI tools on a big document */

const goldenSpec = (n: number) => {
  const paths: Record<string, unknown> = {};
  for (let i = 0; i < n; i++)
    paths[`/res${i % 40}/{id}/sub${i}${i % 7 === 0 ? '/' : ''}`] = {
      get: {
        ...(i % 3 ? { operationId: 'get' + (i % 250) } : {}),
        ...(i % 5 ? { summary: 'Get ' + i, tags: ['t' + (i % 6)] } : {}),
        parameters: [
          { name: i % 11 === 0 ? 'other' : 'id', in: 'path', required: i % 13 !== 0, schema: { type: 'string' } },
          { name: 'q', in: 'query', schema: { type: 'integer', minimum: 1, example: i % 17 === 0 ? 'x' : 3 } },
        ],
        responses:
          i % 19 === 0
            ? {}
            : {
                200: { description: 'ok', content: { 'application/json': { schema: i % 4 ? { type: 'object', properties: { id: { type: 'string' }, n: { type: 'integer' } }, required: ['id'] } : { $ref: i % 9 === 0 ? '#/components/schemas/Missing' : '#/components/schemas/Item' } } } },
                404: { description: 'nf' },
              },
      },
      post: {
        operationId: 'post' + i,
        tags: ['t' + (i % 6)],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string', maxLength: 20 }, qty: { type: 'integer', minimum: 0, maximum: 100 }, kind: { type: 'string', enum: ['a', 'b'] } }, required: ['name'] } } } },
        responses: { 201: { description: 'created' } },
      },
    };
  return { openapi: '3.0.3', info: { title: 'Golden API', version: '1' }, servers: [{ url: 'http://example.com' }], paths, components: { schemas: { Item: { type: 'object', properties: { id: { type: 'string' } } }, Unused: { type: 'string' } } } };
};
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

describe('the OpenAPI tools answer for a 300-operation document as they did', () => {
  const json = JSON.stringify(goldenSpec(300));
  const yaml = stringifyYaml(goldenSpec(300));
  it('lints it, in JSON and in YAML, with each problem at its place', () => {
    const j = lintOpenApi(json);
    const y = lintOpenApi(yaml);
    // (the two information rules of 0.55.6, parameter-description and error-responses, added 900 problems of severity info)
    expect(j.problems).toHaveLength(1886);
    expect(y.problems).toHaveLength(1886);
    expect(hash(j)).toBe('d60fde25b1d93a1b');
    expect(hash(y)).toBe('5d570c6ccb89a454');
    // a path that two keys spell the same way: the first key is where the problem is shown
    const dup = JSON.parse(json);
    dup.paths['/dup/{id}'] = dup.paths['/res1/{id}/sub1'];
    expect(hash(lintOpenApi(JSON.stringify(dup), { minSeverity: 'warning' }))).toBe('ee2b86bf4ee038a0');
  });
  it('makes the same test files and the same outline', () => {
    for (const text of [json, yaml]) {
      expect(hash(testsFromSpec(text, { specPath: 'specs/golden.yaml' }))).toBe('7b23984858722fe1');
      expect(hash(testsFromSpec(text, { negative: false, includeDelete: true }))).toBe('be4df74cd18ab9c2');
      expect(hash(openApiOutline(text))).toBe('31c5879a1620f370');
    }
  });
});

/* ------------------------------------------------------------------ ids */

describe('generated ids', () => {
  it('keep their shape and stay unique', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i++) {
      const s = shortId('run-');
      expect(s).toMatch(/^run-[0-9a-z]+[0-9a-f]{10}$/);
      seen.add(s);
      seen.add(spanId());
      seen.add(traceId());
    }
    expect(seen.size).toBe(60_000);
    expect(spanId()).toMatch(/^[0-9a-f]{16}$/);
    expect(traceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(shortId()).toMatch(/^[0-9a-z]+[0-9a-f]{10}$/);
  });
});
