/**
 * Draft reference answers for a captured dataset (the AI task `rag-draft-references`; planning/rag-testing.md §4b "Capture
 * from traffic", B-33b). A dataset made from real calls has the question, the answer the system gave and the passages it
 * retrieved, but no reference answer, so only the metrics that need none can run. The model drafts a reference for each
 * record from ITS PASSAGES ONLY (the system's own answer is not sent: a hallucination would be copied), an unanswerable one
 * says so, and every draft goes through the same support check as a generated test set (the reference's claims must be in
 * the passages). The drafts are a proposal: a person reads them in the one review, and the ticked ones are written into the
 * dataset, replacing the record of the same id (one Undo puts the file back). Nothing is written without that review.
 */
import { readFileSync } from 'node:fs';
import { ApsError } from '../../../errors.js';
import type { AiPrivacy } from '../../../ai/ai-settings.js';
import type { ProposalItem } from '../../../ai/proposal.js';
import type { AiTaskInput, DraftItem, PreparedItem } from '../../../ai/tasks/registry.js';
import type { WorkspaceStore } from '../../../storage/workspace.js';
import { parseRagDatasetText } from '../dataset-formats.js';
import type { JudgeRef } from '../judge.js';
import { judgeOf, UNANSWERABLE_REFERENCE } from '../testset/task.js';
import { MAX_DRAFTS, REFERENCES_VERSION } from './references-prompts.js';
import '../testset/verify.js';

const PASSAGE_CHARS = 1800;
const MAX_PASSAGES = 6;

interface Rec {
  id?: string;
  question?: string;
  reference?: unknown;
  contexts?: Array<{ id?: string; text?: string }>;
  [k: string]: unknown;
}

/** What `prepareContext` keeps on this computer for `propose`. */
export interface ReferencesLocal {
  dataset: string;
  records: Map<string, Rec & { passages: Array<{ id: string; text: string }> }>;
  order: string[];
  judge?: JudgeRef;
  /** Records left out, with why (shown in the review's notes). */
  skipped: string[];
  /** Records still without a reference after this run. */
  remaining: number;
}

const DATASET = /^[A-Za-z0-9][\w.-]{0,100}\.jsonl$/;

/** `datasets/<name>.jsonl` from a name or a path. */
export function datasetRel(v: unknown): string {
  const name = String(v ?? '').trim().replace(/\\/g, '/').replace(/^datasets\//, '');
  if (!DATASET.test(name)) throw new ApsError('ValidationError', `"${String(v ?? '')}" is not a dataset: a file datasets/<name>.jsonl`, { suggestions: ['`testpion rag capture` makes one; the Data tab lists them.'] });
  return `datasets/${name}`;
}

const asIds = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === 'string' && v.trim() ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

/** The records of a dataset that have no reference and the passages to draft one from. */
export function draftable(store: Pick<WorkspaceStore, 'safePath'>, dataset: string, o: { ids?: string[]; limit?: number } = {}): { picked: ReferencesLocal['records']; order: string[]; skipped: string[]; remaining: number; total: number } {
  const file = store.safePath(dataset);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new ApsError('ConfigurationError', `${dataset} is not in the workspace`, { suggestions: ['The Data tab lists the datasets.'] });
  }
  const rows = parseRagDatasetText(text, 'jsonl') as Rec[];
  const skipped: string[] = [];
  const want = o.ids?.length ? new Set(o.ids) : undefined;
  const eligible: Array<Rec & { passages: Array<{ id: string; text: string }> }> = [];
  for (const r of rows) {
    const id = typeof r.id === 'string' && r.id ? r.id : undefined;
    if (!id || typeof r.question !== 'string' || !r.question.trim()) continue;
    if (want && !want.has(id)) continue;
    const has = typeof r.reference === 'string' ? r.reference.trim() !== '' : r.reference !== undefined && r.reference !== null;
    if (has) continue;
    const passages = (Array.isArray(r.contexts) ? r.contexts : [])
      .map((c, n) => ({ id: typeof c?.id === 'string' && c.id ? c.id : `p${n + 1}`, text: typeof c?.text === 'string' ? c.text.slice(0, PASSAGE_CHARS) : '' }))
      .filter((c) => c.text.trim())
      .slice(0, MAX_PASSAGES);
    if (!passages.length) {
      skipped.push(`${id}: no retrieved passages to draft from (a question-only record)`);
      continue;
    }
    eligible.push({ ...r, id, passages });
  }
  const limit = Math.max(1, Math.min(MAX_DRAFTS, Math.floor(o.limit ?? 8) || 8));
  const chosen = eligible.slice(0, limit);
  return { picked: new Map(chosen.map((r) => [r.id!, r])), order: chosen.map((r) => r.id!), skipped, remaining: eligible.length - chosen.length, total: rows.length };
}

