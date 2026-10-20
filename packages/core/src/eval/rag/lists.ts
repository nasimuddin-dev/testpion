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

import type { RetrievedDoc } from '../../model/types.js';

/**
 * Retrieved contexts written as data: a list of texts or of { id, text, score, source } objects, a JSON array written as
 * text (a CSV cell), or text with one context per line / `;`. Ids default to doc-1, doc-2 ….
 */
export function docsOf(v: unknown): RetrievedDoc[] {
  let items: unknown[] | undefined;
  if (Array.isArray(v)) items = v;
  else if (typeof v === 'string' && v.trim().startsWith('[')) {
    try {
      const j = JSON.parse(v);
      if (Array.isArray(j)) items = j;
    } catch {
      /* not JSON: a list of lines below */
    }
  }
  if (!items) items = (listOf(v) ?? []) as unknown[];
  return items.map((d, i) =>
    typeof d === 'string'
      ? { id: `doc-${i + 1}`, text: d }
      : { id: String((d as Record<string, unknown>).id ?? `doc-${i + 1}`), text: String((d as Record<string, unknown>).text ?? (d as Record<string, unknown>).content ?? ''), score: (d as Record<string, unknown>).score as number | undefined, source: (d as Record<string, unknown>).source as string | undefined },
  );
}
