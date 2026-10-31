/**
 * The embedding map of a bot's run (R-12): its questions, the right documents and the documents it retrieved, placed on a plane by
 * meaning. Texts are embedded by the evaluation's embedding model (or `embedder: provider/model`), then projected to two dimensions
 * with a principal-component analysis (deterministic, no extra package). Two findings are read from the distances, never from a judge:
 *  - **look-alikes**: a retrieved document that is not a right document but reads almost like one (the bot may take the wrong one);
 *  - **far questions**: a question whose meaning is far from every document seen (the documents may not cover it).
 * It calls the embedding model once per 64 texts and reads the run's stored samples: the bot is not asked again.
 */
import { ApsError } from '../errors.js';
import type { ProviderRegistry } from '../ai/index.js';
import { evalCaseKey } from './report.js';
import { resolveRunRef } from '../runner/eval-matrix-runs.js';
import { readRunSummary } from '../runner/run-records.js';
import { runResults } from '../runner/run-results.js';
import { storedSample } from '../runner/rag-rescore.js';
import { findSavedEvaluation } from '../runner/saved-evaluations.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { cosine } from './text.js';

export type MapKind = 'question' | 'right' | 'retrieved';

export interface MapPoint {
  id: string;
  kind: MapKind;
  /** What to show: the question, or the document's id. */
  label: string;
  text: string;
  /** -1 to 1. */
  x: number;
  y: number;
}

export interface LookAlike {
  /** A retrieved document that is not a right document. */
  doc: string;
  /** The right document it reads like. */
  like: string;
  /** Cosine similarity, 0 to 1. */
  similarity: number;
  /** The questions that retrieved it. */
  cases: string[];
}

export interface FarQuestion {
  case: string;
  question: string;
  /** Similarity to the nearest document seen, 0 to 1. */
  nearest: number;
}

export interface EmbeddingMap {
  runId: string;
  embedder: string;
  points: MapPoint[];
  lookAlikes: LookAlike[];
  farQuestions: FarQuestion[];
  /** The documents or questions left out to keep the map readable. */
  leftOut: number;
  text: string;
}

const MAX_QUESTIONS = 100;
const MAX_DOCS = 200;
const BATCH = 64;

export const LOOK_ALIKE_AT = 0.85;
export const FAR_BELOW = 0.3;

const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);

/** The top `k` principal directions of the rows (centered), by power iteration with deflation: deterministic. */
export function pca2(rows: number[][]): Array<[number, number]> {
  const n = rows.length;
  if (n === 0) return [];
  const d = rows[0]!.length;
  const mean = new Array<number>(d).fill(0);
  for (const r of rows) for (let j = 0; j < d; j++) mean[j]! += r[j]! / n;
  const x = rows.map((r) => r.map((v, j) => v - mean[j]!));
  const axes: number[][] = [];
  for (let c = 0; c < 2; c++) {
    let v = Array.from({ length: d }, (_, j) => 1 + ((j * 7 + c * 13) % 5) / 10);
    for (let it = 0; it < 60; it++) {
      // w = Xᵀ (X v), minus what the earlier axes already explain
      const xv = x.map((r) => dot(r, v));
      const w = new Array<number>(d).fill(0);
      for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) w[j]! += x[i]![j]! * xv[i]!;
      for (const a of axes) {
        const p = dot(w, a);
        for (let j = 0; j < d; j++) w[j]! -= p * a[j]!;
      }
      const norm = Math.sqrt(dot(w, w));
      if (norm < 1e-12) break;
      v = w.map((q) => q / norm);
    }
    axes.push(v);
  }
  const xy = x.map((r) => [dot(r, axes[0]!), dot(r, axes[1]!)] as [number, number]);
  const span = (k: 0 | 1) => Math.max(1e-12, ...xy.map((p) => Math.abs(p[k])));
  const sx = span(0);
  const sy = span(1);
  return xy.map(([a, b]) => [Math.round((a / sx) * 1000) / 1000, Math.round((b / sy) * 1000) / 1000]);
}

