import { aiRunDeps, aiUsageSummary, applyProposal, draftFlowProposal, flowSourceRef, getProposal, isAiSetupError, listAiTasks, listProposals, runAiTask, undoProposal, type Proposal } from '../ai/tasks/index.js';
import { normalizeError } from '../errors.js';
import { createEngineContext } from '../engine.js';
import { ApsError } from '../errors.js';
import type { AppSettings } from '../model/types.js';
import type { SecretStore } from '../storage/secrets.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { parseItemRef, toItemRef } from '@testpion/shared';
import { str, type Tool } from './tool.js';
import { aiTriageTools } from './ai-triage-tools.js';
import { aiSpecTools } from './ai-spec-tools.js';
import { aiSecurityTools } from './ai-security-tools.js';
import { aiDriftTools } from './ai-drift-tools.js';
import { aiScriptTools } from './ai-script-tools.js';

/** An item as an agent passes it: a ref object, a testpion:// link or `kind:id…`. */
const itemArg = (v: unknown) => {
  if (v === undefined || v === null || v === '') return undefined;
  const r = typeof v === 'string' ? parseItemRef(v) : toItemRef(v);
  if (!r)
    throw new ApsError('ValidationError', `"${typeof v === 'string' ? v : JSON.stringify(v)}" is not an item reference`, {
      suggestions: ['Use kind:id, e.g. request:<collectionId>:<requestId>, run:<runId>, test:smoke/login.yaml, or the `ref` other tools return.'],
    });
  return r;
};

const items = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? v.split(',').map((s) => s.trim()) : undefined);

/** A proposal as an agent reads it: items with their verification, without the before text of big files. */
const forAgent = (p: Proposal) => ({ ...p, items: p.items.map((i) => ({ ...i, before: i.before && i.before.length > 4000 ? `${i.before.slice(0, 4000)} …` : i.before })) });

/**
 * MCP tools for TestPion's own AI tasks (AIB-1). An agent is already a model, so the deterministic tools come first;
 * these are for clients that want TestPion's configured model (the user's key or a local model). A task only
 * proposes: `ai_run_task` returns a proposal with an id, `ai_apply_proposal` (a separate, confirmed call) writes it.
 */
