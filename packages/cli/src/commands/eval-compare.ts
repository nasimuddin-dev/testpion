/**
 * `testpion eval compare <run> --baseline <run>`: an evaluation run against a baseline run case by case, exiting 1
 * when more cases regressed than allowed (for CI); `testpion eval matrix <runs…>`: runs side by side, a page of the
 * cases × variants matrix. Both read the same engine as the app's matrix view and the eval_compare / eval_matrix MCP
 * tools.
 */
import type { Command } from 'commander';
import { compareEvalRuns, evalMatrixPage, type EvalCompareItem, type EvalMatrixQuery } from '@testpion/core';
import { EXIT, bold, CliError, dim, green, printJson, red, withWorkspace, yellow } from '../shared.js';
import { addOutputOptions, saveSurface, savedLine } from '../output-save.js';

const number = (v: string | undefined, what: string, o: { int?: boolean; min?: number; max?: number } = {}): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (v.trim() === '' || !Number.isFinite(n) || (o.int && !Number.isInteger(n)) || (o.min !== undefined && n < o.min) || (o.max !== undefined && n > o.max))
    throw new CliError(
      `${what} must be ${o.int ? 'a whole number' : 'a number'}${o.min !== undefined ? ` from ${o.min}` : ''}${o.max !== undefined ? ` to ${o.max}` : ''} (got "${v}")`,
      EXIT.CONFIG_ERROR,
    );
  return n;
};

const fmt = (n: number | undefined) => (n === undefined ? '–' : n.toFixed(3).replace(/\.?0+$/, '') || '0');
const signed = (n: number | undefined) => (n === undefined ? '' : `${n > 0 ? '+' : ''}${fmt(n)}`);

function line(i: EvalCompareItem): string {
  const status = i.baselineStatus !== i.status ? `${i.baselineStatus ?? '–'} → ${i.status ?? '–'}` : (i.status ?? '');
  const score = i.score !== undefined || i.baselineScore !== undefined ? `score ${fmt(i.baselineScore)} → ${fmt(i.score)}${i.delta !== undefined ? ` (${signed(i.delta)})` : ''}` : '';
  return `${i.name}${dim(`  [${i.key}]`)}  ${[status, score].filter(Boolean).join(' · ')}${dim(`  ${i.column}`)}`;
}

