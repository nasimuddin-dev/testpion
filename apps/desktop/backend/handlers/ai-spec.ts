/**
 * RPC handlers of AI-4 (tests from a spec, driven by the gaps) and AI-10 (tidy an import): the window's "Generate
 * tests from this spec…" and "Tidy this import with AI…" call the same core functions as the CLI (`testpion generate
 * gaps|tests`, `testpion tidy --ai`) and the MCP server (`spec_gaps`, `spec_tests_generate`, `tidy_import`). They
 * propose; applying is `ai.applyProposal`.
 */
import { draftSpecTestsProposal, draftTidyProposal, specGapsWithDraft, type ItemRef, type SpecCategory } from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';

interface SpecParams {
  spec: string;
  categories?: SpecCategory[];
  operations?: string[];
  gapsOnly?: boolean;
  includeDelete?: boolean;
}

export function aiSpecHandlers(be: Backend): Handlers {
  const options = (p: SpecParams) => ({ categories: p.categories, operations: p.operations, gapsOnly: p.gapsOnly, includeDelete: p.includeDelete });
  return {
    /** What the tests never prove about an API definition, and how many tests TestPion could build for it (no model). */
    'ai.specGaps': (p: SpecParams) => specGapsWithDraft(be.ws, p.spec, options(p)),
    /** Tests for the gaps: TestPion's own cases plus the model's ideas, validated against the document; `noAi`: the own cases only. */
    'ai.specTests': async (p: SpecParams & { hint?: string; privacy?: string; path?: string; environment?: string; dryRun?: boolean; noAi?: boolean; requestId?: string }) => {
      if (p.noAi) {
        const ctx = be.context({ environment: p.environment });
        try {
          return { proposal: await draftSpecTestsProposal(be.ws, p.spec, { ...options(p), path: p.path, surface: 'app', reason: 'Made without AI: the tests TestPion builds from the document for the gaps.', services: ctx.services }) };
        } finally {
          await ctx.dispose();
        }
      }
      return be.assistant({ task: 'tests-from-spec', item: { kind: 'spec', path: p.spec } as ItemRef, context: { options: options(p) }, hint: p.hint, privacy: p.privacy, path: p.path, environment: p.environment, dryRun: p.dryRun, requestId: p.requestId });
    },
    /** The clean-up of an import as reviewable changes; `noAi`: what TestPion finds itself. */
    'ai.tidyImport': async (p: { collectionId: string; flow?: boolean; source?: string; hint?: string; privacy?: string; environment?: string; dryRun?: boolean; noAi?: boolean; requestId?: string }) => {
      const item: ItemRef = { kind: 'collection', collectionId: p.collectionId };
      if (p.noAi) return { proposal: await draftTidyProposal(be.ws, item, { surface: 'app', source: p.source, reason: 'Made without AI: the clean-ups TestPion finds itself.' }) };
      return be.assistant({ task: 'tidy-import', item, context: { options: { flow: p.flow === true, ...(p.source ? { source: p.source } : {}) } }, hint: p.hint, privacy: p.privacy, environment: p.environment, dryRun: p.dryRun, requestId: p.requestId });
    },
  };
}
