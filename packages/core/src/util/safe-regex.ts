import { Script, createContext } from 'node:vm';
import { ApsError } from '../errors.js';

/**
 * Regular expressions typed by the user (Debugger rules, regex checks, find and replace, a test filter) run on the thread that
 * serves the window or the run. A pattern like `^(a+)+$` takes minutes on a short text and freezes the app. Two defences:
 * `unsafeRegexReason` refuses the classic shapes when the pattern is saved or compiled (nested repetition, a repeated group of
 * overlapping alternatives, a very long pattern), and `safeTest` / `safeReplace` run the expression with a deadline (the
 * engine is interrupted, not waited for), so a shape the check does not know cannot hold the app for long either.
 */

/** Longest pattern accepted. */
export const MAX_PATTERN = 500;
/** Longest text a pattern is run on (the rest is not looked at). */
export const MAX_REGEX_INPUT = 1_000_000;

/** Why a pattern is refused (a sentence for the person), or undefined when it looks fine. */
export const unsafeRegexReason = (pattern: string): string | undefined => analyzeRegex(pattern).refuse;

/**
 * `refuse`: a shape that takes minutes on a short text. `watch`: a shape that can be slow on some texts (a repeated group with a
 * repetition inside, many open-ended repetitions in a row): allowed, but run with a deadline (safeTest).
 */
export function analyzeRegex(pattern: string): { refuse?: string; watch: boolean } {
  if (pattern.length > MAX_PATTERN) return { refuse: `the pattern is longer than ${MAX_PATTERN} characters`, watch: false };
  let watch = false;
  let openEnded = 0;
  const refuse = (reason: string) => ({ refuse: reason, watch: false });
  interface Frame {
    /** Some unbounded repetition anywhere inside this group. */
    repeatsInside: boolean;
    /** The alternative being read ends with an unbounded repetition (`*`, `+`, `{n,}`): `a+` in `(a+)`, `(b|a+)`. */
    endsRepeating: boolean;
    /** Some alternative of the group ends that way. */
    anyEndRepeats: boolean;
    /** First character of each alternative so far (the current one is last). */
    firsts: Array<string | undefined>;
    alternatives: number;
  }
  const fresh = (): Frame => ({ repeatsInside: false, endsRepeating: false, anyEndRepeats: false, firsts: [undefined], alternatives: 1 });
  const stack: Frame[] = [fresh()];
  /** What the previous atom was: a closed group (its frame) or something single. */
  let last: { group?: Frame } | undefined;
  let i = 0;
  const top = () => stack[stack.length - 1]!;
  const noteFirst = (c: string) => {
    const f = top();
    f.endsRepeating = false; // an atom: whatever came before it no longer ends the alternative
    if (f.firsts[f.firsts.length - 1] === undefined) f.firsts[f.firsts.length - 1] = c;
  };
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === '\\') {
      noteFirst(pattern.slice(i, i + 2));
      i += 2;
      last = {};
      continue;
    }
    if (c === '[') {
      // a class: up to the closing ]
      let j = i + 1;
      if (pattern[j] === '^') j++;
      if (pattern[j] === ']') j++;
      while (j < pattern.length && pattern[j] !== ']') j += pattern[j] === '\\' ? 2 : 1;
      noteFirst('[');
      i = j + 1;
      last = {};
      continue;
    }
    if (c === '(') {
      // (?: (?= (?! (?<name> (?<= (?<!
      stack.push(fresh());
      i++;
      if (pattern[i] === '?') i += pattern[i + 1] === '<' && pattern[i + 2] !== '=' && pattern[i + 2] !== '!' ? pattern.indexOf('>', i) - i + 1 : 2;
      last = undefined;
      continue;
    }
    if (c === ')') {
      const frame = stack.length > 1 ? stack.pop()! : undefined;
      if (frame) {
        frame.anyEndRepeats ||= frame.endsRepeating;
        if (frame.repeatsInside) top().repeatsInside = true;
      }
      last = frame ? { group: frame } : {};
      if (frame) noteFirst(frame.firsts[0] ?? '(');
      i++;
      continue;
    }
    if (c === '|') {
      const f = top();
      f.anyEndRepeats ||= f.endsRepeating;
      f.endsRepeating = false;
      f.firsts.push(undefined);
      f.alternatives++;
      last = undefined;
      i++;
      continue;
    }
    let quant: { unbounded: boolean; len: number } | undefined;
    if (c === '*' || c === '+') quant = { unbounded: true, len: 1 };
    else if (c === '?') quant = { unbounded: false, len: 1 };
    else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
      if (m) quant = { unbounded: m[2] !== undefined && (m[3] === '' || Number(m[3]) >= 20), len: m[0].length };
    }
    if (quant) {
      if (quant.unbounded) {
        const g = last?.group;
        if (g?.anyEndRepeats) return refuse('it repeats a group that ends with a repetition (like (a+)+), which can take minutes on a short text');
        if (g?.repeatsInside) watch = true;
        openEnded++;
        // (a|aa)+ , (\w|\d)* : alternatives that can start the same way
        if (g && g.alternatives > 1) {
          const firsts = g.firsts;
          if (firsts.some((f) => f === undefined || f === '.' || f === '[' || /^\\[wWdDsS.]$/.test(f)) || new Set(firsts).size < firsts.length) return refuse('it repeats a group of alternatives that can match the same text (like (a|aa)+), which can take minutes on a short text');
        }
        top().endsRepeating = true;
        top().repeatsInside = true;
      }
      i += quant.len;
      if (pattern[i] === '?' || pattern[i] === '+') i++; // lazy
      continue;
    }
    noteFirst(c);
    last = {};
    i++;
  }
  // .*.*.*x : polynomial, not exponential, but slow on a long text
  if (openEnded >= 4) watch = true;
  return { watch };
}

