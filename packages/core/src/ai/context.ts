/**
 * The one context builder of the AI features (AIB-2): what a task sends about the workspace, made safe and small.
 *
 * 1. Redaction (util/redact.ts `redactForAi`): sensitive field names, known secret values (secret variables, resolved
 *    keys), and credentials / personal data found by their shape in any string. Every mask is listed (`redactions`).
 * 2. Privacy level: `full` (redacted values), `metadata` (methods, paths, statuses, names and the *shape* of bodies),
 *    `names` (names, kinds and structure only).
 * 3. Budget: each top-level key is a section with a token budget (a task may set its own per section). A section over
 *    its budget is *sampled* (arrays keep the first, the last, the failed and one of each shape) and its long strings
 *    are shortened with a marker; JSON text is parsed and fitted as data. The JSON sent is never cut mid-value.
 *
 * `text` is exactly what goes into the prompt; "What will be sent" shows it with the sections, the token estimate and
 * the redactions.
 */
import type { AiPrivacy } from './ai-settings.js';
import { estimateTokens } from './types.js';
import { redactForAi, type Redaction, type Redactor } from '../util/redact.js';

export interface AiContextSection {
  name: string;
  /** Estimated tokens sent for the section. */
  tokens: number;
  /** Estimated tokens before it was fitted. */
  originalTokens: number;
  /** What was done to fit it: "sampled 20 of 340 items", "shortened 3 long texts", "summarised to its shape". */
  notes: string[];
}

export interface AiContext {
  /** The JSON text sent (pretty-printed). */
  text: string;
  tokens: number;
  budgetTokens: number;
  privacy: AiPrivacy;
  sections: AiContextSection[];
  redactions: Redaction[];
  /** All masks, including those beyond the first 200 listed. */
  redactionCount: number;
}

export interface AiContextOptions {
  privacy: AiPrivacy;
  redactor: Redactor;
  /** Total tokens for the context (default 6000, about 24 000 characters). */
  budgetTokens?: number;
  /** Tokens for named sections (`{ response: 3000 }`); the rest share what is left. */
  sectionBudgets?: Record<string, number>;
  /** Mask e-mail addresses, phone numbers, card numbers, IBANs (default on). */
  maskPersonalData?: boolean;
}

export const DEFAULT_CONTEXT_TOKENS = 6000;

const tokensOf = (v: unknown) => estimateTokens(JSON.stringify(v, null, 2) ?? '');

/* ------------------------------------------------------------------ privacy levels */

/** Keys whose value is a body (its values go at `metadata`, its shape stays). */
const BODY_KEY = /^(body|bodyPreview|bodyText|rawBody|requestBody|responseBody|content|json|payload|data|output|input|example|examples|text|result|value|values|message_?body|lastSeconds|series)$/i;
/** Keys whose (short) string values are names, kinds or statuses: kept at every level. */
const NAME_KEY =
  /^(name|title|label|method|kind|type|status|statusText|severity|category|rule|check|operationId|operation|pointer|tool|task|protocol|environment|tag|tags|code|codeName|contentType|id|ref|folder|collection|step|file|path)$/i;
/** Numbers that say what happened (status, counts, times): kept at `names` too. */
const NUMBER_KEY = /(status|code|count|total|passed|failed|errors|skipped|ms|duration|latency|p\d\d|tokens|size|iterations|attempts|line|users|rps|rate)/i;

/** The shape of a value: `{ id: 'number', items: ['{…} ×20', { … }] }`. */
export function shapeOf(v: unknown, depth = 0): unknown {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    if (!v.length) return [];
    const first = depth > 6 ? typeof v[0] : shapeOf(v[0], depth + 1);
    return v.length > 1 ? [first, `… ×${v.length} items`] : [first];
  }
  if (typeof v === 'object') {
    if (depth > 6) return '{…}';
    const out: Record<string, unknown> = {};
    const entries = Object.entries(v as Record<string, unknown>);
    for (const [k, x] of entries.slice(0, 60)) out[k] = shapeOf(x, depth + 1);
    if (entries.length > 60) out['…'] = `${entries.length - 60} more keys`;
    return out;
  }
  if (typeof v === 'string') {
    const j = parseJsonText(v);
    return j !== undefined ? shapeOf(j, depth) : v.length > 0 ? `string (${v.length} chars)` : 'string';
  }
  return typeof v;
}

