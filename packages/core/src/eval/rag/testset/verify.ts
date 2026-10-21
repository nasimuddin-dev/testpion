/**
 * The verifiers of a generated test set (planning/rag-testing.md §4b). A model wrote each question and its reference answer;
 * before a person reads them the engine checks what it can:
 *
 *  - `testset-support`: the reference is supported by its chunks. First a lexical check (the share of the reference's content
 *    words found in the chunks: under 40% fails, under 60% warns), a warning when the question copies the chunk, then the
 *    entailment pass by the judge (every claim of the reference stated by the chunks), when a judge is available.
 *  - `testset-answerable`: an unanswerable question must not be answerable from the corpus (BM25 over ALL chunks: a top-3 chunk
 *    holding 70% of the question's content words fails, 55% warns); an answerable one should be retrievable (its source chunk in
 *    the top 5, else a warning that a retriever may not find it).
 *  - `testset-duplicate`: a question whose word set is 80% the same as an earlier one of the batch, or one already in the dataset.
 */
import { existsSync, readFileSync } from 'node:fs';
import { registerVerifier, type VerifyContext } from '../../../ai/verify.js';
import type { ProposalItem, VerificationBadge } from '../../../ai/proposal.js';
import { judgeCall, type JudgeRef } from '../judge.js';
import { parseRagDatasetText } from '../dataset-formats.js';
import { corpusOf } from './corpus-cache.js';
import { bm25, copiedShare, coverage, jaccard, termSet } from './lexical.js';
import { REFERENCE_SUPPORT } from './prompts.js';
import type { TestsetRecord } from './types.js';

export const SUPPORT_FAIL = 0.4;
export const SUPPORT_WARN = 0.6;
export const ANSWERABLE_FAIL = 0.7;
export const ANSWERABLE_WARN = 0.55;
export const DUPLICATE_AT = 0.8;
export const COPY_AT = 0.8;

interface RowData {
  dataset?: string;
  record?: TestsetRecord;
  corpus?: string;
  judge?: JudgeRef;
}
const dataOf = (item: ProposalItem): RowData | undefined => (item.kind === 'dataset-row' ? (item.data as RowData | undefined) : undefined);
const pct = (n: number) => `${Math.round(n * 100)}%`;

export async function verifySupport(item: ProposalItem, ctx: VerifyContext): Promise<VerificationBadge | undefined> {
  const d = dataOf(item);
  if (!d?.record) return undefined;
  const r = d.record;
  if (!r.answerable) return { verifier: 'testset-support', status: 'pass', label: 'unanswerable: no reference to support', detail: 'It is checked against the corpus instead (testset-answerable).' };
  const texts = r.reference_contexts.join('\n\n');
  if (!texts || !r.reference.trim()) return { verifier: 'testset-support', status: 'fail', label: 'no reference answer or no source chunk' };
  const cov = coverage(r.reference, texts);
  if (cov < SUPPORT_FAIL) return { verifier: 'testset-support', status: 'fail', label: `only ${pct(cov)} of the reference's words are in its chunks`, detail: 'The reference says things its source chunks do not.' };
  const copy = Math.max(...r.reference_contexts.map((c) => copiedShare(r.question, c)));
  const host = ctx.services?.ragJudge;
  let entail: VerificationBadge | undefined;
  if (host && !host.dry) {
    try {
      const a = await judgeCall(host, REFERENCE_SUPPORT, { question: r.question, answer: r.reference, contexts: r.reference_ids.map((id, i) => ({ id, text: r.reference_contexts[i] ?? '' })) }, { judge: d.judge, signal: ctx.signal });
      const bad = a.verdict.items.filter((i) => !i.verdict);
      entail = bad.length
        ? { verifier: 'testset-support', status: 'fail', label: `${bad.length} of ${a.verdict.items.length} claims of the reference are not in its chunks`, detail: bad.map((b) => `“${b.text}”: ${b.reason}`).join(' | ') }
        : { verifier: 'testset-support', status: 'pass', label: `the judge finds all ${a.verdict.items.length} claims in the chunks`, detail: `Lexical overlap ${pct(cov)}. Judge: ${a.judge.provider}/${a.judge.model}.` };
    } catch (e) {
      entail = { verifier: 'testset-support', status: 'warn', label: `lexical overlap ${pct(cov)}; the judge did not check it`, detail: (e as Error).message };
    }
  } else if (host?.dry) entail = { verifier: 'testset-support', status: 'skip', label: `lexical overlap ${pct(cov)}; nothing sent (dry run)` };
  else entail = { verifier: 'testset-support', status: cov < SUPPORT_WARN ? 'warn' : 'pass', label: `lexical overlap ${pct(cov)}; no judge to check the claims`, detail: 'Set a judge (Settings ▸ AI assistant, or --judge) to have every claim checked against its chunks.' };
  if (copy >= COPY_AT && entail.status !== 'fail') return { verifier: 'testset-support', status: 'warn', label: 'the question copies the text of its chunk', detail: `${pct(copy)} of the question's words are a run from the chunk: a retriever finds it by string match, which tests little.` };
  if (entail.status === 'pass' && cov < SUPPORT_WARN) return { ...entail, status: 'warn' };
  return entail;
}

