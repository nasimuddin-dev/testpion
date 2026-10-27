import { folderChain, folderVariables, withFolderDefaults, type HttpRequestSpec } from '@testpion/core';
import type { Backend } from './backend.js';

/**
 * The {{variables}} a request names that have no value: what the window asks about before a POST / PUT / PATCH / DELETE goes out with a hole
 * in its URL or body. The same scopes a send reads (the environment, the collection, its folders, globals); a name a pre-request script of
 * the request, its folders or the collection mentions is left out, since that script may be what sets it.
 */
export function unresolvedVariables(
  be: Backend,
  p: { request: HttpRequestSpec; environment?: string; collectionId?: string; requestId?: string; preRequestScript?: string },
): { unresolved: string[] } {
  const ctx = be.context({ environment: p.environment, collectionId: p.collectionId });
  try {
    const folders = ctx.collection && p.requestId ? folderChain(ctx.collection, p.requestId) : [];
    const fv = folderVariables(folders);
    if (Object.keys(fv).length) ctx.vars.setScope('request', fv);
    ctx.vars.resolveDeep(withFolderDefaults(p.request, ctx.collection, folders));
    const scripts = [ctx.collection?.preRequestScript, ...folders.map((f) => f.preRequestScript), p.preRequestScript].filter((s): s is string => !!s?.trim()).join('\n');
    return { unresolved: [...ctx.vars.unresolved].filter((name) => !scripts.includes(name)) };
  } finally {
    void ctx.dispose();
  }
}
