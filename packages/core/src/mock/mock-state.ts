/**
 * A stateful mock: what a POST creates, a GET returns, a PUT or PATCH changes and a DELETE removes, for the time the mock
 * server runs. A resource is a path whose GET example answers with a JSON array (`GET /pets` → `[…]`) or whose item path
 * has an example (`GET /pets/:id`); the array seeds the state the first time the resource is touched. Anything else (a
 * `POST /login`, a path with no such example) is answered by the examples as before. Nothing is written to disk.
 */
import type { MockRoute } from './mock-server.js';

type Record_ = Record<string, unknown>;

export interface StatefulAnswer {
  status: number;
  body?: string;
  headers: Record<string, string>;
}

const ID_LIKE = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{8,})$/i;
const ID_FIELDS = ['id', '_id', 'uuid', 'ID', 'Id'];

/** `/v1/pets/7` → the resource `/v1/pets` and the id `7`; `/v1/pets` → the resource alone. */
export function resourceOf(path: string): { resource: string; id?: string } {
  const clean = path.replace(/\/+$/, '') || '/';
  const at = clean.lastIndexOf('/');
  const last = clean.slice(at + 1);
  const head = clean.slice(0, at) || '/';
  if (at > 0 && (ID_LIKE.test(last) || last.startsWith(':'))) return { resource: head, id: last };
  return { resource: clean };
}

const idOf = (r: Record_): string | undefined => {
  for (const f of ID_FIELDS) if (r[f] !== undefined && r[f] !== null && (typeof r[f] === 'string' || typeof r[f] === 'number')) return String(r[f]);
  return undefined;
};
const idField = (r: Record_ | undefined): string => (r ? (ID_FIELDS.find((f) => r[f] !== undefined) ?? 'id') : 'id');

const parseObject = (text: string | undefined): Record_ | undefined => {
  if (!text?.trim()) return undefined;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record_) : undefined;
  } catch {
    return undefined;
  }
};

/** The most records one resource keeps, and the most bytes (as JSON) all resources keep together: past either a write answers 507. */
export const MAX_STATE_RECORDS = 10_000;
export const MAX_STATE_BYTES = 32 * 1024 * 1024;

/** The records of one resource, with what a POST needs without reading them all: sizes, the next number, which ids are not numbers. */
interface Resource {
  records: Map<string, Record_>;
  /** The size of each record as JSON, by id; `bytes` is their sum. */
  sizes: Map<string, number>;
  bytes: number;
  /** The number the next created record gets (one more than the largest numeric id so far). */
  nextNumber: number;
  /** How many records have a key that is not a number, and the keys of those whose id field is not a number: with none, ids stay numbers. */
  textKeys: number;
  textIds: Set<string>;
}

const isNumeric = (key: string) => Number.isFinite(Number(key));

export class MockState {
  private readonly resources = new Map<string, Resource>();
  /** Resources the examples describe: a list example (its body seeds the state) or an item example. */
  private known = new Map<string, { seed?: Record_[]; field: string }>();
  /** What every resource holds together, in bytes of JSON. */
  private bytes = 0;
  private readonly maxRecords: number;
  private readonly maxBytes: number;

  constructor(routes: MockRoute[], limits: { maxRecords?: number; maxBytes?: number } = {}) {
    this.maxRecords = limits.maxRecords ?? MAX_STATE_RECORDS;
    this.maxBytes = limits.maxBytes ?? MAX_STATE_BYTES;
    this.learn(routes);
  }

  /** Read the examples again (the collection changed): resources already in use keep their records. */
  learn(routes: MockRoute[]): void {
    const known = new Map<string, { seed?: Record_[]; field: string }>();
    for (const r of routes) {
      if (r.method !== 'GET') continue;
      const { resource, id } = resourceOf(r.path);
      if (id !== undefined) {
        if (!known.has(resource)) known.set(resource, { field: idField(parseObject(r.example.body)) });
        continue;
      }
      let seed: unknown;
      try {
        seed = JSON.parse(r.example.body);
      } catch {
        continue;
      }
      if (!Array.isArray(seed) || !seed.every((x) => x && typeof x === 'object' && !Array.isArray(x))) continue;
      const items = seed as Record_[];
      const field = idField(items[0]);
      const had = known.get(resource);
      // a 2xx list example seeds; an item example alone names the resource
      if (!had?.seed && r.example.status >= 200 && r.example.status < 300) known.set(resource, { seed: items, field });
      else if (!had) known.set(resource, { field });
    }
    this.known = known;
  }

  /** Whether a path belongs to a resource the mock keeps state for. */
  isStateful(path: string): boolean {
    const { resource } = resourceOf(path);
    return this.known.has(resource) || this.resources.has(resource);
  }

  private records(resource: string): Resource {
    let m = this.resources.get(resource);
    if (!m) {
      m = { records: new Map(), sizes: new Map(), bytes: 0, nextNumber: 1, textKeys: 0, textIds: new Set() };
      const k = this.known.get(resource);
      // the examples' own records are the collection's, not a client's: they seed whatever their size
      for (const item of k?.seed ?? []) {
        const id = idOf(item);
        if (id !== undefined) this.put(m, id, { ...item }, k?.field ?? 'id');
      }
      this.resources.set(resource, m);
    }
    return m;
  }

