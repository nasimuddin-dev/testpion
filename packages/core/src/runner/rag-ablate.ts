/**
 * Which document mattered? (R-11) For one sample of a finished bot run, the bot is asked again with the documents it retrieved, and again
 * without each one of them in turn. A document whose removal changes the answer is load-bearing; one that changes nothing is dead weight.
 * It works for a bot whose request takes the documents as input (`"documents": "{{documents}}"` or `{{document_texts}}` in its body): such a
 * bot answers from the documents it is given. Answers are compared by words (no judge, no model of ours), so the only cost is the calls to
 * the bot: n + 1 for n documents. The request carries the question and the documents of the stored sample; nothing else leaves.
 */
import type { RagTarget } from '@testpion/shared';
import type { EngineContext } from '../engine.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { ApsError } from '../errors.js';
import { tokenF1 } from '../eval/text.js';
import { callTarget } from '../eval/rag/run-target.js';
import { findRagTarget } from '../eval/rag/targets.js';
import { Tracer } from '../trace/tracer.js';
import { assertProductionStep } from '../net/production-guard.js';
import { normalizeTest } from './loader.js';
import { productionStep, ragStepRunner } from './execute.js';
import { resolveRunRef } from './eval-matrix-runs.js';
import { readRunSummary } from './run-records.js';
import { runResults } from './run-results.js';
import { storedSample } from './rag-rescore.js';
import { findSavedEvaluation } from './saved-evaluations.js';

/** The most documents asked about at once (each is one call to the bot). */
export const MAX_ABLATION_DOCUMENTS = 8;
/** An answer at least this alike (token F1) to the full one is "unchanged". */
export const SAME_ANSWER_AT = 0.8;

export interface AblationDocument {
  id: string;
  text: string;
  /** What the bot answered without this document. */
  answer: string;
  /** How alike that answer is to the one with every document, 0 to 1 (by words). */
  alike: number;
  /** The answer changed: this document was load-bearing. */
  loadBearing: boolean;
  /** With a reference answer: how much closer to it (positive) or farther from it (negative) the answer got without this document. */
  towardsReference?: number;
}

export interface Ablation {
  runId: string;
  resultId: string;
  question: string;
  /** What the bot answers with every document it was given. */
  answer: string;
  documents: AblationDocument[];
  /** Documents left out because the sample had more than the limit. */
  skipped: number;
  /** The calls made to the bot (documents + 1). */
  calls: number;
  text: string;
}

/** The sample of a result and the saved bot it called (the id the run kept; else the evaluation's target when that is still saved). */
async function sampleAndTarget(store: WorkspaceStore, runId: string, resultId: string): Promise<{ sample: ReturnType<typeof storedSample>; targetRef?: string; evaluation?: string }> {
  const summary = readRunSummary(store, runId);
  for await (const r of runResults(store, runId))
    if (r.id === resultId) {
      const kept = (r.metadata as { rag?: { targetId?: string } } | undefined)?.rag?.targetId;
      let targetRef = kept;
      if (!targetRef && summary) {
        try {
          targetRef = findSavedEvaluation(store, summary.name).target;
        } catch {
          /* the evaluation was never saved or was removed */
        }
      }
      return { sample: storedSample(r), targetRef, evaluation: summary?.name };
    }
  throw new ApsError('ValidationError', `No result "${resultId}" in run ${runId}`);
}

/** Whether a target's request takes the retrieved documents as input. */
export function acceptsDocuments(target: Pick<RagTarget, 'step'>): boolean {
  const text = JSON.stringify(target.step ?? {});
  return /\{\{\s*(documents|document_texts)\s*\}\}/.test(text);
}

export const ablationNeedsDocuments =
  'The bot\'s request does not take documents: add "documents": "{{documents}}" (a list of { id, text }) or "documents": "{{document_texts}}" (a list of texts) to its body, and make the bot answer from them.';

export interface AblationInfo {
  /** The calls to the bot an ablation of this sample makes. */
  calls: number;
  /** The documents asked about (at most the limit) and those left out. */
  documents: number;
  skipped: number;
  /** Whether the bot's request takes documents; when not, `reason` says what to add (the app shows it beside the disabled button). */
  possible: boolean;
  reason?: string;
}

