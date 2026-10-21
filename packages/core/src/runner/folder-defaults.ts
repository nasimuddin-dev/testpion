import type { Collection, CollectionFolder, HttpSettings, KeyValue } from '../model/types.js';

/**
 * What a request inherits besides its auth, variables and scripts: the headers and the settings of its collection and
 * folders (Bruno's folder headers, Insomnia 9+ folder headers, Postman's folder `protocolProfileBehavior`). The nearest
 * level wins, and the request's own values win over all of them. Without any, a request comes back unchanged.
 */

/** The headers of a collection and its folders (outermost first): an inner level replaces an outer header of the same name. */
export function inheritedHeaders(collection: Pick<Collection, 'headers'> | undefined, folders: Array<Pick<CollectionFolder, 'headers'>>): KeyValue[] {
  const out = new Map<string, KeyValue>();
  for (const level of [collection?.headers, ...folders.map((f) => f.headers)])
    for (const h of level ?? []) {
      if (!h.key) continue;
      const k = h.key.toLowerCase();
      // a disabled header at an inner level switches an outer one off
      if (h.enabled === false) out.delete(k);
      else out.set(k, h);
    }
  return [...out.values()];
}

/** The settings of a collection and its folders (outermost first), merged: an inner level wins. */
function inheritedSettings(collection: Pick<Collection, 'settings'> | undefined, folders: Array<Pick<CollectionFolder, 'settings'>>): HttpSettings | undefined {
  const merged: HttpSettings = Object.assign({}, collection?.settings, ...folders.map((f) => f.settings));
  return Object.keys(merged).length ? merged : undefined;
}

/** A request's headers plus the inherited ones it does not set itself (an enabled header of the same name wins). */
export function withInheritedHeaders(own: KeyValue[] | undefined, inherited: KeyValue[]): KeyValue[] | undefined {
  if (!inherited.length) return own;
  const set = new Set((own ?? []).filter((h) => h.enabled !== false && h.key).map((h) => h.key.toLowerCase()));
  return [...(own ?? []), ...inherited.filter((h) => !set.has(h.key.toLowerCase()))];
}

/** An HTTP request with the headers and settings of its collection and folders applied. */
export function withFolderDefaults<R extends { headers?: KeyValue[]; settings?: HttpSettings }>(request: R, collection: Collection | undefined, folders: CollectionFolder[]): R {
  const headers = inheritedHeaders(collection, folders);
  const settings = inheritedSettings(collection, folders);
  if (!headers.length && !settings) return request;
  return {
    ...request,
    ...(headers.length ? { headers: withInheritedHeaders(request.headers, headers) } : {}),
    ...(settings ? { settings: { ...settings, ...request.settings } } : {}),
  };
}
