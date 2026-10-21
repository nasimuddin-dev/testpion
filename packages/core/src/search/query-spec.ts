/**
 * The search query spec (AI-12): one small, validated, declarative query over the stores TestPion keeps — History
 * entries, runs, the results of tests inside runs, and traces. The query engine (query-engine.ts) is the only thing that
 * executes it, and it is the same for every caller: the filter chips in the app, `testpion search --query-json`, the MCP
 * tool and the model's translation of a question (the `nl-search` task). The model never sees the data it searches: it
 * writes this spec, TestPion checks it here (known fields, the operators of each, bounded values) and runs it.
 *
 * The spec is data, never code: no regular expressions (text matching is a plain, case-insensitive substring), no
 * paths, no writes. Pure: no imports, so the task prompt can be built from the catalog without a cycle.
 */

export const SEARCH_SOURCES = ['history', 'runs', 'results', 'traces'] as const;
export type SearchSource = (typeof SEARCH_SOURCES)[number];

export const SOURCE_LABEL: Readonly<Record<SearchSource, string>> = { history: 'History', runs: 'Runs', results: 'Test results', traces: 'Traces' };

type SearchOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'not_contains' | 'in' | 'within';

export const OP_LABEL: Readonly<Record<SearchOp, string>> = {
  eq: 'is',
  ne: 'is not',
  gt: 'over',
  gte: 'at least',
  lt: 'under',
  lte: 'at most',
  contains: 'contains',
  not_contains: 'does not contain',
  in: 'is one of',
  within: 'within the last',
};

type SearchField =
  | 'text'
  | 'time'
  | 'name'
  | 'kind'
  | 'method'
  | 'url'
  | 'status'
  | 'failed'
  | 'duration'
  | 'size'
  | 'environment'
  | 'collection'
  | 'file'
  | 'error'
  | 'assertion'
  | 'span'
  | 'spans'
  | 'flaky'
  | 'attempts'
  | 'failures';

type SearchValueType = 'text' | 'word' | 'number' | 'bool' | 'time';

export interface SearchFieldDef {
  id: SearchField;
  label: string;
  type: SearchValueType;
  ops: SearchOp[];
  /** The sources that have this field: a condition on it limits the search to them. */
  sources: SearchSource[];
  /** What it means, for people and for the model (one line). */
  description: string;
  /** The unit of a number (`ms`, `bytes`), said in the chip. */
  unit?: 'ms' | 'bytes';
  /** Values the field commonly takes (a hint, not a limit). */
  examples?: string[];
}

const ALL: SearchSource[] = [...SEARCH_SOURCES];