/** The map of a finished bot run. `embedder` is `provider/model`; by default the provider of the evaluation's AI reviewer. */
export async function embeddingMap(
  store: WorkspaceStore,
  o: { run: string; embedder?: string; providers: ProviderRegistry; signal?: AbortSignal; lookAlikeAt?: number; farBelow?: number },
): Promise<EmbeddingMap> {
  const ref = resolveRunRef(store, o.run);
  const summary = readRunSummary(store, ref.runId);
  if (!summary) throw new ApsError('ConfigurationError', `Run ${ref.runId} has not finished`);
  let route = o.embedder?.trim();
  if (!route) {
    try {
      const j = findSavedEvaluation(store, summary.name).judge;
      if (j?.provider) route = j.provider;
    } catch {
      /* the evaluation was removed: the embedder must be named */
    }
  }
  if (!route) throw new ApsError('ConfigurationError', 'Say which embedding model to use: `embedder: provider/model` (a provider that embeds, such as a local Ollama model or the offline demo model)');
  const [providerId, ...rest] = route.split('/');
  const model = rest.join('/') || undefined;
  const provider = o.providers.get(providerId!);
  if (!provider.embed) throw new ApsError('ConfigurationError', `The provider ${provider.config.name} cannot embed text: choose another embedding model (embedder: provider/model)`);

  const questions: Array<{ id: string; case: string; text: string }> = [];
  const docs = new Map<string, { text: string; right: boolean; cases: Set<string> }>();
  let leftOut = 0;
  for await (const r of runResults(store, ref.runId)) {
    const s = storedSample(r);
    if (!s?.question) continue;
    const key = evalCaseKey(r.id);
    if (questions.length < MAX_QUESTIONS) questions.push({ id: `q:${key}`, case: key, text: s.question });
    else leftOut++;
    const right = new Set(s.referenceIds ?? []);
    (s.contexts ?? []).forEach((c, i) => {
      const id = String(c.id ?? `${key}#${i + 1}`);
      const text = String(c.text ?? '');
      if (!text.trim()) return;
      const have = docs.get(id);
      if (have) (have.cases.add(key), right.has(id) && (have.right = true));
      else if (docs.size < MAX_DOCS) docs.set(id, { text, right: right.has(id), cases: new Set([key]) });
      else leftOut++;
    });
  }
  if (!questions.length) throw new ApsError('ValidationError', 'This run kept no questions with their documents: run the evaluation again to draw its map');
  const items = [
    ...questions.map((q) => ({ id: q.id, kind: 'question' as const, label: q.text, text: q.text })),
    ...[...docs].map(([id, d]) => ({ id: `d:${id}`, kind: (d.right ? 'right' : 'retrieved') as MapKind, label: id, text: d.text })),
  ];
  const vectors: number[][] = [];
  for (let i = 0; i < items.length; i += BATCH) vectors.push(...(await provider.embed(items.slice(i, i + BATCH).map((x) => x.text), model, o.signal)));
  if (vectors.length !== items.length) throw new ApsError('NetworkError', 'The embedding model returned a different number of vectors than texts');
  const xy = pca2(vectors);
  const points: MapPoint[] = items.map((it, i) => ({ id: it.id, kind: it.kind, label: it.label, text: it.text.length > 200 ? `${it.text.slice(0, 199)}…` : it.text, x: xy[i]![0], y: xy[i]![1] }));

  const index = new Map(items.map((x, i) => [x.id, i] as const));
  const at = (id: string) => vectors[index.get(id)!]!;
  const rightIds = [...docs].filter(([, d]) => d.right).map(([id]) => id);
  const lookAt = o.lookAlikeAt ?? LOOK_ALIKE_AT;
  const lookAlikes: LookAlike[] = [];
  for (const [id, d] of docs) {
    if (d.right) continue;
    let best = { like: '', similarity: -1 };
    for (const rid of rightIds) {
      const sim = cosine(at(`d:${id}`), at(`d:${rid}`));
      if (sim > best.similarity) best = { like: rid, similarity: sim };
    }
    if (best.like && best.similarity >= lookAt) lookAlikes.push({ doc: id, like: best.like, similarity: Math.round(best.similarity * 1000) / 1000, cases: [...d.cases] });
  }
  lookAlikes.sort((a, b) => b.similarity - a.similarity);
  const farBelow = o.farBelow ?? FAR_BELOW;
  const farQuestions: FarQuestion[] = [];
  for (const q of questions) {
    let nearest = 0;
    for (const id of docs.keys()) nearest = Math.max(nearest, cosine(at(q.id), at(`d:${id}`)));
    if (docs.size && nearest < farBelow) farQuestions.push({ case: q.case, question: q.text, nearest: Math.round(nearest * 1000) / 1000 });
  }
  farQuestions.sort((a, b) => a.nearest - b.nearest);
  const embedder = `${provider.config.name}${model ? `/${model}` : ''}`;
  const text = [
    `${questions.length} questions and ${docs.size} documents placed by meaning (${embedder}).`,
    lookAlikes.length ? `${lookAlikes.length} retrieved ${lookAlikes.length === 1 ? 'document reads' : 'documents read'} almost like a right one: ${lookAlikes.slice(0, 3).map((l) => `${l.doc} ~ ${l.like}`).join(', ')}.` : 'No retrieved document reads like a right one it is not.',
    farQuestions.length ? `${farQuestions.length} ${farQuestions.length === 1 ? 'question is' : 'questions are'} far from every document seen: ${farQuestions.slice(0, 3).map((f) => f.case).join(', ')}.` : 'Every question has a document near it.',
  ].join(' ');
  return { runId: ref.runId, embedder, points, lookAlikes: lookAlikes.slice(0, 20), farQuestions: farQuestions.slice(0, 20), leftOut, text };
}
