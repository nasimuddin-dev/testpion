import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { flowsFromCollection, flowsFromSpec, importOpenApi } from '../../packages/core/src/index.js';

// An integration suite from an API definition: a flow per resource, the created id flowing between its steps, the login first.
const vet = readFileSync('examples/veterinary-workspace/specs/veterinary-api.yaml', 'utf8');
const petstore = readFileSync('examples/public-workspace/specs/petstore.json', 'utf8');
const yamlOf = (files: Array<{ path: string; yaml: string }>, name: string) =>
  parse(files.find((f) => f.path.endsWith(name))!.yaml) as { defaults?: Record<string, unknown>; tests?: Array<Record<string, unknown>> } & Record<string, unknown>;

describe('flows from an API definition', () => {
  const r = flowsFromSpec(vet, { specPath: 'specs/veterinary-api.yaml' });

  it('makes one flow per resource: create, read back, listed, delete, gone, each depending on the one before', () => {
    expect(r.resources).toEqual(['patient']);
    expect(r.files.map((f) => f.path)).toEqual(['tests/veterinary-api/flows/auth.yaml', 'tests/veterinary-api/flows/patient.yaml', 'tests/veterinary-api-integration.suite.yaml']);
    const flow = yamlOf(r.files, 'patient.yaml');
    expect(flow.defaults).toEqual({ type: 'http', dependsOn: 'auth-token' });
    const steps = flow.tests!;
    expect(steps.map((s) => s.id)).toEqual(['patient-create', 'patient-read', 'patient-listed', 'patient-delete', 'patient-gone']);
    expect(steps[0]).toMatchObject({ method: 'POST', url: '{{baseUrl}}/patients', extract: { patientId: '$.id' }, auth: { type: 'bearer', token: '{{accessToken}}' } });
    // a name gets a random part, so the flow can run again
    expect((steps[0]!.body as { name: string }).name).toMatch(/\{\{\$randomInt\}\}/);
    expect(steps[1]).toMatchObject({ dependsOn: 'patient-create', url: '{{baseUrl}}/patients/{{patientId}}' });
    expect(steps[1]!.assertions).toContainEqual({ type: 'equals', path: '$.id', expected: '{{patientId}}' });
    expect(steps[2]!.assertions).toContainEqual({ type: 'contains', expected: '{{patientId}}' });
    expect(steps[3]).toMatchObject({ method: 'DELETE', dependsOn: ['patient-create', 'patient-read', 'patient-listed'] });
    expect(steps[4]!.assertions).toEqual([{ type: 'status', expected: 404 }]);
    // every step checks the contract
    expect(steps[0]!.assertions).toContainEqual({ type: 'openapi', spec: 'specs/veterinary-api.yaml' });
    // no YAML anchors: a person reads it
    expect(r.files[1]!.yaml).not.toMatch(/&a\d|\*a\d/);
  });

  it('the login operation is the first step: client credentials from the environment, the token saved', () => {
    const auth = yamlOf(r.files, 'auth.yaml');
    expect(auth).toMatchObject({ id: 'auth-token', method: 'POST', url: '{{baseUrl}}/auth/token', extract: { accessToken: '$.access_token' } });
    expect(auth.body).toEqual({
      type: 'form-urlencoded',
      fields: [
        { key: 'grant_type', value: 'client_credentials' },
        { key: 'client_id', value: '{{clientId}}' },
        { key: 'client_secret', value: '{{clientSecret}}' },
      ],
    });
    expect(r.variables).toEqual(['baseUrl', 'clientId', 'clientSecret']);
    expect(yamlOf(r.files, 'integration.suite.yaml').tests).toEqual(['veterinary-api/flows']);
  });

  it('a path parameter that is a field of the record keys the flow; an action path is not a resource', () => {
    const p = flowsFromSpec(petstore, { specPath: 'specs/petstore.json' });
    // /user/createWithList and /pet/{petId}/uploadImage are actions, not resources
    expect(p.resources).toEqual(['pet', 'order', 'user']);
    const user = yamlOf(p.files, 'user.yaml').tests!;
    expect(user[0]).toMatchObject({ extract: { userUsername: '$.username' } });
    expect(user[1]).toMatchObject({ url: '{{baseUrl}}/user/{{userUsername}}' });
    // no login operation (the petstore logs in with GET): the token must come from the environment
    expect(p.variables).toContain('accessToken');
    expect(p.files.some((f) => f.path.endsWith('auth.yaml'))).toBe(false);
  });

  it('a collection makes the same flows, through the OpenAPI document made from it', () => {
    const { collection } = importOpenApi(vet);
    const c = flowsFromCollection(collection);
    expect(c.resources).toEqual(['patient']);
    const steps = yamlOf(c.files, 'patient.yaml').tests!;
    expect(steps.map((s) => s.id)).toContain('patient-gone');
    // no definition file to check the contract against
    expect(steps[0]!.assertions).not.toContainEqual(expect.objectContaining({ type: 'openapi' }));
  });
});