/** What an ablation of a sample would do, without calling the bot: so the app can say the cost first, and why it is not possible. */
export async function ablationInfo(store: WorkspaceStore, o: { run: string; resultId: string; max?: number }): Promise<AblationInfo> {
  const ref = resolveRunRef(store, o.run);
  const { sample, targetRef } = await sampleAndTarget(store, ref.runId, o.resultId);
  const n = (sample?.contexts ?? []).filter((c) => String(c.text ?? '').trim()).length;
  const documents = Math.min(n, o.max ?? MAX_ABLATION_DOCUMENTS);
  const base = { calls: documents + 1, documents, skipped: Math.max(0, n - documents) };
  if (!n) return { ...base, possible: false, reason: 'This sample retrieved no documents' };
  if (!targetRef) return { ...base, possible: false, reason: 'This run kept no saved bot to ask again (its documents were written in the dataset, or it ran an older version)' };
  try {
    if (!acceptsDocuments(findRagTarget(store, targetRef))) return { ...base, possible: false, reason: ablationNeedsDocuments };
  } catch (e) {
    return { ...base, possible: false, reason: e instanceof Error ? e.message : String(e) };
  }
  return { ...base, possible: true };
}

export async function ablateSample(
  store: WorkspaceStore,
  ctx: EngineContext,
  o: { run: string; resultId: string; max?: number; signal?: AbortSignal },
): Promise<Ablation> {
  const ref = resolveRunRef(store, o.run);
  if (!readRunSummary(store, ref.runId)) throw new ApsError('ConfigurationError', `Run ${ref.runId} has not finished`);
  const found = await sampleAndTarget(store, ref.runId, o.resultId);
  const sample = found.sample;
  if (!sample?.question) throw new ApsError('ValidationError', `The result "${o.resultId}" kept no question and documents: run the evaluation again`);
  if (!found.targetRef) throw new ApsError('ValidationError', 'This run kept no saved bot to ask again: its documents were written in the dataset, or it ran an older version');
  const target = findRagTarget(store, found.targetRef);
  if (!acceptsDocuments(target)) throw new ApsError('ConfigurationError', ablationNeedsDocuments, { suggestions: ['Edit the bot in AI quality ▸ RAG bots ▸ Bots, or its target in the library.'] });
  const all = (sample.contexts ?? []).map((c, i) => ({ id: String(c.id ?? `doc-${i + 1}`), text: String(c.text ?? '') })).filter((d) => d.text.trim());
  if (!all.length) throw new ApsError('ValidationError', 'This sample retrieved no documents, so there is nothing to leave out');
  const max = o.max ?? MAX_ABLATION_DOCUMENTS;
  const docs = all.slice(0, max);

  const tracer = new Tracer('rag ablation', ctx.redactor);
  const root = tracer.start('rag ablation', 'test');
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  o.signal?.addEventListener('abort', onAbort);
  const svc = ctx.services;
  const runner = {
    normalize: (raw: Record<string, unknown>) => normalizeTest(raw),
    run: ragStepRunner(svc, root, controller.signal),
    guard: svc.production ? (step: Parameters<typeof productionStep>[0], sc: Parameters<typeof productionStep>[1]) => assertProductionStep(svc.production!, productionStep(step, sc)) : undefined,
  };
  const ask = async (list: Array<{ id: string; text: string }>) => {
    const c = await callTarget(target, sample!.question!, ctx.vars, runner as never, { documents: list, document_texts: list.map((d) => d.text) });
    return c.sample.answer ?? '';
  };
  try {
    const full = await ask(docs);
    const out: AblationDocument[] = [];
    for (const d of docs) {
      const answer = await ask(docs.filter((x) => x !== d));
      const alike = Math.round(tokenF1(answer, full) * 1000) / 1000;
      const toward = sample.reference ? Math.round((tokenF1(answer, sample.reference) - tokenF1(full, sample.reference)) * 1000) / 1000 : undefined;
      out.push({ id: d.id, text: d.text.length > 160 ? `${d.text.slice(0, 159)}…` : d.text, answer, alike, loadBearing: alike < SAME_ANSWER_AT, ...(toward !== undefined ? { towardsReference: toward } : {}) });
    }
    const load = out.filter((d) => d.loadBearing);
    const text = load.length
      ? `Without ${load.map((d) => d.id).join(', ')} the answer changes; ${out.length - load.length === 0 ? 'every other document' : `the other ${out.length - load.length} ${out.length - load.length === 1 ? 'document changes' : 'documents change'}`} nothing.`
      : `The answer stays the same without any single one of the ${out.length} documents: none of them is load-bearing on its own.`;
    return { runId: ref.runId, resultId: o.resultId, question: sample.question, answer: full, documents: out, skipped: Math.max(0, all.length - docs.length), calls: docs.length + 1, text };
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
    root.end({ status: 'ok' });
  }
}