  /** Take a record out, with its part in the counts. */
  private remove(m: Resource, id: string): void {
    if (!m.records.has(id)) return;
    const size = m.sizes.get(id) ?? 0;
    m.records.delete(id);
    m.sizes.delete(id);
    m.bytes -= size;
    this.bytes -= size;
    if (!isNumeric(id)) m.textKeys--;
    m.textIds.delete(id);
    if (m.records.size === 0) m.nextNumber = 1; // an emptied resource numbers from 1 again
  }

  /** Keep a record (new, or in the place of the one with this id: the list keeps its order), with its part in the counts. */
  private put(m: Resource, id: string, record: Record_, field: string, size = Buffer.byteLength(JSON.stringify(record))): void {
    const isNew = !m.records.has(id);
    const grown = size - (m.sizes.get(id) ?? 0);
    m.records.set(id, record);
    m.sizes.set(id, size);
    m.bytes += grown;
    this.bytes += grown;
    if (isNew) {
      if (!isNumeric(id)) m.textKeys++;
      else if (Number.isSafeInteger(Number(id))) m.nextNumber = Math.max(m.nextNumber, Number(id) + 1);
    }
    if (typeof record[field] !== 'number') m.textIds.add(id);
    else m.textIds.delete(id);
  }

  /** Why a record cannot be kept (the resource is full, or the state is), or undefined; `size` is the record's as JSON. */
  private full(m: Resource, id: string, size: number): string | undefined {
    if (!m.records.has(id) && m.records.size >= this.maxRecords) return `This resource already keeps ${this.maxRecords} records, the most a stateful mock holds for one resource`;
    if (this.bytes - (m.sizes.get(id) ?? 0) + size > this.maxBytes) return `The mock's state is full (${Math.round(this.maxBytes / 1024 / 1024)} MB at most over all resources)`;
    return undefined;
  }

  /** The id of a new record: the next number while every id is a number (a counter, not a search through the records), a text id otherwise. */
  private nextId(resource: string, m: Resource): string {
    if (m.textKeys === 0) return String(m.nextNumber);
    return `${resource.split('/').pop() ?? 'item'}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  /** The answer for a request, or undefined when the examples should answer it. */
  handle(method: string, path: string, body: string | undefined): StatefulAnswer | undefined {
    const { resource, id } = resourceOf(path);
    if (!this.isStateful(path)) return undefined;
    const field = this.known.get(resource)?.field ?? 'id';
    const m = this.records(resource);
    const json = (status: number, v: unknown): StatefulAnswer => ({ status, body: JSON.stringify(v, null, 2), headers: { 'content-type': 'application/json', 'x-mock-state': resource } });
    const notFound = () => json(404, { error: 'not_found', message: `No ${resource.split('/').pop() ?? 'item'} with id ${id}` });
    /** Keep the record, or answer 507 when there is no room for it. */
    const keep = (key: string, record: Record_): StatefulAnswer | undefined => {
      const size = Buffer.byteLength(JSON.stringify(record));
      const why = this.full(m, key, size);
      if (why) return json(507, { error: 'insufficient_storage', message: `${why}. Delete records, or reset the state (send the header x-mock-state-reset: true).` });
      this.put(m, key, record, field, size);
      return undefined;
    };
    const M = method.toUpperCase();
    if (id === undefined) {
      if (M === 'GET' || M === 'HEAD') return json(200, [...m.records.values()]);
      if (M === 'POST') {
        const given = parseObject(body) ?? {};
        const newId = idOf(given) ?? this.nextId(resource, m);
        const record = { ...given, [field]: typeof given[field] === 'number' ? given[field] : isNumeric(newId) && m.textIds.size === 0 ? Number(newId) : newId };
        const refused = keep(newId, record);
        if (refused) return refused;
        return { ...json(201, record), headers: { 'content-type': 'application/json', 'x-mock-state': resource, location: `${resource}/${newId}` } };
      }
      if (M === 'DELETE') {
        this.bytes -= m.bytes;
        this.resources.set(resource, { records: new Map(), sizes: new Map(), bytes: 0, nextNumber: 1, textKeys: 0, textIds: new Set() });
        return { status: 204, headers: { 'x-mock-state': resource } };
      }
      return undefined;
    }
    const existing = m.records.get(id);
    if (M === 'GET' || M === 'HEAD') return existing ? json(200, existing) : notFound();
    if (M === 'PUT') {
      const given = parseObject(body) ?? {};
      const record = { ...given, [field]: existing?.[field] ?? (Number.isFinite(Number(id)) ? Number(id) : id) };
      return keep(id, record) ?? json(existing ? 200 : 201, record);
    }
    if (M === 'PATCH') {
      if (!existing) return notFound();
      const record = { ...existing, ...(parseObject(body) ?? {}), [field]: existing[field] };
      return keep(id, record) ?? json(200, record);
    }
    if (M === 'DELETE') {
      if (!existing) return notFound();
      this.remove(m, id);
      return { status: 204, headers: { 'x-mock-state': resource } };
    }
    return undefined;
  }

  /** Every resource with its records (the Mock tab's view, `mock.state`). */
  snapshot(): Record<string, Record_[]> {
    const out: Record<string, Record_[]> = {};
    for (const [resource, m] of this.resources) out[resource] = [...m.records.values()];
    return out;
  }

  /** Forget what was created and changed: the next request starts from the examples again. */
  reset(): void {
    this.resources.clear();
    this.bytes = 0;
  }
}
