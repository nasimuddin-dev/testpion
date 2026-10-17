import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, detectFormat, importAny, importIntoWorkspace, schemaFromText, type SavedGraphQLRequest } from '../../packages/core/src/index.js';

// IMP-FIX-4: a GraphQL schema file (SDL) was detected but not imported ("Unrecognised import format (graphql-sdl)").
// It now imports as a GraphQL request for the endpoint ({{graphqlUrl}}) with a runnable operation for the first Query
// field, plus the SDL to keep in specs/graphql/, with a note.

const sdl = readFileSync(join(__dirname, '..', 'fixtures', 'import', 'graphql', 'clinic.graphql'), 'utf8');

describe('GraphQL SDL import', () => {
  it('detects and imports a schema file as a GraphQL endpoint request', () => {
    expect(detectFormat(sdl)).toBe('graphql-sdl');
    const r = importAny(sdl, { name: 'clinic.graphql' });
    expect(r.format).toBe('graphql-sdl');
    const c = r.collection!;
    expect(c.name).toBe('clinic');
    expect(c.variables).toEqual([{ key: 'graphqlUrl', value: '', enabled: true }]);
    const req = c.items[0] as SavedGraphQLRequest;
    expect(req).toMatchObject({ kind: 'graphql', name: 'clinic: patient', request: { endpoint: '{{graphqlUrl}}' } });
    // the operation for the first Query field, with its required argument as a variable, and valid against the schema
    expect(req.request.query).toMatch(/query \w+\(\$id: ID!\) \{\s+patient\(id: \$id\) \{/);
    expect(req.request.variables).toEqual({ id: expect.anything() });
    const gql = require('graphql') as typeof import('graphql');
    expect(gql.validate(schemaFromText(sdl), gql.parse(req.request.query))).toEqual([]);
  });

  it('returns the SDL to keep in specs/graphql/ and says so in a note', () => {
    const r = importAny(sdl, { name: 'clinic.graphql' });
    expect(r.specFile).toEqual({ path: 'specs/graphql/clinic.graphql', text: sdl });
    expect(r.notes).toEqual([expect.stringMatching(/^GraphQL schema "clinic": set \{\{graphqlUrl\}\} to the endpoint.*kept in specs\/graphql\//)]);
  });

  it('a workspace import writes the SDL to specs/graphql/ (never over another file)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-gql-sdl-'));
    try {
      const store = WorkspaceStore.create(dir, 'GraphQL');
      const r = importIntoWorkspace(store, sdl, { name: 'clinic.graphql' });
      expect(r.specPath).toBe('specs/graphql/clinic.graphql');
      expect(readFileSync(join(dir, 'specs', 'graphql', 'clinic.graphql'), 'utf8')).toBe(sdl);
      const again = importIntoWorkspace(store, sdl.replace('RABBIT', 'BIRD'), { name: 'clinic.graphql' });
      expect(again.specPath).not.toBe('specs/graphql/clinic.graphql');
      expect(readFileSync(join(dir, 'specs', 'graphql', 'clinic.graphql'), 'utf8')).toBe(sdl);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('a schema that does not build still gives a skeleton for the first Query field, with a note', () => {
    const partial = 'type Query {\n  # the list\n  visits: [Visit]\n}\n';
    const r = importAny(partial);
    expect(r.collection!.name).toBe('GraphQL API');
    expect((r.collection!.items[0] as SavedGraphQLRequest).request.query).toBe('query {\n  visits\n}\n');
    expect(r.notes).toEqual(expect.arrayContaining([expect.stringMatching(/^The schema does not build \(.*Visit/)]));
  });

  it('a schema without a Query type: an empty operation and a note', () => {
    const r = importAny('type Patient {\n  id: ID!\n}\n');
    expect((r.collection!.items[0] as SavedGraphQLRequest).request.query).toMatch(/^# The schema has no Query type/);
    expect(r.notes).toContain('The schema has no Query fields: the request has an empty operation to fill in');
  });
});
