/**
 * Generating a test set (planning/rag-testing.md §4b): read and chunk the documents once, ask the model batch by batch (each
 * batch is one run of the task `rag-generate-testset`, its samples verified by the task's verifiers), drop what repeats an
 * earlier batch, and keep ONE proposal for the review. The same function serves the window, `testpion rag generate-dataset`
 * and the MCP tool, so a test set is made the same way everywhere.
 */
import { ApsError, normalizeError } from '../errors.js';
import { newProposalId, PROPOSAL_TTL_MS, saveProposal, type Proposal, type ProposalItem } from '../ai/proposal.js';
import { runAiTask, type AiRunDeps } from '../ai/tasks/run.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import type { JudgeRef, RagJudgeHost } from '../eval/rag/judge.js';
import type { RunEstimate } from '../eval/rag/estimate.js';
import { loadCorpus, type LoadOptions } from '../eval/rag/testset/documents.js';
import { corpusToken, rememberCorpus } from '../eval/rag/testset/corpus-cache.js';
import { estimateTestset } from '../eval/rag/testset/estimate.js';
import { jaccard, termSet } from '../eval/rag/testset/lexical.js';
import { batchesOf } from '../eval/rag/testset/sample.js';
import { clampCount, judgeOf, parseTypes } from '../eval/rag/testset/task.js';
import type { Corpus, TestsetOptions, TestsetType } from '../eval/rag/testset/types.js';

export interface GenerateOptions extends TestsetOptions, Pick<LoadOptions, 'allowAbsolute' | 'guard'> {
  judge?: JudgeRef | string;
  /** Skip the judge's check of the references (the lexical and corpus checks still run). */
  noJudge?: boolean;
  /** Set when the person keeps the types as strings (a CLI flag). */
  typesText?: string;
}

export interface GenerateResult {
  proposal: Proposal;
  corpus: { documents: number; passages: number; skipped: string[] };
  /** Samples by their worst verification status. */
  tally: { verified: number; warned: number; failed: number; byType: Record<string, number> };
  calls: number;
  costUsd?: number;
  usage: { inputTokens: number; outputTokens: number };
}

export interface Resolved {
  count: number;
  types: TestsetType[];
  seed: string;
  judge?: JudgeRef;
}

export function resolveOptions(o: GenerateOptions): Resolved {
  if (!(o.paths?.length || o.urls?.length)) throw new ApsError('ValidationError', 'Name the documents: files or folders of the workspace, or https URLs');
  const judge = judgeOf(o.judge);
  return { count: clampCount(o.count), types: parseTypes(o.types ?? o.typesText), seed: o.seed ?? 'testpion', ...(judge ? { judge } : {}) };
}

/** The estimate of a run, before it: reads the documents, builds nothing else, sends nothing. */
export async function estimateGeneration(store: WorkspaceStore, host: RagJudgeHost, o: GenerateOptions): Promise<RunEstimate & { corpus: { documents: number; passages: number; skipped: string[] } }> {
  const r = resolveOptions(o);
  const corpus = await loadCorpus(store, o);
  return { ...estimateTestset(host, store, corpus, { ...r, verify: !o.noJudge }), corpus: { documents: corpus.docs.length, passages: corpus.chunks.length, skipped: corpus.skipped } };
}

const worst = (i: ProposalItem): 'fail' | 'warn' | 'pass' => (i.verification.some((b) => b.status === 'fail') ? 'fail' : i.verification.some((b) => b.status === 'warn') ? 'warn' : 'pass');

