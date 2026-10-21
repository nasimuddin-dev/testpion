import type { Collection, CollectionNode, KeyValue, SavedExample, SavedHttpRequest } from '../model/types.js';
import { ApsError } from '../errors.js';
import { shortId } from '../util/ids.js';
import type { Redactor } from '../util/redact.js';

/** Bodies larger than this are not saved as examples (workspace files stay small and diffable). */
const MAX_EXAMPLE_BODY = 512 * 1024;

/** Headers that describe one particular transfer and make no sense in a saved example. */
const TRANSIENT_HEADERS = /^(date|connection|keep-alive|transfer-encoding|content-length|content-encoding)$/i;

interface ResponseLike {
  status: number;
  statusText?: string;
  headers: Array<[string, string]>;
  bodyPreview: string;
  truncated?: boolean;
  json?: unknown;
}

/**
 * Turn a live response into an example that is safe to keep in a workspace file: sensitive headers
 * (Set-Cookie, Authorization, tokens …) and sensitive JSON fields are masked, as are known secret values.
 */
export function exampleFromResponse(res: ResponseLike, opts: { name: string; redactor?: Redactor; request?: SavedExample['request'] }): SavedExample {
  if (res.truncated) throw new ApsError('ValidationError', 'The response body was truncated, so it cannot be saved as an example', { suggestions: ['Save the response to a file instead.'] });
  if (res.bodyPreview.length > MAX_EXAMPLE_BODY) throw new ApsError('ValidationError', `The response body is larger than ${MAX_EXAMPLE_BODY / 1024} KB, too large for an example`);
  const r = opts.redactor;
  const headers: KeyValue[] = res.headers.filter(([k]) => !TRANSIENT_HEADERS.test(k)).map(([key, value]) => ({ key, value: r?.isSensitiveKey(key) ? 'REDACTED' : r ? r.redactString(value) : value }));
  let body = res.bodyPreview;
  if (r) {
    if (res.json !== undefined) {
      const masked = r.redact(res.json);
      if (JSON.stringify(masked) !== JSON.stringify(res.json)) body = JSON.stringify(masked, null, 2);
    }
    body = r.redactString(body);
  }
  const request = opts.request && r ? { ...opts.request, url: r.redactUrl(opts.request.url), headers: opts.request.headers && r.redact(opts.request.headers), body: opts.request.body && r.redactString(opts.request.body) } : opts.request;
  return { id: shortId('ex-'), name: opts.name.trim() || `${res.status} ${res.statusText ?? ''}`.trim(), status: res.status, statusText: res.statusText, headers, body, request, createdAt: new Date().toISOString() };
}

/** Find a saved HTTP request anywhere in a collection. */
export function findHttpRequest(items: CollectionNode[], id: string): SavedHttpRequest | undefined {
  for (const n of items) {
    if (n.kind === 'folder') {
      const r = findHttpRequest(n.items, id);
      if (r) return r;
    } else if (n.kind === 'http' && n.id === id) return n;
  }
  return undefined;
}

/** Return a copy of the collection with one request's examples changed. */
export function withRequestExamples(collection: Collection, requestId: string, change: (examples: SavedExample[]) => SavedExample[]): Collection {
  let found = false;
  const map = (nodes: CollectionNode[]): CollectionNode[] =>
    nodes.map((n) => {
      if (n.kind === 'folder') return { ...n, items: map(n.items) };
      if (n.kind === 'http' && n.id === requestId) {
        found = true;
        const examples = change([...(n.examples ?? [])]);
        const { examples: _old, ...rest } = n;
        return examples.length ? { ...rest, examples } : rest;
      }
      return n;
    });
  const items = map(collection.items);
  if (!found) throw new ApsError('ConfigurationError', 'The request is not saved in this collection', { suggestions: ['Save the request to a collection first.'] });
  return { ...collection, items };
}
