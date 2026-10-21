import type { Collection, CollectionFolder, SavedGraphQLRequest } from '../model/types.js';
import { SCHEMA_VERSION } from '../model/types.js';
import { shortId, slugify } from '../util/ids.js';
import { schemaFromText, printSchemaText } from '../protocols/graphql/graphql.js';
import { buildGraphQLOperation } from '../protocols/graphql/operation-builder.js';

/**
 * A GraphQL schema file as a collection: SDL (`type Query { … }`, from `printSchema`, Apollo Rover, a hand-written
 * schema.graphql) or an introspection result (`{ "data": { "__schema": … } }`, what a server answers to the introspection
 * query). Every root field becomes a request for the endpoint (`{{graphqlUrl}}`) with an operation built for it (its arguments
 * as variables, a selection two levels deep), in a folder per operation type (Queries, Mutations, Subscriptions), so it
 * runs without introspection. The schema itself is kept in the workspace (`specFile`: specs/graphql/<name>.graphql, as SDL
 * even when the file was an introspection result) for the mock server and the schema view.
 */

/** At most this many requests per operation type (a big schema has hundreds of fields). */
const GRAPHQL_FIELDS_PER_TYPE = 60;

/** Is this text an introspection result? */
export const isGraphqlIntrospection = (d: unknown): boolean => {
  const o = d as { data?: { __schema?: unknown }; __schema?: unknown } | null;
  return !!o && typeof o === 'object' && (!!o.__schema || !!o.data?.__schema);
};

export function importGraphqlSdl(text: string, fileName?: string): { collection: Collection; specFile: { path: string; text: string }; notes: string[] } {
  const base = String(fileName ?? '')
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(graphqls?|gql|sdl|txt|json)$/i, '');
  const name = base || 'GraphQL API';
  const notes: string[] = [];
  const items: Array<SavedGraphQLRequest | CollectionFolder> = [];
  let sdl = text;
  let firstField: string | undefined;
  const single = (field: string | undefined, query: string, extra: Partial<SavedGraphQLRequest['request']> = {}): SavedGraphQLRequest => ({
    kind: 'graphql',
    id: shortId('gql-'),
    name: field ? `${name}: ${field}` : name,
    request: { endpoint: '{{graphqlUrl}}', query, headers: [], ...extra },
  });
  try {
    const schema = schemaFromText(text);
    // an introspection result is kept as SDL
    if (/^\s*[{[]/.test(text)) sdl = printSchemaText(schema);
    const roots = [
      ['query', 'Queries', schema.getQueryType()],
      ['mutation', 'Mutations', schema.getMutationType()],
      ['subscription', 'Subscriptions', schema.getSubscriptionType()],
    ] as const;
    for (const [op, folderName, type] of roots) {
      if (!type) continue;
      const fields = Object.keys(type.getFields());
      if (fields.length > GRAPHQL_FIELDS_PER_TYPE) notes.push(`${folderName}: the schema has ${fields.length} fields, the first ${GRAPHQL_FIELDS_PER_TYPE} became requests (the schema view builds the others)`);
      const requests: SavedGraphQLRequest[] = [];
      for (const field of fields.slice(0, GRAPHQL_FIELDS_PER_TYPE)) {
        try {
          const built = buildGraphQLOperation(schema, `${op}.${field}`, { depth: 2, includeOptionalArgs: false });
          requests.push({
            kind: 'graphql',
            id: shortId('gql-'),
            name: field,
            request: { endpoint: '{{graphqlUrl}}', query: built.query, ...(Object.keys(built.variables).length ? { variables: built.variables } : {}), operationName: built.operationName, headers: [] },
          });
        } catch (e) {
          notes.push(`${folderName} › ${field}: no operation could be built (${(e as Error).message.split('\n')[0]})`);
        }
      }
      if (requests.length) items.push({ kind: 'folder', id: shortId('fld-'), name: folderName, items: requests });
      if (op === 'query') firstField = fields[0];
    }
    if (!items.length) {
      items.push(single(undefined, '# The schema has no Query type: write an operation here\n'));
      notes.push('The schema has no Query fields: the request has an empty operation to fill in');
    }
  } catch (e) {
    // a partial schema (extend type …, missing types): the first Query field still makes a skeleton
    const field = /\btype\s+Query\b[^{]*\{\s*(?:"""[\s\S]*?"""\s*|"[^"\n]*"\s*|#[^\n]*\n\s*)*([_A-Za-z]\w*)/.exec(text)?.[1];
    notes.push(`The schema does not build (${(e as Error).message.split('\n')[0]}): the query is a skeleton, add the fields you need`);
    if (field) items.push(single(field, `query {\n  ${field}\n}\n`));
    else {
      items.push(single(undefined, '# The schema has no Query type: write an operation here\n'));
      notes.push('The schema has no Query fields: the request has an empty operation to fill in');
    }
    firstField = field;
  }
  void firstField;
  const slug = slugify(name) || 'schema';
  const specFile = { path: `specs/graphql/${slug}.graphql`, text: sdl };
  notes.unshift(
    `GraphQL schema "${name}": set {{graphqlUrl}} to the endpoint (a collection variable); the SDL is kept in specs/graphql/ (testpion mock-graphql --schema <that file> mocks it), and Introspect in the GraphQL view loads the live schema`,
  );
  const collection: Collection = {
    schemaVersion: SCHEMA_VERSION,
    id: `${slug}-${shortId().slice(-4)}`,
    name,
    description: `Imported from the GraphQL schema ${specFile.path}.`,
    version: 0,
    variables: [{ key: 'graphqlUrl', value: '', enabled: true }],
    items,
    updatedAt: new Date().toISOString(),
  };
  return { collection, specFile, notes };
}
