/** `testpion eval sample|estimate|check`: the first run without a key, what a run costs before it starts, and one check tried on one case. */
import type { Command } from 'commander';
import { WorkspaceManager, ensureSample, estimateEvaluation, findSavedEvaluation, formatEstimateUsd, spendPlan, tryEvalCheck, SAMPLE_NAME, type CheckConfig } from '@testpion/core';
import { EXIT, bold, dim, green, red, CliError, printJson, openWorkspace, withWorkspace, cliContext, requireEnvironment, WORKSPACE_OPTION } from '../shared.js';
import type { EvalRunOptions } from './evaluations.js';

type RunEval = (ref: string, o: Omit<EvalRunOptions, 'reporter'> & { reporter?: string[] }) => Promise<number>;

function openForEval(workspace: string | undefined) {
  const { store, ephemeral } = openWorkspace(workspace, undefined, new WorkspaceManager());
  if (ephemeral) {
    store.close();
    throw new CliError('No workspace found: run inside a workspace or pass -w <nameOrPath>', EXIT.CONFIG_ERROR);
  }
  return store;
}

export function registerEvalQualityCommands(ev: Command, runEval: RunEval): void {
  ev.command('sample')
    .description('make the sample evaluation (10 support messages, the offline demo model, no key) and run it: the first result in one command')
    .option(...WORKSPACE_OPTION)
    .option('--no-run', 'only make the sample evaluation, do not run it')
    .option('-o, --out <dir>', 'output directory for results and reports')
    .option('-q, --quiet', 'only print the summary')
    .option('--json', 'print as JSON (for scripts and AI agents)')
    .action(async (o: { workspace?: string; run?: boolean; out?: string; quiet?: boolean; json?: boolean }) => {
      const store = openForEval(o.workspace);
      let made: ReturnType<typeof ensureSample>;
      try {
        made = ensureSample(store);
      } finally {
        store.close();
      }
      if (o.run === false) {
        if (o.json) return printJson({ evaluation: made.evaluation.name, id: made.evaluation.id, created: made.created, providerAdded: made.providerAdded, cases: 10, model: 'Offline demo model' });
        return console.log(`${bold(made.evaluation.name)} ${dim(made.created ? 'made' : 'reset')}: 10 cases, the offline demo model. Run it with: testpion eval run "${SAMPLE_NAME}"`);
      }
      if (!o.quiet && !o.json) console.log(dim('Offline demo model: its answers come from rules, so use this to try things out, not to judge a real model.'));
      process.exitCode = await runEval(SAMPLE_NAME, { workspace: o.workspace, out: o.out, quiet: o.quiet, reporter: o.json ? ['json'] : ['console', 'json', 'html'] });
    });

  ev.command('estimate')
    .description('what a saved evaluation would cost before it runs: cases, calls, tokens, dollars, seconds, and the spend cap and whether a run would ask first')
    .argument('<name>', 'saved evaluation name or id')
    .option(...WORKSPACE_OPTION)
    .option('-e, --environment <name>', 'environment to use')
    .option('--limit <n>', 'only the first n cases')
    .option('--max-cost <usd>', 'the cap to plan with (default $1.00 for a paid model; 0 = none)')
    .option('--json', 'print as JSON (for scripts and AI agents)')
    .action((ref: string, o: { workspace?: string; environment?: string; limit?: string; maxCost?: string; json?: boolean }) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        if (ephemeral) throw new CliError('No workspace found: run inside a workspace or pass -w <nameOrPath>', EXIT.CONFIG_ERROR);
        const d = findSavedEvaluation(store, ref);
        if (d.type === 'rag') throw new CliError('This is an evaluation of a bot with sources: use `testpion rag run --estimate`', EXIT.CONFIG_ERROR);
        if (o.environment) requireEnvironment(store, o.environment);
        const ctx = cliContext(store, o.environment);
        try {
          const est = estimateEvaluation(ctx.services, { ...d, limit: o.limit ? Number(o.limit) : d.limit });
          const plan = spendPlan(est, o.maxCost !== undefined ? Number(o.maxCost) : d.maxCostUsd);
          if (o.json) return printJson({ ...est, plan });
          console.log(`${bold(d.name)}: ${est.summary}`);
          console.log(dim(`${est.calls} calls · about ${est.inputTokens} tokens in / ${est.outputTokens} out · ${est.provider}${est.model ? `/${est.model}` : ''}`));
          if (plan.capUsd !== undefined) console.log(dim(`stops at ${formatEstimateUsd(plan.capUsd)}${plan.ask ? ' · asks first (use --yes to run)' : ''}`));
          if (plan.reason) console.log(plan.reason);
        } finally {
          await ctx.dispose();
        }
      }),
    );

  ev.command('check')
    .description('try one check on one case of a saved evaluation: the case goes to the model, the check is applied to the reply, and you see the reply, passed or failed, and why')
    .argument('<name>', 'saved evaluation name or id')
    .option(...WORKSPACE_OPTION)
    .option('-e, --environment <name>', 'environment to use')
    .option('--check <json>', 'the check as JSON, e.g. \'{"type":"contains","expected":"refill"}\'')
    .option('--type <type>', 'the check type (contains, exact-match, regex, is-json, llm-judge …) instead of --check')
    .option('--expected <value>', 'with --type: the expected value ({{expected}} is the case’s expected answer)')
    .option('--path <jsonpath>', 'with --type: where in the reply to look')
    .option('--criteria <text>', 'with --type llm-judge: the rule the AI reviewer grades by')
    .option('--case <n>', 'which case, counting from 1', '1')
    .option('--dry-run', 'say what would be sent and what it costs; send nothing')
    .option('--yes', 'go ahead although this sends the case to a paid model')
    .option('--json', 'print as JSON (for scripts and AI agents)')
    .action((ref: string, o: { workspace?: string; environment?: string; check?: string; type?: string; expected?: string; path?: string; criteria?: string; case: string; dryRun?: boolean; yes?: boolean; json?: boolean }) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        if (ephemeral) throw new CliError('No workspace found: run inside a workspace or pass -w <nameOrPath>', EXIT.CONFIG_ERROR);
        const d = findSavedEvaluation(store, ref);
        let check: CheckConfig;
        try {
          check = o.check ? (JSON.parse(o.check) as CheckConfig) : o.type ? ({ type: o.type, ...(o.expected !== undefined ? { expected: o.expected } : {}), ...(o.path ? { path: o.path } : {}), ...(o.criteria ? { criteria: o.criteria } : {}) } as CheckConfig) : undefined!;
        } catch {
          throw new CliError('--check is not valid JSON', EXIT.CONFIG_ERROR);
        }
        if (!check?.type) throw new CliError('Give the check: --check \'{"type":"contains","expected":"x"}\' or --type contains --expected x', EXIT.CONFIG_ERROR);
        if (o.environment) requireEnvironment(store, o.environment);
        const ctx = cliContext(store, o.environment);
        try {
          const plan = await tryEvalCheck({ draft: d, check, caseNumber: Number(o.case), dryRun: true }, { services: ctx.services, store });
          if (o.dryRun) return o.json ? printJson(plan) : console.log(`Case ${plan.caseNumber} of ${plan.cases}: ${plan.estimate.summary}. Nothing was sent.`);
          if (!plan.estimate.free && !o.yes) throw new CliError(`This sends case ${plan.caseNumber} to ${d.provider}/${d.model || 'its default model'}${plan.estimate.costUsd !== undefined ? ` (about ${formatEstimateUsd(plan.estimate.costUsd)})` : ''}. Run again with --yes to go ahead.`, EXIT.CONFIG_ERROR);
          const r = await tryEvalCheck({ draft: d, check, caseNumber: Number(o.case) }, { services: ctx.services, store });
          if (r.passed === false || r.error) process.exitCode = EXIT.TEST_FAILURE;
          if (o.json) return printJson(r);
          console.log(`${bold(`Case ${r.caseNumber} of ${r.cases}`)} ${dim(JSON.stringify(r.input))}`);
          console.log(`reply: ${r.reply}`);
          console.log(r.error ? red(`error: ${r.error}`) : `${r.passed ? green('passed') : red('failed')}${r.reason ? `: ${r.reason}` : ''}`);
          if (r.costUsd) console.log(dim(`cost ${formatEstimateUsd(r.costUsd)}`));
        } finally {
          await ctx.dispose();
        }
      }),
    );
}
