import type { BodyConfig, Collection, CollectionNode, KeyValue } from '../model/types.js';
import { SCHEMA_VERSION } from '../model/types.js';
import { shortId, slugify } from '../util/ids.js';
import { normalizeTemplate } from './templates.js';

/** Small builders the importers of other tools share (one place for what each of them needed). */

export type Any = Record<string, any>;

export const collectionOf = (name: string, items: CollectionNode[], extra: Partial<Collection> = {}): Collection => ({
  schemaVersion: SCHEMA_VERSION,
  id: `${slugify(name) || 'import'}-${shortId().slice(-4)}`,
  name,
  version: 0,
  variables: [],
  items,
  updatedAt: new Date().toISOString(),
  ...extra,
});

/** Nested variable objects become dotted keys: `{ api: { url } }` → `api.url`. */
export function flattenVars(data: unknown, prefix = ''): KeyValue[] {
  if (!data || typeof data !== 'object') return [];
  return Object.entries(data as Any).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v) ? flattenVars(v, `${prefix}${k}.`) : [{ key: `${prefix}${k}`, value: typeof v === 'string' ? normalizeTemplate(v) : JSON.stringify(v), enabled: true }],
  );
}

/** A list of `{ name, value, disabled }` (or the given field names) as key/value rows, templates normalised. */
export const kv = (list: unknown, name = 'name', enabled = (x: Any) => !x.disabled): KeyValue[] =>
  (Array.isArray(list) ? list : []).filter((x: Any) => x && x[name]).map((x: Any) => ({ key: normalizeTemplate(x[name]), value: normalizeTemplate(x.value ?? ''), enabled: enabled(x) }));

/** A request body from a MIME type and its text / form parameters. */
export function bodyFromMime(mime: string, text: string | undefined, params: Any[] | undefined): BodyConfig | undefined {
  const m = (mime ?? '').toLowerCase();
  if (m.includes('x-www-form-urlencoded')) return { type: 'form-urlencoded', fields: kv(params) };
  if (m.includes('multipart/form-data'))
    return { type: 'multipart', fields: (params ?? []).filter((p) => p.name).map((p) => ({ key: p.name, value: p.type === 'file' ? p.fileName ?? '' : normalizeTemplate(p.value ?? ''), kind: p.type === 'file' ? 'file' : 'text', enabled: !p.disabled })) };
  if (text === undefined || text === '') return undefined;
  const content = normalizeTemplate(text);
  return { type: m.includes('json') ? 'json' : m.includes('xml') ? 'xml' : m.includes('html') ? 'html' : 'text', content };
}

/** Another tool's script, kept as comments (its API is not TestPion's `tp.*`). */
export function commented(tool: string, script: unknown): string | undefined {
  const s = String(script ?? '').trim();
  if (!s) return undefined;
  return [`// ${tool} script (not converted: it uses ${tool}'s own script API). Rewrite it with pm.* / tp.* to run it.`, ...s.split('\n').map((l) => `// ${l}`)].join('\n');
}
