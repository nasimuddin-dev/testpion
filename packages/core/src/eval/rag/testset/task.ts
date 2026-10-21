/**
 * The work of the AI task `rag-generate-testset`: reading the corpus from the caller's choices (`prepareContext`), turning the
 * model's samples into proposal items (`propose`) and the summary of the review (`describe`). ai/tasks/rag-testset-task.ts
 * only defines the task and calls these.
 */
import { ApsError } from '../../../errors.js';
import type { AiPrivacy } from '../../../ai/ai-settings.js';
import type { ProposalItem } from '../../../ai/proposal.js';
import type { AiTaskInput, DraftItem, PreparedItem } from '../../../ai/tasks/registry.js';
import type { WorkspaceStore } from '../../../storage/workspace.js';
import type { JudgeRef } from '../judge.js';
import { loadCorpus } from './documents.js';
import { corpusOf, corpusToken, rememberCorpus } from './corpus-cache.js';
import { hashOf, slugOf } from './chunk.js';
import { planBatch, type Slot } from './sample.js';
import { BATCH_SAMPLES, MAX_COUNT, TESTSET_TYPES, type Corpus, type RawSample, type TestsetRecord, type TestsetType } from './types.js';
import { TESTSET_VERSION } from './prompts.js';
import './verify.js';

/** What `prepareContext` keeps on this computer for `propose` and the verifiers. */
export interface TestsetLocal {
  corpus: Corpus;
  token: string;
  slots: Slot[];
  seed: string;
  batch: number;
  dataset: string;
  judge?: JudgeRef;
}

/** The judge of the entailment pass: `provider/model` or { provider, model }; unset means the AI settings' large model. */
export function judgeOf(v: unknown): JudgeRef | undefined {
  if (typeof v === 'string' && v.trim()) return { provider: v.split('/')[0], ...(v.includes('/') ? { model: v.split('/').slice(1).join('/') } : {}) };
  if (v && typeof v === 'object') {
    const j = v as JudgeRef;
    return { provider: j.provider, model: j.model, maxCalls: j.maxCalls, maxCostUsd: j.maxCostUsd };
  }
  return undefined;
}

export const UNANSWERABLE_REFERENCE = 'The documents do not contain this information.';

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === 'string' && v.trim() ? [v] : []);

/** The dataset file name: datasets/<slug>.jsonl (the caller's name made safe, or one from the first document). */
export function datasetPathOf(name: string | undefined, fallback: string): string {
  const base = (name ?? '').trim().replace(/^datasets[\\/]/i, '').replace(/\.jsonl$/i, '');
  return `datasets/${slugOf(base || fallback)}.jsonl`;
}

export function parseTypes(v: unknown): TestsetType[] {
  const given = asStrings(v).flatMap((s) => s.split(',')).map((s) => s.trim());
  if (!given.length) return ['single-hop', 'multi-hop', 'abstract', 'unanswerable', 'adversarial'];
  const bad = given.filter((t) => !(TESTSET_TYPES as readonly string[]).includes(t));
  if (bad.length) throw new ApsError('ValidationError', `Unknown question type ${bad.join(', ')}`, { suggestions: [`Types: ${TESTSET_TYPES.join(', ')}`] });
  return TESTSET_TYPES.filter((t) => given.includes(t));
}

export function clampCount(v: unknown): number {
  const n = Math.floor(Number(v ?? 10));
  if (!Number.isFinite(n) || n < 1) throw new ApsError('ValidationError', 'The number of questions is at least 1');
  return Math.min(MAX_COUNT, n);
}

export async function prepareTestset(store: WorkspaceStore, context: Record<string, unknown>, o: { privacy: AiPrivacy }): Promise<PreparedItem> {
  // the passages ARE the context: a lower privacy level would send none of them, so the task says so instead of asking blind
  if (o.privacy !== 'full')
    throw new ApsError('ConfigurationError', `Generating a test set sends passages of your documents, and the AI privacy level is "${o.privacy}"`, { suggestions: ['Settings ▸ AI assistant ▸ Privacy ▸ Full (redacted): secrets and personal data are masked before anything is sent.'] });
  const seed = String(context.seed ?? 'testpion');
  const count = clampCount(context.count);
  const types = parseTypes(context.types);
  const batch = Math.max(0, Math.floor(Number(context.batch ?? 0)));
  let corpus = typeof context.corpus === 'string' ? corpusOf(context.corpus) : undefined;
  if (!corpus) corpus = await loadCorpus(store, { paths: asStrings(context.paths), urls: asStrings(context.urls) });
  const token = corpusToken(corpus, seed);
  rememberCorpus(token, corpus);
  const plan = planBatch(corpus.chunks, { seed, batch, count, types });
  if (!plan.slots.length) throw new ApsError('ValidationError', `Batch ${batch} is past the ${count} questions asked for`);
  const dataset = datasetPathOf(typeof context.name === 'string' ? context.name : undefined, corpus.docs[0]?.name ?? 'testset');
  const judge = judgeOf(context.judge);
  const local: TestsetLocal = { corpus, token, slots: plan.slots, seed, batch, dataset, ...(judge ? { judge } : {}) };
  return {
    label: `${corpus.docs.length} document${corpus.docs.length === 1 ? '' : 's'}`,
    local,
    context: {
      corpus: { documents: corpus.docs.length, passages: corpus.chunks.length, sent: plan.chunks.length },
      passages: plan.chunks.map((c) => ({ id: c.id, document: c.doc, ...(c.heading.length ? { heading: c.heading.join(' > ') } : {}), passage: c.text })),
      slots: plan.slots.map((s) => ({ slot: s.n, type: s.type, passages: s.chunks })),
    },
  };
}

