/**
 * The text-to-SQL metrics (planning/rag-testing.md §2.3 type 13, §4k): `datacompy-score` compares what the generated query
 * and the reference query return (both run by the read-only executor, or two CSV/JSON results given as they are, as
 * Ragas does), and `sql-equivalence` asks a judge whether two queries mean the same given the schema. The generated SQL is
 * untrusted text: only runner/sql-exec.ts runs it.
 */
import { isAbsolute, resolve } from 'node:path';
import type { CheckConfig, CheckResult } from '../../model/types.js';
import { registerCheck, type CheckContext } from '../checks.js';
import { isInside } from '../../storage/fsutil.js';
import { ApsError } from '../../errors.js';
import { productionAllowed, productionRefusal } from '../../net/production-guard.js';
import { databaseTarget, isDatabaseTrusted } from './db-trust.js';
import type { SqlSource } from '../../runner/sql-exec.js';
import { sqlHost } from './sql-host.js';
import { judgedCheck, referenceText, round3 } from './judged-kit.js';
import { SQL_EQUIVALENCE } from './prompts-r2.js';
import { num, result } from './metric-util.js';
import { compareResults, parseResultText, sqlOf, type ResultSet } from './sql.js';

/** The production guard for a database marked `production: true`: the same question, and the same consent, as for a request. */
export function assertSqlProduction(db: SqlSource, what: string): void {
  if (db.production === true && !productionAllowed()) throw productionRefusal({ environment: db.path ?? (db.connectionEnv ? `$${db.connectionEnv}` : 'the database'), action: what, changesData: false, run: true });
}

/**
 * The data source of a SQL metric, or an error that says why not. It fails CLOSED: a context without a workspace folder (a
 * caller that forgot to set it) gets no database, because the folder is what confines a SQLite file and what a network
 * database is allowed for. The database itself comes only from the saved definition (the evaluation's `database`, or the
 * metric's own); callers that take options from outside strip `database` first (stripCallerDatabase in try-metric.ts).
 */
function sourceOf(cfg: CheckConfig, ctx: CheckContext) {
  const db = (cfg.database ?? {}) as SqlSource;
  const root = ctx.workspaceRoot;
  if (!root) throw new ApsError('ConfigurationError', 'The SQL metrics run only inside a workspace, and this run has no workspace folder', { suggestions: ['Run it from the app, `testpion rag run` in the workspace folder, or an MCP server opened on one.'] });
  const src = sqlHost().resolveSqlSource(db, { base: root });
  if (src.dialect === 'sqlite') {
    // a SQLite file named in a pull request's evaluation must not be one elsewhere on the machine
    if (!isInside(root, src.path!, { orSame: false })) {
      const abs = isAbsolute(db.path ?? '') ? db.path! : resolve(root, db.path ?? '');
      throw new ApsError('ConfigurationError', `The database ${abs} is outside the workspace`, { suggestions: ['Keep the SQLite file inside the workspace (for example data/shop.db) so an evaluation file cannot point at other files.'] });
    }
  } else {
    // a connection a workspace file names (any environment variable, any host) and declares read-only is the file's word, not the person's
    const target = databaseTarget(db, src);
    if (!isDatabaseTrusted(root, target))
      throw new ApsError('ConfigurationError', `The database ${target} is named by this workspace and has not been allowed on this computer`, {
        why: 'A workspace comes from git, an import or a teammate: a file in it could name any connection (DATABASE_URL, a host of its choosing) and call it read-only. You decide which connections the SQL metrics may use, once per computer.',
        suggestions: [`Allow it on this computer with \`testpion rag trust-db "${target}"\`. The metric is n/a until then.`],
        details: { databaseNotAllowed: target },
      });
  }
  assertSqlProduction(db, 'Run the generated SQL');
  return src;
}

/** The sample is not scored (n/a, not a fail) while the connection is not allowed on this computer; the hint says how to allow it. */
function notAllowed(cfg: CheckConfig, e: unknown): CheckResult | undefined {
  const target = (e as ApsError).details?.databaseNotAllowed;
  if (typeof target !== 'string') return undefined;
  const hint = (e as ApsError).suggestions.join(' ');
  return result(cfg, true, `${cfg.type} is n/a: the database ${target} is not allowed on this computer. ${hint}`, { source: 'deterministic', explanation: `${(e as ApsError).why} ${hint}`, metadata: { na: 'database-not-allowed', database: target } });
}

const rowsOf = (r: ResultSet) => `${r.rows.length} row${r.rows.length === 1 ? '' : 's'}`;

