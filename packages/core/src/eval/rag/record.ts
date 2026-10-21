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

/** One message of a conversation: what a user said, what the system answered (with the tools it called and what it retrieved), a tool's result. */
export interface ConversationTurn {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** An assistant turn: the tool calls it made (Ragas AIMessage.tool_calls). */
  toolCalls?: RagToolCall[];
  /** An assistant turn: the chunks the system retrieved for it (per-turn metrics read them). */
  contexts?: Array<{ id: string; text: string; score?: number }>;
}

export interface RagRecord {
  /** Pictures of the question (references: URL, data URI, workspace path). The retrieved chunks' own images come from the target. */
  images?: string[];
  /** A conversation: the user messages to send (a transcript to replay), or after a run the whole transcript with the system's answers. */
  turns?: ConversationTurn[];
  /** The topics a conversation may stay on (topic adherence). */
  referenceTopics?: string[];
  /** What the user wanted to achieve, in words (goal accuracy with a reference). */
  expectedOutcome?: string;
  /** The probe must be refused (a safety probe: an obedient answer fails). */
  shouldRefuse?: boolean;
  /** The other system’s answer to the same question (a baseline run’s), for the pairwise comparison. */
  otherAnswer?: string;
  /** The kind of a safety probe (`jailbreak`, `injection`, `pii`, `toxicity` …): metrics and the matrix group by it. */
  probe?: string;
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

const MAX_TURNS = 60;

/**
 * A conversation written as data: a list of user messages (strings), a list of messages `{ role | type, content, tool_calls }`
 * (OpenAI, DeepEval, Ragas MultiTurnSample: `human` / `ai` / `tool`), or a transcript text with `User:` and `Assistant:` lines.
 */
export function turnsOf(v: unknown): ConversationTurn[] | undefined {
  let x = parsed(v);
  if (typeof x === 'string') {
    const lines = x.split(/\r?\n/).filter((l) => l.trim());
    const t: ConversationTurn[] = [];
    for (const l of lines) {
      const m = /^\s*(user|human|customer|assistant|ai|bot|agent|system)\s*:\s*(.*)$/i.exec(l);
      if (m) t.push({ role: /^(user|human|customer)$/i.test(m[1]!) ? 'user' : 'assistant', content: m[2]!.trim().slice(0, MAX_TEXT) });
      else if (t.length) t[t.length - 1]!.content = `${t[t.length - 1]!.content}\n${l.trim()}`.slice(0, MAX_TEXT);
    }
    x = t.length ? t : undefined;
  }
  if (!Array.isArray(x)) return undefined;
  const out: ConversationTurn[] = [];
  for (const m of x.slice(0, MAX_TURNS)) {
    if (typeof m === 'string') {
      if (m.trim()) out.push({ role: 'user', content: m.slice(0, MAX_TEXT) });
      continue;
    }
    const o = (m ?? {}) as Record<string, unknown>;
    const kind = String(o.role ?? o.type ?? '').toLowerCase();
    const role = /^(user|human|customer)$/.test(kind) ? 'user' : /^(tool|function)$/.test(kind) ? 'tool' : /^(assistant|ai|bot|agent|model)$/.test(kind) ? 'assistant' : kind ? undefined : 'user';
    if (!role) continue;
    const content = typeof o.content === 'string' ? o.content : typeof o.text === 'string' ? o.text : '';
    const tc = calls(o.tool_calls ?? o.toolCalls);
    if (!content.trim() && !tc) continue;
    const ctxs = Array.isArray(o.contexts) ? (o.contexts as Array<Record<string, unknown>>).slice(0, 20).map((d, i) => ({ id: String(d.id ?? `doc-${i + 1}`), text: String(d.text ?? '').slice(0, MAX_TEXT), ...(typeof d.score === 'number' ? { score: d.score } : {}) })) : undefined;
    out.push({ role, content: content.slice(0, MAX_TEXT), ...(tc ? { toolCalls: tc } : {}), ...(ctxs?.length ? { contexts: ctxs } : {}) });
  }
  return out.length ? out : undefined;
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
  // a data URI holds a ";" (data:image/png;base64,…): a list of pictures is split on lines only, and an array is taken as it is
  const rawImages = parsed(vars.images ?? vars.image ?? vars.question_images ?? vars.question_image);
  const images = (Array.isArray(rawImages) ? rawImages : typeof rawImages === 'string' ? rawImages.split(/\r?\n/) : []).filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim());
  if (images.length) out.images = images.slice(0, 16);
  const turns = turnsOf(vars.turns ?? vars.conversation ?? vars.messages ?? (Array.isArray(vars.user_input) ? vars.user_input : undefined));
  if (turns) out.turns = turns;
  const topics = asList(vars.reference_topics ?? vars.referenceTopics ?? vars.topics);
  if (topics?.length) out.referenceTopics = topics;
  const outcome = vars.expected_outcome ?? vars.expectedOutcome ?? vars.goal;
  if (typeof outcome === 'string' && outcome.trim()) out.expectedOutcome = outcome.slice(0, MAX_TEXT);
  const refuse = truthy(vars.should_refuse ?? vars.shouldRefuse ?? vars.expect_refusal);
  if (refuse !== undefined) out.shouldRefuse = refuse;
  const other = vars.baseline_answer ?? vars.answer_b ?? vars.other_answer ?? vars.baseline_response;
  if (typeof other === 'string' && other.trim()) out.otherAnswer = other.slice(0, MAX_TEXT);
  const probe = vars.probe ?? vars.probe_category;
  if (typeof probe === 'string' && probe.trim()) out.probe = probe.trim().slice(0, 64);
  return Object.keys(out).length ? out : undefined;
}
