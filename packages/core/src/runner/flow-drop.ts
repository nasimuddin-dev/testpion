/**
 * Build a flow by drag and drop: what is dropped on the designer's canvas — saved requests, a folder or a whole
 * collection, saved gRPC calls and connections, History entries, Debugger exchanges, another flow file — becomes steps
 * of the flow in one edit (one undo step, whatever the size of the drop):
 *   - a request (HTTP, SOAP, GraphQL), a saved gRPC call or connection, an MCP / LLM History entry: one step, through
 *     the one "Save as test" conversion (testFileOfInput), so a step is what Save as test would write;
 *   - a folder or a collection: its requests in order, each waiting for the one before it;
 *   - HTTP History entries and Debugger exchanges: through flowFromExchanges, so a value that flowed from one response
 *     into a later request becomes an extract and a {{variable}} (as recording a flow does);
 *   - a test file: a sub-flow step (`type: flow`).
 * A dropped request that uses a {{variable}} nothing in the flow sets gets it from an earlier step when that step's
 * latest response has a field of that name: the extract is added to that step, and the new step waits for it.
 */
import { readFileSync, statSync } from 'node:fs';
import type { ItemRef } from '@testpion/shared';
import { ApsError } from '../errors.js';
import { parseYaml } from '../util/lazy-yaml.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { applyFlowEdit, collectionSteps, flowStepsOfText, type FlowEditOp, type FlowFileEdit, type FlowStepInput } from './flow-edit.js';
import { flowFromExchanges, type FlowSourceExchange } from './flow-from-exchanges.js';
import { flowRunResults, flowRuns } from './flow-history.js';
import { testFileOfInput } from './test-from-ref.js';

/** Where a drop lands: after a step (on a condition's branch), into a connection, or alone at a point of the canvas. */
export interface DropTarget {
  after?: string;
  when?: boolean;
  between?: { from: string; to: string };
  at?: [number, number];
}

export interface DropOptions {
  /** The Debugger's exchanges by id (they live in the app's session, not in the workspace). */
  exchanges?(ids: string[]): FlowSourceExchange[];
}

/** The steps a drop makes, before they are placed. */
export interface DropSteps {
  steps: FlowStepInput[];
  /** Each waits for the one before it (false: recorded steps carry their own dependsOn). */
  chain: boolean;
  /** Variables the steps need from the flow's defaults (a recorded origin). */
  vars: Record<string, unknown>;
  notes: string[];
}

const MAX_DROP = 500;

/** A step (or steps) as Save as test writes them: the test file's text read back as test objects. */
function stepsOfRef(store: WorkspaceStore, ref: ItemRef): FlowStepInput[] {
  const f = testFileOfInput(store, { ref });
  const data = parseYaml(f.yaml) as Record<string, unknown> | null;
  if (data && Array.isArray(data.tests)) return data.tests as FlowStepInput[];
  return data ? [data as FlowStepInput] : [];
}

/** A History entry as an exchange (its request as sent, its response as kept), or undefined when it was not HTTP. */
function historyExchange(store: WorkspaceStore, id: string): FlowSourceExchange | undefined {
  const e = store.meta.getHistory(id);
  if (!e || e.kind !== 'http') return undefined;
  const r = (e.request ?? {}) as { method?: string; url?: string; headers?: Array<{ key: string; value: string; enabled?: boolean }>; body?: { type?: string; content?: string } };
  if (!r.url) return undefined;
  let responseBody: string | undefined;
  try {
    // the kept response (bounded: a big download is not read whole to find a token in it)
    if (e.payloadPath && statSync(e.payloadPath).size <= 2 * 1024 * 1024) responseBody = readFileSync(e.payloadPath, 'utf8');
  } catch {
    responseBody = undefined;
  }
  const meta = (e.responseMeta ?? {}) as { headers?: Array<{ key: string; value: string }> | Record<string, string>; contentType?: string };
  const responseHeaders = Array.isArray(meta.headers) ? Object.fromEntries(meta.headers.map((h) => [h.key.toLowerCase(), h.value])) : meta.headers;
  return {
    id: `history:${e.id}`,
    method: (r.method ?? e.method ?? 'GET').toUpperCase(),
    url: r.url,
    startedAt: e.timestamp,
    requestHeaders: Object.fromEntries((r.headers ?? []).filter((h) => h.enabled !== false && h.key).map((h) => [h.key.toLowerCase(), h.value])),
    ...(r.body && r.body.type !== 'none' && r.body.content ? { requestBody: r.body.content } : {}),
    ...(typeof e.status === 'number' ? { status: e.status } : {}),
    ...(responseHeaders ? { responseHeaders } : {}),
    ...(responseBody !== undefined ? { responseBody } : {}),
    ...(meta.contentType ? { contentType: meta.contentType } : {}),
    kind: 'http',
  };
}

