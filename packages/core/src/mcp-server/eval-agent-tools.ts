/**
 * MCP tools for evaluations as a matrix (eval_matrix: cases × variants a page at a time, eval_compare: a run against a
 * baseline run, what CI gates on) and for the files coding agents read (agents_init: AGENTS.md and friends). The same
 * engine functions as `testpion eval matrix|compare` and `testpion agents init`.
 */
import { initAgentFiles, parseAgentTargets } from '../agents/agent-files.js';
import { compareEvalRuns, evalMatrixPage, evalMatrixResult } from '../runner/eval-matrix-runs.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { ApsError } from '../errors.js';
import { str, type Tool } from './tool.js';

const num = (description: string) => ({ type: 'number', description });
const strings = (a: unknown): string[] => (Array.isArray(a) ? a.map(String) : typeof a === 'string' && a ? a.split(',').map((x) => x.trim()) : []).filter(Boolean);

export function evalAgentTools({ store }: { store: WorkspaceStore }): Tool[] {
  return [
    {
      name: 'eval_matrix',
      description:
        "Evaluation runs side by side as a matrix: rows are the cases (dataset records), columns the variants (each run — a prompt × model — or one column per model of a run), cells the case's status and mean score. With `baseline` (a run) each cell is regressed / improved / unchanged / new / missing with the score delta. Returns one page of rows (default 100) with per-variant stats (pass count, mean score, regressions) and counts per filter; `filter` failed / regressed / improved / changed / missing, `tag`, `search`, `sort` (case, score, delta, failures) narrow it. Runs are ids, \"last\" or names (the newest run of that name). `result` with `run` returns one cell's full result (input, output, expected, checks with the judge's reasoning).",
      inputSchema: {
        type: 'object',
        properties: {
          runs: { type: 'array', items: { type: 'string' }, description: 'The runs to compare, in column order (ids, "last" or names); up to 20' },
          baseline: str('A run to compare every column with (optional)'),
          threshold: num('A score change counts beyond this (0–1, default 0.05)'),
          filter: { type: 'string', enum: ['all', 'failed', 'regressed', 'improved', 'changed', 'missing'], description: 'Which cases (default all)' },
          tag: str('Only cases with this tag (a dataset record\'s "tags")'),
          search: str('Only cases whose id or name contains this'),
          sort: { type: 'string', enum: ['case', 'score', 'delta', 'failures'], description: 'Order of the rows (default case)' },
          column: num('Sort by this column (0-based) instead of the worst of all'),
          dir: { type: 'string', enum: ['asc', 'desc'] },
          offset: num('First row (default 0)'),
          limit: num('Rows (default 100, at most 500)'),
          run: str('With result: the run of the cell'),
          result: str("A result id (a cell's `id`): returns that result whole instead of a page"),
        },
      },
      run: async (a) => {
        if (a.result !== undefined) {
          if (!a.run) throw new ApsError('ValidationError', 'Give `run` with `result`');
          const r = await evalMatrixResult(store, String(a.run), String(a.result));
          if (!r) throw new ApsError('ConfigurationError', `No result "${String(a.result)}" in run ${String(a.run)}`);
          return r;
        }
        const runs = strings(a.runs);
        return evalMatrixPage(store, {
          runs,
          baseline: a.baseline ? String(a.baseline) : undefined,
          threshold: a.threshold === undefined ? undefined : Number(a.threshold),
          filter: a.filter as never,
          tag: a.tag ? String(a.tag) : undefined,
          search: a.search ? String(a.search) : undefined,
          sort: a.sort as never,
          column: typeof a.column === 'number' ? a.column : undefined,
          dir: a.dir === 'desc' ? 'desc' : 'asc',
          offset: Number(a.offset) || 0,
          limit: Math.min(500, Number(a.limit) || 100),
        });
      },
    },
    {
      name: 'eval_compare',
      description:
        'Compare an evaluation run with a baseline run, case by case, like `testpion eval compare <run> --baseline <run>`: a case regressed when it stopped passing or its score dropped by more than `threshold` (default 0.05; a drop of exactly the threshold is not a regression), improved the other way; missing (only in the baseline) and new cases are listed apart. Returns the counts, per-variant pass rate and mean score delta, the regressions (worst first), improvements, missing and new cases, and `passed`: false when there are more regressions than `maxRegressions` (default 0) or, with failOnMissing, a case is missing. Runs are ids, "last" or names.',
      inputSchema: {
        type: 'object',
        properties: {
          run: str('The run to check (id, "last" or name)'),
          baseline: str('The run to compare with (id or name)'),
          threshold: num('Score change that counts (0–1, default 0.05)'),
          maxRegressions: num('Regressions allowed before passed is false (default 0)'),
          failOnMissing: { type: 'boolean', description: 'A case missing from the run makes passed false' },
          limit: num('At most this many items per list (default 100)'),
        },
        required: ['run', 'baseline'],
      },
      run: (a) =>
        compareEvalRuns(store, {
          run: String(a.run ?? ''),
          baseline: String(a.baseline ?? ''),
          threshold: a.threshold === undefined ? undefined : Number(a.threshold),
          maxRegressions: a.maxRegressions === undefined ? undefined : Number(a.maxRegressions),
          failOnMissing: a.failOnMissing === true,
          limit: Number(a.limit) || 100,
        }),
    },
    {
      name: 'agents_init',
      write: true,
      description:
        "Write (or refresh) AGENTS.md in the workspace root, like `testpion agents init`: the workspace's folders, collections, environments (names only, never values), tests and flows, the CLI commands and exit codes, the MCP server setup, how to add a request / test / flow, and the secrets and production rules. `targets` adds claude (a one-line CLAUDE.md pointing to AGENTS.md) and cursor (.cursor/rules/testpion.mdc). Only the part between <!-- testpion:begin --> and <!-- testpion:end --> is replaced; the user's own text stays. Returns each file's status: created, updated, unchanged or skipped (with the reason, e.g. broken markers; `force` repairs them). `dryRun` writes nothing.",
      inputSchema: {
        type: 'object',
        properties: {
          targets: { type: 'array', items: { type: 'string', enum: ['agents', 'claude', 'cursor'] }, description: 'Files to write (AGENTS.md always)' },
          force: { type: 'boolean', description: 'Repair broken markers instead of skipping the file' },
          dryRun: { type: 'boolean', description: 'Report what would be written, write nothing' },
        },
      },
      run: (a) => initAgentFiles(store, { targets: parseAgentTargets(strings(a.targets)), force: a.force === true, dryRun: a.dryRun === true }),
    },
  ];
}
