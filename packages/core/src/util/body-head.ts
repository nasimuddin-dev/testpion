import { redactedHead, type Redactor } from './redact.js';

/**
 * The head of a (possibly huge) parsed value: a copy that stops after about `maxChars` characters of content, so redacting and
 * pretty-printing it costs O(head), never O(body). A GraphQL or gRPC response can be tens of megabytes of parsed JSON, and a trace,
 * a result row or a console entry keeps a few kilobytes of it.
 *
 * `cut` says whether anything was left out. When it is false the value is small and the caller should use the original: the result
 * of the old whole-value path is then identical (nothing here changes what a small body looks like).
 */
export interface ValueHead {
  value: unknown;
  cut: boolean;
}

const MAX_DEPTH = 40;

export function headOfValue(v: unknown, maxChars: number): ValueHead {
  let left = maxChars;
  let cut = false;
  const walk = (x: unknown, depth: number): unknown => {
    if (x === null || x === undefined || typeof x === 'number' || typeof x === 'boolean' || typeof x === 'bigint') {
      left -= 6;
      return x;
    }
    if (typeof x === 'string') {
      left -= x.length + 2;
      if (left >= 0) return x;
      cut = true;
      const keep = x.length + left; // the part of the string that still fitted
      left = 0;
      return x.slice(0, Math.max(0, keep));
    }
    if (typeof x !== 'object') return x;
    if (ArrayBuffer.isView(x) || x instanceof ArrayBuffer) {
      const n = x instanceof ArrayBuffer ? x.byteLength : x.byteLength;
      left -= n;
      if (left >= 0) return x;
      cut = true;
      left = 0;
      return `[binary ${n} bytes]`;
    }
    if (depth > MAX_DEPTH) {
      cut = true;
      return '[…]';
    }
    if (Array.isArray(x)) {
      const out: unknown[] = [];
      for (let i = 0; i < x.length; i++) {
        if (left <= 0) {
          cut = true;
          break;
        }
        left -= 2;
        out.push(walk(x[i], depth + 1));
      }
      return out;
    }
    const proto = Object.getPrototypeOf(x);
    if (proto !== Object.prototype && proto !== null) {
      left -= 32; // a Date, a Map, a class instance: serialised by its own rules, small
      return x;
    }
    const out: Record<string, unknown> = {};
    for (const k in x as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(x, k)) continue;
      if (left <= 0) {
        cut = true;
        break;
      }
      left -= k.length + 4;
      out[k] = walk((x as Record<string, unknown>)[k], depth + 1);
    }
    return out;
  };
  const value = walk(v, 0);
  return { value, cut };
}

/** A value this big (in characters of content) is cut to its head before it is redacted or pretty-printed. */
const BIG_VALUE_CHARS = 64 * 1024;

/**
 * The redacted summary (at most `n` characters) of a parsed result - a GraphQL response, a gRPC message, subscription events: the
 * same text as the whole-value path for a value up to 64 KB; a bigger one is cut to its head first, so the cost is O(summary),
 * not O(body) (a 14 MB result was deep-copied and pretty-printed whole, twice per step, to keep 1.5 KB and 16 KB of it).
 */
export function summarizeParsed(redactor: Pick<Redactor, 'redact' | 'redactString'>, v: unknown, n: number): string {
  const cutTo = (s: string) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s);
  if (typeof v === 'string') {
    const { head, rest } = redactedHead(redactor, v, n);
    return rest ? `${head}… [${rest} more chars]` : head;
  }
  const h = headOfValue(v, BIG_VALUE_CHARS);
  if (!h.cut) return cutTo(JSON.stringify(redactor.redact(v), null, 2) ?? '');
  const s = JSON.stringify(redactor.redact(h.value), null, 2) ?? '';
  return `${s.slice(0, n)}… [more chars]`;
}
