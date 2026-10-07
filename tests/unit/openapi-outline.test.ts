import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { openApiOutline } from '../../packages/core/src/index.js';

describe('OpenAPI outline', () => {
  const pets = openApiOutline(readFileSync('examples/public-workspace/specs/petstore.json', 'utf8'));

  it('groups operations by tag in the document order, with servers', () => {
    expect(pets.title).toBe('Swagger Petstore - OpenAPI 3.0');
    expect(pets.operations).toBe(19);
    expect(pets.tags.map((t) => t.name)).toEqual(['pet', 'store', 'user']);
    expect(pets.tags.reduce((n, t) => n + t.operations.length, 0)).toBe(19);
    expect(pets.servers).toEqual(['/api/v3']);
  });

  it('lists parameters, the request body and responses, with schemas as short outlines', () => {
    const find = pets.tags[0]!.operations.find((o) => o.operationId === 'findPetsByStatus')!;
    expect(find).toMatchObject({ method: 'GET', path: '/pet/findByStatus', deprecated: false });
    expect(find.parameters[0]).toMatchObject({ name: 'status', in: 'query', type: '"available" | "pending" | "sold"' });
    const ok = find.responses.find((r) => r.code === '200')!;
    expect(ok.schema).toMatch(/^Pet \{\n {2}id\?: integer \(int64\)/m);
    expect(ok.schema).toMatch(/\}\[\]$/);
    const add = pets.tags[0]!.operations.find((o) => o.operationId === 'addPet')!;
    expect(add.requestBody).toMatchObject({ contentType: 'application/json', required: true });
    expect(add.requestBody!.schema).toMatch(/name: string/);
    expect(add.request).toMatchObject({ method: 'POST' });
    expect(add.request!.url).not.toContain('{{baseUrl}}');
    const byId = pets.tags[0]!.operations.find((o) => o.operationId === 'getPetById')!;
    expect(byId.parameters[0]).toMatchObject({ name: 'petId', in: 'path', required: true, type: 'integer (int64)' });
    expect(byId.request!.url).toMatch(/\/pet\/\{\{petId\}\}$/);
    expect(byId.security.length).toBeGreaterThan(0);
  });

  it('reads YAML documents and refuses what is not OpenAPI', () => {
    const vet = openApiOutline(readFileSync('examples/veterinary-workspace/specs/veterinary-api.yaml', 'utf8'));
    expect(vet.operations).toBe(6);
    expect(() => openApiOutline('name: nope')).toThrow(/Not an OpenAPI 3 or Swagger 2 document/);
  });
});
