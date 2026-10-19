/** `testpion eval list|run`: evaluations saved in the app (Evaluations ▸ Save), run by name locally or in CI. */
import { join } from 'node:path';
import { resolve } from 'node:path';
import { Command, Option } from 'commander';
import {
  WorkspaceManager,
  assertEvaluationRunnable,
  evaluationTests,
  findSavedEvaluation,
  listSavedEvaluations,
  runTests,
  shortId,
  type RunEvent,
  type RunSummary,
} from '@testpion/core';
import { EXIT, dim, bold, CliError, printJson, openWorkspace, withWorkspace, cliContext, requireEnvironment } from '../shared.js';
import { cli } from '../output.js';
import { finishRun, printResult } from '../run.js';
import { registerEvalCompareCommands } from './eval-compare.js';

export function registerEvaluationCommands(program: Command): void {
  const ev = program.command('eval').description('evaluations saved in the app (dataset × prompt × model × evaluators): list them, run one by name, compare runs (matrix, compare with a baseline)');
  ev.command('list')
    .description('list the saved evaluations of a workspace')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
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
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('-e, --environment <name>', 'environment to use')
    .option('-c, --concurrency <n>', 'parallel cases (default: the saved setting)')
    .option('--retries <n>', 'retries per failing case (default: the saved setting)')
    .option('--limit <n>', 'only the first n dataset records')
    .option('--judge <provider/model>', 'RAG evaluations: the judge model of the judged metrics (default: the evaluation’s, else TESTPION_AI_PROVIDER / the AI settings’ large model)')
    .option('--max-judge-cost <usd>', 'RAG evaluations: stop judging once this much (USD, from the price table) is spent; the rest is not scored')
    .addOption(new Option('-r, --reporter <formats...>', 'reporters: console, junit, json, html, markdown').default(['console', 'junit', 'json', 'html', 'markdown']))
    .option('-o, --out <dir>', 'output directory for results and reports')
    .option('--baseline <name>', 'compare results against a saved baseline')
    .option('--save-baseline <name>', 'save this run as a baseline')
    .option('--fail-on-regression', 'exit 1 when the baseline comparison finds regressions')
    .option('-v, --verbose', 'show passing checks')
    .option('-q, --quiet', 'only print the summary')
    .action(async (ref: string, o: { judge?: string; maxJudgeCost?: string; workspace?: string; environment?: string; concurrency?: string; retries?: string; limit?: string; reporter: string[]; out?: string; baseline?: string; saveBaseline?: string; failOnRegression?: boolean; verbose?: boolean; quiet?: boolean }) => {
      process.exitCode = await executeEvalRun(ref, o);
    });
  registerEvalCompareCommands(ev);
}

async function executeEvalRun(
  ref: string,
  o: { judge?: string; maxJudgeCost?: string; workspace?: string; environment?: string; concurrency?: string; retries?: string; limit?: string; reporter: string[]; out?: string; baseline?: string; saveBaseline?: string; failOnRegression?: boolean; verbose?: boolean; quiet?: boolean },
): Promise<number> {
  const { store, ephemeral } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
  if (ephemeral) throw new CliError('No workspace found: run inside a workspace or pass -w <nameOrPath>', EXIT.CONFIG_ERROR);
  let evaluation: ReturnType<typeof findSavedEvaluation>;
  try {
    evaluation = findSavedEvaluation(store, ref);
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
  const runId = shortId('run-');
  const outDir = o.out ? resolve(o.out) : store.runDir(runId);
  const resultsFile = join(outDir, 'results.jsonl');
  if (!o.quiet) {
    console.log(bold(`TestPion — ${d.name}`));
    console.log(dim(`evaluation · ${d.provider}${d.model ? `/${d.model}` : ''}${o.environment ? ` · environment: ${o.environment}` : ''} · run: ${runId}`));
  }
  let summary: RunSummary;
  try {
    summary = await runTests({
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
    });
  } finally {
    await ctx.dispose();
  }
  return finishRun({ store, summary, outDir, resultsFile, o, emptyMessage: 'The evaluation has no dataset records.' });
}
