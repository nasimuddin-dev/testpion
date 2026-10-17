import type { Collection, SavedGraphQLRequest } from '../model/types.js';
import { SCHEMA_VERSION } from '../model/types.js';
import { shortId, slugify } from '../util/ids.js';
import { schemaFromText } from '../protocols/graphql/graphql.js';
import { buildGraphQLOperation } from '../protocols/graphql/operation-builder.js';

/**
 * A GraphQL schema file (SDL: `type Query { … }`) as a collection with one GraphQL request for its endpoint
 * (`{{graphqlUrl}}`), whose query is built for the first Query field, so it runs without introspection. The SDL
 * itself is kept in the workspace (`specFile`: specs/graphql/<name>.graphql) for the mock server and the schema view.
 */
export function importGraphqlSdl(text: string, fileName?: string): { collection: Collection; specFile: { path: string; text: string }; notes: string[] } {
  const base = String(fileName ?? '')
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(graphqls?|gql|sdl|txt)$/i, '');
  const name = base || 'GraphQL API';
  const notes: string[] = [];
  let query = '';
  let variables: Record<string, unknown> | undefined;
  let operationName: string | undefined;
  let field: string | undefined;
  try {
    const schema = schemaFromText(text);
    field = Object.keys(schema.getQueryType()?.getFields() ?? {})[0];
    if (field) {
      const op = buildGraphQLOperation(schema, `query.${field}`, { depth: 2, includeOptionalArgs: false });
      query = op.query;
      operationName = op.operationName;
      variables = Object.keys(op.variables).length ? op.variables : undefined;
    }
  } catch (e) {
    // a partial schema (extend type …, missing types): the first Query field still makes a skeleton
    field = /\btype\s+Query\b[^{]*\{\s*(?:"""[\s\S]*?"""\s*|"[^"\n]*"\s*|#[^\n]*\n\s*)*([_A-Za-z]\w*)/.exec(text)?.[1];
    if (field) query = `query {\n  ${field}\n}\n`;
    notes.push(`The schema does not build (${(e as Error).message.split('\n')[0]}): the query is a skeleton, add the fields you need`);
  }
  if (!field) {
    query = '# The schema has no Query type: write an operation here\n';
    notes.push('The schema has no Query fields: the request has an empty operation to fill in');
  }
  const slug = slugify(name) || 'schema';
  const specFile = { path: `specs/graphql/${slug}.graphql`, text };
  const request: SavedGraphQLRequest = {
    kind: 'graphql',
    id: shortId('gql-'),
    name: field ? `${name}: ${field}` : name,
    request: { endpoint: '{{graphqlUrl}}', query, ...(variables ? { variables } : {}), ...(operationName ? { operationName } : {}), headers: [] },
  };
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
    items: [request],
    updatedAt: new Date().toISOString(),
  };
  return { collection, specFile, notes };
}
