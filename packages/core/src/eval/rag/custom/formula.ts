/**
 * The expression language of a `formula` custom metric (planning/rag-testing.md §4d): numbers, references to other metrics,
 * `+ - * /`, comparisons, `&& || !`, and the functions min, max, mean, abs, round, clamp, if, gate and coalesce. It is parsed
 * and evaluated here, never handed to `eval` or the script engine, so a formula in a pull request cannot do anything but
 * arithmetic. A metric without a score (n/a) makes every expression it takes part in n/a, unless `coalesce(x, fallback)` says
 * what to use instead. A name is written with underscores (`context_recall`, `answer_relevance`); a name with other
 * characters goes in backticks (`recall@5`, `custom/tone`).
 */

export type Node =
  | { t: 'num'; v: number }
  | { t: 'ref'; name: string }
  | { t: 'neg'; x: Node }
  | { t: 'not'; x: Node }
  | { t: 'bin'; op: string; l: Node; r: Node }
  | { t: 'call'; fn: string; args: Node[] };

const FUNCTIONS: Record<string, { min: number; max: number }> = {
  min: { min: 1, max: 20 },
  max: { min: 1, max: 20 },
  mean: { min: 1, max: 20 },
  abs: { min: 1, max: 1 },
  round: { min: 1, max: 2 },
  clamp: { min: 3, max: 3 },
  if: { min: 3, max: 3 },
  gate: { min: 3, max: 3 },
  coalesce: { min: 2, max: 20 },
};

type Tok = { k: 'num' | 'id' | 'op' | 'end'; v: string; at: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i))!;
      out.push({ k: 'num', v: m[0], at: i });
      i += m[0].length;
      continue;
    }
    if (c === '`') {
      const j = src.indexOf('`', i + 1);
      if (j < 0) throw new Error(`a backtick at ${i + 1} is not closed`);
      out.push({ k: 'id', v: src.slice(i + 1, j), at: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_@]*/.exec(src.slice(i))!;
      out.push({ k: 'id', v: m[0], at: i });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['>=', '<=', '==', '!=', '&&', '||'].includes(two)) {
      out.push({ k: 'op', v: two, at: i });
      i += 2;
      continue;
    }
    if ('+-*/(),<>!'.includes(c)) {
      out.push({ k: 'op', v: c, at: i });
      i++;
      continue;
    }
    throw new Error(`unexpected "${c}" at ${i + 1}`);
  }
  out.push({ k: 'end', v: '', at: src.length });
  return out;
}

const MAX_LENGTH = 2000;
const MAX_DEPTH = 40;

class Parser {
  private p = 0;
  private depth = 0;
  readonly refs = new Set<string>();
  constructor(private readonly toks: Tok[]) {}
  private get cur() {
    return this.toks[this.p]!;
  }
  private eat(v: string) {
    if (this.cur.k === 'op' && this.cur.v === v) {
      this.p++;
      return true;
    }
    return false;
  }
  private expect(v: string) {
    if (!this.eat(v)) throw new Error(`expected "${v}" at ${this.cur.at + 1}${this.cur.k === 'end' ? ' (the expression ends here)' : ` but found "${this.cur.v}"`}`);
  }
  parse(): Node {
    const n = this.or();
    if (this.cur.k !== 'end') throw new Error(`unexpected "${this.cur.v}" at ${this.cur.at + 1}`);
    return n;
  }
  private nest<T>(f: () => T): T {
    if (++this.depth > MAX_DEPTH) throw new Error('the expression is nested too deeply');
    try {
      return f();
    } finally {
      this.depth--;
    }
  }
  private or(): Node {
    let l = this.and();
    while (this.eat('||')) l = { t: 'bin', op: '||', l, r: this.and() };
    return l;
  }
  private and(): Node {
    let l = this.cmp();
    while (this.eat('&&')) l = { t: 'bin', op: '&&', l, r: this.cmp() };
    return l;
  }
  private cmp(): Node {
    const l = this.add();
    for (const op of ['>=', '<=', '==', '!=', '>', '<']) if (this.eat(op)) return { t: 'bin', op, l, r: this.add() };
    return l;
  }
  private add(): Node {
    let l = this.mul();
    for (;;) {
      if (this.eat('+')) l = { t: 'bin', op: '+', l, r: this.mul() };
      else if (this.eat('-')) l = { t: 'bin', op: '-', l, r: this.mul() };
      else return l;
    }
  }
  private mul(): Node {
    let l = this.unary();
    for (;;) {
      if (this.eat('*')) l = { t: 'bin', op: '*', l, r: this.unary() };
      else if (this.eat('/')) l = { t: 'bin', op: '/', l, r: this.unary() };
      else return l;
    }
  }
  private unary(): Node {
    return this.nest(() => {
      if (this.eat('-')) return { t: 'neg', x: this.unary() };
      if (this.eat('!')) return { t: 'not', x: this.unary() };
      return this.primary();
    });
  }
  private primary(): Node {
    const c = this.cur;
    if (c.k === 'num') {
      this.p++;
      return { t: 'num', v: Number(c.v) };
    }
    if (c.k === 'id') {
      this.p++;
      if (this.cur.k === 'op' && this.cur.v === '(' && /^[a-z]+$/.test(c.v)) {
        const spec = FUNCTIONS[c.v];
        if (!spec) throw new Error(`"${c.v}" is not a function (min, max, mean, abs, round, clamp, if, gate, coalesce); a metric name has no brackets`);
        this.p++;
        const args: Node[] = [];
        if (!this.eat(')')) {
          do args.push(this.nest(() => this.or()));
          while (this.eat(','));
          this.expect(')');
        }
        if (args.length < spec.min || args.length > spec.max) throw new Error(`${c.v}() takes ${spec.min === spec.max ? spec.min : `${spec.min} to ${spec.max}`} argument${spec.max === 1 ? '' : 's'}, not ${args.length}`);
        return { t: 'call', fn: c.v, args };
      }
      this.refs.add(c.v);
      return { t: 'ref', name: c.v };
    }
    if (this.eat('(')) {
      const n = this.nest(() => this.or());
      this.expect(')');
      return n;
    }
    throw new Error(c.k === 'end' ? 'the expression ends too early' : `unexpected "${c.v}" at ${c.at + 1}`);
  }
}

