import { ApsError } from '../errors.js';
import { assertUrlAllowed } from '../net/policy.js';
import type { ImportInput } from './inputs.js';

/**
 * Pulling collections and environments from Postman by link or id with the user's own Postman API key
 * (https://learning.postman.com/docs/developer/postman-api/authentication/). The key is typed by the user (the Import
 * dialog keeps it in the secret store as `postman.apiKey`, the CLI reads `--postman-api-key` or POSTMAN_API_KEY), is sent
 * only to api.getpostman.com in the `X-Api-Key` header, and never appears in a result, a report or an error.
 */

export const POSTMAN_API = 'https://api.getpostman.com';
const MAX_ITEMS = 200;

export interface PostmanRef {
  kind: 'collection' | 'environment' | 'workspace';
  id: string;
}

/**
 * A reference to something in Postman: `postman:collection/<id>`, `postman:environment/<id>`, `postman:workspace/<id>`, an
 * api.getpostman.com URL, or a link copied from the Postman app (`…/collection/<id>`, `…/environment/<id>`, `…/workspace/…/<id>`).
 */
export function parsePostmanRef(input: string): PostmanRef | undefined {
  const s = input.trim();
  const short = /^postman:(collection|environment|workspace)[/:]([\w.-]+)$/i.exec(s);
  if (short) return { kind: short[1]!.toLowerCase() as PostmanRef['kind'], id: short[2]! };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return undefined;
  }
  if (!/^https:$/.test(u.protocol)) return undefined;
  if (u.hostname === 'api.getpostman.com') {
    const m = /^\/(collections|environments|workspaces)\/([\w.-]+)$/.exec(u.pathname);
    return m ? { kind: m[1] === 'collections' ? 'collection' : m[1] === 'environments' ? 'environment' : 'workspace', id: m[2]! } : undefined;
  }
  if (/(^|\.)postman\.(com|co)$/.test(u.hostname)) {
    const m = /\/(collection|environment)\/([\w.-]+)/.exec(u.pathname) ?? /\/workspace\/(?:[\w.-]+\/)?([0-9a-f-]{36})(?:\/|$)/.exec(u.pathname);
    if (m && m.length === 3) return { kind: m[1] as PostmanRef['kind'], id: m[2]! };
    if (m) return { kind: 'workspace', id: m[1]! };
  }
  return undefined;
}

type Fetch = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** The collections and environments a reference names, as import inputs (a workspace has many). */
export async function fetchPostmanInputs(ref: PostmanRef, apiKey: string | undefined, opts: { fetchImpl?: Fetch; signal?: AbortSignal } = {}): Promise<ImportInput[]> {
  if (!apiKey?.trim())
    throw new ApsError('ConfigurationError', 'Importing from Postman by link needs a Postman API key', {
      suggestions: ['Create one in Postman: Settings ▸ Account settings ▸ API keys, then give it to the Import dialog, `--postman-api-key` or POSTMAN_API_KEY. A collection shared as a file imports without one.'],
    });
  const key = apiKey.trim();
  const f: Fetch = opts.fetchImpl ?? ((url, init) => fetch(url, { ...init, redirect: 'error' }) as never);
  const get = async (path: string): Promise<Record<string, any>> => {
    const url = `${POSTMAN_API}${path}`;
    await assertUrlAllowed(url);
    let res;
    try {
      res = await f(url, { headers: { 'X-Api-Key': key, accept: 'application/json' }, signal: opts.signal ?? AbortSignal.timeout(30_000) });
    } catch (e) {
      throw new ApsError('NetworkError', `Couldn't reach the Postman API: ${(e as Error).message.split(key).join('***')}`, { suggestions: ['Check the internet connection and the proxy in Settings ▸ Proxy.'] });
    }
    if (res.status === 401 || res.status === 403) throw new ApsError('AuthenticationError', 'Postman did not accept the API key', { suggestions: ['Check the key (Postman ▸ Settings ▸ API keys); a key can be revoked.'] });
    if (res.status === 404) throw new ApsError('ValidationError', `Postman has no ${path.split('/')[1]!.replace(/s$/, '')} ${path.split('/')[2]} for this key`, { suggestions: ['Use the id or uid of an item in a workspace the key can see (private items need the owner’s key).'] });
    if (res.status === 429) throw new ApsError('NetworkError', 'Postman’s API rate limit was reached', { suggestions: ['Wait a minute and import again.'] });
    if (!res.ok) throw new ApsError('NetworkError', `The Postman API answered HTTP ${res.status}`, { suggestions: [] });
    return (await res.json()) as Record<string, any>;
  };
  const one = async (kind: 'collection' | 'environment', id: string): Promise<ImportInput> => {
    const d = await get(`/${kind}s/${encodeURIComponent(id)}`);
    const body = d[kind];
    if (!body || typeof body !== 'object') throw new ApsError('ValidationError', `The Postman API returned no ${kind}`, { suggestions: [] });
    const name = String(body.info?.name ?? body.name ?? id);
    return { name, text: JSON.stringify(body), source: `postman:${kind}/${id}`, fileCount: 1 };
  };
  if (ref.kind !== 'workspace') return [await one(ref.kind, ref.id)];
  const ws = (await get(`/workspaces/${encodeURIComponent(ref.id)}`)).workspace ?? {};
  const out: ImportInput[] = [];
  const items = [
    ...((ws.collections ?? []) as Array<{ uid?: string; id?: string }>).map((c) => ['collection', c.uid ?? c.id] as const),
    ...((ws.environments ?? []) as Array<{ uid?: string; id?: string }>).map((e) => ['environment', e.uid ?? e.id] as const),
  ].filter((x): x is readonly ['collection' | 'environment', string] => !!x[1]);
  if (items.length > MAX_ITEMS) throw new ApsError('ValidationError', `The workspace has ${items.length} collections and environments (at most ${MAX_ITEMS} at once)`, { suggestions: ['Import them in parts, by their ids.'] });
  for (const [kind, id] of items) out.push(await one(kind, id));
  return out;
}
