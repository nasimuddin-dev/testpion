/**
 * MCP tools for AI-8 (security tests): `security_tests_generate` proposes a test file of OWASP API probes for a collection
 * or folder — the model chooses what to probe, TestPion writes the steps, the verdicts are checks the runner computes —
 * and `security_tests_run` runs such a file one step at a time, paced, and returns the verdicts (findings first). Both
 * refuse an environment marked as production unless the server was started with --allow-production and the call passes
 * allowProduction: true; nothing is written until `ai_apply_proposal`.
 */
import { flowSourceRef } from '../../ai/flow-from-collection.js';
import { draftSecurityProposal, SECURITY_PROBES } from '../../ai/security-tests.js';
import { runSecurityTests, securityReportMarkdown } from '../../ai/security-run.js';
import { createEngineContext } from '../../engine.js';
import { ApsError } from '../../errors.js';
import type { AppSettings } from '../../model/types.js';
import { productionAllowed } from '../../net/production-guard.js';
import type { SecretStore } from '../../storage/secrets.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { createProposer, PRIVACY, strings } from './ai-propose.js';
import { str, type Tool } from '../tool.js';

export function aiSecurityTools({
  store,
  secrets,
  settings,
  checkEnvironment = () => undefined,
}: {
  store: WorkspaceStore;
  secrets: SecretStore;
  settings: AppSettings;
  /** The server's own check of an environment (production only when the server allows it). */
  checkEnvironment?: (name: string | undefined) => unknown;
}): Tool[] {
  const propose = createProposer({ store, secrets, settings });
  return [
    {
      name: 'security_tests_generate',
      description:
        "OWASP API security tests for a collection or folder, as a proposal of one test file with deterministic verdicts: BOLA (a second user repeats the owner's request for the owner's object and must be refused and must not see their data), broken authentication (no credentials and an invalid token must be refused), mass assignment (privileged fields such as role or isAdmin added to a body must not come back) and function-level authorization (a lower-privilege user calls an admin function and must be refused). The model chooses which saved requests to probe and which variables hold the two principals' credentials (names, never values); TestPion writes every step from the saved requests and a fixed catalogue, and each verdict is a check the runner computes from the responses (a status that must be 401/403/404, a value that must not appear) — never an opinion of the model. Safe by design: GET/HEAD/OPTIONS only unless includeWrite / includeDelete are asked for, paced (rate requests a second), capped (max probes), refuses a production environment. Nothing runs and nothing is written: apply the proposal with ai_apply_proposal after the user agrees, then run it with security_tests_run against a test environment. Without a model TestPion's own probes are the proposal. `dryRun` returns what would be sent.",
      inputSchema: {
        type: 'object',
        properties: {
          collection: str('The collection: its name or id (list_collections)'),
          folder: str('One folder of it: its name, its path (Orders/Refunds) or its id'),
          identities: {
            description: 'The variables that hold the two principals’ credentials: {owner: "tokenA", other: "tokenB"} or "owner=tokenA,other=tokenB". The owner is the user the saved requests were written for. Names only, never the credentials.',
          },
          probes: { type: 'array', items: { type: 'string', enum: [...SECURITY_PROBES] }, description: 'Default: all four' },
          includeWrite: { type: 'boolean', description: 'Also probe POST / PUT / PATCH requests (they change data; mass assignment needs them). Default false' },
          includeDelete: { type: 'boolean', description: 'Also probe DELETE requests (they destroy data). Default false' },
          rate: { type: 'number', description: 'Requests a second (the file’s pace), default 4' },
          max: { type: 'number', description: 'Most probes in the file, default 40' },
          hint: str('An extra instruction for the model, e.g. "orders belong to the user of tokenA"'),
          privacy: PRIVACY,
          path: str('The test file to propose, under tests/ (default tests/security/<collection>.yaml)'),
          environment: str('The test environment the tests are for: its variable names (never values) are known to the model; a production environment is refused'),
          noAi: { type: 'boolean', description: 'Only the probes TestPion makes itself (no model is called)' },
          dryRun: { type: 'boolean', description: 'Send nothing: return what would be sent and the estimate' },
        },
        required: ['collection'],
      },
      run: (a) => {
        checkEnvironment(a.environment ? String(a.environment) : undefined);
        const item = flowSourceRef(store, { collection: String(a.collection), folder: a.folder ? String(a.folder) : undefined });
        const options = {
          probes: strings(a.probes),
          identities: a.identities,
          includeWrite: a.includeWrite === true,
          includeDelete: a.includeDelete === true,
          rate: typeof a.rate === 'number' ? a.rate : undefined,
          max: typeof a.max === 'number' ? a.max : undefined,
          environment: a.environment ? String(a.environment) : undefined,
          allowProduction: productionAllowed(),
        };
        return propose({
          task: 'security-tests',
          item,
          context: { options },
          a,
          draft: (reason) => draftSecurityProposal(store, item, { options, path: a.path ? String(a.path) : undefined, surface: 'mcp', reason }),
          next: (p) =>
            `Show the user the file (proposal.items[0].after), the probes per kind (proposal.summary), the notes (what was dropped or not probed) and the verification; apply it with ai_apply_proposal { id: "${p.id}" } after they agree, then run it with security_tests_run against a test environment.`,
        });
      },
    },
    {
      name: 'security_tests_run',
      write: true,
      description:
        "Run a generated security test file (security_tests_generate, applied) and judge it: one step at a time, paced by the file's own rate limit, in a test environment — a production environment is refused unless the server allows it and allowProduction is true. Every step's verdict is computed from its checks: a finding (the API accepted what it must refuse: the other user read the object, a request without credentials succeeded, a privileged field came back), pass, or inconclusive (the owner's setup request failed, so nothing was proven). Findings first, each with the checks that failed. Only files made by security_tests_generate run here; run_tests runs the others.",
      inputSchema: {
        type: 'object',
        properties: {
          path: str('The generated file under tests/, e.g. security/clinic.yaml'),
          environment: str('The test environment to run in (required)'),
          format: { type: 'string', enum: ['json', 'markdown'], description: 'json (default) or a Markdown report' },
        },
        required: ['path', 'environment'],
      },
      run: async (a) => {
        if (!a.environment) throw new ApsError('ValidationError', 'environment is required: security tests run against a test environment you may probe');
        const environment = String(a.environment);
        checkEnvironment(environment);
        const report = await runSecurityTests({
          store,
          path: String(a.path),
          environment,
          allowProduction: productionAllowed(),
          servicesFor: async (env) => {
            const ctx = createEngineContext({ store, secrets, settings, environment: env });
            return { services: ctx.services, dispose: () => ctx.dispose() };
          },
        });
        return a.format === 'markdown' ? { markdown: securityReportMarkdown(report), summary: report.summary } : report;
      },
    },
  ];
}
