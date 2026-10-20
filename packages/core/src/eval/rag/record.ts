/**
 * The fields of a dataset record that metrics read beside the question, the reference and the gold chunks: whether the
 * question can be answered, graded relevance of chunks, an injected instruction to look for, tool calls, rubrics, a source
 * text. A record keeps every column as a variable (`test.variables`); this picks the few a metric knows, under one spelling
 * each, bounded in size so a result can keep them (a rescore reads them back from the stored sample).
 */
export interface RagToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface RagRecord {
  /** false for a question the documents cannot answer (negative rejection). */
  answerable?: boolean;
  /** Graded relevance of chunk ids (qrels): {id: 0..n}. */
  relevance?: Record<string, number>;
  /** The instruction an injected document carries, or the canary words an answer must not contain. */
  canaries?: string[];
  /** Tool calls the system made / should have made. */
  toolCalls?: RagToolCall[];
  referenceToolCalls?: RagToolCall[];
  /** A per-sample rubric (instance rubrics): level -> description, or a single criterion text. */
  rubric?: Record<string, string> | string;
  /** The text that was summarised / the source a summary must cover. */
  source?: string;
  /** Other answers that are acceptable (and unacceptable) for the semantic set metrics. */
  goodAnswers?: string[];
  badAnswers?: string[];
}

const MAX_TEXT = 8000;
const MAX_LIST = 50;

const parsed = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!/^[[{]/.test(t)) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
};

const asList = (v: unknown): string[] | undefined => {
  const x = parsed(v);
  if (typeof x === 'string') {
    const t = x.trim();
    return t
      ? t
          .split(/[;\n]/)
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, MAX_LIST)
      : undefined;
  }
  return Array.isArray(x) ? x.filter((s) => typeof s === 'string' || typeof s === 'number').map((s) => String(s).slice(0, MAX_TEXT)).slice(0, MAX_LIST) : undefined;
};

function calls(v: unknown): RagToolCall[] | undefined {
  const x = parsed(v);
  if (!Array.isArray(x)) return undefined;
  const out: RagToolCall[] = [];
  for (const c of x) {
    const o = (c ?? {}) as { name?: unknown; tool?: unknown; arguments?: unknown; args?: unknown; input?: unknown };
    const name = o.name ?? o.tool;
    if (typeof name !== 'string' || !name) continue;
    const a = parsed(o.arguments ?? o.args ?? o.input);
    out.push({ name, arguments: a && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>) : {} });
  }
  return out.length ? out.slice(0, MAX_LIST) : undefined;
}

const truthy = (v: unknown): boolean | undefined => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (['true', 'yes', '1'].includes(t)) return true;
    if (['false', 'no', '0'].includes(t)) return false;
  }
  if (typeof v === 'number') return v !== 0;
  return undefined;
};

/** Reads the known fields (under the spellings Ragas, DeepEval, promptfoo and BEIR datasets use) out of a record's variables. */
export function pickRecord(vars: Record<string, unknown> | undefined): RagRecord | undefined {
  if (!vars) return undefined;
  const out: RagRecord = {};
  const answerable = truthy(vars.answerable);
  if (answerable !== undefined) out.answerable = answerable;
  const rel = parsed(vars.relevance ?? vars.qrels);
  if (rel && typeof rel === 'object' && !Array.isArray(rel)) {
    const grades: Record<string, number> = {};
    for (const [k, v] of Object.entries(rel).slice(0, 500)) if (v !== null && v !== '' && Number.isFinite(Number(v))) grades[k] = Number(v);
    if (Object.keys(grades).length) out.relevance = grades;
  }
  const canaries = asList(vars.canaries ?? vars.canary ?? vars.injection);
  if (canaries?.length) out.canaries = canaries;
  const tc = calls(vars.tool_calls ?? vars.toolCalls);
  if (tc) out.toolCalls = tc;
  const rtc = calls(vars.reference_tool_calls ?? vars.referenceToolCalls ?? vars.expected_tools);
  if (rtc) out.referenceToolCalls = rtc;
  const rub = parsed(vars.rubric ?? vars.rubrics);
  if (typeof rub === 'string' && rub.trim()) out.rubric = rub.slice(0, MAX_TEXT);
  else if (rub && typeof rub === 'object' && !Array.isArray(rub)) out.rubric = Object.fromEntries(Object.entries(rub as Record<string, unknown>).slice(0, 10).map(([k, v]) => [k, String(v).slice(0, 1000)]));
  if (typeof vars.source === 'string' && vars.source.trim()) out.source = vars.source.slice(0, MAX_TEXT);
  const good = asList(vars.good_answers ?? vars.goodAnswers);
  if (good?.length) out.goodAnswers = good;
  const bad = asList(vars.bad_answers ?? vars.badAnswers);
  if (bad?.length) out.badAnswers = bad;
  return Object.keys(out).length ? out : undefined;
}