export async function generateTestset(deps: AiRunDeps, store: WorkspaceStore, o: GenerateOptions, onProgress?: (done: number, of: number, text: string) => void): Promise<GenerateResult> {
  const r = resolveOptions(o);
  const corpus: Corpus = await loadCorpus(store, o);
  const token = corpusToken(corpus, r.seed);
  rememberCorpus(token, corpus);
  const batches = batchesOf(r.count);
  const context = { corpus: token, count: r.count, types: r.types, seed: r.seed, ...(o.name ? { name: o.name } : {}), ...(r.judge && !o.noJudge ? { judge: r.judge } : {}) };
  // without a judge the services carry none: the verifier then reports the lexical check alone
  const runDeps: AiRunDeps = o.noJudge && deps.services ? { ...deps, services: { ...deps.services, ragJudge: undefined } } : deps;
  const items: ProposalItem[] = [];
  const notes: string[] = [...corpus.skipped.map((s) => `Skipped ${s}`)];
  const problems: string[] = [];
  let usage = { inputTokens: 0, outputTokens: 0 };
  let cost: number | undefined = 0;
  let calls = 0;
  let provider = '';
  let model = '';
  const seen: Array<{ terms: Set<string>; question: string }> = [];
  for (let b = 0; b < batches; b++) {
    onProgress?.(b, batches, `Writing questions ${b * 8 + 1} to ${Math.min(r.count, b * 8 + 8)} of ${r.count}`);
    let res;
    try {
      res = await runAiTask(runDeps, { task: 'rag-generate-testset', context: { ...context, batch: b }, noProposal: true, provider: undefined });
    } catch (e) {
      // the first batch failing is the setup (no model, a cap): say it; later ones are noted and the rest is kept
      if (b === 0 || deps.signal?.aborted) throw e;
      notes.push(`Batch ${b + 1} failed: ${normalizeError(e).message}`);
      continue;
    }
    provider = res.provider;
    model = res.model;
    calls += res.calls;
    usage = { inputTokens: usage.inputTokens + res.usage.inputTokens, outputTokens: usage.outputTokens + res.usage.outputTokens };
    cost = cost === undefined || res.costUsd === undefined ? undefined : cost + res.costUsd;
    problems.push(...res.problems.map((p) => `Batch ${b + 1}: ${p}`));
    for (const it of res.proposal?.items ?? []) {
      const q = String((it.data as { record?: { question?: string } } | undefined)?.record?.question ?? it.title);
      const terms = termSet(q);
      const dup = seen.find((x) => jaccard(terms, x.terms) >= 0.8);
      // a repeat of an earlier batch stays in the review, unticked with its reason, so nothing disappears unseen
      if (dup) {
        it.verification.push({ verifier: 'testset-duplicate', status: 'fail', label: 'asks the same as an earlier question', detail: `“${dup.question}”` });
        it.selected = false;
      }
      seen.push({ terms, question: q });
      items.push(it);
    }
    for (const n of res.proposal?.notes ?? []) notes.push(`Batch ${b + 1}: ${n}`);
  }
  onProgress?.(batches, batches, 'Done');
  if (!items.length) throw new ApsError('ValidationError', 'The model proposed no usable question', { why: problems.join('; ') || undefined, suggestions: ['Try again, a larger model, or fewer question types.'] });
  items.forEach((it, i) => (it.id = `i${i + 1}`));
  const tally = { verified: 0, warned: 0, failed: 0, byType: {} as Record<string, number> };
  for (const it of items) {
    const w = worst(it);
    if (w === 'fail') tally.failed++;
    else if (w === 'warn') tally.warned++;
    else tally.verified++;
    const t = (it.data as { type?: string }).type ?? '?';
    tally.byType[t] = (tally.byType[t] ?? 0) + 1;
  }
  const dataset = (items[0]!.data as { dataset: string }).dataset;
  const now = Date.now();
  const proposal: Proposal = {
    schemaVersion: 1,
    id: newProposalId(),
    task: 'rag-generate-testset',
    taskVersion: 1,
    title: `Test set from ${corpus.docs.length} document${corpus.docs.length === 1 ? '' : 's'}`,
    summary: `${items.length} proposed question${items.length === 1 ? '' : 's'} for ${dataset} (${Object.entries(tally.byType).map(([t, n]) => `${n} ${t}`).join(', ')}) from ${corpus.chunks.length} passages. ${tally.verified} verified, ${tally.warned} with a warning, ${tally.failed} failed a check and are unticked.`,
    assumptions: ['Reference answers were written by a model from the passages; each is checked against them, but read them before relying on them.'],
    ...(notes.length ? { notes: notes.slice(0, 30) } : {}),
    items,
    provider,
    model,
    surface: deps.surface,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PROPOSAL_TTL_MS).toISOString(),
    status: 'open',
    usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, ...(cost !== undefined ? { costUsd: cost } : {}) },
    request: { question: `${r.count} questions (${r.types.join(', ')})`, ...(o.name ? { path: dataset } : {}) },
    ...(problems.length ? { problems: problems.slice(0, 10) } : {}),
  };
  saveProposal(store, proposal);
  return { proposal, corpus: { documents: corpus.docs.length, passages: corpus.chunks.length, skipped: corpus.skipped }, tally, calls, costUsd: cost, usage };
}
