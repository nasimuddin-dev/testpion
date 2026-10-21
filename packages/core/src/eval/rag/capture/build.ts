/**
 * From captured calls to dataset records: match each call to the RAG target, read the question out of the request where the
 * target writes it and the answer and contexts out of the response with the target's mapping (mapping.ts: the same code that
 * reads a live answer), mask, drop duplicates, sample. Pure: no files, no model, nothing sent anywhere.
 */
import { createHash } from 'node:crypto';
import type { RagTarget } from '@testpion/shared';
import { maskSensitiveText, type Redactor } from '../../../util/redact.js';
import { applyMapping, responseOf } from '../mapping.js';
import { captureNote, describeLocator, matchesTarget, protocolOfTarget, questionLocator, readQuestion } from './question-path.js';
import type { CapturedCall, CapturedRecord, CaptureOptions, CaptureReport, QuestionLocator } from './types.js';

const MAX_EXAMPLES = 3;

class Skips {
  private by = new Map<string, { count: number; examples: string[] }>();
  add(reason: string, example: string): void {
    const s = this.by.get(reason) ?? { count: 0, examples: [] };
    s.count++;
    if (s.examples.length < MAX_EXAMPLES) s.examples.push(example);
    this.by.set(reason, s);
  }
  list(): CaptureReport['skipped'] {
    return [...this.by.entries()].map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.count - a.count);
  }
}

/** The masking pass every string of a record goes through before it is kept: secrets always, personal data unless turned off. */
export function makeMasker(redactor: Redactor | undefined, pii: boolean) {
  const stat = { strings: 0, kinds: {} as Record<string, number> };
  const mask = (s: string): string => {
    const first = redactor ? redactor.redactString(s) : s;
    const out = maskSensitiveText(first, { pii }, (k) => (stat.kinds[k] = (stat.kinds[k] ?? 0) + 1));
    if (out !== s) stat.strings++;
    return out;
  };
  return { mask, stat };
}

/** The question in the one form duplicates are found in. */
export const questionKey = (q: string): string => q.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').replace(/[?!.\s]+$/g, '').trim();

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

