/**
 * `testpion ai triage` (AI-2) and `testpion ai attempt-fix` (AI-5): a failed run's failures grouped by cause and — with
 * a model — explained with verified fixes as a proposal (nothing is written until `--apply` or `testpion ai apply`);
 * and a flaky-test analysis's fix applied, then the test run again N times for a stability verdict. The flaky analysis
 * itself is the generic task: `testpion ai run analyze-flaky --item test:<path>`.
 */
import type { Command } from 'commander';
import { formatUsd, plural } from '@testpion/shared';
import { aiRunDeps, applyProposal, attemptFix, rerunCommand, triageMarkdown, triageRun, WorkspaceManager, type AiTaskResult } from '@testpion/core';
import { bold, cliContext, dim, green, printJson, red, withWorkspace, yellow } from '../shared.js';
import { machine } from '../output.js';
import { printPreview, printProposal } from './ai-print.js';

const surface = () => (process.env.CI ? 'ci' : 'cli') as 'ci' | 'cli';

export function registerAiTriageCommands(ai: Command): void {
  ai.command('triage')
    .description(
      "explain and fix a failed run's failures with AI: grouped by likely cause (one cause may explain many: an expired token behind 12 failures), each with evidence (the failing request and response, the failed check, what changed since the last passing run), a confidence and a fix verified against the failing and the last passing response — proposed, never applied until --apply (or testpion ai apply <id>); without a model, the grouping with likely causes",
    )
    .option('--run <id>', 'the run: its id, or last (the newest finished run with failures)', 'last')
    .option('--privacy <level>', 'full (redacted, default) | metadata (statuses, checks, endpoints and shapes; no body values, no failure messages) | names')
    .option('--hint <text>', 'an extra instruction, e.g. "the token was rotated yesterday"')
    .option('--provider <id>', 'provider id or name (default: TESTPION_AI_PROVIDER, then the app settings)')
    .option('--model <name>', 'model name (default: TESTPION_AI_MODEL[_LARGE], then the app settings)')
    .option('--no-ai', 'group the failures and name the likely causes without a model')
    .option('--dry-run', 'send nothing: the grouping, and what would be sent (messages, sections, tokens, cost, what was masked)')
    .option('--apply', 'apply the fixes whose verification did not fail (else they stay a proposal)')
    .option('--items <ids>', 'with --apply: the items to apply, comma-separated (i1,i3)')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--json', 'print { runId, groups, findings, proposal, applied } as JSON (for scripts and AI agents)')
    .action(
      (o: { run: string; privacy?: string; hint?: string; provider?: string; model?: string; ai?: boolean; dryRun?: boolean; apply?: boolean; items?: string; workspace?: string; json?: boolean }) =>
        withWorkspace(o.workspace, async (store) => {
          const runCtx = cliContext(store);
          try {
            const t = await triageRun(aiRunDeps({ ctx: runCtx, settings: new WorkspaceManager().loadSettings(), store, surface: surface(), env: process.env }), {
              runId: o.run,
              privacy: o.privacy,
              hint: o.hint,
              provider: o.provider,
              model: o.model,
              dryRun: o.dryRun,
              noAi: o.ai === false,
            });
            const items = o.items
              ?.split(',')
              .map((x) => x.trim())
              .filter(Boolean);
            const applied =
              o.apply && t.proposal && t.proposal.items.some((i) => i.kind !== 'text' && (items ? items.includes(i.id) : i.selected)) ? applyProposal(store, t.proposal.id, { items }) : undefined;
            const rerun = rerunCommand(t);
            if (o.json || machine())
              return printJson({
                ...t,
                ...(applied ? { applied, rerun } : o.apply ? { applied: null, why: 'no fix was ticked (none, or their verification failed): review them, then testpion ai apply <id> --items …' } : {}),
              });
            if (t.dryRun) {
              console.log(triageMarkdown(t));
              return printPreview({ preview: t.preview } as unknown as AiTaskResult);
            }
            console.log(triageMarkdown(t).trimEnd());
            if (t.proposal) printProposal(t.proposal, { applied: !!applied, findings: false });
            if (t.usage)
              console.log(
                dim(
                  `${t.model} · ${t.usage.inputTokens.toLocaleString('en-US')} in / ${t.usage.outputTokens.toLocaleString('en-US')} out${t.costUsd !== undefined ? ` · ${formatUsd(t.costUsd)}` : ''}${t.repairs ? ` · ${plural(t.repairs, 'repair')}` : ''}`,
                ),
              );
            if (applied) console.log(green(`\nApplied ${plural(applied.applied.length, 'fix', 'fixes')}`) + dim(` · rerun the affected tests: ${rerun} · undo: testpion ai undo ${t.proposal!.id}`));
            else if (o.apply) console.log(yellow('\nNothing applied: no fix was ticked. Review them, then testpion ai apply <id> --items …'));
          } finally {
            await runCtx.dispose();
          }
        }),
    );

  ai.command('attempt-fix')
    .description(
      "a flaky-test analysis's fix (testpion ai run analyze-flaky --item …): apply it (the ticked items, or --items) and run the test again --times times (default 5) for a stability verdict, kept with the proposal; undo with testpion ai undo <id>",
    )
    .argument('<proposalId>', 'the analyze-flaky proposal')
    .option('--times <n>', 'how often to run the test (1–20, default 5)', (v) => Number(v))
    .option('--items <ids>', 'the items to apply, comma-separated (i1,i3)')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--json', 'print { attempt, applied } as JSON (for scripts and AI agents)')
    .action((id: string, o: { times?: number; items?: string; workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, async (store) => {
        const r = await attemptFix({
          store,
          proposalId: id,
          times: o.times,
          items: o.items
            ?.split(',')
            .map((x) => x.trim())
            .filter(Boolean),
          servicesFor: async (environment) => {
            const ctx = cliContext(store, environment);
            return { services: ctx.services, dispose: () => ctx.dispose() };
          },
        });
        if (o.json || machine()) return printJson({ attempt: r.attempt, ...(r.applied ? { applied: r.applied } : {}), proposal: r.proposal.id });
        const a = r.attempt;
        const line = `passed ${a.passed}/${a.runs}`;
        console.log(a.verdict === 'stable' ? green(bold(`Stable: ${line}`)) : a.verdict === 'flaky' ? yellow(bold(`Still flaky: ${line}`)) : red(bold(`Failing: ${line}`)));
        for (const f of a.failures ?? []) console.log(dim(`  ${f}`));
        if (a.verdict !== 'stable') console.log(dim(`Undo the change: testpion ai undo ${id}`));
      }),
    );
}
