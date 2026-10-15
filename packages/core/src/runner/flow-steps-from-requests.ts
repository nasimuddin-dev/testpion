/**
 * Steps from saved requests (the flow designer's Create from a collection, Paste, `addFromCollection`): a saved REST or
 * GraphQL request as a step (the same conversion as Save as test), with the ids and tokens of its saved examples
 * suggested as extracts. Split from flow-edit.ts, which re-exports these.
 */
import { ApsError } from '../errors.js';
import type { Collection, CollectionNode, SavedExample } from '../model/types.js';
import { slugify } from '../util/ids.js';
import { testObjectFromRequest } from './test-from.js';
import type { FlowStepInput } from './flow-edit.js';

/** The keys that close a step (its checks and scripts): written last, after extract. */
export const TAIL_KEYS = ['assertions', 'checks', 'evaluators', 'preRequestScript', 'testScript'];

const fail = (m: string): never => {
  throw new ApsError('ConfigurationError', m);
};

const ID_FIELD = /^(id|uuid|.*[a-z0-9]Id|.*_id|.*token|.*Token|.*_key|key)$/;

/** Extracts worth suggesting from a saved example's JSON body: ids and tokens at the top or one level down. */
export function suggestedExtracts(examples: SavedExample[] | undefined, stepName: string): Record<string, string> {
  const ex = (examples ?? []).find((e) => e.status < 400 && e.body) ?? (examples ?? [])[0];
  if (!ex?.body) return {};
  let body: unknown;
  try {
    body = JSON.parse(ex.body);
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  const noun = slugify(stepName)
    .split('-')
    .filter((w) => !['get', 'create', 'a', 'an', 'the', 'new', 'add', 'post', 'list', 'one', 'read'].includes(w))[0];
  const visit = (v: unknown, path: string, depth: number) => {
    if (!v || typeof v !== 'object' || Array.isArray(v) || depth > 1) return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const p = /^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}['${k}']`;
      if ((typeof x === 'string' || typeof x === 'number') && ID_FIELD.test(k)) {
        const name = k === 'id' || k === 'uuid' ? `${noun ? noun.replace(/-./g, (m) => m[1]!.toUpperCase()) : 'item'}Id` : k;
        if (!(name in out)) out[name] = p;
      } else visit(x, p, depth + 1);
    }
  };
  visit(body, '$', 0);
  return Object.fromEntries(Object.entries(out).slice(0, 4));
}

type Saved = Exclude<CollectionNode, { kind: 'folder' }>;

/** A saved request as a step (the same conversion as Save as test), with extracts suggested from its saved examples. */
export function stepFromSavedRequest(node: Saved): FlowStepInput {
  const { test } =
    node.kind === 'graphql'
      ? testObjectFromRequest(
          node.name,
          {
            kind: 'graphql',
            endpoint: node.request.endpoint,
            query: node.request.query,
            variables: node.request.variables as Record<string, unknown> | undefined,
            operationName: node.request.operationName,
            headers: node.request.headers,
            auth: node.request.auth,
          },
          node.assertions,
        )
      : testObjectFromRequest(node.name, { kind: 'http', request: node.request, preRequestScript: node.preRequestScript, testScript: node.testScript }, node.assertions);
  const extract = node.kind === 'http' ? suggestedExtracts(node.examples, node.name) : {};
  if (!Object.keys(extract).length) return test;
  // extract: before the checks
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(test)) {
    if (TAIL_KEYS.includes(k) && !('extract' in out)) out.extract = extract;
    out[k] = v;
  }
  if (!('extract' in out)) out.extract = extract;
  return out;
}

/** The requests of a collection to add: the named requests and every request of the named folders, in collection order. */
export function collectionSteps(collection: Collection, refs?: string[], max = 100): FlowStepInput[] {
  const picked: Saved[] = [];
  const all = (nodes: CollectionNode[]): Saved[] => nodes.flatMap((n) => (n.kind === 'folder' ? all(n.items) : [n]));
  if (!refs?.length) picked.push(...all(collection.items));
  else {
    const want = new Set(refs);
    const found = new Set<string>();
    const walk = (nodes: CollectionNode[], inside: boolean) => {
      for (const n of nodes) {
        const hit = want.has(n.id) || want.has(n.name);
        if (hit) found.add(want.has(n.id) ? n.id : n.name);
        if (n.kind === 'folder') walk(n.items, inside || hit);
        else if (inside || hit) picked.push(n);
      }
    };
    walk(collection.items, false);
    const missing = refs.filter((r) => !found.has(r));
    if (missing.length) fail(`Not in "${collection.name}": ${missing.join(', ')}`);
  }
  if (!picked.length) fail(`Nothing to add: no requests in ${refs?.length ? 'what was picked' : `"${collection.name}"`}`);
  if (picked.length > max) fail(`${picked.length} requests: pick a folder of at most ${max}`);
  return picked.map(stepFromSavedRequest);
}
