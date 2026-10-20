/**
 * `testpion security generate|run` (AI-8): OWASP API security tests for a collection or folder, as a test file with
 * deterministic verdicts. `generate` proposes the file (the model chooses what to probe; TestPion writes the steps from the
 * saved requests and a fixed catalogue; nothing is written until `--apply`); `run` runs a generated file one step at a
 * time, paced, in a test environment and prints the verdicts, findings first. Both refuse an environment marked as
 * production unless `--allow-production`.
 */
import type { Command } from 'commander';
import { draftSecurityProposal, flowSourceRef, productionAllowed, runSecurityTests, securityReportMarkdown, SECURITY_PROBES } from '@testpion/core';
import { bold, cliContext, dim, EXIT, green, printJson, red, withWorkspace, yellow } from '../shared.js';
import { machine } from '../output.js';
import { proposeCommand } from './ai-propose.js';

const list = (v: string | undefined): string[] | undefined => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);

export function registerAiSecurityCommands(program: Command): void {
  const security = program.command('security').description('OWASP API security tests with deterministic verdicts: generate them for a collection, run them against a test environment');
  security
    .command('generate')
    .description(
      "security tests for a collection or folder as one test file: BOLA (a second user repeats the owner's request and must be refused and must not see their data), broken authentication (no credentials, an invalid token), mass assignment (privileged fields added to a body) and function-level authorization (a lower-privilege user calls an admin function). The model chooses what to probe; TestPion writes the steps from the saved requests and a fixed catalogue, and every verdict is a check computed from the responses. Safe by design: read-only unless --include-write / --include-delete, paced, capped, a production environment is refused. Nothing is written until --apply (or testpion ai apply <id>)",
    )
    .requiredOption('--collection <nameOrId>', 'the collection')
    .option('--folder <nameOrPath>', 'one folder of it (a name, a path such as Orders/Refunds, or an id)')
    .option('--identities <list>', `the variables that hold the credentials of the two principals: owner=tokenA,other=tokenB (names only; the owner is the user the saved requests were written for)`)
    .option('--probes <list>', `probe kinds, comma separated (default all): ${SECURITY_PROBES.join(', ')}`)
    .option('--include-write', 'also probe POST / PUT / PATCH requests (they change data; mass assignment needs them)')
    .option('--include-delete', 'also probe DELETE requests (they destroy data)')
    .option('--rate <n>', 'requests a second (the file’s pace)', (v) => Number(v))
    .option('--max <n>', 'most probes in the file', (v) => Number(v))
    .option('--hint <text>', 'an extra instruction for the model, e.g. "orders belong to the user of tokenA"')
    .option('--privacy <level>', 'full (redacted, default) | metadata | names')
    .option('--path <file>', 'the test file to propose, under tests/ (default tests/security/<collection>.yaml)')
    .option('--provider <id>', 'provider id or name (default: TESTPION_AI_PROVIDER, then the app settings)')
    .option('--model <name>', 'model name (default: TESTPION_AI_MODEL[_LARGE], then the app settings)')
    .option('--no-ai', 'only the probes TestPion makes itself (no model is called)')
    .option('--dry-run', 'send nothing: print what would be sent (messages, sections, tokens, cost, what was masked)')
    .option('--apply', 'write the file if its verification did not fail (else it stays a proposal)')
    .option('-e, --environment <name>', 'the test environment the tests are for (its variable names, never values, are known to the model); a production one is refused')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--json', 'print { proposal, usage, applied } as JSON (for scripts and AI agents)')
    .action(
      async (o: {
        collection: string;
        folder?: string;
        identities?: string;
        probes?: string;
        includeWrite?: boolean;
        includeDelete?: boolean;
        rate?: number;
        max?: number;
        hint?: string;
        privacy?: string;
        path?: string;
        provider?: string;
        model?: string;
        ai?: boolean;
        dryRun?: boolean;
        apply?: boolean;
        environment?: string;
        workspace?: string;
        json?: boolean;
      }) =>
        withWorkspace(o.workspace, async (store) => {
          const item = flowSourceRef(store, { collection: o.collection, folder: o.folder });
          const options = {
            probes: list(o.probes),
            identities: o.identities,
            includeWrite: o.includeWrite === true,
            includeDelete: o.includeDelete === true,
            rate: o.rate,
            max: o.max,
            environment: o.environment,
            // --allow-production is the process default of the sending commands (index.ts)
            allowProduction: productionAllowed(),
          };
          const ctx = cliContext(store, o.environment);
          try {
            await proposeCommand({
              store,
              ctx,
              json: !!o.json || machine(),
              task: 'security-tests',
              item,
              context: { options },
              hint: o.hint,
              privacy: o.privacy,
              path: o.path,
              provider: o.provider,
              model: o.model,
              ai: o.ai,
              dryRun: o.dryRun,
              apply: o.apply,
              draft: (reason) => draftSecurityProposal(store, item, { options, path: o.path, surface: process.env.CI ? 'ci' : 'cli', reason }),
              appliedHint: (p) => `run it: testpion security run ${p.items[0]?.path ? `tests/${p.items[0].path}` : 'tests/security/…'} -e <test environment>`,
              show: (p) => {
                const steps = (p.items[0]?.data as { security?: { probes?: number } } | undefined)?.security?.probes ?? 0;
                console.log(bold(`${steps} probes`) + dim(` · ${p.items[0]?.path ? `tests/${p.items[0].path}` : ''}`));
                if (p.summary) console.log(green(`  ${p.summary}`));
              },
            });
          } finally {
            await ctx.dispose();
          }
        }),
    );

  security
    .command('run')
    .description(
      'run a generated security test file in a test environment and judge it: one step at a time, paced by the file, a verdict per step — finding (the API accepted what it must refuse), pass, or inconclusive (the owner’s setup failed, so nothing was proven). A production environment is refused unless --allow-production. Exit code 1 when there is a finding',
    )
    .argument('<file>', 'the generated file under tests/, e.g. security/clinic.yaml')
    .requiredOption('-e, --environment <name>', 'the test environment to run in')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--json', 'print the report as JSON (for scripts and AI agents)')
    .action(async (file: string, o: { environment: string; workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, async (store) => {
        const report = await runSecurityTests({
          store,
          path: file,
          environment: o.environment,
          allowProduction: productionAllowed(),
          servicesFor: async (environment) => {
            const ctx = cliContext(store, environment);
            return { services: ctx.services, dispose: () => ctx.dispose() };
          },
        });
        if (report.summary.findings > 0) process.exitCode = EXIT.TEST_FAILURE;
        if (o.json || machine()) return printJson(report);
        console.log(securityReportMarkdown(report));
        console.log(
          report.summary.findings
            ? red(`\n${report.summary.findings} finding${report.summary.findings === 1 ? '' : 's'}: the API accepted what it must refuse.`)
            : report.summary.inconclusive
              ? yellow(`\nNo finding, but ${report.summary.inconclusive} step${report.summary.inconclusive === 1 ? '' : 's'} proved nothing (a setup request failed).`)
              : green('\nNo finding.'),
        );
      }),
    );
}
