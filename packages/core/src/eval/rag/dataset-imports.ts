/**
 * More datasets that RAG evaluations start from, read as data only (nothing in a file is executed):
 *
 *  - BEIR: `queries.jsonl` (`_id`, `text`), `qrels/*.tsv` (query-id, corpus-id, score) and, when given, `corpus.jsonl`
 *    (`_id`, `title`, `text`). A query becomes a record whose gold ids are the corpus ids with a positive score.
 *  - NVIDIA retriever data: records with `query` or `question`, positive documents (`pos_doc`, `positive_passages`,
 *    `positive_ctxs`) and optional negatives. The positives are the gold chunks; negatives are kept as a column.
 *  - promptfoo: a config or a list of tests (`vars`, `assert`). The first variable that names a question is the question;
 *    the expected value of an `equals` / `contains` / `similar` / `context-recall` assertion is the reference; a `context`
 *    variable is the gold context.
 *
 * Each import says what it left out. The shapes were read from the tools' public documentation (2026-10); a record that
 * does not fit is skipped with a note, never guessed.
 */
import { csvRecords } from '@testpion/shared';
import { ApsError } from '../../errors.js';
import { parseYaml } from '../../util/lazy-yaml.js';
import { listOf } from './lists.js';

type Rec = Record<string, unknown>;

export interface ImportedRecords {
  records: Rec[];
  notes: string[];
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : v === undefined || v === null ? undefined : typeof v === 'object' ? JSON.stringify(v) : String(v));
const jsonl = (text: string): Rec[] =>
  text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as Rec;
      } catch {
        throw new ApsError('ValidationError', `A line of the file is not JSON: ${l.slice(0, 80)}`);
      }
    });

/** Queries, qrels and (optionally) the corpus of a BEIR dataset as RAG records. */
export function importBeir(files: { queries: string; qrels: string; corpus?: string }, o: { limit?: number } = {}): ImportedRecords {
  const notes: string[] = [];
  const queries = files.queries.trim().startsWith('[') ? (JSON.parse(files.queries) as Rec[]) : jsonl(files.queries);
  // qrels: a header line (query-id corpus-id score) is common; a row has 3 tab-separated columns (TREC format has 4)
  const gold = new Map<string, Array<{ id: string; score: number }>>();
  for (const line of files.qrels.split(/\r?\n/)) {
    const c = line.split(/[\t,]|\s+/).map((x) => x.trim()).filter(Boolean);
    if (c.length < 3) continue;
    const score = Number(c[c.length - 1]);
    if (!Number.isFinite(score)) continue;
    const q = c[0]!;
    const doc = c.length >= 4 ? c[2]! : c[1]!;
    (gold.get(q) ?? gold.set(q, []).get(q)!).push({ id: doc, score });
  }
  const corpus = new Map<string, string>();
  if (files.corpus) for (const d of jsonl(files.corpus)) corpus.set(String(d._id ?? d.id), [str(d.title), str(d.text)].filter(Boolean).join('\n'));
  const records: Rec[] = [];
  let withoutGold = 0;
  for (const q of queries) {
    const id = String(q._id ?? q.id ?? '');
    const text = str(q.text ?? q.query ?? q.question);
    if (!id || !text) continue;
    const rel = (gold.get(id) ?? []).filter((g) => g.score > 0).sort((a, b) => b.score - a.score);
    if (!rel.length) {
      withoutGold++;
      continue;
    }
    const texts = rel.map((g) => corpus.get(g.id)).filter((t): t is string => !!t);
    records.push({ id, question: text, reference_ids: rel.map((g) => g.id), ...(texts.length ? { reference_contexts: texts } : {}), tags: ['beir'] });
    if (o.limit && records.length >= o.limit) break;
  }
  if (withoutGold) notes.push(`${withoutGold} queries have no relevant document in the qrels and are skipped.`);
  if (!files.corpus) notes.push('No corpus file: the records have the gold ids only (the lexical metrics need reference_contexts).');
  if (gold.size && [...gold.values()].some((g) => g.some((x) => x.score > 1))) notes.push('Graded relevance (scores above 1) is read as relevant; the ranking by grade is kept in the order of reference_ids.');
  return { records, notes };
}

const docText = (d: unknown): string | undefined => (typeof d === 'string' ? d : d && typeof d === 'object' ? str((d as Rec).text ?? (d as Rec).passage ?? (d as Rec).contents ?? (d as Rec).content) : undefined);
const docId = (d: unknown): string | undefined => (d && typeof d === 'object' ? str((d as Rec).id ?? (d as Rec).pid ?? (d as Rec).docid ?? (d as Rec).doc_id) : undefined);