/** The record a sample becomes (dataset-formats.ts canonical record). */
export function recordOf(s: RawSample, local: TestsetLocal, chunkIds: string[], model: string | undefined): TestsetRecord {
  const byId = new Map(local.corpus.chunks.map((c) => [c.id, c]));
  const answerable = s.type !== 'unanswerable' && s.answerable !== false;
  const used = answerable ? chunkIds.map((id) => byId.get(id)!).filter(Boolean) : [];
  const docs = [...new Set(used.map((c) => c.doc))];
  return {
    id: `ts-${hashOf(`${s.question}|${chunkIds.join(',')}`)}`,
    question: s.question.trim(),
    reference: answerable ? (s.reference ?? '').trim() : UNANSWERABLE_REFERENCE,
    reference_ids: used.map((c) => c.id),
    reference_contexts: used.map((c) => c.text),
    answerable,
    tags: ['generated', s.type, ...docs.map((d) => `doc:${slugOf(d)}`)],
    metadata: { generator: { task: 'rag-generate-testset', version: TESTSET_VERSION, ...(model ? { model } : {}), seed: local.seed, batch: local.batch, type: s.type } },
  };
}

export function proposeTestset(a: { value?: unknown }, input: AiTaskInput): { items: DraftItem[]; notes: string[]; problems: string[] } {
  const local = input.local as TestsetLocal | undefined;
  if (!local) throw new ApsError('ValidationError', 'A test set is made from documents: name them (paths or urls)');
  const samples = ((a.value as { samples?: RawSample[] } | undefined)?.samples ?? []).filter((s) => s && typeof s === 'object');
  const known = new Set(local.corpus.chunks.map((c) => c.id));
  const notes: string[] = [];
  const problems: string[] = [];
  const items: DraftItem[] = [];
  const seen = new Set<number>();
  for (const s of samples) {
    const slot = local.slots.find((x) => x.n === (s as { slot?: number }).slot) ?? local.slots[items.length];
    if (!slot || typeof s.question !== 'string' || !s.question.trim()) {
      problems.push(`A sample has no question (slot ${String((s as { slot?: unknown }).slot ?? '?')}); write one per slot.`);
      continue;
    }
    if (seen.has(slot.n)) {
      notes.push(`Slot ${slot.n} was answered twice; the first sample is kept.`);
      continue;
    }
    seen.add(slot.n);
    // the type is the slot's, whatever the model wrote: the mix of the test set is the person's choice
    const type = slot.type;
    let ids = asStrings(s.chunks).filter((id) => known.has(id));
    if (type !== 'unanswerable' && !ids.length) {
      ids = slot.chunks;
      notes.push(`Slot ${slot.n}: the sample named no passage of the documents; the slot's passages are used.`);
    }
    const rec = recordOf({ ...s, type }, local, ids, input.model);
    items.push({ kind: 'dataset-row', title: rec.question, after: `${JSON.stringify(rec)}\n`, language: 'json', data: { dataset: local.dataset, record: rec, corpus: local.token, type, ...(local.judge ? { judge: local.judge } : {}) } });
  }
  const missing = local.slots.filter((s) => !seen.has(s.n)).length;
  if (missing && items.length) notes.push(`${missing} of ${local.slots.length} slots got no sample.`);
  if (!items.length) problems.push('No usable sample: answer with {"samples": [...]} with one sample per slot.');
  return { items, notes, problems };
}

export function describeTestset(value: unknown, items: ProposalItem[]): { summary: string; assumptions: string[] } {
  const byType = new Map<string, number>();
  for (const i of items) byType.set((i.data as { type?: string }).type ?? '?', (byType.get((i.data as { type?: string }).type ?? '?') ?? 0) + 1);
  return {
    summary: `${items.length} proposed question${items.length === 1 ? '' : 's'} (${[...byType].map(([t, n]) => `${n} ${t}`).join(', ')}) for ${(items[0]?.data as { dataset?: string } | undefined)?.dataset ?? 'a dataset'}.`,
    assumptions: ['Reference answers were written by a model from the passages; each is checked against them, but read them before relying on them.'],
  };
}

export { BATCH_SAMPLES };
