import type { Tool } from './tool.js';

/**
 * The compact form of a tool for `tools/list` in the `full` profile. A host that loads every listed tool into its context paid
 * 314 KB (about 80,000 tokens) for 200 tools; the complete text of each - when not to use it, an example call, every parameter's
 * full description - is still one call away (`search_tools` with `name`), and the `verbose` profile lists it all.
 *
 * What stays: the name, the first sentences (what it does), one line of when to use it, any warning line (a delete asks for
 * `confirm`), and the whole input schema except that parameter descriptions are cut to their first sentence.
 */
const SHORT_PARAMETER = 48;
const SHORT_WHAT = 200;
const SHORT_WHEN = 120;

const firstSentence = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  const end = /[.!?](\s|$)/.exec(one);
  const cut = end ? one.slice(0, end.index + 1) : one;
  return cut.length > max ? `${cut.slice(0, max - 1).trimEnd()}…` : cut;
};

/** Whole sentences of `text` while they fit in `max` characters (at least the first, cut if it is longer). */
function sentences(text: string, max: number): string {
  const parts = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/);
  let out = '';
  for (const p of parts) {
    if (out && out.length + p.length + 1 > max) break;
    out = out ? `${out} ${p}` : p;
  }
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}

/** The description without its "When not" and "Example" lines; "When to use:" is said as "When:", cut to a sentence. */
export function compactDescription(description: string): string {
  const lines = description.split('\n').filter((l) => !l.startsWith('When not:') && !l.startsWith('Example:'));
  const out: string[] = [];
  let sawWhen = false;
  for (const l of lines) {
    if (l.startsWith('When to use: ')) {
      sawWhen = true;
      out.push(`When: ${firstSentence(l.slice('When to use: '.length), SHORT_WHEN)}`);
    } else if (!sawWhen && !out.length) out.push(sentences(l, SHORT_WHAT)); // the first paragraph says what it does; the rest is in the complete entry
    else if (sawWhen && l.trim()) out.push(l); // a warning after the example (a delete needs confirm)
  }
  return out.join('\n');
}

function shortenSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(shortenSchema);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === 'description' && typeof v === 'string') out[k] = firstSentence(v, SHORT_PARAMETER);
    else if (k === 'properties' && v && typeof v === 'object') out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([name, p]) => [name, shortenSchema(p)]));
    else if (k === 'items' || k === 'additionalProperties') out[k] = shortenSchema(v);
    else out[k] = v;
  }
  return out;
}

/** A tool as `full` lists it: same name, same arguments, shorter words. */
export function compactTool<T extends Pick<Tool, 'description' | 'inputSchema'>>(t: T): T {
  return { ...t, description: compactDescription(t.description), inputSchema: shortenSchema(t.inputSchema) as T['inputSchema'] };
}
