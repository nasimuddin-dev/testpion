/**
 * Which database a SQL metric may read (review 2, findings 1 and 10). The metric context must carry the workspace folder (no
 * folder, no database), the database comes only from a saved definition (a request's options never name one), and a
 * PostgreSQL / MySQL connection a workspace file names is n/a until the person has allowed that target on this computer.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetDatabase, runChecks, setDbDriver, stripCallerDatabase, trustDatabase, trustedDatabases, tryMetric, withEvaluationDatabase, type CheckContext } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers';

describe('which database a SQL metric may read', () => {
  const t = tempDir('tp-datacompy-scope-');
  let db: string;
  let outside: string;
  beforeAll(() => {
    const gbm = (process as unknown as { getBuiltinModule: (id: string) => { DatabaseSync: new (p: string) => { exec(s: string): void; close(): void } } }).getBuiltinModule;
    const emit = process.emitWarning;
    process.emitWarning = (() => undefined) as typeof process.emitWarning;
    const { DatabaseSync } = gbm('node:sqlite');
    process.emitWarning = emit;
    db = join(t.dir, 'shop.db');
    outside = join(tmpdir(), `tp-secret-${process.pid}.db`);
    for (const f of [db, outside]) {
      const d = new DatabaseSync(f);
      d.exec("CREATE TABLE urls (url TEXT); INSERT INTO urls VALUES ('https://private.example/history');");
      d.close();
    }
  });
  afterAll(() => {
    t.cleanup();
    rmSync(outside, { force: true });
  });
  const base = (answer: string, over: Partial<CheckContext> = {}): CheckContext => ({ testType: 'rag', body: answer, text: answer, expected: 'SELECT url FROM urls', ...over });
  const run = async (database: unknown, c: CheckContext) => (await runChecks([{ type: 'datacompy-score', inputs: 'sql', database } as never], c))[0]!;

  it('a context without a workspace folder gets no database at all: the check fails closed, whatever path is named', async () => {
    const r = await run({ path: outside }, base('SELECT url FROM urls'));
    expect(r.passed).toBe(false);
    expect(r.message).toMatch(/no workspace folder/);
    expect(JSON.stringify(r)).not.toContain('private.example');
    // a relative path used to resolve against the process folder
    expect((await run({ path: 'shop.db' }, base('SELECT url FROM urls'))).message).toMatch(/no workspace folder/);
  });

  it('with a workspace folder a file outside it is refused and a file inside it is read', async () => {
    expect((await run({ path: outside }, base('SELECT url FROM urls', { workspaceRoot: t.dir }))).message).toMatch(/outside the workspace/);
    expect((await run({ path: 'shop.db' }, base('SELECT url FROM urls', { workspaceRoot: t.dir }))).score).toBe(1);
  });

  it('tryMetric ignores a database in the caller’s options (an agent’s tool call, the window) and says so', async () => {
    const sample = { answer: 'SELECT url FROM urls', reference: 'SELECT url FROM urls' };
    const r = await tryMetric({ ragJudge: {} as never, workspaceRoot: t.dir }, { metric: { type: 'datacompy-score', inputs: 'sql', database: { path: outside } } as never, sample });
    expect(r.notes?.[0]).toMatch(/`database` in the options was ignored/);
    expect(r.result?.passed).toBe(false);
    expect(JSON.stringify(r)).not.toContain('private.example');
    // the database of a saved evaluation (read by the caller from the workspace) is used
    const ok = await tryMetric({ ragJudge: {} as never, workspaceRoot: t.dir }, { metric: { type: 'datacompy-score', inputs: 'sql' } as never, sample, database: { path: 'shop.db' } });
    expect(ok.result?.score).toBe(1);
    expect(ok.notes).toBeUndefined();
    // and with no workspace folder given to tryMetric, even that fails closed
    const none = await tryMetric({ ragJudge: {} as never }, { metric: { type: 'datacompy-score', inputs: 'sql' } as never, sample, database: { path: 'shop.db' } });
    expect(none.result?.message).toMatch(/no workspace folder/);
  });

  it('evaluators that come with a request (the window’s re-score) lose their database; a saved evaluation gives its own', () => {
    const stripped = stripCallerDatabase({ type: 'datacompy-score', database: { path: outside } } as never);
    expect(stripped.cfg).toEqual({ type: 'datacompy-score' });
    expect(stripped.notes).toHaveLength(1);
    expect(stripCallerDatabase({ type: 'faithfulness' } as never).notes).toEqual([]);
    expect(withEvaluationDatabase([stripped.cfg, { type: 'faithfulness' } as never], { path: 'shop.db' })).toEqual([{ type: 'datacompy-score', database: { path: 'shop.db' } }, { type: 'faithfulness' }]);
  });

  describe('a PostgreSQL / MySQL connection a workspace file names', () => {
    const q = vi.fn(async () => [{ n: 1 }]);
    let restore: () => void;
    beforeAll(() => {
      restore = setDbDriver('postgres', { query: q } as never);
    });
    afterAll(() => restore());
    const net = { connectionEnv: 'TP_TEST_SHOP_DB', readOnly: true };
    const ctx = () => base('SELECT 1 AS n', { workspaceRoot: t.dir, expected: 'SELECT 1 AS n' });
    const target = '$TP_TEST_SHOP_DB -> postgres://reader:***@127.0.0.1:5432/shop';

    it('is n/a with a hint until the person has allowed that target on this computer; nothing is sent to the database', async () => {
      process.env.TP_TEST_SHOP_DB = 'postgres://reader:pw@127.0.0.1:5432/shop';
      try {
        const r = await run(net, ctx());
        expect(r.metadata).toMatchObject({ na: 'database-not-allowed', database: target });
        expect(r.message).toMatch(/not allowed on this computer.*testpion rag trust-db/);
        expect(r.message).not.toContain('pw');
        expect(q).not.toHaveBeenCalled();
        // allowed for ANOTHER workspace, or another target, does not count
        trustDatabase(join(t.dir, 'other'), target);
        trustDatabase(t.dir, '$TP_TEST_SHOP_DB -> postgres://reader:***@127.0.0.1:5432/other');
        expect((await run(net, ctx())).metadata).toMatchObject({ na: 'database-not-allowed' });
        trustDatabase(t.dir, target);
        const ok = await run(net, ctx());
        expect(ok).toMatchObject({ passed: true, score: 1 });
        expect(q).toHaveBeenCalled();
        // the variable now points to another database: the decision does not carry over
        process.env.TP_TEST_SHOP_DB = 'postgres://reader:pw@10.0.0.9:5432/prod';
        expect((await run(net, ctx())).metadata).toMatchObject({ na: 'database-not-allowed' });
      } finally {
        delete process.env.TP_TEST_SHOP_DB;
        forgetDatabase(t.dir);
        forgetDatabase(join(t.dir, 'other'));
      }
    });

    it('readOnly: true in the workspace file is not enough, and the decision can be taken back', async () => {
      process.env.TP_TEST_SHOP_DB = 'postgres://reader:pw@127.0.0.1:5432/shop';
      try {
        trustDatabase(t.dir, target);
        expect(trustedDatabases(t.dir)).toHaveLength(1);
        expect(forgetDatabase(t.dir)).toBe(1);
        expect((await run(net, ctx())).metadata).toMatchObject({ na: 'database-not-allowed' });
      } finally {
        delete process.env.TP_TEST_SHOP_DB;
      }
    });
  });
});
