/**
 * `testpion openapi-drift --spec <file>` (AI-9): where real traffic (History, a HAR file, a run) differs from an OpenAPI
 * document — an endpoint, status or content type it lacks, a field the schema does not have, a type that differs, a
 * required field that is missing, a null it forbids, a value outside an enum. The report is deterministic (no model, no
 * key). `--ai` has the configured model explain each finding and choose the fix, as a proposal: a spec patch TestPion makes
 * from what was observed and a contract check, each verified against the same traffic; `--propose` offers TestPion's own
 * patches without a model. Nothing is written until `--apply` (or `testpion ai apply <id>`).
 */
import type { Command } from 'commander';
import { contractDrift, draftDriftProposal, driftMarkdown, sourceOf } from '@testpion/core';
import { bold, cliContext, dim, printJson, withWorkspace, WORKSPACE_OPTION } from '../shared.js';
import { machine } from '../output.js';
import { proposeCommand } from './ai-propose.js';

export function registerAiDriftCommand(program: Command): void {
  program
    .command('openapi-drift')
    .description(
      'compare an OpenAPI document with real traffic and report the drift: an endpoint, status or content type the document lacks, a field the schema does not have, a type that differs, a missing required field, a null the schema forbids, a value outside an enum — each with where, what the document says, what was seen and how often (deterministic: no AI, no key). --ai: the configured model explains each finding and proposes the fix (a spec patch made from what was observed, a contract check), verified against the same traffic',
    )
    .requiredOption('--spec <file>', 'the API definition in the workspace, e.g. specs/clinic.yaml')
    .option('--har <file>', 'a HAR file as the traffic (a saved Debugger session, a browser export)')
    .option('--run <id>', 'a run as the traffic (its id, or last): the responses its HTTP results stored')
    .option('--limit <n>', 'History: how many of the newest responses (default 300, most 2000)', (v) => Number(v))
    .option('--host <host>', 'History: only responses from this host (127.0.0.1:4010)')
    .option('--request <id>', 'History: only responses of this saved request')
    .option('--ai', 'have the model explain the findings and propose the fix (falls back to TestPion’s own patches without a model)')
    .option('--propose', 'TestPion’s own patches as a proposal, no model (additions are ticked)')
    .option('--hint <text>', 'with --ai: an extra instruction, e.g. "the nickname field is new in v2"')
    .option('--privacy <level>', 'with --ai: full (redacted, default) | metadata | names')
    .option('--provider <id>', 'with --ai: provider id or name (default: TESTPION_AI_PROVIDER, then the app settings)')
    .option('--model <name>', 'with --ai: model name (default: TESTPION_AI_MODEL[_LARGE], then the app settings)')
    .option('--dry-run', 'with --ai: send nothing, print what would be sent')
    .option('--apply', 'with --ai / --propose: write the patches whose verification did not fail (else they stay a proposal)')
    .option('-e, --environment <name>', 'with --ai: environment whose variable names (never values) the model may know')
    .option(...WORKSPACE_OPTION)
    .option('--json', 'print the report (or { proposal, … }) as JSON (for scripts and AI agents)')
    .action(
      async (o: {
        spec: string;
        har?: string;
        run?: string;
        limit?: number;
        host?: string;
        request?: string;
        ai?: boolean;
        propose?: boolean;
        hint?: string;
        privacy?: string;
        provider?: string;
        model?: string;
        dryRun?: boolean;
        apply?: boolean;
        environment?: string;
        workspace?: string;
        json?: boolean;
      }) =>
        withWorkspace(o.workspace, async (store) => {
          const spec = o.spec.replace(/\\/g, '/');
          const source = sourceOf({ har: o.har, runId: o.run, limit: o.limit, host: o.host, requestId: o.request });
          const json = !!o.json || machine();
          if (o.ai || o.propose) {
            const ctx = cliContext(store, o.environment);
            try {
              await proposeCommand({
                store,
                ctx,
                json,
                task: 'contract-drift',
                item: { kind: 'spec', path: spec },
                context: { options: { source } },
                hint: o.hint,
                privacy: o.privacy,
                provider: o.provider,
                model: o.model,
                ai: o.propose && !o.ai ? false : undefined,
                dryRun: o.dryRun,
                apply: o.apply,
                draft: (reason) => draftDriftProposal(store, spec, source, { surface: process.env.CI ? 'ci' : 'cli', reason }),
                appliedHint: () => `restore: testpion ai undo <id>`,
                show: (p) => console.log(bold(`${p.findings?.length ?? 0} findings`) + dim(` · ${spec}`)),
              });
            } finally {
              await ctx.dispose();
            }
            return;
          }
          const report = await contractDrift(store, spec, source);
          if (json) return printJson(report);
          console.log(driftMarkdown(report, spec));
          if (report.findings.length) console.log(dim(`\n${report.patchable} of them can be patched from what was observed: testpion openapi-drift --spec ${spec} --ai (explain and propose) · --propose (TestPion's own patches)`));
        }),
    );
}
