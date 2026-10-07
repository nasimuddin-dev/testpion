import { describe, expect, it } from 'vitest';
import { lintOpenApi, OPENAPI_LINT_RULES } from '../../packages/core/src/index.js';

const bad = `openapi: 3.0.3
info:
  title: Clinic
servers:
  - url: http://api.clinic.example
tags:
  - name: pets
paths:
  /pets/{id}:
    get:
      operationId: getPet
      tags: [pets]
      summary: One pet
      parameters:
        - name: id
          in: path
          schema: { type: string }
        - name: limit
          in: query
          schema: { type: integer }
        - name: limit
          in: query
          schema: { type: integer }
      requestBody:
        content:
          application/json:
            schema: { type: object }
      responses:
        '200':
          description: ok
          content:
            application/json:
              example: { id: 7 }
  /pets/{petId}:
    delete:
      operationId: getPet
      tags: [animals]
      security:
        - apiKey: []
      responses:
        '404':
          description: gone
  /owners/{ownerId}/:
    post:
      parameters:
        - name: other
          in: path
          required: true
          schema: { type: string }
      requestBody:
        content:
          application/json:
            schema: { $ref: '#/components/schemas/Owner' }
            example: { name: 7 }
      responses: {}
components:
  schemas:
    Owner:
      type: object
      required: [name]
      properties:
        name: { type: string }
    Lonely:
      type: string
    Missing:
      $ref: '#/components/schemas/Nowhere'
  securitySchemes:
    bearer:
      type: http
      scheme: bearer
`;

describe('OpenAPI lint', () => {
  const r = lintOpenApi(bad);
  const by = (rule: string) => r.problems.filter((p) => p.rule === rule);

  it('finds the mistakes that break tools and clients', () => {
    expect(by('info').map((p) => p.message)).toEqual(['info has no version']);
    expect(by('ref-unresolved')[0]).toMatchObject({ message: '#/components/schemas/Nowhere points at nothing in this document', where: 'components.schemas.Missing' });
    expect(by('path-ambiguous')[0]!.message).toBe('/pets/{petId} is the same path as /pets/{id}: only the parameter names differ');
    expect(by('path-param-required')[0]).toMatchObject({ where: 'GET /pets/{id}', message: 'Path parameter "id" must be required: true' });
    expect(by('parameter-duplicate')[0]!.message).toBe('Parameter "limit" (in query) is declared twice');
    expect(
      by('path-param-undeclared')
        .map((p) => p.message)
        .sort(),
    ).toEqual(['{ownerId} is in the path but not declared as a path parameter', '{petId} is in the path but not declared as a path parameter']);
    expect(by('path-param-unused')[0]!.message).toBe('Path parameter "other" is not in the path /owners/{ownerId}/');
    expect(by('operation-id-unique')[0]!.message).toBe('operationId "getPet" is also used by GET /pets/{id}');
    expect(by('operation-responses')[0]!.where).toBe('POST /owners/{ownerId}/');
    expect(by('security-scheme-defined')[0]!.message).toBe('Security scheme "apiKey" is not defined in components.securitySchemes');
  });

  it('and the gaps that make an API hard to use', () => {
    expect(by('example-valid')[0]!.message).toMatch(/^The example does not match its schema: \/name must be string/);
    expect(by('operation-id').map((p) => p.where)).toEqual(['POST /owners/{ownerId}/']);
    expect(by('operation-success-response').map((p) => p.where)).toEqual(['DELETE /pets/{petId}']);
    expect(by('response-schema')[0]!.message).toBe('The 200 response (application/json) has no schema');
    expect(by('request-body-on-get')[0]!.where).toBe('GET /pets/{id}');
    expect(by('path-trailing-slash')[0]!.message).toBe('/owners/{ownerId}/ ends with a slash');
    expect(by('server-not-https')[0]!.message).toMatch(/http:\/\/api\.clinic\.example is plain http/);
    expect(by('operation-tags').map((p) => p.message)).toEqual(['Tag "animals" is not declared in the top-level tags', 'POST /owners/{ownerId}/ has no tag']);
    expect(
      by('component-unused')
        .map((p) => p.where)
        .sort(),
    ).toEqual(['components.schemas.Lonely', 'components.schemas.Missing', 'security']);
    expect(r.operations).toBe(3);
    expect(r.counts.error).toBe(r.problems.filter((p) => p.severity === 'error').length);
  });

  it('places each problem on its line, for the editor', () => {
    const lines = bad.split('\n');
    const dup = by('operation-id-unique')[0]!;
    expect(lines[dup.line - 1]).toContain('operationId: getPet');
    expect(lines[dup.line - 1]!.slice(dup.column - 1, dup.endColumn - 1)).toBe('operationId');
    expect(lines[by('ref-unresolved')[0]!.line - 1]).toContain("$ref: '#/components/schemas/Nowhere'");
    // sorted by place
    expect(r.problems.map((p) => p.line)).toEqual([...r.problems.map((p) => p.line)].sort((a, b) => a - b));
  });

  it('rules can be turned off, or only the serious ones kept', () => {
    expect(lintOpenApi(bad, { disable: ['operation-tags', 'component-unused'] }).problems.some((p) => p.rule === 'operation-tags' || p.rule === 'component-unused')).toBe(false);
    const errors = lintOpenApi(bad, { minSeverity: 'error' });
    expect(errors.problems.every((p) => p.severity === 'error')).toBe(true);
    expect(errors.counts.warning).toBe(0);
    expect(OPENAPI_LINT_RULES.map((x) => x.id)).toContain('example-valid');
  });

  it('reports syntax errors and non-OpenAPI documents as problems, not exceptions', () => {
    const broken = lintOpenApi('openapi: 3.0.0\npaths:\n  /a: [unclosed\n');
    expect(broken.problems[0]).toMatchObject({ rule: 'syntax', severity: 'error' });
    expect(broken.problems[0]!.line).toBeGreaterThan(1);
    expect(lintOpenApi('{"name": "not a spec"}').problems[0]!.message).toMatch(/Not an OpenAPI 3 or Swagger 2 document/);
  });

  it('reads Swagger 2 and JSON', () => {
    const v2 = JSON.stringify(
      {
        swagger: '2.0',
        info: { title: 'Old', version: '1' },
        host: 'api.example.com',
        schemes: ['https'],
        securityDefinitions: { key: { type: 'apiKey', in: 'header', name: 'X-Key' } },
        security: [{ key: [] }],
        paths: {
          '/pets': {
            get: { operationId: 'list', tags: ['p'], summary: 's', parameters: [{ name: 'b', in: 'body', schema: { $ref: '#/definitions/Pet' } }], responses: { 200: { description: 'ok' } } },
          },
        },
        definitions: { Pet: { type: 'object' } },
      },
      null,
      2,
    );
    const out = lintOpenApi(v2);
    expect(out.problems.map((p) => p.rule)).toEqual(['request-body-on-get']);
    expect(out.problems[0]!.line).toBeGreaterThan(1);
  });
});
