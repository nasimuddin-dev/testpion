import { ApsError } from '../errors.js';
import type { Collection, CollectionNode, KeyValue } from '../model/types.js';
import { escapeRegex } from '../util/redact.js';

/**
 * Find and replace across a collection's requests (the collection's Find and replace…, `testpion replace`,
 * `replace_in_collection`): a host that moved, a header renamed, a variable that got a new name in hundreds of
 * imported requests. It looks in URLs, query parameters, headers, bodies, auth fields, scripts and names (each can be
 * left out), shows every change before anything is saved, and changes nothing outside the chosen fields.
 */
export type ReplaceField = 'url' | 'params' | 'headers' | 'body' | 'auth' | 'scripts' | 'name';
export const REPLACE_FIELDS: ReplaceField[] = ['url', 'params', 'headers', 'body', 'auth', 'scripts', 'name'];

export interface ReplaceMatch {
  requestId: string;
  /** Folder path and request name: `Admin / Banners / Get banner`. */
  request: string;
  field: ReplaceField;
  /** Which part of the field: `header X-Api-Key`, `param limit`, `test script` … */
  where: string;
  before: string;
  after: string;
}

export interface ReplaceOptions {
  find: string;
  replace: string;
  regex?: boolean;
  caseSensitive?: boolean;
  /** Where to look (default: everywhere). */
  fields?: ReplaceField[];
  /** Only this folder (and what is in it). */
  folderId?: string;
}

function matcher(o: ReplaceOptions): (s: string) => string {
  if (!o.find) throw new ApsError('ValidationError', 'Give the text to find');
  let re: RegExp;
  try {
    re = new RegExp(o.regex ? o.find : escapeRegex(o.find), o.caseSensitive ? 'g' : 'gi');
  } catch (e) {
    throw new ApsError('ValidationError', `Not a valid regular expression: ${(e as Error).message}`);
  }
  // a plain replacement is taken literally ($ means $); with regex, $1 … refer to the groups
  return (s: string) => (o.regex ? s.replace(re, o.replace) : s.replace(re, () => o.replace));
}

/** The changes a replacement would make, and the collection with them (nothing is saved here). */
export function replaceInCollection(c: Collection, o: ReplaceOptions): { collection: Collection; matches: ReplaceMatch[] } {
  const swap = matcher(o);
  const fields = new Set(o.fields?.length ? o.fields : REPLACE_FIELDS);
  const matches: ReplaceMatch[] = [];
  const visit = (nodes: CollectionNode[], path: string[], inScope: boolean): CollectionNode[] =>
    nodes.map((n) => {
      if (n.kind === 'folder') return { ...n, items: visit(n.items, [...path, n.name], inScope || n.id === o.folderId) };
      if (!inScope || (n.kind !== 'http' && n.kind !== 'graphql')) return n;
      const request = [...path, n.name].join(' / ');
      const change = (field: ReplaceField, where: string, value: string | undefined): string | undefined => {
        if (value === undefined || !fields.has(field)) return value;
        const next = swap(value);
        if (next !== value) matches.push({ requestId: n.id, request, field, where, before: value, after: next });
        return next;
      };
      const kv = (field: ReplaceField, what: string, list?: KeyValue[]) => list?.map((x) => ({ ...x, key: change(field, `${what} name`, x.key)!, value: change(field, `${what} ${x.key}`, x.value)! }));
      const out = { ...n } as typeof n & Record<string, unknown>;
      out.name = change('name', 'name', n.name)!;
      if (n.preRequestScript !== undefined) out.preRequestScript = change('scripts', 'pre-request script', n.preRequestScript);
      if (n.testScript !== undefined) out.testScript = change('scripts', 'test script', n.testScript);
      const r = { ...(n.request as unknown as Record<string, any>) };
      if (n.kind === 'http') {
        r.url = change('url', 'URL', r.url);
        if (r.params) r.params = kv('params', 'param', r.params);
        if (r.pathVariables) r.pathVariables = kv('params', 'path variable', r.pathVariables);
        if (r.headers) r.headers = kv('headers', 'header', r.headers);
        const b = r.body;
        if (b && 'content' in b) r.body = { ...b, content: change('body', 'body', b.content) };
        else if (b && 'fields' in b) r.body = { ...b, fields: kv('body', 'field', b.fields) };
      } else {
        r.endpoint = change('url', 'endpoint', r.endpoint);
        r.query = change('body', 'query', r.query);
        if (typeof r.variables === 'string') r.variables = change('body', 'variables', r.variables);
        if (r.headers) r.headers = kv('headers', 'header', r.headers);
      }
      if (r.auth && typeof r.auth === 'object') {
        const a = { ...r.auth } as Record<string, unknown>;
        for (const [k, v] of Object.entries(a)) if (typeof v === 'string' && k !== 'type') a[k] = change('auth', `auth ${k}`, v);
        r.auth = a;
      }
      out.request = r as never;
      return out as CollectionNode;
    });
  const collection = { ...c, items: visit(c.items, [], !o.folderId) };
  return { collection, matches };
}
