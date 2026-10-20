/**
 * `testpion rag metric list|new|validate|import|export` and `testpion rag matrix`: the custom metrics of a workspace
 * (`metrics/*.yaml`, planning/rag-testing.md §4d) and the samples × metrics matrix of a run as a file. `rag metric test`
 * (rag-eval.ts) tries any metric, custom ones included, on one sample. Exit 1 when a file has an error or an example
 * disagrees, 2 for a configuration error.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command, Option } from 'commander';
import {
  ApsError,
  buildMetricMatrix,
  compileCustomMetric,
  stringifyYaml,
  listMetricFiles,
  parseCustomMetric,
  parseRagasResult,
  ragMatrixCsv,
  ragMatrixHtml,
  ragMatrixJson,
  readMetricFile,
  runMetricExamples,
  runResults,
  syncCustomMetrics,
  writeMetricFile,
} from '@testpion/core';
import { CUSTOM_METRIC_KINDS, customMetricTemplate, type CustomMetricKind } from '@testpion/shared';
import { EXIT, CliError, bold, cliContext, dim, green, printJson, red, withWorkspace, yellow } from '../shared.js';
import { machine } from '../output.js';
import { proposeCommand } from './ai-propose.js';

const needWorkspace = (ephemeral: string | undefined) => {
  if (ephemeral) throw new CliError('No workspace found: run inside a workspace or pass -w <nameOrPath>', EXIT.CONFIG_ERROR);
};

const judgeRef = (j: string | undefined) => (j ? { provider: j.split('/')[0], ...(j.includes('/') ? { model: j.split('/').slice(1).join('/') } : {}) } : undefined);

export function registerRagMetricFileCommands(rag: Command): void {
  const metric = rag.commands.find((c) => c.name() === 'metric')!;

  metric
    .command('list')
    .description('the custom metrics of the workspace (metrics/*.yaml): id, kind, version, and what is wrong with a file')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory')
    .option('--json', 'print as JSON')
    .action((o: { workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, (store, ephemeral) => {
        needWorkspace(ephemeral);
        const sync = syncCustomMetrics(store);
        const rows = listMetricFiles(store).map((f) => {
          const p = parseCustomMetric(f.text, { fileId: f.id });
          const bad = sync.files.find((x) => x.id === f.id)?.problems ?? p.problems;
          return { id: f.id, name: p.metric?.name ?? f.id, kind: p.metric?.kind, version: p.metric?.version, path: f.path, registered: sync.registered.includes(`custom/${f.id}`), problems: bad.map((x) => `${x.level}: ${x.field ? `${x.field}: ` : ''}${x.message}`) };
        });
        if (o.json) return printJson({ count: rows.length, metrics: rows });
        if (!rows.length) return console.log(dim('No custom metrics. `testpion rag metric new <id> --kind judge` makes one.'));
        for (const r of rows) {
          console.log(`${bold(r.id.padEnd(28))} ${dim(`${r.kind ?? '?'} · v${r.version ?? '?'}`)}  ${r.registered ? green('ready') : red('not usable')}`);
          for (const p of r.problems) console.log(`    ${p.startsWith('error') ? red(p) : yellow(p)}`);
        }
      }),
    );

  metric
    .command('new')
    .description('make a custom metric file: a starting file of a kind, or (--from-description) a draft written by the AI with examples, checked before it is offered')
    .argument('<id>', 'the metric id: lower-case letters, digits and hyphens; the file is metrics/<id>.yaml')
    .addOption(new Option('--kind <kind>', 'the kind of metric').choices(CUSTOM_METRIC_KINDS.map((k) => k.id)).default('judge'))
    .option('--from-description <text>', 'describe what good looks like; the AI drafts the file (a proposal; --apply writes it)')
    .option('--apply', 'with --from-description: write the draft when its checks pass')
    .option('--force', 'replace a file that exists')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory')
    .option('-e, --environment <name>')
    .option('--provider <name>')
    .option('--model <name>')
    .option('--dry-run', 'with --from-description: show what would be sent, send nothing')
    .option('--no-ai', 'with --from-description: nothing to do without a model (a starting file is made instead)')
    .option('--json', 'print as JSON')
    .action(async (id: string, o: { kind: CustomMetricKind; fromDescription?: string; apply?: boolean; force?: boolean; workspace?: string; environment?: string; provider?: string; model?: string; dryRun?: boolean; ai?: boolean; json?: boolean }) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        needWorkspace(ephemeral);
        if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) throw new CliError(`"${id}" is not a metric id: lower-case letters, digits and hyphens`, EXIT.CONFIG_ERROR);
        if (o.fromDescription && o.ai !== false) {
          const ctx = cliContext(store, o.environment);
          try {
            await proposeCommand({
              store,
              ctx,
              json: !!o.json || machine(),
              task: 'rag-draft-metric',
              item: undefined,
              context: { kind: o.kind, existing: listMetricFiles(store).map((f) => f.id), id },
              question: o.fromDescription,
              provider: o.provider,
              model: o.model,
              ai: true,
              dryRun: o.dryRun,
              apply: o.apply,
              appliedHint: () => `metrics/${id}.yaml, ready for \`testpion rag metric validate ${id} --examples\``,
              show: (p) => console.log(`${bold('Draft')} ${p.items[0]?.title ?? ''}\n${dim('─'.repeat(40))}\n${p.items[0]?.after ?? ''}`),
            });
          } finally {
            await ctx.dispose();
          }
          return;
        }
        if (readMetricFile(store, id) && !o.force) throw new CliError(`metrics/${id}.yaml exists (--force replaces it)`, EXIT.CONFIG_ERROR);
        const text = stringifyYaml(customMetricTemplate(o.kind, id));
        writeMetricFile(store, id, text);
        if (o.json) return printJson({ id, kind: o.kind, path: `metrics/${id}.yaml` });
        console.log(`${green('Wrote')} metrics/${id}.yaml ${dim(`(${o.kind})`)}\nEdit it, then \`testpion rag metric validate ${id} --examples\`; \`testpion rag metric test custom/${id} --answer "…"\` tries it on one sample.`);
      }),
    );

  metric
    .command('validate')
    .description('check metric files (all, or the ones named): the fields, the references, the rules, the cycles; --examples runs their examples and each must come out as written (judged metrics call the judge)')
    .argument('[ids...]', 'metric ids (default: every file)')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory')
    .option('-e, --environment <name>')
    .option('--examples', 'run the examples too (a judge or checklist metric asks the judge)')
    .option('--judge <provider/model>', 'the judge of the examples')
    .option('--json', 'print as JSON')
    .action(async (ids: string[], o: { workspace?: string; environment?: string; examples?: boolean; judge?: string; json?: boolean }) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        needWorkspace(ephemeral);
        const ctx = cliContext(store, o.environment);
        try {
          const sync = syncCustomMetrics(store);
          const files = listMetricFiles(store).filter((f) => !ids.length || ids.includes(f.id));
          if (ids.length && files.length !== ids.length) throw new CliError(`No metric file ${ids.filter((i) => !files.some((f) => f.id === i)).join(', ')} in metrics/`, EXIT.CONFIG_ERROR);
          const out = [];
          let failed = false;
          for (const f of files) {
            const problems = sync.files.find((x) => x.id === f.id)?.problems ?? parseCustomMetric(f.text, { fileId: f.id }).problems;
            const errors = problems.filter((p) => p.level === 'error');
            let examples: Awaited<ReturnType<typeof runMetricExamples>> | undefined;
            if (o.examples && !errors.length) {
              const p = parseCustomMetric(f.text, { fileId: f.id, known: new Set(files.map((x) => x.id)) });
              if (p.metric) {
                try {
                  examples = await runMetricExamples(compileCustomMetric(p.metric), { providers: ctx.services.providers, ragJudge: ctx.services.ragJudge, judge: judgeRef(o.judge) });
                } catch (e) {
                  throw e instanceof ApsError ? new CliError(e.message, EXIT.CONFIG_ERROR) : e;
                }
              }
            }
            if (errors.length || examples?.some((x) => !x.ok)) failed = true;
            out.push({ id: f.id, problems, ...(examples ? { examples } : {}) });
          }
          if (o.json) printJson({ ok: !failed, metrics: out });
          else
            for (const r of out) {
              const errs = r.problems.filter((p) => p.level === 'error').length;
              console.log(`${errs || r.examples?.some((x) => !x.ok) ? red('✗') : green('✓')} ${bold(r.id)}${r.examples ? dim(`  agrees with ${r.examples.filter((x) => x.ok).length}/${r.examples.length} examples`) : ''}`);
              for (const p of r.problems) console.log(`    ${p.level === 'error' ? red('error') : yellow('warning')}: ${p.field ? `${p.field}: ` : ''}${p.message}`);
              for (const x of r.examples ?? []) if (!x.ok) console.log(`    ${red('example')} #${x.index + 1}${x.name ? ` “${x.name}”` : ''} should ${x.expect}, ${x.got === 'na' ? 'has no score' : `does ${x.got}`}: ${x.message}`);
            }
          if (failed) process.exitCode = EXIT.TEST_FAILURE;
        } finally {
          await ctx.dispose();
        }
      }),
    );

  metric
    .command('export')
    .description('print a metric file (or write it to --out) to share it with another workspace')
    .argument('<id>')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory')
    .option('-o, --out <file>')
    .action((id: string, o: { workspace?: string; out?: string }) =>
      withWorkspace(o.workspace, (store, ephemeral) => {
        needWorkspace(ephemeral);
        const f = readMetricFile(store, id);
        if (!f) throw new CliError(`No metric file metrics/${id}.yaml`, EXIT.CONFIG_ERROR);
        if (o.out) {
          writeFileSync(resolve(o.out), f.text);
          console.log(`${green('Wrote')} ${o.out}`);
        } else process.stdout.write(f.text);
      }),
    );

  metric
    .command('import')
    .description('copy a metric file into the workspace after checking it (nothing in it is executed)')
    .argument('<file>')
    .option('--id <id>', 'the id to give it (default: the file’s own)')
    .option('--force', 'replace a file that exists')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory')
    .action((file: string, o: { id?: string; force?: boolean; workspace?: string }) =>
      withWorkspace(o.workspace, (store, ephemeral) => {
        needWorkspace(ephemeral);
        const text = readFileSync(resolve(file), 'utf8');
        const guess = o.id ?? /^id:\s*["']?([a-z0-9-]+)/m.exec(text)?.[1];
        if (!guess) throw new CliError('The file has no id: (use --id <id>)', EXIT.CONFIG_ERROR);
        const p = parseCustomMetric(text, { fileId: guess, known: new Set(listMetricFiles(store).map((f) => f.id)) });
        if (!p.metric) throw new CliError(`Not a valid metric file:\n${p.problems.filter((x) => x.level === 'error').map((x) => `  ${x.field ? `${x.field}: ` : ''}${x.message}`).join('\n')}`, EXIT.CONFIG_ERROR);
        if (readMetricFile(store, guess) && !o.force) throw new CliError(`metrics/${guess}.yaml exists (--force replaces it)`, EXIT.CONFIG_ERROR);
        writeMetricFile(store, guess, text);
        console.log(`${green('Imported')} metrics/${guess}.yaml`);
      }),
    );

  rag
    .command('matrix')
    .description('a RAG run’s samples × metrics matrix as a file or a table: every metric’s score per sample, the aggregates, the failure classes; --ragas-result adds the scores of a Ragas result table beside yours')
    .argument('<run>', 'the run id')
    .addOption(new Option('--format <format>', 'csv, json or html').choices(['csv', 'json', 'html']).default('json'))
    .addOption(new Option('--names <names>', 'name the score columns as Ragas does (answer_relevancy, nv_accuracy …)').choices(['testpion', 'ragas']).default('testpion'))
    .option('--ragas-result <file>', 'a Ragas result table (CSV or JSON from EvaluationResult.to_pandas()): its metric columns are added, matched to the samples by the question')
    .option('-o, --out <file>', 'write the file here (default: print it)')
    .option('--table', 'print the per-metric table (mean, p10, pass rate, interval) instead of a file format')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory')
    .action(async (run: string, o: { format: 'csv' | 'json' | 'html'; names: 'testpion' | 'ragas'; ragasResult?: string; out?: string; table?: boolean; workspace?: string }) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        needWorkspace(ephemeral);
        let external;
        try {
          external = o.ragasResult ? parseRagasResult(readFileSync(resolve(o.ragasResult), 'utf8')) : undefined;
        } catch (e) {
          throw e instanceof ApsError ? new CliError(e.message, EXIT.CONFIG_ERROR) : e;
        }
        const m = await buildMetricMatrix(runResults(store, run), { runId: run, all: true, external });
        if (!m.total) throw new CliError(`Run ${run} has no RAG results`, EXIT.CONFIG_ERROR);
        if (o.table) {
          console.log(`${bold('Metric'.padEnd(34))}${'mean'.padStart(7)}${'pass'.padStart(7)}${'n'.padStart(6)}${'n/a'.padStart(5)}`);
          for (const a of m.aggregates) console.log(`${a.key.padEnd(34)}${String(a.mean ?? '—').padStart(7)}${(a.passRate !== undefined ? `${Math.round(a.passRate * 100)}%` : '—').padStart(7)}${String(a.n).padStart(6)}${String(a.naCount).padStart(5)}`);
          return;
        }
        const text = o.format === 'csv' ? ragMatrixCsv(m, { names: o.names }) : o.format === 'html' ? ragMatrixHtml(m, { names: o.names }) : ragMatrixJson(m, { names: o.names });
        if (o.out) {
          writeFileSync(resolve(o.out), text);
          console.log(`${green('Wrote')} ${m.total} samples × ${m.columns.length} metrics → ${o.out}`);
        } else process.stdout.write(text);
      }),
    );
}
