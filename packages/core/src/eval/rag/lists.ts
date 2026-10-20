/**
 * A list a dataset record holds in a column: an array, a JSON array written as text, or one item per line / `;` (a CSV
 * cell). Undefined when there is none.
 */
export function listOf(v: unknown): string[] | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  let items: unknown[];
  if (Array.isArray(v)) items = v;
  else if (typeof v === 'string') {
    const t = v.trim();
    if (t.startsWith('[')) {
      try {
        const j = JSON.parse(t);
        items = Array.isArray(j) ? j : [t];
      } catch {
        items = [t];
      }
    } else items = t.includes('\n') ? t.split(/\r?\n/) : t.split(';');
  } else items = [v];
  const out = items.map((x) => (typeof x === 'string' ? x.trim() : x === undefined || x === null ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x))).filter(Boolean);
  return out.length ? out : undefined;
}
