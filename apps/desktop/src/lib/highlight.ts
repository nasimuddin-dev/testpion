/**
 * Syntax colours for read-only code (payloads, schemas, configs, raw HTTP), without loading the editor: the text is
 * cut into tokens whose kinds match the editor theme's colours (styles.css `.syn-*`). Small and fast; texts past
 * MAX_CHARS are shown plain.
 */
export type CodeLanguage = 'json' | 'yaml' | 'xml' | 'http' | 'plain';
export type TokenKind = 'key' | 'string' | 'number' | 'keyword' | 'comment' | 'tag' | 'attr' | 'punct' | 'method';
export interface Token {
  text: string;
  kind?: TokenKind;
}

export const MAX_CHARS = 200_000;
const METHOD = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\s/;

/** The language a text most likely is: JSON (it parses or looks like it), XML/HTML, raw HTTP, YAML, else plain. */
export function detectLanguage(text: string): CodeLanguage {
  const t = text.trimStart();
  if (!t) return 'plain';
  if (/^[[{]/.test(t)) return 'json';
  if (t.startsWith('<')) return 'xml';
  if (METHOD.test(t) || /^HTTP\/\d/.test(t)) return 'http';
  const lines = t.split('\n', 20).filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (lines.length && lines.filter((l) => /^\s*(- )?[\w.$"'-]+:(\s|$)|^\s*- /.test(l)).length >= Math.ceil(lines.length * 0.6)) return 'yaml';
  return 'plain';
}

function json(text: string): Token[] {
  const out: Token[] = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|\b(true|false|null)\b|([{}[\],:])/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    if (m[1] !== undefined) {
      out.push({ text: m[1], kind: m[2] ? 'key' : 'string' });
      if (m[2]) out.push({ text: m[2], kind: 'punct' });
    } else if (m[3] !== undefined) out.push({ text: m[3], kind: 'number' });
    else if (m[4] !== undefined) out.push({ text: m[4], kind: 'keyword' });
    else out.push({ text: m[5]!, kind: 'punct' });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

function yamlValue(v: string, out: Token[]) {
  const lead = /^\s*/.exec(v)![0];
  if (lead) out.push({ text: lead });
  const rest = v.slice(lead.length);
  const c = / #.*$/.exec(rest);
  const val = c ? rest.slice(0, c.index) : rest;
  if (val) {
    const kind: TokenKind | undefined = /^(['"]).*\1\s*$/.test(val)
      ? 'string'
      : /^-?\d+(\.\d+)?\s*$/.test(val)
        ? 'number'
        : /^(true|false|null|yes|no|~)\s*$/i.test(val)
          ? 'keyword'
          : /^[|>][-+]?\s*$/.test(val)
            ? 'punct'
            : 'string';
    out.push({ text: val, kind });
  }
  if (c) out.push({ text: c[0], kind: 'comment' });
}

function yaml(text: string): Token[] {
  const out: Token[] = [];
  text.split('\n').forEach((line, i) => {
    if (i) out.push({ text: '\n' });
    if (/^\s*#/.test(line)) return void out.push({ text: line, kind: 'comment' });
    const m = /^(\s*(?:- )?)([\w.$/-]+|"[^"]*"|'[^']*')(:)(?=\s|$)(.*)$/.exec(line);
    if (m) {
      if (m[1]) out.push({ text: m[1], kind: m[1].includes('-') ? 'punct' : undefined });
      out.push({ text: m[2]!, kind: 'key' }, { text: m[3]!, kind: 'punct' });
      yamlValue(m[4]!, out);
      return;
    }
    const item = /^(\s*- )(.*)$/.exec(line);
    if (item) {
      out.push({ text: item[1]!, kind: 'punct' });
      yamlValue(item[2]!, out);
      return;
    }
    out.push({ text: line });
  });
  return out;
}

function xml(text: string): Token[] {
  const out: Token[] = [];
  const re = /(<!--[\s\S]*?-->)|(<\/?[\w:.-]+)|([\w:.-]+)(=)("[^"]*"|'[^']*')|(\/?>)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    if (m[1]) out.push({ text: m[1], kind: 'comment' });
    else if (m[2]) out.push({ text: m[2], kind: 'tag' });
    else if (m[3]) out.push({ text: m[3], kind: 'attr' }, { text: m[4]!, kind: 'punct' }, { text: m[5]!, kind: 'string' });
    else out.push({ text: m[6]!, kind: 'tag' });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

function http(text: string): Token[] {
  const out: Token[] = [];
  const nl = text.search(/\r?\n\r?\n/);
  const head = nl < 0 ? text : text.slice(0, nl);
  const body = nl < 0 ? '' : text.slice(nl);
  head.split('\n').forEach((line, i) => {
    if (i) out.push({ text: '\n' });
    const start = i === 0 ? /^([A-Z]+)(\s+)(\S+)(.*)$/.exec(line) : undefined;
    if (start && (METHOD.test(line) || /^HTTP\//.test(line))) {
      out.push({ text: start[1]!, kind: 'method' }, { text: start[2]! }, { text: start[3]!, kind: /^HTTP\//.test(line) ? 'number' : 'string' }, { text: start[4]! });
      return;
    }
    const h = /^([\w-]+)(:)(.*)$/.exec(line);
    if (h) out.push({ text: h[1]!, kind: 'key' }, { text: h[2]!, kind: 'punct' }, { text: h[3]! });
    else out.push({ text: line });
  });
  if (body) {
    const lead = /^\s*/.exec(body)![0];
    out.push({ text: lead }, ...highlight(body.slice(lead.length)));
  }
  return out;
}

/** The text as tokens in its language (detected when not given). */
export function highlight(text: string, language?: CodeLanguage): Token[] {
  if (!text || text.length > MAX_CHARS) return [{ text }];
  const lang = language ?? detectLanguage(text);
  return lang === 'json' ? json(text) : lang === 'yaml' ? yaml(text) : lang === 'xml' ? xml(text) : lang === 'http' ? http(text) : [{ text }];
}
