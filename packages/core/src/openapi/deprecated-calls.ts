/**
 * Saved requests that call an operation an API definition in the workspace marks `deprecated: true`: the client is
 * already on its way out before the server says so with a header (storage/deprecations.ts). Needs attention lists them;
 * `what_needs_attention` and `testpion problems` carry them as `kind: "deprecation"`.
 */
import { readFileSync } from 'node:fs';
import { collectionRequests } from '../runner/collection-run.js';
import { mockPathOf } from '../mock/mock-server.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { basePaths, findOperation, loadOpenApi, type OpenApiDoc } from './contract.js';
import { listSpecs, specFileToRead } from './spec-files.js';

export interface DeprecatedOperationCall {
  /** The API definition's path in the workspace (`specs/api.yaml`). */
  spec: string;
  collectionId: string;
  collectionName: string;
  requestId: string;
  requestName: string;
  method: string;
  /** The operation's path template in the document (`/pets/{id}`). */
  path: string;
  operationId?: string;
  summary?: string;
}

/** The operation a saved request's URL maps to: the path after its `{{baseUrl}}`, tried as given and under each server base path. */
function operationOf(doc: OpenApiDoc, method: string, url: string) {
  const path = mockPathOf(url).path;
  const tries = [path, ...basePaths(doc).filter(Boolean).map((base) => `${base}${path}`)];
  for (const p of tries) {
    const op = findOperation(doc, method, `http://base.invalid${p}`);
    if (op) return op;
  }
  return undefined;
}

export function deprecatedOperationCalls(store: WorkspaceStore): DeprecatedOperationCall[] {
  const out: DeprecatedOperationCall[] = [];
  const collections = store.listCollections().filter((c) => !(c as { problem?: string }).problem);
  if (!collections.length) return out;
  // a shared platform API's deprecations reach this workspace's calls too
  for (const spec of listSpecs(store, { includeShared: true }).sort()) {
    let doc: OpenApiDoc;
    try {
      doc = loadOpenApi(readFileSync(specFileToRead(store, spec), 'utf8'));
    } catch {
      continue; // not an OpenAPI document, or unreadable
    }
    const hasDeprecated = Object.values(doc.paths ?? {}).some((item) => item && typeof item === 'object' && Object.values(item as Record<string, unknown>).some((op) => !!op && typeof op === 'object' && (op as { deprecated?: unknown }).deprecated === true));
    if (!hasDeprecated) continue;
    for (const c of collections)
      for (const r of collectionRequests(c)) {
        if (r.node.kind !== 'http') continue;
        const op = operationOf(doc, r.node.request.method, r.node.request.url);
        if (!op || (op.operation as { deprecated?: unknown }).deprecated !== true) continue;
        const o = op.operation as { summary?: unknown };
        out.push({ spec, collectionId: c.id, collectionName: c.name, requestId: r.id, requestName: r.name, method: r.node.request.method.toUpperCase(), path: op.path, ...(op.operationId ? { operationId: op.operationId } : {}), ...(typeof o.summary === 'string' ? { summary: o.summary } : {}) });
      }
  }
  return out;
}
