/**
 * One sample of a bot with sources, by stage (R-4): the question, what was retrieved, what the answer used, the answer. Pure
 * text and numbers from the stored sample and its metric results, so the strip above the sample says in four boxes where it
 * went wrong, and the words are the same wherever the sample is opened.
 */
import { plural } from '@testpion/shared';

export interface StageSample {
  question?: string;
  answer?: string;
  reference?: string;
  referenceIds?: string[];
  contexts?: Array<{ id?: string; text: string; score?: number }>;
}

export interface StageClaim {
  ok: boolean;
}

export interface StageCheck {
  passed: boolean;
}

export interface Stage {
  id: 'question' | 'retrieved' | 'used' | 'answer';
  title: string;
  summary: string;
  state: 'ok' | 'bad' | 'info';
}

const WORD = /[\p{L}\p{N}]+/gu;
const words = (s: string): Set<string> => new Set((s.toLowerCase().match(WORD) ?? []).filter((w) => w.length > 2));

/** The retrieved document whose words are closest to a text (the reference answer, for a right document that was not found): by shared words. */
export function nearestChunk(text: string, contexts: ReadonlyArray<{ id?: string; text: string }>): { id: string; rank: number; overlap: number } | undefined {
  const want = words(text);
  if (!want.size) return undefined;
  let best: { id: string; rank: number; overlap: number } | undefined;
  contexts.forEach((c, i) => {
    const have = words(c.text);
    let shared = 0;
    for (const w of want) if (have.has(w)) shared++;
    const overlap = Math.round((shared / want.size) * 100) / 100;
    if (overlap > 0 && (!best || overlap > best.overlap)) best = { id: c.id ?? `doc-${i + 1}`, rank: i + 1, overlap };
  });
  return best;
}

/**
 * The four stages of a sample. `claims` are what the focused measure judged in the answer (empty when it judged none),
 * `checks` every measure's result for the sample.
 */
export function stagesOf(sample: StageSample | null | undefined, claims: readonly StageClaim[], checks: readonly StageCheck[]): Stage[] {
  const got = new Set((sample?.contexts ?? []).map((c, i) => c.id ?? `doc-${i + 1}`));
  const gold = [...new Set(sample?.referenceIds ?? [])];
  const missed = gold.filter((g) => !got.has(g));
  const n = sample?.contexts?.length ?? 0;
  const retrieved: Stage = !n
    ? { id: 'retrieved', title: 'Retrieved', summary: gold.length ? `Nothing was retrieved (${plural(gold.length, 'right document')} needed)` : 'Nothing was retrieved', state: gold.length ? 'bad' : 'info' }
    : gold.length
      ? { id: 'retrieved', title: 'Retrieved', summary: `${plural(n, 'document')} · right documents found ${gold.length - missed.length} of ${gold.length}`, state: missed.length ? 'bad' : 'ok' }
      : { id: 'retrieved', title: 'Retrieved', summary: plural(n, 'document'), state: 'info' };
  const backed = claims.filter((c) => c.ok).length;
  const used: Stage = claims.length
    ? { id: 'used', title: 'Used', summary: `${backed} of ${plural(claims.length, 'statement')} backed by the documents`, state: backed === claims.length ? 'ok' : 'bad' }
    : { id: 'used', title: 'Used', summary: 'No statements were judged for this measure', state: 'info' };
  const failed = checks.filter((c) => !c.passed).length;
  const answer: Stage = {
    id: 'answer',
    title: 'Answer',
    summary: !checks.length ? 'No measure ran' : failed ? `${failed} of ${plural(checks.length, 'measure')} failed` : `All ${plural(checks.length, 'measure')} passed`,
    state: !checks.length ? 'info' : failed ? 'bad' : 'ok',
  };
  const q = (sample?.question ?? '').replace(/\s+/g, ' ').trim();
  return [{ id: 'question', title: 'Question', summary: q ? (q.length > 60 ? `${q.slice(0, 59)}…` : q) : 'No question stored', state: 'info' }, retrieved, used, answer];
}

/** The first stage that went wrong: where to look first (the retrieval before the answer it fed). */
export const firstBadStage = (stages: readonly Stage[]): Stage['id'] | undefined => stages.find((s) => s.state === 'bad')?.id;
