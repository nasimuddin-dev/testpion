/**
 * The context of an AI task from a workspace item (`testpion ai run <task> --item request:<c>:<r>`, MCP `ai_run_task`
 * with `item`): the same data the app's views offer for that item, read from the workspace — a saved request with its
 * latest response, a history entry, a run or one result of it, a test or flow file, an API definition, a collection
 * or folder (its requests). The context builder redacts and fits it; nothing here is sent as it is.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { ItemRef } from '@testpion/shared';
import { toItemRef } from '@testpion/shared';
import { ApsError } from '../errors.js';
import type { Collection, CollectionNode, HistoryEntry, TestResult } from '../model/types.js';
import { historyResponse } from '../storage/history-compare.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { runResults } from '../runner/run-results.js';
import { finishedRun } from '../runner/result-source.js';
import type { StoredResponse } from './verify.js';

interface ItemContext {
  /** A short name of the item ("Orders / Create order"). */
  label: string;
  context: Record<string, unknown>;
  /** The response checks and scripts are verified against. */
  response?: StoredResponse;
  /** The response before it (a saved request's second-latest): checks that pass on one but not the other pin a changing value. */
  previous?: StoredResponse;
  /** The collection, for a flow verified against its mock. */
  collection?: Collection;
}

/** A request body's text, whatever its type (none, json, text, form …). */
const bodyText = (b: unknown): unknown => (b && typeof b === 'object' && 'content' in b ? (b as { content?: unknown }).content : undefined);

const SUPPORTED = 'request, folder, collection, history, run (with or without resultId; run:last is the newest finished run), test, flow, spec';
const MAX_FILE = 512 * 1024;

function findNode(items: CollectionNode[], id: string, path: string[] = []): { node: CollectionNode; path: string[] } | undefined {
  for (const n of items) {
    if (n.id === id) return { node: n, path };
    if (n.kind === 'folder') {
      const r = findNode(n.items, id, [...path, n.name]);
      if (r) return r;
    }
  }
  return undefined;
}

/** Requests of a folder or collection as a list (name, method, url, folder): what a flow can be built from. */
function requestList(items: CollectionNode[], folder: string[] = [], out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  for (const n of items) {
    if (n.kind === 'folder') requestList(n.items, [...folder, n.name], out);
    else if (n.kind === 'http')
      out.push({
        id: n.id,
        name: n.name,
        method: n.request.method,
        url: n.request.url,
        ...(folder.length ? { folder: folder.join(' / ') } : {}),
        ...(bodyText(n.request.body) ? { body: bodyText(n.request.body) } : {}),
        ...(n.examples?.length ? { examples: n.examples.slice(0, 2) } : {}),
      });
    else out.push({ id: n.id, name: n.name, method: 'POST', graphql: true, url: n.request.endpoint, ...(folder.length ? { folder: folder.join(' / ') } : {}) });
  }
  return out;
}

const responseOfHistory = (store: WorkspaceStore, h: HistoryEntry): StoredResponse => {
  const r = historyResponse(store, h);
  return { status: typeof h.status === 'number' ? h.status : undefined, headers: r.headers, body: r.body, latencyMs: h.durationMs };
};

const readText = (file: string) => {
  if (!existsSync(file)) throw new ApsError('ConfigurationError', `${file} does not exist`);
  if (statSync(file).size > MAX_FILE) return readFileSync(file, 'utf8').slice(0, MAX_FILE);
  return readFileSync(file, 'utf8');
};

