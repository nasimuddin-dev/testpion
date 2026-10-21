/**
 * `testpion rag label` and `testpion rag calibrate`: a person's pass/fail labels of judged results (labels/<name>.json) and
 * how well each metric's judge agrees with them (Cohen's kappa, accuracy, TPR/TNR, a seeded bootstrap interval, the
 * disagreements, and the pass mark that would agree most). Deterministic statistics: no model is called. Exit 1 when a
 * kappa is below --min-kappa, 2 for a configuration error.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command, Option } from 'commander';
import { ApsError, applyThreshold, calibrateRun, calibrationMarkdown, defaultLabelsName, labelResult, listLabelSets, readLabels, unlabel, type CalibrationReport, type MetricCalibration } from '@testpion/core';
import { EXIT, CliError, bold, dim, green, printJson, red, withWorkspace, yellow } from '../shared.js';

const needWorkspace = (ephemeral: string | undefined) => {
  if (ephemeral) throw new CliError('No workspace found: run inside a workspace or pass -w <nameOrPath>', EXIT.CONFIG_ERROR);
};
const wrap = <T>(f: () => T): T => {
  try {
    return f();
  } catch (e) {
    throw e instanceof ApsError ? new CliError(e.message, EXIT.CONFIG_ERROR) : e;
  }
};
const num = (x: number | undefined) => (x === undefined ? '—' : String(x));
const list = (v: string | undefined) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);

function printMetric(m: MetricCalibration): void {
  const a = m.agreement;
  const tone = m.verdict === 'good' ? green : m.verdict === 'fair' ? yellow : red;
  console.log(`${bold(m.metric)}  ${tone(m.verdict)}  ${dim(`n=${a.n} · from ${m.source}${m.threshold !== undefined ? ` · pass mark ${m.threshold}` : ''}`)}`);
  console.log(`  kappa ${num(a.kappa)}${m.interval.kappa ? ` [${m.interval.kappa.join(', ')}]` : ''} · accuracy ${num(a.accuracy)}${m.interval.accuracy ? ` [${m.interval.accuracy.join(', ')}]` : ''} · TPR ${num(a.tpr)} · TNR ${num(a.tnr)} · precision ${num(a.precision)}`);
  const c = a.confusion;
  console.log(dim(`  judge pass/person pass ${c.tp} · judge pass/person fail ${c.fp} · judge fail/person pass ${c.fn} · judge fail/person fail ${c.tn}`));
  if (m.byJudge.length > 1) for (const j of m.byJudge) console.log(`  ${j.role === 'member' ? 'jury member' : j.role === 'jury' ? 'the jury together' : 'judge'} ${j.judge}: n=${j.agreement.n}, kappa ${num(j.agreement.kappa)}, accuracy ${num(j.agreement.accuracy)}, TPR ${num(j.agreement.tpr)}, TNR ${num(j.agreement.tnr)}`);
  console.log(`  ${m.advice}`);
  if (m.tuning) console.log(`  ${bold('Tuned pass mark')}: ${m.tuning.threshold} (kappa ${num(m.tuning.agreement.kappa)}${m.tuning.gain !== undefined ? `, ${m.tuning.gain >= 0 ? '+' : ''}${m.tuning.gain}` : ''})${m.tuning.warning ? `\n  ${yellow(m.tuning.warning)}` : ''}`);
  for (const d of m.disagreements.slice(0, 5)) console.log(`  ${red('≠')} ${d.record}: judge ${d.judge}, you ${d.human}${d.score !== undefined ? ` (score ${d.score})` : ''} ${dim(d.question ?? '')}`);
}

export function registerRagCalibrateCommands(rag: Command): void {
  const label = rag.command('label').description('label judged results pass or fail (labels/<name>.json), the human side of judge calibration');

  label
    .command('set', { isDefault: true })
    .description('record your verdict on one result and metric; it is attached to the dataset record, so it also counts for later runs of the same dataset')
    .argument('<run>', 'the run the result is from')
    .requiredOption('--result <id>', 'a result id of the run, or its dataset record id')
    .option('--metric <name>', 'the metric (a check name or id); `overall` is the whole answer', 'overall')
    .option('--pass', 'the answer is good on this metric')
    .option('--fail', 'the answer is bad on this metric')
    .option('--note <text>', 'why')
    .option('--labels <name>', 'the label set (default: the run’s evaluation)')
    .option('--by <name>', 'who labelled')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory')
    .option('--json', 'print as JSON')
    .action((run: string, o: { result: string; metric: string; pass?: boolean; fail?: boolean; note?: string; labels?: string; by?: string; workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        needWorkspace(ephemeral);
        if (!!o.pass === !!o.fail) throw new CliError('Say --pass or --fail', EXIT.CONFIG_ERROR);
        const r = await wrap(() => labelResult(store, { run, result: o.result, metric: o.metric, label: o.pass ? 'pass' : 'fail', labels: o.labels, by: o.by, note: o.note })).catch((e: unknown) => {
          throw e instanceof ApsError ? new CliError(e.message, EXIT.CONFIG_ERROR) : e;
        });
        if (o.json) return printJson(r);
        console.log(`${green('Labelled')} ${r.label.record} · ${r.label.metric} · ${r.label.label} ${dim(`→ labels/${r.labels}.json`)}`);
      }),
    );

  label
    .command('list')
    .description('the label sets of the workspace, or the labels of one')
    .argument('[name]', 'a label set')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory')
    .option('--json', 'print as JSON')
    .action((name: string | undefined, o: { workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, (store, ephemeral) => {
        needWorkspace(ephemeral);
        if (!name) {
          const sets = listLabelSets(store);
          if (o.json) return printJson({ count: sets.length, sets });
          if (!sets.length) return console.log(dim('No labels yet. `testpion rag label <run> --result <id> --metric <m> --pass|--fail` makes one.'));
          for (const s of sets) console.log(`${bold(s.name.padEnd(30))} ${s.labels} labels  ${dim(s.path)}`);
          return;
        }
        const f = wrap(() => readLabels(store, name));
        if (o.json) return printJson(f);
        for (const l of f.labels) console.log(`${l.record.padEnd(24)} ${l.metric.padEnd(24)} ${l.label === 'pass' ? green('pass') : red('fail')}  ${dim(`${l.by ?? ''} ${l.at.slice(0, 10)} ${l.note ?? ''}`)}`);
      }),
    );

  label
    .command('clear')
    .description('remove one label')
    .argument('<name>', 'the label set')
    .requiredOption('--result <id>', 'the dataset record id (or a result id)')
    .option('--metric <name>', 'the metric', 'overall')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory')
    .action((name: string, o: { result: string; metric: string; workspace?: string }) =>
      withWorkspace(o.workspace, (store, ephemeral) => {
        needWorkspace(ephemeral);
        const ok = wrap(() => unlabel(store, { labels: name, record: o.result, metric: o.metric }));
        console.log(ok ? `${green('Removed')} the label` : dim('There was no such label.'));
      }),
    );

  rag
    .command('calibrate')
    .description('how well the judges of a run agree with your labels: kappa, accuracy, TPR/TNR, confusion matrix, bootstrap intervals, disagreements, and (--tune) the pass mark that agrees most')
    .argument('[labels]', 'the label set, or the evaluation it is named after (default: the run’s evaluation)')
    .requiredOption('--run <run>', 'the run whose judged results are compared with the labels')
    .option('--metric <names>', 'only these metrics (comma separated)')
    .option('--by-judge', 'show every judge model’s own numbers, even when only one judged')
    .option('--tune', 'find the pass mark that agrees most with the labels')
    .option('--apply', 'with --tune: write the tuned pass mark into the evaluation (--evaluation) or the custom metric file')
    .option('--evaluation <name>', 'with --apply: the saved evaluation whose evaluator gets the pass mark')
    .option('--min-kappa <k>', 'exit 1 when a metric’s kappa is below this', parseFloat)
    .option('--no-reviews', 'do not count good/bad reviews of results as `overall` labels')
    .addOption(new Option('--format <format>', 'with --out: the report as md or json').choices(['md', 'json']).default('md'))
    .option('-o, --out <file>', 'write the report to a file (Markdown by default) as well')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory')
    .option('--json', 'print as JSON')
    .action((labels: string | undefined, o: { run: string; metric?: string; byJudge?: boolean; tune?: boolean; apply?: boolean; evaluation?: string; minKappa?: number; reviews?: boolean; format?: 'md' | 'json'; out?: string; workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        needWorkspace(ephemeral);
        if (o.apply && !o.tune) throw new CliError('--apply needs --tune', EXIT.CONFIG_ERROR);
        const name = labels ? labels.replace(/^.*[\\/]/, '').replace(/\.json$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-') : defaultLabelsName(store, o.run);
        let report: CalibrationReport;
        try {
          report = await calibrateRun(store, { run: o.run, labels: name, metrics: list(o.metric), tune: o.tune, reviews: o.reviews });
        } catch (e) {
          throw e instanceof ApsError ? new CliError(e.message, EXIT.CONFIG_ERROR) : e;
        }
        const applied: Array<{ metric: string; changed: string; threshold: number }> = [];
        const notApplied: Array<{ metric: string; why: string }> = [];
        if (o.apply)
          for (const m of report.metrics) {
            if (!m.tuning || m.metric === 'overall' || (m.tuning.gain ?? 0) <= 0) continue;
            try {
              const a = applyThreshold(store, { metric: m.metric, threshold: m.tuning.threshold, evaluation: o.evaluation, calibration: { run: o.run, n: m.agreement.n, kappa: m.tuning.agreement.kappa, tpr: m.tuning.agreement.tpr, tnr: m.tuning.agreement.tnr } });
              applied.push({ metric: m.metric, ...a });
            } catch (e) {
              // a metric the evaluation does not score (or no --evaluation for it) is reported, not fatal: the others still apply
              notApplied.push({ metric: m.metric, why: (e as Error).message });
            }
          }
        if (o.out) writeFileSync(resolve(o.out), o.format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : calibrationMarkdown(report));
        const low = o.minKappa === undefined ? [] : report.metrics.filter((m) => m.agreement.kappa === undefined || m.agreement.kappa < o.minKappa!);
        if (o.json) printJson({ ...report, ...(applied.length ? { applied } : {}), ...(notApplied.length ? { notApplied } : {}),...(o.minKappa !== undefined ? { minKappa: o.minKappa, belowMinKappa: low.map((m) => m.metric) } : {}) });
        else {
          if (!report.metrics.length) console.log(dim(`No labelled results in run ${o.run} (label set "${name}"${report.missing ? `, ${report.missing} labels are about records this run does not have` : ''}). Label some with \`testpion rag label\`.`));
          for (const m of report.metrics) printMetric(m);
          if (report.stale) console.log(yellow(`${report.stale} labels are about an answer this run did not give and were left out.`));
          for (const n of notApplied) console.log(yellow(`Not applied: ${n.metric}: ${n.why}`));
          for (const a of applied) console.log(`${green('Applied')} ${a.metric} pass mark ${a.threshold} → ${a.changed}`);
          if (o.out) console.log(`${green('Wrote')} the calibration report → ${o.out}`);
        }
        if (low.length) {
          if (!o.json) console.error(red(`kappa is below ${o.minKappa} for: ${low.map((m) => m.metric).join(', ')}`));
          process.exitCode = EXIT.TEST_FAILURE;
        }
      }),
    );
}
