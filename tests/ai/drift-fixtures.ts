/** A clinic OpenAPI document and the traffic that drifted from it (contract drift). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WorkspaceStore } from '../../packages/core/src/index.js';

export const CLINIC_SPEC = `# The clinic API (kept by the platform team)
openapi: 3.0.3
info:
  title: Clinic
  version: 1.0.0
paths:
  /patients/{id}:
    get:
      operationId: getPatient
      summary: Read a patient
      parameters:
        - { name: id, in: path, required: true, schema: { type: integer } }
      responses:
        '200':
          description: The patient
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Patient'
        '404':
          description: Not found
  /patients:
    get:
      operationId: listPatients
      summary: List patients
      responses:
        '200':
          description: The patients
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/Patient'
components:
  schemas:
    Patient:
      type: object
      required: [id, name]
      properties:
        id: { type: integer }
        name: { type: string }
        species:
          type: string
          enum: [dog, cat]
        age: { type: integer }
`;

export const BASE = 'http://127.0.0.1:4010';

/** The clinic document as specs/clinic.yaml (or another file name). */
export function addClinicSpec(store: WorkspaceStore, o: { file?: string; text?: string } = {}): string {
  const rel = o.file ?? 'specs/clinic.yaml';
  const f = join(store.root, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, o.text ?? CLINIC_SPEC);
  return rel;
}

let n = 0;
/** One History entry with its response body on disk (as the app keeps them). */
export function addHistory(store: WorkspaceStore, o: { method?: string; path: string; status: number; body?: unknown; collectionId?: string; requestId?: string; contentType?: string }): string {
  const id = `h-${++n}`;
  let payloadPath: string | undefined;
  if (o.body !== undefined) {
    payloadPath = join(store.path('payloads'), `${id}.json`);
    mkdirSync(dirname(payloadPath), { recursive: true });
    writeFileSync(payloadPath, typeof o.body === 'string' ? o.body : JSON.stringify(o.body));
  }
  store.meta.addHistory({
    id,
    timestamp: new Date(Date.UTC(2026, 9, 19, 10, 0, n)).toISOString(),
    kind: 'http',
    name: `${o.method ?? 'GET'} ${o.path}`,
    method: o.method ?? 'GET',
    url: `${BASE}${o.path}`,
    status: o.status,
    durationMs: 20,
    ...(payloadPath ? { payloadPath } : {}),
    responseMeta: { headers: [['content-type', o.contentType ?? 'application/json']] },
    ...(o.collectionId ? { collectionId: o.collectionId, requestId: o.requestId } : {}),
  });
  return id;
}

/** The drifted traffic: a nickname nobody documented (4 of 6), age as a string (2), an unknown species, a missing name, a null age, a 500, an unknown endpoint. */
export function addDriftedTraffic(store: WorkspaceStore): void {
  const rex = { id: 7, name: 'Rex', species: 'dog', age: 3, nickname: 'R' };
  for (let i = 0; i < 3; i++) addHistory(store, { path: `/patients/7`, status: 200, body: rex, collectionId: 'clinic', requestId: 'r-get' });
  addHistory(store, { path: '/patients/8', status: 200, body: { ...rex, id: 8, age: '4' }, collectionId: 'clinic', requestId: 'r-get' });
  addHistory(store, { path: '/patients/9', status: 200, body: { ...rex, id: 9, age: '5', species: 'bird' }, collectionId: 'clinic', requestId: 'r-get' });
  addHistory(store, { path: '/patients/10', status: 200, body: { id: 10, species: 'cat', age: null } });
  addHistory(store, { path: '/patients', status: 200, body: [rex, { ...rex, id: 11 }] });
  addHistory(store, { path: '/patients/7', status: 500, body: { error: 'boom', trace: 'x' } });
  addHistory(store, { path: '/owners', status: 200, body: [{ id: 1 }] });
}