export function aiTools({
  store,
  secrets,
  settings,
  checkEnvironment,
}: {
  store: WorkspaceStore;
  secrets: SecretStore;
  settings: AppSettings;
  /** The server's check of an environment a tool runs in (ai_attempt_fix); see aiTriageTools. */
  checkEnvironment?: (name: string | undefined) => unknown;
}): Tool[] {
  return [
    {
      name: 'ai_list_tasks',
      description:
        "TestPion's AI tasks: id, what each does, tier (small or large model), output (markdown, code, json), what its context holds, whether it proposes changes, and the verifiers that check them.",
      inputSchema: { type: 'object', properties: {} },
      run: () => ({ tasks: listAiTasks() }),
    },
    {
      name: 'ai_run_task',
      description:
        "Run one of TestPion's AI tasks with the model the user configured (their key, or a local model): an answer, and for generating tasks (tests, flows, checks, scripts, a request) a proposal with an id whose items were verified (lint, checks against the response, the script in the sandbox). Nothing is written: ai_apply_proposal does that. The context is redacted (secrets, tokens, personal data) and fitted to a budget; `dryRun` shows what would be sent without sending. Calls are counted in the workspace's AI usage, within the user's caps.",
      inputSchema: {
        type: 'object',
        properties: {
          task: str('Task id (ai_list_tasks), e.g. explain-test-failure, generate-assertions, design-flow'),
          item: {
            description:
              'The workspace item it is about: a ref from another tool, or kind:id (request:<c>:<r>, run:<runId>:<resultId>, history:<id>, test:<path>, flow:<path>, spec:<path>, collection:<id>, folder:<c>:<f>)',
          },
          question: str('The question, or what to generate'),
          context: { type: 'object', description: 'Context as a JSON object (instead of, or on top of, item)' },
          privacy: { type: 'string', enum: ['full', 'metadata', 'names'], description: 'full (redacted, default), metadata (shapes and names, no bodies), names (names only)' },
          hint: str('An extra instruction (regenerate with a hint)'),
          path: str('Where a generated test file goes, under tests/'),
          target: { description: 'Where a generated request goes: collection:<id> or folder:<c>:<f>' },
          environment: str('Environment whose variable names (never values) the task may use'),
          preferStable: { type: 'boolean', description: 'Checks tasks: prefer types, formats and presence over literal ids, times and tokens (default: the AI setting)' },
          dryRun: { type: 'boolean', description: 'Send nothing: return what would be sent (messages, sections, token and cost estimate, what was masked)' },
        },
        required: ['task'],
      },
      run: async (a) => {
        const ctx = createEngineContext({ store, secrets, settings, environment: a.environment ? String(a.environment) : undefined });
        try {
          const r = await runAiTask(aiRunDeps({ ctx, settings, store, surface: 'mcp' }), {
            task: String(a.task),
            item: itemArg(a.item),
            question: a.question ? String(a.question) : undefined,
            context: a.context && typeof a.context === 'object' ? (a.context as Record<string, unknown>) : undefined,
            privacy: a.privacy ? String(a.privacy) : undefined,
            hint: a.hint ? String(a.hint) : undefined,
            path: a.path ? String(a.path) : undefined,
            target: itemArg(a.target),
            dryRun: a.dryRun === true,
            ...(typeof a.preferStable === 'boolean' ? { preferStable: a.preferStable } : {}),
          });
          const { preview, proposal, ...rest } = r;
          return {
            ...rest,
            ...(r.dryRun ? { preview } : { sent: { privacy: preview.privacy, contextTokens: preview.context.tokens, masked: preview.redactionCount, local: preview.local } }),
            ...(proposal ? { proposal: forAgent(proposal), next: `Show the user the items and their verification; apply with ai_apply_proposal { id: "${proposal.id}" } after they agree.` } : {}),
          };
        } finally {
          await ctx.dispose();
        }
      },
    },
    {
      name: 'flow_generate',
      description:
        "Have TestPion's configured model (the user's key or a local model) write an integration flow from the saved requests of a collection or one folder: steps that use those requests by id (an invented one is dropped), ordered create → read → update → delete, ids and tokens extracted and passed on, status and key-field checks, one or two error cases, and the model's assumptions. It starts from the deterministic draft (generate_flows' logic) and is verified: lint (cycles, unknown dependsOn), every {{variable}} extracted before use, and a run against a mock of the collection. It only proposes: apply the returned proposal with ai_apply_proposal after the user agrees. Without a model set up, the deterministic draft is the proposal (with a note). `dryRun` returns what would be sent (requests, shapes, variable names — never values) with the token and cost estimate.",
      inputSchema: {
        type: 'object',
        properties: {
          collection: str('The collection: its name or id (list_collections)'),
          folder: str('One folder of it: its name, its path (Orders/Refunds) or its id'),
          hint: str('An extra instruction, e.g. "also test pagination"'),
          privacy: { type: 'string', enum: ['full', 'metadata', 'names'], description: 'full (redacted, default), metadata (methods, URLs, shapes and names; no body values), names' },
          path: str('The flow file to propose, under tests/ (default tests/flows/<collection>-<folder>.yaml)'),
          environment: str('Environment whose variable names (never values) the flow may use'),
          noAi: { type: 'boolean', description: 'Only the deterministic draft (no model is called)' },
          dryRun: { type: 'boolean', description: 'Send nothing: return what would be sent and the estimate' },
        },
        required: ['collection'],
      },
      run: async (a) => {
        const item = flowSourceRef(store, { collection: String(a.collection), folder: a.folder ? String(a.folder) : undefined });
        const ctx = createEngineContext({ store, secrets, settings, environment: a.environment ? String(a.environment) : undefined });
        const verify = { variableNames: ctx.vars.names(), services: ctx.services };
        const path = a.path ? String(a.path) : undefined;
        const next = (p: Proposal) => `Show the user the flow (proposal.items[0].after), its verification, assumptions and notes; apply it with ai_apply_proposal { id: "${p.id}" } after they agree.`;
        try {
          if (a.noAi === true) {
            const p = await draftFlowProposal(store, item, { path, surface: 'mcp', reason: 'Made without AI (noAi): the deterministic draft.', verify });
            return { proposal: forAgent(p), next: next(p) };
          }
          try {
            const r = await runAiTask(aiRunDeps({ ctx, settings, store, surface: 'mcp' }), {
              task: 'flow-from-collection',
              item,
              hint: a.hint ? String(a.hint) : undefined,
              privacy: a.privacy ? String(a.privacy) : undefined,
              path,
              dryRun: a.dryRun === true,
            });
            if (r.dryRun) return { dryRun: true, preview: r.preview };
            const { preview, proposal, ...rest } = r;
            return {
              ...rest,
              sent: { privacy: preview.privacy, contextTokens: preview.context.tokens, masked: preview.redactionCount, local: preview.local },
              ...(proposal ? { proposal: forAgent(proposal), next: next(proposal) } : {}),
            };
          } catch (e) {
            if (!isAiSetupError(e) || a.dryRun === true) throw e;
            const why = normalizeError(e).message;
            const p = await draftFlowProposal(store, item, { path, surface: 'mcp', reason: `No AI model is set up (${why}): this is the deterministic draft.`, verify });
            return { fallback: why, proposal: forAgent(p), next: next(p) };
          }
        } finally {
          await ctx.dispose();
        }
      },
    },
    {
      name: 'ai_proposals',
      description:
        'AI proposals of the workspace (kept a day): id, task, title, status (open, applied, discarded), items; with `id`, one proposal with each item (before/after text, target, verification badges).',
      inputSchema: { type: 'object', properties: { id: str('A proposal id (ai-…): that one in full'), status: { type: 'string', enum: ['open', 'applied', 'discarded'] } } },
      run: (a) => (a.id ? forAgent(getProposal(store, String(a.id))) : { proposals: listProposals(store, { status: a.status as Proposal['status'] | undefined }) }),
    },
    {
      name: 'ai_apply_proposal',
      write: true,
      description:
        'Apply an AI proposal: its ticked items, or the ones named in `items` (writes test files under tests/, adds checks or scripts to saved requests, adds requests). What it replaces is kept so ai_undo_proposal can put it back. `dryRun` lists what would be applied.',
      inputSchema: {
        type: 'object',
        properties: {
          id: str('The proposal id from ai_run_task'),
          items: { type: 'array', items: { type: 'string' }, description: 'Item ids to apply (default: the ticked ones, i.e. those whose verification did not fail)' },
          dryRun: { type: 'boolean', description: 'Change nothing: list what would be applied' },
        },
        required: ['id'],
      },
      run: (a) => {
        if (a.dryRun === true) {
          const p = getProposal(store, String(a.id));
          const want = items(a.items);
          return {
            id: p.id,
            status: p.status,
            wouldApply: p.items
              .filter((i) => (want ? want.includes(i.id) : i.selected && i.kind !== 'text'))
              .map((i) => ({ item: i.id, kind: i.kind, title: i.title, path: i.path, target: i.target, verification: i.verification })),
          };
        }
        return applyProposal(store, String(a.id), { items: items(a.items) });
      },
    },
    {
      name: 'ai_undo_proposal',
      write: true,
      description: 'Undo an applied AI proposal: put back the files and requests it replaced (and remove what it added).',
      inputSchema: { type: 'object', properties: { id: str('The proposal id') }, required: ['id'] },
      run: (a) => undoProposal(store, String(a.id)),
    },
    {
      name: 'ai_usage',
      description:
        "What TestPion's AI features used in this workspace: today and the last `days` days (calls, tokens, estimated cost), per task, model and surface (app, cli, mcp, ci), the latest calls, the user's caps and what is left of them today. AI Lab prompts are listed too (llm_usage has them per model).",
      inputSchema: { type: 'object', properties: { days: { type: 'number', description: 'The period (default 30)' } } },
      run: (a) => aiUsageSummary(store, { days: Number(a.days) || 30, settings: settings.ai, recent: 20 }),
    },
    // AI-2 / AI-5: triage a failed run, analyse a flaky test, attempt the fix
    ...aiTriageTools({ store, secrets, settings, checkEnvironment }),
    // AI-4 / AI-10: tests from a spec (gap-driven), tidy an import
    ...aiSpecTools({ store, secrets, settings }),
    // AI-8 / AI-9 / AI-6: security tests, contract drift, the script helper
    ...aiSecurityTools({ store, secrets, settings, checkEnvironment }),
    ...aiDriftTools({ store, secrets, settings }),
    ...aiScriptTools({ store, secrets, settings }),
  ];
}
