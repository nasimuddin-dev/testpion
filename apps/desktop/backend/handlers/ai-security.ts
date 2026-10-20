/**
 * RPC handlers of AI-8 (security tests) and AI-9 (contract drift): the window's "Generate security tests with AI…" and
 * "Check traffic against this spec…" call the same core functions as the CLI (`testpion security generate|run`,
 * `testpion openapi-drift`) and the MCP server (`security_tests_generate`, `security_tests_run`, `contract_drift`). They
 * propose; applying is `ai.applyProposal`. The window never consents to production: a production environment is refused.
 */
import { contractDrift, draftDriftProposal, draftSecurityProposal, runSecurityTests, securityReportMarkdown, sourceOf, type DriftSource, type ItemRef } from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';

interface SecurityParams {
  collectionId: string;
  folderId?: string;
  identities?: { owner?: string; other?: string };
  probes?: string[];
  includeWrite?: boolean;
  includeDelete?: boolean;
  rate?: number;
  max?: number;
  hint?: string;
  privacy?: string;
  path?: string;
  environment?: string;
  dryRun?: boolean;
  noAi?: boolean;
  requestId?: string;
}

interface DriftParams {
  spec: string;
  source?: DriftSource;
  hint?: string;
  privacy?: string;
  environment?: string;
  dryRun?: boolean;
  noAi?: boolean;
  requestId?: string;
}

export function aiSecurityHandlers(be: Backend): Handlers {
  const optionsOf = (p: SecurityParams) => ({
    probes: p.probes,
    identities: p.identities,
    includeWrite: p.includeWrite === true,
    includeDelete: p.includeDelete === true,
    rate: p.rate,
    max: p.max,
    environment: p.environment,
    allowProduction: false,
  });
  return {
    /** Security tests for a collection or folder: the model picks the probes, TestPion writes the steps; `noAi`: TestPion's own probes. */
    'ai.securityTests': async (p: SecurityParams) => {
      const item: ItemRef = p.folderId ? { kind: 'folder', collectionId: p.collectionId, folderId: p.folderId } : { kind: 'collection', collectionId: p.collectionId };
      const options = optionsOf(p);
      if (p.noAi) return { proposal: await draftSecurityProposal(be.ws, item, { options, path: p.path, surface: 'app', reason: 'Made without AI: the probes TestPion makes itself.' }) };
      return be.assistant({ task: 'security-tests', item, context: { options }, hint: p.hint, privacy: p.privacy, path: p.path, environment: p.environment, dryRun: p.dryRun, requestId: p.requestId });
    },
    /** Run a generated security file in a test environment (paced, one step at a time); the verdicts, findings first. */
    'ai.securityRun': async (p: { path: string; environment: string }) => {
      const report = await runSecurityTests({
        store: be.ws,
        path: p.path,
        environment: p.environment,
        allowProduction: false,
        servicesFor: async (environment) => {
          const ctx = be.context({ environment });
          return { services: ctx.services, dispose: () => ctx.dispose() };
        },
      });
      return { ...report, markdown: securityReportMarkdown(report) };
    },
    /** What real traffic does that an API definition does not say (deterministic, no model). */
    'ai.driftReport': ({ spec, source }: { spec: string; source?: DriftSource }) => contractDrift(be.ws, spec, sourceOf({ ...(source ?? {}) })),
    /** The drift explained and the fix proposed (spec patches made from what was observed, contract checks), verified against the same traffic; `noAi`: TestPion's own patches. */
    'ai.driftExplain': async (p: DriftParams) => {
      const source = sourceOf({ ...(p.source ?? {}) });
      if (p.noAi) return { proposal: await draftDriftProposal(be.ws, p.spec, source, { surface: 'app', reason: 'Made without AI: the patches TestPion makes from what was observed.' }) };
      return be.assistant({ task: 'contract-drift', item: { kind: 'spec', path: p.spec }, context: { options: { source } }, hint: p.hint, privacy: p.privacy, environment: p.environment, dryRun: p.dryRun, requestId: p.requestId });
    },
  };
}
