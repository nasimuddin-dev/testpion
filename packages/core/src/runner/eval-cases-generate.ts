/**
 * Generate test cases for an evaluation with AI (AU-13). One function for the window (`eval.generateCases`), the CLI
 * (`testpion eval generate-cases`) and the MCP tool (`eval_generate_cases`): the cases are written from the prompt, an API
 * definition, a collection or folder, real calls in History (task `eval-cases`), or documents (the RAG test-set generator,
 * whose questions and reference answers become cases), each verified, and returned as ONE proposal a person reads and accepts.
 * Nothing is added to the evaluation here.
 */
import { ApsError } from '../errors.js';
import { discardProposal, openProposal, saveProposal, type Proposal, type ProposalItem } from '../ai/proposal.js';
import { runAiTask, type AiRunDeps, type AiTaskResult } from '../ai/tasks/run.js';
import { verifyItems } from '../ai/verify.js';
import { CASE_SOURCES, DEFAULT_GENERATED_CASES, MAX_GENERATED_CASES, prepareEvalCases, promptVariables, type CasesDraft, type CaseSource } from '../ai/eval-cases.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { estimateGeneration, generateTestset, type GenerateOptions } from './rag-testset-generate.js';

export interface GenerateCasesOptions {
  source: CaseSource;
  /** The evaluation as edited (its prompt, checks and cases): what the cases are written for. */
  draft: CasesDraft;
  /** The saved evaluation (id) accepted cases are added to; none for an unsaved draft: the window adds them to its own. */
  evaluation?: string;
  count?: number;
  /** source spec: an API definition of the workspace (specs/<file>). */
  spec?: string;
  /** source collection: the collection id and, optionally, a folder of it. */
  collection?: string;
  folder?: string;
  /** source documents: workspace files or folders, and https pages. */
  paths?: string[];
  urls?: string[];
  /** source history: how many recent prompts to read (1 to 50). */
  historyLimit?: number;
  /** Write them with this provider instead of the one the AI settings choose (the offline demo model is `demo`). */
  provider?: string;
  /** Ask again with a hint ("more about refunds"). */
  hint?: string;
  /** Send nothing: the preview of what would be sent (the estimate for documents). */
  dryRun?: boolean;
  privacy?: string;
  /** Documents only: the options of the test-set generator (types, judge, dedupe …). */
  documents?: Partial<GenerateOptions>;
}

export interface GenerateCasesResult {
  source: CaseSource;
  /** The cases to read; none on a dry run. */
  proposal?: Proposal;
  /** A dry run: what would be sent (messages and the estimate), or the document estimate. */
  preview?: AiTaskResult['preview'];
  estimate?: unknown;
  dryRun: boolean;
  /** Cases by their worst verification. */
  tally: { verified: number; warned: number; failed: number };
  provider?: string;
  model?: string;
  calls: number;
  costUsd?: number;
  usage: { inputTokens: number; outputTokens: number };
}

const worst = (i: ProposalItem): 'fail' | 'warn' | 'pass' => (i.verification.some((b) => b.status === 'fail') ? 'fail' : i.verification.some((b) => b.status === 'warn') ? 'warn' : 'pass');

export function tallyOf(items: ProposalItem[]): GenerateCasesResult['tally'] {
  const t = { verified: 0, warned: 0, failed: 0 };
  for (const i of items) {
    const w = worst(i);
    if (w === 'fail') t.failed++;
    else if (w === 'warn') t.warned++;
    else t.verified++;
  }
  return t;
}

const clampCount = (n: unknown) => Math.max(1, Math.min(MAX_GENERATED_CASES, Math.floor(Number(n ?? DEFAULT_GENERATED_CASES)) || DEFAULT_GENERATED_CASES));

