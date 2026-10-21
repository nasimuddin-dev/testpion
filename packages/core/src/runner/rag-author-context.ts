/**
 * What the AI task `rag-author-evaluation` reads from the workspace (registry `prepareContext`): the RAG target's shape, the
 * dataset's columns and a few records, an outline of documents or of an API definition, and the metric catalogue seen through
 * the inputs this data can supply. It lives in runner/ because it reads the workspace's datasets and saved evaluations, which
 * eval/rag may not import. Nothing secret is read: a target's request (URL, headers, auth) is never sent, only what its
 * mapping reads out of the response.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import type { RagTarget } from '@testpion/shared';
import { ApsError } from '../errors.js';
import type { PreparedItem } from '../ai/tasks/registry.js';
import { catalogueContext, catalogueFor, suppliedInputs } from '../eval/rag/author/catalogue.js';
import type { AuthorLocal } from '../eval/rag/author/types.js';
import { METRIC_PRESETS } from '../eval/rag/catalogue-presets.js';
import { findRagTarget } from '../eval/rag/targets.js';
import { openApiOutline } from '../openapi/outline.js';
import { listSpecs } from '../openapi/spec-files.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { readWorkspaceDataset } from './datasets.js';
import { EVALUATIONS_LIBRARY } from './saved-evaluations.js';

const MAX_RECORDS = 300;
const SHOWN_RECORDS = 5;
const clip = (v: unknown, n = 400) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** What the mapping reads, without the request: the model needs to know what the system returns, not how it is called. */
export function targetShape(t: RagTarget & { name: string }) {
  return {
    name: t.name,
    protocol: t.protocol,
    ...(t.description ? { description: clip(t.description, 300) } : {}),
    readOnly: t.readOnly === true,
    reads: {
      answer: !!t.mapping?.answer,
      contexts: !!t.mapping?.contexts,
      contextIds: !!t.mapping?.context?.id,
      contextScores: !!t.mapping?.context?.score,
      usage: !!(t.mapping?.usage?.input || t.mapping?.usage?.output || t.mapping?.usage?.total),
      latency: true,
    },
  };
}

