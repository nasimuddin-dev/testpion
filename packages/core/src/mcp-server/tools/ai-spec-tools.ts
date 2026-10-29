/**
 * MCP tools for AI-4 and AI-10 with TestPion's configured model: `spec_gaps` (what the tests never prove about an API
 * definition; deterministic, no model), `spec_tests_generate` (tests that close the gaps: positive, negative, boundary,
 * security; TestPion's own cases plus the model's, verified against the document) and `tidy_import` (the clean-up of a
 * fresh import: names, folders, hosts and tokens as variables, chained ids, tracking requests dropped). They only
 * propose: `ai_apply_proposal` applies, after the user agrees. Without a model the deterministic proposal is returned.
 */
import { flowSourceRef } from '../../ai/flow-from-collection.js';
import { analyseSpec, draftSpecTestsProposal } from '../../ai/spec-tests.js';
import { draftTidyProposal } from '../../ai/tidy-import.js';
import { ApsError } from '../../errors.js';
import type { AppSettings } from '../../model/types.js';
import { SPEC_CATEGORIES, specGapMarkdown, workspaceSpecGaps } from '../../openapi/spec-gaps.js';
import type { SecretStore } from '../../storage/secrets.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { createProposer, PRIVACY, strings } from './ai-propose.js';
import { str, type Tool } from '../tool.js';

export function aiSpecTools({ store, secrets, settings }: { store: WorkspaceStore; secrets: SecretStore; settings: AppSettings }): Tool[] {
  const specArg = (a: Record<string, unknown>) => {
    const spec = String(a.spec ?? '').replace(/\\/g, '/');
    if (!spec) throw new ApsError('ValidationError', 'spec is required: an API definition of the workspace (specs/clinic.yaml; openapi_outline lists them)');
    return spec;
  };
  /** Run a task with the configured model; without one, TestPion's own proposal (with the reason). */
  const propose = createProposer({ store, secrets, settings });
  return [
    {
      name: 'spec_gaps',
      description:
        "What the workspace's tests and collections never prove about an API definition (deterministic: no model, no key): per operation, is it called, which documented statuses are asserted, is there a negative, a boundary and a security test, is the response checked against the document, which parameters are never sent; the open gaps and coverage in percent; how many tests TestPion could build for the gaps without a model.",
      inputSchema: { type: 'object', properties: { spec: str('The API definition in the workspace, e.g. specs/clinic.yaml'), format: { type: 'string', enum: ['json', 'markdown'], description: 'json (default) or a Markdown report' } }, required: ['spec'] },
      run: (a) => {
        const spec = specArg(a);
        const report = workspaceSpecGaps(store, spec);
        const { local } = analyseSpec(store, spec);
        const draft = { tests: local.draft.length, operations: new Set(local.draft.map((c) => c.operation)).size };
        return a.format === 'markdown' ? { markdown: specGapMarkdown(report), draft } : { report, draft, next: 'spec_tests_generate { spec } proposes tests for these gaps (noAi: true for TestPion’s own cases only).' };
      },
    },
    {
      name: 'spec_tests_generate',
      description:
        "Tests that close the gaps in the tests of an API definition, as a proposal: positive (documented example, status, OpenAPI contract, shallow JSON Schema), negative (invalid input → 4xx, unknown id → 404), boundary (a value at and beyond a documented limit) and security (no credentials → 401/403). TestPion builds those from the document; with its configured model (the user's key or a local model) it adds ideas built from the valid example too (an operation the document lacks is dropped and reported; an undocumented status becomes its class). Every test is validated against the document and the proposal says the coverage before → after. Nothing is written: apply with ai_apply_proposal after the user agrees. Without a model the deterministic cases are the proposal (with a note). `dryRun` returns what would be sent (operations, limits, gaps; no secrets) with the token and cost estimate.",
      inputSchema: {
        type: 'object',
        properties: {
          spec: str('The API definition in the workspace, e.g. specs/clinic.yaml'),
          categories: { type: 'array', items: { type: 'string', enum: [...SPEC_CATEGORIES] }, description: 'Default: all four' },
          operations: { type: 'array', items: { type: 'string' }, description: 'Only these: "POST /patients" or an operationId (default: every operation with a gap)' },
          gapsOnly: { type: 'boolean', description: 'Only what the gaps need (default true); false: every category for every operation' },
          includeDelete: { type: 'boolean', description: 'Also DELETE operations (they destroy data; default false)' },
          hint: str('An extra instruction for the model, e.g. "an order holds at most 10 items"'),
          privacy: PRIVACY,
          path: str('Put all the tests in this file under tests/ (default tests/<api>/<tag>-gaps.yaml)'),
          environment: str('Environment whose variable names (never values) the model may know'),
          noAi: { type: 'boolean', description: 'Only the deterministic cases (no model is called)' },
          dryRun: { type: 'boolean', description: 'Send nothing: return what would be sent and the estimate' },
        },
        required: ['spec'],
      },
      run: (a) => {
        const spec = specArg(a);
        const options = { categories: strings(a.categories) as never, operations: strings(a.operations), gapsOnly: a.gapsOnly !== false, includeDelete: a.includeDelete === true };
        return propose({
          task: 'tests-from-spec',
          item: { kind: 'spec', path: spec },
          context: { options },
          a,
          draft: (reason, services) => draftSpecTestsProposal(store, spec, { ...options, path: a.path ? String(a.path) : undefined, surface: 'mcp', reason, services }),
          next: (p) => `Show the user the files (proposal.items[].after), the tests per category, the coverage before → after (proposal.summary), the notes and the verification; apply with ai_apply_proposal { id: "${p.id}" } after they agree, then run them (run_tests).`,
        });
      },
    },
    {
      name: 'tidy_import',
      description:
        "Tidy a freshly imported collection (Postman, curl, HAR, Insomnia, Bruno), as a proposal of separate reviewable changes: names and folders, a host typed into many URLs and a repeated token as collection variables, a hard-coded id that an earlier response returns chained (a tp.* script sets the variable; confirmed against the saved example when there is one), tracking, static and duplicate requests dropped, optionally a flow wiring the requests. TestPion finds the hosts, tokens, noise, duplicates and confirmed chains itself; TestPion's configured model names and groups (the model's drops and unconfirmed chains are unticked: opt in). Every change is verified: the result is a valid collection and every remaining request sends exactly what it sent before, variables resolved. Nothing is written: apply with ai_apply_proposal (ai_undo_proposal puts the collection back). Without a model the findings are the proposal.",
      inputSchema: {
        type: 'object',
        properties: {
          collection: str('The collection: its name or id (list_collections)'),
          flow: { type: 'boolean', description: 'Also propose a flow that wires the requests' },
          source: str('Where it came from: har, postman, curl, insomnia, bruno (context for the model)'),
          hint: str('An extra instruction, e.g. "group by resource"'),
          privacy: PRIVACY,
          environment: str('Environment whose variable names (never values) the model may know'),
          noAi: { type: 'boolean', description: 'Only what TestPion finds itself (no model is called)' },
          dryRun: { type: 'boolean', description: 'Send nothing: return what would be sent and the estimate' },
        },
        required: ['collection'],
      },
      run: (a) => {
        const item = flowSourceRef(store, { collection: String(a.collection) });
        const source = a.source ? String(a.source) : undefined;
        return propose({
          task: 'tidy-import',
          item,
          context: { options: { flow: a.flow === true, ...(source ? { source } : {}) } },
          a,
          draft: (reason) => draftTidyProposal(store, item, { surface: 'mcp', reason, source }),
          next: (p) => `Show the user each change (proposal.items[].title, before/after, verification); apply the ticked ones with ai_apply_proposal { id: "${p.id}", items: [...] } after they agree; ai_undo_proposal puts the collection back.`,
        });
      },
    },
  ];
}

