/** "node server.js --flag" ⇄ command + arguments (quotes keep spaces). */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | undefined;
  let has = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}
export function joinCommandLine(parts: string[]): string {
  return parts.map((p) => (p === '' || /[\s"']/.test(p) ? `"${p.replace(/"/g, "'")}"` : p)).join(' ');
}