/** A small seeded generator (mulberry32) so a sample is the same every time. */
function rng(seed: string | number): () => number {
  let a = parseInt(hash(String(seed)).slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const parseBody = (text: string | undefined): unknown => {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
};

export interface BuildInput {
  calls: CapturedCall[];
  /** Absent only when every call is a run result (a sample already). */
  target?: Pick<RagTarget, 'step' | 'mapping' | 'protocol'>;
  options: Pick<CaptureOptions, 'questionPath' | 'dedupe' | 'limit' | 'sample' | 'seed' | 'since' | 'until' | 'onlySuccess' | 'maskPii' | 'asQuestions'>;
  redactor?: Redactor;
}

export function buildRecords({ calls, target, options: o, redactor }: BuildInput): { records: CapturedRecord[]; report: CaptureReport } {
  const skips = new Skips();
  const warnings = new Set<string>();
  const { mask, stat } = makeMasker(redactor, o.maskPii !== false);
  let loc: QuestionLocator | undefined;
  const needsTarget = calls.some((c) => !c.sample);
  if (needsTarget) {
    if (!target) throw new Error('A RAG target is needed to read questions and answers out of captured requests');
    const note = captureNote(target);
    if (note) warnings.add(note);
    loc = questionLocator(target, o.questionPath);
    if (!loc) warnings.add('The target’s request has no {{question}} placeholder; pass the place of the question (--question-path "$.input.q" or query:<name>).');
  }
  const since = o.since ? Date.parse(o.since) : undefined;
  const until = o.until ? Date.parse(o.until) : undefined;
  const onlySuccess = o.onlySuccess !== false;
  let matched = 0;
  const found: Array<{ key: string; rec: CapturedRecord }> = [];
  for (const c of calls) {
    const at = c.at ? Date.parse(c.at) : undefined;
    if (at !== undefined && ((since !== undefined && at < since) || (until !== undefined && at > until))) {
      skips.add('outside the time range', c.id);
      continue;
    }
    let question: string | undefined;
    let answer: string | undefined;
    let contexts: CapturedRecord['contexts'];
    let reference: string | undefined;
    let referenceIds: string[] | undefined;
    // the record holds the question alone: asked for, or the protocol keeps no response
    let questionOnly = !!o.asQuestions;
    if (c.sample) {
      ({ question, answer, contexts, reference, referenceIds } = c.sample);
    } else {
      const have = c.protocol ?? 'http';
      const want = protocolOfTarget(target!);
      if (have !== want) {
        skips.add(`a ${have} call, and the target is ${want}`, c.id);
        continue;
      }
      if (onlySuccess && !(c.ok ?? (c.status !== undefined && c.status >= 200 && c.status < 300))) {
        skips.add(c.ok === false ? 'the call did not succeed' : c.status === undefined ? 'no response was recorded' : `the call answered ${c.status}, not 2xx`, c.id);
        continue;
      }
      if (!matchesTarget(target!, c)) {
        skips.add('not a call to the target’s URL and method', `${c.method ?? ''} ${(c.url ?? '').split('?')[0]}`.trim());
        continue;
      }
      if (!loc) {
        skips.add('the place of the question is unknown', c.id);
        continue;
      }
      question = readQuestion(loc, c);
      if (!question) {
        skips.add(`no question at ${describeLocator(loc)}`, c.id);
        continue;
      }
      // History keeps no response for a gRPC or an MCP call: what it has is the question
      if (c.responseText === undefined && (have === 'grpc' || have === 'mcp')) questionOnly = true;
      if (!questionOnly) {
        if (c.responseText === undefined) {
          skips.add('the response body was not recorded', c.id);
          continue;
        }
        const s = applyMapping(responseOf({ body: parseBody(c.responseText), text: c.responseText, headers: c.responseHeaders }), target!.mapping);
        if (!s.answer) {
          skips.add('the target’s mapping finds no answer in the response', c.id);
          continue;
        }
        for (const w of s.warnings) warnings.add(w);
        answer = s.answer;
        contexts = s.contexts.map((d) => ({ id: d.id, text: d.text, ...(d.score !== undefined ? { score: d.score } : {}), ...(d.source ? { source: d.source } : {}) }));
      }
    }
    matched++;
    const q = mask(question!);
    const rec: CapturedRecord = {
      id: `cap-${hash(`${c.source}:${c.id}`).slice(0, 10)}`,
      question: q,
      ...(questionOnly ? {} : { answer: mask(answer ?? ''), contexts: (contexts ?? []).map((d) => ({ id: d.id, text: mask(d.text), ...(d.score !== undefined ? { score: d.score } : {}), ...(d.source ? { source: mask(d.source) } : {}) })) }),
      ...(reference && !questionOnly ? { reference: mask(reference) } : {}),
      ...(referenceIds?.length ? { reference_ids: referenceIds } : {}),
      tags: ['captured', c.source],
      metadata: { capturedFrom: { kind: c.source, id: c.id }, ...(c.at ? { at: c.at } : {}), ...(c.latencyMs !== undefined ? { latencyMs: c.latencyMs } : {}) },
    };
    found.push({ key: questionKey(q), rec });
  }
  // duplicates (the same question once masked): the newest stays (calls are oldest first), or the first
  let list = found;
  let deduped = 0;
  if (o.dedupe) {
    const keepFirst = o.dedupe === 'first';
    const at = new Map<string, number>();
    const out: typeof found = [];
    for (const f of found) {
      const i = at.get(f.key);
      if (i === undefined) {
        at.set(f.key, out.length);
        out.push(f);
      } else {
        deduped++;
        if (!keepFirst) out[i] = f;
      }
    }
    list = out;
  }
  let sampled = 0;
  if (o.sample !== undefined && o.sample > 0 && list.length > o.sample) {
    const rand = rng(o.seed ?? 'testpion');
    const idx = list.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [idx[i], idx[j]] = [idx[j]!, idx[i]!];
    }
    const keep = new Set(idx.slice(0, o.sample));
    sampled = list.length - o.sample;
    list = list.filter((_, i) => keep.has(i));
  }
  if (o.limit !== undefined && o.limit > 0 && list.length > o.limit) {
    sampled += list.length - o.limit;
    list = list.slice(list.length - o.limit);
  }
  return {
    records: list.map((f) => f.rec),
    report: {
      read: calls.length,
      matched,
      skipped: skips.list(),
      masked: stat,
      deduped,
      sampled,
      records: list.length,
      ...(loc ? { questionAt: describeLocator(loc) } : {}),
      warnings: [...warnings].slice(0, 10),
    },
  };
}