/**
 * `generate_tests` with `ai: true` (AI-4): the same proposal as `spec_tests_generate` (gap-driven positive / negative /
 * boundary / security tests, the model's ideas built from the document, verified, nothing written until
 * `ai_apply_proposal`); without it the tool writes the first suite as it always did. One name for an agent that thinks of "generate tests".
 */
export function generateTestsWithAi(tools: Tool[]): Tool[] {
  const gen = tools.find((t) => t.name === 'generate_tests');
  const ai = tools.find((t) => t.name === 'spec_tests_generate');
  if (!gen || !ai) return tools;
  const p = ai.inputSchema.properties;
  const wrapped: Tool = {
    ...gen,
    description: `${gen.description} With \`ai: true\` nothing is written: it proposes tests for the gaps in what is tested (positive, negative, boundary, security) built from the document with TestPion's configured model, validated against the document, with the coverage before → after; apply with ai_apply_proposal after the user agrees (the same as spec_tests_generate; \`gapsOnly\`, \`categories\`, \`operations\`, \`hint\`, \`privacy\`, \`dryRun\` and \`noAi\` apply).`,
    inputSchema: {
      ...gen.inputSchema,
      properties: {
        ...gen.inputSchema.properties,
        ai: { type: 'boolean', description: 'Propose gap-driven tests with the configured model instead of writing the first suite (nothing is written)' },
        categories: p.categories,
        operations: p.operations,
        gapsOnly: p.gapsOnly,
        hint: p.hint,
        privacy: p.privacy,
        path: p.path,
        environment: p.environment,
        noAi: p.noAi,
        dryRun: p.dryRun,
      },
    },
    run: (a) => (a.ai === true ? ai.run(a) : gen.run(a)),
  };
  return tools.map((t) => (t === gen ? wrapped : t));
}
