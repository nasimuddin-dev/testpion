/** One way a response differs from its snapshot. */
interface SnapshotDifference {
  /** JSONPath of the place, e.g. $.items[0].price */
  path: string;
  kind: 'missing' | 'extra' | 'type' | 'value' | 'length';
  expected?: unknown;
  actual?: unknown;
}

interface SnapshotOptions {
  /**
   * shape (default): the same fields with the same types, values may change (good for live data);
   * values: the same values too (array lengths included).
   */
  mode?: 'shape' | 'values';
  /** JSONPaths not compared: `$.id`, `$.items[*].updatedAt`, `$..createdAt` (any depth). */
  ignore?: string[];
  /** Report fields the response has but the snapshot doesn't (off by default: new fields rarely break clients). */
  strict?: boolean;
  /** Stop after this many differences (default 50). */
  max?: number;
}

const kindOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const key = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`);

/** Path segments: `$.a[0]["b c"]` → ['a', 0, 'b c']; in patterns `*` / `[*]` match one segment and `..` any depth ('**'). */
function segments(path: string): Array<string | number> {
  const out: Array<string | number> = [];
  const re = /\.\.|\.([^.[\]]+)|\[(\d+|\*)\]|\[("(?:[^"\\]|\\.)*")\]/g;
  for (const m of path.trim().replace(/^\$/, '').matchAll(re)) {
    if (m[0] === '..') out.push('**');
    else if (m[1] !== undefined) out.push(m[1]);
    else if (m[2] !== undefined) out.push(m[2] === '*' ? '*' : Number(m[2]));
    else out.push(JSON.parse(m[3]!) as string);
  }
  return out;
}

/** Whether a concrete path is at or below one of the ignore patterns. */
function ignoreMatcher(patterns: string[]): (path: string) => boolean {
  const pats = patterns.filter((p) => p.trim()).map(segments);
  const match = (pat: Array<string | number>, p: Array<string | number>): boolean => {
    if (!pat.length) return true; // the pattern is a prefix: everything below is ignored too
    const [h, ...rest] = pat;
    if (h === '**') return p.some((_, i) => match(rest, p.slice(i))) || match(rest, []);
    if (!p.length) return false;
    return (h === '*' || h === p[0]) && match(rest, p.slice(1));
  };
  return (path) => {
    if (!pats.length) return false;
    const p = segments(path);
    return pats.some((pat) => match(pat, p));
  };
}

/**
 * How `actual` differs from the `expected` snapshot. In shape mode the values may change but not the
 * fields or their types; arrays are checked element by element against the snapshot's first element.
 */
export function compareSnapshot(expected: unknown, actual: unknown, opts: SnapshotOptions = {}): SnapshotDifference[] {
  const mode = opts.mode ?? 'shape';
  const max = opts.max ?? 50;
  const ignored = ignoreMatcher(opts.ignore ?? []);
  const out: SnapshotDifference[] = [];
  const walk = (e: unknown, a: unknown, path: string) => {
    if (out.length >= max || ignored(path)) return;
    const ke = kindOf(e);
    const ka = kindOf(a);
    // shape: null in the snapshot accepts anything (an optional value that happened to be empty)
    if (ke !== ka) {
      if (mode === 'shape' && (ke === 'null' || ka === 'null')) return;
      out.push({ path, kind: 'type', expected: ke, actual: ka });
      return;
    }
    if (ke === 'array') {
      const x = e as unknown[];
      const y = a as unknown[];
      if (mode === 'values') {
        if (x.length !== y.length) out.push({ path, kind: 'length', expected: x.length, actual: y.length });
        for (let i = 0; i < Math.min(x.length, y.length); i++) walk(x[i], y[i], `${path}[${i}]`);
      } else if (x.length) for (let i = 0; i < y.length; i++) walk(x[0], y[i], `${path}[${i}]`);
      return;
    }
    if (ke === 'object') {
      const x = e as Record<string, unknown>;
      const y = a as Record<string, unknown>;
      for (const k of Object.keys(x)) {
        if (out.length >= max) return;
        const p = path + key(k);
        if (!(k in y)) {
          if (!ignored(p)) out.push({ path: p, kind: 'missing', expected: x[k] });
        } else walk(x[k], y[k], p);
      }
      if (opts.strict) for (const k of Object.keys(y)) if (!(k in x) && !ignored(path + key(k)) && out.length < max) out.push({ path: path + key(k), kind: 'extra', actual: y[k] });
      return;
    }
    if (mode === 'values' && !Object.is(e, a)) out.push({ path, kind: 'value', expected: e, actual: a });
  };
  walk(expected, actual, '$');
  return out;
}

/** A difference in a few words, for check messages. */
export function describeDifference(d: SnapshotDifference): string {
  const v = (x: unknown) => (typeof x === 'string' ? JSON.stringify(x.length > 40 ? x.slice(0, 40) + '…' : x) : JSON.stringify(x));
  switch (d.kind) {
    case 'missing':
      return `${d.path} is missing`;
    case 'extra':
      return `${d.path} is new`;
    case 'type':
      return `${d.path} is ${d.actual}, was ${d.expected}`;
    case 'length':
      return `${d.path} has ${d.actual} items, was ${d.expected}`;
    default:
      return `${d.path} is ${v(d.actual)}, was ${v(d.expected)}`;
  }
}
