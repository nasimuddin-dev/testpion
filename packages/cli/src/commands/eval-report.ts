/**
 * `testpion eval summary|why|diff|variants`: how an evaluation run went in a few sentences, why one case failed, how a case's
 * answer changed since the run before, and the comparison of an evaluation's variants. The same functions as the app's report
 * card and the `eval_summary`, `eval_explain_failure`, `eval_case_diff` and `eval_variants` MCP tools, so the words are the same.
 */
import type { Command } from 'commander';
import { aiRunDeps, evalCaseDiff, evalReport, evalTrajectory, evalWhy, findSavedEvaluation, runAiTask, variantsSummary, WorkspaceManager } from '@testpion/core';
import { formatUsd } from '@testpion/shared';
import { EXIT, bold, dim, green, red, yellow, CliError, printJson, withWorkspace, cliContext, requireEnvironment, WORKSPACE_OPTION } from '../shared.js';
import { printPreview } from './ai-print.js';

const noWorkspace = () => new CliError('No workspace found: run inside a workspace or pass -w <nameOrPath>', EXIT.CONFIG_ERROR);

export function registerEvalReportCommands(ev: Command): void {
  ev.command('summary')
    .description('how an evaluation run went, in a few sentences: "17 of 20 passed", cost and time, which checks failed, the failed cases, the pass line and how it compares with the run before')
    .argument('[run]', 'the run: its id, "last" (the newest evaluation run, the default) or an evaluation name (its newest run)', 'last')
    .option(...WORKSPACE_OPTION)
    .option('--against <run>', 'compare with this run instead of the one before it')
    .option('--json', 'print as JSON: headline, byCheck, failures, passLine, vsLast, trend and text (for scripts and AI agents)')
    .action((run: string, o: { workspace?: string; against?: string; json?: boolean }) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        if (ephemeral) throw noWorkspace();
        const r = await evalReport(store, { run, against: o.against });
        if (o.json) return printJson(r);
        console.log(`${bold(r.run.name)} ${dim(`(${r.run.id})`)}`);
        console.log(r.failed + r.errors ? red(r.headline) : green(r.headline));
        console.log(r.text.slice(r.headline.length + 1).trim());
        if (r.byCheck.length) console.log(dim(`By check: ${r.byCheck.map((c) => `${c.name} ${c.passed}/${c.total}${c.aiReviewer ? ' (AI reviewer)' : ''}`).join(' · ')}`));
        for (const f of r.failures.slice(0, 10)) {
          console.log(`${red('✗')} ${f.key}  ${dim(`expected ${f.expected ?? '–'}  got ${(f.got ?? f.error ?? '–').replace(/\s+/g, ' ').slice(0, 80)}`)}`);
          if (f.reason) console.log(dim(`    AI reviewer: ${f.reason.slice(0, 200)}`));
        }
        if (r.failures.length > 10) console.log(dim(`… ${r.failures.length - 10} more failed cases (--json lists them)`));
        if (r.trend.length > 1) console.log(dim(`Trend: ${r.trend.map((t) => `${Math.round(t.passRate * 100)}%`).join(' → ')}`));
      }),
    );

  ev.command('why')
    .description('why one failed case failed: an AI reviewer’s stored reason when it graded the case, else the AI task eval-why with the model you configured (--dry-run shows what would be sent)')
    .argument('<run>', 'the run: its id, "last" or an evaluation name')
    .argument('<case>', 'the case: its result id, its key (e.g. case-7) or its name')
    .option(...WORKSPACE_OPTION)
    .option('-e, --environment <name>', 'environment whose variable names the task may use')
    .option('--privacy <level>', 'full (redacted, default), metadata or names')
    .option('--dry-run', 'send nothing: print what would be sent and the estimate')
    .option('--no-ai', 'only the stored reason of an AI reviewer: never call a model')
    .option('--json', 'print as JSON (for scripts and AI agents)')
    .action((run: string, kase: string, o: { workspace?: string; environment?: string; privacy?: string; dryRun?: boolean; ai?: boolean; json?: boolean }) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        if (ephemeral) throw noWorkspace();
        const why = await evalWhy(store, { run, case: kase });
        const head = { run: why.run, case: why.key, name: why.name, expected: why.failure.expected, reply: why.failure.got, failedChecks: why.failure.failedChecks.map((c) => ({ name: c.name, message: c.message })) };
        if (why.stored) {
          if (o.json) return printJson({ ...head, source: why.stored.source, answer: why.stored.reason, calledModel: false });
          console.log(`${bold(`Case ${why.key}`)} ${dim(why.name)}`);
          console.log(`${why.stored.reason}\n${dim('AI reviewer’s reason (stored with the run; no model was called)')}`);
          return;
        }
        if (o.ai === false) {
          if (o.json) return printJson({ ...head, calledModel: false, note: 'No AI reviewer graded this case, so there is no stored reason.' });
          console.log(yellow('No AI reviewer graded this case, so there is no stored reason. Leave out --no-ai to ask the AI task.'));
          console.log(why.failure.failedChecks.map((c) => `${red('✗')} ${c.name}: ${c.message}`).join('\n'));
          return;
        }
        if (o.environment) requireEnvironment(store, o.environment);
        const ctx = cliContext(store, o.environment);
        try {
          const r = await runAiTask(aiRunDeps({ ctx, settings: new WorkspaceManager().loadSettings(), store, surface: process.env.CI ? 'ci' : 'cli', env: process.env }), { task: 'eval-why', context: why.context, privacy: o.privacy, dryRun: o.dryRun });
          if (o.json) return printJson({ ...head, ...r, source: 'AI task eval-why', calledModel: !r.dryRun, answer: r.text });
          if (r.dryRun) return printPreview(r);
          console.log(`${bold(`Case ${why.key}`)} ${dim(why.name)}\n${r.text}`);
          console.log(dim(`\n${r.provider}/${r.model} · ${r.usage.inputTokens} in / ${r.usage.outputTokens} out${r.costUsd !== undefined ? ` · ${formatUsd(r.costUsd)}` : ''} · AI-generated`));
        } finally {
          await ctx.dispose();
        }
      }),
    );

  ev.command('diff')
    .description('how the answer of one case changed since the run before it: both answers, whether the case got better or worse, and the difference')
    .argument('<run>', 'the run: its id, "last" or an evaluation name')
    .argument('<case>', 'the case: its result id, its key or its name')
    .option(...WORKSPACE_OPTION)
    .option('--against <run>', 'compare with this run instead of the one before it')
    .option('--json', 'print as JSON (for scripts and AI agents)')
    .action((run: string, kase: string, o: { workspace?: string; against?: string; json?: boolean }) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        if (ephemeral) throw noWorkspace();
        const d = await evalCaseDiff(store, { run, case: kase, against: o.against });
        if (o.json) return printJson(d);
        console.log(`${bold(`Case ${d.key}`)} ${dim(d.name)}`);
        console.log(d.text);
        if (d.diff && !d.same) {
          if (d.diff.body.format === 'json') for (const c of d.diff.body.changes) console.log(`  ${c.path}: ${JSON.stringify(c.before) ?? '–'} → ${JSON.stringify(c.after) ?? '–'}`);
          else for (const l of d.diff.body.lines ?? []) console.log(l.op === '+' ? green(`+ ${l.text}`) : l.op === '-' ? red(`- ${l.text}`) : dim(`  ${l.text}`));
        }
      }),
    );

  ev.command('trajectory')
    .description('what an agent did in one case, step by step: each model call, each tool call with its arguments and result, the final answer, and the tool checks pinned to the step that decided them (met at the call, broken at the forbidden call, never called)')
    .argument('<run>', 'the run: its id, "last" or an evaluation name')
    .argument('<case>', 'the case: its result id, its key or its name')
    .option(...WORKSPACE_OPTION)
    .option('--json', 'print as JSON: items (each with its pins), endPins and text (for scripts and AI agents)')
    .action((run: string, kase: string, o: { workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        if (ephemeral) throw noWorkspace();
        const t = await evalTrajectory(store, { run, case: kase });
        if (o.json) return printJson(t);
        console.log(`${bold(t.name)} ${t.status === 'passed' ? green(t.status) : red(t.status)}`);
        console.log(dim(t.text));
        const pin = (p: { state: string; text: string; check: string }) => `    ${p.state === 'bad' ? red('✗') : p.state === 'ok' ? green('✓') : dim('·')} ${p.text} ${dim(`(${p.check})`)}`;
        for (const it of t.items) {
          const mark = it.kind === 'tool' ? (it.error ? red('  ⚠ ') : '  → ') : it.kind === 'model' ? bold('') : '';
          console.log(`${mark}${it.kind === 'tool' ? it.title : bold(it.title)}`);
          if (it.detail && it.kind !== 'tool') console.log(dim(`    ${it.detail.replace(/\s+/g, ' ').slice(0, 200)}`));
          if (it.kind === 'tool' && it.detail) console.log(dim(`    ← ${it.detail.replace(/\s+/g, ' ').slice(0, 160)}`));
          for (const p of it.pins) console.log(pin(p));
        }
        for (const p of t.endPins) console.log(pin(p));
      }),
    );

  ev.command('variants')
    .description('compare the variants of a saved evaluation (other prompt versions and models, set in the app’s Compare mode): the latest run of each, passed, cost and time per variant, the winner of each row and one sentence. Run them first with `eval run <name> --variants`')
    .argument('<name>', 'saved evaluation name or id')
    .option(...WORKSPACE_OPTION)
    .option('--json', 'print as JSON (for scripts and AI agents)')
    .action((ref: string, o: { workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        if (ephemeral) throw noWorkspace();
        const s = await variantsSummary(store, { evaluation: findSavedEvaluation(store, ref) });
        if (o.json) return printJson(s);
        printVariants(s);
      }),
    );
}

/** The comparison table as text. */
export function printVariants(s: Awaited<ReturnType<typeof variantsSummary>>): void {
  console.log(bold(`Compare: ${s.evaluation}`));
  if (!s.ready) return console.log(yellow(s.conclusion));
  const w = Math.max(8, ...s.columns.map((c) => c.label.length + 3));
  console.log(dim(['', ...s.columns.map((c) => `${c.letter}: ${c.label}`.padEnd(w)), 'Winner'].join('  ')));
  for (const r of s.rows) console.log([r.label.padEnd(22), ...r.values.map((v) => v.padEnd(w)), r.winnerText].join('  '));
  console.log(`\n${s.conclusion}`);
}
