/**
 * The JSONPath filter's suggestions (response body, JSON trees): every distinct path of a JSON value, arrays as `[*]`
 * with the keys of their elements merged, and the completions of what is typed.
 */

const segment = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`);

/**
 * The paths of a value (`$.items[*].name`), parents before children, at most `max` of them; an array contributes the
 * paths of its first `sample` elements (an API's arrays hold objects of one shape), so a 100 000-item body stays fast.
 */
export function jsonPaths(value: unknown, opts: { max?: number; depth?: number; sample?: number } = {}): string[] {
  const max = opts.max ?? 2000;
  const maxDepth = opts.depth ?? 12;
  const sample = opts.sample ?? 50;
  const out = new Set<string>();
  const walk = (v: unknown, path: string, depth: number) => {
    if (out.size >= max || depth > maxDepth || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      const p = `${path}[*]`;
      if (!v.length) return;
      out.add(p);
      for (const x of v.slice(0, sample)) walk(x, p, depth + 1);
      return;
    }
    for (const [k, x] of Object.entries(v)) {
      if (out.size >= max) return;
      const p = path + segment(k);
      out.add(p);
      walk(x, p, depth + 1);
    }
  };
  walk(value, '$', 0);
  return [...out];
}

/** How many segments a path has (`$.a[*].b` → 3). */
const depthOf = (p: string) => (p.match(/\.[^.[]+|\[[^\]]*\]/g) ?? []).length;
/** A path's last key (`$.a[*].b` → b, `$["x-y"]` → x-y). */
const lastKey = (p: string) => {
  const m = /(?:\.([^.[]+)|\[("(?:[^"\\]|\\.)*"|[^\]]*)\])$/.exec(p);
  if (!m) return '';
  if (m[1] !== undefined) return m[1];
  try {
    return m[2]!.startsWith('"') ? (JSON.parse(m[2]!) as string) : m[2]!;
  } catch {
    return m[2]!;
  }
};

/**
 * Completions of what is typed: a path (`$.ite`) completes to the paths that start with it, the next level first; a
 * plain word (`name`) finds the paths whose last key holds it, the ones that start with it first. Nothing typed: the
 * first level.
 */
export function suggestJsonPaths(paths: readonly string[], input: string, limit = 12): string[] {
  const q = input.trim();
  if (!q || q === '$') return paths.filter((p) => depthOf(p) === 1).slice(0, limit);
  const lower = q.toLowerCase();
  if (q.startsWith('$')) {
    const base = depthOf(q);
    return paths
      .filter((p) => p.length > q.length && p.toLowerCase().startsWith(lower))
      .map((p) => ({ p, d: depthOf(p) - base }))
      .sort((a, b) => a.d - b.d || a.p.length - b.p.length || a.p.localeCompare(b.p))
      .slice(0, limit)
      .map((x) => x.p);
  }
  return paths
    .map((p) => ({ p, k: lastKey(p).toLowerCase() }))
    .filter((x) => x.k.includes(lower))
    .sort((a, b) => Number(!a.k.startsWith(lower)) - Number(!b.k.startsWith(lower)) || depthOf(a.p) - depthOf(b.p) || a.p.localeCompare(b.p))
    .slice(0, limit)
    .map((x) => x.p);
}

/**
 * A path as typed, as a JSONPath from the root: `items[0].id` is `$.items[0].id`, `[0]` is `$[0]` — the same reading
 * as the engine's assertions and extractions (core util/jsonpath.ts), so a path that works in a check works here.
 */
export function rootedJsonPath(path: string): string {
  const p = path.trim();
  if (!p || p.startsWith('$')) return p || '$';
  return p.startsWith('[') ? `$${p}` : `$.${p}`;
}

/**
 * Why a JSONPath can't be right, or undefined: the library behind the filter reads almost anything (`$.[`, `$.a[`) as
 * some path and quietly matches something, so the filter checks the shape first and says what is wrong. A path without
 * the `$` is read from the root (rootedJsonPath).
 */
export function jsonPathProblem(path: string): string | undefined {
  const p = rootedJsonPath(path);
  const close: Record<string, string> = { '[': ']', '(': ')' };
  const stack: string[] = [];
  let quote: string | undefined;
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '[' || c === '(') stack.push(close[c]!);
    else if (c === ']' || c === ')') {
      if (stack.pop() !== c) return `“${c}” at ${i + 1} closes nothing`;
      if (c === ']' && p[i - 1] === '[') return 'an empty [] (use [*] for every item)';
    }
  }
  if (quote) return 'a quote is not closed';
  if (stack.length) return `“${stack[stack.length - 1]}” is missing`;
  if (/(^|[^.])\.$/.test(p) && p !== '$') return 'it ends with a dot: add a key';
  if (/\.{3,}/.test(p)) return 'too many dots';
  return undefined;
}