export interface ParsedFormula {
  ast?: Node;
  /** The metric names the expression reads, as written. */
  refs: string[];
  problems: string[];
}

export function parseFormula(src: string): ParsedFormula {
  if (typeof src !== 'string' || !src.trim()) return { refs: [], problems: ['The formula is empty.'] };
  if (src.length > MAX_LENGTH) return { refs: [], problems: [`The formula is longer than ${MAX_LENGTH} characters.`] };
  try {
    const p = new Parser(tokenize(src));
    const ast = p.parse();
    return { ast, refs: [...p.refs], problems: [] };
  } catch (e) {
    return { refs: [], problems: [(e as Error).message] };
  }
}

/** A value of the language: a number, or null for "no score". Booleans are 1 and 0. */
export type Value = number | null;

const truth = (v: Value): Value => (v === null ? null : v !== 0 ? 1 : 0);

/** Evaluates with the values of the references; a reference missing from the map is n/a. */
export function evalFormula(n: Node, ref: (name: string) => Value): Value {
  const ev = (x: Node): Value => {
    switch (x.t) {
      case 'num':
        return x.v;
      case 'ref':
        return ref(x.name) ?? null;
      case 'neg': {
        const v = ev(x.x);
        return v === null ? null : -v;
      }
      case 'not': {
        const v = ev(x.x);
        return v === null ? null : v === 0 ? 1 : 0;
      }
      case 'bin': {
        const l = ev(x.l);
        const r = ev(x.r);
        if (l === null || r === null) {
          // a short circuit that does not need the missing side still has an answer
          if (x.op === '&&' && (l === 0 || r === 0)) return 0;
          if (x.op === '||' && ((l !== null && l !== 0) || (r !== null && r !== 0))) return 1;
          return null;
        }
        switch (x.op) {
          case '+':
            return l + r;
          case '-':
            return l - r;
          case '*':
            return l * r;
          case '/':
            return r === 0 ? null : l / r;
          case '>':
            return l > r ? 1 : 0;
          case '<':
            return l < r ? 1 : 0;
          case '>=':
            return l >= r ? 1 : 0;
          case '<=':
            return l <= r ? 1 : 0;
          case '==':
            return Math.abs(l - r) < 1e-9 ? 1 : 0;
          case '!=':
            return Math.abs(l - r) < 1e-9 ? 0 : 1;
          case '&&':
            return l !== 0 && r !== 0 ? 1 : 0;
          case '||':
            return l !== 0 || r !== 0 ? 1 : 0;
        }
        return null;
      }
      case 'call': {
        if (x.fn === 'coalesce') {
          for (const a of x.args) {
            const v = ev(a);
            if (v !== null) return v;
          }
          return null;
        }
        if (x.fn === 'if' || x.fn === 'gate') {
          const c = truth(ev(x.args[0]!));
          return c === null ? null : ev(x.args[c === 1 ? 1 : 2]!);
        }
        const vs = x.args.map(ev);
        if (vs.some((v) => v === null)) return null;
        const ns = vs as number[];
        switch (x.fn) {
          case 'min':
            return Math.min(...ns);
          case 'max':
            return Math.max(...ns);
          case 'mean':
            return ns.reduce((a, b) => a + b, 0) / ns.length;
          case 'abs':
            return Math.abs(ns[0]!);
          case 'round': {
            const f = 10 ** (ns[1] ?? 0);
            return Math.round(ns[0]! * f) / f;
          }
          case 'clamp':
            return Math.min(ns[2]!, Math.max(ns[1]!, ns[0]!));
        }
        return null;
      }
    }
  };
  const v = ev(n);
  return v !== null && Number.isFinite(v) ? v : null;
}
