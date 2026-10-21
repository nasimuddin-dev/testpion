/**
 * What the model is asked about in one call (planning/rag-testing.md §4b): a deterministic, seeded selection of chunks spread
 * over the documents, and for each requested sample a "slot" saying its type and the chunk(s) to use. The same seed and the
 * same documents always ask about the same chunks, so a run can be repeated and compared. Multi-hop slots get a PAIR of
 * chunks: a neighbour in the same document or the chunk that shares the most rare terms.
 */
import { BATCH_SAMPLES, TESTSET_TYPES, type Chunk, type TestsetType } from './types.js';
import { seeded, termSet } from './lexical.js';

export interface Slot {
  n: number;
  type: TestsetType;
  chunks: string[];
  /** Who asks and how they word it (from the run's personas and styles, in turn). */
  persona?: string;
  style?: string;
}

/** Chunks in the order they are asked about: shuffled by the seed, then interleaved so each document comes up in turn. */
export function askOrder(chunks: Chunk[], seed: string): Chunk[] {
  const rnd = seeded(seed);
  const byDoc = new Map<string, Chunk[]>();
  for (const c of chunks) byDoc.set(c.doc, [...(byDoc.get(c.doc) ?? []), c]);
  const lists = [...byDoc.values()].map((l) => {
    const a = [...l];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  });
  const out: Chunk[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]!);
  return out;
}

/** The type of the n-th sample of a run: the requested types in turn (unanswerable and adversarial come after the answerable ones in each round). */
export function typeAt(types: TestsetType[], n: number): TestsetType {
  const order = TESTSET_TYPES.filter((t) => types.includes(t));
  return order[n % order.length]!;
}

/** The chunk that goes with `c` for a question across two passages. */
function partnerOf(c: Chunk, chunks: Chunk[]): Chunk | undefined {
  if (chunks.length < 2) return undefined;
  const df = new Map<string, number>();
  const sets = new Map<string, Set<string>>();
  for (const x of chunks) {
    const s = termSet(x.text);
    sets.set(x.id, s);
    for (const t of s) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const mine = sets.get(c.id)!;
  let best: { c: Chunk; score: number } | undefined;
  for (const x of chunks) {
    if (x.id === c.id) continue;
    let score = 0;
    for (const t of sets.get(x.id)!) if (mine.has(t)) score += 1 / (df.get(t) ?? 1);
    // a neighbour in the same document is a natural second hop when nothing shares a rare term
    if (x.doc === c.doc && Math.abs(Number(x.id.split('#')[1]) - Number(c.id.split('#')[1])) === 1) score += 0.25;
    if (!best || score > best.score) best = { c: x, score };
  }
  return best && best.score > 0 ? best.c : chunks.find((x) => x.id !== c.id);
}

interface BatchPlan {
  slots: Slot[];
  /** The chunks the slots use, once each. */
  chunks: Chunk[];
}

export function planBatch(chunks: Chunk[], o: { seed: string; batch: number; count: number; types: TestsetType[]; personas?: string[]; styles?: string[] }): BatchPlan {
  const order = askOrder(chunks, o.seed);
  const start = o.batch * BATCH_SAMPLES;
  const slots: Slot[] = [];
  const used = new Map<string, Chunk>();
  for (let g = start; g < Math.min(o.count, start + BATCH_SAMPLES); g++) {
    const type = typeAt(o.types, g);
    const base = order[g % order.length]!;
    const picked = [base];
    if (type === 'multi-hop') {
      const p = partnerOf(base, chunks);
      if (p) picked.push(p);
    }
    for (const c of picked) used.set(c.id, c);
    // the voices go round on their own cycles, so five personas and two styles meet in every combination over a long run
    const persona = o.personas?.length ? o.personas[g % o.personas.length] : undefined;
    const style = o.styles?.length ? o.styles[g % o.styles.length] : undefined;
    slots.push({ n: g + 1, type, chunks: picked.map((c) => c.id), ...(persona ? { persona } : {}), ...(style ? { style } : {}) });
  }
  return { slots, chunks: [...used.values()] };
}

export const batchesOf = (count: number): number => Math.ceil(count / BATCH_SAMPLES);
