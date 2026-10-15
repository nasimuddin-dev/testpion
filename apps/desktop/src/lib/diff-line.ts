/**
 * Where a line of a file is in its unified diff: the row (0-based, in `text.split('\n')`) that shows line `line`
 * (1-based) of the new version — an added or unchanged line, read from the hunk heads (`@@ -a,b +c,d @@`). A line the
 * diff does not show (outside every hunk) gives the head of the nearest hunk before it (else the first one), so a link
 * still lands near it; `exact` says which. Undefined for a diff without hunks.
 */
export function diffRowOfLine(text: string, line: number): { row: number; exact: boolean } | undefined {
  const rows = text.split('\n');
  let near: number | undefined;
  let n = 0; // the new file's line number of the next ' ' / '+' row; 0 outside a hunk
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const head = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(r);
    if (head) {
      n = Number(head[1]);
      if (near === undefined || n <= line) near = i;
      continue;
    }
    if (!n) continue;
    if (r.startsWith('-')) continue;
    if (r.startsWith('+') || r.startsWith(' ')) {
      if (n === line) return { row: i, exact: true };
      n++;
      continue;
    }
    if (!r.startsWith('\\')) n = 0; // "\ No newline at end of file" stays in the hunk; anything else ends it
  }
  return near === undefined ? undefined : { row: near, exact: false };
}
