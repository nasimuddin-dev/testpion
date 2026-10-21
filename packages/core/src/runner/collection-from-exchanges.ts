import { parseYaml } from '../util/lazy-yaml.js';
import type { KeyValue } from '@testpion/shared';
import type { BodyConfig, Collection, CollectionFolder, CollectionNode, SavedHttpRequest } from '../model/types.js';
import { ApsError } from '../errors.js';
import { shortId } from '../util/ids.js';
import { flowFromExchanges, type FlowFromExchangesOptions, type FlowSourceExchange } from './flow-from-exchanges.js';

/** How saved requests are put in folders: one per host, one per first path segment, or none. */
export type CaptureGrouping = 'host' | 'path' | 'none';

interface CollectionFromExchangesOptions extends Omit<FlowFromExchangesOptions, 'name'> {
  /** A folder per host (default), per first path segment, or the requests side by side. */
  group?: CaptureGrouping;
  /** Add to this collection (a top folder named `folder`, or its top level); without it a new collection named `name`. */
  collection?: Collection;
  /** The new collection's name, or the folder the requests go in when adding to one. */
  name?: string;
}

interface CollectionFromExchangesResult {
  /** The collection to save (the given one with the requests added, or a new one). */
  collection: Collection;
  created: boolean;
  /** The saved requests, in the order they were made: id, name, exchange. */
  requests: Array<{ id: string; name: string; exchangeId: string; folder?: string }>;
  /** Secret variables the requests use ({{token}}): set them in an environment (their values are never saved). */
  secrets: string[];
  /** Variables set on the collection: each origin ({{baseUrl}}), with its value. */
  variables: string[];
  dropped: Array<{ id: string; method: string; url: string; reason: string }>;
  notes: string[];
}

const BODY_TYPES = new Set(['none', 'json', 'xml', 'text', 'html', 'form-urlencoded', 'multipart', 'binary']);
const asBody = (b: unknown): BodyConfig | undefined => {
  if (b === undefined || b === null) return undefined;
  const o = b as { type?: unknown; content?: unknown; fields?: unknown };
  if (typeof o === 'object' && typeof o.type === 'string' && BODY_TYPES.has(o.type) && (o.content !== undefined || o.fields !== undefined)) return o as BodyConfig;
  return { type: 'json', content: JSON.stringify(b, null, 2) };
};
/** A JSONPath of the recorder ($.a['b'][0]) as a safe JS access on the response's JSON. */
const jsAccess = (path: string) =>
  `tp.response.json()${path
    .slice(1)
    .replace(/\[/g, '?.[')
    .replace(/\.(?=[A-Za-z_$])/g, '?.')}`;

/**
 * WF-12 The HTTP Debugger's exchanges as saved requests (Save to collection): the same reading as a recorded flow
 * (core flowFromExchanges: noise left out, each origin a {{variable}}, secrets turned into variables that are never
 * saved, values that came from an earlier response extracted and passed on) — but as requests one sends by hand:
 * what a response gives later requests is kept in collection variables by the request's test script.
 */
export function collectionFromExchanges(exchanges: FlowSourceExchange[], o: CollectionFromExchangesOptions = {}): CollectionFromExchangesResult {
  const r = flowFromExchanges(exchanges, { ...o, name: o.name ?? 'Captured requests' });
  const doc = parseYaml(r.text) as { defaults?: { variables?: Record<string, string> }; tests?: Array<Record<string, unknown>> };
  const steps = doc.tests ?? [];
  if (!steps.length) throw new ApsError('ValidationError', 'Nothing to save: no requests were left after the noise was left out');
  const exchangeOf = new Map(r.steps.map((s) => [s.id, s.exchangeId]));
  const urlOf = new Map(exchanges.map((e) => [e.id, e.url]));
  const group = o.group ?? 'host';
  const folderName = (exchangeId: string): string | undefined => {
    if (group === 'none') return undefined;
    try {
      const u = new URL(urlOf.get(exchangeId) ?? '');
      return group === 'host' ? u.host : `/${u.pathname.split('/').filter(Boolean)[0] ?? ''}`;
    } catch {
      return undefined;
    }
  };

  const top: CollectionNode[] = [];
  const folders = new Map<string, CollectionFolder>();
  const requests: CollectionFromExchangesResult['requests'] = [];
  for (const s of steps) {
    const exchangeId = exchangeOf.get(String(s.id)) ?? '';
    const headers: KeyValue[] = Object.entries((s.headers as Record<string, unknown> | undefined) ?? {}).map(([key, value]) => ({ key, value: String(value), enabled: true }));
    // what this response gives later requests: kept in the collection's variables, as a script any send runs
    const lines = [
      ...Object.entries((s.extract as Record<string, string> | undefined) ?? {}).map(([name, path]) => `tp.collectionVariables.set('${name}', ${jsAccess(path)});`),
      ...String(s.testScript ?? '')
        .split('\n')
        .filter(Boolean)
        .map((l) => l.replace(/^tp\.variables\.set\(/, 'tp.collectionVariables.set(')),
    ];
    const body = asBody(s.body);
    const req: SavedHttpRequest = {
      kind: 'http',
      id: shortId('req-'),
      name: String(s.name),
      request: { method: String(s.method), url: String(s.url), headers, ...(body ? { body } : {}) },
      ...(lines.length ? { testScript: `${lines.join('\n')}\n` } : {}),
      ...(Array.isArray(s.assertions) ? { assertions: s.assertions as SavedHttpRequest['assertions'] } : {}),
    };
    const f = folderName(exchangeId);
    if (f) {
      let folder = folders.get(f);
      if (!folder) folders.set(f, (folder = { kind: 'folder', id: shortId('fld-'), name: f, items: [] }));
      folder.items.push(req);
    } else top.push(req);
    requests.push({ id: req.id, name: req.name, exchangeId, ...(f ? { folder: f } : {}) });
  }
  const items = [...folders.values(), ...top];
  const defaults = doc.defaults?.variables ?? {};
  const now = new Date().toISOString();
  let collection: Collection;
  if (o.collection) {
    const c = o.collection;
    // the origins join the collection's variables (a variable it already has keeps its value)
    const vars = [
      ...(c.variables ?? []),
      ...Object.entries(defaults)
        .filter(([k]) => !(c.variables ?? []).some((v) => v.key === k))
        .map(([key, value]) => ({ key, value: String(value), enabled: true })),
    ];
    const added: CollectionNode[] = o.name ? [{ kind: 'folder', id: shortId('fld-'), name: o.name, items }] : items;
    collection = { ...c, variables: vars, items: [...c.items, ...added], updatedAt: now };
  } else
    collection = {
      schemaVersion: '1.0',
      id: shortId('col-'),
      name: o.name?.trim() || `Captured ${now.slice(0, 16).replace('T', ' ')}`,
      version: 0,
      updatedAt: now,
      variables: Object.entries(defaults).map(([key, value]) => ({ key, value: String(value), enabled: true })),
      items,
    } as Collection;
  return { collection, created: !o.collection, requests, secrets: r.secrets, variables: Object.keys(defaults), dropped: r.dropped, notes: r.notes.filter((n) => !/defaults/.test(n)) };
}
