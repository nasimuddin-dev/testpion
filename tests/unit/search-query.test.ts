/**
 * AI-12 · The search query spec and engine: every operator over a fixture workspace (History, runs, results, traces),
 * the schema's rejection of invalid and hostile specs, bounds, and that a search never writes anything. The model is not
 * involved here: this is the deterministic half that answers whatever the model translated.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  conditionText,
  explainQuery,
  parseSearchQuery,
  queryChips,
  runSearchQuery,
  SEARCH_FIELDS,
  SEARCH_LIMIT_MAX,
  textQuery,
  WorkspaceStore,
  type SearchCondition,
  type SearchQuery,
} from '../../packages/core/src/index.js';
import { NOW, seedSearchWorkspace } from '../ai/search-fixtures.js';
import { tempDir } from '../helpers.js';

const t = tempDir('tp-search-');
let store: WorkspaceStore;

beforeAll(async () => {
  store = await seedSearchWorkspace(t.dir);
});
afterAll(() => {
  store.close();
  t.cleanup();
});

const q = (where: SearchCondition[], extra: Partial<SearchQuery> = {}) => {
  const r = parseSearchQuery({ where, ...extra });
  if (!r.query) throw new Error(r.problems.join('; '));
  return r.query;
};
const ids = async (where: SearchCondition[], extra: Partial<SearchQuery> = {}) => (await runSearchQuery(store, q(where, extra), { now: NOW })).rows.map((r) => r.id);
const c = (field: SearchCondition['field'], op: SearchCondition['op'], value: SearchCondition['value']): SearchCondition => ({ field, op, value });

describe('the engine, every operator', () => {
  it('text: contains and not_contains, case-insensitive, over every source', async () => {
    expect(await ids([c('text', 'contains', 'PAYMENTS')], { sources: ['history'] })).toEqual(['h1', 'h2']);
    expect(await ids([c('text', 'contains', 'payments'), c('text', 'not_contains', 'post')], { sources: ['history'] })).toEqual(['h1']);
    const all = await runSearchQuery(store, q([c('text', 'contains', 'checkout')]), { now: NOW });
    expect(all.rows.map((r) => r.source).sort()).toEqual(['results', 'results', 'traces']);
  });

  it('time: within, gte and lte (a bare date covers the whole day)', async () => {
    expect(await ids([c('time', 'within', '5h')], { sources: ['history'] })).toEqual(['h1', 'h4', 'h6']);
    expect(await ids([c('time', 'within', '2d')], { sources: ['history'] })).toEqual(['h1', 'h4', 'h6', 'h2']);
    expect(await ids([c('time', 'gte', '2026-10-18')], { sources: ['history'] })).toEqual(['h1', 'h4', 'h6', 'h2']);
    // 2026-10-09 is 10 days before: lte that date includes the whole day, and nothing newer
    expect(await ids([c('time', 'lte', '2026-10-09')], { sources: ['history'] })).toEqual(['h3']);
    expect(await ids([c('time', 'gte', '2026-10-09'), c('time', 'lte', '2026-10-14')], { sources: ['history'] })).toEqual(['h5', 'h3']);
  });

  it('name: contains, not_contains and eq', async () => {
    expect(await ids([c('name', 'contains', 'charge')], { sources: ['history'] })).toEqual(['h1', 'h2']);
    expect(await ids([c('name', 'eq', 'ping')], { sources: ['history'] })).toEqual(['h4']);
    expect(await ids([c('name', 'contains', 'login')], { sources: ['results'] })).toEqual(['run-b:login', 'run-a:login']);
    expect(await ids([c('name', 'not_contains', 'login')], { sources: ['results'] })).toEqual(['run-b:checkout', 'run-a:checkout']);
    expect(await ids([c('name', 'eq', 'nightly')], { sources: ['runs'] })).toEqual(['run-a']);
  });

  it('kind, method: eq, ne and in', async () => {
    expect(await ids([c('kind', 'eq', 'grpc')], { sources: ['history'] })).toEqual(['h4']);
    expect(await ids([c('kind', 'ne', 'http')], { sources: ['history'] })).toEqual(['h4', 'h5']);
    expect(await ids([c('kind', 'in', ['grpc', 'llm'])], { sources: ['history'] })).toEqual(['h4', 'h5']);
    expect(await ids([c('method', 'eq', 'post')], { sources: ['history'] })).toEqual(['h2', 'h5']);
    expect(await ids([c('method', 'in', ['GET', 'DELETE'])], { sources: ['history'] })).toEqual(['h1', 'h6', 'h3']);
    expect(await ids([c('kind', 'eq', 'llm')], { sources: ['traces'] })).toEqual(['tr1']);
  });

  it('url: contains and not_contains', async () => {
    expect(await ids([c('url', 'contains', '/pets')])).toEqual(['h6']);
    expect(await ids([c('url', 'not_contains', 'api.example.com')])).toEqual(['h4', 'h5']);
  });

  it('status: eq, ne, gt, gte, lt, lte and in (a non-numeric status never matches a number)', async () => {
    expect(await ids([c('status', 'eq', 404)])).toEqual(['h6']);
    expect(await ids([c('status', 'ne', 200)])).toEqual(['h1', 'h6', 'h2']);
    expect(await ids([c('status', 'gt', 404)])).toEqual(['h1']);
    expect(await ids([c('status', 'gte', 404), c('status', 'lte', 599)])).toEqual(['h1', 'h6']);
    expect(await ids([c('status', 'lt', 201)])).toEqual(['h5', 'h3']);
    expect(await ids([c('status', 'in', [201, 404])])).toEqual(['h6', 'h2']);
  });

  it('failed: true and false in every source', async () => {
    expect(await ids([c('failed', 'eq', true)], { sources: ['history'] })).toEqual(['h1', 'h4', 'h6']);
    expect(await ids([c('failed', 'eq', false)], { sources: ['history'] })).toEqual(['h2', 'h5', 'h3']);
    expect(await ids([c('failed', 'eq', true)], { sources: ['runs'] })).toEqual(['run-b', 'run-a']);
    expect(await ids([c('failed', 'eq', true)], { sources: ['results'] })).toEqual(['run-b:login', 'run-a:checkout']);
    expect(await ids([c('failed', 'eq', true)], { sources: ['traces'] })).toEqual(['tr1']);
  });

  it('duration and size: gt, gte, lt, lte', async () => {
    expect(await ids([c('duration', 'gt', 2500)], { sources: ['history'] })).toEqual(['h5']);
    expect(await ids([c('duration', 'gte', 2500)], { sources: ['history'] })).toEqual(['h1', 'h5']);
    expect(await ids([c('duration', 'lt', 80)], { sources: ['history'] })).toEqual(['h6']);
    expect(await ids([c('duration', 'lte', 80)], { sources: ['history'] })).toEqual(['h4', 'h6']);
    expect(await ids([c('duration', 'gt', 2000)], { sources: ['results'] })).toEqual(['run-b:login', 'run-a:checkout']);
    expect(await ids([c('size', 'gte', 4000)], { sources: ['history'] })).toEqual(['h5', 'h3']);
    expect(await ids([c('size', 'lt', 300)], { sources: ['history'] })).toEqual(['h2']);
  });

  it('environment and collection: eq, ne, contains', async () => {
    expect(await ids([c('environment', 'eq', 'Staging')], { sources: ['runs'] })).toEqual(['run-a']);
    expect(await ids([c('environment', 'ne', 'staging')], { sources: ['runs'] })).toEqual(['run-b']);
    expect(await ids([c('environment', 'contains', 'prod')], { sources: ['results'] })).toEqual(['run-b:login', 'run-b:checkout']);
    // by the collection's name or its id
    expect(await ids([c('collection', 'eq', 'shop')])).toEqual(['h1', 'h2']);
    expect(await ids([c('collection', 'contains', 'sho')])).toEqual(['h1', 'h2']);
  });

  it('results: file, error, assertion, flaky, attempts', async () => {
    expect(await ids([c('file', 'contains', 'checkout/')])).toEqual(['run-b:checkout', 'run-a:checkout']);
    expect(await ids([c('error', 'contains', 'econnreset')], { sources: ['results'] })).toEqual(['run-b:login']);
    // a failed check's message is error text too
    expect(await ids([c('error', 'contains', 'got 500')], { sources: ['results'] })).toEqual(['run-a:checkout']);
    expect(await ids([c('error', 'not_contains', 'econnreset'), c('failed', 'eq', true)], { sources: ['results'] })).toEqual(['run-a:checkout']);
    expect(await ids([c('assertion', 'contains', 'equals 201'), c('failed', 'eq', true)])).toEqual(['run-a:checkout']);
    expect(await ids([c('flaky', 'eq', true)])).toEqual(['run-b:checkout', 'run-a:checkout']);
    expect(await ids([c('attempts', 'gte', 2)])).toEqual(['run-b:checkout']);
    expect(await ids([c('attempts', 'eq', 1)], { sources: ['results'] })).toEqual(['run-b:login', 'run-a:login', 'run-a:checkout']);
  });

  it('runs: failures', async () => {
    expect(await ids([c('failures', 'gte', 1)])).toEqual(['run-b', 'run-a']);
    expect(await ids([c('failures', 'eq', 0)])).toEqual([]);
  });

  it('traces: span, error text (read from the trace files), spans', async () => {
    expect(await ids([c('span', 'contains', 'tool.call')])).toEqual(['tr1']);
    expect(await ids([c('error', 'contains', 'timeout')], { sources: ['traces'] })).toEqual(['tr1']);
    expect(await ids([c('error', 'not_contains', 'timeout')], { sources: ['traces'] })).toEqual(['tr2']);
    expect(await ids([c('spans', 'gte', 2)])).toEqual(['tr1']);
    expect(await ids([c('spans', 'lt', 2)])).toEqual(['tr2']);
    expect(await ids([c('spans', 'eq', 1), c('spans', 'gt', 0)])).toEqual(['tr2']);
  });

  it('sorts by duration (slowest first, entries without one last) and by time ascending, and cuts at the limit', async () => {
    expect(await ids([c('failed', 'eq', true)], { sources: ['history'], sort: { by: 'duration', dir: 'desc' } })).toEqual(['h1', 'h4', 'h6']);
    expect(await ids([c('failed', 'eq', true)], { sources: ['history'], sort: { by: 'time', dir: 'asc' } })).toEqual(['h6', 'h4', 'h1']);
    const cut = await runSearchQuery(store, q([c('failed', 'eq', true)], { sources: ['history'], limit: 2 }), { now: NOW });
    expect(cut.rows).toHaveLength(2);
    expect(cut.matched).toBe(3);
  });

  it('merges sources newest first and returns the ref that opens each hit', async () => {
    const r = await runSearchQuery(store, q([c('time', 'within', '2d'), c('failed', 'eq', true)]), { now: NOW });
    expect(r.rows.map((x) => `${x.source}:${x.id}`)).toEqual(['history:h1', 'history:h4', 'history:h6', 'traces:tr1', 'runs:run-b', 'results:run-b:login']);
    expect(r.rows.find((x) => x.id === 'run-b:login')!.ref).toEqual({ kind: 'run', runId: 'run-b', resultId: 'login' });
    expect(r.rows.find((x) => x.id === 'h1')!.ref).toEqual({ kind: 'history', historyId: 'h1' });
    expect(r.rows.find((x) => x.id === 'tr1')!.ref).toEqual({ kind: 'trace', traceId: 'tr1' });
  });

  it('is read-only: no file in the workspace changes', async () => {
    const digest = () => {
      const h = createHash('sha1');
      const walk = (d: string) => {
        for (const n of readdirSync(d).sort()) {
          const p = join(d, n);
          if (/database\.sqlite/.test(n)) continue; // the database is opened by every reader
          const s = statSync(p);
          if (s.isDirectory()) walk(p);
          else h.update(`${p}:${s.size}:${readFileSync(p).length}`);
        }
      };
      walk(store.root);
      return h.digest('hex');
    };
    const before = digest();
    await runSearchQuery(store, q([c('text', 'contains', 'a')]), { now: NOW });
    await runSearchQuery(store, q([c('flaky', 'eq', true)]), { now: NOW });
    await runSearchQuery(store, q([c('span', 'contains', 'llm')]), { now: NOW });
    expect(digest()).toBe(before);
  });

  it('reports a cap instead of hiding it', async () => {
    const r = await runSearchQuery(store, q([c('text', 'contains', 'zzz-nothing')]), { now: NOW });
    expect(r.rows).toEqual([]);
    expect(r.capped).toEqual([]);
    expect(r.perSource.history!.scanned).toBe(6);
  });
});

describe('the spec: validation', () => {
  const bad = (input: unknown) => parseSearchQuery(input);

  it('fills the defaults and narrows the sources to those that have every field', () => {
    const r = parseSearchQuery({ where: [c('method', 'eq', 'get')] });
    expect(r.query).toEqual({ sources: ['history'], where: [{ field: 'method', op: 'eq', value: 'GET' }], sort: { by: 'time', dir: 'desc' }, limit: 25 });
    expect(parseSearchQuery({}).query!.sources).toEqual(['history', 'runs', 'results', 'traces']);
    expect(parseSearchQuery({ where: [c('failed', 'eq', true), c('flaky', 'eq', true)] }).query!.sources).toEqual(['results']);
  });

  it('rejects a spec no source can answer, with why', () => {
    const r = bad({ sources: ['runs'], where: [c('method', 'eq', 'GET')] });
    expect(r.query).toBeUndefined();
    expect(r.problems.join()).toMatch(/no source has all the fields used \(method\).*history/);
  });

  it('rejects unknown fields, operators, sources and keys, each saying what is allowed', () => {
    expect(bad({ where: [{ field: 'password', op: 'eq', value: 'x' }] }).problems[0]).toMatch(/unknown field "password" \(allowed: text, time/);
    expect(bad({ where: [c('status', 'contains', '5')] }).problems[0]).toMatch(/"contains" is not an operator of status \(allowed: eq, ne, gt, gte, lt, lte, in\)/);
    expect(bad({ sources: ['users'] }).problems[0]).toMatch(/unknown source "users"/);
    expect(bad({ where: [], orderBy: 'x' }).problems[0]).toMatch(/unknown key "orderBy"/);
    expect(bad({ where: [{ field: 'text', op: 'contains', value: 'x', sql: 'drop' }] }).problems[0]).toMatch(/unknown key "sql"/);
    expect(bad({ sort: { by: 'size', dir: 'asc' } }).problems[0]).toMatch(/sort.by/);
    expect(bad('status:500').problems[0]).toMatch(/JSON object/);
    expect(bad([]).problems[0]).toMatch(/JSON object/);
    expect(bad(null).query).toBeUndefined();
  });

  it('rejects values of the wrong type or outside the bounds', () => {
    expect(bad({ where: [c('status', 'eq', '500')] }).problems[0]).toMatch(/is a number/);
    expect(bad({ where: [c('duration', 'gt', -1)] }).problems[0]).toMatch(/outside/);
    expect(bad({ where: [c('duration', 'gt', Infinity)] }).problems[0]).toMatch(/is a number/);
    expect(bad({ where: [c('failed', 'eq', 'yes')] }).problems[0]).toMatch(/true or false/);
    expect(bad({ where: [c('text', 'contains', '')] }).problems[0]).toMatch(/empty/);
    expect(bad({ where: [c('text', 'contains', 'x'.repeat(201))] }).problems[0]).toMatch(/longer than 200/);
    expect(bad({ where: [c('text', 'contains', 'a\u0000b')] }).problems[0]).toMatch(/control/);
    expect(bad({ where: [c('kind', 'in', [])] }).problems[0]).toMatch(/non-empty list/);
    expect(
      bad({
        where: [
          c(
            'kind',
            'in',
            Array.from({ length: 21 }, (_, i) => `k${i}`),
          ),
        ],
      }).problems[0],
    ).toMatch(/more than 20/);
    expect(bad({ where: [c('time', 'within', '1y')] }).problems[0]).toMatch(/not a duration/);
    expect(bad({ where: [c('time', 'within', '400d')] }).problems[0]).toMatch(/not a duration/);
    expect(bad({ where: [c('time', 'gte', 'last tuesday')] }).problems[0]).toMatch(/ISO date/);
    expect(bad({ where: [c('time', 'gte', '2026-13-45')] }).problems[0]).toMatch(/ISO date/);
  });

  it('bounds the limit and the number of conditions', () => {
    expect(bad({ limit: SEARCH_LIMIT_MAX + 1 }).problems[0]).toMatch(/limit is a whole number from 1 to 200/);
    expect(bad({ limit: 0 }).problems[0]).toMatch(/limit/);
    expect(bad({ limit: 2.5 }).problems[0]).toMatch(/limit/);
    expect(bad({ limit: '10' }).problems[0]).toMatch(/limit/);
    expect(bad({ where: Array.from({ length: 13 }, () => c('text', 'contains', 'a')) }).problems[0]).toMatch(/more than 12/);
    expect(parseSearchQuery({ limit: SEARCH_LIMIT_MAX }).query!.limit).toBe(SEARCH_LIMIT_MAX);
  });

  it('is not fooled by prototype keys or objects with a custom prototype', () => {
    expect(bad(JSON.parse('{"__proto__": {"polluted": true}, "where": []}')).problems[0]).toMatch(/unknown key "__proto__"/);
    expect(bad({ where: [{ field: 'constructor', op: 'eq', value: 'x' }] }).problems[0]).toMatch(/unknown field "constructor"/);
    expect(bad({ where: [{ field: '__proto__', op: 'eq', value: 'x' }] }).problems[0]).toMatch(/unknown field/);
    class Evil {
      where = [];
    }
    expect(bad(new Evil()).query).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('the engine validates again: a query that skipped the parser is refused', async () => {
    await expect(runSearchQuery(store, { sources: ['history'], where: [{ field: 'sql', op: 'eq', value: 'x' } as never], sort: { by: 'time', dir: 'desc' }, limit: 5 })).rejects.toThrow(
      /Invalid search query/,
    );
  });

  it('every field declares its operators among the known ones and a source that exists', () => {
    for (const f of SEARCH_FIELDS) {
      expect(f.ops.length, f.id).toBeGreaterThan(0);
      expect(f.sources.length, f.id).toBeGreaterThan(0);
      expect(f.description.length, f.id).toBeGreaterThan(10);
    }
  });
});

describe('explain and chips', () => {
  it('says the query in plain words and gives one chip per condition', () => {
    const query = q([c('failed', 'eq', true), c('url', 'contains', 'payment'), c('time', 'within', '7d'), c('duration', 'gt', 2000), c('status', 'gte', 500)], { sources: ['history'] });
    expect(explainQuery(query)).toBe(
      'Looking in History where failed is yes and url contains "payment" and time within the last 7 days and duration over 2 s and status at least 500; newest first, at most 25.',
    );
    expect(queryChips(query).map((x) => x.text)).toEqual(['failed is yes', 'url contains "payment"', 'time within the last 7 days', 'duration over 2 s', 'status at least 500']);
    expect(queryChips(query)[3]).toMatchObject({ index: 3, field: 'duration', op: 'gt', value: 2000 });
  });

  it('words times, units and lists', () => {
    expect(conditionText(c('time', 'gte', '2026-10-12'))).toBe('time since 2026-10-12');
    expect(conditionText(c('time', 'within', '1d'))).toBe('time within the last day');
    expect(conditionText(c('time', 'within', '90m'))).toBe('time within the last 90 minutes');
    expect(conditionText(c('size', 'gt', 2048))).toBe('size over 2 KB');
    expect(conditionText(c('kind', 'in', ['grpc', 'llm']))).toBe('kind is one of grpc, llm');
    expect(explainQuery(q([], { sort: { by: 'duration', dir: 'desc' }, limit: 5 }))).toMatch(/slowest first, at most 5/);
  });

  it('a text query splits the words (each must be present, in any order)', async () => {
    const tq = textQuery('Payments  charge');
    expect(tq.where).toEqual([c('text', 'contains', 'payments'), c('text', 'contains', 'charge')]);
    expect((await runSearchQuery(store, tq, { now: NOW })).rows.map((r) => r.id)).toEqual(['h1', 'h2']);
    expect(parseSearchQuery(textQuery('a\u0000b ' + 'w'.repeat(500))).problems).toEqual([]);
  });
});
