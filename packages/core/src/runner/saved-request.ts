import type { AuthConfig, Collection, HttpRequestSpec } from '../model/types.js';
import { folderChain } from './collection-run.js';
import { withFolderDefaults } from './folder-defaults.js';

/**
 * `tp.execution.runRequest("Get patient")` (Bruno's `bru.runRequest`, Thunder's `tc.runRequest`): a script runs another
 * HTTP request saved in the same collection and gets its response. This finds it, by id, by name or by its path
 * (`Patients / Get patient`), with the auth it inherits and the headers and settings of its collection and folders; the
 * caller resolves the variables and sends it. The request's own scripts and checks do not run (it is a call, not a step).
 */
export function savedRequestSpec(collection: Collection, ref: string): HttpRequestSpec | undefined {
  const found: Array<{ id: string; name: string; path: string; request: HttpRequestSpec }> = [];
  const walk = (nodes: Collection['items'], path: string[]) => {
    for (const n of nodes) {
      if (n.kind === 'folder') walk(n.items, [...path, n.name]);
      else if (n.kind === 'http') found.push({ id: n.id, name: n.name, path: [...path, n.name].join(' / '), request: n.request });
    }
  };
  walk(collection.items, []);
  const want = ref.trim();
  const hit = found.find((f) => f.id === want) ?? found.find((f) => f.path === want) ?? found.find((f) => f.name === want) ?? found.find((f) => f.name.toLowerCase() === want.toLowerCase());
  if (!hit) return undefined;
  const folders = folderChain(collection, hit.id);
  // auth: the request's own, else the nearest folder's, else the collection's
  let auth: AuthConfig | undefined = hit.request.auth && hit.request.auth.type !== 'inherit' ? hit.request.auth : undefined;
  if (!auth) for (const f of [...folders].reverse()) if (f.auth && f.auth.type !== 'inherit') (auth = f.auth), (folders.length = 0);
  const base = auth ?? (collection.auth && collection.auth.type !== 'inherit' ? collection.auth : undefined);
  return withFolderDefaults({ ...hit.request, auth: base ?? { type: 'none' } }, collection, folderChain(collection, hit.id));
}

/** The prefix a saved-request call carries through `tp.sendRequest`'s plumbing. */
export const SAVED_REQUEST_PREFIX = 'tp-saved:';
