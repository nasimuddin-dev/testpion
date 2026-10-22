import { ApsError } from '../../errors.js';
import type { AuthConfig, Collection, CollectionNode } from '../../model/types.js';
import type { EngineContext } from '../../engine.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { requireCollection } from '../../storage/env-edit.js';
import { fetchOAuth2Token, type OAuth2TokenInfo } from './auth.js';

/** The auth a request is sent with and where it comes from: its own, else the nearest folder's, else the collection's. */
export function effectiveAuth(c: Collection, request?: string): { auth: AuthConfig; from: string } | undefined {
  const own = (a: AuthConfig | undefined): a is AuthConfig => !!a && a.type !== 'inherit';
  let chain: Array<Extract<CollectionNode, { kind: 'folder' }>> = [];
  let found: CollectionNode | undefined;
  const walk = (nodes: CollectionNode[], trail: typeof chain): boolean => {
    for (const n of nodes) {
      if (n.kind === 'folder') {
        if (walk(n.items, [...trail, n])) return true;
      } else if (request && (n.id === request || n.name.toLowerCase() === request.toLowerCase())) {
        chain = trail;
        found = n;
        return true;
      }
    }
    return false;
  };
  if (request && !walk(c.items, []) ) throw new ApsError('ConfigurationError', `No request "${request}" in "${c.name}"`, { suggestions: ['list_requests / `testpion requests` lists them.'] });
  const mine = found && 'request' in found ? (found.request as { auth?: AuthConfig }).auth : undefined;
  if (own(mine)) return { auth: mine, from: `request "${found!.name}"` };
  for (const f of [...chain].reverse()) if (own(f.auth)) return { auth: f.auth, from: `folder "${f.name}"` };
  if (own(c.auth)) return { auth: c.auth, from: `collection "${c.name}"` };
  return undefined;
}

/**
 * "Get token" for a saved request (or a collection): run its OAuth 2.0 grant now and say what came back. The variables of
 * the auth are resolved in the context's environment. The token itself is masked.
 */
export async function oauth2TokenOf(store: WorkspaceStore, ctx: EngineContext, o: { collection: string; request?: string; fresh?: boolean }): Promise<OAuth2TokenInfo & { from: string }> {
  const c = requireCollection(store, o.collection);
  const eff = effectiveAuth(c, o.request);
  if (!eff || eff.auth.type !== 'oauth2') throw new ApsError('ConfigurationError', `${o.request ? `"${o.request}"` : `"${c.name}"`} does not use OAuth 2.0`, { suggestions: [eff ? `It uses ${eff.auth.type} (${eff.from}).` : 'It has no auth.', 'Set the type to OAuth 2.0 in its Authorization tab.'] });
  const info = await fetchOAuth2Token(ctx.vars.resolveDeep(eff.auth), { redactor: ctx.redactor }, { fresh: o.fresh !== false });
  return { ...info, from: eff.from };
}
