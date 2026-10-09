import type { GraphQLSchema, IntrospectionQuery, GraphQLField, GraphQLInputField, GraphQLNamedType } from 'graphql';
import { nodeRequire } from '../../util/lazy-require.js';

// graphql loads at first use, not at startup (see util/lazy-require.ts)
let graphqlMod: typeof import('graphql') | undefined;
const gql = (): typeof import('graphql') => (graphqlMod ??= typeof require === 'function' ? require('graphql') : nodeRequire('graphql'));
import type { GraphQLRequestSpec, HttpRequestSpec, HttpResponseData } from '../../model/types.js';
import { ApsError } from '../../errors.js';
import { executeHttp, type HttpExecOptions, type PreparedRequest } from '../http/client.js';

export interface GraphQLResult {
  response: HttpResponseData;
  prepared: PreparedRequest;
  data?: unknown;
  errors?: Array<{ message: string; path?: unknown; locations?: unknown; extensions?: unknown }>;
  operationType?: 'query' | 'mutation' | 'subscription';
}

function toHttp(spec: GraphQLRequestSpec, body: unknown): HttpRequestSpec {
  const headers = [...(spec.headers ?? [])];
  if (!headers.some((h) => h.key.toLowerCase() === 'accept' && h.enabled !== false))
    headers.push({ key: 'accept', value: 'application/graphql-response+json, application/json' });
  return {
    method: 'POST',
    url: spec.endpoint,
    headers,
    auth: spec.auth,
    body: { type: 'json', content: JSON.stringify(body) },
    settings: spec.settings,
  };
}

function parseVariables(v: GraphQLRequestSpec['variables']): Record<string, unknown> | undefined {
  if (v == null || v === '') return undefined;
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(v);
  } catch (e) {
    throw new ApsError('ValidationError', 'GraphQL variables are not valid JSON', { cause: e });
  }
}

export function detectOperation(query: string, operationName?: string): { type?: 'query' | 'mutation' | 'subscription'; name?: string; names: string[] } {
  try {
    const doc = gql().parse(query);
    const names = doc.definitions.flatMap((d) => (d.kind === 'OperationDefinition' && d.name ? [d.name.value] : []));
    const op = gql().getOperationAST(doc, operationName);
    return { type: op?.operation, name: op?.name?.value, names };
  } catch {
    return { names: [] };
  }
}

export async function executeGraphQL(spec: GraphQLRequestSpec, opts: HttpExecOptions = {}): Promise<GraphQLResult> {
  const variables = parseVariables(spec.variables);
  const op = detectOperation(spec.query, spec.operationName);
  if (op.type === 'subscription')
    throw new ApsError('ConfigurationError', 'A subscription runs over WebSocket, not as one HTTP request', {
      suggestions: ['In the app, Subscribe in the GraphQL editor; in a test file or a collection run it is subscribed to by itself (events: and wait: set how long).', 'From the terminal: testpion graphql-subscribe <endpoint>.'],
    });
  const body: Record<string, unknown> = { query: spec.query };
  if (variables) body.variables = variables;
  if (spec.operationName) body.operationName = spec.operationName;
  const { response, prepared } = await executeHttp(toHttp(spec, body), opts);
  const json = response.json as { data?: unknown; errors?: GraphQLResult['errors'] } | undefined;
  return { response, prepared, data: json?.data, errors: json?.errors, operationType: op.type };
}

export async function introspect(spec: Omit<GraphQLRequestSpec, 'query'>, opts: HttpExecOptions = {}): Promise<{ schema: GraphQLSchema; sdl: string; introspection: IntrospectionQuery }> {
  const { response } = await executeHttp(
    toHttp({ ...spec, query: '' }, { query: gql().getIntrospectionQuery({ descriptions: true, inputValueDeprecation: true }), operationName: 'IntrospectionQuery' }),
    { ...opts, maxPreviewBytes: 64 * 1024 * 1024 },
  );
  const json = response.json as { data?: IntrospectionQuery; errors?: Array<{ message: string }> } | undefined;
  if (response.status >= 400 || !json?.data) {
    const why = json?.errors?.map((e) => e.message).join('; ') || `HTTP ${response.status}`;
    throw new ApsError('SchemaError', `Schema introspection failed: ${why}`, {
      suggestions: ['Introspection may be disabled on this server — import the schema SDL instead.', 'Check authentication headers.'],
    });
  }
  const schema = gql().buildClientSchema(json.data);
  return { schema, sdl: gql().printSchema(schema), introspection: json.data };
}