/** Every field a query may use: the one list the validator, the engine, the prompt, the chips and the docs read. */
export const SEARCH_FIELDS: readonly SearchFieldDef[] = [
  { id: 'text', label: 'Text', type: 'text', ops: ['contains', 'not_contains'], sources: ALL, description: 'free text anywhere in the entry (names, URLs, methods, statuses, errors)' },
  {
    id: 'time',
    label: 'Time',
    type: 'time',
    ops: ['gte', 'lte', 'within'],
    sources: ALL,
    description: 'when it happened: gte = since / on or after, lte = until / on or before (an ISO date or date-time), within = the last N (a number then m, h, d or w: 90m, 24h, 7d, 2w)',
  },
  { id: 'name', label: 'Name', type: 'text', ops: ['contains', 'not_contains', 'eq'], sources: ALL, description: 'the name of the request (History), the run, the test (Test results) or the trace' },
  {
    id: 'kind',
    label: 'Kind',
    type: 'word',
    ops: ['eq', 'ne', 'in'],
    sources: ['history', 'traces'],
    description: 'the protocol of a History entry or the kind of a trace',
    examples: ['http', 'graphql', 'grpc', 'mcp', 'llm', 'websocket', 'capture'],
  },
  { id: 'method', label: 'Method', type: 'word', ops: ['eq', 'ne', 'in'], sources: ['history'], description: 'the HTTP method', examples: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
  { id: 'url', label: 'URL', type: 'text', ops: ['contains', 'not_contains'], sources: ['history'], description: 'part of the URL (host, path or query), e.g. /payments or a host name' },
  {
    id: 'status',
    label: 'Status',
    type: 'number',
    ops: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in'],
    sources: ['history'],
    description: 'the HTTP status code (a range is two conditions: gte 500 and lte 599)',
  },
  {
    id: 'failed',
    label: 'Failed',
    type: 'bool',
    ops: ['eq'],
    sources: ALL,
    description: 'true = it failed (History: 4xx/5xx or an error; a run or test result with failures or errors; a trace that ended in an error); false = it succeeded',
  },
  { id: 'duration', label: 'Duration', type: 'number', ops: ['gt', 'gte', 'lt', 'lte'], sources: ALL, unit: 'ms', description: 'how long it took, in milliseconds (2 seconds = 2000)' },
  { id: 'size', label: 'Size', type: 'number', ops: ['gt', 'gte', 'lt', 'lte'], sources: ['history'], unit: 'bytes', description: 'the response size in bytes' },
  { id: 'environment', label: 'Environment', type: 'text', ops: ['eq', 'ne', 'contains'], sources: ['runs', 'results'], description: 'the environment the run used (staging, production …)' },
  { id: 'collection', label: 'Collection', type: 'text', ops: ['eq', 'contains'], sources: ['history'], description: 'the collection a History entry was sent from (by name)' },
  { id: 'file', label: 'Test file', type: 'text', ops: ['contains'], sources: ['results'], description: 'the test file path of a result, e.g. checkout/' },
  {
    id: 'error',
    label: 'Error text',
    type: 'text',
    ops: ['contains', 'not_contains'],
    sources: ['results', 'traces'],
    description: 'text in the error message of a test result or in the error of any span of a trace (timeout, connection reset, 500 …)',
  },
  { id: 'assertion', label: 'Failed assertion', type: 'text', ops: ['contains'], sources: ['results'], description: 'text in the name or message of a check (assertion) that failed in a test result' },
  { id: 'span', label: 'Span name', type: 'text', ops: ['contains'], sources: ['traces'], description: 'the name of any span of a trace (llm.chat, tool.call …)' },
  { id: 'spans', label: 'Span count', type: 'number', ops: ['eq', 'gt', 'gte', 'lt', 'lte'], sources: ['traces'], description: 'how many spans the trace has' },
  { id: 'flaky', label: 'Flaky', type: 'bool', ops: ['eq'], sources: ['results'], description: 'true = a test whose result keeps changing across the latest runs, or that passed only after a retry' },
  { id: 'attempts', label: 'Attempts', type: 'number', ops: ['eq', 'gt', 'gte', 'lt', 'lte'], sources: ['results'], description: 'how many attempts a test result took (2 or more = it was retried)' },
  { id: 'failures', label: 'Failures', type: 'number', ops: ['eq', 'gt', 'gte', 'lt', 'lte'], sources: ['runs'], description: 'how many tests of a run failed or errored' },
];

const FIELD = new Map<string, SearchFieldDef>(SEARCH_FIELDS.map((f) => [f.id, f]));
export const searchField = (id: string): SearchFieldDef | undefined => FIELD.get(id);

type SearchValue = string | number | boolean | Array<string | number>;

export interface SearchCondition {
  field: SearchField;
  op: SearchOp;
  value: SearchValue;
}

interface SearchSort {
  by: 'time' | 'duration';
  dir: 'asc' | 'desc';
}

/** A query: all conditions must hold (AND); an entry of a source that lacks a field the query uses is never a match. */
export interface SearchQuery {
  /** Where to look (default: every source that has all the fields the conditions use). */
  sources: SearchSource[];
  where: SearchCondition[];
  sort: SearchSort;
  limit: number;
}

export const SEARCH_LIMIT_DEFAULT = 25;
export const SEARCH_LIMIT_MAX = 200;
const SEARCH_CONDITIONS_MAX = 12;
export const SEARCH_VALUE_MAX = 200;
const SEARCH_LIST_MAX = 20;
/** The longest `within` (a year): a bound, not a promise that history reaches back that far. */
const SEARCH_WITHIN_MAX_MS = 366 * 86_400_000;

const WITHIN = /^(\d{1,6}(?:\.\d{1,3})?)\s*(m|h|d|w)$/i;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 } as const;

