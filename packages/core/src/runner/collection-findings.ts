/** What a review of a collection turns up, as the app, the CLI (`testpion lint`) and the MCP server report it. */
import type { Collection } from '../model/types.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import type { EngineContext } from '../engine.js';
import { certificateLint, securityLint, variableFlow, type SecurityFinding } from '../eval/security.js';
import { listCertificates } from '../storage/certificates.js';

/**
 * Security findings of a collection's request definitions, the certificates of the hosts it calls, and the
 * {{variables}} nothing defines; `ctx` resolves the URLs and knows the variables of its environment.
 */
export function collectionSecurityFindings(store: WorkspaceStore, collection: Collection, ctx: Pick<EngineContext, 'vars'>, redactFields?: string[]): SecurityFinding[] {
  return [...securityLint(collection, redactFields), ...certificateLint(collection, (u) => ctx.vars.resolve(u), listCertificates(store)), ...variableFlow(collection, Object.keys(ctx.vars.toObject()))];
}
