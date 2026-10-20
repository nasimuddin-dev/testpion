/**
 * The text-to-SQL metrics of the catalogue (planning/rag-testing.md §2.3 type 13): `datacompy-score`, which compares the data two
 * queries return (the generated SQL is run by the read-only executor, runner/sql-exec.ts), and `sql-equivalence`, a judge's
 * opinion on whether two queries mean the same. Tested in tests/unit/rag-sql-metrics.test.ts and tests/unit/sql-exec.test.ts.
 */
import { registerMetric, type MetricDef } from './metric-registry.js';
import { judgeEstimate } from './metric-defs.js';

const RAGAS = 'https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/sql/';

const DEFS: MetricDef[] = [
  {
    id: 'datacompy-score',
    name: 'DataCompy score',
    group: 'sql',
    kind: 'sql',
    direction: 'higher',
    what: 'Whether the generated SQL query returns the same data as the reference query (Ragas DataCompyScore). Both queries run on a read-only database; or give the two results as CSV and nothing is run.',
    how: 'The result sets are normalised (numbers and numeric text, dates, NULL, trimmed text) and compared. mode rows (default): precision = matching rows / response rows, recall = matching rows / reference rows, as multisets (`ordered: true` in order); mode columns does the same with columns. `metric` f1 (default), precision or recall. A generated query that does not run scores 0 with the reason; a reference query that does not run is a configuration error.',
    example: 'The response returns 6 rows, the reference 5, and 4 match: precision 0.667, recall 0.8, F1 0.727.',
    requires: ['answer', 'reference'],
    threshold: 1,
    check: 'datacompy-score',
    aliases: ['datacompy', 'sql-results'],
    ragas: { names: ['datacompy_score', 'DataCompyScore'], options: { inputs: 'results' }, differs: 'Ragas compares two CSV result strings and never runs a query; here `inputs: sql` (the default when a database is set) runs both queries on a read-only database.' },
    options: {
      inputs: { type: 'string', default: 'sql', values: ['sql', 'results'], description: 'sql: run the generated and the reference query. results: the answer and the reference are results as CSV or JSON.' },
      database: { type: 'string', description: 'A SQLite file inside the workspace ({ path }), or a postgres:// / mysql:// connection ({ url or connectionEnv, readOnly: true }).' },
      mode: { type: 'string', default: 'rows', values: ['rows', 'columns'], description: 'Compare rows or columns.' },
      metric: { type: 'string', default: 'f1', values: ['f1', 'precision', 'recall'], description: 'Which score to return.' },
      ordered: { type: 'boolean', default: false, description: 'Rows must come in the same order.' },
      epsilon: { type: 'number', default: 0, description: 'Numbers closer than this are equal.' },
      byPosition: { type: 'boolean', default: false, description: 'Pair the columns by position, not by name.' },
      maxRows: { type: 'number', default: 10000, description: 'Refuse a result with more rows than this.' },
      timeoutMs: { type: 'number', default: 10000, description: 'Stop a query that runs longer than this.' },
    },
    calls: '0',
    version: 'datacompy-score-v1',
    sources: [RAGAS],
    estimate: () => ({ llmCalls: 0, embedCalls: 0, inputTokens: 0, outputTokens: 0 }),
  },
  {
    id: 'sql-equivalence',
    name: 'SQL equivalence',
    group: 'sql',
    kind: 'judged',
    direction: 'higher',
    what: 'Whether the generated query and the reference query mean the same thing given the schema, even when they are written differently (Ragas SQLSemanticEquivalence). It runs no query.',
    how: 'One judge call reads both queries and the schema (the CREATE TABLE statements in `reference_contexts`, or a SQLite database’s own) and gives a verdict: 1 or 0.',
    example: 'JOIN … SUM … GROUP BY against INNER JOIN … SUM … GROUP BY: 1; SUM(quantity) against COUNT(quantity): 0.',
    requires: ['answer', 'reference', 'referenceContexts'],
    threshold: 1,
    check: 'sql-equivalence',
    aliases: ['sql-semantic-equivalence'],
    ragas: { names: ['sql_query_equivalence', 'sql_semantic_equivalence', 'SQLSemanticEquivalence', 'LLMSQLEquivalence'] },
    options: { database: { type: 'string', description: 'A SQLite file inside the workspace ({ path }) whose table definitions are the schema.' } },
    judge: 'service',
    prompts: ['sql-equivalence-v1'],
    calls: '1',
    version: 'sql-equivalence-v1',
    sources: [RAGAS],
    estimate: (s) => judgeEstimate(s, { prompt: 220, reads: ['answerTokens', 'referenceTokens', 'contextTokens'], items: () => 1 }),
  },
];

for (const d of DEFS) registerMetric(d);
