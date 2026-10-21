/**
 * `testpion rag trend <evaluation>`: the mean of every metric run by run, the runs where the judge or a metric’s wording changed
 * (not comparable), and the metrics that moved. Reads stored runs; calls no model. Exit 1 with --fail-on-drop when a metric dropped.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command, Option } from 'commander';
import { ApsError, ragTrend, trendCsv, trendTable } from '@testpion/core';
import { EXIT, CliError, bold, dim, green, printJson, red, withWorkspace, yellow } from '../shared.js';

export function registerRagTrendCommands(rag: Command): void {
  rag
    .command('trend')
    .description('the mean of each metric across the runs of an evaluation (and of its monitor), run by run; a change of judge or wording is marked, not read as a regression')
    .argument('<evaluation>', 'a saved evaluation (id or name)')
    .option('--metric <names>', 'only these metrics, comma separated')
    .option('--runs <n>', 'the most recent runs', '30')
    .option('--since <date>', 'only runs since this date (2026-10-01)')
    .option('--min-delta <n>', 'the smallest move that counts when the interval does not decide it', '0.05')
    .addOption(new Option('--format <format>', 'table, csv or json').choices(['table', 'csv', 'json']).default('table'))
    .option('-o, --out <file>', 'write it here instead of printing')
    .option('--fail-on-drop', 'exit 1 when the newest run got worse on a metric')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory')
    .option('--json', 'print as JSON')
    .action(async (evaluation: string, o: { metric?: string; runs: string; since?: string; minDelta: string; format: 'table' | 'csv' | 'json'; out?: string; failOnDrop?: boolean; workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        if (ephemeral) throw new CliError('No workspace found: run inside a workspace or pass -w <nameOrPath>', EXIT.CONFIG_ERROR);
        let t;
        try {
          t = await ragTrend(store, { evaluation, metrics: o.metric?.split(',').map((s) => s.trim()).filter(Boolean), runs: Number(o.runs), since: o.since, minDelta: Number(o.minDelta) });
        } catch (e) {
          throw e instanceof ApsError ? new CliError(e.message, EXIT.CONFIG_ERROR) : e;
        }
        if (!t.points.length) throw new CliError(`No scored runs of "${t.evaluation ?? evaluation}" yet: \`testpion rag run\` makes one.`, EXIT.CONFIG_ERROR);
        if (o.json) {
          printJson(t);
          if (o.failOnDrop && t.findings.some((f) => f.worse)) process.exitCode = EXIT.TEST_FAILURE;
          return;
        }
        const text = o.format === 'json' ? `${JSON.stringify(t, null, 2)}\n` : o.format === 'csv' ? trendCsv(t.points) : undefined;
        if (o.out) {
          writeFileSync(resolve(o.out), text ?? `${trendTable(t.points)}\n`);
          console.log(`${green('Wrote')} ${t.points.length} runs → ${o.out}`);
        } else if (text !== undefined) process.stdout.write(text);
        else {
          console.log(`${bold(t.evaluation ?? evaluation)} ${dim(`· ${t.points.length} runs`)}\n${trendTable(t.points)}`);
          for (const f of t.findings) console.log(`${f.worse ? red(f.change === 'dropped' ? '▼' : '▲') : green(f.change === 'dropped' ? '▼' : '▲')} ${f.text}`);
          if (!t.findings.length) console.log(dim('No metric moved more than its interval.'));
          const changed = t.points.filter((p) => p.judgeChanged).length;
          if (changed) console.log(yellow(`${changed} run${changed === 1 ? '' : 's'} measured with a different judge or wording than the run before.`));
        }
        if (o.failOnDrop && t.findings.some((f) => f.worse)) process.exitCode = EXIT.TEST_FAILURE;
      }),
    );
}