/** NVIDIA retriever data (query + positive and negative documents) as RAG records. */
export function importNvidia(records: Rec[]): ImportedRecords {
  const notes: string[] = [];
  const out: Rec[] = [];
  records.forEach((r, i) => {
    const question = str(r.query ?? r.question);
    const posRaw = r.pos_doc ?? r.positive_passages ?? r.positive_ctxs ?? r.pos_docs;
    const pos = Array.isArray(posRaw) ? posRaw : posRaw === undefined ? [] : [posRaw];
    if (!question || !pos.length) return void notes.push(`Record ${i + 1} has no ${question ? 'positive document' : 'query'} and is skipped.`);
    const ids = pos.map(docId);
    const texts = pos.map(docText).filter((t): t is string => !!t);
    const neg = r.neg_doc ?? r.negative_passages ?? r.negative_ctxs;
    const answers = listOf(r.answers ?? r.answer ?? r.reference);
    out.push({
      id: str(r.question_id ?? r.id) ?? `nvidia-${i + 1}`,
      question,
      ...(answers?.[0] ? { reference: answers[0] } : {}),
      ...(ids.every(Boolean) ? { reference_ids: ids } : {}),
      ...(texts.length ? { reference_contexts: texts } : {}),
      ...(Array.isArray(neg) && neg.length ? { negative_contexts: neg.map((d) => docText(d) ?? '').filter(Boolean).slice(0, 20) } : {}),
      tags: ['nvidia'],
    });
  });
  if (out.some((r) => !r.reference_ids)) notes.push('Some positive documents have no id; those records have gold texts only (use the lexical metrics, or add reference_ids).');
  return { records: out, notes };
}

const QUESTION_VARS = ['query', 'question', 'input', 'user_input', 'prompt', 'q'];
const REFERENCE_TYPES = new Set(['equals', 'contains', 'icontains', 'similar', 'context-recall', 'answer-relevance', 'factuality', 'g-eval']);

/** The tests of a promptfoo config (or a bare list of tests), as written in YAML or JSON. */
export function parsePromptfooTests(text: string): Rec[] {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    throw new ApsError('ValidationError', `The promptfoo file is not valid YAML or JSON: ${(e as Error).message.split('\n')[0]}`);
  }
  const tests = Array.isArray(doc) ? doc : doc && typeof doc === 'object' ? (doc as Rec).tests : undefined;
  if (!Array.isArray(tests)) throw new ApsError('ValidationError', 'A promptfoo file has a `tests:` list (or is a list of tests)', { suggestions: ['promptfoo tests may also be a path to a CSV file: import that CSV directly.'] });
  return tests.filter((x): x is Rec => !!x && typeof x === 'object');
}

/** promptfoo tests as RAG records. */
export function importPromptfoo(tests: Rec[]): ImportedRecords {
  const notes: string[] = [];
  const out: Rec[] = [];
  tests.forEach((t, i) => {
    const vars = (t.vars && typeof t.vars === 'object' ? t.vars : t) as Rec;
    const qKey = QUESTION_VARS.find((k) => vars[k] !== undefined) ?? Object.keys(vars).find((k) => typeof vars[k] === 'string' && !['context', 'expected', 'reference'].includes(k));
    const question = qKey ? str(vars[qKey]) : undefined;
    if (!question) return void notes.push(`Test ${i + 1} has no question variable (query, question, input …) and is skipped.`);
    const asserts = Array.isArray(t.assert) ? (t.assert as Rec[]) : [];
    const ref = asserts.find((a) => REFERENCE_TYPES.has(String(a.type)) && typeof a.value === 'string');
    const reference = str(vars.reference ?? vars.expected ?? vars.ground_truth ?? ref?.value);
    const ctx = listOf(vars.context ?? vars.contexts);
    const meta = t.metadata && typeof t.metadata === 'object' ? (t.metadata as Rec) : undefined;
    const tags = [...(listOf(meta?.tags) ?? []), ...(meta?.category ? [String(meta.category)] : [])];
    out.push({
      id: str(t.id) ?? `promptfoo-${i + 1}`,
      question,
      ...(reference ? { reference } : {}),
      ...(ctx ? { reference_contexts: ctx } : {}),
      ...(tags.length ? { tags } : {}),
    });
    const skipped = asserts.filter((a) => a !== ref).map((a) => String(a.type));
    if (skipped.length && i === 0) notes.push(`promptfoo assertions are not imported (${[...new Set(skipped)].join(', ')}); choose TestPion metrics for the evaluation instead.`);
  });
  notes.push('A `context` variable is read as the gold context (reference_contexts); the system under test retrieves its own.');
  return { records: out, notes };
}

/** A dataset file of any supported shape as raw records, by its name: YAML for promptfoo, CSV / TSV, JSON, JSONL. */
export function parseRagImportText(text: string, name: string, from?: string): Rec[] {
  const ext = name.split('.').pop()?.toLowerCase();
  if (from === 'promptfoo' || ext === 'yaml' || ext === 'yml') return parsePromptfooTests(text);
  if (ext === 'csv' || ext === 'tsv') {
    const [head, ...rows] = csvRecords(text, ext === 'tsv' ? '\t' : ',');
    return rows.map((r) => Object.fromEntries((head ?? []).map((h, i) => [h, r[i] ?? ''])));
  }
  const t = text.trim();
  if (t.startsWith('[') || (t.startsWith('{') && !t.includes('\n{'))) {
    const d = JSON.parse(t) as unknown;
    if (Array.isArray(d)) return d.filter((x): x is Rec => !!x && typeof x === 'object');
    for (const k of ['tests', 'test_cases', 'testCases', 'goldens', 'samples', 'data', 'rows', 'records', 'items'])
      if (Array.isArray((d as Rec)[k])) return ((d as Rec)[k] as unknown[]).filter((x): x is Rec => !!x && typeof x === 'object');
    return [d as Rec];
  }
  return jsonl(text);
}