/** `7d`, `24h`, `90m`, `2w` in milliseconds, or undefined when it is not a duration. */
export function parseWithin(v: string): number | undefined {
  const m = WITHIN.exec(v.trim());
  if (!m) return undefined;
  const ms = Number(m[1]) * UNIT_MS[m[2]!.toLowerCase() as keyof typeof UNIT_MS];
  return ms > 0 && ms <= SEARCH_WITHIN_MAX_MS ? ms : undefined;
}

const DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** An ISO date or date-time in epoch milliseconds (a bare date is midnight UTC), or undefined. */
export function parseWhen(v: string): number | undefined {
  const s = v.trim();
  if (!DATE.test(s)) return undefined;
  const t = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s.replace(' ', 'T'));
  return Number.isFinite(t) ? t : undefined;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
const KEYS = { query: ['sources', 'where', 'sort', 'limit'], condition: ['field', 'op', 'value'], sort: ['by', 'dir'] } as const;

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

function unknownKeys(o: Record<string, unknown>, allowed: readonly string[], where: string): string[] {
  return Object.keys(o)
    .filter((k) => !allowed.includes(k))
    .map((k) => `${where}: unknown key "${k.slice(0, 40)}" (allowed: ${allowed.join(', ')})`);
}

/** One value of a field, checked against the field's type: the problems, and the value made canonical. */
function checkValue(def: SearchFieldDef, op: SearchOp, raw: unknown, at: string): { value?: SearchValue; problems: string[] } {
  const bad = (m: string) => ({ problems: [`${at}: ${m}`] });
  const scalar = (v: unknown): { value?: string | number; problem?: string } => {
    switch (def.type) {
      case 'text':
      case 'word': {
        if (typeof v !== 'string') return { problem: `a ${def.label} value is a string` };
        const s = v.trim();
        if (!s) return { problem: 'the value is empty' };
        if (s.length > (def.type === 'word' ? 40 : SEARCH_VALUE_MAX)) return { problem: `the value is longer than ${def.type === 'word' ? 40 : SEARCH_VALUE_MAX} characters` };
        if (CONTROL.test(s)) return { problem: 'the value has control characters' };
        return { value: def.id === 'method' ? s.toUpperCase() : s };
      }
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) return { problem: `a ${def.label} value is a number` };
        if (v < 0 || v > 1e12) return { problem: 'the number is outside 0 … 1e12' };
        return { value: v };
      default:
        return { problem: 'unsupported' };
    }
  };
  if (def.type === 'bool') return typeof raw === 'boolean' ? { value: raw, problems: [] } : bad(`${def.label} takes true or false`);
  if (def.type === 'time') {
    if (typeof raw !== 'string') return bad('a time is a string (an ISO date or date-time; a number and m, h, d or w for "within")');
    if (op === 'within')
      return parseWithin(raw) !== undefined ? { value: raw.trim().toLowerCase(), problems: [] } : bad(`"${raw.slice(0, 40)}" is not a duration (use 90m, 24h, 7d or 2w; at most 366d)`);
    return parseWhen(raw) !== undefined ? { value: raw.trim(), problems: [] } : bad(`"${raw.slice(0, 40)}" is not an ISO date or date-time (2026-10-12 or 2026-10-12T08:00:00Z)`);
  }
  if (op === 'in') {
    if (!Array.isArray(raw) || !raw.length) return bad('"in" takes a non-empty list');
    if (raw.length > SEARCH_LIST_MAX) return bad(`the list has more than ${SEARCH_LIST_MAX} values`);
    const out: Array<string | number> = [];
    for (const v of raw) {
      const s = scalar(v);
      if (s.problem) return bad(s.problem);
      out.push(s.value!);
    }
    return { value: out, problems: [] };
  }
  const s = scalar(raw);
  return s.problem ? bad(s.problem) : { value: s.value, problems: [] };
}

/**
 * A query from untrusted input (a model's answer, `--query-json`, an RPC from a window, an MCP argument): strict.
 * Unknown keys, unknown fields, an operator the field does not take, a value of the wrong type or beyond a bound, or
 * a field that no source has together with the others are problems (each says what is allowed, so a model can repair
 * it). On success the query is complete: sources narrowed to those that have every field used, the default sort and
 * limit filled in.
 */