/** The context of a workspace item for an AI task (see the module comment). */
export async function contextOfItem(store: WorkspaceStore, value: unknown): Promise<ItemContext> {
  const ref = toItemRef(value) as ItemRef | undefined;
  if (!ref)
    throw new ApsError('ValidationError', 'That is not an item reference', {
      suggestions: [`Use kind:id, e.g. request:<collectionId>:<requestId>, run:<runId>, test:smoke/login.yaml. Kinds: ${SUPPORTED}.`],
    });
  switch (ref.kind) {
    case 'request': {
      const c = store.getCollection(ref.collectionId);
      const found = findNode(c.items, ref.requestId);
      if (!found || found.node.kind === 'folder') throw new ApsError('ConfigurationError', `No request "${ref.requestId}" in ${c.name}`);
      const n = found.node;
      const [last, before] = store.meta.listHistory({ requestId: n.id, limit: 2 }).items;
      const response = last ? responseOfHistory(store, last) : undefined;
      return {
        label: [c.name, ...found.path, n.name].join(' / '),
        collection: c,
        response,
        ...(before ? { previous: responseOfHistory(store, before) } : {}),
        context: {
          request: {
            name: n.name,
            ...(n.kind === 'http'
              ? { method: n.request.method, url: n.request.url, headers: n.request.headers, body: bodyText(n.request.body) }
              : { graphql: n.request.query, url: n.request.endpoint }),
            assertions: n.assertions,
            testScript: n.testScript,
          },
          ...(response ? { status: response.status, headers: response.headers?.slice(0, 30), body: response.body, latencyMs: response.latencyMs } : {}),
        },
      };
    }
    case 'collection':
    case 'folder':
    case 'mock': {
      const c = store.getCollection(ref.collectionId);
      const f = ref.kind === 'folder' ? findNode(c.items, ref.folderId) : undefined;
      if (ref.kind === 'folder' && f?.node.kind !== 'folder') throw new ApsError('ConfigurationError', `No folder "${ref.folderId}" in ${c.name}`);
      const items = f?.node.kind === 'folder' ? f.node.items : c.items;
      return {
        label: f ? [c.name, ...f.path, f.node.name].join(' / ') : c.name,
        collection: c,
        context: { collection: c.name, ...(f ? { folder: f.node.name } : {}), variables: c.variables.map((v) => v.key), requests: requestList(items) },
      };
    }
    case 'history': {
      const h = store.meta.getHistory(ref.historyId);
      if (!h) throw new ApsError('ConfigurationError', `No history entry "${ref.historyId}"`);
      const response = responseOfHistory(store, h);
      return {
        label: h.name,
        response,
        context: { request: h.request, method: h.method, url: h.url, status: h.status, headers: response.headers?.slice(0, 30), body: response.body, latencyMs: h.durationMs },
      };
    }
    case 'run': {
      // run:last (and run:last:<resultId>): the newest FINISHED run, by the same rule as `ci --run last`
      if (ref.runId === 'last') return contextOfItem(store, { ...ref, runId: finishedRun(store, 'last').runId });
      const results: TestResult[] = [];
      let total = 0;
      for await (const r of runResults(store, ref.runId)) {
        total++;
        if (ref.resultId ? r.id === ref.resultId : r.status !== 'passed' && results.length < 200) results.push(r);
        if (ref.resultId && results.length) break;
      }
      if (ref.resultId) {
        const r = results[0];
        if (!r) throw new ApsError('ConfigurationError', `No result "${ref.resultId}" in run ${ref.runId}`);
        return {
          label: r.name,
          context: { test: { name: r.name, type: r.type, status: r.status, file: r.file }, checks: r.checks, error: r.error, input: r.input, output: r.output, latencyMs: r.latencyMs },
        };
      }
      const meta = store.meta.listRuns({ limit: 500 }).items.find((x) => x.id === ref.runId);
      if (!meta && !total) throw new ApsError('ConfigurationError', `No run "${ref.runId}" in this workspace`);
      return {
        label: meta?.name ?? ref.runId,
        context: {
          run: meta ? { name: meta.name, total: meta.total, passed: meta.passed, failed: meta.failed, errors: meta.errors, environment: meta.environment } : { total },
          results: results.map((r) => ({ name: r.name, status: r.status, file: r.file, checks: r.checks.filter((c) => !c.passed), error: r.error })),
        },
      };
    }
    case 'test':
    case 'flow': {
      const text = store.readTestFile(ref.path.replace(/^tests[\\/]/, ''));
      return { label: ref.path, context: { file: ref.path, content: text } };
    }
    case 'spec': {
      const text = readText(store.safePath(ref.path));
      return { label: ref.path, context: { file: ref.path, document: text } };
    }
    default:
      throw new ApsError('ValidationError', `An AI task cannot read a ${ref.kind} yet`, { suggestions: [`Kinds it reads: ${SUPPORTED}; or pass the context yourself (--context, MCP context).`] });
  }
}
