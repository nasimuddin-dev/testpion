import { describe, expect, it } from 'vitest';
import { buildSchema, introspectionFromSchema } from 'graphql';
import { IMPORTER_SUPPORT } from '../../packages/core/src/import/support.js';
import { importGraphqlSdl } from '../../packages/core/src/import/graphql-sdl.js';
import { MIGRATE_TOOLS } from '../../packages/shared/src/index.js';

const SDL = `
type Query { user(id: ID!): User  users: [User!]! }
type Mutation { createUser(name: String!): User }
type User { id: ID! name: String }
`;

describe('GraphQL import', () => {
  it('imports an introspection result like the SDL it was made from', () => {
    const fromSdl = importGraphqlSdl(SDL, 'schema.graphql');
    const intro = JSON.stringify({ data: introspectionFromSchema(buildSchema(SDL)) });
    const fromIntro = importGraphqlSdl(intro, 'introspection.json');
    const names = (r: ReturnType<typeof importGraphqlSdl>) => JSON.stringify(r.collection.items.map((i) => ('name' in i ? (i as { name: string }).name : '')).sort());
    expect(names(fromIntro)).toBe(names(fromSdl));
    // the schema is kept as SDL even when the file was an introspection result
    expect(fromIntro.specFile.text).toMatch(/type Query/);
    expect(fromIntro.specFile.text).toMatch(/createUser/);
  });
});

describe('migration tools and importer support agree', () => {
  it('every importer has an entry in MIGRATE_TOOLS and the reverse', () => {
    const importers = IMPORTER_SUPPORT.map((s) => s.id).sort();
    const tools = Object.keys(MIGRATE_TOOLS)
      .filter((k) => k !== 'other')
      .sort();
    expect(tools).toEqual(importers);
  });
});
