import type { Tool } from './tool.js';

/**
 * The compact form of a tool for `tools/list` in the `full` profile. A host that loads every listed tool into its context paid
 * 314 KB (about 80,000 tokens) for 200 tools; the complete text of each - when not to use it, an example call, every parameter's
 * full description - is still one call away (`search_tools` with `name`), and the `verbose` profile lists it all.
 *
 * What stays: the name, the first sentences (what it does), one line of when to use it, any warning line (a delete asks for
 * `confirm`), and the whole input schema except that parameter descriptions are cut to their first sentence.
 */
const SHORT_PARAMETER = 32;
const SHORT_WHAT = 185;
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
      out.push(`When: ${firstSentence(l.slice('When to use: '.length).replace(/^Use it (to |when |for |if )?/, (_m, w) => (w === 'to ' ? '' : (w ?? '')).trimStart()), SHORT_WHEN)}`);
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

/**
 * Parameters that dozens of tools share (the contract adds them): their text was repeated per tool (~10 KB of the list). The compact
 * list leaves their description out; the server's instructions say what they mean once, and the verbose profile keeps every text.
 */
const SHARED_PARAMETERS = new Set(['limit', 'cursor', 'response_format', 'max_cost_usd', 'dryRun', 'allowProduction', 'environment', 'collection']);
/** The once-only text for those parameters (appended to the server's instructions in the compact profiles). */
export const SHARED_PARAMETER_NOTE =
  'Parameters many tools share: limit and cursor page a list (the result says nextCursor when there is more); response_format is concise (the default, long values are cut and each cut is named) or detailed; ' +
  'dryRun: true sends or changes nothing and returns what would happen; allowProduction: true lets data-changing requests go to a production environment (only when the user said so); ' +
  'max_cost_usd refuses an AI call that could cost more than that; confirm is the go-ahead of the user for a delete or overwrite (the code they give you, or true where the host takes no code): without it nothing changes and the result says what would; ' +
  'environment and collection are names or ids. A parameter listed without a description means one of these.';

/** A tool as `full` lists it: same name, same arguments, shorter words. */
export function compactTool<T extends Pick<Tool, 'description' | 'inputSchema'>>(t: T): T {
  const schema = shortenSchema(t.inputSchema) as { properties?: Record<string, { description?: unknown }> };
  const props = schema.properties;
  if (props)
    for (const [name, p] of Object.entries(props)) {
      if (!p || typeof p.description !== 'string') continue;
      // (a code-style confirm - "A code from the user, not true" - is a safety instruction: it stays)
      if (SHARED_PARAMETERS.has(name) || (name === 'confirm' && p.description.startsWith('true to go ahead'))) props[name] = Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'description')) as typeof p;
    }
  return { ...t, description: compactDescription(t.description), inputSchema: schema as T['inputSchema'] };
}
