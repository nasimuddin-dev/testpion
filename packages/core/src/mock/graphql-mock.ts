import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GraphQLFieldResolver, GraphQLOutputType, GraphQLSchema, GraphQLTypeResolver } from 'graphql';
import { nodeRequire } from '../util/lazy-require.js';

// graphql loads at first use, not at startup (see util/lazy-require.ts)
let graphqlMod: typeof import('graphql') | undefined;
const gql = (): typeof import('graphql') => (graphqlMod ??= typeof require === 'function' ? require('graphql') : nodeRequire('graphql'));
import { ApsError } from '../errors.js';

/**
 * GraphQL mock: answers any valid query against a schema with fake, correctly typed data, so a
 * front end (or a test) can work before the real API exists. Values are deterministic (the same
 * query gives the same data) and look plausible for the field name (email, name, url, date …).
 * `overrides` fixes values per type, e.g. `{ "Patient": { "name": "Rex", "species": "DOG" } }`.
 */
export interface GraphQLMockOptions {
  /** Items in every list (default 2). */
  listLength?: number;
  /** Values per type name (and field): `{ Patient: { name: 'Rex' } }`. */
  overrides?: Record<string, Record<string, unknown>>;
}

/** Small deterministic hash of a string (FNV-1a). */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

const FIRST = ['Ann', 'Ben', 'Cleo', 'Dev', 'Eli', 'Fay', 'Gus', 'Hana'];
const LAST = ['Rivera', 'Okafor', 'Kim', 'Novak', 'Haddad', 'Silva', 'Meyer', 'Tanaka'];
const WORDS = ['alpha', 'bravo', 'coral', 'delta', 'ember', 'fjord', 'grove', 'harbor'];

function fakeScalar(typeName: string, field: string, n: number): unknown {
  const f = field.toLowerCase();
  switch (typeName) {
    case 'ID':
      return `${field.replace(/id$/i, '') || 'id'}-${(n % 9000) + 1000}`.replace(/^-/, '');
    case 'Int':
      if (/count|total|size|length|quantity/.test(f)) return (n % 50) + 1;
      if (/age/.test(f)) return (n % 15) + 1;
      if (/year/.test(f)) return 2020 + (n % 7);
      return n % 100;
    case 'Float':
      if (/price|amount|cost|total/.test(f)) return Math.round((n % 10000) + 99) / 100;
      if (/lat/.test(f)) return 40 + (n % 1000) / 1000;
      if (/lon|lng/.test(f)) return -73 - (n % 1000) / 1000;
      return Math.round(n % 10000) / 100;
    case 'Boolean':
      return n % 2 === 0;
    case 'String':
      if (/e-?mail/.test(f)) return `${FIRST[n % FIRST.length]!.toLowerCase()}@example.com`;
      if (/^(first_?name|given_?name)$/.test(f)) return FIRST[n % FIRST.length];
      if (/^(last_?name|family_?name|surname)$/.test(f)) return LAST[n % LAST.length];
      if (/name|title|label/.test(f)) return `${FIRST[n % FIRST.length]} ${LAST[(n >>> 3) % LAST.length]}`;
      if (/url|link|href|website|avatar|image/.test(f)) return `https://example.com/${WORDS[n % WORDS.length]}`;
      if (/phone/.test(f)) return `+1-555-${String(n % 10000).padStart(4, '0')}`;
      if (/date|time|at$|_at$/.test(f)) return new Date(Date.UTC(2026, n % 12, (n % 28) + 1, 9, 30)).toISOString();
      if (/status|state/.test(f)) return ['active', 'pending', 'closed'][n % 3];
      if (/description|body|text|summary|note|comment/.test(f)) return `A sample ${field} (${WORDS[n % WORDS.length]}).`;
      if (/color|colour/.test(f)) return ['#2f7bff', '#8b5cff', '#05893e'][n % 3];
      return `${field} ${WORDS[n % WORDS.length]}`;
    default:
      return `${typeName} ${n % 100}`; // custom scalars (DateTime, JSON …)
  }
}

export interface GraphQLMockResult {
  data?: unknown;
  errors?: Array<{ message: string; locations?: unknown; path?: unknown }>;
}

