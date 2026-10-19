import { convertScript } from './convert/index.js';

/**
 * TestPion scripts can use `tp.*` or Postman's `pm.*`: in the sandbox both names are the same
 * object. Postman only knows `pm`, so scripts are converted to `pm.*` when they are exported to
 * Postman, and can optionally be converted the other way.
 *
 * The conversion only touches code: text in strings, template literals (outside `${…}`),
 * comments and regular expressions is left alone, as is `obj.tp` (a property). A script that
 * declares its own `tp` (or `pm`) variable is returned unchanged.
 */
export function renameScriptGlobal(code: string, from: 'tp' | 'pm', to: 'tp' | 'pm'): { code: string; changed: number; skipped?: string } {
  if (!code || !new RegExp(`\\b${from}\\b`).test(code)) return { code, changed: 0 };
  const declares = (name: string) =>
    new RegExp(
      [
        `\\b(?:const|let|var|function|class)\\s+${name}\\b`, // const tp = …, function tp()
        `\\b(?:const|let|var)\\s*[{[][^}\\]]*\\b${name}\\b`, // const { tp } = …
        `\\bfunction\\b[^(]*\\([^)]*\\b${name}\\b[^)]*\\)`, // function f(a, tp)
        `\\(([^()]*[,\\s(])?${name}\\s*(,[^()]*)?\\)\\s*=>`, // (a, tp) => …
        `\\b${name}\\s*=>`, // tp => …
        `\\bcatch\\s*\\(\\s*${name}\\s*\\)`, // catch (tp)
      ].join('|'),
    ).test(code);
  if (declares(from)) return { code, changed: 0, skipped: `the script declares its own "${from}"` };
  if (declares(to)) return { code, changed: 0, skipped: `the script declares its own "${to}"` };

  let out = '';
  let changed = 0;
  let i = 0;
  const n = code.length;
  /** Last significant character before the current position (to tell a regex from a division). */
  let prevSig = '';
  let prevWord = '';
  const templateDepth: number[] = []; // brace depth at which each open `${` returns to its template
  let braces = 0;

  const copyString = (q: string) => {
    let j = i + 1;
    while (j < n && code[j] !== q) {
      if (code[j] === '\\') j++;
      else if (code[j] === '\n') break;
      j++;
    }
    out += code.slice(i, j + 1);
    i = j + 1;
  };
  /** Copy template text up to the closing backtick or a `${` (which re-enters code). */
  const copyTemplate = () => {
    let j = i;
    while (j < n) {
      if (code[j] === '\\') j += 2;
      else if (code[j] === '`') {
        out += code.slice(i, j + 1);
        i = j + 1;
        return;
      } else if (code[j] === '$' && code[j + 1] === '{') {
        out += code.slice(i, j + 2);
        i = j + 2;
        templateDepth.push(braces);
        braces++;
        return;
      } else j++;
    }
    out += code.slice(i);
    i = n;
  };

  while (i < n) {
    const c = code[i]!;
    const c2 = code[i + 1];
    if (c === '/' && c2 === '/') {
      const e = code.indexOf('\n', i);
      const end = e < 0 ? n : e;
      out += code.slice(i, end);
      i = end;
      continue;
    }
    if (c === '/' && c2 === '*') {
      const e = code.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      out += code.slice(i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      copyString(c);
      prevSig = c;
      prevWord = '';
      continue;
    }
    if (c === '`') {
      out += c;
      i++;
      copyTemplate();
      prevSig = '`';
      prevWord = '';
      continue;
    }
    if (c === '/') {
      // a regex literal where an expression can start; otherwise division
      const regexCanStart = !prevSig || /[(,=:[!&|?{};+\-*%<>~^]/.test(prevSig) || /^(return|typeof|case|in|of|delete|void|throw|new)$/.test(prevWord);
      if (regexCanStart) {
        let j = i + 1;
        let inClass = false;
        while (j < n && code[j] !== '\n') {
          if (code[j] === '\\') j++;
          else if (code[j] === '[') inClass = true;
          else if (code[j] === ']') inClass = false;
          else if (code[j] === '/' && !inClass) break;
          j++;
        }
        j++;
        while (j < n && /[a-z]/i.test(code[j]!)) j++;
        out += code.slice(i, j);
        i = j;
        prevSig = '/';
        prevWord = '';
        continue;
      }
    }
    if (c === '{') braces++;
    if (c === '}') {
      braces--;
      if (templateDepth.length && braces === templateDepth[templateDepth.length - 1]) {
        templateDepth.pop();
        out += c;
        i++;
        copyTemplate();
        prevSig = '`';
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(code[j]!)) j++;
      const word = code.slice(i, j);
      // `tp` as a global: not a property (`x.tp`) and used as an object (`tp.` / `tp[`)
      let k = j;
      while (k < n && (code[k] === ' ' || code[k] === '\t')) k++;
      const isGlobalUse = word === from && prevSig !== '.' && (code[k] === '.' || code[k] === '[');
      if (isGlobalUse) {
        out += to;
        changed++;
      } else out += word;
      i = j;
      prevSig = word[word.length - 1]!;
      prevWord = word;
      continue;
    }
    out += c;
    if (!/\s/.test(c)) {
      prevSig = c;
      prevWord = '';
    }
    i++;
  }
  return { code: out, changed };
}

/** A script for Postman: `tp.*` becomes `pm.*` (Postman has no `tp`). */
export function toPostmanScript(code: string | undefined): string | undefined {
  return code === undefined ? undefined : renameScriptGlobal(code, 'tp', 'pm').code;
}

export interface ScriptConversion<C> {
  collection: C;
  /** Scripts that were rewritten. */
  changed: number;
  /** Individual `pm.`/`tp.` uses rewritten. */
  replacements: number;
  /** Scripts left as they are, with the reason (e.g. they declare their own `tp`). */
  skipped: Array<{ where: string; reason: string }>;
}

type ScriptHolder = { name?: string; preRequestScript?: string; testScript?: string; items?: ScriptHolder[]; kind?: string };

function treeRename(code: string): { code: string; changed: number; skipped?: string } {
  const r = convertScript(code, 'postman');
  return { code: r.code, changed: r.changes, ...(r.status === 'kept' ? { skipped: r.reason } : {}) };
}

/**
 * Rewrite every script in a collection (collection, folders and requests) from `from` to `to`,
 * e.g. Postman's `pm.*` to TestPion's `tp.*`. Returns a new collection; the input is not changed.
 */
export function convertCollectionScripts<C extends ScriptHolder>(collection: C, from: 'tp' | 'pm', to: 'tp' | 'pm'): ScriptConversion<C> {
  let changed = 0;
  let replacements = 0;
  const skipped: Array<{ where: string; reason: string }> = [];
  const fix = (code: string | undefined, where: string): string | undefined => {
    if (!code) return code;
    // Postman's pm.* to TestPion's tp.*: by syntax tree (scope-aware, legacy postman.* too); the other way by tokens
    const r = from === 'pm' && to === 'tp' ? treeRename(code) : renameScriptGlobal(code, from, to);
    if (r.skipped) skipped.push({ where, reason: r.skipped });
    if (r.changed) {
      changed++;
      replacements += r.changed;
    }
    return r.code;
  };
  const walk = <T extends ScriptHolder>(n: T, path: string): T => {
    const out: T = { ...n };
    if (n.preRequestScript !== undefined) out.preRequestScript = fix(n.preRequestScript, `${path} (pre-request)`);
    if (n.testScript !== undefined) out.testScript = fix(n.testScript, `${path} (post-response)`);
    if (n.items) out.items = n.items.map((c) => walk(c, `${path} / ${c.name ?? '?'}`));
    return out;
  };
  return { collection: walk(collection, collection.name ?? 'collection'), changed, replacements, skipped };
}