export function parseSearchQuery(input: unknown): { query?: SearchQuery; problems: string[] } {
  if (!isPlain(input)) return { problems: ['the query is a JSON object: {"sources", "where", "sort", "limit"}'] };
  const problems = unknownKeys(input, KEYS.query, 'query');
  let sources: SearchSource[] | undefined;
  if (input.sources !== undefined) {
    if (!Array.isArray(input.sources) || !input.sources.length) problems.push(`sources is a non-empty list of: ${SEARCH_SOURCES.join(', ')}`);
    else {
      const bad = input.sources.filter((s) => !SEARCH_SOURCES.includes(s as SearchSource));
      if (bad.length) problems.push(`unknown source ${bad.map((s) => `"${String(s).slice(0, 30)}"`).join(', ')} (allowed: ${SEARCH_SOURCES.join(', ')})`);
      else sources = [...new Set(input.sources as SearchSource[])];
    }
  }
  const where: SearchCondition[] = [];
  if (input.where !== undefined) {
    if (!Array.isArray(input.where)) problems.push('where is a list of {"field", "op", "value"}');
    else if (input.where.length > SEARCH_CONDITIONS_MAX) problems.push(`where has more than ${SEARCH_CONDITIONS_MAX} conditions`);
    else
      input.where.forEach((c: unknown, i) => {
        const at = `where[${i}]`;
        if (!isPlain(c)) return problems.push(`${at}: a condition is {"field", "op", "value"}`);
        const before = problems.length;
        problems.push(...unknownKeys(c, KEYS.condition, at));
        // a Map, not an object: "constructor" or "__proto__" is never a field
        const def = typeof c.field === 'string' ? FIELD.get(c.field) : undefined;
        if (!def) return problems.push(`${at}: unknown field "${String(c.field).slice(0, 40)}" (allowed: ${SEARCH_FIELDS.map((f) => f.id).join(', ')})`);
        if (typeof c.op !== 'string' || !def.ops.includes(c.op as SearchOp))
          return problems.push(`${at}: "${String(c.op).slice(0, 30)}" is not an operator of ${def.id} (allowed: ${def.ops.join(', ')})`);
        const v = checkValue(def, c.op as SearchOp, c.value, `${at} (${def.id})`);
        problems.push(...v.problems);
        if (problems.length === before) where.push({ field: def.id, op: c.op as SearchOp, value: v.value! });
      });
  }
  let sort: SearchSort = { by: 'time', dir: 'desc' };
  if (input.sort !== undefined) {
    if (!isPlain(input.sort)) problems.push('sort is {"by": "time" | "duration", "dir": "asc" | "desc"}');
    else {
      problems.push(...unknownKeys(input.sort, KEYS.sort, 'sort'));
      const by = input.sort.by ?? 'time';
      const dir = input.sort.dir ?? 'desc';
      if (by !== 'time' && by !== 'duration') problems.push('sort.by is "time" or "duration"');
      else if (dir !== 'asc' && dir !== 'desc') problems.push('sort.dir is "asc" or "desc"');
      else sort = { by, dir };
    }
  }
  let limit = SEARCH_LIMIT_DEFAULT;
  if (input.limit !== undefined) {
    if (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > SEARCH_LIMIT_MAX) problems.push(`limit is a whole number from 1 to ${SEARCH_LIMIT_MAX}`);
    else limit = input.limit;
  }
  if (problems.length) return { problems };
  // the sources that have every field the conditions use (a method is a History thing, a flaky test a result)
  const need = [...new Set(where.map((c) => c.field))];
  const requested = sources ?? [...SEARCH_SOURCES];
  const usable = requested.filter((s) => need.every((f) => FIELD.get(f)!.sources.includes(s)));
  if (!usable.length)
    return {
      problems: [
        `no source has all the fields used (${need.join(', ')}): ${need
          .map((f) => `${f} is in ${FIELD.get(f)!.sources.join('/')}`)
          .join('; ')}${sources ? ` — the sources asked for are ${sources.join(', ')}` : ''}`,
      ],
    };
  return { query: { sources: usable, where, sort, limit }, problems: [] };
}

