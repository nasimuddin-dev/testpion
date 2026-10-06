import { describe, it, expect } from 'vitest';
import { loadOpenApi, requestBodySchema } from '@testpion/core';

// The body editor's schema: the operation a request maps to, its JSON request body, refs kept with the components.
describe('request body schema from an API definition', () => {
  const doc = loadOpenApi(
    JSON.stringify({
      openapi: '3.0.0',
      servers: [{ url: 'https://api.example.com/v2' }],
      paths: {
        '/pets': { post: { operationId: 'addPet', summary: 'Add a pet', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } } },
        '/pets/{id}': {
          get: { operationId: 'getPet' },
          put: {
            requestBody: {
              content: { 'application/x-www-form-urlencoded': { schema: { type: 'object' } }, 'application/vnd.api+json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } },
            },
          },
        },
      },
      components: { schemas: { Pet: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, tag: { type: 'string' } } } } },
    }),
  );

  it('finds the operation through variables resolved, keeps $ref with the components, prefers JSON', () => {
    const r = requestBodySchema(doc, 'POST', 'https://api.example.com/v2/pets')!;
    expect(r.operationId).toBe('addPet');
    expect(r.path).toBe('POST /pets');
    expect(r.summary).toBe('Add a pet');
    expect(r.contentType).toBe('application/json');
    expect(r.schema.$ref).toBe('#/components/schemas/Pet');
    expect((r.schema.components as { schemas: Record<string, unknown> }).schemas.Pet).toBeTruthy();
    const put = requestBodySchema(doc, 'put', 'https://api.example.com/v2/pets/7')!;
    expect(put.contentType).toBe('application/vnd.api+json');
    expect(requestBodySchema(doc, 'GET', 'https://api.example.com/v2/pets/7')).toBeUndefined(); // no body
    expect(requestBodySchema(doc, 'POST', 'https://api.example.com/v2/nothing')).toBeUndefined();
  });

  it('reads a Swagger 2 body parameter', () => {
    const v2 = loadOpenApi(
      JSON.stringify({
        swagger: '2.0',
        basePath: '/api',
        paths: { '/users': { post: { parameters: [{ in: 'body', name: 'user', schema: { $ref: '#/definitions/User' } }] } } },
        definitions: { User: { type: 'object' } },
      }),
    );
    const r = requestBodySchema(v2, 'POST', 'http://x/api/users')!;
    expect(r.schema.$ref).toBe('#/definitions/User');
    expect(r.schema.definitions).toBeTruthy();
  });
});
