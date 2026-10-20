/**
 * The text-to-SQL metrics: result comparison with its known values (the catalogue's example: 6 response rows, 5 reference
 * rows, 4 matching → precision 0.667, recall 0.8, F1 0.727), value normalisation, and `datacompy-score` end to end on a SQLite
 * database (both queries run by the read-only executor, a failing generated query scores 0 with the reason) and on two CSV
 * results (Ragas' form, nothing is run).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { compareResults, normalizeCell, parseResultText, runChecks, sqlOf, type CheckContext } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers';

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const rs = (columns: string[], rows: unknown[][]) => ({ columns, rows });

describe('comparing results', () => {
  const ref = rs(['id', 'name'], [[1, 'a'], [2, 'b'], [3, 'c'], [4, 'd'], [5, 'e']]);
  const resp = rs(['id', 'name'], [[1, 'a'], [2, 'b'], [3, 'c'], [4, 'd'], [9, 'x'], [10, 'y']]);

  it('rows: 6 response rows, 5 reference rows, 4 match → P 0.667, R 0.8, F1 0.727; the missing and extra rows are listed', () => {
    const c = compareResults(resp, ref);
    expect([r3(c.precision), r3(c.recall), r3(c.f1), r3(c.score)]).toEqual([0.667, 0.8, 0.727, 0.727]);
    expect(c.missing).toEqual(['5 | e']);
    expect(c.extra).toEqual(['9 | x', '10 | y']);
    expect(r3(compareResults(resp, ref, { metric: 'precision' }).score)).toBe(0.667);
    expect(r3(compareResults(resp, ref, { metric: 'recall' }).score)).toBe(0.8);
  });

  it('rows are a multiset: order does not matter unless it is asked for; a duplicate counts once per copy', () => {
    const shuffled = rs(['id', 'name'], [[3, 'c'], [1, 'a'], [2, 'b'], [5, 'e'], [4, 'd']]);
    expect(compareResults(shuffled, ref).score).toBe(1);
    expect(compareResults(shuffled, ref, { ordered: true }).matching).toBe(0);
    const dup = rs(['x'], [[1], [1], [2]]);
    expect(r3(compareResults(dup, rs(['x'], [[1], [2], [2]])).f1)).toBe(0.667);
  });

  it('columns are paired by name (any order, any case) or, when the names differ, by position', () => {
    const swapped = rs(['NAME', 'Id'], [['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]]);
    const c = compareResults(swapped, ref);
    expect(c.score).toBe(1);
    expect(c.paired).toBe('name');
    const renamed = rs(['pk', 'label'], ref.rows);
    expect(compareResults(renamed, ref)).toMatchObject({ score: 1, paired: 'position' });
    const wide = rs(['a', 'b', 'c'], [[1, 'a', 0]]);
    const none = compareResults(wide, ref);
    expect(none).toMatchObject({ score: 0, paired: 'none' });
    expect(none.note).toMatch(/cannot be paired/);
  });

  it('values: numbers and numeric text are equal, within an epsilon; NULL spellings; ISO dates; booleans; trimmed text', () => {
    expect(normalizeCell(1)).toBe(normalizeCell('1'));
    expect(normalizeCell(1.5)).toBe(normalizeCell('1.50'));
    expect(normalizeCell(0.1 + 0.2)).toBe(normalizeCell(0.3));
    expect(normalizeCell(1.0004, 0.001)).toBe(normalizeCell(1.0, 0.001));
    expect(normalizeCell(1.0004, 0.0001)).not.toBe(normalizeCell(1.0, 0.0001));
    for (const nul of [null, undefined, '', 'NULL', 'null', 'None', 'NaN']) expect(normalizeCell(nul)).toBe('n:');
    expect(normalizeCell('2026-01-02T03:04:05Z')).toBe(normalizeCell('2026-01-02 03:04:05'));
    expect(normalizeCell('2026-01-02T03:04:05+02:00')).toBe(normalizeCell('2026-01-02T01:04:05Z'));
    expect(normalizeCell('2026-01-02')).not.toBe(normalizeCell('2026-01-03'));
    expect(normalizeCell('True')).toBe(normalizeCell(true));
    expect(normalizeCell('  Ada ')).toBe(normalizeCell('Ada'));
    expect(normalizeCell('Ada')).not.toBe(normalizeCell('ada'));
    expect(normalizeCell('007')).toBe(normalizeCell(7));
  });

  it('mode columns: P and R over columns whose values are equal', () => {
    const a = rs(['id', 'name', 'extra'], [[1, 'a', 0], [2, 'b', 0]]);
    const b = rs(['id', 'name', 'other'], [[1, 'a', 9], [2, 'b', 9]]);
    // the names differ in the last column, so they pair by position: 3 columns each, 2 match
    const c = compareResults(a, b, { mode: 'columns' });
    expect(r3(c.f1)).toBe(0.667);
    expect(c.missing).toEqual(['other']);
  });

  it('two empty results are the same result', () => {
    expect(compareResults(rs(['a'], []), rs(['a'], [])).score).toBe(1);
    expect(compareResults(rs(['a'], [[1]]), rs(['a'], [])).score).toBe(0);
  });
});

describe('reading a result and a query', () => {
  it('CSV with quoted cells, a JSON list of objects, a JSON list of lists', () => {
    expect(parseResultText('id,name\n1,"Smith, Jo"\n2,Ada\n')).toEqual({ columns: ['id', 'name'], rows: [['1', 'Smith, Jo'], ['2', 'Ada']] });
    expect(parseResultText('[{"id":1,"n":"a"},{"id":2}]')).toEqual({ columns: ['id', 'n'], rows: [[1, 'a'], [2, undefined]] });
    expect(parseResultText('[["id","n"],[1,"a"]]')).toEqual({ columns: ['id', 'n'], rows: [[1, 'a']] });
  });

  it('the SQL of an answer: the fenced block, else the text', () => {
    expect(sqlOf('Here you go:\n```sql\nSELECT 1;\n```\nDone.')).toBe('SELECT 1;');
    expect(sqlOf('SELECT 2')).toBe('SELECT 2');
    expect(sqlOf('```\nSELECT 3\n```')).toBe('SELECT 3');
  });
});

describe('datacompy-score', () => {
  const t = tempDir('tp-datacompy-');
  let db: string;
  beforeAll(() => {
    db = join(t.dir, 'shop.db');
    const gbm = (process as unknown as { getBuiltinModule: (id: string) => { DatabaseSync: new (p: string) => { exec(s: string): void; close(): void } } }).getBuiltinModule;
    const emit = process.emitWarning;
    process.emitWarning = (() => undefined) as typeof process.emitWarning;
    const { DatabaseSync } = gbm('node:sqlite');
    process.emitWarning = emit;
    const d = new DatabaseSync(db);
    d.exec(`CREATE TABLE orders (id INTEGER PRIMARY KEY, customer TEXT, total REAL, status TEXT);
      INSERT INTO orders VALUES (1, 'ada', 20, 'paid'), (2, 'ada', 5.5, 'paid'), (3, 'linus', 7, 'open'), (4, 'grace', 12, 'paid');`);
    d.close();
  });
  afterAll(() => t.cleanup());

  const ctx = (answer: string, over: Partial<CheckContext> = {}): CheckContext => ({ testType: 'rag', body: answer, text: answer, expected: 'SELECT customer, SUM(total) AS spent FROM orders WHERE status = \'paid\' GROUP BY customer', workspaceRoot: t.dir, ...over });
  const one = async (cfg: Record<string, unknown>, c: CheckContext) => (await runChecks([{ type: 'datacompy-score', database: { path: 'shop.db' }, ...cfg } as never], c))[0]!;

  it('a differently written query that returns the same data scores 1', async () => {
    const r = await one({}, ctx("```sql\nselect o.customer, sum(o.total) spent from orders o where o.status = 'paid' group by o.customer order by spent desc;\n```"));
    expect(r).toMatchObject({ score: 1, passed: true });
    expect(r.metadata).toMatchObject({ executed: true, inputs: 'sql', subScores: { executed: 1, precision: 1, recall: 1, f1: 1 } });
  });

  it('a query with a wrong filter gets precision, recall and F1 from what it returned', async () => {
    // all orders: ada 25.5, linus 7, grace 12 against the paid ones: ada 25.5, grace 12 → 2 of 3 rows match
    const r = await one({}, ctx('SELECT customer, SUM(total) AS spent FROM orders GROUP BY customer'));
    expect(r.score).toBe(0.8);
    expect(r.metadata).toMatchObject({ subScores: { precision: 0.667, recall: 1, f1: 0.8 } });
    expect((r.metadata as { items: Array<{ text: string }> }).items.map((i) => i.text)).toEqual(['linus | 7']);
    expect((await one({ metric: 'precision' }, ctx('SELECT customer, SUM(total) AS spent FROM orders GROUP BY customer'))).score).toBe(0.667);
  });

  it('a generated query that does not run scores 0 with the reason; so does a write, which is never run', async () => {
    const bad = await one({}, ctx('SELECT nope FROM orders'));
    expect(bad).toMatchObject({ score: 0, passed: false });
    expect(bad.metadata).toMatchObject({ executed: false, subScores: { executed: 0 } });
    expect(bad.message).toMatch(/did not run/);
    const del = await one({}, ctx('DELETE FROM orders'));
    expect(del.score).toBe(0);
    expect(del.message).toMatch(/cannot be run/);
    // the data is untouched
    expect((await one({}, ctx("SELECT customer, SUM(total) AS spent FROM orders WHERE status = 'paid' GROUP BY customer"))).score).toBe(1);
  });

  it('a reference query that does not run is a configuration problem, not a bad answer', async () => {
    const r = await one({}, ctx('SELECT 1', { expected: 'SELECT * FROM nowhere' }));
    expect(r.passed).toBe(false);
    expect(r.score).toBeUndefined();
    expect(r.message).toMatch(/reference query could not be run/);
  });

  it('a database outside the workspace is refused, and so is an unset one', async () => {
    const outside = await one({ database: { path: '../elsewhere.db' } }, ctx('SELECT 1'));
    expect(outside.message).toMatch(/outside the workspace/);
    const abs = await one({ database: { path: join(t.dir, '..', 'x.db') } }, ctx('SELECT 1'));
    expect(abs.message).toMatch(/outside the workspace/);
    const unset = await one({ database: {} }, ctx('SELECT 1'));
    expect(unset.message).toMatch(/needs a SQLite file/);
  });

  it('results as CSV (Ragas’ form) run nothing: the catalogue example and column order', async () => {
    const csv = (rows: string[]) => `id,name\n${rows.join('\n')}`;
    const reference = csv(['1,a', '2,b', '3,c', '4,d', '5,e']);
    const response = csv(['1,a', '2,b', '3,c', '4,d', '9,x', '10,y']);
    const r = await runChecks([{ type: 'datacompy-score', inputs: 'results', threshold: 0.7 } as never], { testType: 'rag', body: response, text: response, expected: reference });
    expect(r[0]).toMatchObject({ score: 0.727, passed: true });
    const ragas = await runChecks([{ type: 'ragas:datacompy_score' } as never], { testType: 'rag', body: response, text: response, expected: reference });
    expect(ragas[0]!.score).toBe(0.727);
    const cols = await runChecks([{ type: 'datacompy-score', inputs: 'results', mode: 'columns' } as never], { testType: 'rag', body: '', text: 'name,id\na,1\nb,2', expected: 'id,name\n1,a\n2,b' });
    expect(cols[0]!.score).toBe(1);
    const none = await runChecks([{ type: 'datacompy-score' } as never], { testType: 'rag', body: '', text: 'x' });
    expect(none[0]!.message).toMatch(/needs the reference/);
  });
});