/** The questions of the RAG test-set generator as cases of this evaluation: the question fills the prompt's variable, the reference answer is the expected answer. */
async function fromDocuments(deps: AiRunDeps, store: WorkspaceStore, o: GenerateCasesOptions, onProgress?: (done: number, of: number, text: string) => void): Promise<GenerateCasesResult> {
  if (!(o.paths?.length || o.urls?.length)) throw new ApsError('ValidationError', 'Name the documents: files or folders of the workspace, or https pages');
  const opts: GenerateOptions = { ...o.documents, paths: o.paths, urls: o.urls, count: clampCount(o.count) };
  if (o.dryRun) {
    if (!deps.services?.ragJudge) throw new ApsError('ConfigurationError', 'No model is set up to estimate with');
    return { source: 'documents', dryRun: true, estimate: await estimateGeneration(store, deps.services.ragJudge, opts), tally: { verified: 0, warned: 0, failed: 0 }, calls: 0, usage: { inputTokens: 0, outputTokens: 0 } };
  }
  const r = await generateTestset(deps, store, opts, onProgress);
  const variables = promptVariables(`${o.draft.system ?? ''}\n${o.draft.prompt}`).filter((v) => v !== (o.draft.expectedField || 'expected'));
  const field = o.draft.expectedField || 'expected';
  // the shape and repeat checks of every case use the evaluation as it is now
  const prepared = await prepareEvalCases(store, { source: 'prompt', draft: o.draft, count: opts.count, ...(o.evaluation ? { evaluation: o.evaluation } : {}) });
  const local = prepared.local as { token: string; source: CaseSource; variables: string[] };
  local.source = 'documents';
  const name = local.variables[0] ?? variables[0] ?? 'input';
  const items: ProposalItem[] = r.proposal.items.map((it, i) => {
    const rec = (it.data as { record: { question: string; reference: string; tags?: string[]; answerable?: boolean } }).record;
    const record: Record<string, string> = { [name]: rec.question, [field]: rec.reference };
    const tags = (rec.tags ?? []).filter((t) => !t.startsWith('doc:') && t !== 'generated').slice(0, 2);
    return {
      id: `i${i + 1}`,
      kind: 'eval-case',
      title: rec.question,
      after: `${JSON.stringify({ ...record, ...(tags.length ? { tags: tags.join(', ') } : {}) })}\n`,
      language: 'json',
      data: { token: local.token, source: 'documents', evaluation: o.evaluation, record, why: (it.data as { type?: string }).type },
      // the badges of the test-set verifiers (the reference is backed by its passages, an unanswerable question is not answerable, no repeats) travel with the case
      verification: it.verification,
      selected: it.selected,
    };
  });
  await verifyItems(items, ['eval-case-shape', 'eval-case-duplicate'], { store });
  for (const it of items) if (it.verification.some((b) => b.status === 'fail')) it.selected = false;
  discardProposal(store, r.proposal.id);
  const proposal = openProposal({
    task: 'eval-cases',
    taskVersion: 1,
    title: `Test cases from ${r.corpus.documents} document${r.corpus.documents === 1 ? '' : 's'}`,
    summary: `${items.length} proposed test case${items.length === 1 ? '' : 's'} from ${r.corpus.passages} passages of your documents.`,
    assumptions: ['The expected answers were written by a model from the passages; each is checked against them, but read them before relying on them.'],
    ...(r.proposal.notes?.length ? { notes: r.proposal.notes } : {}),
    items,
    provider: r.proposal.provider,
    model: r.proposal.model,
    surface: deps.surface,
    usage: r.proposal.usage,
    request: { question: `${items.length} cases from documents` },
    ...(r.proposal.problems?.length ? { problems: r.proposal.problems } : {}),
  });
  saveProposal(store, proposal);
  return { source: 'documents', proposal, dryRun: false, tally: tallyOf(items), provider: proposal.provider, model: proposal.model, calls: r.calls, costUsd: r.costUsd, usage: r.usage };
}

export async function generateEvalCases(deps: AiRunDeps, store: WorkspaceStore, o: GenerateCasesOptions, onProgress?: (done: number, of: number, text: string) => void): Promise<GenerateCasesResult> {
  if (!CASE_SOURCES.includes(o.source)) throw new ApsError('ValidationError', `"${String(o.source)}" is not a source of cases`, { suggestions: [`Use one of: ${CASE_SOURCES.join(', ')}`] });
  if (!o.draft || typeof o.draft.prompt !== 'string') throw new ApsError('ValidationError', 'Name the evaluation the cases are for');
  if (o.source === 'documents') return fromDocuments(deps, store, o, onProgress);
  const r = await runAiTask(deps, {
    task: 'eval-cases',
    hint: o.hint,
    provider: o.provider,
    privacy: o.privacy,
    dryRun: o.dryRun,
    context: {
      source: o.source,
      count: clampCount(o.count),
      draft: o.draft,
      ...(o.evaluation ? { evaluation: o.evaluation } : {}),
      ...(o.spec ? { spec: o.spec } : {}),
      ...(o.collection ? { collection: o.collection } : {}),
      ...(o.folder ? { folder: o.folder } : {}),
      ...(o.historyLimit ? { history: { limit: o.historyLimit } } : {}),
    },
  });
  if (r.dryRun) return { source: o.source, dryRun: true, preview: r.preview, tally: { verified: 0, warned: 0, failed: 0 }, provider: r.provider, model: r.model, calls: 0, usage: { inputTokens: 0, outputTokens: 0 } };
  if (!r.proposal?.items.length) throw new ApsError('ValidationError', 'The model proposed no usable test case', { why: r.problems.join('; ') || undefined, suggestions: ['Try again, or write the cases from the prompt.'] });
  return {
    source: o.source,
    proposal: r.proposal,
    dryRun: false,
    tally: tallyOf(r.proposal.items),
    provider: r.provider,
    model: r.model,
    calls: r.calls,
    ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
    usage: { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens },
  };
}

/** The test cases a proposal's ticked items hold, as records (for a window that adds them to an unsaved draft). */
export function recordsOfProposal(p: Proposal, ids?: string[]): Array<Record<string, string>> {
  const want = ids?.length ? new Set(ids) : new Set(p.items.filter((i) => i.selected).map((i) => i.id));
  return p.items.filter((i) => i.kind === 'eval-case' && want.has(i.id)).map((i) => {
    let rec = (i.data as { record?: Record<string, string> }).record ?? {};
    try {
      const edited = JSON.parse(i.after) as Record<string, unknown>;
      if (edited && typeof edited === 'object') rec = Object.fromEntries(Object.entries(edited).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
    } catch {
      /* the original record stands */
    }
    return rec;
  });
}