/** The steps the dropped items make, in the order they were dropped. */
export function dropSteps(store: WorkspaceStore, refs: ItemRef[], opts: DropOptions = {}): DropSteps {
  if (!refs.length) throw new ApsError('ValidationError', 'Nothing was dropped');
  if (refs.length > MAX_DROP) throw new ApsError('ValidationError', `${refs.length} items: drop at most ${MAX_DROP} at once`);
  const notes: string[] = [];
  // recorded traffic (History entries, Debugger exchanges) goes through flowFromExchanges together: values flow between them
  const recorded: FlowSourceExchange[] = [];
  const others: ItemRef[] = [];
  const exchangeIds = refs.filter((r): r is Extract<ItemRef, { kind: 'exchange' }> => r.kind === 'exchange').map((r) => r.exchangeId);
  const fromDebugger = exchangeIds.length ? (opts.exchanges?.(exchangeIds) ?? []) : [];
  if (exchangeIds.length && fromDebugger.length < exchangeIds.length) notes.push(`${exchangeIds.length - fromDebugger.length} exchange(s) are no longer in the Debugger session`);
  for (const r of refs) {
    if (r.kind === 'exchange') continue;
    const h = r.kind === 'history' ? historyExchange(store, r.historyId) : undefined;
    if (h) recorded.push(h);
    else others.push(r);
  }
  recorded.push(...fromDebugger);
  if (recorded.length && others.length) throw new ApsError('ValidationError', 'Drop recorded traffic (History, Debugger) and saved items separately');
  if (recorded.length) {
    recorded.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    const r = flowFromExchanges(recorded, { keepNoise: true, source: 'a drop on the canvas' });
    const data = parseYaml(r.text) as { tests?: FlowStepInput[]; defaults?: { variables?: Record<string, unknown> } };
    notes.push(...r.links.map((l) => `{{${l.variable}}}: from step ${l.fromIndex} (${l.source}) into step ${l.toIndex} (${l.target})`));
    if (r.secrets.length) notes.push(`Set ${r.secrets.map((s) => `{{${s}}}`).join(', ')} in an environment before running`);
    return { steps: data.tests ?? [], chain: false, vars: data.defaults?.variables ?? {}, notes };
  }
  const steps: FlowStepInput[] = [];
  for (const r of others) {
    if (r.kind === 'test' || r.kind === 'flow') {
      steps.push({ name: r.path.replace(/^.*\//, '').replace(/\.[^.]+$/, ''), type: 'flow', file: r.path });
      continue;
    }
    if (!['request', 'folder', 'collection', 'saved', 'history'].includes(r.kind)) throw new ApsError('ValidationError', `A ${r.kind} can't be dropped into a flow`);
    // a request or a folder: as "From a collection" adds them (ids and tokens of saved examples extracted)
    if (r.kind === 'request' || r.kind === 'folder') steps.push(...collectionSteps(store.getCollection(r.collectionId), [r.kind === 'request' ? r.requestId : r.folderId], MAX_DROP));
    else steps.push(...stepsOfRef(store, r));
  }
  return { steps, chain: true, vars: {}, notes };
}

/* ------------------------------------------------------------------ values an earlier response provides */

/** Where a field of this name is in a JSON value (depth ≤ 3; `fooId` also matches an `id` at the top). */
function findField(value: unknown, name: string): string | undefined {
  const want = name.toLowerCase();
  let found: string | undefined;
  const walk = (v: unknown, path: string, depth: number) => {
    if (found || depth > 3 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) return walk(v[0], `${path}[0]`, depth + 1);
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const p = /^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}['${k}']`;
      if (k.toLowerCase() === want && (typeof x === 'string' || typeof x === 'number')) {
        found = p;
        return;
      }
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, /^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}['${k}']`, depth + 1);
  };
  walk(value, '$', 0);
  if (!found && /id$/i.test(name) && value && typeof value === 'object' && !Array.isArray(value) && ['string', 'number'].includes(typeof (value as Record<string, unknown>).id)) found = '$.id';
  return found;
}

/**
 * For each {{variable}} the new steps read that nothing in the flow sets: an earlier step whose latest response has a
 * field of that name extracts it, and the new step waits for that step. Returns the new text and what was done.
 */
async function inferExtracts(store: WorkspaceStore, file: string, text: string, added: string[]): Promise<{ text: string; notes: string[] }> {
  const notes: string[] = [];
  const steps = flowStepsOfText(text, file);
  const newOnes = steps.filter((s) => added.includes(s.id));
  const provided = new Set(steps.flatMap((s) => s.extract ?? []));
  const defaults = (parseYaml(text) as { defaults?: { vars?: Record<string, unknown>; variables?: Record<string, unknown> } } | null)?.defaults;
  for (const k of [...Object.keys(defaults?.vars ?? {}), ...Object.keys(defaults?.variables ?? {})]) provided.add(k);
  const wanted = [...new Set(newOnes.flatMap((s) => (s.uses ?? []).filter((v) => !provided.has(v) && !v.startsWith('$'))))];
  if (!wanted.length) return { text, notes };
  const runs = await flowRuns(store, file, { limit: 1 }).catch(() => ({ runs: [] }));
  const latest = runs.runs[0];
  if (!latest) return { text, notes };
  const results = (await flowRunResults(store, file, latest.runId)).results;
  let out = text;
  for (const v of wanted) {
    for (const r of results) {
      if (added.includes(r.id) || !r.output) continue;
      let body: unknown;
      try {
        body = JSON.parse(r.output);
      } catch {
        continue;
      }
      const path = findField(body, v);
      if (!path) continue;
      const producer = flowStepsOfText(out, file).find((s) => s.id === r.id);
      if (!producer) continue;
      const raw = (parseYaml(out) as { tests?: Array<Record<string, unknown>> }).tests?.find((t) => (t.id ?? '') === producer.id || t.name === producer.name);
      const extract = { ...((raw?.extract as Record<string, unknown>) ?? {}), [v]: path };
      out = applyFlowEdit(out, { op: 'updateStep', id: producer.id, set: { extract } }, { file }).text;
      for (const s of newOnes.filter((n) => n.uses?.includes(v))) {
        try {
          out = applyFlowEdit(out, { op: 'connect', from: producer.id, to: s.id }, { file }).text;
        } catch {
          // it already waits for it (or that would make a cycle): the extract alone is enough
        }
      }
      notes.push(`{{${v}}} is extracted from ${path} of "${producer.name}"`);
      break;
    }
  }
  return { text: out, notes };
}

/**
 * Drop items (or ready steps: a palette block) into a flow file and save it, as one edit: what the app's canvas (RPC
 * tests.flowEdit with op `drop`) does. Returns the edit (its text before, for Undo) and notes for the toast.
 */
export async function dropIntoFlow(
  store: WorkspaceStore,
  file: string,
  drop: { refs?: ItemRef[]; steps?: FlowStepInput[]; target?: DropTarget },
  opts: DropOptions = {},
): Promise<FlowFileEdit & { notes: string[] }> {
  const rel = file.replace(/\\/g, '/').replace(/^tests\//, '');
  const before = store.readTestFile(rel);
  const made: DropSteps = drop.steps?.length ? { steps: drop.steps, chain: true, vars: {}, notes: [] } : dropSteps(store, drop.refs ?? [], opts);
  if (!made.steps.length) throw new ApsError('ValidationError', 'The dropped items have no requests to add');
  const t = drop.target ?? {};
  const op: FlowEditOp = {
    op: 'insertSteps',
    steps: made.steps,
    chain: made.chain,
    ...(t.after ? { after: t.after } : {}),
    ...(t.when !== undefined ? { when: t.when } : {}),
    ...(t.between ? { between: t.between } : {}),
    ...(t.at ? { at: t.at } : {}),
    ...(Object.keys(made.vars).length ? { vars: made.vars } : {}),
  };
  const r = applyFlowEdit(before, op, { file: rel });
  const added = r.added ?? [];
  const inferred = drop.refs?.length ? await inferExtracts(store, rel, r.text, added) : { text: r.text, notes: [] };
  if (inferred.text !== before) store.writeTestFile(rel, inferred.text);
  return { file: rel, before, text: inferred.text, added, steps: flowStepsOfText(inferred.text, rel), written: inferred.text !== before, notes: [...made.notes, ...inferred.notes] };
}