/** Expressions compiled by compileUserRegex whose shape can be slow: `safeTest` runs them with a deadline. */
const watched = new WeakSet<RegExp>();

/** The pattern compiled, or an ApsError that says why not (invalid, too long, or a shape that can freeze the app). */
export function compileUserRegex(pattern: string, flags = '', what = 'The pattern'): RegExp {
  const a = analyzeRegex(pattern);
  if (a.refuse) throw new ApsError('ValidationError', `${what} is refused: ${a.refuse}`, { suggestions: ['Write it without nested repetition, or match a shorter piece of the text.'] });
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch (e) {
    throw new ApsError('ValidationError', `Not a valid regular expression: ${(e as Error).message}`);
  }
  if (a.watch) watched.add(re);
  return re;
}

const sandbox = createContext({ re: undefined as RegExp | undefined, text: '', rep: '' });
const testScript = new Script('re.lastIndex = 0, re.test(text)');
const replaceScript = new Script('text.replace(re, rep)');

/** `re.test(text)` with a deadline: a pattern that runs longer than `ms` counts as no match (and `timedOut` says so). */
export function safeTest(re: RegExp, text: string, ms = 100): { matched: boolean; timedOut?: boolean } {
  // the common shapes cannot blow up (compileUserRegex refused the others): no watchdog, which costs about 10 ms a call
  if (!watched.has(re)) {
    re.lastIndex = 0;
    return { matched: re.test(text.length > MAX_REGEX_INPUT ? text.slice(0, MAX_REGEX_INPUT) : text) };
  }
  const s = sandbox as { re?: RegExp; text: string };
  s.re = re;
  s.text = text.length > MAX_REGEX_INPUT ? text.slice(0, MAX_REGEX_INPUT) : text;
  try {
    return { matched: testScript.runInContext(sandbox, { timeout: ms }) === true };
  } catch {
    return { matched: false, timedOut: true };
  } finally {
    s.re = undefined;
    s.text = '';
  }
}

/** `text.replace(re, replacement)` with a deadline; throws an ApsError when the pattern runs too long. */
export function safeReplace(re: RegExp, text: string, replacement: string, ms = 500): string {
  if (!watched.has(re)) return text.replace(re, replacement);
  const s = sandbox as { re?: RegExp; text: string; rep: string };
  s.re = re;
  s.text = text;
  s.rep = replacement;
  try {
    return String(replaceScript.runInContext(sandbox, { timeout: ms }));
  } catch {
    throw new ApsError('ValidationError', `The pattern took longer than ${ms} ms on a text of ${text.length} characters`, { suggestions: ['Make the pattern more specific.'] });
  } finally {
    s.re = undefined;
    s.text = '';
    s.rep = '';
  }
}
