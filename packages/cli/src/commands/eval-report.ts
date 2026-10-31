/**
 * `testpion eval summary|why|diff|variants`: how an evaluation run went in a few sentences, why one case failed, how a case's
 * answer changed since the run before, and the comparison of an evaluation's variants. The same functions as the app's report
 * card and the `eval_summary`, `eval_explain_failure`, `eval_case_diff` and `eval_variants` MCP tools, so the words are the same.
 */
import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { aiRunDeps, evalCaseDiff, evalReport, evalReviewQueue, evalTrajectory, evalWhy, diffPromptVersions, listPromptVersions, reviewToDataset, savePromptVersion, setEvaluationBaseline, usePromptVersion, findSavedEvaluation, runAiTask, variantsSummary, WorkspaceManager } from '@testpion/core';
import { datasetHealth, formatUsd } from '@testpion/shared';
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
        if (d.retrieved) console.log(dim(`Retrieved documents: ${d.retrieved.text}${d.retrieved.causeNow ? ` Now: ${d.retrieved.causeNow}.` : ''}`));
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
    .option('--against <run>', 'compare the tools with this run instead of the evaluation’s baseline')
    .option('--json', 'print as JSON: items (each with its pins), endPins, vsBaseline and text (for scripts and AI agents)')
    .action((run: string, kase: string, o: { workspace?: string; against?: string; json?: boolean }) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        if (ephemeral) throw noWorkspace();
        const t = await evalTrajectory(store, { run, case: kase, against: o.against });
        if (o.json) return printJson(t);
        console.log(`${bold(t.name)} ${t.status === 'passed' ? green(t.status) : red(t.status)}`);
        console.log(dim(t.text));
        if (t.vsBaseline) console.log(t.vsBaseline.kind === 'same' ? green(`Against the baseline (${t.vsBaseline.baselineRun}): ${t.vsBaseline.text}`) : yellow(`Against the baseline (${t.vsBaseline.baselineRun}): ${t.vsBaseline.text}`));
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

  ev.command('baseline')
    .description('mark a run as the golden run of its agent evaluation (the tools it used are the reference), or clear it: later runs and `eval trajectory` say how their tools differ')
    .argument('[run]', 'the run: its id, "last" or an evaluation name (its newest run)')
    .option(...WORKSPACE_OPTION)
    .option('--clear', 'remove the baseline of the evaluation (name it with --evaluation)')
    .option('--evaluation <name>', 'the saved evaluation (default: the run’s own)')
    .option('--json', 'print as JSON')
    .action((run: string | undefined, o: { workspace?: string; clear?: boolean; evaluation?: string; json?: boolean }) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        if (ephemeral) throw noWorkspace();
        const r = setEvaluationBaseline(store, { run, clear: o.clear, evaluation: o.evaluation });
        if (o.json) return printJson(r);
        console.log(r.baselineRun ? green(`Baseline of "${r.evaluation}": ${r.baselineRun}`) : green(`Baseline of "${r.evaluation}" cleared`));
      }),
    );

  ev.command('review')
    .description('the answers of a run to read and grade good or bad, the failed ones first; what the checks decided stays hidden until a case is graded (grade with `testpion history review <run> <result> --good|--bad`)')
    .argument('<run>', 'the run: its id, "last" or an evaluation name')
    .option(...WORKSPACE_OPTION)
    .option('--count <n>', 'how many answers (default 10, at most 50)', (v) => Number(v))
    .option('--export', 'print the graded answers as JSON lines (input, answer, rating, note) instead')
    .option('--json', 'print as JSON: cases (each with its grade), graded, agreement and text (for scripts and AI agents)')
    .action((run: string, o: { workspace?: string; count?: number; export?: boolean; json?: boolean }) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        if (ephemeral) throw noWorkspace();
        const q = await evalReviewQueue(store, { run, count: o.count });
        if (o.export) {
          for (const c of q.cases.filter((x) => x.rating)) console.log(JSON.stringify({ case: c.key, input: c.input, answer: c.answer, rating: c.rating, ...(c.note ? { note: c.note } : {}) }));
          return;
        }
        if (o.json) return printJson(q);
        console.log(`${bold(q.evaluation ?? q.run)} ${dim(`(${q.run})`)}`);
        console.log(q.text);
        q.cases.forEach((c, i) => {
          console.log(`\n${bold(`${i + 1}. ${c.key}`)} ${c.rating ? (c.rating === 'good' ? green('good') : red('bad')) : dim('not graded')}`);
          if (c.input) console.log(dim(`  asked: ${c.input.replace(/\s+/g, ' ').slice(0, 200)}`));
          console.log(`  answered: ${(c.answer ?? '(empty)').replace(/\s+/g, ' ').slice(0, 300)}`);
          if (c.verdict) console.log(dim(`  the checks: ${c.verdict.status}${c.verdict.failedChecks.length ? ` (${c.verdict.failedChecks.join(', ')})` : ''}`));
        });
        console.log(dim('\nGrade one with: testpion history review <run id> <result id> --good|--bad -w <workspace>'));
      }),
    );

  ev.command('review-add')
    .description('add the answers graded good to the evaluation’s test cases as their expected answers (a record that already has one keeps it)')
    .argument('<run>', 'the run: its id, "last" or an evaluation name')
    .option(...WORKSPACE_OPTION)
    .option('--json', 'print as JSON')
    .action((run: string, o: { workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        if (ephemeral) throw noWorkspace();
        const r = await reviewToDataset(store, { run });
        if (o.json) return printJson(r);
        console.log(green(r.text));
      }),
    );

  ev.command('versions')
    .description('the versions of a saved evaluation’s prompt: each with the result of the run made with exactly that prompt; the one in use is marked *')
    .argument('<evaluation>', 'saved evaluation name or id')
    .option(...WORKSPACE_OPTION)
    .option('--json', 'print as JSON: versions (id, name, current, run) and text (for scripts and AI agents)')
    .action((ref: string, o: { workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        if (ephemeral) throw noWorkspace();
        const v = await listPromptVersions(store, ref);
        if (o.json) return printJson(v);
        console.log(`${bold(v.evaluation)}${v.passLine ? dim(` · pass line ${v.passLine}%`) : ''}`);
        console.log(v.text);
        if (!v.currentSaved) console.log(yellow(`The prompt in use is not saved as a version${v.currentRun ? ` (its last run: ${v.currentRun.passed} of ${v.currentRun.total} passed)` : ''}: \`testpion eval version-save "${v.evaluation}" "<name>"\`.`));
      }),
    );

  ev.command('lint')
    .description('look at the test cases of a saved evaluation: repeated inputs, cases without the expected answer a check compares with, prompt variables a case does not fill, one answer most cases expect, very long inputs (exit 1 when there is something to look at)')
    .argument('<evaluation>', 'saved evaluation name or id')
    .option(...WORKSPACE_OPTION)
    .option('--json', 'print as JSON')
    .action((ref: string, o: { workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        if (ephemeral) throw noWorkspace();
        const d = findSavedEvaluation(store, ref);
        const h = datasetHealth({ dataset: d.dataset, datasetFormat: d.datasetFormat, expectedField: d.expectedField, prompt: d.type === 'rag' ? '' : d.prompt, evaluators: d.type === 'rag' ? [] : (d.evaluators as unknown as Array<Record<string, unknown>>) });
        if (o.json) printJson({ evaluation: d.name, ...h });
        else {
          console.log(h.notes.length ? yellow(h.text) : green(h.text));
          for (const n of h.notes) if (n.cases?.length) console.log(dim(`  ${n.kind}: case ${n.cases.join(', ')}`));
        }
        if (h.notes.length) process.exitCode = EXIT.TEST_FAILURE;
      }),
    );

  ev.command('version-save')
    .description('save the evaluation’s prompt and system prompt now as a named version, or a draft (--prompt, --system) beside the others without changing the evaluation')
    .argument('<evaluation>', 'saved evaluation name or id')
    .argument('<name>', 'the version’s name, for example "Shorter prompt"')
    .option(...WORKSPACE_OPTION)
    .option('--note <text>', 'what changed and why')
    .option('--prompt <text|@file>', 'a draft prompt to keep as the version (the evaluation keeps the one it has)')
    .option('--system <text|@file>', 'the draft’s system prompt')
    .option('--json', 'print as JSON')
    .action((ref: string, name: string, o: { workspace?: string; note?: string; prompt?: string; system?: string; json?: boolean }) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        if (ephemeral) throw noWorkspace();
        const text = (v?: string) => (v?.startsWith('@') ? readFileSync(v.slice(1), 'utf8') : v);
        const v = savePromptVersion(store, { evaluation: ref, name, note: o.note, prompt: text(o.prompt), system: text(o.system) });
        if (o.json) return printJson(v);
        console.log(green(`Saved version "${v.name}" (${v.id})`));
      }),
    );

  ev.command('version-diff')
    .description('what changed between a version and another one (or the prompt in use), word by word, for the prompt and the system prompt')
    .argument('<evaluation>', 'saved evaluation name or id')
    .argument('<version>', 'the older wording: a version’s name or id')
    .argument('[other]', 'the newer wording: another version (default: the prompt in use)')
    .option(...WORKSPACE_OPTION)
    .option('--json', 'print as JSON: the segments (same, add, del) and the counts')
    .action((ref: string, version: string, other: string | undefined, o: { workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        if (ephemeral) throw noWorkspace();
        const d = await diffPromptVersions(store, { evaluation: ref, version, other });
        if (o.json) return printJson(d);
        console.log(bold(d.text));
        const show = (label: string, segs: typeof d.prompt.segments) => {
          console.log(dim(`
${label}`));
          console.log(segs.map((s) => (s.type === 'add' ? green(s.text) : s.type === 'del' ? red(`[-${s.text}-]`) : s.text)).join(''));
        };
        show('Prompt', d.prompt.segments);
        if (d.system) show('System prompt', d.system.segments);
      }),
    );

  ev.command('version-use')
    .description('make a version the evaluation’s prompt. A version under the pass line, worse than the prompt in use, or never run asks first (--confirm) and says the numbers; the prompt in use is kept as "Before <version>"')
    .argument('<evaluation>', 'saved evaluation name or id')
    .argument('<version>', 'the version’s name or id')
    .option(...WORKSPACE_OPTION)
    .option('--confirm', 'make it current even when it is under the pass line, worse, or never run')
    .option('--json', 'print as JSON')
    .action((ref: string, version: string, o: { workspace?: string; confirm?: boolean; json?: boolean }) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        if (ephemeral) throw noWorkspace();
        const r = await usePromptVersion(store, { evaluation: ref, version, confirm: o.confirm });
        if (o.json) return printJson(r);
        console.log(green(`"${r.version}" is now the prompt of "${r.evaluation}"${r.kept ? `; the one before is kept as "${r.kept}"` : ''}`));
        for (const g of r.gated) console.log(yellow(`  confirmed anyway: ${g}`));
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