/** Build an executor that answers queries against `schema` with fake data. */
export function createGraphQLMock(schema: GraphQLSchema, opts: GraphQLMockOptions = {}) {
  const listLength = Math.max(0, Math.min(opts.listLength ?? 2, 50));
  const overrides = opts.overrides ?? {};

  const valueFor = (type: GraphQLOutputType, field: string, path: string): unknown => {
    const t = gql().getNullableType(type);
    if (gql().isListType(t)) return Array.from({ length: listLength }, (_, i) => valueFor(t.ofType, field, `${path}.${i}`));
    const named = gql().getNamedType(t);
    const n = hash(path);
    if (gql().isScalarType(named)) return fakeScalar(named.name, field, n);
    if (gql().isEnumType(named)) {
      const vals = named.getValues();
      return vals.length ? vals[n % vals.length]!.value : null;
    }
    if (gql().isAbstractType(named)) {
      const possible = schema.getPossibleTypes(named);
      const pick = possible[n % Math.max(possible.length, 1)];
      return pick ? { __typename: pick.name, __path: path, ...(overrides[pick.name] ?? {}) } : null;
    }
    if (gql().isObjectType(named)) return { __path: path, ...(overrides[named.name] ?? {}) };
    return null;
  };

  const fieldResolver: GraphQLFieldResolver<unknown, unknown> = (source, _args, _ctx, info) => {
    const src = (source ?? {}) as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(src, info.fieldName) && info.fieldName !== '__path') {
      const v = src[info.fieldName];
      // an override for an object field: keep it, filling missing fields with fake values
      return typeof v === 'object' && v !== null && !Array.isArray(v) && gql().isObjectType(gql().getNamedType(info.returnType)) ? { __path: `${src.__path ?? info.parentType.name}.${info.fieldName}`, ...v } : v;
    }
    const base = (src.__path as string | undefined) ?? info.parentType.name;
    const path = `${base}.${info.fieldName}`;
    const own = overrides[info.parentType.name]?.[info.fieldName];
    if (own !== undefined) return own;
    return valueFor(info.returnType, info.fieldName, path);
  };
  const typeResolver: GraphQLTypeResolver<unknown, unknown> = (value, _ctx, _info, abstractType) => {
    const v = value as { __typename?: string };
    return v?.__typename ?? schema.getPossibleTypes(abstractType)[0]?.name;
  };

  return {
    schema,
    /** Answer one GraphQL request (validation errors come back like a real server's). */
    run(query: string, variables?: Record<string, unknown>, operationName?: string): GraphQLMockResult {
      let document;
      try {
        document = gql().parse(query);
      } catch (e) {
        return { errors: [{ message: (e as Error).message }] };
      }
      const errors = gql().validate(schema, document);
      if (errors.length) return { errors: errors.map((e) => ({ message: e.message, locations: e.locations })) };
      const r = gql().execute({ schema, document, variableValues: variables, operationName, rootValue: {}, fieldResolver, typeResolver });
      if (r instanceof Promise) throw new ApsError('ConfigurationError', 'Unexpected async resolver in the GraphQL mock');
      return { data: r.data ?? null, ...(r.errors?.length ? { errors: r.errors.map((e) => ({ message: e.message, path: e.path })) } : {}) };
    },
  };
}

export interface GraphQLMockServer {
  url: string;
  port: number;
  close(): Promise<void>;
  /** Replace the schema or overrides of a running mock. */
  update(schema: GraphQLSchema, opts?: GraphQLMockOptions): void;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** Serve a GraphQL mock on localhost: POST (or GET with ?query=) at any path, e.g. /graphql. */
export async function startGraphQLMockServer(schema: GraphQLSchema, opts: GraphQLMockOptions & { port?: number; host?: string; delayMs?: number } = {}): Promise<GraphQLMockServer> {
  const host = opts.host ?? '127.0.0.1';
  if (!LOCAL_HOSTS.has(host)) throw new ApsError('ConfigurationError', `The GraphQL mock only listens on localhost, not ${host}`);
  let mock = createGraphQLMock(schema, opts);
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { ...cors, 'content-type': 'application/json', 'x-mock': 'graphql' });
    res.end(JSON.stringify(body));
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }
    const u = new URL(req.url ?? '/', 'http://mock');
    let payload: { query?: string; variables?: Record<string, unknown>; operationName?: string } = {};
    if (req.method === 'GET') payload = { query: u.searchParams.get('query') ?? undefined, operationName: u.searchParams.get('operationName') ?? undefined, variables: u.searchParams.get('variables') ? JSON.parse(u.searchParams.get('variables')!) : undefined };
    else {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > 1024 * 1024) return send(res, 413, { errors: [{ message: 'Request body too large' }] });
        chunks.push(c as Buffer);
      }
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return send(res, 400, { errors: [{ message: 'The body must be JSON: { "query": "…", "variables": { … } }' }] });
      }
    }
    if (!payload.query) return send(res, 400, { errors: [{ message: 'Missing "query"' }] });
    if (opts.delayMs) await new Promise((ok) => setTimeout(ok, opts.delayMs));
    const r = mock.run(payload.query, payload.variables, payload.operationName);
    send(res, r.data === undefined && r.errors ? 400 : 200, r);
  };
  const server = createServer((req, res) => {
    handle(req, res).catch((e) => send(res, 500, { errors: [{ message: (e as Error).message }] }));
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(opts.port ?? 0, host, () => ok());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${host === '::1' ? '[::1]' : host}:${port}/graphql`,
    port,
    close: () => new Promise((ok) => server.close(() => ok())),
    update: (s, o) => (mock = createGraphQLMock(s, { ...opts, ...o })),
  };
}
