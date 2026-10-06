import { describe, it, expect, vi, afterEach } from 'vitest';
import { newDb } from 'pg-mem';

// The real PostgreSQL driver runs against pg-mem, an in-memory PostgreSQL, through the `pg` module it imports.
const mem = newDb();
mem.public.none(`
  CREATE TABLE patients (id integer PRIMARY KEY, name text NOT NULL, species text, born date, active boolean);
  INSERT INTO patients VALUES (1, 'Byron', 'cat', '2020-01-02', true), (2, 'Biscuit', 'dog', '2021-01-01', true), (3, 'Clover', 'rabbit', '2022-01-01', false);
`);
vi.mock('pg', () => ({ default: mem.adapters.createPg() }));

const { readDataset, dbKindOf, redactDbUrl, setDbDriver, expandDataset } = await import('../../packages/core/src/index.js');

const all = async (src: Parameters<typeof readDataset>[0]) => {
  const out: Array<Record<string, unknown>> = [];
  for await (const r of readDataset(src)) out.push(r);
  return out;
};

describe('database datasets', () => {
  afterEach(() => {
    delete process.env.TP_TEST_DB;
  });

  it('knows connection URLs and hides their passwords', () => {
    expect(dbKindOf('postgres://u:p@h/db')).toBe('postgres');
    expect(dbKindOf('postgresql://h/db')).toBe('postgres');
    expect(dbKindOf('mysql://h/db')).toBe('mysql');
    expect(dbKindOf('mariadb://h/db')).toBe('mysql');
    expect(dbKindOf('data/users.csv')).toBeUndefined();
    expect(redactDbUrl('postgres://app:s3cret@db.example.com:5432/shop')).toBe('postgres://app:***@db.example.com:5432/shop');
  });

  it('reads PostgreSQL rows with $ placeholders, dates as ISO text', async () => {
    const rows = await all({ connection: 'postgres://app:pw@127.0.0.1:5432/clinic', query: 'SELECT id, name, born FROM patients WHERE active = $1 ORDER BY id', params: [true] });
    expect(rows).toEqual([
      { id: 1, name: 'Byron', born: '2020-01-02T00:00:00.000Z' },
      { id: 2, name: 'Biscuit', born: '2021-01-01T00:00:00.000Z' },
    ]);
  });

  it('takes the URL from an OS environment variable, or as the path; limit and offset apply', async () => {
    process.env.TP_TEST_DB = 'postgres://app:pw@127.0.0.1:5432/clinic';
    expect((await all({ connectionEnv: 'TP_TEST_DB', query: 'SELECT name FROM patients ORDER BY id', offset: 1, limit: 1 })).map((r) => r.name)).toEqual(['Biscuit']);
    expect((await all({ path: 'postgres://app:pw@127.0.0.1:5432/clinic', query: 'SELECT count(*) AS n FROM patients' }))[0]).toEqual({ n: 3 });
    await expect(all({ connectionEnv: 'TP_MISSING_DB', query: 'SELECT 1' })).rejects.toThrow(/TP_MISSING_DB is not set/);
  });

  it('refuses anything but one read-only statement', async () => {
    await expect(all({ connection: 'postgres://h/db', query: 'DELETE FROM patients' })).rejects.toThrow(/must be one SELECT/);
    await expect(all({ connection: 'postgres://h/db', query: 'SELECT 1; DROP TABLE patients' })).rejects.toThrow(/must be one SELECT/);
    await expect(all({ connection: 'postgres://h/db' })).rejects.toThrow(/needs a query/);
  });

  it('explains a failing query', async () => {
    await expect(all({ connection: 'postgres://h/db', query: 'SELECT nope FROM patients' })).rejects.toThrow(/PostgreSQL dataset query failed/);
  });

  it('runs MySQL queries through its driver: ? placeholders, binary as base64, big integers as numbers', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const restore = setDbDriver('mysql', {
      query: async (url, sql, params) => {
        calls.push([url, sql, params]);
        return [{ id: 7n, token: Buffer.from('hi'), at: new Date('2026-10-06T10:00:00Z') }];
      },
    });
    try {
      const rows = await all({ connection: 'mysql://app:pw@127.0.0.1:3306/shop', query: 'SELECT id, token, at FROM t WHERE id = ?', params: [7] });
      expect(rows).toEqual([{ id: 7, token: 'aGk=', at: '2026-10-06T10:00:00.000Z' }]);
      expect(calls).toEqual([['mysql://app:pw@127.0.0.1:3306/shop', 'SELECT id, token, at FROM t WHERE id = ?', [7]]]);
    } finally {
      restore();
    }
  });

  it('feeds a data-driven test file (one test per row), the URL not taken for a file path', async () => {
    process.env.TP_TEST_DB = 'postgres://app:pw@127.0.0.1:5432/clinic';
    const tests: Array<{ name: string }> = [];
    for await (const t of expandDataset(
      { name: 'patient', type: 'http', url: 'http://127.0.0.1/patients/{{id}}', dataset: { connectionEnv: 'TP_TEST_DB', query: 'SELECT id, name FROM patients ORDER BY id' } },
      'C:/ws/tests/patients.yaml',
    ))
      tests.push(t as never);
    expect(tests.map((t) => t.name)).toEqual(['patient [1]', 'patient [2]', 'patient [3]']);
  });
});