export function registerEvalCompareCommands(ev: Command): void {
  ev.command('compare')
    .description(
      'compare an evaluation run with a baseline run case by case: regressions (stopped passing, or the score dropped by more than --threshold), improvements, missing and new cases; exits 1 when more cases regressed than --max-regressions (for CI)',
    )
    .argument('<run>', 'the run to check: its id, "last" (the newest finished evaluation run), or a name (the newest run of that name, e.g. a saved evaluation)')
    .requiredOption('-b, --baseline <run>', 'the run to compare with (id or name)')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('-t, --threshold <score>', 'a score change counts beyond this, 0 to 1 (a drop of exactly the threshold is not a regression)', '0.05')
    .option('--max-regressions <n>', 'regressions allowed before the exit code is 1', '0')
    .option('--fail-on-missing', 'exit 1 too when a baseline case is missing from the run')
    .option('--limit <n>', 'at most this many cases per list (default 200)')
    .option('--json', 'print the report as JSON: counts, per-variant pass rate and score delta, regressions, improvements, missing, added, passed')
    .action((run: string, o: { baseline: string; workspace?: string; threshold?: string; maxRegressions?: string; failOnMissing?: boolean; limit?: string; json?: boolean }) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        if (ephemeral) throw new CliError('No workspace found: run inside a workspace or pass -w <nameOrPath>', EXIT.CONFIG_ERROR);
        const r = await compareEvalRuns(store, {
          run,
          baseline: o.baseline,
          threshold: number(o.threshold, '--threshold', { min: 0, max: 1 }),
          maxRegressions: number(o.maxRegressions, '--max-regressions', { int: true, min: 0 }),
          failOnMissing: o.failOnMissing,
          limit: number(o.limit, '--limit', { int: true, min: 1 }),
        });
        if (o.json) printJson(r);
        else {
          console.log(bold(`${r.run.name} (${r.run.id}) against ${r.baseline.name} (${r.baseline.id})`));
          console.log(
            dim(
              `${r.cases} cases · threshold ${r.threshold} · ${r.counts.regressed} regressed, ${r.counts.improved} improved, ${r.counts.unchanged} unchanged, ${r.counts.missing} missing, ${r.counts.added} new`,
            ),
          );
          for (const c of r.columns)
            console.log(
              dim(
                `  ${c.label}: pass rate ${(c.passRate * 100).toFixed(1)}%${c.meanScore !== undefined ? ` · mean score ${fmt(c.meanScore)}` : ''}${c.meanDelta !== undefined ? ` (${signed(c.meanDelta)})` : ''}`,
              ),
            );
          const section = (title: string, items: EvalCompareItem[], paint: (s: string) => string) => {
            if (!items.length) return;
            console.log(`\n${paint(title)}`);
            for (const i of items) console.log(`  ${line(i)}`);
          };
          section('Regressed', r.regressions, red);
          section('Improved', r.improvements, green);
          section('Missing from the run', r.missing, yellow);
          if (r.added.length) console.log(dim(`\n${r.added.length} new case${r.added.length === 1 ? '' : 's'} (not in the baseline)`));
          if (r.truncated) console.log(dim('Lists cut at --limit; --json has the same limit.'));
          console.log(
            r.passed
              ? green(`\nNo regressions beyond the threshold${r.maxRegressions ? ` (at most ${r.maxRegressions} allowed)` : ''}.`)
              : red(
                  `\n${r.counts.regressed} regression${r.counts.regressed === 1 ? '' : 's'}${r.maxRegressions ? ` (at most ${r.maxRegressions} allowed)` : ''}${o.failOnMissing && r.counts.missing ? `, ${r.counts.missing} missing` : ''}.`,
                ),
          );
        }
        if (!r.passed) process.exitCode = EXIT.TEST_FAILURE;
      }),
    );
  addOutputOptions(
    ev
      .command('matrix')
      .description('evaluation runs side by side: cases × variants (a column per run, or per model of a run) with status and score, against a baseline run when given; prints a page, or --out saves every row as CSV, JSON, Markdown or HTML')
      .argument('<runs...>', 'runs in column order: ids, "last" or names')
      .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
      .option('-b, --baseline <run>', 'compare every column with this run')
      .option('-t, --threshold <score>', 'a score change counts beyond this, 0 to 1', '0.05')
      .option('--filter <which>', 'all, failed, regressed, improved, changed, missing', 'all')
      .option('--tag <tag>', 'only cases with this tag')
      .option('--sort <by>', 'case, score, delta, failures', 'case')
      .option('--offset <n>', 'first row', '0')
      .option('--limit <n>', 'rows (at most 1000)', '50')
      .option('--json', 'print the page as JSON (columns with stats, rows with cells, counts per filter, tags)'),
    'eval.matrix',
  ).action((runs: string[], o: { workspace?: string; baseline?: string; threshold?: string; filter: string; tag?: string; sort: string; offset: string; limit: string; json?: boolean; out?: string; format?: string }) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        if (ephemeral) throw new CliError('No workspace found: run inside a workspace or pass -w <nameOrPath>', EXIT.CONFIG_ERROR);
        if (o.out) {
          const saved = await saveSurface({ store, surface: 'eval.matrix', format: o.format, out: o.out, params: { runs, baseline: o.baseline } });
          return o.json ? printJson(saved) : console.log(savedLine(saved));
        }
        const filters = ['all', 'failed', 'regressed', 'improved', 'changed', 'missing'];
        const sorts = ['case', 'score', 'delta', 'failures'];
        if (!filters.includes(o.filter)) throw new CliError(`--filter is one of ${filters.join(', ')}`, EXIT.CONFIG_ERROR);
        if (!sorts.includes(o.sort)) throw new CliError(`--sort is one of ${sorts.join(', ')}`, EXIT.CONFIG_ERROR);
        const page = await evalMatrixPage(store, {
          runs,
          baseline: o.baseline,
          threshold: number(o.threshold, '--threshold', { min: 0, max: 1 }),
          filter: o.filter as EvalMatrixQuery['filter'],
          tag: o.tag,
          sort: o.sort as EvalMatrixQuery['sort'],
          offset: number(o.offset, '--offset', { int: true, min: 0 }),
          limit: number(o.limit, '--limit', { int: true, min: 1, max: 1000 }),
        });
        if (o.json) return printJson(page);
        console.log(
          bold(`${page.total} of ${page.cases} cases`) +
            dim(
              ` · ${page.columns.map((c, k) => `[${k + 1}] ${c.label} (${c.stats.passed}/${c.stats.cases} passed${c.stats.meanScore !== undefined ? `, score ${fmt(c.stats.meanScore)}` : ''})`).join(' · ')}`,
            ),
        );
        const mark = (s?: string) => (s === 'passed' ? green('✓') : s === 'failed' || s === 'error' ? red('✗') : s === 'skipped' ? dim('–') : dim('·'));
        for (const r of page.rows)
          console.log(
            `${r.key.padEnd(12)} ${r.cells
              .map(
                (c) =>
                  `${mark(c.status)} ${fmt(c.score).padStart(5)}${c.change === 'regressed' ? red(` ${signed(c.delta) || '↓'}`) : c.change === 'improved' ? green(` ${signed(c.delta) || '↑'}`) : ''}`,
              )
              .join('  ')}  ${dim(r.name)}`,
          );
        if (page.total > page.offset + page.rows.length) console.log(dim(`… ${page.total - page.offset - page.rows.length} more (--offset ${page.offset + page.rows.length})`));
      }),
    );
}