const datacompy = async (cfg: CheckConfig, ctx: CheckContext): Promise<CheckResult> => {
  const reference = referenceText(cfg, ctx);
  if (!reference) return result(cfg, false, 'datacompy-score needs the reference: the expected query (with a database) or its result as CSV, in a "reference" column.', { source: 'deterministic', explanation: 'No reference.' });
  const mode = cfg.mode === 'columns' ? 'columns' : 'rows';
  const metric = ['precision', 'recall', 'f1'].includes(String(cfg.metric)) ? (cfg.metric as 'precision' | 'recall' | 'f1') : 'f1';
  const t = num(cfg.threshold, 1);
  const opts = { mode, metric, ordered: cfg.ordered === true, epsilon: num(cfg.epsilon, 0), columns: cfg.byPosition === true ? ('position' as const) : ('auto' as const) } as const;
  const inputs = cfg.inputs === 'results' || (cfg.inputs !== 'sql' && !cfg.database) ? 'results' : 'sql';
  let resp: ResultSet;
  let ref: ResultSet;
  const meta: Record<string, unknown> = { inputs, mode, metric, threshold: t };
  if (inputs === 'results') {
    resp = parseResultText(ctx.text);
    ref = parseResultText(reference);
  } else {
    let src;
    try {
      src = sourceOf(cfg, ctx);
    } catch (e) {
      return notAllowed(cfg, e) ?? result(cfg, false, (e as Error).message, { source: 'deterministic', explanation: (e as ApsError).why });
    }
    const limits = { maxRows: typeof cfg.maxRows === 'number' ? cfg.maxRows : undefined, timeoutMs: typeof cfg.timeoutMs === 'number' ? cfg.timeoutMs : undefined };
    const query = sqlOf(ctx.text);
    // the reference query is the author's: a failure there is a configuration problem, not a bad answer
    try {
      ref = await sqlHost().runReadOnlySql(src, sqlOf(reference), limits, ctx.services?.signal);
    } catch (e) {
      return result(cfg, false, `the reference query could not be run: ${(e as Error).message}`, { source: 'deterministic', explanation: 'The reference query failed.', metadata: { ...meta, executed: null } });
    }
    try {
      sqlHost().checkReadOnlySql(query, src.dialect);
      resp = await sqlHost().runReadOnlySql(src, query, limits, ctx.services?.signal);
    } catch (e) {
      // the generated query did not run: that is the answer being wrong, and it scores 0 with the reason
      return result(cfg, false, `datacompy 0: the generated query did not run: ${(e as Error).message.split('\n')[0]}`, { source: 'deterministic', score: 0, explanation: (e as ApsError).why ?? (e as Error).message, metadata: { ...meta, executed: false, error: (e as Error).message.slice(0, 500), subScores: { executed: 0, precision: 0, recall: 0, f1: 0 } } });
    }
  }
  const c = compareResults(resp, ref, opts);
  const score = round3(c.score);
  const items = [
    ...c.missing.slice(0, 5).map((m) => ({ text: m, ok: false, evidence: mode === 'columns' ? 'in the reference, different or missing in the response' : 'in the reference, missing from the response' })),
    ...c.extra.slice(0, 5).map((m) => ({ text: m, ok: false, evidence: mode === 'columns' ? 'in the response, not in the reference' : 'in the response, not in the reference' })),
  ];
  return result(cfg, score >= t, `datacompy ${metric} ${score}: ${c.matching} of ${c.responseCount} response and ${c.referenceCount} reference ${mode} match${c.note ? ` (${c.note})` : ''} (threshold ${t})`, {
    source: 'deterministic',
    score,
    metadata: { ...meta, executed: true, rows: { response: rowsOf(resp), reference: rowsOf(ref) }, paired: c.paired, subScores: { executed: 1, precision: round3(c.precision), recall: round3(c.recall), f1: round3(c.f1) }, items, itemLabels: ['matches', 'differs'] },
  });
};

/** The schema the judge reads: the gold chunk texts (DDL), else SQLite's own table definitions. */
async function schemaOf(cfg: CheckConfig, ctx: CheckContext): Promise<string | undefined> {
  if (ctx.referenceContexts?.length) return ctx.referenceContexts.join('\n\n').slice(0, 20_000);
  if (!cfg.database) return undefined;
  const src = sourceOf(cfg, ctx);
  if (src.dialect !== 'sqlite') return undefined;
  const r = await sqlHost().runReadOnlySql(src, "SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 200", { maxRows: 200, timeoutMs: 3000 }, ctx.services?.signal);
  return r.rows.map((row) => String(row[1] ?? '')).join(';\n').slice(0, 20_000);
}

const equivalenceJudge = judgedCheck({
  metric: SQL_EQUIVALENCE,
  id: 'sql-equivalence',
  threshold: 1,
  needs: ['answer', 'reference'],
  input: (cfg, ctx) => ({ response: sqlOf(ctx.text), reference: sqlOf(referenceText(cfg, ctx) ?? ''), schema: (cfg as { __schema?: string }).__schema ?? '' }),
});

const sqlEquivalence = async (cfg: CheckConfig, ctx: CheckContext): Promise<CheckResult> => {
  let schema: string | undefined;
  try {
    schema = await schemaOf(cfg, ctx);
  } catch (e) {
    return notAllowed(cfg, e) ?? result(cfg, false, `sql-equivalence could not read the schema: ${(e as Error).message}`, { source: 'ai-judge' });
  }
  if (!schema) return result(cfg, false, 'sql-equivalence needs the schema: add the CREATE TABLE statements as "reference_contexts" in the dataset, or name a SQLite database (database: { path }).', { source: 'ai-judge', explanation: 'No schema.' });
  return equivalenceJudge({ ...cfg, __schema: schema } as CheckConfig, ctx);
};

registerCheck('datacompy-score', datacompy);
registerCheck('sql-equivalence', sqlEquivalence);
