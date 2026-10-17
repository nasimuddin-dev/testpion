/**
 * A unified diff of two texts (`--- a`, `+++ b`, `@@ -a,b +c,d @@` hunks with 3 lines of context), for showing a
 * proposed change the way git shows one (the window's DiffText, the CLI). Lines are compared after the common start
 * and end are cut off; the middle is an LCS diff, bounded: texts too different to diff cheaply show as one replacement.
 */

type Op = { t: ' ' | '-' | '+'; s: string };

const MAX_CELLS = 4_000_000;

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map((s) => ({ t: '+', s }));
  if (!m) return a.map((s) => ({ t: '-', s }));
  if (n * m > MAX_CELLS) return [...a.map((s) => ({ t: '-' as const, s })), ...b.map((s) => ({ t: '+' as const, s }))];
  // lengths of the LCS of a[i..] and b[j..], row by row (Uint32: up to 4M cells)
  const w = m + 1;
  const L = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * w + j] = a[i] === b[j] ? L[(i + 1) * w + j + 1]! + 1 : Math.max(L[(i + 1) * w + j]!, L[i * w + j + 1]!);
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: ' ', s: a[i]! });
      i++;
      j++;
    } else if (L[(i + 1) * w + j]! >= L[i * w + j + 1]!) out.push({ t: '-', s: a[i++]! });
    else out.push({ t: '+', s: b[j++]! });
  }
  while (i < n) out.push({ t: '-', s: a[i++]! });
  while (j < m) out.push({ t: '+', s: b[j++]! });
  return out;
}

/** The unified diff of `before` → `after` ('' when they are equal). A missing `before` (null) is a new file. */
export function unifiedDiff(before: string | null | undefined, after: string, name = 'file', context = 3): string {
  const a = before == null || before === '' ? [] : before.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const b = after === '' ? [] : after.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ops: Op[] = [
    ...a.slice(0, pre).map((s) => ({ t: ' ' as const, s })),
    ...lcsOps(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf)),
    ...a.slice(a.length - suf).map((s) => ({ t: ' ' as const, s })),
  ];
  if (!ops.some((o) => o.t !== ' ')) return '';
  const lines = [`--- ${before == null ? '/dev/null' : `a/${name}`}`, `+++ b/${name}`];
  // hunks: runs of changes with `context` lines around them, merged when they touch
  let k = 0;
  let aLine = 1;
  let bLine = 1;
  const pos: Array<{ a: number; b: number }> = ops.map((o) => {
    const p = { a: aLine, b: bLine };
    if (o.t !== '+') aLine++;
    if (o.t !== '-') bLine++;
    return p;
  });
  while (k < ops.length) {
    while (k < ops.length && ops[k]!.t === ' ') k++;
    if (k >= ops.length) break;
    const start = Math.max(0, k - context);
    let end = k;
    let quiet = 0;
    while (end < ops.length && quiet <= context * 2) {
      quiet = ops[end]!.t === ' ' ? quiet + 1 : 0;
      end++;
    }
    end = Math.min(ops.length, end - Math.max(0, quiet - context));
    const hunk = ops.slice(start, end);
    const aCount = hunk.filter((o) => o.t !== '+').length;
    const bCount = hunk.filter((o) => o.t !== '-').length;
    const aStart = aCount ? pos[start]!.a : pos[start]!.a - 1;
    const bStart = bCount ? pos[start]!.b : pos[start]!.b - 1;
    lines.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const o of hunk) lines.push(`${o.t}${o.s}`);
    k = end;
  }
  return lines.join('\n');
}