/** Titles and headings of documents (a file, or the files of a folder of the workspace), never their text. */
export function docsOutline(store: WorkspaceStore, paths: string[]): Array<{ file: string; title?: string; headings: string[] }> {
  const out: Array<{ file: string; title?: string; headings: string[] }> = [];
  const add = (file: string) => {
    if (out.length >= 20 || !/\.(md|markdown|txt|html?)$/i.test(file)) return;
    let text: string;
    try {
      if (statSync(file).size > 400_000) return;
      text = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    const heads = /\.html?$/i.test(extname(file))
      ? [...text.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => m[1]!.replace(/<[^>]+>/g, '').trim())
      : [...text.matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => m[1]!.trim());
    const rel = relative(store.root, file).split(sep).join('/');
    out.push({ file: rel, ...(heads[0] ? { title: clip(heads[0], 120) } : {}), headings: heads.slice(1, 9).map((h) => clip(h, 100)!).filter(Boolean) });
  };
  const walk = (p: string, depth: number) => {
    if (!existsSync(p)) throw new ApsError('ValidationError', `No such document or folder in the workspace: ${relative(store.root, p).split(sep).join('/')}`);
    if (statSync(p).isDirectory()) {
      if (depth < 3) for (const e of readdirSync(p).sort()) if (!e.startsWith('.')) walk(join(p, e), depth + 1);
    } else add(p);
  };
  for (const p of paths) walk(store.safePath(p), 0);
  return out;
}

export interface AuthorChoices {
  target: string;
  dataset?: string;
  docs?: string[];
  spec?: string;
  goal?: string;
  /** The judge the person named (provider/model): it wins over the plan's. */
  judge?: string;
  name?: string;
}

const strOf = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function choicesOf(c: Record<string, unknown>): AuthorChoices {
  const target = strOf(c.target);
  if (!target) throw new ApsError('ValidationError', 'Name the RAG target to author an evaluation for', { suggestions: ['`testpion rag targets` lists them; connect one in AI Lab ▸ RAG first.'] });
  return {
    target,
    dataset: strOf(c.dataset),
    docs: Array.isArray(c.docs) ? c.docs.map(String).filter(Boolean) : undefined,
    spec: strOf(c.spec),
    goal: strOf(c.goal),
    judge: strOf(c.judge),
    name: strOf(c.name),
  };
}

/** The registry's `prepareContext` of the task. */
export async function prepareAuthorContext(store: WorkspaceStore, context: Record<string, unknown>): Promise<PreparedItem> {
  const c = choicesOf(context);
  const target = findRagTarget(store, c.target);
  let dataset: AuthorLocal['dataset'];
  if (c.dataset) {
    const d = await readWorkspaceDataset(store, c.dataset, { limit: MAX_RECORDS });
    if (!d.rows.length) throw new ApsError('ValidationError', `datasets/${d.name} has no records`);
    dataset = { name: d.name, records: d.rows, total: d.count };
  }
  const inputs = suppliedInputs(dataset?.records ?? [], target);
  const rows = catalogueFor(inputs);
  const local: AuthorLocal = {
    target,
    ...(dataset ? { dataset } : {}),
    ...(c.judge ? { judge: { provider: c.judge.split('/')[0]!, ...(c.judge.includes('/') ? { model: c.judge.split('/').slice(1).join('/') } : {}) } } : {}),
    ...(c.name ? { name: c.name } : {}),
    existing: store.getLibrary<{ name?: string }>(EVALUATIONS_LIBRARY).items.map((i) => i.name),
    inputs,
  };
  let api: unknown;
  if (c.spec) {
    const known = listSpecs(store);
    const file = known.find((s) => s === c.spec || s.endsWith(`/${c.spec}`));
    if (!file) throw new ApsError('ValidationError', `No API definition "${c.spec}" in specs/`, { suggestions: [`Found: ${known.join(', ') || 'none'}`] });
    const o = openApiOutline(readFileSync(store.safePath(file), 'utf8'));
    api = { file, operations: o.tags.flatMap((t) => t.operations).slice(0, 40).map((op) => `${op.method} ${op.path}${op.summary ? ` — ${clip(op.summary, 80)}` : ''}`) };
  }
  const docs = c.docs?.length ? docsOutline(store, c.docs) : undefined;
  return {
    label: target.name,
    local,
    context: {
      ...(c.goal ? { goal: clip(c.goal, 1000) } : {}),
      target: targetShape(target),
      dataset: dataset
        ? {
            name: dataset.name,
            records: dataset.total,
            // which inputs the data has and where each comes from: a metric needing another one cannot run
            supplies: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v])),
            sample: dataset.records.slice(0, SHOWN_RECORDS).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, clip(v)]))),
          }
        : { note: 'No dataset was chosen: the evaluation will need one before it can run.' },
      ...(docs ? { docs } : {}),
      ...(api ? { api } : {}),
      ...catalogueContext(rows),
      presets: METRIC_PRESETS.map((p) => ({ id: p.id, description: p.description, metrics: p.metrics.map((m) => (typeof m === 'string' ? m : m.metric)) })),
    },
  };
}

/**
 * What a target and a dataset can support, before anything is asked of a model: the inputs the data supplies and how many
 * catalogue metrics can run on it (the window shows it beside "Draft an evaluation with AI"; nothing is sent).
 */
export async function authorInputs(store: WorkspaceStore, choices: { target: string; dataset?: string }): Promise<{ supplies: Record<string, string>; runnable: number; total: number; notRunnable: Array<{ id: string; missing: string[] }>; records: number }> {
  const target = findRagTarget(store, choices.target);
  const d = choices.dataset ? await readWorkspaceDataset(store, choices.dataset, { limit: MAX_RECORDS }) : undefined;
  const supplies = suppliedInputs(d?.rows ?? [], target);
  const rows = catalogueFor(supplies);
  return { supplies: supplies as Record<string, string>, runnable: rows.filter((r) => r.runnable).length, total: rows.length, notRunnable: rows.filter((r) => !r.runnable).map((r) => ({ id: r.id, missing: r.missing ?? [] })), records: d?.count ?? 0 };
}