/** A schema from a file's text: SDL, or an introspection result (`{ data: { __schema } }` or `{ __schema }`). */
export function schemaFromText(text: string): GraphQLSchema {
  if (/^\s*[{[]/.test(text)) {
    const json = JSON.parse(text) as { data?: IntrospectionQuery } & Partial<IntrospectionQuery>;
    return gql().buildClientSchema((json.data ?? json) as IntrospectionQuery);
  }
  return schemaFromSdl(text);
}

export function schemaFromSdl(sdl: string): GraphQLSchema {
  try {
    return gql().buildSchema(sdl);
  } catch (e) {
    throw new ApsError('SchemaError', `Invalid GraphQL SDL: ${(e as Error).message}`);
  }
}

export function validateQuery(schema: GraphQLSchema | undefined, query: string): Array<{ message: string; line?: number; column?: number }> {
  try {
    const doc = gql().parse(query);
    if (!schema) return [];
    return gql().validate(schema, doc).map((e) => ({ message: e.message, line: e.locations?.[0]?.line, column: e.locations?.[0]?.column }));
  } catch (e) {
    const err = e as { message: string; locations?: Array<{ line: number; column: number }> };
    return [{ message: err.message, line: err.locations?.[0]?.line, column: err.locations?.[0]?.column }];
  }
}

export function formatQuery(query: string): string {
  return gql().print(gql().parse(query));
}

/* ------------------------------------------------------------------ schema explorer model */

export interface SchemaFieldInfo {
  name: string;
  type: string;
  description?: string;
  deprecated?: string;
  args?: Array<{ name: string; type: string; description?: string; defaultValue?: unknown }>;
}

export interface SchemaTypeInfo {
  name: string;
  kind: 'OBJECT' | 'INTERFACE' | 'INPUT_OBJECT' | 'ENUM' | 'UNION' | 'SCALAR';
  description?: string;
  fields?: SchemaFieldInfo[];
  enumValues?: Array<{ name: string; description?: string; deprecated?: string }>;
  possibleTypes?: string[];
  interfaces?: string[];
}

export interface SchemaSummary {
  queryType?: string;
  mutationType?: string;
  subscriptionType?: string;
  types: SchemaTypeInfo[];
  directives: Array<{ name: string; description?: string; locations: string[] }>;
}

export function summarizeSchema(schema: GraphQLSchema): SchemaSummary {
  const field = (f: GraphQLField<unknown, unknown> | GraphQLInputField): SchemaFieldInfo => ({
    name: f.name,
    type: String(f.type),
    description: f.description ?? undefined,
    deprecated: f.deprecationReason ?? undefined,
    args:
      'args' in f
        ? f.args.map((a) => ({ name: a.name, type: String(a.type), description: a.description ?? undefined, defaultValue: a.defaultValue }))
        : undefined,
  });
  const types: SchemaTypeInfo[] = [];
  for (const t of Object.values(schema.getTypeMap()) as GraphQLNamedType[]) {
    if (t.name.startsWith('__')) continue;
    if (gql().isObjectType(t))
      types.push({ name: t.name, kind: 'OBJECT', description: t.description ?? undefined, fields: Object.values(t.getFields()).map(field), interfaces: t.getInterfaces().map((i) => i.name) });
    else if (gql().isInterfaceType(t))
      types.push({ name: t.name, kind: 'INTERFACE', description: t.description ?? undefined, fields: Object.values(t.getFields()).map(field), possibleTypes: schema.getPossibleTypes(t).map((p) => p.name) });
    else if (gql().isInputObjectType(t)) types.push({ name: t.name, kind: 'INPUT_OBJECT', description: t.description ?? undefined, fields: Object.values(t.getFields()).map(field) });
    else if (gql().isEnumType(t))
      types.push({ name: t.name, kind: 'ENUM', description: t.description ?? undefined, enumValues: t.getValues().map((v) => ({ name: v.name, description: v.description ?? undefined, deprecated: v.deprecationReason ?? undefined })) });
    else if (gql().isUnionType(t)) types.push({ name: t.name, kind: 'UNION', description: t.description ?? undefined, possibleTypes: t.getTypes().map((p) => p.name) });
    else if (gql().isScalarType(t)) types.push({ name: t.name, kind: 'SCALAR', description: t.description ?? undefined });
  }
  types.sort((a, b) => a.name.localeCompare(b.name));
  return {
    queryType: schema.getQueryType()?.name,
    mutationType: schema.getMutationType()?.name,
    subscriptionType: schema.getSubscriptionType()?.name,
    types,
    directives: schema.getDirectives().map((d) => ({ name: d.name, description: d.description ?? undefined, locations: [...d.locations] })),
  };
}
