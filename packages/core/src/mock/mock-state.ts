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

export class MockState {
  private readonly resources = new Map<string, Map<string, Record_>>();
  /** Resources the examples describe: a list example (its body seeds the state) or an item example. */
  private known = new Map<string, { seed?: Record_[]; field: string }>();

  constructor(routes: MockRoute[]) {
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

  private records(resource: string): Map<string, Record_> {
    let m = this.resources.get(resource);
    if (!m) {
      m = new Map();
      const k = this.known.get(resource);
      for (const item of k?.seed ?? []) {
        const id = idOf(item);
        if (id !== undefined) m.set(id, { ...item });
      }
      this.resources.set(resource, m);
    }
    return m;
  }

  private nextId(resource: string, m: Map<string, Record_>): string {
    const nums = [...m.keys()].map(Number).filter((n) => Number.isFinite(n));
    if (nums.length === m.size && m.size > 0) return String(Math.max(...nums) + 1);
    if (m.size === 0) return '1';
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
    const M = method.toUpperCase();
    if (id === undefined) {
      if (M === 'GET' || M === 'HEAD') return json(200, [...m.values()]);
      if (M === 'POST') {
        const given = parseObject(body) ?? {};
        const newId = idOf(given) ?? this.nextId(resource, m);
        const record = { ...given, [field]: typeof given[field] === 'number' ? given[field] : Number.isFinite(Number(newId)) && (m.size === 0 || [...m.values()].every((r) => typeof r[field] === 'number')) ? Number(newId) : newId };
        m.set(newId, record);
        return { ...json(201, record), headers: { 'content-type': 'application/json', 'x-mock-state': resource, location: `${resource}/${newId}` } };
      }
      if (M === 'DELETE') {
        m.clear();
        return { status: 204, headers: { 'x-mock-state': resource } };
      }
      return undefined;
    }
    const existing = m.get(id);
    if (M === 'GET' || M === 'HEAD') return existing ? json(200, existing) : notFound();
    if (M === 'PUT') {
      const given = parseObject(body) ?? {};
      const record = { ...given, [field]: existing?.[field] ?? (Number.isFinite(Number(id)) ? Number(id) : id) };
      m.set(id, record);
      return json(existing ? 200 : 201, record);
    }
    if (M === 'PATCH') {
      if (!existing) return notFound();
      const record = { ...existing, ...(parseObject(body) ?? {}), [field]: existing[field] };
      m.set(id, record);
      return json(200, record);
    }
    if (M === 'DELETE') {
      if (!existing) return notFound();
      m.delete(id);
      return { status: 204, headers: { 'x-mock-state': resource } };
    }
    return undefined;
  }

  /** Every resource with its records (the Mock tab's view, `mock.state`). */
  snapshot(): Record<string, Record_[]> {
    const out: Record<string, Record_[]> = {};
    for (const [resource, m] of this.resources) out[resource] = [...m.values()];
    return out;
  }

  /** Forget what was created and changed: the next request starts from the examples again. */
  reset(): void {
    this.resources.clear();
  }
}