/**
 * A query for plain text: every source, newest first (what the Ask box does without a model). Each word must be in the
 * entry, in any order, as the workspace search treats its terms.
 */
export function textQuery(text: string, limit = SEARCH_LIMIT_DEFAULT): SearchQuery {
  const words = [...new Set(text.toLowerCase().replace(new RegExp(CONTROL.source, 'g'), ' ').split(/\s+/).filter(Boolean))].slice(0, 8).map((w) => w.slice(0, SEARCH_VALUE_MAX));
  return { sources: [...SEARCH_SOURCES], where: words.map((value) => ({ field: 'text' as const, op: 'contains' as const, value })), sort: { by: 'time', dir: 'desc' }, limit };
}

/* ------------------------------------------------------------------ in words */

const fmtMs = (ms: number) => (ms >= 60_000 ? `${+(ms / 60_000).toFixed(1)} min` : ms >= 1000 ? `${+(ms / 1000).toFixed(2)} s` : `${ms} ms`);
const fmtBytes = (n: number) => (n >= 1_048_576 ? `${+(n / 1_048_576).toFixed(1)} MB` : n >= 1024 ? `${+(n / 1024).toFixed(1)} KB` : `${n} B`);
const WITHIN_WORD = { m: 'minute', h: 'hour', d: 'day', w: 'week' } as const;

function valueText(def: SearchFieldDef, c: SearchCondition): string {
  const one = (v: string | number) => {
    if (typeof v === 'number') return def.unit === 'ms' ? fmtMs(v) : def.unit === 'bytes' ? fmtBytes(v) : String(v);
    return def.type === 'text' ? `"${v}"` : v;
  };
  if (Array.isArray(c.value)) return c.value.map(one).join(', ');
  if (typeof c.value === 'boolean') return c.value ? 'yes' : 'no';
  if (def.type === 'time' && c.op === 'within') {
    const m = WITHIN.exec(String(c.value))!;
    const n = Number(m[1]);
    const unit = WITHIN_WORD[m[2]!.toLowerCase() as keyof typeof WITHIN_WORD];
    return n === 1 ? unit : `${n} ${unit}s`;
  }
  return one(c.value);
}

/** One condition in plain words ("duration over 2 s", "time within the last 7 days", "failed is yes"). */
export function conditionText(c: SearchCondition): string {
  const def = FIELD.get(c.field)!;
  if (def.type === 'time') return c.op === 'within' ? `time within the last ${valueText(def, c)}` : `time ${c.op === 'gte' ? 'since' : 'until'} ${c.value}`;
  return `${def.label.toLowerCase()} ${OP_LABEL[c.op]} ${valueText(def, c)}`;
}

/** The query as a sentence: what is searched, which conditions all hold, in which order and how many. */
export function explainQuery(q: SearchQuery): string {
  const where = q.where.length ? ` where ${q.where.map(conditionText).join(' and ')}` : '';
  const order = q.sort.by === 'time' ? (q.sort.dir === 'desc' ? 'newest first' : 'oldest first') : q.sort.dir === 'desc' ? 'slowest first' : 'fastest first';
  return `Looking in ${q.sources.map((s) => SOURCE_LABEL[s]).join(', ')}${where}; ${order}, at most ${q.limit}.`;
}

/** An editable piece of a query: the chips of the filter form. */
export interface SearchChip {
  index: number;
  field: SearchField;
  op: SearchOp;
  value: SearchValue;
  /** "duration over 2 s". */
  text: string;
}

export const queryChips = (q: SearchQuery): SearchChip[] => q.where.map((c, index) => ({ index, ...c, text: conditionText(c) }));

/** The catalog as the prompt states it: one line per field with its operators and meaning. */
export function fieldCatalogText(): string {
  return SEARCH_FIELDS.map(
    (f) => `- ${f.id} (${f.type}${f.unit ? `, ${f.unit}` : ''}; ops: ${f.ops.join(', ')}; in: ${f.sources.join(', ')}): ${f.description}${f.examples ? ` — e.g. ${f.examples.join(', ')}` : ''}`,
  ).join('\n');
}
