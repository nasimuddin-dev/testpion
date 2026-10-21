/**
 * Deterministic chunking of documents (planning/rag-testing.md §4b): pure functions, so the same documents always give the
 * same chunks and ids and a dataset's `reference_ids` stay meaningful. Markdown is split at headings, then paragraphs are
 * packed up to a token budget; a paragraph over the budget is split at sentence ends. No overlap: a chunk is a passage a
 * question can be answered from, and the verifiers compare answers with exactly this text.
 */
import { createHash } from 'node:crypto';
import { estimateTokens } from '../../../ai/types.js';
import type { Chunk, SourceDoc } from './types.js';

export const CHUNK_TOKENS = 220;
const MIN_TOKENS = 30;

export const slugOf = (name: string): string =>
  name
    .replace(/^https?:\/\//i, '')
    .replace(/\.[a-z0-9]{1,8}$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'doc';

export const normalizeText = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
export const hashOf = (s: string): string => createHash('sha256').update(normalizeText(s)).digest('hex').slice(0, 8);

interface Block {
  heading: string[];
  paragraphs: string[];
}

/** Sections by heading (markdown `#`, or a short line followed by a blank line in plain text is NOT treated as one: too guessy). */
function sections(doc: SourceDoc): Block[] {
  const out: Block[] = [];
  const trail: string[] = [];
  let cur: Block = { heading: [], paragraphs: [] };
  let para: string[] = [];
  let fence = false;
  const flush = () => {
    if (para.length) cur.paragraphs.push(para.join('\n').trim());
    para = [];
  };
  for (const raw of doc.text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (doc.format === 'markdown' && /^(```|~~~)/.test(line.trim())) fence = !fence;
    const h = doc.format === 'markdown' && !fence ? /^(#{1,6})\s+(.*\S)\s*#*$/.exec(line) : null;
    if (h) {
      flush();
      if (cur.paragraphs.length) out.push(cur);
      const depth = h[1]!.length;
      trail.length = depth - 1;
      trail[depth - 1] = h[2]!;
      cur = { heading: trail.filter(Boolean), paragraphs: [] };
    } else if (!line.trim() && !fence) flush();
    else para.push(line);
  }
  flush();
  if (cur.paragraphs.length) out.push(cur);
  return out;
}

const sentences = (p: string): string[] => p.match(/[^.!?\n]+(?:[.!?]+["')\]]*|\n|$)\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? [p];

/** Pieces of a paragraph that fits the budget (a long one is cut at sentence ends, a sentence longer than the budget stays whole). */
function fit(p: string, budget: number): string[] {
  if (estimateTokens(p) <= budget) return [p];
  const out: string[] = [];
  let cur = '';
  for (const s of sentences(p)) {
    if (cur && estimateTokens(`${cur} ${s}`) > budget) (out.push(cur), (cur = s));
    else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

export function chunkDocument(doc: SourceDoc, slug: string, o: { tokens?: number } = {}): Chunk[] {
  const budget = o.tokens ?? CHUNK_TOKENS;
  const raw: Array<{ heading: string[]; text: string }> = [];
  for (const sec of sections(doc)) {
    let cur = '';
    for (const para of sec.paragraphs.flatMap((p) => fit(p, budget))) {
      if (cur && estimateTokens(`${cur}\n\n${para}`) > budget) (raw.push({ heading: sec.heading, text: cur }), (cur = para));
      else cur = cur ? `${cur}\n\n${para}` : para;
    }
    if (cur) raw.push({ heading: sec.heading, text: cur });
  }
  // a tiny tail joins the chunk before it (same section) instead of becoming a passage nobody can ask about
  const merged: typeof raw = [];
  for (const r of raw) {
    const prev = merged[merged.length - 1];
    if (prev && estimateTokens(r.text) < MIN_TOKENS && prev.heading.join('/') === r.heading.join('/')) prev.text = `${prev.text}\n\n${r.text}`;
    else merged.push({ ...r });
  }
  return merged.map((r, i) => ({ id: `${slug}#${i + 1}`, doc: doc.name, heading: r.heading, text: r.text, tokens: estimateTokens(r.text), hash: hashOf(r.text) }));
}

/** Slugs made unique in the order the documents are given (a second `readme` is `readme-2`). */
export function chunkCorpus(docs: SourceDoc[], o: { tokens?: number } = {}): { chunks: Chunk[]; docs: Array<{ name: string; slug: string; chunks: number }> } {
  const used = new Map<string, number>();
  const chunks: Chunk[] = [];
  const out: Array<{ name: string; slug: string; chunks: number }> = [];
  for (const d of docs) {
    const base = slugOf(d.name);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    const slug = n === 1 ? base : `${base}-${n}`;
    const c = chunkDocument(d, slug, o);
    chunks.push(...c);
    out.push({ name: d.name, slug, chunks: c.length });
  }
  return { chunks, docs: out };
}
