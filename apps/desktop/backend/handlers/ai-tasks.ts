/**
 * RPC handlers of the AI task runner (packages/core/src/ai/tasks): the window's AI actions call these, the same
 * runner the CLI (`testpion ai …`) and the MCP server (`ai_*` tools) use. The window never builds prompts itself.
 */
import { aiUsageSummary, applyProposal, askSearch, OP_LABEL, runQuerySpec, SEARCH_FIELDS, SEARCH_SOURCES, SOURCE_LABEL, discardProposal, draftFlowProposal, getProposal, listProposals, reverifyProposal, undoProposal, type ItemRef, type Proposal, type ReverifyOptions } from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';

/** The page a window call asked for (nothing asked: the engine's default page). */
const searchPageOf = (p: { limit?: number; offset?: number; cursor?: string | number }) => (p.limit === undefined && p.offset === undefined && p.cursor === undefined ? undefined : p);

/**
 * A proposal that saves into a library (an authored RAG evaluation goes to library/evaluations.json) is a change the lists
 * of the window have to hear of: the file watcher does not report the app's own writes, so it is announced here.
 */
function announceLibraryItems(be: Backend, id: string): void {
  try {
    const p = getProposal(be.ws, id);
    if (p.items.some((i) => i.kind === 'evaluation')) be.host.emit('data.changed', { method: 'ai.proposal', paths: ['library/evaluations.json'] });
  } catch {
    /* an expired proposal has nothing to announce */
  }
}

export function aiTaskHandlers(be: Backend): Handlers {
  return {
    /** Run a task: an answer and, for generating tasks, a verified proposal (nothing is applied). */
    'ai.runTask': (p: Parameters<Backend['assistant']>[0]) => be.assistant({ ...p, dryRun: false }),
    /** "What will be sent": the messages, sections, token and cost estimate and the masks, without sending. */
    'ai.preview': (p: Parameters<Backend['assistant']>[0]) => be.assistant({ ...p, dryRun: true, requestId: undefined }),
    /**
     * An integration flow from a collection or folder (AI-1): the model improves TestPion's draft, the flow is verified and
     * proposed (nothing is written). `noAi` gives the draft itself (no model set up, or the person asked for it).
     */
    'ai.generateFlow': async (p: { collectionId: string; folderId?: string; hint?: string; privacy?: string; path?: string; environment?: string; dryRun?: boolean; noAi?: boolean; requestId?: string }) => {
      const item: ItemRef = p.folderId ? { kind: 'folder', collectionId: p.collectionId, folderId: p.folderId } : { kind: 'collection', collectionId: p.collectionId };
      if (p.noAi) {
        const ctx = be.context({ environment: p.environment });
        try {
          return { proposal: await draftFlowProposal(be.ws, item, { path: p.path, surface: 'app', reason: 'Made without AI: the deterministic draft TestPion builds from the saved requests.', verify: { variableNames: ctx.vars.names(), services: ctx.services } }) };
        } finally {
          await ctx.dispose();
        }
      }
      return be.assistant({ task: 'flow-from-collection', item, hint: p.hint, privacy: p.privacy, path: p.path, environment: p.environment, dryRun: p.dryRun, requestId: p.requestId });
    },
    /** Check a proposal again: after an edit in the review, a switch to a safer check, Try on mock (`verifiers: ['flow-mock']`), or Run now (a new response). */
    'ai.reverifyProposal': async ({ id, environment, ...o }: ReverifyOptions & { id: string; environment?: string }) => {
      const ctx = be.context({ environment });
      try {
        return await reverifyProposal(be.ws, id, o, { variableNames: ctx.vars.names(), services: ctx.services });
      } finally {
        await ctx.dispose();
      }
    },
    'ai.proposal': ({ id }: { id: string }) => getProposal(be.ws, id),
    'ai.proposals': ({ status }: { status?: Proposal['status'] }) => listProposals(be.ws, { status }),
    /** Apply the chosen items (test files, checks, scripts, requests) through the workspace's writers; Undo puts them back. */
    'ai.applyProposal': ({ id, items, recordOnly }: { id: string; items?: string[]; recordOnly?: boolean }) => {
      const r = applyProposal(be.ws, id, { items, recordOnly });
      announceLibraryItems(be, id);
      return r;
    },
    'ai.discardProposal': ({ id }: { id: string }) => {
      const p = discardProposal(be.ws, id);
      return { id: p.id, status: p.status };
    },
    'ai.undoProposal': ({ id }: { id: string }) => {
      const r = undoProposal(be.ws, id);
      announceLibraryItems(be, id);
      return r;
    },
    /**
     * The Ask box (AI-12): a question translated by the model into a validated search query and run by TestPion, the
     * query shown in words and as chips. No model, or a failure: the words are searched as typed (`mode: 'text'`, why in
     * `fallback`). `scope` keeps the search inside the view it was asked in (History, Runs, Traces).
     */
    'search.ask': ({ question, scope, noAi, privacy, dryRun, requestId, limit, offset, cursor }: { question: string; scope?: string[]; noAi?: boolean; privacy?: string; dryRun?: boolean; requestId?: string; limit?: number; offset?: number; cursor?: string | number }) =>
      be.withAiDeps({ requestId, dryRun }, (deps) => askSearch(deps, { question, scope: scope as never, noAi, privacy, dryRun, page: searchPageOf({ limit, offset, cursor }) })),
    /** Run a query the window holds (the chips edited by hand): validated by the same schema, no model. */
    'search.query': ({ query, scope, limit, offset, cursor }: { query: unknown; scope?: string[]; limit?: number; offset?: number; cursor?: string | number }) => runQuerySpec(be.ws, query, { scope: scope as never, page: searchPageOf({ limit, offset, cursor }) }),
    /** The fields, operators and sources a query may use: what the chip editor offers. */
    'search.fields': () => ({ fields: SEARCH_FIELDS, sources: SEARCH_SOURCES.map((id) => ({ id, label: SOURCE_LABEL[id] })), ops: OP_LABEL }),
    /** The AI features' usage in this workspace (app, CLI, MCP, CI), the caps and what is left today, and AI Lab per model. */
    'ai.taskUsage': ({ days }: { days?: number }) => aiUsageSummary(be.ws, { days, settings: be.settings.ai, recent: 50 }),
  };
}