export function verifyAnswerable(item: ProposalItem): VerificationBadge | undefined {
  const d = dataOf(item);
  if (!d?.record) return undefined;
  const r = d.record;
  const corpus = corpusOf(d.corpus);
  if (!corpus) return { verifier: 'testset-answerable', status: 'skip', label: 'corpus not available', detail: 'The documents are kept in memory while a test set is made; generate it again to check this.' };
  const top = bm25(corpus.chunks, r.question, r.answerable ? 5 : 3);
  if (!r.answerable) {
    const best = top.reduce<(typeof top)[number] | undefined>((b, x) => (!b || x.covers > b.covers ? x : b), undefined);
    if (best && best.covers >= ANSWERABLE_FAIL) return { verifier: 'testset-answerable', status: 'fail', label: `${best.chunk.id} holds ${pct(best.covers)} of the question's words`, detail: 'The question may be answerable from the documents. Mark it answerable by adding a reference, or drop it.' };
    if (best && best.covers >= ANSWERABLE_WARN) return { verifier: 'testset-answerable', status: 'warn', label: `${best.chunk.id} holds ${pct(best.covers)} of the question's words`, detail: 'Close to answerable: read it before keeping it as an unanswerable question.' };
    return { verifier: 'testset-answerable', status: 'pass', label: 'no chunk of the corpus answers it' };
  }
  const found = r.reference_ids.some((id) => top.some((x) => x.chunk.id === id));
  return found ? { verifier: 'testset-answerable', status: 'pass', label: 'its source chunk is among the top 5 for the question' } : { verifier: 'testset-answerable', status: 'warn', label: 'its source chunk is not among the top 5 by keyword search', detail: 'Fine for a hard question; a keyword-based retriever may not find the source.' };
}

/** Question word sets of earlier items of the same pass (a pass starts at the item `i1`), by corpus token and batch. */
const seen = new Map<string, Array<{ id: string; terms: Set<string>; question: string }>>();
const existing = new Map<string, { at: number; terms: Array<{ terms: Set<string>; question: string }> }>();

function datasetQuestions(ctx: VerifyContext, rel: string): Array<{ terms: Set<string>; question: string }> {
  if (!ctx.store) return [];
  try {
    const file = ctx.store.safePath(rel);
    if (!existsSync(file)) return [];
    const hit = existing.get(file);
    if (hit && Date.now() - hit.at < 5000) return hit.terms;
    const terms = parseRagDatasetText(readFileSync(file, 'utf8'), 'jsonl')
      .map((r) => String(r.question ?? ''))
      .filter(Boolean)
      .map((question) => ({ terms: termSet(question), question }));
    existing.set(file, { at: Date.now(), terms });
    return terms;
  } catch {
    return [];
  }
}

export function verifyDuplicate(item: ProposalItem, ctx: VerifyContext): VerificationBadge | undefined {
  const d = dataOf(item);
  if (!d?.record) return undefined;
  const key = `${d.corpus ?? ''}:${d.record.metadata.generator.batch}`;
  if (item.id === 'i1') seen.delete(key);
  const list = seen.get(key) ?? [];
  const terms = termSet(d.record.question);
  const earlier = list.find((x) => x.id !== item.id && jaccard(terms, x.terms) >= DUPLICATE_AT);
  list.push({ id: item.id, terms, question: d.record.question });
  seen.set(key, list);
  if (earlier) return { verifier: 'testset-duplicate', status: 'fail', label: 'asks the same as an earlier question', detail: `“${earlier.question}”` };
  const there = d.dataset ? datasetQuestions(ctx, d.dataset).find((x) => jaccard(terms, x.terms) >= DUPLICATE_AT) : undefined;
  if (there) return { verifier: 'testset-duplicate', status: 'fail', label: `already in ${d.dataset}`, detail: `“${there.question}”` };
  return { verifier: 'testset-duplicate', status: 'pass', label: 'not a duplicate' };
}

registerVerifier('testset-support', verifySupport);
registerVerifier('testset-answerable', verifyAnswerable);
registerVerifier('testset-duplicate', verifyDuplicate);

