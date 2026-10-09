import { nodeRequire } from './lazy-require.js';

// jsonpath-plus loads with the first query, not at startup (see lazy-require.ts)
let jsonPathMod: typeof import('jsonpath-plus') | undefined;
const jsonPathLib = (): typeof import('jsonpath-plus') => (jsonPathMod ??= typeof require === 'function' ? require('jsonpath-plus') : nodeRequire('jsonpath-plus'));

/**
 * Evaluate a JSONPath expression. Returns the list of matches.
 * Accepts `$.a.b`, `a.b` (implicit root), `$['a']`, `$.items[*].id`, filters, etc.
 */
export function queryAll(data: unknown, path: string): unknown[] {
  const p = normalizePath(path);
  if (p === '$') return [data];
  if (data === null || typeof data !== 'object') return [];
  try {
    return jsonPathLib().JSONPath({ path: p, json: data as object, wrap: true }) as unknown[];
  } catch {
    return [];
  }
}

/** First match, or undefined. Use `exists()` to distinguish "missing" from `undefined` values. */
export function query(data: unknown, path: string): unknown {
  return queryAll(data, path)[0];
}

export function exists(data: unknown, path: string): boolean {
  return queryAll(data, path).length > 0;
}

function normalizePath(path: string): string {
  const p = path.trim();
  if (!p || p === '$') return '$';
  if (p.startsWith('$')) return p;
  if (p.startsWith('[')) return `$${p}`;
  return `$.${p}`;
}

/** Try to parse a string as JSON; tolerates ```json fenced blocks commonly produced by LLMs. */
export function tryParseJson(text: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof text !== 'string') return { ok: false };
  const t = text.trim();
  if (!t) return { ok: false };
  const candidates = [t];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const firstObj = t.indexOf('{');
  const lastObj = t.lastIndexOf('}');
  if (firstObj >= 0 && lastObj > firstObj) candidates.push(t.slice(firstObj, lastObj + 1));
  for (const c of candidates) {
    if (!/^[[{"\d-]|^(true|false|null)$/.test(c)) continue;
    try {
      return { ok: true, value: JSON.parse(c) };
    } catch {
      /* try next */
    }
  }
  return { ok: false };
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) {
    // loose numeric/string equality for values coming from YAML/text
    if ((typeof a === 'number' && typeof b === 'string') || (typeof a === 'string' && typeof b === 'number'))
      return String(a) === String(b);
    return false;
  }
  if (a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Infer a permissive JSON schema from an example value (used when `json-schema` has no explicit schema). */
export function inferSchema(example: unknown): Record<string, unknown> {
  if (example === null) return { type: 'null' };
  if (Array.isArray(example)) return { type: 'array', items: example.length ? inferSchema(example[0]) : {} };
  switch (typeof example) {
    case 'string':
      return { type: 'string' };
    case 'number':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'object': {
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(example as object)) props[k] = inferSchema(v);
      return { type: 'object', properties: props, required: Object.keys(props) };
    }
    default:
      return {};
  }
}