export async function prepareReferences(store: WorkspaceStore, context: Record<string, unknown>, o: { privacy: AiPrivacy }): Promise<PreparedItem> {
  // the passages and questions ARE the context: a lower privacy level would send none of them, so the task says so instead of asking blind
  if (o.privacy !== 'full')
    throw new ApsError('ConfigurationError', `Drafting reference answers sends the questions and passages of the dataset, and the AI privacy level is "${o.privacy}"`, { suggestions: ['Settings ▸ AI assistant ▸ Privacy ▸ Full (redacted): secrets and personal data are masked before anything is sent.'] });
  const dataset = datasetRel(context.dataset);
  const d = draftable(store, dataset, { ids: asIds(context.ids), limit: Number(context.limit ?? 8) });
  if (!d.order.length)
    throw new ApsError('ValidationError', d.skipped.length ? `No record of ${dataset} can be drafted: ${d.skipped[0]}` : `Every record of ${dataset} has a reference answer already`, { suggestions: d.skipped.slice(1, 4) });
  const judge = judgeOf(context.judge);
  const local: ReferencesLocal = { dataset, records: d.picked, order: d.order, ...(judge ? { judge } : {}), skipped: d.skipped, remaining: d.remaining };
  return {
    label: dataset,
    local,
    context: {
      dataset,
      without: d.order.length + d.remaining,
      records: d.order.map((id) => {
        const r = d.picked.get(id)!;
        return { id, question: String(r.question), passages: r.passages };
      }),
    },
  };
}

export function proposeReferences(a: { value?: unknown }, input: AiTaskInput): { items: DraftItem[]; notes: string[]; problems: string[] } {
  const local = input.local as ReferencesLocal | undefined;
  if (!local) throw new ApsError('ValidationError', 'Reference answers are drafted for a dataset: name it (dataset)');
  const drafts = ((a.value as { drafts?: Array<{ id?: unknown; reference?: unknown; chunks?: unknown; answerable?: unknown; note?: unknown }> } | undefined)?.drafts ?? []).filter((d) => d && typeof d === 'object');
  const notes: string[] = [...local.skipped.map((s) => `Left out: ${s}`)];
  const problems: string[] = [];
  const items: DraftItem[] = [];
  const done = new Set<string>();
  for (const d of drafts) {
    const id = String(d.id ?? '');
    const rec = local.records.get(id);
    if (!rec) {
      notes.push(`The model wrote a draft for "${id}", which is not one of the records asked about; it is left out.`);
      continue;
    }
    if (done.has(id)) {
      notes.push(`Record ${id} was drafted twice; the first draft is kept.`);
      continue;
    }
    done.add(id);
    const byId = new Map(rec.passages.map((p) => [p.id, p]));
    const answerable = d.answerable !== false && typeof d.reference === 'string' && d.reference.trim() !== '';
    let used = asIds(d.chunks).filter((c) => byId.has(c));
    if (answerable && !used.length) {
      used = rec.passages.map((p) => p.id);
      notes.push(`Record ${id}: the draft named no passage; all of the record's passages are its sources.`);
    }
    const { passages: _p, ...orig } = rec;
    const meta = (orig.metadata && typeof orig.metadata === 'object' ? orig.metadata : {}) as Record<string, unknown>;
    const record = {
      ...orig,
      reference: answerable ? String(d.reference).trim() : UNANSWERABLE_REFERENCE,
      reference_ids: answerable ? used : [],
      reference_contexts: answerable ? used.map((c) => byId.get(c)!.text) : [],
      answerable,
      tags: [...new Set([...(Array.isArray(orig.tags) ? (orig.tags as unknown[]).map(String) : []), 'ai-reference'])],
      metadata: { ...meta, reference: { source: 'ai-draft', task: 'rag-draft-references', version: REFERENCES_VERSION, ...(input.model ? { model: input.model } : {}) } },
    };
    items.push({
      kind: 'dataset-row',
      title: String(rec.question),
      after: `${JSON.stringify(record)}\n`,
      language: 'json',
      data: { dataset: local.dataset, record, replace: true, ...(local.judge ? { judge: local.judge } : {}) },
    });
  }
  const missing = local.order.filter((id) => !done.has(id)).length;
  if (missing && items.length) notes.push(`${missing} of ${local.order.length} records got no draft.`);
  if (local.remaining) notes.push(`${local.remaining} more record${local.remaining === 1 ? '' : 's'} of ${local.dataset} have no reference: run it again for the next ones.`);
  if (!items.length) problems.push('No usable draft: answer with {"drafts": [...]} with one draft per record.');
  return { items, notes, problems };
}

export function describeReferences(value: unknown, items: ProposalItem[]): { summary: string; assumptions: string[] } {
  const none = items.filter((i) => (i.data as { record?: { answerable?: boolean } }).record?.answerable === false).length;
  const dataset = (items[0]?.data as { dataset?: string } | undefined)?.dataset ?? 'the dataset';
  return {
    summary: `${items.length} drafted reference answer${items.length === 1 ? '' : 's'} for ${dataset}${none ? `, ${none} of them marked unanswerable from the retrieved passages` : ''}. Accepting replaces the record of the same id and keeps the rest of it.`,
    assumptions: ['Each reference was written from the passages the system retrieved, not from its own answer. A system that retrieved the wrong passages gets a reference from them: read the ones marked unanswerable and the ones that look thin.'],
  };
}
