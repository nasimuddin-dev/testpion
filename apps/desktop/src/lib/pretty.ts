/**
 * "Pretty" for a body: JSON indented, HTML and XML one element per line with nesting, anything else as it is.
 * The one formatter behind every Pretty view (a response, a trace's payload, a Debugger exchange). Texts past
 * MAX_PRETTY are shown as they are.
 */
export const MAX_PRETTY = 2_000_000;

/** HTML elements that never have content or a closing tag. */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', '!doctype']);
/** Elements whose content is kept exactly (code, preformatted text). */
const RAW = new Set(['script', 'style', 'pre', 'textarea']);

/** HTML or XML, one tag per line, indented by nesting; text between tags is trimmed onto its own line. */
export function prettyMarkup(text: string, indent = '  '): string {
  const out: string[] = [];
  let depth = 0;
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/?([A-Za-z][\w:.-]*)(?:"[^"]*"|'[^']*'|[^'">])*>/g;
  let last = 0;
  const line = (s: string) => out.push(indent.repeat(Math.max(0, depth)) + s);
  const textBetween = (s: string) => {
    const t = s.replace(/\s+/g, ' ').trim();
    if (t) line(t);
  };
  for (let m = re.exec(text); m; m = re.exec(text)) {
    textBetween(text.slice(last, m.index));
    const tag = m[0];
    const name = (m[1] ?? '').toLowerCase();
    last = re.lastIndex;
    if (!m[1]) {
      line(tag.replace(/\s+/g, ' ')); // a comment, a doctype, a processing instruction or CDATA
      continue;
    }
    if (tag.startsWith('</')) {
      depth--;
      line(tag);
      continue;
    }
    const selfClosing = tag.endsWith('/>') || VOID.has(name);
    if (RAW.has(name) && !selfClosing) {
      // the element's content as it is, up to its closing tag
      const close = new RegExp(`</${name}\\s*>`, 'i');
      const rest = text.slice(last);
      const end = rest.search(close);
      const body = end < 0 ? rest : rest.slice(0, end);
      const closing = end < 0 ? '' : rest.slice(end).match(close)![0];
      line(tag);
      if (body.trim()) for (const l of body.replace(/^\s*\n|\n\s*$/g, '').split('\n')) out.push(indent.repeat(depth + 1) + l.trimEnd());
      if (closing) line(closing);
      last += body.length + closing.length;
      re.lastIndex = last;
      continue;
    }
    // a short element whose content is only text stays on one line: <title>Google</title>
    const short = /^([^<]{0,120})<\/([A-Za-z][\w:.-]*)\s*>/.exec(text.slice(last));
    if (!selfClosing && short && short[2]!.toLowerCase() === name && !short[1]!.includes('\n')) {
      line(tag + short[1]!.trim() + `</${short[2]}>`);
      last += short[0].length;
      re.lastIndex = last;
      continue;
    }
    line(tag);
    if (!selfClosing) depth++;
  }
  textBetween(text.slice(last));
  return out.join('\n');
}

/** The body in its pretty form: JSON indented, HTML / XML laid out by nesting, other text unchanged. */
export function prettyBody(text: string, contentType = ''): string {
  if (!text || text.length > MAX_PRETTY) return text;
  const t = text.trimStart();
  if (/json/i.test(contentType) || /^[[{]/.test(t)) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }
  if (/html|xml/i.test(contentType) || t.startsWith('<')) {
    try {
      return prettyMarkup(text);
    } catch {
      return text;
    }
  }
  return text;
}
