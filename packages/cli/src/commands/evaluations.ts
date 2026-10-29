/** `testpion eval list|run`: evaluations saved in the app (Evaluations ▸ Save), run by name locally or in CI. */
import { join } from 'node:path';
import { resolve } from 'node:path';
import { Command, Option } from 'commander';
import {
  WorkspaceManager,
  assertEvaluationRunnable,
  evaluationTests,
  estimateEvaluation,
  evaluationVariants,
  variantsSummary,
  type RunnableVariant,
  spendPlan,
  capRunOptions,
  formatEstimateUsd,
  findSavedEvaluation,
  listSavedEvaluations,
  runTests,
  shortId,
  type RunEvent,
  type RunSummary,
} from '@testpion/core';
import { EXIT, dim, bold, CliError, printJson, openWorkspace, withWorkspace, cliContext, requireEnvironment, WORKSPACE_OPTION } from '../shared.js';
import { cli } from '../output.js';
import { finishRun, printResult } from '../run.js';
import { registerEvalCompareCommands } from './eval-compare.js';
import { registerEvalQualityCommands } from './eval-quality.js';
import { registerEvalCasesCommands } from './eval-cases.js';
import { printVariants, registerEvalReportCommands } from './eval-report.js';

export function registerEvaluationCommands(program: Command): void {
  const ev = program.command('eval').description('evaluations saved in the app (dataset × prompt × model × evaluators): list them, run one by name, compare runs (matrix, compare with a baseline)');
  ev.command('list')
    .description('list the saved evaluations of a workspace')
    .option(...WORKSPACE_OPTION)
    .option('--json', 'print as JSON (for scripts and AI agents)')
    .action((o: { workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, (store, ephemeral) => {
        if (ephemeral) throw new CliError('No workspace found: run inside a workspace or pass -w <nameOrPath>', EXIT.CONFIG_ERROR);
        const list = listSavedEvaluations(store);
        if (o.json) return printJson(list);
        if (!list.length) return console.log(dim('No saved evaluations. Save one in the app: Evaluations ▸ Save.'));
        for (const e of list) console.log(`${bold(e.name)}${e.folder ? dim(`  (${e.folder})`) : ''}\n  ${dim(`${e.type} · ${e.provider}${e.model ? `/${e.model}` : ''} · ${e.cases} cases · ${e.evaluators.join(', ') || 'no evaluators'}`)}`);
      }),
    );
  ev.command('run')
    .description('run a saved evaluation by name or id; exits 1 when a case fails (for CI)')
    .argument('<name>', 'saved evaluation name or id')
    .option(...WORKSPACE_OPTION)
    .option('-e, --environment <name>', 'environment to use')
    .option('-c, --concurrency <n>', 'parallel cases (default: the saved setting)')
    .option('--retries <n>', 'retries per failing case (default: the saved setting)')
    .option('--limit <n>', 'only the first n dataset records')
    .option('--judge <provider/model>', 'RAG evaluations: the judge model of the judged metrics (default: the evaluation’s, else TESTPION_AI_PROVIDER / the AI settings’ large model)')
    .option('--max-cost <usd>', 'stop the run once it has cost this much (USD, from the price table; default $1.00 for a paid model, none for the offline demo model; 0 = no cap)')
    .option('--yes', 'go ahead when the estimate is over $0.50 (or 100 calls); without it such a run is refused with the estimate')
    .option('--variants', 'compare mode: run the evaluation and each of its variants (other prompt versions and models, set in the app) on the same cases, then print the comparison; a comparison is not a gate, so failed cases do not change the exit code')
    .option('--max-judge-cost <usd>', 'RAG evaluations: stop judging once this much (USD, from the price table) is spent; the rest is not scored')
    .addOption(new Option('-r, --reporter <formats...>', 'reporters: console, junit, json, html, markdown').default(['console', 'junit', 'json', 'html', 'markdown']))
    .option('-o, --out <dir>', 'output directory for results and reports')
    .option('--baseline <name>', 'compare results against a saved baseline; "last-good" is the last run of this evaluation that passed (the first run has none and is not compared)')
    .option('--save-baseline <name>', 'save this run as a baseline')
    .option('--fail-on-regression', 'exit 1 when the baseline comparison finds regressions')
    .option('-v, --verbose', 'show passing checks')
    .option('-q, --quiet', 'only print the summary')
    .action(async (ref: string, o: EvalRunOptions) => {
      process.exitCode = o.variants ? await executeVariantRuns(ref, o) : await executeEvalRun(ref, o);
    });
  registerEvalCompareCommands(ev);
  registerEvalCasesCommands(ev);
  registerEvalReportCommands(ev);
  registerEvalQualityCommands(ev, (ref, o) => executeEvalRun(ref, { reporter: ['console', 'junit', 'json', 'html', 'markdown'], ...o }));
}

export type EvalRunOptions = { variants?: boolean; maxCost?: string; yes?: boolean; judge?: string; maxJudgeCost?: string; workspace?: string; environment?: string; concurrency?: string; retries?: string; limit?: string; reporter: string[]; out?: string; baseline?: string; saveBaseline?: string; failOnRegression?: boolean; verbose?: boolean; quiet?: boolean };

/** Compare mode: every variant of the evaluation is run as a run of its own ("<name> · <variant>"), then the comparison is printed. */
async function executeVariantRuns(ref: string, o: EvalRunOptions): Promise<number> {
  const { store, ephemeral } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
  if (ephemeral) throw new CliError('No workspace found: run inside a workspace or pass -w <nameOrPath>', EXIT.CONFIG_ERROR);
  let base: ReturnType<typeof findSavedEvaluation>;
  let list: RunnableVariant[];
  try {
    base = findSavedEvaluation(store, ref);
    if (base.type === 'rag') throw new CliError('Variants compare prompts and models of a prompt evaluation: this is an evaluation of a bot with sources', EXIT.CONFIG_ERROR);
    list = evaluationVariants(base);
    if (list.length < 2) throw new CliError(`"${base.name}" has no variants. Add them in the app: open the evaluation and choose Compare.`, EXIT.CONFIG_ERROR);
  } catch (e) {
    store.close();
    throw e instanceof CliError ? e : new CliError((e as Error).message, EXIT.CONFIG_ERROR);
  }
  store.close();
  for (const v of list) {
    if (!o.quiet) console.log(bold(`Variant ${v.letter}: ${v.label}`));
    // the variant's own evaluation (its prompt, model); no baseline: this is a comparison, not a gate
    const code = await executeEvalRun(ref, { ...o, baseline: undefined, saveBaseline: undefined, failOnRegression: false, quiet: o.quiet ?? true }, { ...base, ...v.draft, id: base.id });
    if (code !== EXIT.SUCCESS && code !== EXIT.TEST_FAILURE) return code;
  }
  const again = openWorkspace(o.workspace, undefined, new WorkspaceManager());
  try {
    const summary = await variantsSummary(again.store, { evaluation: base });
    printVariants(summary);
  } finally {
    again.store.close();
  }
  return EXIT.SUCCESS;
}

async function executeEvalRun(
  ref: string,
  o: { maxCost?: string; yes?: boolean; judge?: string; maxJudgeCost?: string; workspace?: string; environment?: string; concurrency?: string; retries?: string; limit?: string; reporter: string[]; out?: string; baseline?: string; saveBaseline?: string; failOnRegression?: boolean; verbose?: boolean; quiet?: boolean },
  /** Compare mode: this variant of the evaluation, run under its own name. */
  as?: ReturnType<typeof findSavedEvaluation>,
): Promise<number> {
  const { store, ephemeral } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
  if (ephemeral) throw new CliError('No workspace found: run inside a workspace or pass -w <nameOrPath>', EXIT.CONFIG_ERROR);
  let evaluation: ReturnType<typeof findSavedEvaluation>;
  try {
    evaluation = as ?? findSavedEvaluation(store, ref);
    if (o.environment) requireEnvironment(store, o.environment);
  } catch (e) {
    store.close();
    throw e instanceof CliError ? e : new CliError((e as Error).message, EXIT.CONFIG_ERROR);
  }
  const judgeArg = o.judge?.split('/');
  const d = {
    ...evaluation,
    limit: o.limit ? Number(o.limit) : evaluation.limit,
    ...(judgeArg ? { judge: { provider: judgeArg[0], ...(judgeArg.length > 1 ? { model: judgeArg.slice(1).join('/') } : {}) } } : {}),
    ...(o.maxJudgeCost ? { maxJudgeCostUsd: Number(o.maxJudgeCost) } : {}),
  };
  const ctx = cliContext(store, o.environment);
  try {
    // a RAG evaluation: the target and the judge are checked now, once, with what to configure (never a silent judge)
    if (d.type === 'rag') assertEvaluationRunnable(store, ctx.services.ragJudge!, d);
  } catch (e) {
    await ctx.dispose();
    store.close();
    throw e;
  }
  // a prompt evaluation: what it costs, the cap that stops it, and asking first when it is big (AU-5, AU-18)
  const est = d.type === 'rag' ? undefined : estimateEvaluation(ctx.services, d);
  const plan = est ? spendPlan(est, o.maxCost !== undefined ? Number(o.maxCost) : d.maxCostUsd) : undefined;
  if (est && plan?.ask && !o.yes) {
    await ctx.dispose();
    store.close();
    throw new CliError(`${est.summary}. ${plan.reason ?? ''} Run again with --yes to go ahead, or lower --limit.`.replace(/\s+/g, ' '), EXIT.CONFIG_ERROR);
  }
  if (est && !o.quiet) console.log(dim(`estimate: ${est.summary}${plan?.capUsd !== undefined ? ` · stops at ${formatEstimateUsd(plan.capUsd)}` : ''}${est.offline ? ' · Offline demo model: its answers come from rules' : ''}`));
  // --baseline last-good: the last run of this evaluation that passed (a baseline kept under a name of its own)
  const lastGood = o.baseline === 'last-good' ? `last-good-${d.name}` : undefined;
  if (lastGood) {
    try {
      store.getBaseline(lastGood);
      o.baseline = lastGood;
    } catch {
      o.baseline = undefined;
      if (!o.quiet) console.log(dim('no earlier good run to compare with: this run becomes the first'));
    }
  }
  const runId = shortId('run-');
  const outDir = o.out ? resolve(o.out) : store.runDir(runId);
  const resultsFile = join(outDir, 'results.jsonl');
  if (!o.quiet) {
    console.log(bold(`TestPion — ${d.name}`));
    console.log(dim(`evaluation · ${d.provider}${d.model ? `/${d.model}` : ''}${o.environment ? ` · environment: ${o.environment}` : ''} · run: ${runId}`));
  }
  let summary: RunSummary;
  let guard: ReturnType<typeof capRunOptions>['guard'] | undefined;
  try {
    const capped = capRunOptions(
      {
      name: d.name,
      runId,
      tests: evaluationTests(d, { store }),
      concurrency: Number(o.concurrency ?? d.concurrency ?? 4),
      retries: Number(o.retries ?? d.retries ?? 0),
      services: ctx.services,
      resultsFile,
      traceMode: 'failures',
      onTrace: (trace) => void store.saveTrace(trace, 'test', runId),
      environment: o.environment,
      onEvent: (e: RunEvent) => {
        if (e.type === 'test-end' && (!o.quiet || cli.jsonl)) printResult(e.result, !!o.verbose);
      },
      },
      plan?.capUsd,
    );
    guard = capped.guard;
    summary = await runTests(capped.options);
  } finally {
    await ctx.dispose();
  }
  // a run stopped at its cap is not a cancelled one: it says how far it got and fails, so a pipeline never passes on part of the cases
  const stopped = guard?.stopped ? guard.message(est?.cases ?? summary.total) : '';
  if (stopped) {
    summary = { ...summary, cancelled: false };
    console.error(stopped);
  }
  // the last good run: this run when every case passed (kept after it was compared with the one before)
  if (lastGood && !stopped && summary.failed + summary.errors === 0 && !summary.cancelled) o.saveBaseline = lastGood;
  const code = await finishRun({ store, summary, outDir, resultsFile, o, emptyMessage: 'The evaluation has no dataset records.' });
  return stopped && code === EXIT.SUCCESS ? EXIT.TEST_FAILURE : code;
}
