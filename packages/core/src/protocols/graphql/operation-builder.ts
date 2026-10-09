import type { GraphQLField, GraphQLInputType, GraphQLOutputType, GraphQLSchema } from 'graphql';
import { nodeRequire } from '../../util/lazy-require.js';

// graphql loads at first use, not at startup (see util/lazy-require.ts)
let graphqlMod: typeof import('graphql') | undefined;
const gql = (): typeof import('graphql') => (graphqlMod ??= typeof require === 'function' ? require('graphql') : nodeRequire('graphql'));
import { ApsError } from '../../errors.js';
import { formatQuery } from './graphql.js';

/**
 * Build a ready-to-run operation for one root field (e.g. Query.patient): a variable for each
 * argument (with a placeholder value of the right type), and a selection of the scalar fields down
 * to `depth` levels of objects. What Postman's and Insomnia's query builders make by clicking.
 */
export interface BuiltOperation {
  operation: 'query' | 'mutation' | 'subscription';
  operationName: string;
  query: string;
  variables: Record<string, unknown>;
}

export function buildGraphQLOperation(schema: GraphQLSchema, field: string, opts: { operation?: 'query' | 'mutation' | 'subscription'; depth?: number; includeOptionalArgs?: boolean } = {}): BuiltOperation {
  // "Query.patient", "mutation.addPet" or just "patient" (query first, then mutation, then subscription)
  const [typePart, fieldPart] = field.includes('.') ? (field.split('.', 2) as [string, string]) : [undefined, field];
  const roots = (
    [
      ['query', schema.getQueryType()],
      ['mutation', schema.getMutationType()],
      ['subscription', schema.getSubscriptionType()],
    ] as const
  ).filter(([op, t]) => t && (opts.operation ? op === opts.operation : true) && (!typePart || op === typePart.toLowerCase() || t.name === typePart));
  const hit = roots.map(([op, t]) => [op, t!.getFields()[fieldPart]] as const).find(([, f]) => f);
  if (!hit) {
    const known = roots.flatMap(([, t]) => Object.keys(t!.getFields()).map((n) => `${t!.name}.${n}`));
    throw new ApsError('ValidationError', `No root field "${field}" in the schema`, { suggestions: [known.length ? `Root fields: ${known.slice(0, 30).join(', ')}${known.length > 30 ? ' …' : ''}` : 'The schema has no root fields'] });
  }
  const [operation, rootField] = hit as readonly ['query' | 'mutation' | 'subscription', GraphQLField<unknown, unknown>];
  const depth = Math.min(Math.max(opts.depth ?? 2, 0), 6);
  const args = rootField.args.filter((a) => opts.includeOptionalArgs !== false || gql().isNonNullType(a.type));
  const variables: Record<string, unknown> = {};
  for (const a of args) variables[a.name] = placeholder(a.type, 0);
  const operationName = `${fieldPart.charAt(0).toUpperCase()}${fieldPart.slice(1)}`;
  const varDefs = args.length ? `(${args.map((a) => `$${a.name}: ${a.type.toString()}`).join(', ')})` : '';
  const argList = args.length ? `(${args.map((a) => `${a.name}: $${a.name}`).join(', ')})` : '';
  const selection = selectionOf(rootField.type, depth, new Set());
  const query = formatQuery(`${operation} ${operationName}${varDefs} { ${fieldPart}${argList}${selection} }`);
  return { operation, operationName, query, variables };
}

/** ` { a b c { d } }` for an object type, '' for a leaf. */
function selectionOf(type: GraphQLOutputType, depth: number, seen: Set<string>): string {
  const named = gql().getNamedType(type);
  if (gql().isLeafType(named)) return '';
  if (gql().isUnionType(named)) {
    const parts = named.getTypes().map((t) => `... on ${t.name}${selectionOf(t, depth, seen) || ' { __typename }'}`);
    return ` { __typename ${parts.join(' ')} }`;
  }
  if (!gql().isObjectType(named) && !gql().isInterfaceType(named)) return '';
  const fields = Object.values(named.getFields());
  // leaves first; objects only while there is depth left, skipping types already on the path (cycles)
  const leaves = fields.filter((f) => gql().isLeafType(gql().getNamedType(f.type)) && !f.args.some((a) => gql().isNonNullType(a.type)) && !f.deprecationReason).map((f) => f.name);
  const nested =
    depth > 0
      ? fields
          .filter((f) => !gql().isLeafType(gql().getNamedType(f.type)) && !f.args.some((a) => gql().isNonNullType(a.type)) && !f.deprecationReason && !seen.has(gql().getNamedType(f.type).name))
          .map((f) => {
            const inner = selectionOf(f.type, depth - 1, new Set([...seen, named.name]));
            return inner ? `${f.name}${inner}` : '';
          })
          .filter(Boolean)
      : [];
  const all = [...leaves, ...nested];
  return ` { ${all.length ? all.join(' ') : '__typename'} }`;
}

/** A placeholder value of an input type: 0, "", false, the first enum value, an input object with its required fields. */
function placeholder(type: GraphQLInputType, level: number): unknown {
  if (gql().isNonNullType(type)) return placeholder(type.ofType, level);
  if (gql().isListType(type)) return [placeholder(type.ofType, level)];
  if (gql().isEnumType(type)) return type.getValues()[0]?.value ?? null;
  if (gql().isInputObjectType(type)) {
    if (level > 4) return {};
    const out: Record<string, unknown> = {};
    for (const f of Object.values(type.getFields())) if (gql().isNonNullType(f.type) && f.defaultValue === undefined) out[f.name] = placeholder(f.type, level + 1);
    return out;
  }
  if (gql().isScalarType(type)) {
    switch (type.name) {
      case 'Int':
      case 'Float':
        return 0;
      case 'Boolean':
        return false;
      default:
        return '';
    }
  }
  return null;
}
