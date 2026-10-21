import { withEngine } from './server-kit.js';
import { introspect } from '../../protocols/graphql/graphql.js';
import { buildGraphQLOperation } from '../../protocols/graphql/operation-builder.js';
import { collectSubscriptionEvents } from '../../protocols/graphql/subscription.js';
import { str } from '../tool.js';
import type { Tool } from '../tool.js';
import type { ModuleToolDeps } from './deps.js';

/** GraphQL operations and subscriptions. */
export function graphqlTools(d: ModuleToolDeps): Tool[] {
  const { store, secrets, settings, checkEnvironment } = d;
  return [
    {
      name: 'graphql_operation',
      // it sends an introspection request to the endpoint
      write: true,
      description:
        'Build a valid, ready-to-run GraphQL operation for one root field by introspecting the endpoint: a variable for each argument (with a placeholder value of the right type) and a selection of the scalar fields down to `depth` levels. Use it instead of guessing field names; then send it with send_request or save it. {{variables}} of the environment are resolved in the endpoint and headers.',
      inputSchema: {
        type: 'object',
        properties: {
          endpoint: str('GraphQL endpoint (http or https)'),
          field: str('Root field: "Query.patient", "Mutation.addPet" or just "patient"'),
          depth: { type: 'number', description: 'Levels of nested objects to select (default 2, max 6)' },
          requiredArgsOnly: { type: 'boolean', description: 'Only the required arguments (default: all)' },
          headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Headers for introspection, e.g. Authorization: Bearer {{token}}' },
          environment: str('Environment name'),
        },
        required: ['endpoint', 'field'],
      },
      run: async (a) => {
        return withEngine({ store, secrets, settings }, { environment: checkEnvironment(a.environment) }, async (ctx) => {
          const headers = ctx.vars.resolveDeep(Object.entries((a.headers as Record<string, string>) ?? {}).map(([key, value]) => ({ key, value })));
          const { schema } = await introspect({ endpoint: ctx.vars.resolve(String(a.endpoint)), headers }, { cookieJar: ctx.services.cookieJar });
          return buildGraphQLOperation(schema, String(a.field), { depth: a.depth === undefined ? undefined : Number(a.depth), includeOptionalArgs: a.requiredArgsOnly !== true });
        });
      },
    },
    {
      name: 'graphql_subscribe',
      write: true,
      description: 'Run a GraphQL subscription over WebSocket (graphql-transport-ws or graphql-ws) and return the events received: up to maxEvents (default 10) or durationSec (default 15, at most 60), whichever comes first. {{variables}} of the environment are resolved.',
      inputSchema: {
        type: 'object',
        properties: {
          endpoint: str('GraphQL endpoint (http(s) or ws(s))'),
          query: str('The subscription document'),
          variables: { type: 'object', description: 'Variables' },
          environment: str('Environment name'),
          maxEvents: { type: 'number' },
          durationSec: { type: 'number' },
        },
        required: ['endpoint', 'query'],
      },
      run: async (a) => {
        return withEngine({ store, secrets, settings }, { environment: checkEnvironment(a.environment) }, async (ctx) => {
          const r = await collectSubscriptionEvents({
            url: ctx.vars.resolve(String(a.endpoint)),
            query: String(a.query),
            variables: a.variables && typeof a.variables === 'object' ? ctx.vars.resolveDeep(a.variables as Record<string, unknown>) : undefined,
            maxEvents: Math.min(100, Number(a.maxEvents) || 10),
            durationMs: Math.min(60, Number(a.durationSec) || 15) * 1000,
            cookieJar: ctx.services.cookieJar,
          });
          return ctx.redactor.redact(r);
        });
      },
    },
  ];
}
