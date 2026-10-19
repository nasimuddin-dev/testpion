import type { Any } from './import-helpers.js';

/**
 * Importers for other API clients' exports live in one module each: insomnia-import.ts (v4 JSON, v5 YAML),
 * bruno-import.ts (collection export JSON, .bru, folders) and hoppscotch-import.ts; opencollection-import.ts reads
 * Bruno's newer YAML format. This module re-exports them and tells the formats apart.
 */

export { normalizeTemplate } from './templates.js';
export { importInsomnia, parseInsomnia } from './insomnia-import.js';
export { importBruno, parseBruno } from './bruno-import.js';
export { importHoppscotch, parseHoppscotch } from './hoppscotch-import.js';

export function detectOtherTool(d: unknown): 'insomnia' | 'bruno' | 'hoppscotch' | undefined {
  if (!d || typeof d !== 'object') return undefined;
  const o = d as Any;
  if (o._type === 'export' && Array.isArray(o.resources)) return 'insomnia';
  if (String(o.type ?? '').startsWith('collection.insomnia.rest/')) return 'insomnia';
  if (Array.isArray(o.items) && (o.brunoConfig || o.items.some((i: Any) => /^(http|graphql)-request$|^folder$/.test(i?.type ?? '')))) return 'bruno';
  const hopp = (c: Any) => c && typeof c === 'object' && Array.isArray(c.folders) && Array.isArray(c.requests);
  if (hopp(o) || (Array.isArray(o) && o.length > 0 && o.every(hopp))) return 'hoppscotch';
  return undefined;
}
