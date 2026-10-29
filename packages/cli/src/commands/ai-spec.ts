/**
 * `testpion generate gaps|tests --spec <file>` (AI-4): what the tests of an API definition never prove, and tests that
 * close the gaps — positive, negative, boundary and security cases. The gap report is deterministic (no model, no key);
 * `generate tests` builds the deterministic cases itself and, with a model set up, adds the model's case ideas. The
 * result is a verified proposal: nothing is written until `--apply` (or `testpion ai apply <id>`).
 */
import type { Command } from 'commander';
import { analyseSpec, draftSpecTestsProposal, specGapMarkdown, SPEC_CATEGORIES, workspaceSpecGaps, type SpecCategory } from '@testpion/core';
import { bold, cliContext, CliError, dim, EXIT, green, printJson, withWorkspace, WORKSPACE_OPTION } from '../shared.js';
import { machine } from '../output.js';
import { proposeCommand } from './ai-propose.js';

const list = (v: string | undefined): string[] | undefined => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);

function categories(v: string | undefined): SpecCategory[] | undefined {
  const l = list(v);
  if (!l) return undefined;
  const bad = l.filter((c) => !(SPEC_CATEGORIES as readonly string[]).includes(c));
  if (bad.length) throw new CliError(`Unknown category ${bad.join(', ')}: use ${SPEC_CATEGORIES.join(', ')}`, EXIT.CONFIG_ERROR);
  return l as SpecCategory[];
}

export function registerAiSpecCommands(program: Command): void {
  const generate = program.command('generate').description('generate tests from an API definition: the gaps in what is tested, and tests that close them');
  generate
    .command('gaps')
    .description('what the tests and collections of the workspace never prove about an API definition: operations never called, documented statuses never asserted, no negative, boundary or security test, no contract check, parameters never sent (deterministic: no AI, no key)')
    .requiredOption('--spec <file>', 'the API definition in the workspace, e.g. specs/clinic.yaml')
    .option(...WORKSPACE_OPTION)
    .option('--json', 'print the report as JSON (for scripts and AI agents)')
    .action((o: { spec: string; workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, (store) => {
        const spec = o.spec.replace(/\\/g, '/');
        const report = workspaceSpecGaps(store, spec);
        const { local } = analyseSpec(store, spec);
        const draft = { tests: local.draft.length, operations: new Set(local.draft.map((c) => c.operation)).size };
        if (o.json || machine()) return printJson({ report, draft });
        console.log(specGapMarkdown(report));
        console.log(dim(`TestPion can build ${draft.tests} tests for ${draft.operations} operations from the document without a model: testpion generate tests --spec ${spec} --no-ai`));
      }),
    );
  generate
    .command('tests')
    .description(
      'tests for the gaps in the tests of an API definition: positive (the documented example, its status, the OpenAPI contract, a shallow JSON Schema), negative (invalid input → 4xx, an unknown id → 404), boundary (a value at and beyond a documented limit) and security (no credentials → 401/403) — TestPion builds those from the document; a configured model adds more ideas, which are built from the document too (an operation the document does not have is dropped). Every test is validated against the document and the proposal says the coverage before → after. Nothing is written until --apply (or testpion ai apply <id>)',
    )
    .requiredOption('--spec <file>', 'the API definition in the workspace, e.g. specs/clinic.yaml')
    .option('--category <list>', `categories, comma separated (default all): ${SPEC_CATEGORIES.join(', ')}`)
    .option('--operation <list>', 'only these operations, comma separated: "POST /patients" or an operationId (default: every operation with a gap)')
    .option('--gaps-only', 'only what the gaps need (the default)')
    .option('--no-gaps-only', 'every category for every operation, not only what the gaps need')
    .option('--include-delete', 'also test DELETE operations (they destroy data)')
    .option('--hint <text>', 'an extra instruction for the model, e.g. "orders cannot exceed 10 items"')
    .option('--privacy <level>', 'full (redacted, default) | metadata | names')
    .option('--path <file>', 'put all the tests in this file under tests/ (default tests/<api>/<tag>-gaps.yaml, free names)')
    .option('--provider <id>', 'provider id or name (default: TESTPION_AI_PROVIDER, then the app settings)')
    .option('--model <name>', 'model name (default: TESTPION_AI_MODEL[_LARGE], then the app settings)')
    .option('--ai', 'add the configured model’s ideas (the default when a model is set up)')
    .option('--no-ai', 'only the deterministic cases (no model is called)')
    .option('--dry-run', 'send nothing: print what would be sent (messages, sections, tokens, cost, what was masked)')
    .option('--apply', 'write the files whose verification did not fail (else they stay a proposal)')
    .option('-e, --environment <name>', 'environment whose variable names (never values) the model may know')
    .option(...WORKSPACE_OPTION)
    .option('--json', 'print { proposal, usage, applied } as JSON (for scripts and AI agents)')
    .action(
      async (o: {
        spec: string;
        category?: string;
        operation?: string;
        gapsOnly?: boolean;
        includeDelete?: boolean;
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
          const spec = o.spec.replace(/\\/g, '/');
          const options = { categories: categories(o.category), operations: list(o.operation), gapsOnly: o.gapsOnly !== false, includeDelete: o.includeDelete === true };
          const ctx = cliContext(store, o.environment);
          try {
            await proposeCommand({
              store,
              ctx,
              json: !!o.json || machine(),
              task: 'tests-from-spec',
              item: { kind: 'spec', path: spec },
              context: { options },
              hint: o.hint,
              privacy: o.privacy,
              path: o.path,
              provider: o.provider,
              model: o.model,
              ai: o.ai,
              dryRun: o.dryRun,
              apply: o.apply,
              draft: (reason, services) => draftSpecTestsProposal(store, spec, { ...options, path: o.path, surface: process.env.CI ? 'ci' : 'cli', reason, services }),
              appliedHint: (p) => `run them: testpion test ${p.items[0]?.path ? `tests/${p.items[0].path}` : 'tests/…'} -e <environment>`,
              show: (p) => {
                const count = p.items.reduce((n, i) => n + ((i.data as { tests?: number } | undefined)?.tests ?? 0), 0);
                console.log(bold(`${count} tests in ${p.items.length} file${p.items.length === 1 ? '' : 's'}`) + dim(` · ${spec}`));
                if (p.summary) console.log(green(`  ${p.summary}`));
              },
            });
          } finally {
            await ctx.dispose();
          }
        }),
    );
}
