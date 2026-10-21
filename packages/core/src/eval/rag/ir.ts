/**
 * Information-retrieval measures over the retrieved chunk ids and the gold ids (binary relevance), and the string
 * similarity the lexical metrics use. Pure functions with their worked examples in tests/unit/rag-ir.test.ts.
 * Retrieved ids are used in rank order with repeats dropped (a chunk found twice is one document).
 */

import { levenshtein } from '../../util/text-distance.js';

const dedupe = (ids: string[]) => [...new Set(ids)];

/** The top k retrieved ids (k defaults to all). */
const top = (retrieved: string[], k?: number) => dedupe(retrieved).slice(0, k && k > 0 ? Math.floor(k) : undefined);

export const recallAt = (retrieved: string[], gold: string[], k?: number): number => {
  const g = new Set(gold);
  return g.size ? top(retrieved, k).filter((id) => g.has(id)).length / g.size : 0;
};

/** Divided by k even when fewer were retrieved: a retriever that returns 2 of 5 asked for is not 100% precise. */
export const precisionAt = (retrieved: string[], gold: string[], k: number): number => {
  const g = new Set(gold);
  return k > 0 ? top(retrieved, k).filter((id) => g.has(id)).length / k : 0;
};

export const hitRateAt = (retrieved: string[], gold: string[], k?: number): number => {
  const g = new Set(gold);
  return top(retrieved, k).some((id) => g.has(id)) ? 1 : 0;
};

export const mrrAt = (retrieved: string[], gold: string[], k?: number): number => {
  const g = new Set(gold);
  const i = top(retrieved, k).findIndex((id) => g.has(id));
  return i < 0 ? 0 : 1 / (i + 1);
};

export const ndcgAt = (retrieved: string[], gold: string[], k?: number): number => {
  const g = new Set(gold);
  if (!g.size) return 0;
  const ranked = top(retrieved, k);
  const dcg = ranked.reduce((a, id, i) => a + (g.has(id) ? 1 / Math.log2(i + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(g.size, k && k > 0 ? Math.floor(k) : g.size) }).reduce<number>((a, _, i) => a + 1 / Math.log2(i + 2), 0);
  return ideal ? dcg / ideal : 0;
};

/** Average precision: gold chunks never retrieved count as 0 (the divisor is all the gold ids). */
export const averagePrecisionAt = (retrieved: string[], gold: string[], k?: number): number => {
  const g = new Set(gold);
  if (!g.size) return 0;
  let hits = 0;
  let sum = 0;
  top(retrieved, k).forEach((id, i) => {
    if (g.has(id)) sum += ++hits / (i + 1);
  });
  return sum / g.size;
};

export const rPrecision = (retrieved: string[], gold: string[]): number => {
  const r = new Set(gold).size;
  return r ? precisionAt(retrieved, gold, r) : 0;
};

/** Rank-weighted average precision of a list of relevant / not relevant flags (the Ragas context precision formula). */
export function rankedAveragePrecision(relevant: boolean[]): number {
  const total = relevant.filter(Boolean).length;
  if (!total) return 0;
  let hits = 0;
  let sum = 0;
  relevant.forEach((r, i) => {
    if (r) sum += ++hits / (i + 1);
  });
  return sum / total;
}

/* ------------------------------------------------------------------ string similarity */

const MAX_CHARS = 4000;

export { levenshtein };

/** 1 − distance / the longer length (1 for two empty texts); texts are cut at 4,000 characters so a long chunk cannot stall a run. */
export function similarityRatio(a: string, b: string): number {
  const x = a.slice(0, MAX_CHARS);
  const y = b.slice(0, MAX_CHARS);
  const longer = Math.max(x.length, y.length);
  return longer ? 1 - levenshtein(x, y) / longer : 1;
}

/* ------------------------------------------------------------------ holes and graded relevance */

/** BEIR's Hole@k: the share of the top k that carries no relevance label at all (a hole in the judgements, not an irrelevant chunk). */
export const holeAt = (retrieved: string[], labelled: Iterable<string>, k: number): number => {
  const known = new Set(labelled);
  return k > 0 ? top(retrieved, k).filter((id) => !known.has(id)).length / k : 0;
};

/**
 * nDCG@k with graded relevance (qrels): `gain: linear` weighs a chunk by its grade, `exponential` by 2^grade − 1. The ideal
 * order puts the best grades first. A chunk without a grade is 0; a gold id without a grade counts as grade 1.
 */
export function ndcgGraded(retrieved: string[], grades: Record<string, number>, k: number | undefined, o: { gain?: 'linear' | 'exponential'; gold?: string[] } = {}): number {
  const g: Record<string, number> = { ...grades };
  for (const id of o.gold ?? []) if (g[id] === undefined) g[id] = 1;
  const gain = (rel: number) => (o.gain === 'exponential' ? 2 ** Math.max(0, rel) - 1 : Math.max(0, rel));
  const ranked = top(retrieved, k);
  const dcg = ranked.reduce((a, id, i) => a + gain(g[id] ?? 0) / Math.log2(i + 2), 0);
  const ideal = Object.values(g)
    .map(gain)
    .sort((a, b) => b - a)
    .slice(0, k && k > 0 ? Math.floor(k) : undefined)
    .reduce((a, x, i) => a + x / Math.log2(i + 2), 0);
  return ideal > 0 ? dcg / ideal : 0;
}