function parseJsonText(s: string): unknown {
  if (s.length < 2 || s.length > 2_000_000 || !/^\s*[{[]/.test(s)) return undefined;
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** A URL without its query values (names stay): `https://api.example.com/orders?status=…`. */
const stripQueryValues = (s: string) => s.replace(/([?&][^=&#\s]+)=[^&#\s]*/g, '$1=…');
const looksUrl = (s: string) => /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(s) || /^\{\{[^}]+\}\}\/\S*$/.test(s);
const pathOnly = (s: string) =>
  s
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '')
    .replace(/^\{\{[^}]+\}\}/, '')
    .replace(/[?#].*$/, '') || '/';

export function applyPrivacy(v: unknown, level: AiPrivacy, key = '', depth = 0): unknown {
  if (level === 'full' || v == null || depth > 64) return v;
  if (BODY_KEY.test(key) && !(typeof v === 'string' && v.length <= 40 && !parseJsonText(v))) return shapeOf(v);
  if (Array.isArray(v)) {
    // [name, value] header pairs: the name stays
    if (v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' && /^[\w-]+$/.test(v[0])) return [v[0], /^content-type$/i.test(v[0]) && level === 'metadata' ? v[1] : '…'];
    return v.map((x) => applyPrivacy(x, level, key, depth + 1));
  }
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    // { key, value } rows (headers, params, variables): the key stays
    if (typeof obj.key === 'string' && 'value' in obj)
      return {
        ...Object.fromEntries(
          Object.entries(obj)
            .filter(([k]) => k !== 'value')
            .map(([k, x]) => [k, applyPrivacy(x, level, k, depth + 1)]),
        ),
        value: '…',
      };
    return Object.fromEntries(Object.entries(obj).map(([k, x]) => [k, applyPrivacy(x, level, k, depth + 1)]));
  }
  if (typeof v === 'number') return level === 'names' && !NUMBER_KEY.test(key) ? 'number' : v;
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') return typeof v;
  if (looksUrl(v)) return level === 'metadata' ? stripQueryValues(v) : pathOnly(v);
  if (NAME_KEY.test(key) && v.length <= 200) return /^(url|path)$/i.test(key) && level === 'names' ? pathOnly(v) : v;
  if (level === 'metadata' && v.length <= 160 && /^(message|error|why|what|reason|description|summary|hint|expected|actual|where|observed)$/i.test(key)) return v;
  return v.length ? `string (${v.length} chars)` : '';
}

/* ------------------------------------------------------------------ fitting to a budget */

interface Limits {
  str: number;
  items: number;
  depth: number;
}

/** From light to heavy: each step shortens strings and samples arrays more. */
const LEVELS: Limits[] = [
  { str: 4000, items: 100, depth: 24 },
  { str: 2000, items: 50, depth: 16 },
  { str: 1000, items: 24, depth: 12 },
  { str: 400, items: 12, depth: 10 },
  { str: 200, items: 6, depth: 8 },
  { str: 100, items: 4, depth: 6 },
  { str: 60, items: 2, depth: 4 },
];

/** An item that says something failed (kept when an array is sampled). */
const failed = (x: unknown): boolean => {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return o.passed === false || o.ok === false || !!o.error || (typeof o.status === 'string' && /fail|error/i.test(o.status)) || (typeof o.status === 'number' && o.status >= 400);
};

const shapeKey = (x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x).sort().join(',') : typeof x);

/** Up to `n` items: the first, the last, the failed, one of each shape, then the first ones. */
export function sampleArray<T>(arr: T[], n: number): { items: T[]; picked: number[] } {
  if (arr.length <= n) return { items: arr, picked: arr.map((_, i) => i) };
  const pick = new Set<number>([0]);
  if (n > 1) pick.add(arr.length - 1);
  for (let i = 0; i < arr.length && pick.size < Math.max(2, Math.ceil(n * 0.6)); i++) if (failed(arr[i])) pick.add(i);
  const shapes = new Set([...pick].map((i) => shapeKey(arr[i])));
  for (let i = 0; i < arr.length && pick.size < n; i++) {
    const k = shapeKey(arr[i]);
    if (!shapes.has(k)) {
      shapes.add(k);
      pick.add(i);
    }
  }
  for (let i = 1; i < arr.length && pick.size < n; i++) pick.add(i);
  const picked = [...pick].sort((a, b) => a - b);
  return { items: picked.map((i) => arr[i]!), picked };
}

function fit(v: unknown, lim: Limits, notes: Set<string>, depth = 0): unknown {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (v.length <= lim.str) return v;
    // JSON text is fitted as data, never cut mid-value
    const j = parseJsonText(v);
    if (j !== undefined) {
      notes.add('fitted JSON text as data');
      return fit(j, lim, notes, depth);
    }
    notes.add('shortened long texts');
    return `${v.slice(0, lim.str)} … [${v.length - lim.str} more characters]`;
  }
  if (depth >= lim.depth) {
    notes.add('summarised deep parts to their shape');
    return shapeOf(v);
  }
  if (Array.isArray(v)) {
    if (v.length <= lim.items) return v.map((x) => fit(x, lim, notes, depth + 1));
    const s = sampleArray(v, lim.items);
    notes.add(`sampled ${s.items.length} of ${v.length} items (first, last, failed, one of each shape)`);
    return [...s.items.map((x) => fit(x, lim, notes, depth + 1)), `… ${v.length - s.items.length} more items not sent`];
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    const keep = Math.max(lim.items * 2, 8);
    const out: Record<string, unknown> = {};
    for (const [k, x] of entries.slice(0, keep)) out[k] = fit(x, lim, notes, depth + 1);
    if (entries.length > keep) {
      notes.add('left out keys of large objects');
      out['…'] = `${entries.length - keep} more keys not sent: ${entries
        .slice(keep, keep + 20)
        .map(([k]) => k)
        .join(', ')}`;
    }
    return out;
  }
  return String(v);
}

/** A section fitted into `budget` tokens: lighter limits first, then heavier, then its shape alone. */
export function fitSection(value: unknown, budget: number): { value: unknown; notes: string[] } {
  if (tokensOf(value) <= budget) return { value, notes: [] };
  for (const lim of LEVELS) {
    const notes = new Set<string>();
    const out = fit(value, lim, notes);
    if (tokensOf(out) <= budget) return { value: out, notes: [...notes] };
  }
  const shape = shapeOf(value);
  if (tokensOf(shape) <= budget) return { value: shape, notes: ['summarised to its shape (too large to send)'] };
  const notes = new Set<string>(['summarised to its shape (too large to send)']);
  return { value: fit(shape, LEVELS[LEVELS.length - 1]!, notes), notes: [...notes] };
}

/** Shares `total` among sections: each named budget first, then equal shares, the unused part of small ones going to big ones. */
export function shareBudget(sizes: Record<string, number>, total: number, fixed: Record<string, number> = {}): Record<string, number> {
  const out: Record<string, number> = {};
  let left = total;
  const rest: string[] = [];
  for (const k of Object.keys(sizes)) {
    if (fixed[k] !== undefined) {
      out[k] = Math.min(fixed[k]!, sizes[k]!);
      left -= out[k]!;
    } else rest.push(k);
  }
  left = Math.max(left, rest.length * 50);
  // water-filling: the smallest sections take what they need, the rest share the remainder
  const order = rest.sort((a, b) => sizes[a]! - sizes[b]!);
  for (let i = 0; i < order.length; i++) {
    const share = Math.floor(left / (order.length - i));
    const k = order[i]!;
    out[k] = Math.min(sizes[k]!, share);
    left -= out[k]!;
  }
  return out;
}

/** Build the context of an AI call (see the module comment). */
export function buildAiContext(input: Record<string, unknown> | undefined, o: AiContextOptions): AiContext {
  const budget = Math.max(200, o.budgetTokens ?? DEFAULT_CONTEXT_TOKENS);
  const safe = redactForAi(input ?? {}, o.redactor, { pii: o.maskPersonalData !== false });
  const leveled = applyPrivacy(safe.value, o.privacy) as Record<string, unknown>;
  const keys = Object.keys(leveled).filter((k) => leveled[k] !== undefined);
  const sizes = Object.fromEntries(keys.map((k) => [k, tokensOf(leveled[k])]));
  // JSON punctuation of the wrapper: a few tokens per section
  const shares = shareBudget(sizes, budget - keys.length * 4, o.sectionBudgets);
  const value: Record<string, unknown> = {};
  const sections: AiContextSection[] = [];
  for (const k of keys) {
    const f = fitSection(leveled[k], Math.max(20, shares[k]!));
    value[k] = f.value;
    sections.push({ name: k, tokens: tokensOf(f.value), originalTokens: sizes[k]!, notes: f.notes });
  }
  const text = keys.length ? JSON.stringify(value, null, 2) : '';
  return { text, tokens: estimateTokens(text), budgetTokens: budget, privacy: o.privacy, sections, redactions: safe.redactions, redactionCount: safe.total };
}
